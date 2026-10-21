// workflow/check-attempts.js — 检查「尝试」身份（0.5.14 M2/M3，专家 Windows 复核）
// 背景：检查范围有两份记录——task.operations 里的 check operation（带公开 request_id 时写入）
// 与后台 job 的 params 快照（N2 起总是写入）。旧实现「有 operation 就优先」，导致：
//   M2：同一任务先跑 check-A（带 id）后开 check-B（无 id async），取消 B 时回执报 A 的 workdir/timeout；
//   M3：更早的成功证据把「B 已停止、效果未核」投影成 done（next_action=null + mechanical_requirements_met）。
// 本模块把两层记录按 job_id 配对成**一次尝试**，再按尝试时间排序——顺序不依赖公开 request_id，
// 也不改写历史记录。纯读：不落盘、不改任务、不增长 revision。
import { listJobs } from './jobs.js'

const STOPPED = ['cancelled', 'indeterminate']
const DETERMINATE = ['succeeded', 'failed']
const CHECK_KINDS = new Set(['test', 'typecheck', 'lint'])

function ms(v) {
  const t = Date.parse(v || 0)
  return Number.isFinite(t) ? t : 0
}

// 一次尝试的「最近活动时间」——heartbeat 反映后台 job 实际仍在跑（长检查启动早但活得久）。
function attemptTime(rec) {
  if (!rec) return 0
  return Math.max(
    ms(rec.finished), ms(rec.updated), ms(rec.started), ms(rec.created), ms(rec.heartbeat),
  )
}

function checksOf(op, job) {
  const fromOp = Array.isArray(op?.checks) && op.checks.length ? [...op.checks] : null
  const p = (job && typeof job.params === 'object' && job.params) || null
  const fromJob = Array.isArray(p?.checks) && p.checks.length ? [...p.checks] : null
  return { fromOp, fromJob, checks: fromOp || fromJob }
}

// 全部检查尝试（新→旧）。operation 与 job 按 job_id 配对；没有 operation 的 job 单独成为一次尝试
// （这正是「无公开 request_id 的 async 检查」）。
export function checkAttempts(task, { workspaceDir = null } = {}) {
  const ops = (Array.isArray(task?.operations) ? task.operations : [])
    .filter(o => o?.kind === 'check')
  let jobs = []
  if (workspaceDir && task?.task_id) {
    try { jobs = listJobs(workspaceDir, { task_id: task.task_id, limit: 0 }).filter(j => j?.kind === 'check') } catch { jobs = [] }
  }
  const byJobId = new Map()
  for (const j of jobs) if (j?.job_id) byJobId.set(j.job_id, j)
  const paired = new Set()
  const out = []
  ops.forEach((op, i) => {
    const job = op?.job_id ? byJobId.get(op.job_id) || null : null
    if (job) paired.add(job.job_id)
    const { checks } = checksOf(op, job)
    out.push({
      attempt_id: job?.job_id || op.operation_id || ('op#' + i),
      operation_id: op.operation_id || null,
      job_id: job?.job_id || null,
      state: job ? (job.state || null) : (op.state || null),
      time: Math.max(attemptTime(job), attemptTime(op)),
      has_scope: !!checks,
      op, job,
    })
  })
  jobs.forEach((job, i) => {
    if (job?.job_id && paired.has(job.job_id)) return
    const { checks } = checksOf(null, job)
    out.push({
      attempt_id: job?.job_id || ('job#' + i),
      operation_id: job.operation_id || null,
      job_id: job?.job_id || null,
      state: job?.state || null,
      time: attemptTime(job),
      has_scope: !!checks,
      op: null, job,
    })
  })
  // 新→旧；时间相同用身份兜底排序（确定性，不依赖对象插入序）
  out.sort((a, b) => (b.time - a.time) || String(b.attempt_id).localeCompare(String(a.attempt_id)))
  return out
}

// 一次尝试的范围：同一次尝试里 operation 记录为权威（它先于 job 写入），job.params 补齐缺失字段。
// source 反映范围来自哪一层：'operation'（有 operation 记录）或 'job'（只有 job 快照）。
export function scopeOfAttempt(a) {
  if (!a) return null
  const o = a.op || null
  const p = (a.job && typeof a.job.params === 'object' && a.job.params) || null
  const { fromOp, checks } = checksOf(o, a.job)
  if (!checks) return null
  const pick = (k) => (o && o[k] != null ? o[k] : (p && p[k] != null ? p[k] : null))
  return {
    checks,
    workdir: pick('workdir'),
    timeout: pick('timeout'),
    verifier: pick('verifier'),
    source: fromOp ? 'operation' : 'job',
    operation_id: a.operation_id || null,
    ...(a.job_id ? { job_id: a.job_id } : {}),
    ...(a.job ? { job_state: a.job.state || null } : {}),
    attempt_state: a.state || null,
    attempt_time: a.time || null,
  }
}

// 最新一次检查尝试的范围（恢复/重验建议的唯一来源）——按时间，而不是「哪层先有记录」。
export function latestCheckScope(task, { workspaceDir = null } = {}) {
  return scopeOfAttempt(checkAttempts(task, { workspaceDir })[0])
}

