// test-s3-async.js — S3.2b 长检查 job 端到端（code_check async + code_control job/cancel_job）
// 覆盖：accepted+job_id、后台完成→证据/result_kind=validated、在途去重、job 查询、
//       确认取消 → op indeterminate、缺 job_id、非法 action。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP = join(os.tmpdir(), 'opencode', 's3-async-test')
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
const WS = join(TMP, 'ws'); mkdirSync(WS, { recursive: true })
process.env.MALONG_STATE_DIR = join(TMP, 'state')
process.env.MALONG_ENTRY_STATE = '1'

let pass = 0, fail = 0
const assert = (c, m) => { if (c) pass++; else { fail++; console.error('  FAIL:', m) } }
const wait = (ms) => new Promise(r => setTimeout(r, ms))

const shared = await import(pathToFileURL(join(__dirname, '..', 'tools', 'entry-shared.js')).href)
const store = await import(pathToFileURL(join(__dirname, '..', 'tools', 'entry-store.js')).href)
const check = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-code-check', 'handler.js')).href)
const control = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-code-control', 'handler.js')).href)
const jobsMod = await import(pathToFileURL(join(__dirname, '..', 'workflow', 'jobs.js')).href)
const ctx = { codeIndexService: null, langParserService: null }

function pkg(testScript) { writeFileSync(join(WS, 'package.json'), JSON.stringify({ name: 's3-async-fixture', version: '1.0.0', scripts: { test: testScript } }, null, 2)) }
function mkTask(id, operations = []) {
  const patch = { operation_id: 'op_seed', kind: 'patch', state: 'succeeded', file: 'a.txt', result_file_hash: 'sha256:x', result_kind: 'partial' }
  const t = { task_id: id, revision: 1, route: 'change', lifecycle: 'active', node: 'edit', materials: [], operations, evidence: [], workspace_dir: WS }
  shared.putTask(WS, t, { type: 'task_created', task: t })
  return t
}
async function waitJob(jobId, ms = 25000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const j = jobsMod.getJob(WS, jobId)
    if (j && ['succeeded', 'failed', 'cancelled', 'indeterminate'].includes(j.state)) return j
    await wait(150)
  }
  return jobsMod.getJob(WS, jobId)
}

// ── 1. 后台完成 → 证据 + validated ──
pkg('node -e "console.log(\'1 passing\')"')
mkTask('task_ok', [{ operation_id: 'op_seed', kind: 'patch', state: 'succeeded', file: 'a.txt', result_file_hash: 'sha256:x', result_kind: 'partial' }])
let r = await check.handle({ workspace_dir: WS, task_id: 'task_ok', checks: ['test'], run: true, async: true, request_id: 'rq_async_ok' }, ctx)
assert(r.ok === true && r.observation?.accepted === true && typeof r.observation?.job_id === 'string', 'async → accepted + job_id')
const jobId = r.observation.job_id
// 在途去重：同 request_id 返回 running/accepted（不重复起 job）
const dup = await check.handle({ workspace_dir: WS, task_id: 'task_ok', checks: ['test'], run: true, async: true, request_id: 'rq_async_ok' }, ctx)
assert(dup.ok === true && (dup.observation?.accepted === true || dup.observation?.deduplicated === true), '同 request_id 去重（不重复起 job）')
const done = await waitJob(jobId)
assert(done.state === 'succeeded', `后台 job 成功（得 ${done.state}）`)
const t1 = store.getTask(WS, 'task_ok')
assert(t1.result_kind === 'validated', `result_kind=validated（得 ${t1.result_kind}）`)
assert((t1.evidence || []).some(e => e.kind === 'test' && e.result === 'passed'), '证据记 passed')
assert((t1.operations || []).some(o => o.kind === 'check' && o.state === 'succeeded'), 'check op succeeded')
// 第二轮审查修复：链接后的 job_id 不得被终态提交吞掉
const doneCheckOp = (t1.operations || []).find(o => o.kind === 'check' && o.state === 'succeeded')
assert(doneCheckOp?.job_id === jobId, `check op 保留 job_id（得 ${doneCheckOp?.job_id}）`)

