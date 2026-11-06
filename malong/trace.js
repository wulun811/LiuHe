// trace.js — TRACE v0（专家 0.6.1 §4）：本地只追加的「无内容」工具调用轨迹
//
// 设计约束（专家原文逐条落实）：
//  · 开关 MALONG_TRACE=off|errors|all，默认 off —— 默认零行为变化、零 IO
//  · 只收元数据：绝不记录 raw args / 源码补丁 / 提示词 / 工具返回正文 /
//    绝对路径 / token / key / 环境变量值
//  · phase=started + phase=finished|timeout|abandoned 两种短事件——
//    只有结束事件的话，真崩溃时「有开始无结果」根本查不出来
//  · reported_success / effect_observed / verified 三个概念分开，success ≠ verified
//  · 不新增 MCP 工具、不引入依赖、不上报外网
//  · 写日志失败不改变工具结果（只累加有界计数，供 health(stats) 暴露）
//  · 轮转可读回：off 时零副作用；errors|all 时有界追加
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { getStateDir } from './host-config.js'

export const TRACE_MODES = ['off', 'errors', 'all']
const MAX_BYTES = 4 * 1024 * 1024       // 单文件上限（专家建议 2–5MB）
const MAX_ROTATIONS = 3                 // 滚动 2–3 个
const TRACE_FILE = 'malong-trace.jsonl'
const COUNTER_FILE = 'malong-trace-counters.json'
// 轨迹独占一个子目录（用户 2026-10-30 明确要求）：
// 此前直接写在 stateDir 根下，跟 code-index/workspaces/entry-tasks/反馈文件摆在同一层。
// 后果：① 用户的产物目录被轨迹污染；② “清掉轨迹”很容易写成宽匹配 rm 误删别的状态。
// 现在固定 <stateDir>/trace/，想清就删这一个目录。
const TRACE_SUBDIR = 'trace'

// 有界计数器：写失败次数等（health(stats) 读它）
//
// 2026-10-30 自用试用修正：此前 `dropped` 与 `COUNTER_FILE` 声明了却从无写入点，
// 于是 health(stats).trace.dropped 永远是 0——比没有这个字段更坏，
// 它会让人以为「从不丢事件」。现在：
//   · 每一次写入失败 = 一个事件被丢 → dropped 真计数
//   · 计数器落盘（换进程/重启仍可见），读时懒加载并在内存里取「盘上 + 本次」较大值
let _writeFailCount = 0
let _droppedCount = 0
let _lastError = null
let _counterLoaded = false
let _legacyChecked = false

export function getTraceMode() {
  const raw = String(process.env.MALONG_TRACE || 'off').trim().toLowerCase()
  return TRACE_MODES.includes(raw) ? raw : 'off'
}

export function traceEnabled() {
  return getTraceMode() !== 'off'
}

// 会话标识：只取宿主注入的 session 名做短哈希，不落原文。
// env 参数只为测试可注入（生产默认 process.env）。
export function ephemeralSessionId(env = process.env) {
  const raw = env.OPENCODE_SESSION || env.MCP_SESSION_ID || env.SESSION_ID || ''
  if (!raw) return null
  return 'ephemeral-' + createHash('sha256').update(String(raw)).digest('hex').slice(0, 8)
}

// R16m/R16n（2026-11-02）：宿主压根没注入会话变量时（opencode 实测就是这样），
// `session` 恒为 null——多开窗口/多任务并行时轨迹无法按会话聚合，
// triage 的「建议是否采纳」也只能跨会话乱比（自用实测 20/33 全是噪声）。
//
// R16n 修正（本轮审查发现）：R16m 先按“小时桶”派生，是错的。实测本机同时有 6 个
// mcp-server 进程，分属 6 个**不同 workspace**（/home/chen、0bore、NAI2、1FTY-llm、
// mail、ANT-FTY），同一小时内启动就拿到**同一个** sess- 标识。后果很具体：
// triage 把跨 workspace 的调用当成“同一条链”，口径收紧反而制造了新的一类误报。
//
// 现在按**进程身份**（pid + 进程启动时刻）派生：
//   · 同进程同启动时刻 → 同标识（started/finished 必然一致）
//   · 同小时启动的不同进程 → 不同标识（不同 workspace 不会混）
//   · 同 pid 重启 → 不同标识（重启就是新会话段）
// 仍不是“知道真实会话”：一个进程服务多个对话时仍会合并，文档里要这么说。
export function deriveSessionId({ pid, startMs } = {}) {
  // 归一化：非法/缺失一律退回当前进程 + 当前时刻，绝不抛错、绝不返回 null
  const p = Number.isFinite(Number(pid)) ? String(Number(pid)) : String(process.pid)
  const t = Number.isFinite(Number(startMs)) ? String(Math.trunc(Number(startMs))) : String(Math.trunc(Date.now()))
  return 'sess-' + createHash('sha256').update(p + '|' + t).digest('hex').slice(0, 8)
}