// 取消/效果核对：以**被取消的那个 job** 为权威，只按 operation_id 关联补全；
// 禁止借同任务其他检查（更早的 operation）填范围。
export function checkScopeForJob(task, job) {
  if (!job) return null
  const linked = job.operation_id
    ? (Array.isArray(task?.operations) ? task.operations : []).find(o => o?.operation_id === job.operation_id && o?.kind === 'check') || null
    : null
  return scopeOfAttempt({
    operation_id: job.operation_id || null,
    job_id: job.job_id || null,
    state: job.state || null,
    time: attemptTime(job),
    op: linked,
    job,
  })
}

// M3：存在「已停止、效果未核」的检查尝试，且之后没有确定的检查结果覆盖它。
// 只认带范围（checks）的尝试——没有范围的后台 job 无法重验，也不该冒充一次可核对的检查尝试。
// 一旦同 scope 重验成功/失败（更新的确定尝试），本函数返回 null，完成态按既有规则恢复。
// ── 覆盖（可比较范围，S1/S2：2026-10-19 专家 Windows 复核三）────────────────
// 一条「确定结果」能收口一条「停止尝试」必须范围可比较：
//   · 同工作区、同任务（由调用方以同一 task/workspaceDir 限定）；
//   · 规范化 workdir 相等——异目录（C 与 B 不同）**默认不覆盖**；根范围也不自动覆盖子目录
//     （跨目录覆盖需要显式可验证契约，不能只凭时间更新）；
//   · 确定尝试的 checks 覆盖停止尝试的 checks（子集关系）。
// 「更新」由尝试序列保证：新→旧排序后，只有排在停止尝试之前的确定结果才算后继。
export function normalizeScopeWorkdir(w) {
  if (w == null) return null
  let s = String(w).trim()
  if (!s) return null
  s = s.replace(/[\\/]+/g, '/')
  if (s.startsWith('./')) s = s.slice(2)
  while (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1)
  if (s === '.' || s === '' || s === '/') return null
  return s
}

export function normalizeScopeChecks(c) {
  const arr = Array.isArray(c) ? c : []
  return [...new Set(arr.map(x => String(x).trim().toLowerCase()).filter(Boolean))].sort()
}

function attemptScopeKey(a) {
  const s = scopeOfAttempt(a)
  if (!s) return null
  return { workdir: normalizeScopeWorkdir(s.workdir), checks: normalizeScopeChecks(s.checks) }
}

// 确定尝试 d 是否覆盖（可收口）停止尝试 s 的范围。
export function coversStoppedAttempt(d, s) {
  if (!d || !s) return false
  if (!DETERMINATE.includes(String(d.state))) return false
  const dk = attemptScopeKey(d), sk = attemptScopeKey(s)
  if (!dk || !sk) return false
  if (dk.workdir !== sk.workdir) return false
  return sk.checks.every(c => dk.checks.includes(c))
}

// 每条停止尝试的收口情况（新→旧）：{ attempt, resolved_by }，resolved_by=后继确定尝试或 null。
// 关键（S1）：每条停止尝试**各自**找有效后继验证——一次异范围的确定结果不会抹掉其他停止记录。
export function stoppedAttemptResolutions(task, { workspaceDir = null } = {}) {
  const attempts = checkAttempts(task, { workspaceDir })
  const out = []
  attempts.forEach((a, idx) => {
    if (!STOPPED.includes(String(a.state)) || !a.has_scope) return
    const resolved_by = attempts.slice(0, idx).find(d => coversStoppedAttempt(d, a)) || null
    out.push({ attempt: a, resolved_by })
  })
  return out
}

// M3/S1：全部「已停止、效果未核」的检查尝试（新→旧）——每条都未被**更新、同范围**的确定结果覆盖。
export function unresolvedStoppedAttempts(task, { workspaceDir = null } = {}) {
  return stoppedAttemptResolutions(task, { workspaceDir })
    .filter(r => !r.resolved_by)
    .map(r => r.attempt)
}

// M3（兼容旧名）：最新一条未收口的停止尝试；没有则 null（完成态按既有规则恢复）。
export function unresolvedStoppedAttempt(task, { workspaceDir = null } = {}) {
  return unresolvedStoppedAttempts(task, { workspaceDir })[0] || null
}

// S2：已被**更新、同范围**确定尝试收口的 indeterminate 检查 operation id 集合——
// inflightFacts / indeterminateReview / effective-state 共用同一份覆盖事实，
// 让「带 request_id（有 operation 记录）」与「无 request_id（只有 job）」两条路径得到同一结论。
// 只收口 check 类；写操作（patch/batch/…）的 indeterminate 永不被检查覆盖。
export function resolvedStoppedCheckOperationIds(task, { workspaceDir = null } = {}) {
  const ids = new Set()
  for (const r of stoppedAttemptResolutions(task, { workspaceDir })) {
    if (!r.resolved_by) continue
    if (r.attempt.operation_id) ids.add(r.attempt.operation_id)
  }
  return ids
}

export function isCheckKind(kind) { return CHECK_KINDS.has(String(kind)) }
