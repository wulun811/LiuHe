#!/usr/bin/env node
// test-wp02-check-facts.js — WP02 检查事实与目标覆盖
// 覆盖：证据事实完整（command/runner/goal_revision/inputs）、AC08 显式 exit verifier
// （协议解析与退出码判据分开）、AC02（review 路线机械 validated ≠ 目标已覆盖）、
// AC10（检查期间依赖变化 → 历史结果保留 + 当前证据 stale）。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import os from 'node:os'
import { createHash } from 'node:crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP = join(os.tmpdir(), 'opencode', 'wp02-check-facts')
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
process.env.MALONG_STATE_DIR = join(TMP, 'state')
process.env.MALONG_ENTRY_STATE = '1'

let pass = 0
let fail = 0
function assert(cond, msg) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`) } else { fail++; console.log(`  ✗ ${msg}`) }
}
const sha = (s) => `sha256:${createHash('sha256').update(s).digest('hex')}`
const imp = (p) => import(pathToFileURL(p).href)

const shared = await imp(join(__dirname, '..', 'tools', 'entry-shared.js'))
const store = await imp(join(__dirname, '..', 'tools', 'entry-store.js'))
const check = await imp(join(__dirname, '..', 'tools', 'tool-code-check', 'handler.js'))
const { projectEffectiveState } = await imp(join(__dirname, '..', 'workflow', 'effective-state.js'))
const { listJobs } = await imp(join(__dirname, '..', 'workflow', 'jobs.js'))
const ctx = {}

function mkWs(name, testScript) {
  const ws = join(TMP, name)
  mkdirSync(ws, { recursive: true })
  writeFileSync(join(ws, 'package.json'), JSON.stringify({ name, scripts: testScript === null ? {} : { test: testScript } }))
  return ws
}
function mkTask(ws, id, extra = {}) {
  const t = { task_id: id, revision: 1, route: 'change', lifecycle: 'active', node: 'edit', materials: [], operations: [], evidence: [], candidates: [], workspace_dir: ws, ...extra }
  shared.putTask(ws, t, { type: 'task_created', task: t })
  return t
}
const patchOp = (id, file, hash) => ({ operation_id: id, request_id: null, kind: 'patch', state: 'succeeded', file, ...(hash ? { result_file_hash: hash } : {}), result_kind: 'partial' })

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

console.log('== WP02 检查事实：command/runner/goal_revision/inputs 入账 ==')
{
  const ws = mkWs('facts', 'node -e "console.log(\'1 passing\')"')
  mkTask(ws, 'task_facts', { operations: [patchOp('op_f1', 'a.txt')], result_kind: 'partial' })
  const r = await check.handle({ workspace_dir: ws, task_id: 'task_facts', checks: ['test'], run: true, request_id: 'wf_1' }, ctx)
  const ev = r.observation?.evidence?.[0]
  assert(r.ok === true && ev?.result === 'passed', '通过 → evidence passed')
  assert(ev?.goal_revision === 1, `证据记 goal_revision=1（得 ${ev?.goal_revision}）`)
  assert(typeof ev?.actual?.command === 'string' && /run test/.test(ev.actual.command), `actual.command 回传（得 ${ev?.actual?.command}）`)
  assert(typeof ev?.actual?.runner === 'string' && ev.actual.runner.length > 0, `actual.runner 记录（得 ${ev?.actual?.runner}）`)
  const op = store.getTask(ws, 'task_facts').operations.find(o => o.kind === 'check')
  assert(op?.checks?.includes('test') && op.state === 'succeeded', 'check op 记 checks/succeeded')
  assert(op?.workdir === null && op?.timeout === null && op?.verifier === 'protocol', 'op inputs：workdir/timeout/verifier 入账（缺省值显式）')
}

console.log('== AC08：协议解析与显式 exit verifier 分开 ==')
{
  const script = 'node -e "console.log(\'custom assertion framework output, nothing parseable\')"'
  const wsP = mkWs('proto', script)
  mkTask(wsP, 'task_proto', { operations: [patchOp('op_p1', 'a.txt')], result_kind: 'partial' })
  const rp = await check.handle({ workspace_dir: wsP, task_id: 'task_proto', checks: ['test'], run: true, request_id: 'wp_p' }, ctx)
  const evp = rp.observation?.evidence?.[0]
  assert(rp.ok === true, 'protocol 模式执行成功返回')
  assert(evp?.result === 'skipped', `默认 protocol：exit0 + 无可识别协议 → skipped 不伪绿（得 ${evp?.result}）`)
  assert(rp.observation?.result_kind === 'partial', 'skipped 不得把任务推到 validated')

  const wsE = mkWs('exitv', script)
  mkTask(wsE, 'task_exit', { operations: [patchOp('op_e1', 'a.txt')], result_kind: 'partial' })
  const re = await check.handle({ workspace_dir: wsE, task_id: 'task_exit', checks: ['test'], run: true, request_id: 'we_e', verifier: 'exit' }, ctx)
  const eve = re.observation?.evidence?.[0]
  assert(eve?.result === 'passed', `显式 verifier=exit：exit0 → passed（得 ${eve?.result}）`)
  assert(eve?.provenance?.verifier === 'exit', '证据 provenance 记 verifier=exit（判据来源可追溯）')
  assert(re.observation?.result_kind === 'validated', '显式声明下 exit0 通过 + 有 patch → validated')

  const wsX = mkWs('exitf', 'node -e "process.exit(3)"')
  mkTask(wsX, 'task_exitf', { operations: [patchOp('op_x1', 'a.txt')], result_kind: 'partial' })
  const rx = await check.handle({ workspace_dir: wsX, task_id: 'task_exitf', checks: ['test'], run: true, request_id: 'we_x', verifier: 'exit' }, ctx)
  assert(rx.observation?.evidence?.[0]?.result === 'failed' && rx.observation.evidence[0].actual.exit_code === 3, 'verifier=exit：非零退出 → failed + exit_code 入账')

  const bad = await check.handle({ workspace_dir: wsE, task_id: 'task_exit', checks: ['test'], run: true, request_id: 'we_bad', verifier: 'magic' }, ctx)
  assert(bad.error === 'invalid_input', `非法 verifier 值 → invalid_input（得 ${bad.error}）`)
  const conflict = await check.handle({ workspace_dir: wsE, task_id: 'task_exit', checks: ['test'], run: true, request_id: 'we_e', verifier: 'protocol' }, ctx)
  assert(conflict.error === 'request_conflict', '同 request_id 不同 verifier → request_conflict（payload 含判定规则）')
}
console.log('== P2 修复（2026-10-12 狗粮）：verifier 记忆 + notice 不自相矛盾 ==')
{
  const script = 'node -e "console.log(\'custom framework output, nothing parseable\')"'
  const wsM = mkWs('memv', script)
  mkTask(wsM, 'task_mem', { operations: [patchOp('op_mm1', 'a.txt')], result_kind: 'partial' })
  const r1 = await check.handle({ workspace_dir: wsM, task_id: 'task_mem', checks: ['test'], run: true, request_id: 'wm_1', verifier: 'exit' }, ctx)
  const e1 = r1.observation?.evidence?.[0]
  assert(e1?.result === 'passed', `P2 显式 exit 首跑 passed（得 ${e1?.result}）`)
  assert(typeof e1?.actual?.notice === 'string' && !/not counted as a pass/.test(e1.actual.notice), `P2 verifier=exit 时 notice 不再写 not counted as a pass（得 ${e1?.actual?.notice}）`)
  assert(typeof e1?.actual?.notice_protocol === 'string' && /not counted as a pass/.test(e1.actual.notice_protocol), 'P2 原协议 notice 保留到 notice_protocol（可追溯）')

  const r2 = await check.handle({ workspace_dir: wsM, task_id: 'task_mem', checks: ['test'], run: true, request_id: 'wm_2' }, ctx)
  const e2 = r2.observation?.evidence?.[0]
  assert(e2?.result === 'passed' && e2?.provenance?.verifier === 'exit', `P2 未传 verifier → 记忆复用 exit（得 ${e2?.result}）`)
  assert(e2?.actual?.verifier_reused === true && r2.observation?.verifier_reused === true, 'P2 复用显式标注 verifier_reused（证据+observation）')

  const r3 = await check.handle({ workspace_dir: wsM, task_id: 'task_mem', checks: ['test'], run: true, request_id: 'wm_3', verifier: 'protocol' }, ctx)
  const e3 = r3.observation?.evidence?.[0]
  assert(e3?.result === 'skipped' && !e3?.provenance?.verifier, `P2 显式 protocol 覆盖记忆（回 skipped；得 ${e3?.result}）`)
  assert(e3?.actual?.verifier_reused === undefined, 'P2 显式传参不标 reused')
}
console.log('== AC02：review 路线机械 validated ≠ 目标已覆盖 ==')
{
  const ws = mkWs('review', 'node -e "console.log(\'1 passing\')"')
  mkTask(ws, 'task_rev', { route: 'review', operations: [patchOp('op_r1', 'sec.js')], result_kind: 'partial' })
  const r = await check.handle({ workspace_dir: ws, task_id: 'task_rev', checks: ['test'], run: true, request_id: 'wr_1' }, ctx)
  assert(r.observation?.result_kind === 'validated', 'review 路线：数值测试通过 → 机械 result_kind=validated（如实记录）')
  assert(r.next_action?.tool === 'code_audit', `但 next_action 指向 code_audit（测试通过不算安全目标已覆盖；得 ${r.next_action?.tool}）`)
  assert(r.progress === undefined && r.mechanical_requirements_met === undefined, '不输出 done/机械要求满足（目标覆盖不由数值测试声明）')
}

console.log('== AC10：检查期间依赖变化 → 历史结果保留 + 当前证据 stale ==')
{
  const ws = mkWs('midrun', 'node -e "setTimeout(()=>require(\'fs\').writeFileSync(\'dep.txt\',\'CHANGED\'),250)" && node -e "console.log(\'1 passing\')"')
  writeFileSync(join(ws, 'dep.txt'), 'ORIG')
  mkTask(ws, 'task_mid', {
    operations: [patchOp('op_m1', 'dep.txt', sha('ORIG'))],
    result_kind: 'partial',
  })
  const r = await check.handle({ workspace_dir: ws, task_id: 'task_mid', checks: ['test'], run: true, request_id: 'wm_1', async: true }, ctx)
  assert(r.ok === true && r.observation?.accepted === true && r.job_id, `异步检查已接受（job ${r.job_id}）`)
  let job = null
  for (let i = 0; i < 150; i++) {
    await sleep(100)
    job = listJobs(ws, { task_id: 'task_mid', limit: 0 }).find(j => j.job_id === r.job_id)
    if (job && !['running', 'cancelling'].includes(job.state)) break
  }
  assert(job && job.state === 'succeeded', `job 完成（state=${job?.state}）`)
  const t = store.getTask(ws, 'task_mid')
  const ev = (t.evidence || [])[0]
  assert(ev?.result === 'passed', `检查期间改文件 → 进程结果如实 passed（历史不否认；得 ${ev?.result}）`)
  assert(ev?.depends_on?.some(d => d.file === 'dep.txt' && d.hash === sha('ORIG')), 'depends_on 记采集时版本（ORIG）')
  assert(readFileSync(join(ws, 'dep.txt'), 'utf-8') === 'CHANGED', 'mid-run 写入已发生（夹具自证）')
  const p = projectEffectiveState(ws, t)
  assert(p.freshness.result_stale === true && p.freshness.stale_reason === 'file_change' && p.freshness.stale_evidence.includes(ev.evidence_id), '现实已变 → 当前证据 stale/file_change（passed 不绑定未观察版本）')
  assert(t.evidence.length === 1 && t.evidence[0].result === 'passed', '历史证据保留不被改写（AC10：历史命令结果保留）')
}

console.log(`\n=== test-wp02-check-facts: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
