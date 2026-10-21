// test-s3-jobs.js — S3.2a job 管理核心（workflow/jobs.js）+ spawn 取消
// 覆盖：成功/失败、心跳与终态、确认取消、无法确认取消（indeterminate）、终态幂等、
//       孤儿对账、listJobs 过滤、真实子进程取消（AbortSignal → 杀进程组）。
import { join } from 'node:path'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import os from 'node:os'

const TMP = join(os.tmpdir(), 'opencode', 's3-jobs-test')
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
const WS = join(TMP, 'ws'); mkdirSync(WS, { recursive: true })
process.env.MALONG_STATE_DIR = join(TMP, 'state')

let pass = 0, fail = 0
const assert = (c, m) => { if (c) pass++; else { fail++; console.error('  FAIL:', m) } }
const jobs = await import('../workflow/jobs.js')
const { spawnWithGroup } = await import('../spawn-guard.js')
const wait = (ms) => new Promise(r => setTimeout(r, ms))
const wsHash = createHash('md5').update(resolve(WS)).digest('hex').slice(0, 12)

// ── 1. 成功 job ──
let j = jobs.startJob({ workspaceDir: WS, task_id: 't1', kind: 'test', run: async () => ({ ok: true, exit_code: 0 }) })
assert(j.state === 'running' && j.job_id.startsWith('job_'), 'startJob 返回 running')
let d = await j.done
assert(d.state === 'succeeded', `成功 job → succeeded（得 ${d.state}）`)
assert(jobs.getJob(WS, j.job_id).state === 'succeeded', 'getJob 反映终态')

// ── 2. 失败 job（throw）──
j = jobs.startJob({ workspaceDir: WS, task_id: 't1', kind: 'test', run: async () => { throw new Error('boom') } })
d = await j.done
assert(d.state === 'failed' && jobs.getJob(WS, j.job_id).error?.message === 'boom', 'throw → failed + error')

// ── 3. run 返回 ok:false → failed ──
j = jobs.startJob({ workspaceDir: WS, task_id: 't1', kind: 'test', run: async () => ({ ok: false }) })
d = await j.done
assert(d.state === 'failed', 'ok:false → failed')

// ── 4. 确认取消：run 响应 abort ──
j = jobs.startJob({ workspaceDir: WS, task_id: 't1', kind: 'check', run: ({ signal }) => new Promise((res) => { signal.addEventListener('abort', () => res({ ok: false })) }) })
await wait(20)
let c = await jobs.cancelJob(WS, j.job_id, { waitMs: 3000 })
assert(c.cancelled === true && c.confirmed === true, `确认取消 → cancelled（得 ${JSON.stringify(c)}）`)
assert(jobs.getJob(WS, j.job_id).state === 'cancelled', '取消后磁盘态 cancelled')

// ── 5. 无法确认取消：run 不响应 abort → waitMs 后 indeterminate ──
j = jobs.startJob({ workspaceDir: WS, task_id: 't1', kind: 'check', run: () => new Promise(() => {}) })
await wait(20)
c = await jobs.cancelJob(WS, j.job_id, { waitMs: 200 })
assert(c.cancelled === false && c.ambiguous === true && jobs.getJob(WS, j.job_id).state === 'indeterminate', `无法确认 → indeterminate（得 ${JSON.stringify(c)}）`)

// ── 6. 终态幂等取消 ──
j = jobs.startJob({ workspaceDir: WS, task_id: 't1', kind: 'test', run: async () => ({ ok: true }) })
await j.done
c = await jobs.cancelJob(WS, j.job_id)
assert(c.idempotent === true && c.state === 'succeeded', '终态取消幂等')

// ── 7. 取消不存在的 job ──
c = await jobs.cancelJob(WS, 'job_nope')
assert(c.ok === false && c.error === 'job_not_found', '未知 job → job_not_found')

