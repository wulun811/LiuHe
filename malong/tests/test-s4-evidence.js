// test-s4-evidence.js — S4.1 证据依赖 DAG（局部失效）
// 覆盖：成功写文件推导依赖、版本快照、isEvidenceStale/staleEvidenceIds、无依赖不失效、
//        status/resume 报 stale_evidence、code_check 采集时记 depends_on。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP = join(os.tmpdir(), 'opencode', 's4-evidence-test')
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
const WS = join(TMP, 'ws'); mkdirSync(WS, { recursive: true })
process.env.MALONG_STATE_DIR = join(TMP, 'state')
process.env.MALONG_ENTRY_STATE = '1'

let pass = 0, fail = 0
const assert = (c, m) => { if (c) pass++; else { fail++; console.error('  FAIL:', m) } }
const imp = (p) => import(pathToFileURL(p).href)

const shared = await imp(join(__dirname, '..', 'tools', 'entry-shared.js'))
const store = await imp(join(__dirname, '..', 'tools', 'entry-store.js'))
const evidence = await imp(join(__dirname, '..', 'workflow', 'evidence.js'))
const control = await imp(join(__dirname, '..', 'tools', 'tool-code-control', 'handler.js'))
const check = await imp(join(__dirname, '..', 'tools', 'tool-code-check', 'handler.js'))

const A = 'a.js'
const h = (s) => `sha256:${shared.sha256Hex(s)}`
const CONTENT = 'const a = 1\n'
writeFileSync(join(WS, A), CONTENT)

// ── 单元：成功写文件推导 + 版本快照 ──
const task = {
  task_id: 't1', revision: 1, route: 'change', lifecycle: 'active', node: 'check', workspace_dir: WS, materials: [],
  operations: [
    { operation_id: 'op1', kind: 'patch', state: 'succeeded', file: A, result_file_hash: h(CONTENT) },
    { operation_id: 'op2', kind: 'batch', state: 'succeeded', files: ['b.js', A], result_hashes: {} },
    { operation_id: 'op3', kind: 'patch', state: 'failed', file: 'c.js' },
    { operation_id: 'op4', kind: 'maintain', state: 'succeeded', files: ['d.js'] },
  ],
  evidence: [
    { evidence_id: 'ev1', kind: 'test', result: 'passed', operation_id: 'op1', depends_on: [{ file: A, hash: h(CONTENT) }], limitations: [] },
    { evidence_id: 'ev2', kind: 'lint', result: 'passed', operation_id: 'op1', depends_on: [], limitations: [] },
  ],
  result_kind: 'validated',
}
store.putTask(WS, task, { type: 'task_created', task })

const wf = evidence.writeFilesOf(task)
assert(wf.length === 3 && wf.includes(A) && wf.includes('b.js') && wf.includes('d.js'), `成功写文件去重（含 maintain；得 ${JSON.stringify(wf)}）`)
assert(!wf.includes('c.js'), 'failed 操作不计入依赖')
assert(evidence.currentDependencies(WS, task).some(d => d.file === A && d.hash === h(CONTENT)), 'currentDependencies 记版本快照')
// ── dogfood-050 P3：depends_on 上限 50 + truncated 标记（防状态膨胀）──
{
  const big = { task_id: 't_big', revision: 1, route: 'change', lifecycle: 'active', node: 'edit', workspace_dir: WS, materials: [], evidence: [], operations: [] }
  mkdirSync(join(WS, 'many'), { recursive: true })
  for (let i = 0; i < 55; i++) {
    const f = `many/f${i}.js`
    writeFileSync(join(WS, f), `export const v${i} = ${i}\n`)
    big.operations.push({ operation_id: `op_${i}`, kind: 'patch', state: 'succeeded', file: f })
  }
  const deps = evidence.currentDependencies(WS, big)
  assert(deps.length === evidence.MAX_EVIDENCE_DEPS && deps.truncated === true, `依赖上限 ${evidence.MAX_EVIDENCE_DEPS} + truncated（得 ${deps.length}/${deps.truncated}）`)
  assert(evidence.isEvidenceStale(WS, { depends_on: deps }) === false, '截断依赖版本一致 → 不 stale')
}