// 进程级会话标识：一次解析、全程复用（started/finished 必须同值）。
// 有宿主会话变量就用它；没有就按“本进程身份”派生。
//
// 启动时刻用 `Date.now() - process.uptime()*1000` 反推**真实**进程启动时刻，
// 不用模块加载时刻（`Date.now()`）：后者在模块被重新加载时（缓存带 query、
// 热更新、测试动态 import）会变，同一进程会被拆成多个 session——
// 同一个 MCP 进程的调用被当成两段，聚合就错了一半。反推值只依赖进程本身，
// 取整到秒以消除两次计算的毫秒级抖动。
const PROCESS_START_MS = Math.round((Date.now() - process.uptime() * 1000) / 1000) * 1000
let _sessionIdCache = null
function currentSessionId() {
  if (_sessionIdCache) return _sessionIdCache
  const fromEnv = ephemeralSessionId()
  if (fromEnv) { _sessionIdCache = fromEnv; return _sessionIdCache }
  _sessionIdCache = deriveSessionId({ pid: process.pid, startMs: PROCESS_START_MS })
  return _sessionIdCache
}

// 轨迹目录：唯一位置。所有读写都经它，不得再直接 join(getStateDir(), ...)
export function traceDir() {
  return join(getStateDir(), TRACE_SUBDIR)
}

// 旧位置（stateDir 根）里还剩下的轨迹文件。
// 只读，不搬家：让“升级后历史看不见了”变成一句可核查的提示，而不是静默消失。
export function legacyTraceFiles() {
  try {
    const stateDir = getStateDir()
    const names = [TRACE_FILE, COUNTER_FILE]
    for (let i = 1; i <= MAX_ROTATIONS; i++) names.push(`${TRACE_FILE}.${i}`)
    return names.filter(n => existsSync(join(stateDir, n)))
  } catch { return [] }
}

function tracePath() {
  return join(traceDir(), TRACE_FILE)
}

function counterPath() {
  return join(traceDir(), COUNTER_FILE)
}

// 旧位置（stateDir 根下）的一次性迁移。
// 只在真正要写入时调用（off 模式绝不触发，保持零 IO）：没有旧文件就不做任何事。
// 迁移失败不影响写入语义——最坏情况是旧历史留在原处，新记录照常进新目录。
function migrateLegacyOnce() {
  if (_legacyChecked) return
  _legacyChecked = true
  try {
    const stateDir = getStateDir()
    const dir = traceDir()
    // 旧文件集合：主文件 + .1..N + 计数器
    const legacyNames = [TRACE_FILE, COUNTER_FILE]
    for (let i = 1; i <= MAX_ROTATIONS; i++) legacyNames.push(`${TRACE_FILE}.${i}`)
    const present = legacyNames.filter(n => existsSync(join(stateDir, n)))
    if (present.length === 0) return
    mkdirSync(dir, { recursive: true })
    for (const n of present) {
      const from = join(stateDir, n)
      const to = join(dir, n)
      try {
        // 新位置已有 → 不覆盖（宁可保留两份，也不能丢用户数据）
        if (existsSync(to)) continue
        renameSync(from, to)
      } catch { /* 单个文件迁移失败：留在原处，不阻断其余 */ }
    }
  } catch { /* 迁移是尽力而为，失败不得影响写入 */ }
}

// 计数器懒加载：只在首次统计/首次写入时读一次，失败不影响任何工具结果
function loadCounters() {
  if (_counterLoaded) return
  _counterLoaded = true
  try {
    const raw = JSON.parse(readFileSync(counterPath(), 'utf8'))
    if (typeof raw?.write_failed === 'number' && raw.write_failed > _writeFailCount) _writeFailCount = raw.write_failed
    if (typeof raw?.dropped === 'number' && raw.dropped > _droppedCount) _droppedCount = raw.dropped
    if (typeof raw?.last_error === 'string') _lastError = raw.last_error
  } catch { /* 文件不存在/损坏 → 从 0 开始，不是错误 */ }
}

