// 码龙 — 公共代码索引服务 (v2 P2.1)
// 多语言 tree-sitter 解析，SQLite 存储符号/引用/依赖
// 详见：通天计划 §六 码龙

import Database from 'better-sqlite3'
import { join, relative, extname, resolve } from 'node:path'
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, watch, chmodSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { Worker } from 'node:worker_threads'
import { DEFAULT_IGNORE_DIRS } from './file-collector.js'

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
  kind TEXT NOT NULL CHECK(kind IN ('call','import','extends','implements','assign','use')),
  line INTEGER DEFAULT 0,
  call_expr TEXT DEFAULT ''
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
  const db = openHealthy(dbPath)
  db.pragma('journal_mode=WAL')
  db.pragma('synchronous=NORMAL')
  db.pragma('busy_timeout=5000')
  db.pragma('cache_size=-16384')
  db.pragma('mmap_size=67108864')
  db.pragma('temp_store=FILE')
  db.exec(SCHEMA)
  try { db.exec('ALTER TABLE refs ADD COLUMN line INTEGER DEFAULT 0') } catch (e) { if (!e.message?.includes('duplicate column')) console.error('[code-index] migration error:', e.message) }
  try { db.exec("ALTER TABLE refs ADD COLUMN call_expr TEXT DEFAULT ''") } catch (e) { if (!e.message?.includes('duplicate column')) console.error('[code-index] migration error:', e.message) }
  return db
}

