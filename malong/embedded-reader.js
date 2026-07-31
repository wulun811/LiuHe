// embedded-reader.js — 读侧去壳（§7 原语化方案：embedded reader）
// 形态：better-sqlite3 readonly + 安全文件读取。不 import parse-client、不起 socket/watcher/server。
// 快路径：图查询（find/callers/callees/outline）纯 SQLite；正文读取按索引 range 切片（§16.2 不 parse）。
// 诚实边界：遇 dirty/stale 索引返回 INDEX_STALE（附录 D：不装对）；正文 hash 按需计算。
import { join, resolve, extname } from 'node:path'
import { readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'

const MAX_LIVE_READ = 1024 * 1024
const CODE_EXTS = new Set(['.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.hpp', '.rb', '.php'])

export class EmbeddedReader {
  constructor(dbPath, workspaceDir) {
    this.dbPath = dbPath
    this.workspaceDir = workspaceDir
    this.db = new Database(dbPath, { readonly: true })
  }

  close() {
    try { this.db.close() } catch {}
  }

  // ── 图查询（纯 SQLite 快路径） ──

  findSymbols(name, kind) {
    const rows = kind
      ? this.db.prepare('SELECT s.name, s.type, s.start_line, s.end_line, s.signature, s.stable_id, f.path AS file_path FROM symbols s JOIN files f ON s.file_id = f.id WHERE s.name = ? AND s.type = ? ORDER BY f.path, s.start_line').all(name, kind)
      : this.db.prepare('SELECT s.name, s.type, s.start_line, s.end_line, s.signature, s.stable_id, f.path AS file_path FROM symbols s JOIN files f ON s.file_id = f.id WHERE s.name = ? ORDER BY f.path, s.start_line').all(name)
    return rows
  }

  getSymbols(filePath) {
    return this.db.prepare('SELECT s.id, s.name, s.type, s.signature, s.start_line, s.end_line, s.stable_id, s.parent_id FROM symbols s JOIN files f ON s.file_id = f.id WHERE f.path = ? ORDER BY s.start_line').all(filePath)
  }

  getSymbolByStableId(stableId) {
    return this.db.prepare('SELECT s.id, s.name, s.type, s.signature, s.start_line, s.end_line, s.stable_id, s.parent_id, s.body_hash, s.signature_hash, f.path AS file_path, f.content_hash FROM symbols s JOIN files f ON s.file_id = f.id WHERE s.stable_id = ?').get(stableId) || null
  }

  getCallers(symbolId) {
    return this.db.prepare(`
      SELECT f.path AS file, r.line, ps.name AS caller_func, r.call_expr
      FROM refs r JOIN files f ON r.source_file_id = f.id
      LEFT JOIN symbols ps ON r.source_symbol_id = ps.id
      WHERE r.target_symbol_id = ? AND r.kind = 'call'
      ORDER BY f.path, r.line`).all(symbolId)
  }

  getCallees(symbolId) {
    return this.db.prepare(`
      SELECT r.target_name, r.call_expr, r.line, f2.path AS callee_file, ts.start_line AS callee_line
      FROM refs r LEFT JOIN symbols ts ON r.target_symbol_id = ts.id
      LEFT JOIN files f2 ON ts.file_id = f2.id
      WHERE r.source_symbol_id = ? AND r.kind = 'call'
      ORDER BY r.line`).all(symbolId)
  }

  getFileStatus(filePath) {
    const row = this.db.prepare('SELECT path, size, mtime, content_hash, index_state FROM files WHERE path = ?').get(filePath)
    if (!row) return { state: 'not_indexed' }
    let st = null
    try { st = statSync(join(this.workspaceDir, filePath)) } catch {
      return { state: 'stale', reason: 'file_missing_on_disk', index_state: row.index_state }
    }
    if (row.index_state !== 'fresh') return { state: 'dirty', reason: row.index_state, index_state: row.index_state }
    if (Math.abs(st.mtimeMs - row.mtime) > 1) {
      // 附录 C：mtime 变不一定内容变（touch）——真判据是 content_hash，有 hash 时不装对
      if (row.content_hash) {
        try {
          const curHash = createHash('sha256').update(readFileSync(join(this.workspaceDir, filePath))).digest('hex')
          if (curHash === row.content_hash) return { state: 'fresh', index_state: row.index_state, mtime: row.mtime, size: row.size }
        } catch {}
      }
      return { state: 'stale', reason: 'file_mtime_changed', index_state: row.index_state }
    }
    return { state: 'fresh', index_state: row.index_state, mtime: row.mtime, size: row.size }
  }

  // ── 正文读取（快路径：索引 range 切片，不 parse） ──

  readSymbol(locator, opts = {}) {
    const filePath = locator?.file_path
    if (!filePath) return { error: 'missing_parameter', message: 'file_path is required' }
    // 路径安全（§7：workspace 边界，防 ../../ 穿越）
    const wsRoot = this.workspaceDir.endsWith('/') ? this.workspaceDir : this.workspaceDir + '/'
    const resolved = resolve(wsRoot, filePath)
    if (!resolved.startsWith(wsRoot)) {
      return { error: 'PATH_BLOCKED', message: `Path escapes workspace: ${filePath}` }
    }

    // 索引状态（附录 D：embedded reader 遇 dirty/stale 返 INDEX_STALE 不装对）
    const status = this.getFileStatus(filePath)
    if (status.state !== 'fresh') {
      return { error: 'INDEX_STALE', message: `Index ${status.state} (${status.reason || 'unknown'}). Run reindex before reading.`, index_status: status }
    }

    // resolve 符号
    let symbol = null
    if (locator.symbol_id) {
      symbol = this.getSymbolByStableId(locator.symbol_id)
      if (symbol && symbol.file_path !== filePath) symbol = null
      if (!symbol) return { error: 'SYMBOL_NOT_FOUND', message: `No symbol with stable_id ${locator.symbol_id} in ${filePath}` }
    } else if (locator.name) {
      const rows = this.findSymbols(locator.name, locator.kind).filter(r => r.file_path === filePath)
      if (rows.length === 0) return { error: 'SYMBOL_NOT_FOUND', message: `No symbol named "${locator.name}" in ${filePath}` }
      if (rows.length > 1) return { error: 'AMBIGUOUS_SYMBOL', message: `${rows.length} candidates for "${locator.name}" in ${filePath}`, candidates: rows.map(r => ({ symbol_id: r.stable_id, name: r.name, kind: r.type, range: [r.start_line, r.end_line] })) }
      symbol = { ...rows[0], id: undefined }
    }

    // 安全读文件（大文件截断保护）
    let content = ''
    try {
      const st = statSync(resolved)
      if (st.size > MAX_LIVE_READ) return { error: 'FILE_TOO_LARGE', message: `File ${st.size} bytes > ${MAX_LIVE_READ} limit. Use line_range locator.`, size: st.size }
      content = readFileSync(resolved, 'utf-8')
    } catch (e) {
      return { error: 'READ_FAILED', message: e.message }
    }

    const lines = content.split('\n')
    const range = symbol ? [symbol.start_line, Math.max(symbol.start_line, symbol.end_line)] : null
    let text = null
    if (range) {
      text = lines.slice(range[0] - 1, range[1]).join('\n')
    } else if (Array.isArray(locator.line_range) && locator.line_range.length === 2) {
      const [a, b] = [Math.max(1, locator.line_range[0]), Math.max(1, locator.line_range[1])]
      text = lines.slice(a - 1, b).join('\n')
    } else {
      text = content
    }
    const budget = Math.max(200, parseInt(opts?.budget) || 1200)
    let truncated = false
    if (text.length > budget) {
      text = text.slice(0, budget) + '\n…[truncated]'
      truncated = true
    }

    return {
      file_path: filePath,
      symbol: symbol ? {
        symbol_id: symbol.stable_id || null,
        name: symbol.name,
        kind: symbol.type,
        range,
        signature: symbol.signature || null,
        text,
      } : { symbol_id: null, text },
      budget: { requested: budget, truncated },
      version: {
        file: { hash: `sha256:${createHash('sha256').update(content).digest('hex')}`, size: content.length },
        symbol: symbol ? { body_hash: `sha256:${createHash('sha256').update(text).digest('hex')}` } : null,
      },
      index_status: status,
    }
  }

  getOutline(filePath) {
    const syms = this.getSymbols(filePath)
    const tree = []
    const byId = new Map()
    for (const s of syms) {
      const node = { name: s.name, type: s.type, signature: s.signature, range: [s.start_line, s.end_line], symbol_id: s.stable_id, children: [] }
      byId.set(s.id, node)
      if (s.parent_id && byId.has(s.parent_id)) byId.get(s.parent_id).children.push(node)
      else tree.push(node)
    }
    return tree
  }
}

export function langOfPath(p) {
  return CODE_EXTS.has(extname(p)) ? extname(p).slice(1) : null
}
