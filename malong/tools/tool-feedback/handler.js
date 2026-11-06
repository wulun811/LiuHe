import { appendFileSync, readFileSync, existsSync, statSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

// R22-⑮：jsonl 无界增长防护——>MAX_FEEDBACK_BYTES 轮转，保留 MAX_ROTATIONS 个历史轮转文件
const MAX_FEEDBACK_BYTES = 5 * 1024 * 1024
const MAX_ROTATIONS = 3

// R7-CE20（专家 2026-10-30，P1）：读端必须读回轮转历史，否则「写端轮转、读端只读主文件」
// 会让旧反馈在磁盘上还没过期就已经查不到，下一次轮转后永久消失。
// 有界：历史合并受全局条数与字节双上限约束，不为了展示 500 条把巨量历史全部读进内存。
const MAX_LISTED_ENTRIES = 5000
const MAX_LISTED_BYTES = 16 * 1024 * 1024
// 单条 issue/note 字节上限：防一次提交就造出 5MB 单行 JSONL
const MAX_FIELD_BYTES = { issue: 8 * 1024, note: 4 * 1024 }

// R7-CE20：默认不落盘敏感内容——密钥形态与绝对路径在写入前脱敏
const SECRET_PATTERNS = [
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, '<redacted-key>'],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{16,}/g, '$1 <redacted-token>'],
  [/\b(api[_-]?key|access[_-]?token|secret|password)\b\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{12,}/gi, '$1=<redacted>'],
  [/(?:\/|[A-Za-z]:[\\/])(?:[\w.@+-]+[\\/]){2,}[\w.@+-]+/g, '<abs-path>'],
]

function sanitizeField(raw, kind) {
  let text = typeof raw === 'string' ? raw : (raw == null ? '' : String(raw))
  let redactions = 0
  for (const [re] of SECRET_PATTERNS) {
    text = text.replace(re, (...m) => {
      redactions++
      if (m[0].startsWith('Bearer')) return `Bearer <redacted-token>`
      if (/^(api[_-]?key|access[_-]?token|secret|password)/i.test(m[0])) return `${m[1]}=<redacted>`
      if (m[0].startsWith('<')) return m[0]
      if (/^(sk-)/.test(m[0])) return '<redacted-key>'
      return '<abs-path>'
    })
  }
  const maxBytes = MAX_FIELD_BYTES[kind] || 4096
  let truncated = false
  if (Buffer.byteLength(text, 'utf-8') > maxBytes) {
    truncated = true
    let buf = Buffer.from(text, 'utf-8').subarray(0, maxBytes)
    while (buf.length > 0 && (buf[buf.length - 1] & 0xc0) === 0x80) buf = buf.subarray(0, buf.length - 1)
    text = buf.toString('utf-8') + '…[truncated]'
  }
  return { text, truncated, redactions }
}

// R16B-PRIV02（专家 2026-10-31 r16b 复审 P1）：只脱敏 issue/note 不够——
// error_code、session、tool 同样是调用方可控输入，此前原样落盘。现在：
//   · error_code 只收结构化安全码（标识符形态），自由文本不回显原值
//   · session 只存不可逆短哈希（仍可跨条目关联，不能还原宿主注入的原文）
//   · tool 收敛为标识符形态，其余归 unknown
const FEEDBACK_TOOL_RE = /^[a-z][a-z0-9_-]{0,63}$/
const SAFE_ERROR_CODE_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/
const SECRETISH_RE = /\bsk-[A-Za-z0-9_-]{8,}|\bBearer\b|api[_-]?key|access[_-]?token|\bsecret\b|\bpassword\b/i

function sanitizeToolName(raw) {
  const s = typeof raw === 'string' ? raw.trim() : ''
  return FEEDBACK_TOOL_RE.test(s) && !SECRETISH_RE.test(s) ? s : 'unknown'
}

function sanitizeErrorCode(raw) {
  const s = typeof raw === 'string' ? raw.trim() : ''
  if (!s) return ''
  return SAFE_ERROR_CODE_RE.test(s) && !SECRETISH_RE.test(s) ? s : 'redacted_error_code'
}

function opaqueSessionRef(raw) {
  const s = typeof raw === 'string' ? raw.trim() : ''
  if (!s) return ''
  return 'sess-' + createHash('sha256').update(s).digest('hex').slice(0, 12)
}

