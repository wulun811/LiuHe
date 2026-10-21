// workflow/jobs.js — S3.2 长操作 job 管理（v2.0 §10.4/§10.5，WP08）。
// 首版用应用层 job_id（不依赖新版 MCP Tasks）：进程内执行、心跳、所有权（pid）、取消。
// 状态：running → cancelling → cancelled | success又分 succeeded/failed；进程重启后孤儿 → indeterminate。
// 取消语义（§7.2/T13）：能确认进程已停 → cancelled；无法确认 → indeterminate（取消 ≠ 回滚）。
// 存储：$MALONG_STATE_DIR/jobs/<wsHash>/<job_id>.json（原子写，不污染用户仓库）。
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { atomicWrite } from '../path-guard.js'
import { getStateDir } from '../host-config.js'

const JOB_ROOT = 'jobs'
const HEARTBEAT_MS = 2000
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'indeterminate'])

// 进程内注册表：job_id → { controller, done }
const registry = new Map()

function wsHash(workspaceDir) {
  // 与 entry-store.wsHash 同式：resolve 对齐，命名空间一致
  return createHash('md5').update(resolve(workspaceDir)).digest('hex').slice(0, 12) // malong-ignore: 仅用于缓存目录名
}
function jobsDir(workspaceDir) { return join(getStateDir(), JOB_ROOT, wsHash(workspaceDir)) }
function jobPath(workspaceDir, jobId) { return join(jobsDir(workspaceDir), `${jobId}.json`) }
function readJob(workspaceDir, jobId) {
  try { return JSON.parse(readFileSync(jobPath(workspaceDir, jobId), 'utf-8')) } catch { return null }
}
function writeJob(workspaceDir, rec) {
  const d = jobsDir(workspaceDir)
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  atomicWrite(jobPath(workspaceDir, rec.job_id), JSON.stringify(rec, null, 2), { fsync: true })
  return rec
}
function alive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}
// 孤儿核对：持久化仍 running/cancelling，但本进程无该 job 且 pid 已死 → indeterminate（不假称完成）
function reconcileRecord(workspaceDir, rec) {
  if (!rec || TERMINAL.has(rec.state)) return rec
  const mark = (reason) => writeJob(workspaceDir, { ...rec, state: 'indeterminate', updated: new Date().toISOString(), reason })
  if (rec.pid && rec.pid !== process.pid && !alive(rec.pid)) return mark('owner process gone; outcome unknown')
  // 第二轮审查：pid 等于本进程但注册表无记录（重启后 pid 复用/异常路径遗留）→ 孤儿，不得永远 running
  if (rec.pid === process.pid && !registry.has(rec.job_id)) return mark('owner registry lost (same pid, no live job); outcome unknown')
  return rec
}

// 启动一个后台 job。run 收到 { signal }，必须在 signal abort 后尽快 settle（否则取消判 indeterminate）。
// 返回 { job_id, state, done }；done 解析为 { job_id, state, result, error }。
// N2（0.5.14 Windows 复核）：job 必须自带请求范围（checks/workdir/timeout/verifier 等），
// 与公开 request_id 解耦——旧实现只存 kind/operation_id，缺 request_id 的 async 检查取消后
// 恢复建议拿不到原范围（实测 034–036：丢 workdir/timeout/verifier，resume 落到仓库根）。
export function startJob({ workspaceDir, task_id = null, operation_id = null, kind = 'job', run, timeoutMs = null, params = null }) {
  const job_id = `job_${randomBytes(4).toString('hex')}`
  const now = new Date().toISOString()
  const controller = new AbortController()
  let timeoutTimer = null
  if (timeoutMs && timeoutMs > 0) timeoutTimer = setTimeout(() => controller.abort(), timeoutMs)

  let rec = writeJob(workspaceDir, {
    job_id, task_id, operation_id, kind, state: 'running',
    pid: process.pid, owner: process.pid, created: now, started: now, heartbeat: now,
    timeout_ms: timeoutMs || null,
    // 请求范围快照：取消/恢复/效果核对都从这里取，不依赖公开 request_id 是否存在
    ...(params && typeof params === 'object' ? { params } : {}),
  })

  const beat = setInterval(() => {
    const cur = readJob(workspaceDir, job_id)
    if (!cur || TERMINAL.has(cur.state)) { clearInterval(beat); return }
    writeJob(workspaceDir, { ...cur, heartbeat: new Date().toISOString() })
  }, HEARTBEAT_MS)
  if (beat.unref) beat.unref()

  const done = (async () => {
    try {
      const result = await run({ signal: controller.signal })
      const state = controller.signal.aborted ? 'cancelled' : (result && result.ok === false ? 'failed' : 'succeeded')
      const fin = writeJob(workspaceDir, { ...readJob(workspaceDir, job_id), state, result: result ?? null, finished: new Date().toISOString(), exit_code: result?.exit_code ?? result?.exitCode ?? null })
      return { job_id, state: fin.state, result: result ?? null, error: null }
    } catch (e) {
      const aborted = controller.signal.aborted
      const state = aborted ? 'cancelled' : 'failed'
      writeJob(workspaceDir, { ...readJob(workspaceDir, job_id), state, error: { code: e?.code || e?.name || 'JOB_FAILED', message: e?.message || String(e) }, finished: new Date().toISOString() })
      return { job_id, state, result: null, error: { message: e?.message || String(e) } }
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer)
      clearInterval(beat)
    }
  })()

  registry.set(job_id, { controller, done })
  done.finally(() => setTimeout(() => registry.delete(job_id), 60_000).unref?.())
  return { job_id, state: 'running', done }
}

