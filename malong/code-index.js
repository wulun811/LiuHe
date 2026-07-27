// 码龙 — 公共代码索引服务 (v2 P2.1)
// 多语言 tree-sitter 解析，SQLite 存储符号/引用/依赖
// 详见：通天计划 §六 码龙

import Database from 'better-sqlite3'
import { join, relative, extname, resolve } from 'node:path'
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, watch, chmodSync } from 'node:fs'
import { createServer } from 'node:http'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT UNIQUE NOT NULL,
  repo TEXT NOT NULL DEFAULT '',
  size INTEGER DEFAULT 0,
  mtime INTEGER DEFAULT 0,
  indexed_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS symbols (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('function','class','variable','method','export','import','interface','type')),
  signature TEXT DEFAULT '',
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL DEFAULT 0,
  parent_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS refs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  source_symbol_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
  target_file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
  target_symbol_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
  target_name TEXT DEFAULT '',
  kind TEXT NOT NULL CHECK(kind IN ('call','import','extends','implements','assign','use'))
);
CREATE INDEX IF NOT EXISTS idx_sym_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_sym_file ON symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_sym_type ON symbols(type);
CREATE INDEX IF NOT EXISTS idx_sym_parent ON symbols(parent_id);
CREATE INDEX IF NOT EXISTS idx_ref_source ON refs(source_symbol_id);
CREATE INDEX IF NOT EXISTS idx_ref_target ON refs(target_symbol_id);
CREATE INDEX IF NOT EXISTS idx_ref_file ON refs(source_file_id);
CREATE INDEX IF NOT EXISTS idx_ref_name ON refs(target_name);
`

const CACHED_EXT = new Set(['.js', '.mjs', '.cjs', '.py', '.go', '.rs'])
const WATCHER_DEBOUNCE = 300

function extractSymbols(tree, source) {
  const symbols = []
  const imports = []

  function walk(node, depth = 0) {
    if (depth > 100) return
    if (node.type === 'function_declaration') {
      const name = node.childForFieldName('name')
      if (name) symbols.push({ name: source.slice(name.startIndex, name.endIndex), type: 'function', startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 })
    } else if (node.type === 'class_declaration') {
      const name = node.childForFieldName('name')
      if (name) symbols.push({ name: source.slice(name.startIndex, name.endIndex), type: 'class', startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 })
    } else if (node.type === 'method_definition') {
      const name = node.childForFieldName('name')
      if (name) symbols.push({ name: source.slice(name.startIndex, name.endIndex), type: 'method', startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 })
    } else if (node.type === 'import_statement') {
      const s = node.childForFieldName('source')
      if (s) imports.push({ target: source.slice(s.startIndex, s.endIndex).replace(/['"]/g, ''), kind: 'import' })
    } else if ((node.type === 'lexical_declaration' || node.type === 'variable_declaration') && (depth === 1 || !node.parent)) {
      for (const c of node.children) {
        if (c.type === 'variable_declarator') {
          const name = c.childForFieldName('name')
          if (name) symbols.push({ name: source.slice(name.startIndex, name.endIndex), type: 'variable', startLine: c.startPosition.row + 1, endLine: c.endPosition.row + 1 })
        }
      }
    } else if (node.type === 'export_statement') {
      for (let i = 0; i < node.childCount; i++) walk(node.child(i), depth + 1)
      return
    }
    for (let i = 0; i < node.childCount; i++) walk(node.child(i), depth + 1)
  }

  walk(tree.rootNode)
  return { symbols, imports }
}

function _calcComplexity(sym) {
  const loc = Math.max(1, (sym.end_line || sym.start_line) - sym.start_line + 1)
  const cyclomatic = Math.min(10, Math.ceil(loc / 10))
  const cognitive = Math.min(10, Math.ceil(loc / 15))
  return {
    name: sym.name,
    type: sym.type,
    file: sym.file,
    linesOfCode: loc,
    cyclomaticComplexity: cyclomatic,
    cognitiveComplexity: cognitive,
    complexityScore: Math.min(10, Math.round((cyclomatic + cognitive) / 2)),
  }
}

function initDb(dir) {
  const dbPath = join(dir, 'code-index.db')
  const db = new Database(dbPath)
  db.pragma('journal_mode=WAL')
  db.pragma('synchronous=NORMAL')
  db.pragma('cache_size=-65536')
  db.pragma('mmap_size=268435456')
  db.pragma('temp_store=MEMORY')
  db.exec(SCHEMA)
  return db
}

class CodeIndex {
  constructor() {
    this._core = null
    this._db = null
    this._langParser = null
    this._indexing = false
    this._udsServer = null
    this._watcher = null
    this._watchedDir = null
    this._watcherTimer = null
  }

  _resolveRepoDir(filePath) {
    if (this._watchedDir) return this._watchedDir
    let dir = filePath
    const lastSlash = dir.lastIndexOf('/')
    if (lastSlash > 0) dir = dir.slice(0, lastSlash)
    for (let i = 0; i < 5; i++) {
      if (existsSync(join(dir, '.git'))) return dir
      const parent = dir.lastIndexOf('/')
      if (parent <= 0) break
      dir = dir.slice(0, parent)
    }
    return null
  }

  indexFile(filePath, repo) {
    if (!CACHED_EXT.has(extname(filePath))) return null
    const source = readFileSync(filePath, 'utf-8')
    const ext = extname(filePath)
    const tree = this._langParser.parse(source, ext)
    if (!tree) return null
    const { symbols, imports } = this._langParser.extractSymbols(tree, source, ext)
    const refs = this._langParser.extractReferences(tree, source, ext)
    const relPath = repo ? relative(repo, filePath) : filePath
    return this._db.transaction(() => {
      return this._indexFileDb(relPath, source, symbols, imports, refs)
    })()
  }

  _indexFileDb(relPath, source, symbols, imports, refs) {
    let fileId = null
    const existing = this._db.prepare('SELECT id FROM files WHERE path = ?').get(relPath)
    if (existing) {
      fileId = existing.id
      this._db.prepare('DELETE FROM symbols WHERE file_id = ?').run(fileId)
      this._db.prepare('DELETE FROM refs WHERE source_file_id = ?').run(fileId)
      this._db.prepare("UPDATE files SET size = ?, mtime = ?, indexed_at = datetime('now') WHERE id = ?").run(source.length, Date.now(), fileId)
    }
    if (!fileId) {
      const r = this._db.prepare('INSERT OR IGNORE INTO files (path, repo, size, mtime) VALUES (?, ?, ?, ?)').run(relPath, '', source.length, Date.now())
      fileId = r.lastInsertRowid
    }

    const insSym = this._db.prepare('INSERT INTO symbols (file_id, name, type, start_line, end_line) VALUES (?, ?, ?, ?, ?)')
    const symIdMap = new Map()
    for (const s of symbols) {
      const r = insSym.run(fileId, s.name, s.type, s.startLine, s.endLine)
      symIdMap.set(s.name, r.lastInsertRowid)
    }

    const insRef = this._db.prepare('INSERT INTO refs (source_file_id, target_name, kind) VALUES (?, ?, ?)')
    for (const i of imports) insRef.run(fileId, i.target, i.kind)
    for (const r of refs) {
      if (r.type === 'call') insRef.run(fileId, r.name, 'call')
      if (r.type === 'import') insRef.run(fileId, r.module || '', 'import')
    }

    const updateRef = this._db.prepare('UPDATE refs SET target_symbol_id = ? WHERE id = ?')
    const namedRefs = this._db.prepare("SELECT id, target_name FROM refs WHERE source_file_id = ? AND target_symbol_id IS NULL AND target_name != ''").all(fileId)
    for (const nr of namedRefs) {
      const symId = symIdMap.get(nr.target_name)
      if (symId) updateRef.run(symId, nr.id)
    }

    return { path: relPath, symbols: symbols.length, refs: refs.length, imports: imports.length }
  }

  _resolveCrossFileRefs() {
    const unbound = this._db.prepare("SELECT r.id, r.source_file_id, r.target_name FROM refs r WHERE r.target_symbol_id IS NULL AND r.kind IN ('call','extends','implements') AND r.target_name != ''").all()
    if (!unbound.length) return 0
    const allSyms = this._db.prepare('SELECT s.id, s.name, s.file_id FROM symbols s').all()
    const symMap = new Map()
    for (const s of allSyms) {
      if (!symMap.has(s.name)) symMap.set(s.name, [])
      symMap.get(s.name).push(s)
    }
    const updateRef = this._db.prepare('UPDATE refs SET target_symbol_id = ?, target_file_id = ? WHERE id = ?')
    let resolved = 0
    this._db.transaction(() => {
      for (const r of unbound) {
        const candidates = symMap.get(r.target_name)
        if (!candidates) continue
        const sym = candidates.find(s => s.file_id !== r.source_file_id)
        if (!sym) continue
        updateRef.run(sym.id, sym.file_id, r.id)
        resolved++
      }
    })()
    return resolved
  }

  async walkAndIndex(dir, rootDir) {
    const { readdirSync } = await import('node:fs')
    const { join: joinPath } = await import('node:path')
    const files = []
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const full = joinPath(d, e.name)
        if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '.git' && !e.name.startsWith('.')) walk(full) }
        else if (CACHED_EXT.has(extname(e.name))) files.push(full)
      }
    }
    walk(rootDir || dir)
    return this.indexBatch(files, rootDir || dir)
  }

  async indexBatch(filePaths, repo, onProgress) {
    this._db.pragma('synchronous=OFF')
    try {
      const CHUNK = 200
      const results = []
      for (let i = 0; i < filePaths.length; i += CHUNK) {
        const chunk = filePaths.slice(i, i + CHUNK)
        const parsed = []
        for (const fp of chunk) {
          if (!CACHED_EXT.has(extname(fp))) continue
          let source
          try { source = readFileSync(fp, 'utf-8') } catch { continue }
          const ext = extname(fp)
          const tree = this._langParser.parse(source, ext)
          if (!tree) continue
          const { symbols, imports } = this._langParser.extractSymbols(tree, source, ext)
          const refs = this._langParser.extractReferences(tree, source, ext)
          const relPath = repo ? relative(repo, fp) : fp
          parsed.push({ relPath, source, symbols, imports, refs })
        }
        const txResults = this._db.transaction(() => {
          const r = []
          for (const p of parsed) r.push(this._indexFileDb(p.relPath, p.source, p.symbols, p.imports, p.refs))
          return r
        })()
        results.push(...txResults)
        if (onProgress) onProgress(Math.min(i + CHUNK, filePaths.length), filePaths.length)
        if (i + CHUNK < filePaths.length) await new Promise(r => setImmediate(r))
      }
      this._resolveCrossFileRefs()
      return results
    } finally {
      this._db.pragma('synchronous=NORMAL')
    }
  }

  async init(core) {
    this._core = core
    this._langParser = core.getService('langParser')
    if (!this._langParser) throw new Error('[code-index] lang-parser service required but not registered')
    // 延迟初始化数据库，等待 workspace_dir 参数
    this._db = null
    this._currentWorkspace = null

    const self = this

    // 初始化指定 workspace 的数据库
    function initWorkspaceDb(workspaceDir) {
      const wsDir = core.getWorkspaceDir(workspaceDir)
      if (self._db && self._currentWorkspace === workspaceDir) {
        return // 已经初始化过
      }
      if (self._db) {
        self._db.close()
      }
      self._db = initDb(wsDir)
      self._currentWorkspace = workspaceDir
      // 写入 metadata
      const metadataPath = join(wsDir, 'metadata.json')
      const metadata = {
        workspace_dir: workspaceDir,
        created_at: new Date().toISOString(),
        last_accessed: new Date().toISOString()
      }
      writeFileSync(metadataPath, JSON.stringify(metadata, null, 2))
    }

    core.registerService('codeIndex', {
      // 初始化 workspace（供 handler 调用）
      initWorkspace(workspaceDir) {
        initWorkspaceDb(workspaceDir)
        return { workspace_dir: workspaceDir, db_path: join(core.getWorkspaceDir(workspaceDir), 'code-index.db') }
      },

      // 索引单个文件（供 reindex handler 调用）
      indexFile(filePath, repo) {
        return self.indexFile(filePath, repo)
      },

      // 解析跨文件引用（供 reindex handler 调用）
      resolveCrossFileRefs() {
        return self._resolveCrossFileRefs()
      },

      async indexBatch(filePaths, repo, onProgress) {
        return self.indexBatch(filePaths, repo, onProgress)
      },

      // 索引状态（供 reindex handler 调用）
      get indexing() {
        return self._indexing
      },

      set indexing(value) {
        self._indexing = value
        if (!value) {
          self._indexProgress = null
          if (self._db) {
            const stats = {
              workspace_dir: self._currentWorkspace,
              files: self._db.prepare('SELECT COUNT(*) as cnt FROM files').get().cnt,
              symbols: self._db.prepare('SELECT COUNT(*) as cnt FROM symbols').get().cnt,
              refs: self._db.prepare('SELECT COUNT(*) as cnt FROM refs').get().cnt,
              completed_at: new Date().toISOString(),
            }
            self._lastIndexed = stats
          }
        }
      },

      // 索引进度（供 reindex handler 查询）
      _indexProgress: null,
      get indexProgress() {
        return self._indexProgress
      },
      set indexProgress(value) {
        self._indexProgress = value
      },

      // 上次索引完成记录（供 reindex handler 查询）
      _lastIndexed: null,
      get lastIndexed() {
        return self._lastIndexed
      },

      async getSymbols(filePath, { timeout = 5000 } = {}) {
        const f = self._db.prepare('SELECT id FROM files WHERE path = ?').get(filePath)
        if (!f) return []
        return self._db.prepare('SELECT name, type, start_line, end_line FROM symbols WHERE file_id = ? ORDER BY start_line').all(f.id)
      },

      async getReferences(symbol, filePath, { timeout = 5000 } = {}) {
        if (filePath) {
          const f = self._db.prepare('SELECT id FROM files WHERE path = ?').get(filePath)
          if (!f) return []
          return self._db.prepare("SELECT f.path, r.kind, r.target_name FROM refs r JOIN files f ON r.source_file_id = f.id WHERE r.source_file_id = ? AND (r.target_name = ? OR r.target_name LIKE ?)").all(f.id, symbol, `%${symbol}%`)
        }
        return self._db.prepare("SELECT f.path, r.kind, r.target_name FROM refs r JOIN files f ON r.source_file_id = f.id WHERE (r.target_name = ? OR r.target_name LIKE ?)").all(symbol, `%${symbol}%`)
      },

      async getCallGraph(filePath, { timeout = 10000 } = {}) {
        const f = self._db.prepare('SELECT id FROM files WHERE path = ?').get(filePath)
        if (!f) return { calls: [], calledBy: [] }
        const syms = self._db.prepare("SELECT id, name, type, start_line FROM symbols WHERE file_id = ? AND type IN ('function','method')").all(f.id)
        const calls = self._db.prepare("SELECT r.target_name, r.kind FROM refs r WHERE r.source_file_id = ? AND r.kind IN ('call','import')").all(f.id)
        const calledBy = self._db.prepare("SELECT f.path, r.kind FROM refs r JOIN files f ON r.source_file_id = f.id WHERE r.target_name IN (SELECT name FROM symbols WHERE file_id = ? AND type IN ('function','method'))").all(f.id)
        return { functions: syms, calls, calledBy }
      },

      async getModuleGraph(entryFiles, { timeout = 15000 } = {}) {
        const entries = Array.isArray(entryFiles) ? entryFiles : [entryFiles]
        const nodes = new Set(entries)
        const edges = []
        for (const e of entries) {
          const f = self._db.prepare('SELECT id FROM files WHERE path = ?').get(e)
          if (!f) continue
          const refs = self._db.prepare("SELECT r.target_name, f.path AS source FROM refs r JOIN files f ON r.source_file_id = f.id WHERE r.source_file_id = ? AND r.kind = 'import'").all(f.id)
          for (const r of refs) {
            edges.push({ from: r.source, to: r.target_name, kind: 'import' })
            nodes.add(r.target_name)
          }
        }
        return { nodes: [...nodes], edges }
      },

      async classifyMessage(content, { timeout = 3000 } = {}) {
        return self._langParser.classifyMessage(content)
      },

      async extractSymbols(content, { timeout = 3000 } = {}) {
        const tree = self._langParser.parse(content, '.js')
        if (!tree) return { symbols: [], imports: [], hasErrors: false }
        const result = self._langParser.extractSymbols(tree, content, '.js')
        return { ...result, hasErrors: self._langParser.hasErrors(tree) }
      },

      async getSemanticDensity(content, { timeout = 3000 } = {}) {
        const tree = self._langParser.parse(content, '.js')
        if (!tree) return { density: 0, nodeCount: 0 }
        const density = Math.min(1, tree.rootNode.childCount / 50)
        return { density: Math.round(density * 100) / 100, nodeCount: tree.rootNode.childCount }
      },

      async searchSymbols(query, { limit = 30 } = {}) {
        if (!query || query.length < 1) return []
        return self._db.prepare("SELECT s.name, s.type, s.start_line, s.end_line, f.path AS file FROM symbols s JOIN files f ON s.file_id = f.id WHERE s.name LIKE ? ORDER BY s.name LIMIT ?").all(`%${query}%`, limit)
      },

      async getCallers(symbolName, { filePath } = {}) {
        if (filePath) {
          const f = self._db.prepare('SELECT id FROM files WHERE path = ?').get(filePath)
          if (!f) return []
          return self._db.prepare("SELECT r.target_name AS callee, r.target_symbol_id, f2.path AS target_file FROM refs r JOIN files f ON r.source_file_id = f.id LEFT JOIN files f2 ON r.target_file_id = f2.id WHERE r.source_file_id = ? AND r.kind = 'call' AND r.target_name = ?").all(f.id, symbolName)
        }
        return self._db.prepare("SELECT f.path AS caller_file, r.target_name AS callee FROM refs r JOIN files f ON r.source_file_id = f.id WHERE r.kind = 'call' AND r.target_name = ?").all(symbolName)
      },

      async getCallees(symbolName, { filePath } = {}) {
        if (!symbolName) return []
        if (filePath) {
          return self._db.prepare("SELECT r.target_name, r.kind, f2.path AS target_file FROM symbols s JOIN refs r ON r.source_file_id = s.file_id LEFT JOIN files f2 ON r.target_file_id = f2.id WHERE s.name = ? AND s.file_id = (SELECT id FROM files WHERE path = ?) AND r.kind IN ('call','import')").all(symbolName, filePath)
        }
        return self._db.prepare("SELECT r.target_name, r.kind, f.path AS source_file, f2.path AS target_file FROM symbols s JOIN refs r ON r.source_file_id = s.file_id JOIN files f ON s.file_id = f.id LEFT JOIN files f2 ON r.target_file_id = f2.id WHERE s.name = ? AND r.kind IN ('call','import')").all(symbolName)
      },

      async getImpactAnalysis(filePath, { depth = 3 } = {}) {
        const f = self._db.prepare('SELECT id FROM files WHERE path = ?').get(filePath)
        if (!f) return { file: filePath, callers: [], transitive: [] }
        const callers = self._db.prepare("SELECT DISTINCT f.path AS caller_file, r.target_name FROM refs r JOIN files f ON r.source_file_id = f.id WHERE r.kind = 'call' AND r.target_name IN (SELECT name FROM symbols WHERE file_id = ?)").all(f.id)
        const transitive = []
        if (depth > 1) {
          const visited = new Set([filePath])
          let queue = callers.map(c => c.caller_file).filter(Boolean)
          for (let d = 1; d < depth && queue.length; d++) {
            const next = []
            for (const qf of queue) {
              if (visited.has(qf)) continue
              visited.add(qf)
              const q = self._db.prepare("SELECT id FROM files WHERE path = ?").get(qf)
              if (!q) continue
              const higher = self._db.prepare("SELECT DISTINCT f.path FROM refs r JOIN files f ON r.source_file_id = f.id WHERE r.kind = 'call' AND r.target_name IN (SELECT name FROM symbols WHERE file_id = ?)").all(q.id)
              for (const h of higher) {
                if (!visited.has(h.path)) {
                  transitive.push({ depth: d, caller: h.path, target: qf })
                  next.push(h.path)
                }
              }
            }
            queue = next
          }
        }
        return { file: filePath, directCallers: callers.length, callers, transitiveCallers: transitive }
      },

      async getModuleDependencies(filePath, { depth = 3 } = {}) {
        const f = self._db.prepare('SELECT id FROM files WHERE path = ?').get(filePath)
        if (!f) return { file: filePath, imports: [], transitive: [] }
        const imports = self._db.prepare("SELECT r.target_name AS module FROM refs r WHERE r.source_file_id = ? AND r.kind = 'import'").all(f.id)
        const transitive = []
        if (depth > 1) {
          const visited = new Set([filePath])
          let queue = imports.map(i => i.module).filter(Boolean)
          for (let d = 1; d < depth && queue.length; d++) {
            const next = []
            for (const mod of queue) {
              if (visited.has(mod)) continue
              visited.add(mod)
              const mf = self._db.prepare("SELECT id, path FROM files WHERE path LIKE ?").get(`%${mod}%`)
              if (!mf) continue
              const sub = self._db.prepare("SELECT r.target_name AS module FROM refs r WHERE r.source_file_id = ? AND r.kind = 'import'").all(mf.id)
              for (const s of sub) {
                if (!visited.has(s.module)) {
                  transitive.push({ depth: d, from: mf.path, module: s.module })
                  next.push(s.module)
                }
              }
            }
            queue = next
          }
        }
        return { file: filePath, directImports: imports, transitiveDeps: transitive }
      },

      async detectDeadCode({ minUseCount = 1 } = {}) {
        return self._db.prepare("SELECT s.name, s.type, f.path AS file, s.start_line, (SELECT COUNT(*) FROM refs WHERE target_name = s.name) AS ref_count FROM symbols s JOIN files f ON s.file_id = f.id WHERE s.type IN ('function','method') AND (SELECT COUNT(*) FROM refs WHERE target_name = s.name AND (source_file_id != s.file_id OR kind != 'import')) < ? ORDER BY ref_count ASC LIMIT 50").all(minUseCount)
      },

      async getComplexity(symbolName, { filePath } = {}) {
        if (filePath) {
          const f = self._db.prepare('SELECT id FROM files WHERE path = ?').get(filePath)
          if (!f) return null
          const sym = self._db.prepare("SELECT s.id, s.start_line, s.end_line, s.type, f.path AS file FROM symbols s JOIN files f ON s.file_id = f.id WHERE s.name = ? AND s.file_id = ?").get(symbolName, f.id)
          return sym ? _calcComplexity(sym) : null
        }
        const sym = self._db.prepare("SELECT s.id, s.start_line, s.end_line, s.type, f.path AS file FROM symbols s JOIN files f ON s.file_id = f.id WHERE s.name = ? LIMIT 1").get(symbolName)
        return sym ? _calcComplexity(sym) : null
      },

      async detectChangeType(oldHash, newHash, { timeout = 3000 } = {}) {
        return { changeType: 'unknown' }
      },

      async syncFileChange(filePath) {
        if (!existsSync(filePath)) {
          const relPath = self._watchedDir ? relative(self._watchedDir, filePath) : filePath
          const matched = self._db.prepare('SELECT id FROM files WHERE path = ?').get(relPath)
          if (matched) {
            self._db.prepare('DELETE FROM symbols WHERE file_id = ?').run(matched.id)
            self._db.prepare('DELETE FROM refs WHERE source_file_id = ?').run(matched.id)
            self._db.prepare('DELETE FROM files WHERE id = ?').run(matched.id)
          }
          if (self._core.emit) self._core.emit('file.changed', { path: filePath, type: 'deleted' })
          return { path: relPath, status: 'deleted' }
        }
        const repo = self._watchedDir || self._resolveRepoDir(filePath)
        const result = self.indexFile(filePath, repo)
        if (result) self._core.log('info', `[code-index] synced: ${result.path} (${result.symbols} syms)`)
        if (self._core.emit) self._core.emit('file.changed', { path: filePath })
        return result
      },

      async indexProject(rootDir, { timeout = 60000 } = {}) {
        if (self._indexing) return { status: 'already indexing' }
        self._indexing = true
        self._core.log('info', `[code-index] indexing ${rootDir}...`)
        const t0 = Date.now()
        const results = await self.walkAndIndex(rootDir)
        self._indexing = false
        const elapsed = Date.now() - t0
        self._core.log('info', `[code-index] indexed ${results.length} files in ${elapsed}ms`)
        return { status: 'done', files: results.length, elapsed }
      },

      getStats() {
        const files = self._db.prepare('SELECT COUNT(*) as cnt FROM files').get().cnt
        const symbols = self._db.prepare('SELECT COUNT(*) as cnt FROM symbols').get().cnt
        const refs = self._db.prepare('SELECT COUNT(*) as cnt FROM refs').get().cnt
        const dbPath = self._currentWorkspace ? join(self._core.getWorkspaceDir(self._currentWorkspace), 'code-index.db') : null
        const fileSize = dbPath && existsSync(dbPath) ? readFileSync(dbPath).length : 0
        return { files, symbols, refs, dbSize: fileSize, indexing: self._indexing }
      },

      watchDirectory(dir) {
        if (self._watcher) { self._watcher.close(); self._watcher = null }
        self._watchedDir = resolve(dir)
        if (!existsSync(self._watchedDir)) return { status: 'not_found', dir }
        try {
          self._watcher = watch(self._watchedDir, { recursive: true }, (eventType, filename) => {
            if (!filename) return
            const ext = extname(filename)
            if (!CACHED_EXT.has(ext)) return
            if (self._watcherTimer) clearTimeout(self._watcherTimer)
            self._watcherTimer = setTimeout(() => {
              const fullPath = join(self._watchedDir, filename)
              if (!existsSync(fullPath)) return
              self.syncFileChange(fullPath)
            }, WATCHER_DEBOUNCE)
          })
          self._core.log('info', `[code-index] watching ${self._watchedDir}`)
          return { status: 'watching', dir: self._watchedDir }
        } catch (e) {
          self._core.log('warn', `[code-index] watch failed: ${e.message}`)
          return { status: 'error', message: e.message }
        }
      },

      unwatch() {
        if (self._watcher) { self._watcher.close(); self._watcher = null }
        self._watchedDir = null
        if (self._watcherTimer) { clearTimeout(self._watcherTimer); self._watcherTimer = null }
        self._core.log('info', `[code-index] watcher stopped`)
        return { status: 'stopped' }
      },
    })
    core.log('info', `[code-index] service registered`)

    const udsPath = core.get('codeIndex.udsPath', join(process.cwd(), 'data', 'code-index.sock'))
    const udsToken = core.get('codeIndex.udsToken', '')
    try { unlinkSync(udsPath) } catch {}
    this._udsServer = createServer((req, res) => {
      if (udsToken) {
        const token = new URL(req.url, 'http://localhost').searchParams.get('token') || req.headers['x-auth-token'] || ''
        if (token !== udsToken) {
          res.statusCode = 401
          res.end(JSON.stringify({ error: 'unauthorized' }))
          return
        }
      }
      let body = ''
      req.on('data', c => body += c)
      req.on('end', async () => {
        const url = new URL(req.url, 'http://localhost')
        const parts = url.pathname.split('/').filter(Boolean)
        res.setHeader('Content-Type', 'application/json')
        try {
          const svc = core.services.codeIndex
          let result
          if (req.method === 'POST' && parts[0] === 'classify') {
            result = await svc.classifyMessage(JSON.parse(body).content)
          } else if (req.method === 'POST' && parts[0] === 'extract-symbols') {
            result = await svc.extractSymbols(JSON.parse(body).content)
          } else if (req.method === 'GET' && parts[0] === 'symbols' && parts[1]) {
            result = await svc.getSymbols(decodeURIComponent(parts[1]))
          } else if (req.method === 'GET' && parts[0] === 'references' && parts[1]) {
            result = await svc.getReferences(decodeURIComponent(parts[1]))
          } else if (req.method === 'GET' && parts[0] === 'stats') {
            result = svc.getStats()
          } else if (req.method === 'POST' && parts[0] === 'density') {
            result = await svc.getSemanticDensity(JSON.parse(body).content)
          } else if (req.method === 'GET' && parts[0] === 'callers' && parts[1]) {
            result = await svc.getCallers(decodeURIComponent(parts[1]))
          } else if (req.method === 'GET' && parts[0] === 'callees' && parts[1]) {
            result = await svc.getCallees(decodeURIComponent(parts[1]))
          } else if (req.method === 'GET' && parts[0] === 'impact' && parts[1]) {
            result = await svc.getImpactAnalysis(decodeURIComponent(parts[1]))
          } else if (req.method === 'GET' && parts[0] === 'deps' && parts[1]) {
            result = await svc.getModuleDependencies(decodeURIComponent(parts[1]))
          } else if (req.method === 'GET' && parts[0] === 'deadcode') {
            result = svc.detectDeadCode()
          } else if (req.method === 'GET' && parts[0] === 'complexity' && parts[1]) {
            result = await svc.getComplexity(decodeURIComponent(parts[1]))
          } else if (req.method === 'GET' && parts[0] === 'search') {
            const q = url.searchParams.get('q') || ''
            result = await svc.searchSymbols(q)
          } else {
            res.statusCode = 404
            result = { error: 'not_found', path: url.pathname }
          }
          res.end(JSON.stringify(result))
        } catch (e) {
          res.statusCode = 400
          res.end(JSON.stringify({ error: e.message }))
        }
      })
    })
    this._udsServer.listen(udsPath, () => {
      try { chmodSync(udsPath, 0o600) } catch {}
      core.log('info', `[code-index] UDS server on ${udsPath}`)
    })
  }

  async start() {
    this._core.log('info', `[code-index] ready (db: ${this._db ? 'opened' : 'none'})`)
  }

  async stop() {
    if (this._watcher) { this._watcher.close(); this._watcher = null }
    if (this._watcherTimer) { clearTimeout(this._watcherTimer); this._watcherTimer = null }
    if (this._udsServer) { this._udsServer.close(); this._udsServer = null }
    if (this._db) { this._db.close(); this._db = null }
    this._langParser = null
    this._core.log('info', '[code-index] stopped')
  }
}

const instance = new CodeIndex()
const name = 'malong-code-index'
const version = '0.3.0'
const init = (core) => instance.init(core)
const start = () => instance.start()
const stop = () => instance.stop()
export { name, version, init, start, stop }
export default instance