assert(evidence.isEvidenceStale(WS, task.evidence[0]) === false, '版本未变 → 不 stale')
assert(evidence.isEvidenceStale(WS, task.evidence[1]) === false, '无依赖 → 永不 stale')

// ── 版本变化 → 局部失效 ──
writeFileSync(join(WS, A), 'const a = 2\n')
assert(evidence.isEvidenceStale(WS, task.evidence[0]) === true, '文件变化 → 依赖证据 stale')
assert(evidence.staleEvidenceIds(WS, task).length === 1 && evidence.staleEvidenceIds(WS, task)[0] === 'ev1', '只失效依赖该文件的证据')
assert(evidence.isEvidenceStale(WS, task.evidence[1]) === false, '无依赖证据不因文件变化失效')

// ── 集成：status/resume 报 stale_evidence ──
let r = await control.handle({ workspace_dir: WS, task_id: 't1', action: 'status' })
assert(r.observation.result_stale === true, '依赖证据失效 → result_stale true')
assert(Array.isArray(r.observation.stale_evidence) && r.observation.stale_evidence.includes('ev1'), 'status 报 stale_evidence')
r = await control.handle({ workspace_dir: WS, task_id: 't1', action: 'resume' })
assert(r.observation.stale_evidence.includes('ev1'), 'resume 报 stale_evidence')

// ── 集成：code_check 采集证据记 depends_on ──
const WS2 = join(TMP, 'ws2'); mkdirSync(WS2, { recursive: true })
writeFileSync(join(WS2, A), CONTENT)
writeFileSync(join(WS2, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node -e "console.log(\'1 passing\')"' } }))
const t2 = {
  task_id: 't2', revision: 1, route: 'change', lifecycle: 'active', node: 'edit', workspace_dir: WS2, materials: [], evidence: [],
  operations: [{ operation_id: 'op_x', kind: 'patch', state: 'succeeded', file: A, result_file_hash: h(CONTENT) }], result_kind: 'partial',
}
store.putTask(WS2, t2, { type: 'task_created', task: t2 })
r = await check.handle({ workspace_dir: WS2, task_id: 't2', checks: ['test'], run: true, request_id: 'ck1' }, {})
const ev = r.observation?.evidence?.[0]
assert(r.observation?.result_kind === 'validated', `通过+batch/patch → validated（得 ${r.observation?.result_kind}）`)
assert(ev?.depends_on?.some(d => d.file === A && d.hash === h(CONTENT)), `code_check 证据记 depends_on（得 ${JSON.stringify(ev?.depends_on)}）`)

// ── R1：同类证据取最新——被取代的旧失败证据不再计入 stale ──
{
  const task3 = {
    task_id: 't3', revision: 1, workspace_dir: WS, operations: [],
    evidence: [
      { evidence_id: 'ev_f', kind: 'test', result: 'failed', depends_on: [{ file: A, hash: h('stale-old-content') }] },
      { evidence_id: 'ev_p', kind: 'test', result: 'passed', depends_on: [{ file: A, hash: h('const a = 2\n') }] },
    ],
  }
  const ids = evidence.staleEvidenceIds(WS, task3)
  assert(ids.length === 0 && !ids.includes('ev_f'), `R1 被取代的旧失败证据不计 stale（得 ${JSON.stringify(ids)}）`)
  writeFileSync(join(WS, A), 'const a = 3\n')
  const ids2 = evidence.staleEvidenceIds(WS, task3)
  assert(ids2.length === 1 && ids2[0] === 'ev_p', `R1 最新证据依赖漂移仍如实报 stale（得 ${JSON.stringify(ids2)}）`)
}

console.log(`\n=== test-s4-evidence: ${pass} passed, ${fail} failed ===`)
process.exit(fail > 0 ? 1 : 0)