// 计数器落盘：尽力而为，失败不影响工具结果
function saveCounters() {
  try {
    mkdirSync(traceDir(), { recursive: true })
    writeFileSync(counterPath(), JSON.stringify({
      write_failed: _writeFailCount, dropped: _droppedCount, last_error: _lastError,
    }))
  } catch { /* 写不了计数器不重要，内存里仍有真值 */ }
}

// 保留期（专家 §4：7–14 天）——轮转只管体积，按天数管要靠时间清理
const MAX_AGE_DAYS = 14

function rotateIfNeeded(path) {
  try {
    // ① 先按天数清超龄档（体积不触发但时间会）
    const cutoff = Date.now() - MAX_AGE_DAYS * 86400_000
    for (let i = 1; i <= MAX_ROTATIONS; i++) {
      const f = `${path}.${i}`
      try {
        if (existsSync(f) && statSync(f).mtimeMs < cutoff) rmSync(f, { force: true })
      } catch { /* 单档清理失败不影响其它 */ }
    }
    // ② 再按体积轮转
    if (!existsSync(path) || statSync(path).size < MAX_BYTES) return
    const oldest = `${path}.${MAX_ROTATIONS}`
    if (existsSync(oldest)) rmSync(oldest, { force: true })
    for (let i = MAX_ROTATIONS - 1; i >= 1; i--) {
      const cur = `${path}.${i}`
      if (existsSync(cur)) renameSync(cur, `${path}.${i + 1}`)
    }
    renameSync(path, `${path}.1`)
  } catch { /* 轮转失败不影响写入语义 */ }
}

// 从工具结果里提取「建议的下一步工具名」——只取工具名，绝不取 args/note
// （note 是自由文本，可能带绝对路径）。已知形态见 RESPONSE-CONTRACT.md：
//   top-level next_action / extra.next_action / navigation.next_action
const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/

// R16B-PRIV01（专家 2026-10-31 r16b 复审 P1）：call_id 过去由 mcp-server 用
// `${客户端 JSON-RPC id}_${工具名}_${Date.now()}` 拼出，于是把请求 id 原文写进了轨迹。
// 现在：call_id 只能由内部生成（opaqueCallId），写入边界再归一一次——
// 非不透明形态或带密钥形态 → null，绝不把外部输入当关联键。
// 关联能力不受影响：同一次调用的 started/finished 仍共享同一个 id。
const OPAQUE_CALL_ID_RE = /^c-[A-Za-z0-9_-]{1,62}$/
const SECRETISH_RE = /sk-[A-Za-z0-9_-]{8,}|Bearer\s|api[_-]?key|access[_-]?token|secret|password/i
export function opaqueCallId() {
  return 'c-' + randomUUID().replace(/-/g, '')
}
function normalizeCallId(v) {
  const s = typeof v === 'string' ? v.trim() : ''
  if (!s || !OPAQUE_CALL_ID_RE.test(s) || SECRETISH_RE.test(s)) return null
  return s
}
// 结构化安全错误码：只收标识符形态；自由文本（可能带 key/路径）一律丢弃，不回显原值
const SAFE_ERROR_CODE_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/
function normalizeErrorCode(v) {
  const s = typeof v === 'string' ? v.trim() : ''
  return SAFE_ERROR_CODE_RE.test(s) && !SECRETISH_RE.test(s) ? s : null
}
// 轨迹字段白名单：写入边界是唯一出口，将来给调用方加字段也不会自动落盘
const TRACE_FIELDS = new Set([
  'v', 'ts', 'session', 'call_id', 'parent_call_id', 'tool', 'phase', 'latency_ms',
  'outcome', 'effect', 'state_commit', 'verification', 'next_action', 'next_action_basis',
  'error_code', 'output_chars', 'truncated',
])

export function extractSuggestedTool(result) {
  if (!result || typeof result !== 'object') return null
  const candidates = [result.next_action, result.extra?.next_action, result.navigation?.next_action]
  for (const c of candidates) {
    const tool = c && typeof c === 'object' ? c.tool : null
    if (typeof tool === 'string' && TOOL_NAME_RE.test(tool)) return tool
  }
  return null
}

