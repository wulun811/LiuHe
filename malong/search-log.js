// search-log.js — 检索 MISS 的本地只追加日志（P3 用）
//
// 为什么单独一个模块、不塞进 trace.js：
//   trace.js 的字段白名单刻意不含「查询词 / 参数原文」（隐私约束，TRACE-GUIDE §2）。
//   但 P3 要「按根因聚类检索 MISS」，没有查询词就没法分类——只能看到「code_query 被调了、
//   耗时多少、成功与否」，那回答不了「为什么没搜到」。
//   所以这里是一个**独立的、默认关闭的、仅本地**的日志：只在代码命中为 0 时写一行。
//
// 边界（逐条）：
//   · 开关 MALONG_SEARCH_LOG=misses；未设或其它值 = off（不猜、不回落成开）
//   · 只在 0 命中 / 只有弱文档命中时写；正常命中不写（不做全量查询审计）
//   · 不写绝对路径：workspace 只存 sha256 前 8 位
//   · 查询词归一：折叠空白、去控制符、截 200 字（记下归一前的字数）
//   · 位置固定 <stateDir>/trace/search-misses.jsonl（与轨迹同目录、不同文件）
//   · 单文件 1MB、滚动 2 档、30 天保留（按 mtime）
//   · 写失败不改变工具结果，只返回 written:false（调用方不得因此报错）
//   · 读取只有一份口径：readSearchMisses()——聚合脚本不得自己再写一份
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { traceDir } from './trace.js'

export const SEARCH_LOG_MODES = ['off', 'misses']
export const SEARCH_LOG_FILE = 'search-misses.jsonl'
const MAX_BYTES = 1024 * 1024
const MAX_ROTATIONS = 2
const RETENTION_DAYS = 30
const QUERY_MAX_CHARS = 200

// 记录的字段白名单：写和读共用，防止以后有人顺手塞参数原文进来
const RECORD_FIELDS = [
  'v', 'ts', 'entry', 'reason', 'query', 'query_chars', 'has_ascii',
  'code_hits', 'partial_hits', 'doc_hits', 'doc_weak',
  'expanded_hits', 'search_terms', 'workspace',
]
const ENTRIES = ['code_search', 'code_task']
const REASONS = ['zero_hit', 'weak_docs_only']

export function getSearchLogMode() {
  const raw = String(process.env.MALONG_SEARCH_LOG || 'off').trim().toLowerCase()
  return SEARCH_LOG_MODES.includes(raw) ? raw : 'off'
}

export function searchLogEnabled() {
  return getSearchLogMode() !== 'off'
}

export function searchLogPath() {
  return join(traceDir(), SEARCH_LOG_FILE)
}

function toPosixInt(v) {
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.min(Math.floor(n), 1e9)
}

// 查询词归一：控制符（包括换行/制表）一律折叠成单空格，再截断。
// 目的不是「脱敏」，是把一行 JSON 保持一行、把体积钉死。
export function normalizeLoggedQuery(q) {
  const raw = String(q == null ? '' : q)
  const collapsed = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return { text: collapsed.slice(0, QUERY_MAX_CHARS), chars: collapsed.length }
}

// workspace 只留指纹：够把「同一仓库的 MISS」聚到一起，又不落绝对路径
export function workspaceFingerprint(workspaceDir) {
  const abs = resolve(String(workspaceDir || '.'))
  return 'ws-' + createHash('sha256').update(abs).digest('hex').slice(0, 8)
}

function pruneAndRotate(path) {
  try {
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000
    for (let i = 1; i <= MAX_ROTATIONS; i++) {
      const f = path + '.' + i
      try {
        if (existsSync(f) && statSync(f).mtimeMs < cutoff) rmSync(f, { force: true })
      } catch { /* 单档清理失败不影响其它 */ }
    }
    if (!existsSync(path) || statSync(path).size < MAX_BYTES) return
    const oldest = path + '.' + MAX_ROTATIONS
    if (existsSync(oldest)) rmSync(oldest, { force: true })
    for (let i = MAX_ROTATIONS - 1; i >= 1; i--) {
      const cur = path + '.' + i
      if (existsSync(cur)) renameSync(cur, path + '.' + (i + 1))
    }
    renameSync(path, path + '.1')
  } catch { /* 轮转失败不阻断写入：宁可单文件大一点 */ }
}

