// 码龙 — 符号锚点（原语化 P1）
// 附录 A：symbol_id = lang:path::qualified_name#kind，身份锚不含 range/hash/signature
// 提取器只返回 name/type/startLine/endLine → JS 侧重建 parent 链（stack 嵌套检测）与 signature（定义行）
// 消歧：signature-based 优先，ordinal 兜底；无法生成稳定 id → 返回 null（调用方降级 patch）

import { readFileSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'
import { bodyHash, signatureHash } from './hash-utils.js'

const LANG_BY_EXT = {
  '.py': 'py', '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.ts': 'ts',
  '.go': 'go', '.rs': 'rs',
}
const MAX_INDEX_SIZE = 1024 * 1024

export function langOf(filePath) {
  return LANG_BY_EXT[extname(filePath)] || null
}

export function buildParentMap(symbols) {
  const sorted = [...symbols].sort((a, b) => a.start_line - b.start_line || a.end_line - b.end_line)
  const parents = new Map()
  const stack = []
  for (const s of sorted) {
    while (stack.length && stack[stack.length - 1].end_line < s.start_line) stack.pop()
    if (stack.length) parents.set(s.id, stack[stack.length - 1].id)
    stack.push(s)
  }
  return parents
}

export function buildQualifiedName(symbols, parents, sym) {
  const byId = new Map(symbols.map(s => [s.id, s]))
  const chain = []
  let cur = sym
  const seen = new Set()
  while (cur) {
    if (seen.has(cur.id)) break
    seen.add(cur.id)
    chain.unshift(cur.name)
    cur = parents.has(cur.id) ? byId.get(parents.get(cur.id)) : null
  }
  return chain.join('.')
}

export function extractSignatureLine(lines, sym) {
  for (let i = sym.start_line - 1; i < Math.min(lines.length, sym.start_line + 3); i++) {
    const t = (lines[i] || '').trim()
    if (!t || t.startsWith('@')) continue
    return t
  }
  return ''
}

export function makeStableId({ lang, path, qualifiedName, kind }) {
  if (!lang || !path || !qualifiedName) return null
  const safe = qualifiedName.replace(/[#:]/g, '_')
  return `${lang}:${path}::${safe}#${kind}`
}

function resolveAmbiguities(rows) {
  const base = new Map()
  for (const r of rows) {
    if (!base.has(r.stableId)) base.set(r.stableId, [])
    base.get(r.stableId).push(r)
  }
  for (const [id, group] of base) {
    if (group.length === 1) { group[0].stableId = id; continue }
    const sigCount = new Map()
    for (const r of group) {
      const sig = r.signatureHash.slice(0, 8)
      sigCount.set(sig, (sigCount.get(sig) || 0) + 1)
    }
    const ordinal = new Map()
    for (const r of group) {
      const sig = r.signatureHash.slice(0, 8)
      if (sigCount.get(sig) === 1) {
        r.stableId = `${id}#sig-${sig}`
      } else {
        const n = (ordinal.get(sig) || 0) + 1
        ordinal.set(sig, n)
        r.stableId = `${id}#sig-${sig}#${n}`
      }
    }
  }
  return rows
}

export function computeFileAnchors(absPath, relPath, symbols) {
  if (!existsOrNull(absPath)) return null
  const { size } = statSync(absPath)
  if (size > MAX_INDEX_SIZE) return null
  const content = readFileSync(absPath, 'utf-8')
  const lines = content.split('\n')
  const parents = buildParentMap(symbols)
  const rows = []
  for (const sym of symbols) {
    const qualifiedName = buildQualifiedName(symbols, parents, sym)
    const signature = extractSignatureLine(lines, sym)
    const body = lines.slice(sym.start_line - 1, Math.max(sym.start_line, sym.end_line)).join('\n')
    rows.push({
      id: sym.id,
      name: sym.name,
      kind: sym.type,
      parentId: parents.get(sym.id) || null,
      signature,
      qualifiedName,
      stableId: makeStableId({
        lang: langOf(absPath),
        path: relPath || absPath,
        qualifiedName,
        kind: sym.type,
      }),
      bodyHash: bodyHash(body),
      signatureHash: signatureHash(signature),
    })
  }
  return resolveAmbiguities(rows)
}

function existsOrNull(p) {
  try { statSync(p); return true } catch { return false }
}

export async function backfillSymbolAnchors(workspaceDir, codeIndexService) {
  const db = codeIndexService._db
  if (!db) return { files: 0, symbols: 0, failed: [] }
  const files = db.prepare('SELECT id, path FROM files').all()
  let symCount = 0
  const failed = []
  for (const f of files) {
    const absPath = join(workspaceDir, f.path)
    if (!existsOrNull(absPath)) { failed.push({ file: f.path, reason: 'missing' }); continue }
    const symbols = db.prepare('SELECT id, name, type, start_line, end_line FROM symbols WHERE file_id = ?').all(f.id)
    if (symbols.length === 0) continue
    const anchors = computeFileAnchors(absPath, f.path, symbols)
    if (!anchors) { failed.push({ file: f.path, reason: 'too_large_or_unreadable' }); continue }
    const upd = db.prepare('UPDATE symbols SET parent_id = ?, signature = ?, stable_id = ?, body_hash = ?, signature_hash = ? WHERE id = ?')
    // 逐行 UPDATE 无事务 → 崩溃留混合状态（部分符号有锚点部分没有，stable_id 查找半失效）——
    // 递归进化第 5 轮 P1#18
    db.transaction(() => {
      for (const a of anchors) {
        upd.run(a.parentId, a.signature, a.stableId, a.bodyHash, a.signatureHash, a.id)
        symCount++
      }
    })()
  }
  return { files: files.length, symbols: symCount, failed }
}