// 只允许「已知安全快照字段」透传——白名单而非黑名单，防止未来给 args 加字段时泄漏
const SAFE_OUTCOME = new Set([
  'ok', 'success', 'error', 'version_conflict', 'not_applied', 'partial', 'failed',
  'not_run', 'timeout', 'abandoned', 'unknown', 'blocked', 'refused',
])
const SAFE_EFFECT = new Set(['workspace_write', 'read_only', 'not_applied', 'unknown', 'none'])
const SAFE_STATE_COMMIT = new Set(['committed', 'pending', 'not_attempted', 'unknown'])
const SAFE_VERIFICATION = new Set(['verified', 'not_run', 'failed', 'unknown'])

function pick(value, allowed) {
  const v = typeof value === 'string' ? value : ''
  return allowed.has(v) ? v : 'unknown'
}

// 从工具结果里提取「安全摘要」——绝不把结果正文写进轨迹
export function summarizeToolResult(result, opts = {}) {
  if (!result || typeof result !== 'object') {
    return { outcome: 'unknown', effect: 'unknown', state_commit: 'unknown', verification: 'unknown' }
  }
  const err = result.error || (result.success === false ? 'error' : null)
  let outcome = 'ok'
  if (typeof result.status === 'string') outcome = result.status
  else if (err) outcome = 'error'
  if (!SAFE_OUTCOME.has(outcome)) outcome = err ? 'error' : 'ok'
  // 形状坑（2026-10-30 试用实测）：写类工具把 effect/committed/receipt 放在 observation 层，
  // 顶层没有。旧实现只查 result.effect ?? result.receipt?.effect → 所有写路径退化为
  // effect=unknown、state_commit=unknown，「写入但未验证」永远统计不出来（恒 0，假绿）。
  // 这里按「顶层优先、observation 兜底」取值，仍只取白名单值，不臆造。
  const obs = (result.observation && typeof result.observation === 'object') ? result.observation : {}
  // 只读声明：graph 工具在 boundaries.read_only 里明说自己只读（code_query 等）。
  // 这跟「压根没有 effect 字段」不是一回事：没字段仍记 unknown（不臆造）；但工具
  // 明确声明后仍记 unknown，会让 13 个只读工具的 effect 整列失效——2026-11-01 P3
  // 首次开采集实测：code_query 记成 effect=unknown，读那一列等于什么都没读。
  const declaredReadOnly = result.boundaries?.read_only === true
    || obs.boundaries?.read_only === true
    || result.read_only === true
  const effect = pick(
    result.effect ?? obs.effect ?? result.receipt?.effect ?? obs.receipt?.effect
      ?? (declaredReadOnly ? 'read_only' : undefined),
    SAFE_EFFECT,
  )
  // state_commit：写路径常只给 committed:true/false，由它推导 committed/not_attempted
  const rawCommit = result.state_commit ?? obs.state_commit ?? result.receipt?.state_commit ?? obs.receipt?.state_commit
  const rawCommitted = obs.committed ?? result.committed
  const stateCommit = rawCommit !== undefined
    ? pick(rawCommit, SAFE_STATE_COMMIT)
    : (typeof rawCommitted === 'boolean' ? (rawCommitted ? 'committed' : 'not_attempted') : 'unknown')
  // verified 只有显式 readback_verified=true 才算；不得由 success 推导
  let verification = 'unknown'
  const rb = result.readback_verified ?? obs.readback_verified
    ?? result.receipt?.readback_verified ?? obs.receipt?.readback_verified
  if (rb === true) verification = 'verified'
  else if (rb === false) verification = 'failed'
  else if (result.verification === 'not_run' || result.verification === 'verified' || result.verification === 'failed') verification = result.verification
  else verification = 'not_run'
  return {
    outcome,
    effect,
    state_commit: stateCommit,
    verification,
    error_code: typeof result.code === 'string' ? result.code.slice(0, 64)
      : (typeof result.error_code === 'string' ? result.error_code.slice(0, 64) : null),
    ...(opts.includeOutputSize ? { output_chars: opts.outputChars ?? null, truncated: !!opts.truncated } : {}),
  }
}