// 查询单个 job（含孤儿核对）；不存在的返回 null。
export function getJob(workspaceDir, job_id) {
  if (!job_id) return null
  const rec = readJob(workspaceDir, job_id)
  if (!rec) return null
  if (registry.has(job_id)) return rec // 本进程在跑，状态以磁盘为准
  return reconcileRecord(workspaceDir, rec)
}

// 列出本工作区 job（新→旧）；可选 task_id 过滤；顺带核对孤儿。
export function listJobs(workspaceDir, { task_id = null, limit = 50 } = {}) {
  const d = jobsDir(workspaceDir)
  if (!existsSync(d)) return []
  const out = []
  for (const f of readdirSync(d)) {
    if (!f.endsWith('.json')) continue
    let rec = null
    try { rec = JSON.parse(readFileSync(join(d, f), 'utf-8')) } catch { continue }
    if (task_id && rec.task_id !== task_id) continue
    if (!registry.has(rec.job_id)) rec = reconcileRecord(workspaceDir, rec)
    out.push(rec)
  }
  out.sort((a, b) => String(b.created).localeCompare(String(a.created)))
  // 第二轮审查：limit=0 表示不限量（liveJobs/cancel 预检用）——旧固定 50 截断会漏掉旧的 running job
  return limit > 0 ? out.slice(0, limit) : out
}

// 取消：running → cancelling → abort → 等待 done。确认停止 → cancelled；无法确认 → indeterminate。
// 已是终态 → 幂等返回；本进程无该 job（孤儿）→ indeterminate（不谎称取消）。
export async function cancelJob(workspaceDir, job_id, { waitMs = 5000 } = {}) {
  let rec = readJob(workspaceDir, job_id)
  if (!rec) return { ok: false, error: 'job_not_found' }
  if (TERMINAL.has(rec.state)) {
    return { ok: true, job_id, state: rec.state, cancelled: rec.state === 'cancelled', idempotent: true }
  }
  const entry = registry.get(job_id)
  if (!entry) {
    rec = reconcileRecord(workspaceDir, rec)
    if (rec.state === 'indeterminate') return { ok: true, job_id, state: 'indeterminate', cancelled: false, ambiguous: true }
    return { ok: true, job_id, state: rec.state, cancelled: false, ambiguous: true }
  }
  writeJob(workspaceDir, { ...rec, state: 'cancelling', updated: new Date().toISOString() })
  entry.controller.abort()
  const raced = await Promise.race([
    entry.done.then(() => 'done'),
    new Promise((res) => setTimeout(() => res('timeout'), waitMs)),
  ])
  const after = readJob(workspaceDir, job_id) || rec
  if (raced === 'done' && after.state === 'cancelled') {
    return { ok: true, job_id, state: 'cancelled', cancelled: true, confirmed: true }
  }
  // 无法确认已停（run 未响应 abort / 超时）→ indeterminate，不谎称取消完成（T13）
  const fin = writeJob(workspaceDir, { ...after, state: 'indeterminate', updated: new Date().toISOString(), reason: 'cancel could not be confirmed within wait window' })
  return { ok: true, job_id, state: fin.state, cancelled: false, ambiguous: true }
}

// 进程重启后对账（mcp-server 启动调一次）：本进程无 registry 的 running/cancelling → 孤儿 indeterminate。
export function reconcileJobs(workspaceDir) {
  const d = jobsDir(workspaceDir)
  if (!existsSync(d)) return []
  const changed = []
  for (const f of readdirSync(d)) {
    if (!f.endsWith('.json')) continue
    const id = f.slice(0, -5)
    if (registry.has(id)) continue
    let rec = null
    try { rec = JSON.parse(readFileSync(join(d, f), 'utf-8')) } catch { continue }
    const next = reconcileRecord(workspaceDir, rec)
    if (next && next.state !== rec.state) changed.push({ job_id: id, state: next.state })
  }
  return changed
}

// 仅供测试：清空内存注册表（模拟进程重启）
export function _clearRegistry() { registry.clear() }

// 终态 job 记录超龄清扫（health(action=cleanup) 调用）；running/cancelling 永不清
export function pruneJobs(stateDir, { maxAgeDays = 7, dryRun = false } = {}) {
  const root = join(stateDir, JOB_ROOT)
  if (!stateDir || !existsSync(root)) return { pruned: 0, dry_run: dryRun }
  const cutoff = Date.now() - maxAgeDays * 86400000
  let pruned = 0
  for (const d of readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    const dir = join(root, d.name)
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue
      try {
        const rec = JSON.parse(readFileSync(join(dir, f), 'utf-8'))
        if (!TERMINAL.has(rec.state)) continue
        const ts = Date.parse(rec.finished || rec.updated || rec.created || 0)
        if (!Number.isFinite(ts) || ts >= cutoff) continue
        if (!dryRun) rmSync(join(dir, f), { force: true })
        pruned++
      } catch {}
    }
    try { if (!dryRun && readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true }) } catch {}
  }
  return { pruned, dry_run: dryRun }
}