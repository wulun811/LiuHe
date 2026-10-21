// test-s5-budget.js — S5.4b2 累计输出优化（output-budget + code_status/code_control 窗口）
// 覆盖：capped/windowed 语义、code_status 任务列表封顶、code_control status 操作/证据窗口 + expand 取全。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, rmSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP = join(os.tmpdir(), 'opencode', 's5-budget-test')
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
const WS = join(TMP, 'ws')
mkdirSync(WS, { recursive: true })
process.env.MALONG_STATE_DIR = join(TMP, 'state')
process.env.MALONG_ENTRY_STATE = '1'

let pass = 0, fail = 0
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  FAIL:', msg) } }

const imp = (p) => import(pathToFileURL(p).href)
const budget = await imp(join(__dirname, '..', 'workflow', 'output-budget.js'))
const shared = await imp(join(__dirname, '..', 'tools', 'entry-shared.js'))
const statusMod = await imp(join(__dirname, '..', 'tools', 'tool-code-status', 'handler.js'))
const control = await imp(join(__dirname, '..', 'tools', 'tool-code-control', 'handler.js'))

// ── 1. capped/windowed 语义 ──
const arr = Array.from({ length: 25 }, (_, i) => i)
assert(budget.capped(arr, 20).items.length === 20 && budget.capped(arr, 20).omitted === 5 && budget.capped(arr, 20).truncated === true, 'capped 取前 20')
assert(budget.capped(arr, 20).items[0] === 0, 'capped 保序（首屏）')
assert(budget.windowed(arr, 20).items.length === 20 && budget.windowed(arr, 20).items[19] === 24, 'windowed 取最新 20（含末元素）')
assert(budget.windowed(arr, 20).omitted === 5, 'windowed omitted')
assert(budget.capped(arr, 100).truncated === false, '未超限 → 不截断')
assert(budget.windowed([1, 2], 20).truncated === false, '少于上限 → 不截断')
assert(budget.capped(null, 20).items.length === 0, 'null 列表安全')

// ── 2. code_status 任务列表封顶 ──
for (let i = 0; i < 25; i++) {
  const t = { task_id: `t${i}`, revision: 1, route: 'change', lifecycle: 'active', node: 'read', materials: [], operations: [], evidence: [], workspace_dir: WS, goal: `g${i}`, created: new Date(1700000000000 + i * 1000).toISOString() }
  shared.putTask(WS, t, { type: 'task_created', task: t })
}
let r = await statusMod.handle({ workspace_dir: WS })
assert(r.observation.tasks.length === 20, `code_status 列 20 个任务（得 ${r.observation.tasks.length}）`)
assert(r.observation.tasks_truncated === true, 'code_status tasks_truncated=true')
assert(r.observation.tasks[0].task_id === 't24', 'code_status 显示最新任务（created 倒序）')
// 第二轮审查：active_count 必须排除 cancelled
{
  const c = { task_id: 'tc', revision: 1, route: 'change', lifecycle: 'cancelled', node: 'cancelled', materials: [], operations: [], evidence: [], workspace_dir: WS, goal: 'cancelled', created: new Date(1700000099000).toISOString() }
  shared.putTask(WS, c, { type: 'task_created', task: c })
  const rs = await statusMod.handle({ workspace_dir: WS })
  assert(rs.observation.active_count === 25, `active_count 排除 cancelled（得 ${rs.observation.active_count}）`)
  assert(/26 task\(s\).*25 active/.test(rs.observation.summary), `summary 区分总数/活跃（得 ${rs.observation.summary}）`)
}

// ── 3. code_control status 操作/证据窗口 + expand 取全 ──
const ops = Array.from({ length: 25 }, (_, i) => ({ operation_id: `op${i}`, kind: 'patch', state: 'succeeded', file: `f${i}.js` }))
const evs = Array.from({ length: 25 }, (_, i) => ({ evidence_id: `ev${i}`, kind: 'test', result: 'passed', depends_on: [] }))
const bigTask = { task_id: 'big', revision: 1, route: 'change', lifecycle: 'active', node: 'edit', materials: [], operations: ops, evidence: evs, workspace_dir: WS, goal: 'big' }
shared.putTask(WS, bigTask, { type: 'task_created', task: bigTask })
r = await control.handle({ workspace_dir: WS, task_id: 'big', action: 'status' })
assert(r.observation.operations.length === 20 && r.observation.operations_truncated === true && r.observation.operations_omitted === 5, 'status 操作窗口 20 + 截断标记')
assert(r.observation.evidence.length === 20 && r.observation.evidence_truncated === true, 'status 证据窗口 20')
// expand 仍能取到窗口外的最早 operation
r = await control.handle({ workspace_dir: WS, task_id: 'big', action: 'expand', ref: 'op0' })
assert(r.ok === true && r.observation.kind === 'operation' && r.observation.item.operation_id === 'op0', 'expand 取窗口外 operation')

// 未超限时不应有截断标记
const small = { task_id: 'small', revision: 1, route: 'change', lifecycle: 'active', node: 'edit', materials: [], operations: [ops[0]], evidence: [evs[0]], workspace_dir: WS, goal: 's' }
shared.putTask(WS, small, { type: 'task_created', task: small })
r = await control.handle({ workspace_dir: WS, task_id: 'small', action: 'status' })
assert(r.observation.operations_truncated === false && r.observation.operations.length === 1, '小任务不误标截断')

// ── 4. resume 预算一致（第二轮审查）：materials 50 封顶 + evidence 20 窗口带标记 ──
{
  const mats = Array.from({ length: 60 }, (_, i) => ({ read_ref: `read_${i}`, locator: { file_path: 'a.js' }, canonical_path: 'a.js' }))
  const bops = Array.from({ length: 25 }, (_, i) => ({ operation_id: `bop${i}`, kind: 'patch', state: 'succeeded', file: 'a.js' }))
  const bevs = Array.from({ length: 25 }, (_, i) => ({ evidence_id: `bev${i}`, kind: 'test', result: 'passed', depends_on: [] }))
  const big2 = { task_id: 'big2', revision: 1, route: 'change', lifecycle: 'active', node: 'edit', materials: mats, operations: bops, evidence: bevs, workspace_dir: WS, goal: 'big2' }
  shared.putTask(WS, big2, { type: 'task_created', task: big2 })
  r = await control.handle({ workspace_dir: WS, task_id: 'big2', action: 'resume' })
  assert(r.observation.materials.length === 50 && r.observation.materials_truncated === true && r.observation.materials_omitted === 10, `resume materials 50 封顶 + 标记（得 ${r.observation.materials.length}/${r.observation.materials_omitted}）`)
  assert(r.observation.evidence.length === 20 && r.observation.evidence_truncated === true && r.observation.evidence_omitted === 5, `resume evidence 20 窗口 + 标记（得 ${r.observation.evidence.length}/${r.observation.evidence_omitted}）`)
}

console.log(`\n=== test-s5-budget: ${pass} passed, ${fail} failed ===`)
process.exit(fail > 0 ? 1 : 0)