function shouldRecord(mode, event) {
  if (mode === 'off') return false
  if (mode === 'all') return true
  // errors：只留失败/未验证/未知与所有 started（否则崩溃窗看不出来）
  if (event.phase === 'started') return true
  if (event.phase !== 'finished') return true
  if (event.outcome && event.outcome !== 'ok' && event.outcome !== 'success') return true
  if (event.verification && event.verification !== 'verified') return true
  if (event.error_code) return true
  return false
}

// 核心写入：永远不抛（写日志失败不得改变工具结果）
export function traceEvent(event) {
  const mode = getTraceMode()
  if (mode === 'off') return { written: false, reason: 'off' }
  try {
    const record = { v: 1, ts: new Date().toISOString(), ...event }
    // R16B-PRIV01：白名单 + 归一化只在写入前做一次（所有 trace* 入口共用）
    for (const k of Object.keys(record)) if (!TRACE_FIELDS.has(k)) delete record[k]
    record.call_id = normalizeCallId(record.call_id)
    record.parent_call_id = normalizeCallId(record.parent_call_id)
    record.tool = TOOL_NAME_RE.test(String(record.tool || '')) ? record.tool : 'unknown'
    if (record.error_code != null) record.error_code = normalizeErrorCode(record.error_code)
    if (record.next_action != null && !TOOL_NAME_RE.test(String(record.next_action))) record.next_action = null
    if (event.phase !== 'started' && !shouldRecord(mode, record)) {
      return { written: false, reason: 'filtered' }
    }
    const path = tracePath()
    // 首次写入前把旧位置的轨迹搬进 trace/（没有旧文件就什么也不做）
    migrateLegacyOnce()
    mkdirSync(traceDir(), { recursive: true })
    rotateIfNeeded(path)
    appendFileSync(path, JSON.stringify(record) + '\n')
    return { written: true }
  } catch (e) {
    _writeFailCount++
    // 把这个事件真正计为「丢了」——不是估算，就是这一次 append 失败
    _droppedCount++
    _lastError = e?.code || e?.message || String(e)
    saveCounters()
    return { written: false, reason: 'write_failed', error: _lastError }
  }
}

// 调用开始：必须有 started，才能在崩溃后看出「有开始、无结果」
export function traceStarted({ tool, callId, parentCallId }) {
  return traceEvent({
    session: currentSessionId(),
    call_id: callId || null,
    parent_call_id: parentCallId || null,
    tool: String(tool || 'unknown').slice(0, 80),
    phase: 'started',
  })
}

// 调用结束：phase ∈ finished|timeout|abandoned
export function traceFinished({ tool, callId, parentCallId, phase = 'finished', latencyMs, summary, nextAction, nextActionBasis, outputChars, truncated }) {
  return traceEvent({
    session: currentSessionId(),
    call_id: callId || null,
    parent_call_id: parentCallId || null,
    tool: String(tool || 'unknown').slice(0, 80),
    phase,
    latency_ms: Number.isFinite(latencyMs) ? Math.round(latencyMs) : null,
    outcome: summary?.outcome || 'unknown',
    effect: summary?.effect || 'unknown',
    state_commit: summary?.state_commit || 'unknown',
    verification: summary?.verification || 'unknown',
    // suggested_next_action 与真实下一调用分开记：这里只记「建议」，是否执行由下一条 started 决定
    next_action: typeof nextAction === 'string' ? nextAction.slice(0, 64) : null,
    next_action_basis: typeof nextActionBasis === 'string' ? nextActionBasis.slice(0, 64) : null,
    error_code: summary?.error_code || null,
    ...(outputChars != null ? { output_chars: outputChars } : {}),
    ...(truncated != null ? { truncated: !!truncated } : {}),
  })
}

// health(stats=true) 用：有界计数 + 当前模式
export function traceStats() {
  const mode = getTraceMode()
  // 懒加载盘上累计值：重启不归零
  loadCounters()
  let bytes = 0
  let files = 0
  try {
    const dir = traceDir()
    for (const f of readdirSync(dir)) {
      if (f === TRACE_FILE || f.startsWith(TRACE_FILE + '.')) {
        try { bytes += statSync(join(dir, f)).size; files++ } catch {}
      }
    }
  } catch {}
  return {
    mode,
    enabled: mode !== 'off',
    dir: traceDir(),
    files,
    bytes,
    max_bytes_per_file: MAX_BYTES,
    max_rotations: MAX_ROTATIONS,
    write_failed: _writeFailCount,
    dropped: _droppedCount,
    last_error: _lastError,
    // 旧位置（stateDir 根）的残留：off 时不主动搬家，只报事实，避免“历史消失”
    legacy_files: legacyTraceFiles(),
    // 默认 off 时明确说明「没有采集」，而不是让 0 看起来像「采集了但没数据」
    note: mode === 'off'
      ? 'tracing is off (default). Set MALONG_TRACE=errors|all to collect local metadata-only traces.'
      : 'tracing is on: metadata only (no args/paths/source/prompts). Local file, never uploaded.',
  }
}