// 轮转索引：固定保留 MAX_ROTATIONS 个历史文件（.1 最新 … .MAX_ROTATIONS 最旧）。
// R7-CE20 off-by-one 修正：旧实现从 i=MAX_ROTATIONS 起把 .MAX 搬到 .MAX+1，结果保留 MAX+1 个文件。
function rotateIfNeeded(path) {
  try {
    if (statSync(path).size < MAX_FEEDBACK_BYTES) return { rotated: false }
    // ① 先丢掉最旧的一档，保证轮转后恰好 MAX_ROTATIONS 个历史文件
    const oldest = `${path}.${MAX_ROTATIONS}`
    if (existsSync(oldest)) rmSync(oldest, { force: true })
    // ② 逐级后移：.MAX-1 → .MAX … .1 → .2
    for (let i = MAX_ROTATIONS - 1; i >= 1; i--) {
      const cur = `${path}.${i}`
      if (existsSync(cur)) renameSync(cur, `${path}.${i + 1}`)
    }
    // ③ 主文件 → .1
    renameSync(path, `${path}.1`)
    return { rotated: true }
  } catch (e) {
    if (e && e.code === 'ENOENT') return { rotated: false } // 首次写入：主文件尚不存在
    // 2026-10-04：轮转失败不再静默（此前 catch {} 全吞，磁盘无界增长无任何信号）
    return { rotated: false, error: e?.message || String(e) }
  }
}



import { ensureStateDir, getLegacyDir, getSessionId, resolveStateFile } from '../../host-config.js'

function getFeedbackPath() {
  ensureStateDir()
  return resolveStateFile('malong-feedback.jsonl')
}

// Y001-S5 + 2026-10-04 修复：list 聚合端同时读取新路径与旧路径（0AIT 旧副本
// ~/.config/opencode/）——此前 readStateFile 在新路径存在时完全遮蔽旧数据；
// 坏行不静默：计入 skipped_malformed。
// R7-CE20（P1）：在两条路径上各自再读回轮转历史（.1 … .MAX_ROTATIONS）。
// 顺序固定：主文件（最新）→ .1 → .2 → .3；legacy 路径同规则排在后面。
// 有界：全局条数 MAX_LISTED_ENTRIES 与字节 MAX_LISTED_BYTES 双上限，越限后停止读取并标记。
function feedbackFileChain(path) {
  if (!path) return []
  const chain = [path]
  for (let i = 1; i <= MAX_ROTATIONS; i++) chain.push(`${path}.${i}`)
  return chain
}

function readFeedbackFiles() {
  const current = resolveStateFile('malong-feedback.jsonl')
  const legacy = join(getLegacyDir(), 'malong-feedback.jsonl')
  const roots = [current]
  if (legacy !== current) roots.push(legacy)
  const sources = []
  const files = []
  for (const root of roots) {
    // 只有主文件不存在才记录 source（轮转文件缺失是常态，不刷噪声）
    if (!existsSync(root)) sources.push({ path: root, entries: 0, rotated: false })
    for (const p of feedbackFileChain(root)) if (existsSync(p)) files.push({ p, root })
  }
  const entries = []
  const recency = []
  let skipped = 0
  let bytesRead = 0
  let budgetExhausted = null
  // R16B-FB01（专家 2026-10-31 r16b 复审 P1）：给每条记录一个单调写入序——
  // 文件序号越大越旧，同文件内行号越大越新。旧实现把数组尾部当「最近」，
  // 而尾部恰恰是最旧的轮转档（主文件→.1→.2 的拼接顺序造成的）。
  for (let fileIdx = 0; fileIdx < files.length; fileIdx++) {
    if (budgetExhausted) break
    const { p, root } = files[fileIdx]
    const seqBase = (files.length - fileIdx) * 1e6
    let n = 0
    let text
    try {
      const size = statSync(p).size
      if (bytesRead + size > MAX_LISTED_BYTES) {
        budgetExhausted = `byte_budget_exceeded at ${p}`
        break
      }
      text = readFileSync(p, 'utf-8')
      bytesRead += Buffer.byteLength(text, 'utf-8')
    } catch {
      skipped++
      continue
    }
    let lineIdx = 0
    for (const line of text.split('\n')) {
      if (!line) continue
      if (entries.length >= MAX_LISTED_ENTRIES) { budgetExhausted = `entry_budget_exceeded at ${p}`; break }
      try {
        entries.push(JSON.parse(line))
        recency.push(seqBase + lineIdx)
        lineIdx++
        n++
      } catch { skipped++ }
    }
    sources.push({ path: p, entries: n, rotated: p !== root })
  }
  return {
    entries, recency, sources, skipped,
    budget_exhausted: budgetExhausted,
    bytes_read: bytesRead,
    path: existsSync(current) ? current : legacy,
  }
}

