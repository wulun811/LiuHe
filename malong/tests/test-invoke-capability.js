// test-invoke-capability.js — G1-b 保底调用出口（invoke_capability）
// 覆盖：三类代表（只读/带副作用/服务）委派链 / 原结果保留 / 顶层边界 / 注入拒绝 / 未知名 / 未知 task / state 门控 / 空 context 不裸崩
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
let pass = 0, fail = 0
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  FAIL:', msg) } }

const inv = (await import(pathToFileURL(join(ROOT, 'tools', 'tool-invoke-capability', 'handler.js')).href)).handle
const cat = await import(pathToFileURL(join(ROOT, 'workflow', 'public-catalog.js')).href)
const shared = await import(pathToFileURL(join(ROOT, 'tools', 'entry-shared.js')).href)

const WS = mkdtempSync(join(tmpdir(), 'malong-invoke-'))
const STATE = mkdtempSync(join(tmpdir(), 'malong-invstate-'))
writeFileSync(join(WS, 'a.js'), 'export function a() { return 1 }\n// TODO: later\n')
const ctx = { getWorkspaceDir: () => STATE }

// ── 1. 参数/名形/未知 ──
assert((await inv({}, ctx)).error === 'missing_parameter', '缺 workspace_dir')
assert((await inv({ workspace_dir: '/no/such/dir/zz', name: 'active_todos' }, ctx)).error === 'invalid_input', 'workspace 不存在')
assert((await inv({ workspace_dir: WS }, ctx)).error === 'missing_parameter', '缺 name')
for (const bad of ['../x', 'tools/tool-x/handler.js', 'file:///x.js', 'Read_Symbol', 'a']) {
  assert((await inv({ workspace_dir: WS, name: bad }, ctx)).error === 'invalid_input', '名形/注入拒绝: ' + bad)
}
assert((await inv({ workspace_dir: WS, name: 'no_such_zz' }, ctx)).error === 'unknown_capability', '未知名拒绝')
assert((await inv({ workspace_dir: WS, name: 'active_todos', args: [] }, ctx)).error === 'invalid_input', 'args 非对象拒绝')
assert((await inv({ workspace_dir: WS, name: 'active_todos', task_id: 'T-nope' }, ctx)).error === 'unknown_task', '未知 task 拒绝（工作区交叉核验）')

// ── 2. 只读类：active_todos + patch_parser ──
const r1 = await inv({ workspace_dir: WS, name: 'active_todos', args: {} }, ctx)
assert(r1.ok === true && r1.delegated === true && r1.delegated_once === true, 'active_todos: 委派成功')
assert(r1.result && r1.result.total_todos === 1, 'active_todos: 原结果保留（1 个 TODO）')
assert(JSON.stringify(r1.effects) === JSON.stringify(['read']), 'active_todos: effects 透出')
const r2 = await inv({ workspace_dir: WS, name: 'patch_parser', args: { text: '--- a/x.js\n+++ b/x.js\n@@ -1 +1 @@\n-old\n+new\n' } }, ctx)
assert(r2.ok === true, 'patch_parser: 委派成功')

// ── 3. 带副作用类：write_symbol 真写（tmp 工作区）──
const target = join(WS, 'out', 'x.js')
const r3 = await inv({ workspace_dir: WS, name: 'write_symbol', args: { create: true, locator: { file_path: 'out/x.js' }, content: 'export const x = 1\n', dry_run: false } }, ctx)
assert(r3.ok === true, 'write_symbol: 委派成功（得 ' + JSON.stringify(r3).slice(0, 160) + '）')
assert(existsSync(target) === true, 'write_symbol: 真写落盘')
assert(existsSync(target) && readFileSync(target, 'utf-8').includes('x = 1'), 'write_symbol: 内容正确')

// ── 4. 服务维护类：health matrix（服务缺失时保留原样错误，不谎报成功）──
const r4 = await inv({ workspace_dir: WS, name: 'health', args: { action: 'matrix', tool: 'read_symbol' } }, ctx)
assert(r4.ok === true && typeof r4.result === 'object', 'health: 委派透明')
assert(r4.result.action === 'matrix' || !!r4.result.error, 'health: 原结果或 typed 服务错误透出')

// ── 5. 顶层边界：嵌套 args 不得覆盖 workspace_dir ──
const r5 = await inv({ workspace_dir: WS, name: 'active_todos', args: { workspace_dir: '/etc', scope: '.' } }, ctx)
assert(r5.ok === true && r5.result.total_todos === 1, '嵌套 workspace_dir 被顶层覆盖（仍扫 WS）')

