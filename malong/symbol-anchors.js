// 码龙 — 符号锚点（原语化 P1）
// 附录 A：symbol_id = lang:path::qualified_name#kind，身份锚不含 range/hash/signature
// 提取器只返回 name/type/startLine/endLine → JS 侧重建 parent 链（stack 嵌套检测）与 signature（定义行）
// 消歧：signature-based 优先，ordinal 兜底；无法生成稳定 id → 返回 null（调用方降级 patch）

import { readFileSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'
import { bodyHash, signatureHash } from './hash-utils.js'

const LANG_BY_EXT = {
  '.py': 'py', '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'js', '.ts': 'ts', '.tsx': 'ts', '.mts': 'ts', '.cts': 'ts',
  '.go': 'go', '.rs': 'rs', '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.hh': 'cpp', '.hxx': 'cpp',
  '.java': 'java', '.sh': 'bash', '.bash': 'bash',
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
    // pop 用 <（end 相同不算结束：子符号可结束于父的同一行，如 __init__ 体首行 self 与 __init__ 同 end 行）
    // 同起始行才是「并行定义」（def a(): x=1; def b(): y=2 内联）——不互为 parent（P2-C13）
    while (stack.length && stack[stack.length - 1].end_line < s.start_line) stack.pop()
    if (stack.length) {
      const top = stack[stack.length - 1]
      if (top.start_line !== s.start_line) parents.set(s.id, top.id)
    }
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
