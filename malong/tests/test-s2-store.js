// test-s2-store.js — S2 任务状态持久化（ADR-001）失败路径
// 覆盖：持久化读写、request_id 去重、CAS 冲突/成功、W1 快照缺失重建、W3 jsonl 半行丢弃、
//       prune 终态超龄删 / 活跃保留、跨"重启"（新进程读同目录）可见。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, rmSync, existsSync, utimesSync, appendFileSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP = join(os.tmpdir(), 'opencode', 's2-store-test')
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
mkdirSync(join(TMP, 'ws'), { recursive: true })
process.env.MALONG_STATE_DIR = join(TMP, 'state')

let pass = 0, fail = 0
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  FAIL:', msg) } }

const store = await import(pathToFileURL(join(__dirname, '..', 'tools', 'entry-store.js')).href)
const WS = join(TMP, 'ws')
const snapPath = (id) => join(process.env.MALONG_STATE_DIR, 'entry-tasks', store.wsHash(WS), `${id}.json`)
const evPath = (id) => join(process.env.MALONG_STATE_DIR, 'entry-tasks', store.wsHash(WS), `${id}.events.jsonl`)

// ── 建任务 + 持久化读取 ──
const task = { task_id: 'task_a', revision: 1, route: 'understand', lifecycle: 'active', node: 'orient', materials: [], workspace_dir: WS, request_id: 'req_1' }
store.putTask(WS, task, { type: 'task_created', task })
assert(existsSync(snapPath('task_a')), 'putTask 落快照')
assert(existsSync(evPath('task_a')), 'putTask 落事件')
let got = store.getTask(WS, 'task_a')
assert(got && got.task_id === 'task_a' && got.revision === 1, 'getTask 读回')
assert(store.listTasks(WS).length === 1, 'listTasks 1 条')
assert(store.findByRequestId(WS, 'req_1') === 'task_a', 'request_id 索引命中')
assert(store.findByRequestId(WS, 'req_missing') === null, '未知 request_id 返回 null')
// wsHash resolve：等价路径（WS/.）映射同一命名空间
const viaDot = store.getTask(join(WS, '.'), 'task_a')
assert(viaDot && viaDot.task_id === 'task_a', 'wsHash resolve：等价路径映射同一任务')

// ── CAS ──
let r = store.updateTaskCas(WS, 'task_a', 99, (t) => { t.node = 'read'; return { type: 'node_changed', data: { node: 'read' } } })
assert(r.ok === false && r.code === 'REVISION_CONFLICT' && r.current === 1, 'CAS 版本冲突不写')
r = store.updateTaskCas(WS, 'task_a', 1, (t) => { t.materials.push({ read_ref: 'read_1' }); t.node = 'read'; return { type: 'material_added', data: { read_ref: 'read_1', material: { read_ref: 'read_1' }, node: 'read' } } })
assert(r.ok === true && r.task.revision === 2 && r.task.materials.length === 1, 'CAS 成功 revision+1')
r = store.updateTaskCas(WS, 'task_ghost', 1, () => ({}))
assert(r.ok === false && r.code === 'TASK_NOT_FOUND', 'CAS 未知任务')

// ── W1：快照缺失 → 事件重建 ──
rmSync(snapPath('task_a'), { force: true })
assert(!existsSync(snapPath('task_a')), 'W1 前置：快照已删')
got = store.getTask(WS, 'task_a')
assert(got && got.revision === 2 && got.materials.length === 1 && got.node === 'read', 'W1 由事件重建快照')
assert(existsSync(snapPath('task_a')), 'W1 重建后回填快照')

// ── W3：jsonl 尾部半行丢弃 ──
const before = store.readEvents(WS, 'task_a').length
appendFileSync(evPath('task_a'), '{"type":"node_changed","node":"half') // 无换行、不可解析
const after = store.readEvents(WS, 'task_a')
assert(after.length === before, `W3 尾部半行被丢弃（${before} -> ${after.length}）`)
// 后续正常事件仍可追加读取
store.updateTaskCas(WS, 'task_a', 2, (t) => { t.node = 'read'; return { type: 'node_changed', data: { node: 'read' } } })
assert(store.readEvents(WS, 'task_a').length >= before + 1, 'W3 半行后事件仍可读（截断于半行）')