// 写一条 MISS。永不抛错：调用方是工具 handler，日志失败不得改变工具结果。
export function logSearchMiss(entry = {}) {
  if (!searchLogEnabled()) return { written: false, reason: 'disabled' }
  const reason = REASONS.includes(entry.reason) ? entry.reason : 'zero_hit'
  const entryName = ENTRIES.includes(entry.entry) ? entry.entry : 'code_search'
  const q = normalizeLoggedQuery(entry.query)
  if (!q.text) return { written: false, reason: 'empty_query' }
  const record = {
    v: 1,
    ts: new Date().toISOString(),
    entry: entryName,
    reason,
    query: q.text,
    query_chars: q.chars,
    has_ascii: /[A-Za-z_][A-Za-z0-9_]{1,}/.test(q.text),
    code_hits: toPosixInt(entry.codeHits),
    partial_hits: toPosixInt(entry.partialHits),
    doc_hits: toPosixInt(entry.docHits),
    doc_weak: toPosixInt(entry.docWeak),
    expanded_hits: toPosixInt(entry.expandedHits),
    search_terms: toPosixInt(entry.searchTerms),
    workspace: workspaceFingerprint(entry.workspaceDir),
  }
  const path = searchLogPath()
  try {
    mkdirSync(join(path, '..'), { recursive: true })
    pruneAndRotate(path)
    appendFileSync(path, JSON.stringify(record) + '\n')
    return { written: true, path, reason }
  } catch (e) {
    return { written: false, reason: 'write_failed', error: String(e && e.message || e).slice(0, 120) }
  }
}

function traceFiles() {
  const base = searchLogPath()
  const out = []
  for (let i = MAX_ROTATIONS; i >= 1; i--) {
    const f = base + '.' + i
    if (existsSync(f)) out.push(f)
  }
  if (existsSync(base)) out.push(base)
  return out
}

function sanitize(rec) {
  if (!rec || typeof rec !== 'object') return null
  const out = {}
  for (const k of RECORD_FIELDS) if (Object.prototype.hasOwnProperty.call(rec, k)) out[k] = rec[k]
  if (!RECORD_FIELDS.some(k => Object.prototype.hasOwnProperty.call(out, k))) return null
  return out
}

// 唯一读取口径：最旧轮转档 → 最新主文件；坏行跳过并计数；时间窗在这里过滤。
export function readSearchMisses({ limit = 500, sinceMs = null } = {}) {
  const files = traceFiles()
  const entries = []
  let badLines = 0
  const since = Number.isFinite(sinceMs) ? sinceMs : null
  for (const f of files) {
    let text = ''
    try { text = readFileSync(f, 'utf8') } catch { continue }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let rec = null
      try { rec = JSON.parse(line) } catch { badLines++; continue }
      const clean = sanitize(rec)
      if (!clean) { badLines++; continue }
      if (since != null) {
        const t = Date.parse(clean.ts)
        if (!Number.isFinite(t) || t < since) continue
      }
      entries.push(clean)
    }
  }
  const sliced = limit > 0 ? entries.slice(-limit) : entries
  return { entries: sliced, total: entries.length, bad_lines: badLines, files: files.map(f => f.split('/').pop()) }
}

// 只读统计（triage / health 用）：回答「有没有在记、记了多少」，不用读全量
export function searchLogStats() {
  const mode = getSearchLogMode()
  const path = searchLogPath()
  const files = traceFiles()
  let bytes = 0
  for (const f of files) { try { bytes += statSync(f).size } catch { /* 忽略 */ } }
  return {
    mode,
    enabled: mode !== 'off',
    dir: traceDir(),
    path,
    files: files.length,
    bytes,
    note: mode === 'off'
      ? 'not collecting (MALONG_SEARCH_LOG unset or off) — an empty log here does NOT mean "no misses happened"'
      : 'collecting: one line per query that produced zero code hits',
  }
}

// 目录是否可写（triage 提示用，不建目录、不改状态）
export function searchLogReadable() {
  try { return readdirSync(traceDir()).length >= 0 } catch { return false }
}