// ── 5b. 0.5.25：嵌套工作区冲突不再静默——成功路径回 warnings 明说「嵌套的被忽略、生效的是哪个」──
assert(Array.isArray(r5.warnings) && r5.warnings.some((w) => w.code === 'workspace_dir_ignored'), '5b: 回 warnings（不静默吞掉嵌套工作区）')
assert(r5.warnings?.[0]?.effective_workspace_dir === WS, '5b: warning 指明生效工作区')

// ── 5c. 0.5.25：task 实际在嵌套工作区里 → 精确的 task_workspace_mismatch（不是 unknown_task）──
{
  const WS2 = mkdtempSync(join(tmpdir(), 'malong-invoke-ws2-'))
  const taskId = 'task_wsmismatch_001'
  shared.putTask(WS2, {
    task_id: taskId, revision: 1, route: 'change', node: 'orient', lifecycle: 'active',
    goal: 'g', materials: [], evidence: [], operations: [], created: new Date().toISOString(),
  })
  const r = await inv({ workspace_dir: WS, name: 'active_todos', task_id: taskId, args: { workspace_dir: WS2 } }, ctx)
  assert(r.error === 'task_workspace_mismatch', '5c: 跨工作区 task → task_workspace_mismatch（得 ' + r.error + '）')
  assert(typeof r.suggestion === 'string' && r.suggestion.includes(WS2), '5c: 建议把 workspace_dir 提到顶层')
  assert(typeof r.message === 'string' && r.message.includes(WS2) && r.message.includes(WS), '5c: 报错同时点出两个工作区')
  const same = await inv({ workspace_dir: WS2, name: 'active_todos', task_id: taskId, args: { workspace_dir: WS2 } }, ctx)
  assert(same.error !== 'task_workspace_mismatch' && same.error !== 'unknown_task', '5c: 嵌套与顶层一致 → 正常放行（不误报）')
  const unknown = await inv({ workspace_dir: WS, name: 'active_todos', task_id: 'task_not_exist_zz' }, ctx)
  assert(unknown.error === 'unknown_task' && unknown.message.includes(WS), '5c: 真·未知 task 仍 unknown_task 且报文带工作区')
  try { rmSync(WS2, { recursive: true, force: true }) } catch {}
}

// ── 6. state 门控（graph 面 requires_state）──
assert(cat.gateReason({ name: 'invoke_capability', interface: 'graph', requires_state: true }, { MALONG_INTERFACE: 'graph', MALONG_ENTRY_STATE: '0' }) === cat.GATE.STATE, 'graph 无 state（显式 state=0）→ STATE')
assert(cat.gateReason({ name: 'invoke_capability', interface: 'graph', requires_state: true }, { MALONG_INTERFACE: 'graph', MALONG_ENTRY_STATE: '1' }) === null, 'graph+state → 可见')

// ── 7. 空 context 委派：要么原样失败、要么成功，不得裸崩 ──
const r7 = await inv({ workspace_dir: WS, name: 'read_outline', args: { file: 'a.js' } }, {})
assert(r7.error === 'delegate_failed' || r7.ok === true, '空 context 委派被围栏（不裸崩）')

// ── 8. R2（0.5.14）：验证类结果独立合同——invoke 出口透出 verification_result（调用成功 != 检查通过）──
{
  const vpDir = join(WS, 'vp-notrun')
  mkdirSync(vpDir, { recursive: true })
  writeFileSync(join(vpDir, 'package.json'), JSON.stringify({ name: 'vp-notrun' }))
  const r = await inv({ workspace_dir: vpDir, name: 'verify_pipeline', args: { stages: 'typecheck' } }, ctx)
  assert(r.ok === true, '8: 委派成功（得 ' + JSON.stringify({ e: r.error, o: r.ok }) + '）')
  assert(r.result?.status === 'not_run' && r.result?.verification?.status === 'not_run', '8: 原结果 status=not_run（得 ' + r.result?.status + '）')
  assert(r.verification_result?.status === 'not_run' && r.verification_result?.complete === false && r.verification_result?.executed === 0, '8: 出口 verification_result 独立透出（得 ' + JSON.stringify(r.verification_result) + '）')
  assert(typeof r.execution?.note === 'string' && /verification_result/.test(r.execution.note), '8: execution.note 指向 verification_result（不把调用成功当验证通过）')
}

console.log('\n=== test-invoke-capability: ' + pass + ' passed, ' + fail + ' failed ===')
try { rmSync(WS, { recursive: true, force: true }); rmSync(STATE, { recursive: true, force: true }) } catch {}
process.exit(fail > 0 ? 1 : 0)