// ── W1b：快照落后于事件（快照写失败但事件已落盘）→ getTask 必须先由事件重建 ──
const cur3 = store.getTask(WS, 'task_a')
assert(cur3.revision === 3, `W1b 前置：当前 revision=3（得 ${cur3.revision}）`)
writeFileSync(snapPath('task_a'), JSON.stringify({ ...cur3, revision: 2, node: 'orient', last_marker: 'stale' }, null, 2))
const healed = store.getTask(WS, 'task_a')
assert(healed && healed.revision === 3 && healed.last_marker === undefined, `W1b 快照落后事件 → 事件重建（得 rev=${healed?.revision}, marker=${healed?.last_marker}）`)

// ── 第二轮审查：listTasks 也必须做 W1b 自愈（旧直接返回旧快照）──
writeFileSync(snapPath('task_a'), JSON.stringify({ ...cur3, revision: 2, last_marker: 'stale' }, null, 2))
const listed = store.listTasks(WS).find(t => t.task_id === 'task_a')
assert(listed && listed.revision === 3 && listed.last_marker === undefined, `listTasks W1b 自愈（得 rev=${listed?.revision}, marker=${listed?.last_marker}）`)

// ── 跨"重启"：新模块实例读同目录 ──
const store2 = await import(pathToFileURL(join(__dirname, '..', 'tools', 'entry-store.js')).href + `?v=${Date.now()}`)
const got2 = store2.getTask(WS, 'task_a')
assert(got2 && got2.task_id === 'task_a' && got2.materials.length === 1, '跨重启（新实例）仍可读任务')

// ── prune：终态超龄删 / 活跃保留 ──
const done = { task_id: 'task_done', revision: 1, route: 'change', lifecycle: 'done', node: 'done', materials: [], workspace_dir: WS, request_id: 'req_done' }
store.putTask(WS, done, { type: 'task_created', task: done })
assert(store.findByRequestId(WS, 'req_done') === 'task_done', '去重索引已登记终态任务')
const old = Date.now() / 1000 - 3600 * 48
utimesSync(snapPath('task_done'), old, old)
const pr = store.pruneTasks(WS, { maxAgeHours: 24 })
assert(pr.pruned === 1, `prune 删终态超龄 1（得 ${pr.pruned}）`)
assert(!existsSync(snapPath('task_done')), 'prune 后终态快照移除')
assert(store.findByRequestId(WS, 'req_done') === null, 'prune 清理幽灵去重索引（回归修复）')
assert(existsSync(snapPath('task_a')), 'prune 保留活跃任务 task_a')
const dr = store.pruneTasks(WS, { maxAgeHours: 0.0001, dryRun: true })
assert(dr.dry_run === true && existsSync(snapPath('task_a')), 'prune dryRun 无副作用')

// ── prune：真实终态 cancelled/completed 也删（回归修复：此前只认 done/abandoned）──
for (const lc of ['cancelled', 'completed']) {
  const tt = { task_id: 'task_' + lc, revision: 1, route: 'change', lifecycle: lc, node: lc, materials: [], operations: [], workspace_dir: WS, request_id: 'req_' + lc }
  store.putTask(WS, tt, { type: 'task_created', task: tt })
  const o = Date.now() / 1000 - 3600 * 48
  utimesSync(snapPath('task_' + lc), o, o)
}
const pr2 = store.pruneTasks(WS, { maxAgeHours: 24 })
assert(pr2.pruned === 2, `prune 删真实终态 cancelled/completed 2（得 ${pr2.pruned}）`)
assert(!existsSync(snapPath('task_cancelled')) && !existsSync(snapPath('task_completed')), 'cancelled/completed 快照移除')

// ── E2 stateless：MALONG_ENTRY_EPHEMERAL=1 → 不落 state dir（重启即丢）──
process.env.MALONG_ENTRY_EPHEMERAL = '1'
store.putTask(WS, { task_id: 'task_eph', revision: 1, workspace_dir: WS, operations: [], evidence: [] }, { type: 'task_created', task: { task_id: 'task_eph', revision: 1, workspace_dir: WS, operations: [], evidence: [] } })
assert(store.getTask(WS, 'task_eph')?.task_id === 'task_eph', 'ephemeral 同进程可读')
assert(!existsSync(join(process.env.MALONG_STATE_DIR, 'entry-tasks', store.wsHash(WS), 'task_eph.json')), 'ephemeral 不落 state dir')
delete process.env.MALONG_ENTRY_EPHEMERAL

console.log(`\n=== test-s2-store: ${pass} passed, ${fail} failed ===`)
process.exit(fail > 0 ? 1 : 0)