// ── 1b. 后台完成但检查失败 → job failed（dogfood ②a：不再假报 succeeded）──
pkg('node -e "process.exit(1)"')
mkTask('task_fail', [{ operation_id: 'op_seed', kind: 'patch', state: 'succeeded', file: 'a.txt', result_file_hash: 'sha256:x', result_kind: 'partial' }])
r = await check.handle({ workspace_dir: WS, task_id: 'task_fail', checks: ['test'], run: true, async: true, request_id: 'rq_async_fail' }, ctx)
assert(r.ok === true && typeof r.observation?.job_id === 'string', '1b async 失败用例受理')
const fjob = await waitJob(r.observation.job_id)
assert(fjob.state === 'failed', `1b 检查失败 → job state=failed（得 ${fjob.state}）`)
assert(fjob.result?.ok === false && fjob.result?.all_passed === false, `1b job result.ok=false/all_passed=false（得 ${JSON.stringify(fjob.result)}）`)
assert((fjob.result?.failed || []).includes('test:failed'), `1b failed 含 test:failed（得 ${JSON.stringify(fjob.result?.failed)}）`)

// ── 2. job 查询（code_control action=job）──
r = await control.handle({ workspace_dir: WS, task_id: 'task_ok', action: 'job' })
assert(r.ok === true && Array.isArray(r.observation?.jobs) && r.observation.jobs.length >= 1, 'job action 列出任务 job')
r = await control.handle({ workspace_dir: WS, task_id: 'task_ok', action: 'job', job_id: jobId })
assert(r.ok === true && r.observation?.job?.job_id === jobId, 'job action 查询单个')
r = await control.handle({ workspace_dir: WS, task_id: 'task_ok', action: 'status' })
assert(Array.isArray(r.observation?.pending_jobs), 'status 含 pending_jobs')

// ── 3. 确认取消：长检查 job → cancelled + op indeterminate ──
pkg('node -e "setTimeout(()=>{}, 20000)"')
mkTask('task_cancel', [{ operation_id: 'op_seed', kind: 'patch', state: 'succeeded', file: 'a.txt', result_file_hash: 'sha256:x', result_kind: 'partial' }])
r = await check.handle({ workspace_dir: WS, task_id: 'task_cancel', checks: ['test'], run: true, async: true, request_id: 'rq_cancel' }, ctx)
const cj = r.observation.job_id
await wait(600) // 让 npm 进程起来
const cr = await control.handle({ workspace_dir: WS, task_id: 'task_cancel', action: 'cancel_job', job_id: cj, wait_ms: 8000 })
assert(cr.ok === true && cr.observation?.cancelled === true && cr.observation?.confirmed === true, `cancel_job 确认停止（得 ${JSON.stringify(cr.observation)}）`)
const t2 = store.getTask(WS, 'task_cancel')
assert((t2.operations || []).some(o => o.kind === 'check' && o.state === 'indeterminate'), '取消后 check op indeterminate')

// ── 4. 参数/动作错误 ──
r = await control.handle({ workspace_dir: WS, task_id: 'task_ok', action: 'cancel_job' })
assert(r.error === 'missing_parameter', 'cancel_job 缺 job_id')
r = await control.handle({ workspace_dir: WS, task_id: 'task_ok', action: 'job', job_id: 'job_nope' })
assert(r.error === 'job_not_found', '未知 job')
r = await control.handle({ workspace_dir: WS, task_id: 'task_ok', action: 'bogus' })
assert(r.error === 'invalid_input', '非法 action')