// ── 8. 孤儿对账：模拟重启（清空注册表）+ 死 pid → indeterminate ──
const dir = join(process.env.MALONG_STATE_DIR, 'jobs', wsHash)
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, 'job_orphan.json'), JSON.stringify({ job_id: 'job_orphan', task_id: 't1', state: 'running', pid: 999999, created: new Date().toISOString(), started: new Date().toISOString(), heartbeat: new Date().toISOString() }))
jobs._clearRegistry()
assert(jobs.getJob(WS, 'job_orphan').state === 'indeterminate', '孤儿 running → indeterminate')
writeFileSync(join(dir, 'job_orphan2.json'), JSON.stringify({ job_id: 'job_orphan2', task_id: 't1', state: 'running', pid: 999999, created: new Date().toISOString(), started: new Date().toISOString(), heartbeat: new Date().toISOString() }))
const changed = jobs.reconcileJobs(WS)
assert(changed.some(x => x.job_id === 'job_orphan2'), 'reconcileJobs 扫出孤儿')
// ── 8b. 第二轮审查：pid 等于本进程但注册表无记录（重启 pid 复用）→ 不得永远 running ──
jobs._clearRegistry()
writeFileSync(join(dir, 'job_reuse.json'), JSON.stringify({ job_id: 'job_reuse', task_id: 't1', state: 'running', pid: process.pid, created: new Date().toISOString(), started: new Date().toISOString(), heartbeat: new Date().toISOString() }))
assert(jobs.getJob(WS, 'job_reuse').state === 'indeterminate', '本进程 pid 孤儿 → indeterminate')

// ── 9. listJobs 过滤 task ──
const t2 = jobs.startJob({ workspaceDir: WS, task_id: 't2', kind: 'test', run: async () => ({ ok: true }) })
await t2.done
assert(jobs.listJobs(WS, { task_id: 't2' }).every(x => x.task_id === 't2') && jobs.listJobs(WS, { task_id: 't2' }).length === 1, 'listJobs 按 task 过滤')

// ── 10. 真实子进程取消：AbortSignal → spawnWithGroup 杀进程组 ──
j = jobs.startJob({ workspaceDir: WS, task_id: 't1', kind: 'cmd', run: ({ signal }) => spawnWithGroup('node', ['-e', 'setInterval(()=>{},1000)'], { signal, timeout: 30000 }).then(r => ({ ok: r.code === 0, aborted: r.aborted })) })
await wait(300) // 让进程起来
c = await jobs.cancelJob(WS, j.job_id, { waitMs: 8000 })
assert(c.cancelled === true, `真实子进程取消 → cancelled（得 ${JSON.stringify(c)}）`)

// ── 11. 第二轮审查：limit=0 不限量——旧固定 50 截断会漏掉旧 running job ──
for (let i = 0; i < 55; i++) {
  writeFileSync(join(dir, `job_bulk_${i}.json`), JSON.stringify({ job_id: `job_bulk_${i}`, task_id: 't1', state: 'succeeded', created: new Date(1700000000000 + i * 1000).toISOString(), finished: new Date(1700000000000 + i * 1000).toISOString() }))
}
writeFileSync(join(dir, 'job_old_running.json'), JSON.stringify({ job_id: 'job_old_running', task_id: 't1', state: 'running', pid: 999999, created: new Date(1600000000000).toISOString(), started: new Date(1600000000000).toISOString(), heartbeat: new Date(1600000000000).toISOString() }))
assert(jobs.listJobs(WS, { limit: 50 }).length === 50, 'limit 50 截断（前置）')
assert(jobs.listJobs(WS, { limit: 0 }).some(x => x.job_id === 'job_old_running'), 'limit=0 全量含旧 running job')

// ── 12. 第二轮审查：pruneJobs 只清终态过龄 ──
const oldIso = new Date(Date.now() - 10 * 86400000).toISOString()
writeFileSync(join(dir, 'job_term_old.json'), JSON.stringify({ job_id: 'job_term_old', task_id: 't1', state: 'succeeded', created: oldIso, finished: oldIso }))
writeFileSync(join(dir, 'job_run_old.json'), JSON.stringify({ job_id: 'job_run_old', task_id: 't1', state: 'running', pid: 999999, created: oldIso, started: oldIso, heartbeat: oldIso }))
const pr = jobs.pruneJobs(process.env.MALONG_STATE_DIR, { maxAgeDays: 7 })
assert(pr.pruned >= 1 && !existsSync(join(dir, 'job_term_old.json')), 'pruneJobs 清终态过龄')
assert(existsSync(join(dir, 'job_run_old.json')), 'pruneJobs 不动 running（即使过龄）')

console.log(`\n=== test-s3-jobs: ${pass} passed, ${fail} failed ===`)
process.exit(fail > 0 ? 1 : 0)