function openHealthy(dbPath) {
  const attempt = () => {
    const db = new Database(dbPath)
    const r = db.pragma('integrity_check')
    const ok = Array.isArray(r) && r.length === 1 && r[0]?.integrity_check === 'ok'
    if (!ok) { db.close(); throw new Error('integrity_check failed') }
    return db
  }
  try {
    return attempt()
  } catch (e) {
    console.error(`[code-index] DB corrupt (${e.message}) — rebuilding: ${dbPath}`)
    for (const suffix of ['', '-wal', '-shm']) {
      try { unlinkSync(dbPath + suffix) } catch {}
    }
    return new Database(dbPath)
  }
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
    this._impactCache = new Map()
    this._contextCache = new Map()
    this._outlineCache = new Map()
    this._impactCacheMax = 200
    this._outlineCacheMax = 100
    this._contextCacheMax = 50
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
    let size = 0
    try { size = statSync(filePath).size } catch { return null }
    if (size > 1024 * 1024) return null
    const source = readFileSync(filePath, 'utf-8')
    const ext = extname(filePath)
    const tree = this._langParser.parse(source, ext)
    if (!tree) return null
    const { symbols, refs } = this._langParser.extractAll(tree, source, ext)
    const relPath = repo ? relative(repo, filePath) : filePath
    let mtime = Date.now()
    try { mtime = statSync(filePath).mtimeMs } catch {}
    return this._db.transaction(() => {
      return this._indexFileDb(relPath, source.length, symbols, refs, mtime)
    })()
  }

  _indexFileDb(relPath, sourceLength, symbols, refs, mtime) {
    let fileId = null
    const existing = this._db.prepare('SELECT id FROM files WHERE path = ?').get(relPath)
    if (existing) {
      fileId = existing.id
      this._db.prepare('DELETE FROM symbols WHERE file_id = ?').run(fileId)
      this._db.prepare('DELETE FROM refs WHERE source_file_id = ?').run(fileId)
      this._db.prepare("UPDATE files SET size = ?, mtime = ?, indexed_at = datetime('now') WHERE id = ?").run(sourceLength, mtime, fileId)
    }
    if (!fileId) {
      const r = this._db.prepare('INSERT OR IGNORE INTO files (path, repo, size, mtime) VALUES (?, ?, ?, ?)').run(relPath, '', sourceLength, mtime)
      fileId = r.lastInsertRowid
    }
      this._impactCache?.clear()
      this._contextCache?.clear()
      this._outlineCache?.clear()

    if (symbols.length > 0) {
      const SYM_BATCH = 180
      const symRows = symbols.flatMap(s => [fileId, s.name, s.type, s.startLine, s.endLine])
      for (let i = 0; i < symRows.length; i += SYM_BATCH * 5) {
        const batch = symRows.slice(i, i + SYM_BATCH * 5)
        const ph = Array(batch.length / 5).fill('(?,?,?,?,?)').join(',')
        this._db.prepare(`INSERT INTO symbols (file_id, name, type, start_line, end_line) VALUES ${ph}`).run(...batch)
      }
    }
    const insertedSyms = this._db.prepare('SELECT id, name, type, start_line, end_line FROM symbols WHERE file_id = ?').all(fileId)
    const symIdMap = new Map(insertedSyms.map(s => [s.name, s.id]))
    const funcSyms = insertedSyms.filter(s => s.type === 'function' || s.type === 'method')

    const refRows = []
    for (const r of refs) {
      if (r.type === 'call') {
        const callName = r.name.includes('.') ? r.name.split('.').pop() : r.name
        const callExpr = r.name.includes('.') ? r.name : ''
        let sourceSymId = null
        let bestRange = Infinity
        for (const fs of funcSyms) {
          if (fs.start_line <= r.line && r.line <= fs.end_line) {
            const range = fs.end_line - fs.start_line
            if (range < bestRange) { bestRange = range; sourceSymId = fs.id }
          }
        }
        refRows.push([fileId, sourceSymId, callName, 'call', r.line, callExpr])
      } else if (r.type === 'import') {
        refRows.push([fileId, null, r.module || '', 'import', r.line, ''])
        if (r.symbols && r.symbols.length > 0) {
          for (const symName of r.symbols) {
            refRows.push([fileId, null, symName, 'import', r.line, ''])
          }
        }
      }
    }
    if (refRows.length > 0) {
      const BATCH_SIZE = 150
      for (let i = 0; i < refRows.length; i += BATCH_SIZE) {
        const batch = refRows.slice(i, i + BATCH_SIZE)
        const ph = batch.map(() => '(?,?,?,?,?,?)').join(',')
        this._db.prepare(`INSERT INTO refs (source_file_id, source_symbol_id, target_name, kind, line, call_expr) VALUES ${ph}`).run(...batch.flat())
      }
    }

    const updateRef = this._db.prepare('UPDATE refs SET target_symbol_id = ? WHERE id = ?')
    const namedRefs = this._db.prepare("SELECT id, target_name FROM refs WHERE source_file_id = ? AND target_symbol_id IS NULL AND target_name != '' AND kind = 'call'").all(fileId)
    for (const nr of namedRefs) {
      const symId = symIdMap.get(nr.target_name)
      if (symId) updateRef.run(symId, nr.id)
    }

    return { path: relPath, symbols: symbols.length, refs: refs.length }
  }

  _resolveCrossFileRefs() {
    const unbound = this._db.prepare("SELECT r.id, r.source_file_id, r.target_name FROM refs r WHERE r.target_symbol_id IS NULL AND r.kind IN ('call','import','extends','implements') AND r.target_name != ''").all()
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

  _isTestFile(filePath) {
    const lower = filePath.toLowerCase()
    if (lower.includes('__tests__/') || lower.includes('/tests/') || lower.includes('/test/') || lower.startsWith('tests/') || lower.startsWith('test/')) return true
    const base = lower.split('/').pop()
    return /^test[_-]./.test(base) || /[_-]test\./.test(base) || /\.test\./.test(base) || /\.spec\./.test(base) || /^test\.[^.]+$/.test(base)
  }

  _extractContext(filePath, line, window = 1) {
    if (!line || line <= 0) return null
    let absPath = filePath
    if (!absPath.startsWith('/')) absPath = join(this._currentWorkspace || '', filePath)
    try {
      if (!this._contextCache.has(absPath)) {
        if (this._contextCache.size >= this._contextCacheMax) {
          const oldest = this._contextCache.keys().next().value
          this._contextCache.delete(oldest)
        }
        this._contextCache.set(absPath, readFileSync(absPath, 'utf-8').split('\n'))
      }
      const lines = this._contextCache.get(absPath)
      const start = Math.max(0, line - 1 - window)
      const end = Math.min(lines.length, line + window)
      const ctx = lines.slice(start, end).join('\n')
      return ctx || null
    } catch {
      return null
    }
  }

  _calculateRisk(direct, tests, changeType) {
    const total = direct + tests
    if (changeType === 'delete') {
      if (total >= 3) return 'high'
      if (total >= 1) return 'medium'
    } else if (changeType === 'rename') {
      if (total >= 4) return 'high'
      if (total >= 1) return 'medium'
    } else {
      if (total >= 6) return 'high'
      if (total >= 2) return 'medium'
    }
    return 'low'
  }

  _extractDocstrings(filePath, symbols) {
    const absPath = this._currentWorkspace ? join(this._currentWorkspace, filePath) : filePath
    if (!existsSync(absPath)) return {}
    try {
      const content = readFileSync(absPath, 'utf-8')
      const lines = content.split('\n')
      const result = {}
      for (const sym of symbols) {
        if (sym.type !== 'function' && sym.type !== 'method' && sym.type !== 'class') continue
        const defLine = sym.start_line - 1
        for (let i = defLine + 1; i < Math.min(defLine + 5, lines.length); i++) {
          const t = lines[i].trim()
          if (!t) continue
          const m = t.match(/^(?:"""([\s\S]*?)"""|'''([\s\S]*?)'''|\/\*\*([\s\S]*?)\*\/)/)
          if (m) {
            const doc = (m[1] || m[2] || m[3] || '').trim().split('\n')[0].trim()
            if (doc) result[sym.start_line] = doc
          }
          break
        }
      }
      return result
    } catch {
      return {}
    }
  }

  _extractDecorators(filePath, symbols) {
    const absPath = this._currentWorkspace ? join(this._currentWorkspace, filePath) : filePath
    if (!existsSync(absPath)) return {}
    try {
      const content = readFileSync(absPath, 'utf-8')
      const lines = content.split('\n')
      const result = {}
      for (const sym of symbols) {
        if (sym.type !== 'function' && sym.type !== 'method' && sym.type !== 'class') continue
        const defLine = sym.start_line - 1
        const decorators = []
        for (let i = defLine - 1; i >= Math.max(0, defLine - 10); i--) {
          const t = lines[i].trim()
          if (!t) continue
          if (t.startsWith('@')) {
            decorators.unshift(t.slice(1).split('(')[0])
          } else {
            break
          }
        }
        if (decorators.length > 0) {
          result[sym.start_line] = decorators
        }
      }
      return result
    } catch {
      return {}
    }
  }

  _resolveRefDetail(sourceSymbolId) {
    if (!sourceSymbolId) return { line: 0, func: null }
    const row = this._db.prepare('SELECT name, type, start_line FROM symbols WHERE id = ?').get(sourceSymbolId)
    if (!row) return { line: 0, func: null }
    return {
      line: row.start_line,
      func: (row.type === 'function' || row.type === 'method') ? row.name : null,
    }
  }

  _findIndirectCallers(symbolName, maxDepth, excludeFile) {
    const direct = excludeFile
      ? this._db.prepare("SELECT DISTINCT r.source_symbol_id, f.path AS caller_file, s.name AS caller_func FROM refs r JOIN files f ON r.source_file_id = f.id LEFT JOIN symbols s ON r.source_symbol_id = s.id WHERE r.target_name = ? AND r.kind = 'call' AND f.path != ? AND r.source_symbol_id IS NOT NULL").all(symbolName, excludeFile)
      : this._db.prepare("SELECT DISTINCT r.source_symbol_id, f.path AS caller_file, s.name AS caller_func FROM refs r JOIN files f ON r.source_file_id = f.id LEFT JOIN symbols s ON r.source_symbol_id = s.id WHERE r.target_name = ? AND r.kind = 'call' AND r.source_symbol_id IS NOT NULL").all(symbolName)

    const visited = new Set(direct.map(d => d.source_symbol_id))
    let queue = direct.map(d => ({ symId: d.source_symbol_id, func: d.caller_func, file: d.caller_file }))

    const results = []
    for (let d = 2; d <= maxDepth; d++) {
      const nextQueue = []
      for (const { symId, func: funcName } of queue) {
        const higher = this._db.prepare("SELECT DISTINCT f.path AS caller_file, s.name AS caller_func, r.line AS caller_line, r.source_symbol_id AS higher_sym_id FROM refs r JOIN files f ON r.source_file_id = f.id LEFT JOIN symbols s ON r.source_symbol_id = s.id WHERE r.target_symbol_id = ? AND r.kind = 'call'").all(symId)
        for (const h of higher) {
          results.push({ file: h.caller_file, function: h.caller_func, line: h.caller_line || 0, depth: d, via: funcName })
          if (h.higher_sym_id && !visited.has(h.higher_sym_id)) {
            visited.add(h.higher_sym_id)
            nextQueue.push({ symId: h.higher_sym_id, func: h.caller_func, file: h.caller_file })
          }
        }
      }
      queue = nextQueue
      if (!queue.length) break
    }
    return results
  }

  _findCallees(symId, sourceFilePath) {
    if (!symId) return []
    const rows = this._db.prepare(
      "SELECT r.target_name, r.target_symbol_id, r.target_file_id, r.line, r.call_expr, " +
      "f2.path AS target_file_path " +
      "FROM refs r " +
      "LEFT JOIN files f2 ON r.target_file_id = f2.id " +
      "WHERE r.source_symbol_id = ? AND r.kind = 'call'"
    ).all(symId)

    const callees = []
    const seen = new Set()
    for (const r of rows) {
      const key = `${r.target_name}\0${r.line || 0}`
      if (seen.has(key)) continue
      seen.add(key)

      let calleeFile = r.target_file_path || null
      let calleeLine = 0
      if (r.target_symbol_id) {
        const ts = this._db.prepare('SELECT start_line, file_id FROM symbols WHERE id = ?').get(r.target_symbol_id)
        if (ts) {
          calleeLine = ts.start_line
          if (!calleeFile) {
            const cf = this._db.prepare('SELECT path FROM files WHERE id = ?').get(ts.file_id)
            if (cf) calleeFile = cf.path
          }
        }
      }

      callees.push({
        function: r.target_name,
        file: sourceFilePath,
        line: r.line || 0,
        call_expr: r.call_expr || '',
        context: this._extractContext(sourceFilePath, r.line || 0),
        callee_file: calleeFile,
        callee_line: calleeLine,
        resolved: !!r.target_symbol_id,
      })
    }
    return callees
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
    const validFiles = filePaths.filter(fp => CACHED_EXT.has(extname(fp)))
    if (!validFiles.length) return []

    const existingFiles = new Map(this._db.prepare('SELECT path, mtime FROM files').all().map(f => [f.path, f.mtime]))
    const changedFiles = []
    const mtimeMap = new Map()
    const currentPaths = new Set()
    for (const fp of validFiles) {
      const relPath = repo ? relative(repo, fp) : fp
      currentPaths.add(relPath)
      let st
      try { st = statSync(fp) } catch { continue }
      const oldMtime = existingFiles.get(relPath)
      if (oldMtime !== undefined && oldMtime >= st.mtimeMs) continue
      changedFiles.push(fp)
      mtimeMap.set(relPath, st.mtimeMs)
    }

    const deletedIds = this._db.prepare('SELECT id, path FROM files').all().filter(f => !currentPaths.has(f.path)).map(f => f.id)

    if (!changedFiles.length && !deletedIds.length) {
      if (onProgress) onProgress(0, 0)
      return []
    }

    const totalChanges = changedFiles.length + deletedIds.length
    const rebuildIndexes = totalChanges > 20
    console.error(`[code-index] incremental: ${changedFiles.length} changed, ${deletedIds.length} deleted, ${validFiles.length - changedFiles.length} unchanged skipped, rebuildIndexes=${rebuildIndexes}`)

    this._db.pragma('synchronous=OFF')
    if (rebuildIndexes) {
      this._db.exec('DROP INDEX IF EXISTS idx_sym_name; DROP INDEX IF EXISTS idx_sym_file; DROP INDEX IF EXISTS idx_sym_type; DROP INDEX IF EXISTS idx_sym_parent; DROP INDEX IF EXISTS idx_ref_source; DROP INDEX IF EXISTS idx_ref_target; DROP INDEX IF EXISTS idx_ref_file; DROP INDEX IF EXISTS idx_ref_name')
    }
    const t0 = Date.now()
    try {
      if (deletedIds.length) {
        this._db.transaction(() => {
          for (const id of deletedIds) {
            this._db.prepare('DELETE FROM symbols WHERE file_id = ?').run(id)
            this._db.prepare('DELETE FROM refs WHERE source_file_id = ?').run(id)
            this._db.prepare('DELETE FROM files WHERE id = ?').run(id)
          }
        })()
      }

      let parsed = []
      if (changedFiles.length) {
        const workerUrl = new URL('./parse-worker.js', import.meta.url)
        const mid = Math.ceil(changedFiles.length / 2)
        const batches = [changedFiles.slice(0, mid), changedFiles.slice(mid)].filter(b => b.length > 0)
        const runWorker = (files) => new Promise((res) => {
          const w = new Worker(workerUrl)
          const timer = setTimeout(() => {
            console.error(`[code-index] parse worker timeout (${files.length} files) — skipping batch`)
            try { w.terminate() } catch {}
            res([])
          }, 300000)
          w.on('message', (msg) => { clearTimeout(timer); res(msg.results); w.terminate() })
          w.on('error', (e) => { clearTimeout(timer); console.error(`[code-index] parse worker error: ${e.message}`); res([]) })
          w.postMessage({ files, repo })
        })
        const workerResults = await Promise.all(batches.map(b => runWorker(b)))
        parsed = workerResults.flat()
        console.error(`[code-index] parse: ${parsed.length}/${changedFiles.length} files in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
      }

      const CHUNK = 200
      const results = []
      for (let i = 0; i < parsed.length; i += CHUNK) {
        const chunk = parsed.slice(i, i + CHUNK)
        const txResults = this._db.transaction(() => {
          const r = []
          for (const p of chunk) r.push(this._indexFileDb(p.relPath, p.sourceLength, p.symbols, p.refs, mtimeMap.get(p.relPath) || Date.now()))
          return r
        })()
        results.push(...txResults)
        if (onProgress) onProgress(Math.min(i + CHUNK, parsed.length), parsed.length)
        if (i + CHUNK < parsed.length) await new Promise(r => setImmediate(r))
      }
      console.error(`[code-index] insert: ${parsed.length} files in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
      if (typeof global.gc === 'function') global.gc()
      const resolved = this._resolveCrossFileRefs()
      console.error(`[code-index] resolve: ${resolved} refs in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
      return results
    } finally {
      if (rebuildIndexes) {
        this._db.exec('CREATE INDEX IF NOT EXISTS idx_sym_name ON symbols(name); CREATE INDEX IF NOT EXISTS idx_sym_file ON symbols(file_id); CREATE INDEX IF NOT EXISTS idx_sym_type ON symbols(type); CREATE INDEX IF NOT EXISTS idx_sym_parent ON symbols(parent_id); CREATE INDEX IF NOT EXISTS idx_ref_source ON refs(source_symbol_id); CREATE INDEX IF NOT EXISTS idx_ref_target ON refs(target_symbol_id); CREATE INDEX IF NOT EXISTS idx_ref_file ON refs(source_file_id); CREATE INDEX IF NOT EXISTS idx_ref_name ON refs(target_name)')
      }
      this._db.pragma('synchronous=NORMAL')
      console.error(`[code-index] ${rebuildIndexes ? 'indexes rebuilt' : 'indexes kept'}, total ${((Date.now() - t0) / 1000).toFixed(1)}s`)
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

    // 启动文件监听器（增量索引）
    function startWatcher(dir) {
      self._watchedDir = dir
      if (!existsSync(dir)) return
      const pendingChanges = new Set()
      try {
        self._watcher = watch(dir, { recursive: true }, (eventType, filename) => {
          if (!filename) return
          const ext = extname(filename)
          if (!CACHED_EXT.has(ext)) return
          const parts = filename.split(/[\\/]/)
          if (parts.some(p => DEFAULT_IGNORE_DIRS.has(p))) return
          pendingChanges.add(filename)
          if (self._watcherTimer) clearTimeout(self._watcherTimer)
          self._watcherTimer = setTimeout(() => {
            const files = Array.from(pendingChanges)
            pendingChanges.clear()
            for (const f of files) {
              const fullPath = join(dir, f)
              if (existsSync(fullPath)) {
                self.syncFileChange(fullPath)
              }
            }
          }, WATCHER_DEBOUNCE)
        })
        self._core.log('info', `[code-index] watching ${dir}`)
      } catch (e) {
        self._core.log('warn', `[code-index] watch failed: ${e.message}`)
      }
    }

    core.registerService('codeIndex', {
      // 初始化 workspace（供 handler 调用）
      initWorkspace(workspaceDir) {
        initWorkspaceDb(workspaceDir)
        if (!self._watcher || self._watchedDir !== resolve(workspaceDir)) {
          if (self._watcher) { self._watcher.close(); self._watcher = null }
          startWatcher(resolve(workspaceDir))
        }
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

      getSymbolsAtLine(filePath, line) {
        const f = self._db.prepare('SELECT id FROM files WHERE path = ?').get(filePath)
        if (!f) return []
        return self._db.prepare("SELECT id, name, type, start_line, end_line FROM symbols WHERE file_id = ? AND ? BETWEEN start_line AND end_line ORDER BY end_line - start_line ASC").all(f.id, line)
      },

      async getImpactAnalysis(filePath, { symbol, changeType = 'modify', maxCallers = 20, depth = 2 } = {}) {
        const cacheKey = `${self._currentWorkspace || ''}\0${filePath}\0${symbol || ''}\0${changeType}\0${maxCallers}\0${depth}`
        if (self._impactCache.has(cacheKey)) {
          const cached = self._impactCache.get(cacheKey)
          cached._fromCache = true
          return cached
        }

        const f = self._db.prepare('SELECT id FROM files WHERE path = ?').get(filePath)
        if (!f) return { file: filePath, symbol: symbol || null, callers: [], importers: [], callees: [], truncated: false, caller_count: { direct: 0, indirect: 0, test: 0, import: 0 }, risk_level: 'low', limitations: [] }

        let symLine = 0
        let symId = 0
        if (symbol) {
          const sym = self._db.prepare('SELECT id, start_line FROM symbols WHERE name = ? AND file_id = ?').get(symbol, f.id)
                     || self._db.prepare('SELECT id, start_line FROM symbols WHERE name = ?').get(symbol)
          if (sym) { symLine = sym.start_line; symId = sym.id }
        }

        let refs
        if (symbol) {
          refs = self._db.prepare(
            "SELECT r.id, r.source_file_id, f.path AS source_file_path, r.target_name, r.kind, r.source_symbol_id, r.target_symbol_id, r.line, r.call_expr " +
            "FROM refs r JOIN files f ON r.source_file_id = f.id " +
            "WHERE r.target_name = ? AND r.source_file_id != ?"
          ).all(symbol, f.id)
        } else {
          refs = self._db.prepare(
            "SELECT r.id, r.source_file_id, f.path AS source_file_path, r.target_name, r.kind, r.source_symbol_id, r.target_symbol_id, r.line, r.call_expr " +
            "FROM refs r JOIN files f ON r.source_file_id = f.id " +
            "WHERE r.target_name IN (SELECT name FROM symbols WHERE file_id = ?) AND r.source_file_id != ?"
          ).all(f.id, f.id)
        }

        const directCallers = []
        const testCallers = []
        const importers = []
        const seenKeys = new Set()

        for (const r of refs) {
          if (r.kind === 'import') {
            importers.push({ file: r.source_file_path, line: r.line || 0, ref_type: 'import' })
            continue
          }
          const { func: callerFunc } = self._resolveRefDetail(r.source_symbol_id)
          const refLine = r.line || 0
          const isTest = self._isTestFile(r.source_file_path)
          const key = `${r.source_file_path}\0${callerFunc || ''}`
          seenKeys.add(key)
          const info = {
            type: isTest ? 'test' : 'direct',
            ref_type: r.kind,
            file: r.source_file_path,
            line: refLine,
            function: callerFunc,
            call_expr: r.call_expr || '',
            context: self._extractContext(r.source_file_path, refLine),
          }
          if (isTest) testCallers.push(info)
          else directCallers.push(info)
        }

        const indirectCallers = []
        if (symbol && depth >= 2) {
          const indirect = self._findIndirectCallers(symbol, depth, filePath)
          for (const entry of indirect) {
            const key = `${entry.file}\0${entry.function || ''}`
            if (seenKeys.has(key)) continue
            seenKeys.add(key)
            const isTest = self._isTestFile(entry.file)
            const info = {
              type: isTest ? 'test' : 'indirect',
              ref_type: 'indirect',
              file: entry.file,
              line: entry.line || 0,
              function: entry.function,
              call_expr: '',
              context: self._extractContext(entry.file, entry.line || 0),
              depth: entry.depth,
              via: entry.via,
            }
            if (isTest) testCallers.push(info)
            else indirectCallers.push(info)
          }
        }

        const allCallers = [...directCallers, ...indirectCallers, ...testCallers]
        const truncated = allCallers.length > maxCallers

        const callees = symbol && symId ? self._findCallees(symId, filePath) : []

        const result = {
          symbol: symbol || null,
          file: filePath,
          line: symLine,
          change_type: changeType,
          callers: allCallers.slice(0, maxCallers),
          importers: importers.slice(0, maxCallers),
          callees: callees.slice(0, maxCallers),
          truncated,
          caller_count: {
            direct: directCallers.length,
            indirect: indirectCallers.length,
            test: testCallers.length,
            import: importers.length,
          },
          risk_level: self._calculateRisk(directCallers.length, testCallers.length, changeType),
          limitations: ['dynamic_calls_invisible', 'method_dispatch_by_name'],
        }

        self._impactCache.set(cacheKey, result)
        if (self._impactCache.size > self._impactCacheMax) {
          const oldest = self._impactCache.keys().next().value
          self._impactCache.delete(oldest)
        }
        return result
      },

      async getModuleDependencies(filePath, { depth = 3 } = {}) {
        const f = self._db.prepare('SELECT id FROM files WHERE path = ?').get(filePath)
        if (!f) return { file: filePath, imports: [], transitive: [] }
        const imports = self._db.prepare("SELECT r.target_name AS module FROM refs r WHERE r.source_file_id = ? AND r.kind = 'import'").all(f.id)
        const transitive = []
        if (depth > 1) {
          const visited = new Set([filePath])
          let queue = imports.map(i => i.module).filter(m => m && !m.startsWith('node:'))
          for (let d = 1; d < depth && queue.length; d++) {
            const next = []
            for (const mod of queue) {
              if (visited.has(mod)) continue
              visited.add(mod)
              const cleanMod = mod.replace(/^\.\.?\//, '')
              let mf = self._db.prepare("SELECT id, path FROM files WHERE path LIKE ?").get(`%${cleanMod}%`)
              if (!mf && cleanMod.includes('.')) {
                const slashed = cleanMod.replace(/\./g, '/')
                mf = self._db.prepare("SELECT id, path FROM files WHERE path LIKE ?").get(`%${slashed}%`)
              }
              if (!mf) continue
              const sub = self._db.prepare("SELECT r.target_name AS module FROM refs r WHERE r.source_file_id = ? AND r.kind = 'import'").all(mf.id)
              for (const s of sub) {
                if (!visited.has(s.module) && !s.module.startsWith('node:')) {
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

      getFileMtime(filePath) {
        const f = self._db.prepare('SELECT mtime FROM files WHERE path = ?').get(filePath)
        return f ? f.mtime : 0
      },

      clearCachesForFile(filePath) {
        const absPath = self._currentWorkspace ? join(self._currentWorkspace, filePath) : filePath
        self._contextCache.delete(absPath)
        for (const key of self._outlineCache.keys()) {
          if (key.includes(`\0${filePath}\0`)) self._outlineCache.delete(key)
        }
        for (const key of self._impactCache.keys()) {
          if (key.includes(`\0${filePath}\0`)) self._impactCache.delete(key)
        }
      },

      async getFileOutline(filePath, { depth = 1, includeRefs = false, includeTestRefs = false, maxItems = 50 } = {}) {
        const cacheKey = `${self._currentWorkspace || ''}\0${filePath}\0${depth}\0${includeRefs}\0${includeTestRefs}\0${maxItems}`
        if (self._outlineCache.has(cacheKey)) {
          return self._outlineCache.get(cacheKey)
        }

        const f = self._db.prepare('SELECT id, size, mtime FROM files WHERE path = ?').get(filePath)
        if (!f) return { error: 'file_not_found', message: `File not indexed: ${filePath}`, suggestion: `Call reindex(workspace_dir=...) to index the project first` }

        const symbols = self._db.prepare('SELECT id, name, type, signature, start_line, end_line FROM symbols WHERE file_id = ? ORDER BY start_line').all(f.id)

        const docstrings = self._extractDocstrings(filePath, symbols)
        const decorators = self._extractDecorators(filePath, symbols)

        const rootSymbols = symbols.filter(s => !symbols.some(c => c.start_line <= s.start_line && c.end_line >= s.end_line && c.id !== s.id))
        const truncated = rootSymbols.length > maxItems
        const slice = truncated ? rootSymbols.slice(0, maxItems) : rootSymbols

        const outline = await Promise.all(slice.map(s => buildOutlineNode(s, symbols, depth - 1, includeRefs, includeTestRefs)))

        const result = {
          file: filePath,
          lines: symbols.length > 0 ? Math.max(...symbols.map(s => s.end_line)) : 0,
          tokens_estimate: f.size ? Math.ceil(f.size / 3) : 0,
          mtime: f.mtime || 0,
          truncated,
          outline
        }

        self._outlineCache.set(cacheKey, result)
        if (self._outlineCache.size > self._outlineCacheMax) {
          const oldest = self._outlineCache.keys().next().value
          self._outlineCache.delete(oldest)
        }

        return result

        async function buildOutlineNode(sym, allSyms, remainingDepth, countRefs, countTestRefs) {
          const children = allSyms.filter(c => c.id !== sym.id && c.start_line >= sym.start_line && c.end_line <= sym.end_line && !allSyms.some(g => g.id !== sym.id && g.id !== c.id && g.start_line <= c.start_line && g.end_line >= c.end_line))
          const node = { type: sym.type, name: sym.name, line: sym.start_line, end_line: sym.end_line }
          if (sym.signature) node.signature = sym.signature
          if (sym.name.startsWith('_') && !sym.name.startsWith('__')) node.private = true
          if (docstrings[sym.start_line]) node.docstring = docstrings[sym.start_line]
          if (decorators[sym.start_line]) node.decorators = decorators[sym.start_line]
          if (children.length > 0 && remainingDepth >= 0) {
            node.children = await Promise.all(children.map(c => buildOutlineNode(c, allSyms, remainingDepth - 1, countRefs, countTestRefs)))
          }
          if (countRefs) {
            const refCount = self._db.prepare('SELECT COUNT(*) as cnt FROM refs WHERE target_name = ? AND (source_file_id != ? OR kind != \'import\')').get(sym.name, f.id)
            node.refs = refCount.cnt
          }
          if (countTestRefs && !self._isTestFile(filePath)) {
            node.test_refs = self._db.prepare("SELECT COUNT(*) as cnt FROM refs r JOIN files f2 ON r.source_file_id = f2.id WHERE r.target_name = ? AND f2.path LIKE '%test%'").get(sym.name).cnt
          }
          return node
        }
      },

      watchDirectory(dir) {
        if (self._watcher) { self._watcher.close(); self._watcher = null }
        const resolvedDir = resolve(dir)
        if (!existsSync(resolvedDir)) return { status: 'not_found', dir }
        startWatcher(resolvedDir)
        if (self._watcher) {
          return { status: 'watching', dir: resolvedDir }
        } else {
          return { status: 'error', message: 'Failed to start watcher' }
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