// ── 5. live 审查 I3b：无 live job 的 prepared check op 收口为 failed（不再永久 blocked_by）──
mkTask('task_stale', [{ operation_id: 'op_stale', kind: 'check', state: 'prepared', created: '2020-01-01T00:00:00.000Z' }])
r = await check.handle({ workspace_dir: WS, task_id: 'task_stale', checks: ['test'] }, ctx)
assert(r.ok === true && r.observation?.dry_run === true, `5 预览触发 prepared op 收口（得 ${JSON.stringify(r.error || r.observation?.effect)}）`)
const tst = store.getTask(WS, 'task_stale')
assert((tst.operations || []).find(o => o.operation_id === 'op_stale')?.state === 'failed', `5 prepared op 收口为 failed（得 ${JSON.stringify(tst.operations)}）`)
const cst = await control.handle({ workspace_dir: WS, task_id: 'task_stale', action: 'cancel' })
assert(cst.ok === true && cst.observation?.cancelled === true, `5 收口后可 cancel（得 ${JSON.stringify(cst.observation)}）`)

// ── 5b. 第二轮审查 P1：在跑的 sync check op 不被收口器误杀 ──
mkTask('task_live', [{ operation_id: 'op_live', kind: 'check', state: 'prepared', created: '2020-01-01T00:00:00.000Z' }])
check._runningSyncOps.set('op_live', 1)
r = await check.handle({ workspace_dir: WS, task_id: 'task_live' }, ctx)
check._runningSyncOps.delete('op_live')
let tlv = store.getTask(WS, 'task_live')
assert(r.ok === true && r.observation?.dry_run === true, '5b 预览路径触发收口器')
assert(tlv.operations.find(o => o.operation_id === 'op_live')?.state === 'prepared', '5b 在跑的 sync op 不被误收口')
r = await check.handle({ workspace_dir: WS, task_id: 'task_live' }, ctx)
tlv = store.getTask(WS, 'task_live')
assert(tlv.operations.find(o => o.operation_id === 'op_live')?.state === 'failed', '5b 运行结束后正常收口 failed')

// ── 6. live 审查 I4：无 request_id 的 async job 在途 → cancel 必须 blocked（不能假称取消）──
pkg('node -e "setTimeout(()=>{}, 15000)"')
mkTask('task_noid')
r = await check.handle({ workspace_dir: WS, task_id: 'task_noid', checks: ['test'], run: true, async: true }, ctx)
assert(r.ok === true && typeof r.observation?.job_id === 'string', `6 无 request_id async 受理（得 ${JSON.stringify(r.error || r.observation?.job_id)}）`)
const c6 = await control.handle({ workspace_dir: WS, task_id: 'task_noid', action: 'cancel' })
assert(c6.ok === true && c6.observation?.cancelled === false && (c6.observation?.pending_jobs || []).length >= 1, `6 在途 job 阻止 cancel（得 ${JSON.stringify(c6.observation)}）`)
await control.handle({ workspace_dir: WS, task_id: 'task_noid', action: 'cancel_job', job_id: r.observation.job_id, wait_ms: 8000 })

// ── 7. live 审查 I5：任务在 job 完成前被置 cancelled → 不得事后写 validated ──
pkg('node -e "console.log(\'1 passing\')"')
mkTask('task_guard', [{ operation_id: 'op_seed', kind: 'patch', state: 'succeeded', file: 'a.txt', result_file_hash: 'sha256:x', result_kind: 'partial' }])
r = await check.handle({ workspace_dir: WS, task_id: 'task_guard', checks: ['test'], run: true, async: true, request_id: 'rq_guard' }, ctx)
{
  const cur = store.getTask(WS, 'task_guard')
  shared.updateTaskCas(WS, 'task_guard', cur.revision, (t) => { t.lifecycle = 'cancelled'; t.node = 'cancelled'; return { type: 'lifecycle', data: { lifecycle: 'cancelled' } } })
}
const g7 = await waitJob(r.observation.job_id)
const tg = store.getTask(WS, 'task_guard')
assert(g7.state === 'failed' || g7.state === 'cancelled', `7 取消后 job 不报成功（得 ${g7.state}）`)
assert(tg.result_kind !== 'validated' && !(tg.evidence || []).some(e => e.result === 'passed'), `7 取消后不写 validated（得 result_kind=${tg.result_kind}）`)

console.log(`\n=== test-s3-async: ${pass} passed, ${fail} failed ===`)
process.exit(fail > 0 ? 1 : 0)