function listFeedback(toolFilter, limit) {
  const { entries, recency, sources, skipped, path, budget_exhausted, bytes_read } = readFeedbackFiles()
  const byTool = Object.create(null)
  for (const e of entries) byTool[e.tool] = (byTool[e.tool] || 0) + 1
  // R16B-FB01（专家 2026-10-31 r16b 复审 P1）：recent = 「最近」，不是「数组尾部」。
  //   · 主序：记录里的有效时间戳倒序
  //   · 缺失/非法时间戳：退到写入序（有效时间戳优先，非法/缺失排后）
  //   · 同时间戳或都无时间戳：写入序倒序（后写入者在前）
  // 同一份数据多次调用结果必须一致（确定性）。
  const timeOf = (e) => {
    const t = typeof e?.timestamp === 'string' ? Date.parse(e.timestamp) : NaN
    return Number.isFinite(t) ? t : null
  }
  const picked = []
  for (let i = 0; i < entries.length; i++) {
    if (!toolFilter || entries[i].tool === toolFilter) picked.push(i)
  }
  picked.sort((a, b) => {
    const ta = timeOf(entries[a])
    const tb = timeOf(entries[b])
    if (ta !== null && tb !== null && ta !== tb) return tb - ta
    if (ta !== null && tb === null) return -1
    if (ta === null && tb !== null) return 1
    return recency[b] - recency[a]
  })
  return {
    path, total: entries.length, total_filtered: picked.length, by_tool: byTool,
    recent: picked.slice(0, limit).map(i => entries[i]), sources, skipped_malformed: skipped,
    // R7-CE20：读回边界显式化——不得让「没列全」看起来像「不存在」
    history: {
      rotations_read: sources.filter(s => s.rotated).length,
      budget_exhausted: budget_exhausted || null,
      bytes_read,
    },
  }
}

export async function handle(args, context) {
  // 第二轮审查：未知 action 不再静默降级为 record（与 code_* 家族对齐）
  if (args?.action != null && args.action !== 'record' && args.action !== 'list') {
    return { error: 'invalid_input', message: `Unknown action: ${args.action}`, valid_actions: ['record', 'list'], suggestion: 'Omit action for record, or use action="list".' }
  }
  if (args?.action === 'list') {
    const toolFilter = args?.tool || ''
    const rawLimit = parseInt(args?.limit)
    const limit = Number.isNaN(rawLimit) ? 50 : Math.min(500, Math.max(1, rawLimit))
    const { path, total, total_filtered, by_tool, recent, sources, skipped_malformed, history } = listFeedback(toolFilter, limit)
    return {
      status: 'ok',
      total,
      total_filtered,
      by_tool,
      recent,
      path,
      sources,
      skipped_malformed,
      history,
      next_step: total > 0
        ? 'Review and fix top issues. Usage insights: health(action="check", stats=true)'
        : 'No feedback yet. Tools are on probation until exercised — report issues to improve them.',
    }
  }

  const tool = args?.tool || 'unknown'
  const rawIssue = args?.issue || ''
  const rawNote = args?.note || ''
  const errorCode = args?.error_code || ''

  if (!rawIssue || !String(rawIssue).trim()) {
    return { error: 'missing_parameter', message: 'issue is required', suggestion: 'Describe what went wrong or could be improved' }
  }

  // R7-CE20：单条字节上限 + 敏感内容脱敏（默认不落盘源码片段/Key/Token/绝对路径）
  const issueSan = sanitizeField(rawIssue, 'issue')
  const noteSan = sanitizeField(rawNote, 'note')

  const entry = {
    timestamp: new Date().toISOString(),
    tool: sanitizeToolName(tool),
    issue: issueSan.text,
    note: noteSan.text,
    error_code: sanitizeErrorCode(errorCode),
    session: opaqueSessionRef(getSessionId()),
    ...(issueSan.truncated || noteSan.truncated ? { truncated: true } : {}),
    ...(issueSan.redactions || noteSan.redactions ? { redactions: issueSan.redactions + noteSan.redactions } : {}),
  }

  try {
    const path = getFeedbackPath()
    // R22-⑮：写前检查轮转（防单文件无限增长）
    const rotation = rotateIfNeeded(path)
    appendFileSync(path, JSON.stringify(entry) + '\n')
    return {
      status: 'recorded', message: 'Feedback saved. Thank you!', path,
      ...(entry.truncated ? { truncated: true } : {}),
      ...(entry.redactions ? { redactions: entry.redactions } : {}),
      ...(rotation.rotated ? { rotated: true } : {}),
      ...(rotation.error ? { rotation_warning: rotation.error } : {}),
    }
  } catch (e) {
    return { error: 'write_failed', message: `Cannot write feedback: ${e.message}` }
  }
}