// 只读：读回滚动后的历史（**唯一读取入口**）
//
// 2026-10-30 统一读取：此前 readTraceEntries 与 scripts/trace-triage.mjs 的 readAll 是
// 两份实现，已经读出了不同结果——triage 用 startsWith(BASE+'.') 认文件，会把越界的 .4
// 和外来后缀 .1.bak 也当成轨迹；同一份目录两边条数不同。现在读取只此一份，
// 聚合工具必须走它，不得自己再写。
//
// 口径（钉成合同，test-trace-v0 ⑰ 锁住）：
//   · 只认主文件 + `.1` … `.MAX_ROTATIONS` 这几档；越界档与任何其它后缀都不算轨迹
//   · 顺序：最旧轮转档 → 最新主文件（尾部 slice 取到的就是最近的）
//   · 坏行跳过并计数，不影响其余行
//   · sinceMs 时间窗在这里过滤（聚合层不要再写一份）
//   · 目录选择按“目录”，不按单个文件：新旧两处只要有一处存在轨迹就整目录读，
//     否则「新目录只剩轮转档、主文件还没建」时会被旧目录遮住一半历史
export function readTraceEntriesDetailed({ limit = 500, includeRotated = true, sinceMs = null } = {}) {
  // 目录选择：新目录（trace/）有任何轨迹就只读新的；否则才看旧位置
  const hasAny = (dir) => {
    try {
      if (existsSync(join(dir, TRACE_FILE))) return true
      for (let i = 1; i <= MAX_ROTATIONS; i++) {
        if (existsSync(join(dir, `${TRACE_FILE}.${i}`))) return true
      }
      return false
    } catch { return false }
  }
  const newDir = traceDir()
  // 本次真正参与统计的目录：旧目录被选上时，legacy 残留提示不应再自指
  const usedDir = hasAny(newDir) ? newDir : (hasAny(getStateDir()) ? getStateDir() : newDir)
  const base = join(usedDir, TRACE_FILE)
  const files = []
  if (includeRotated) {
    for (let i = MAX_ROTATIONS; i >= 1; i--) files.push(`${base}.${i}`)
  }
  files.push(base)
  const out = []
  let malformed = 0
  const fileInfo = []
  for (const f of files) {
    if (!existsSync(f)) continue
    let text = ''
    try { text = readFileSync(f, 'utf-8') } catch { continue }
    let n = 0
    for (const line of text.split('\n')) {
      if (!line) continue
      let rec
      try { rec = JSON.parse(line) } catch { malformed++; continue }
      // 时间窗：解析不出时间的记录保留（宁可多算，不因格式问题静默丢）
      if (sinceMs != null) {
        const t = Date.parse(rec?.ts || '')
        if (Number.isFinite(t) && t < sinceMs) continue
      }
      out.push(rec); n++
    }
    let size = 0
    try { size = statSync(f).size } catch { /* 拿不到大小不影响内容 */ }
    fileInfo.push({ file: basename(f), entries: n, bytes: size })
  }
  return {
    entries: out.slice(-limit),
    files: fileInfo,
    parsed: out.length,
    malformed_lines: malformed,
    // 旧位置残留（未参与本次统计）：非空就说明有历史还没搬进 trace/，得提示用户
    legacy_files: usedDir === newDir ? legacyTraceFiles() : [],
    // 本次“真的读了哪个目录”：报告层必须照抄它，不能自己推 <stateDir>/trace。
    // （否则只有旧位置有数据时，表头把人指向一个空目录。）
    dir: usedDir,
  }
}

// 兼容入口：只要条目
// 只读：读回滚动后的历史
export function readTraceEntries(opts = {}) {
  return readTraceEntriesDetailed(opts).entries
}
