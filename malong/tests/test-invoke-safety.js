// test-invoke-safety.js — 保底出口安全收口（R01/R02/R05/R06，0.5.9~0.5.10 审核修复）
// 覆盖（专家场景复刻 + 审核修复验收）：
//   A. 取消后副作用写入必须拒绝、hash 不变、账本无新增（R01）
//   A2. reopen 后放行且记入任务账本（kind=invoke / succeeded）（R01）
//   B. task 在：同 request_id 异载荷 → request_conflict；同 id 同载荷 → 幂等复读（R02）
//   C. 无 task：共享账本同上语义（R02）
//   D. 在途（prepared）不盲目重放（R01/R02 恢复语义）
//   E. 出口保守子集 schema 校验：类型不符预拒 + required_args 结构化（R06）
//   F. 三态 operation_succeeded：marker-less → null + 操作记 indeterminate 不重放（R06）+ next_actions 可达改写（R05）
//   G. 结果缺参（missing_parameter）→ required_args 显式 + call_with_required_args（R05）
//   H. 分类器三态单测（导出面）
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  FAIL:', msg) } }

const TMP = join(os.tmpdir(), 'opencode', 'invoke-safety-test')
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
mkdirSync(join(TMP, 'src'), { recursive: true })
process.env.MALONG_STATE_DIR = join(TMP, 'state')
writeFileSync(join(TMP, 'src', 'a.js'), 'export function a() { return 1 }')

const imp = (p) => import(pathToFileURL(p).href)
const sha = (rel) => { try { return createHash('sha256').update(readFileSync(join(TMP, rel))).digest('hex').slice(0, 16) } catch { return null } }

function mockIndex() {
  return {
    async initWorkspace() {}, async indexBatch() { return [] },
    markIndexDirty() {},
    async findDefinitions() { return [] }, async searchSymbols() { return [] },
    findSymbolsInFile() { return [] }, async getFileOutline() { return { outline: [] } },
    async getSymbolsAtLine() { return [] }, getSymbolByStableId() { return null },
    getFileByPath(f) { return { path: f, index_state: 'fresh' } },
  }
}
const ctx = { codeIndexService: mockIndex(), getWorkspaceDir: (w) => w }

const shared = await imp(join(__dirname, '..', 'tools', 'entry-shared.js'))
const invMod = await imp(join(__dirname, '..', 'tools', 'tool-invoke-capability', 'handler.js'))
const inv = invMod.handle
const { validateArgsConservative } = await imp(join(__dirname, '..', 'tools', 'outlet-schema.js'))
const taskMod = await imp(join(__dirname, '..', 'tools', 'tool-code-task', 'handler.js'))
const ctlMod = await imp(join(__dirname, '..', 'tools', 'tool-code-control', 'handler.js'))

async function mkTask(goal) {
  const r = await taskMod.handle({ workspace_dir: TMP, goal }, ctx)
  return r?.task?.task_id || null
}
const brief = (v) => JSON.stringify(v ?? null).slice(0, 160)

// ── A. R01：取消后副作用写入被拒 ──
const t1 = await mkTask('invoke safety: cancelled task must reject side effects')
assert(!!t1, 'A: 建立任务 t1（得 ' + brief(t1) + '）')
const c1 = await ctlMod.handle({ workspace_dir: TMP, task_id: t1, action: 'cancel', reason: 'r01-repro' }, ctx)
assert(c1?.observation?.cancelled === true, 'A: 任务取消成功')
const A_FILE = 'cancelled-created.js'
const a1 = await inv({ workspace_dir: TMP, name: 'write_symbol', task_id: t1, args: { create: true, locator: { file_path: A_FILE }, content: 'export const c = 1', dry_run: false } }, ctx)
assert(a1?.error === 'task_cancelled', 'R01: 取消后拒绝副作用写入（得 ' + brief(a1) + '）')
assert(existsSync(join(TMP, A_FILE)) === false && sha(A_FILE) === null, 'R01: 文件未创建（hash 不变）')
assert(((shared.getTask(TMP, t1)?.operations) || []).length === 0, 'R01: 取消任务账本无新增操作')

// ── A2. reopen 后放行并入账 ──
const c2 = await ctlMod.handle({ workspace_dir: TMP, task_id: t1, action: 'reopen' }, ctx)
assert(c2?.ok === true, 'A2: reopen 返回 ok（得 ' + brief(c2) + '）')
const a2 = await inv({ workspace_dir: TMP, name: 'write_symbol', task_id: t1, args: { create: true, locator: { file_path: A_FILE }, content: 'export const c = 1', dry_run: false } }, ctx)
assert(a2?.ok === true && a2?.delegated === true && a2?.operation_succeeded === true, 'A2: reopen 后放行真写 + operation_succeeded=true（得 ' + brief(a2) + '）')
assert(existsSync(join(TMP, A_FILE)) === true, 'A2: 文件已创建')
const ops1 = shared.getTask(TMP, t1)?.operations || []
assert(ops1.length === 1 && ops1[0].kind === 'invoke' && ops1[0].tool === 'write_symbol' && ops1[0].state === 'succeeded', 'R01: 操作入任务账本（kind/tool/state 正确，得 ' + brief(ops1) + '）')

// ── B. R02（task 在）──
const t2 = await mkTask('invoke safety: request identity under task')
const b1 = await inv({ workspace_dir: TMP, name: 'write_symbol', task_id: t2, request_id: 'rid-b1', args: { create: true, locator: { file_path: 'id-one.js' }, content: 'export const b1 = 1', dry_run: false } }, ctx)
assert(b1?.ok === true && b1?.delegated === true, 'B: 首次写入成功（得 ' + brief(b1) + '）')
const b1Hash = sha('id-one.js')
const b2 = await inv({ workspace_dir: TMP, name: 'write_symbol', task_id: t2, request_id: 'rid-b1', args: { create: true, locator: { file_path: 'id-two.js' }, content: 'export const b2 = 1', dry_run: false } }, ctx)
assert(b2?.error === 'request_conflict', 'R02: 同 id 异载荷 → request_conflict（得 ' + brief(b2) + '）')
assert(existsSync(join(TMP, 'id-two.js')) === false, 'R02: 冲突载荷未落盘')
const b3 = await inv({ workspace_dir: TMP, name: 'write_symbol', task_id: t2, request_id: 'rid-b1', args: { create: true, locator: { file_path: 'id-one.js' }, content: 'export const b1 = 1', dry_run: false } }, ctx)
assert(b3?.ok === true && b3?.deduplicated === true && b3?.delegated === false && b3?.operation_succeeded === true, 'R02: 同 id 同载荷 → 幂等复读（得 ' + brief(b3) + '）')
assert(sha('id-one.js') === b1Hash, 'R02: 幂等后 hash 不变')

// ── C. R02（无 task，共享账本）──
const cc1 = await inv({ workspace_dir: TMP, name: 'write_symbol', request_id: 'rid-c1', args: { create: true, locator: { file_path: 'ledger-one.js' }, content: 'export const l1 = 1', dry_run: false } }, ctx)
assert(cc1?.ok === true, 'C: 无 task 首次写入成功（得 ' + brief(cc1) + '）')
const cc1Hash = sha('ledger-one.js')
const cc2 = await inv({ workspace_dir: TMP, name: 'write_symbol', request_id: 'rid-c1', args: { create: true, locator: { file_path: 'ledger-two.js' }, content: 'export const l2 = 1', dry_run: false } }, ctx)
assert(cc2?.error === 'request_conflict', 'R02(无 task): 同 id 异载荷 → request_conflict（得 ' + brief(cc2) + '）')
assert(existsSync(join(TMP, 'ledger-two.js')) === false, 'R02(无 task): 冲突载荷未落盘')
const cc3 = await inv({ workspace_dir: TMP, name: 'write_symbol', request_id: 'rid-c1', args: { create: true, locator: { file_path: 'ledger-one.js' }, content: 'export const l1 = 1', dry_run: false } }, ctx)
assert(cc3?.ok === true && cc3?.deduplicated === true, 'R02(无 task): 同载荷幂等（得 ' + brief(cc3) + '）')
assert(sha('ledger-one.js') === cc1Hash, 'R02(无 task): hash 不变')

// ── D. 在途（prepared）不盲目重放 ──
const t3 = await mkTask('invoke safety: prepared op must not be replayed')
const D_ARGS = { create: true, locator: { file_path: 'inflight-created.js' }, content: 'export const d = 1', dry_run: false }
{
  const t3Now = shared.getTask(TMP, t3)
  const prepared = {
    operation_id: shared.newOperationId(), request_id: 'rid-d1',
    payload_hash: shared.payloadHash({ capability: 'write_symbol', args: D_ARGS }),
    state: 'prepared', kind: 'invoke', tool: 'write_symbol', created: new Date().toISOString(),
  }
  const cas = shared.updateTaskCas(TMP, t3, t3Now.revision, (t) => shared.operationEvent(t, prepared, { node: 'edit' }))
  assert(cas.ok === true, 'D: 注入在途操作（得 ' + brief(cas) + '）')
}
const d1 = await inv({ workspace_dir: TMP, name: 'write_symbol', task_id: t3, request_id: 'rid-d1', args: D_ARGS }, ctx)
assert(d1?.error === 'request_unresolved', 'R01: 在途同请求不盲目重放（得 ' + brief(d1) + '）')
assert(existsSync(join(TMP, 'inflight-created.js')) === false, 'D: 未发生副作用')

// ── E. R06：出口保守子集 schema 校验（类型不符预拒；不委派、不落盘）──
{
  const e1 = await inv({ workspace_dir: TMP, name: 'write_symbol', args: { create: true, locator: { file_path: 'bad-type.js' }, content: 'export const x = 1', dry_run: 'yes' } }, ctx)
  assert(e1?.error === 'invalid_input' && Array.isArray(e1?.invalid_args), 'R06: dry_run 类型不符 → invalid_input + invalid_args（得 ' + brief(e1) + '）')
  assert(e1?.invalid_args?.[0]?.arg === 'dry_run' && e1.invalid_args[0].expected === 'boolean', 'R06: invalid_args 指向 dry_run(expected boolean)')
  assert(Array.isArray(e1?.required_args) && e1.required_args.includes('locator'), 'R06: required_args 显式回传（含 locator）')
  assert(e1?.next_actions?.[0]?.action === 'call_with_valid_args', 'R06: next_actions 结构化（call_with_valid_args）')
  assert(existsSync(join(TMP, 'bad-type.js')) === false, 'R06: 预拒不发副作用')
  assert(validateArgsConservative({ properties: { n: { type: 'number' } } }, { n: 'str' }) !== null, 'E-unit 类型不符被抓')
  assert(validateArgsConservative({ properties: { n: { type: 'number' } } }, { n: 3 }) === null, 'E-unit 合法零误报')
  assert(validateArgsConservative({ properties: { m: { enum: ['a', 'b'] } } }, { m: 'c' }) !== null, 'E-unit enum 不符被抓')
  assert(validateArgsConservative({ properties: { z: { anyOf: [{ type: 'string' }, { type: 'number' }] } } }, { z: 5 }) === null, 'E-unit anyOf/无 type 跳过')
  assert(validateArgsConservative({ properties: { q: { type: 'string', unknownKeyword: 1 } } }, { q: 's', extra_unknown: 9 }) === null, 'E-unit 未知关键字忽略')
  assert(validateArgsConservative({ properties: { q: { type: 'string' } } }, { q: null }) === null, 'E-unit null 视为未提供')
}

// ── F. R06/R05：marker-less 预览 → operation_succeeded=null + op indeterminate 不重放 + next_actions 可达改写 ──
{
  const t5 = await mkTask('invoke safety: tri-state and next_actions')
  const f0 = await inv({ workspace_dir: TMP, name: 'write_symbol', args: { create: true, locator: { file_path: 'rename-src.js' }, content: 'export function rname() { return 1 }' } }, ctx)
  assert(f0?.ok === true, 'F: 预备文件写入成功（得 ' + brief(f0) + '）')
  const f1 = await inv({ workspace_dir: TMP, name: 'rename_symbol', task_id: t5, request_id: 'rid-f1', args: { file: 'rename-src.js', symbol: 'rname', new_name: 'rname2' } }, ctx)
  assert(f1?.ok === true && f1?.operation_succeeded === null, 'R06: marker-less 结果 → operation_succeeded=null（得 ' + brief(f1) + '）')
  assert(Array.isArray(f1?.next_actions) && f1.next_actions.some((a) => /name='rename_symbol'/.test(a.text)), 'R05: next_actions 把 rename_symbol 改写为保底出口形式（得 ' + brief(f1?.next_actions) + '）')
  assert(readFileSync(join(TMP, 'rename-src.js'), 'utf-8').includes('rname()'), 'R03: dry 预览零写入（hash 不变）')
  const ops5 = shared.getTask(TMP, t5)?.operations || []
  assert(ops5.some((o) => o.request_id === 'rid-f1' && o.state === 'indeterminate'), 'R06: 操作记 indeterminate（得 ' + brief(ops5) + '）')
  const f2 = await inv({ workspace_dir: TMP, name: 'rename_symbol', task_id: t5, request_id: 'rid-f1', args: { file: 'rename-src.js', symbol: 'rname', new_name: 'rname2' } }, ctx)
  assert(f2?.error === 'request_unresolved', 'R06: indeterminate 同请求不盲目重放（得 ' + brief(f2) + '）')
}

// ── G. R05：结果缺参 → required_args 显式补齐（ok 语义保留、operation_succeeded=false）──
{
  const g1 = await inv({ workspace_dir: TMP, name: 'read_symbol', args: {} }, ctx)
  assert(g1?.ok === true && g1?.operation_succeeded === false, 'R06: 结果错误 → operation_succeeded=false（得 ' + brief(g1) + '）')
  assert(Array.isArray(g1?.required_args) && g1.required_args.length > 0, 'R05: required_args 显式回传（schema 层，得 ' + brief(g1?.required_args) + '）')
  assert((g1?.next_actions || []).some((a) => a.action === 'call_with_required_args'), 'R05: next_actions 含 call_with_required_args')
}

// ── H. 分类器三态单测 ──
{
  const cls = invMod.classifyDelegatedOutcome
  assert(cls({ success: true }).state === 'succeeded', 'H success:true → succeeded')
  assert(cls({ ok: true }).state === 'succeeded', 'H ok:true → succeeded')
  assert(cls({ status: 'modified' }).state === 'succeeded', 'H status=警告串 → succeeded')
  assert(cls({ error: 'x' }).state === 'failed', 'H error → failed')
  assert(cls({ success: false }).state === 'failed', 'H success:false → failed')
  assert(cls({ status: 'fail' }).state === 'failed', 'H status=fail → failed')
  assert(cls({ todos: [] }).state === 'indeterminate', 'H marker-less → indeterminate')
  assert(cls(null).state === 'indeterminate', 'H null → indeterminate')
  // N02（0.5.11）：执行类工具的退出事实可解码（否则正常完成被归 indeterminate → 无 task 账本不落终态 → 可重放双执行）
  assert(cls({ exit_code: 0, stdout: 'ok' }).state === 'succeeded', 'N02 exit_code:0 → succeeded')
  assert(cls({ exit_code: 1, stdout: '' }).state === 'failed', 'N02 exit_code:1 → failed')
  assert(cls({ exit_code: 0, no_totals_parsed: true }).state === 'indeterminate', 'N02 exit 0 但无用例计数 → indeterminate（不冒充通过）')
}

// ── I. N01（0.5.11）：schema 校验失败必须先于占位——不留 prepared、纠错不被锁死 ──
{
  const t6 = await mkTask('invoke safety N01: arg validation must not leave prepared ops')
  const BAD_ARGS = { create: true, locator: { file_path: 'n01-created.js' }, content: 'export const n01 = 1', dry_run: 'false' }
  const i1 = await inv({ workspace_dir: TMP, name: 'write_symbol', task_id: t6, request_id: 'rid-i1', args: BAD_ARGS }, ctx)
  assert(i1?.error === 'invalid_input', 'N01: 类型不符 → invalid_input（得 ' + brief(i1) + '）')
  assert(existsSync(join(TMP, 'n01-created.js')) === false, 'N01: 首错无文件变化')
  const opsAfter = shared.getTask(TMP, t6)?.operations || []
  assert(opsAfter.length === 0, 'N01: 校验失败不留操作（无在途残留；得 ' + brief(opsAfter) + '）')
  const st = await ctlMod.handle({ workspace_dir: TMP, task_id: t6, action: 'status' }, ctx)
  assert(st?.progress !== 'in_flight' && st?.progress !== 'indeterminate', 'N01: status 不假称在途（得 ' + brief(st?.progress) + '）')
  const i2 = await inv({ workspace_dir: TMP, name: 'write_symbol', task_id: t6, request_id: 'rid-i1', args: BAD_ARGS }, ctx)
  assert(i2?.error === 'invalid_input', 'N01: 原样重试仍明确拒绝 invalid_input（不得 request_unresolved；得 ' + brief(i2) + '）')
  const i3 = await inv({ workspace_dir: TMP, name: 'write_symbol', task_id: t6, request_id: 'rid-i1', args: { ...BAD_ARGS, dry_run: false } }, ctx)
  assert(i3?.ok === true && i3?.delegated === true && i3?.operation_succeeded === true, 'N01: 修正参数后同 request_id 可执行（得 ' + brief(i3) + '）')
  assert(existsSync(join(TMP, 'n01-created.js')) === true, 'N01: 修正后真写落盘')
}

// ── J. N02（0.5.11）：无 task 的副作用命令——同 request_id 同载荷不得执行两次 ──
{
  const counter = join(TMP, 'counter.txt')
  try { rmSync(counter, { force: true }) } catch {}
  writeFileSync(join(TMP, 'append.cjs'),
    'const fs=require("fs");const p=require("path").join(__dirname,"counter.txt");fs.appendFileSync(p,"x\\n");console.log("appended")\n')
  const J_ARGS = { script: 'append.cjs' }
  const j1 = await inv({ workspace_dir: TMP, name: 'debug_runner', request_id: 'rid-j1', args: J_ARGS }, ctx)
  assert(j1?.ok === true && j1?.delegated === true && j1?.operation_succeeded === true, 'N02: 首次命令成功（得 ' + brief(j1) + '）')
  assert(j1?.result?.exit_code === 0, 'N02: 原结果 exit_code 保留（得 ' + brief(j1?.result?.exit_code) + '）')
  const after1 = existsSync(counter) ? readFileSync(counter, 'utf-8') : ''
  assert(after1.split('\n').filter(Boolean).length === 1, 'N02: 首次只追加一次（得 ' + JSON.stringify(after1) + '）')
  const j2 = await inv({ workspace_dir: TMP, name: 'debug_runner', request_id: 'rid-j1', args: J_ARGS }, ctx)
  assert(j2?.ok === true && j2?.deduplicated === true && j2?.delegated === false, 'N02: 同 id 同载荷 → 幂等复读不重放（得 ' + brief(j2) + '）')
  const after2 = existsSync(counter) ? readFileSync(counter, 'utf-8') : ''
  assert(after2.split('\n').filter(Boolean).length === 1, 'N02: 第二次不产生追加标记（得 ' + JSON.stringify(after2) + '）')
  // 失败态也必须落终态（不得可重放）
  const j3 = await inv({ workspace_dir: TMP, name: 'debug_runner', request_id: 'rid-j3', args: { command: 'node -e "process.exit(3)"' } }, ctx)
  assert(j3?.operation_succeeded === false, 'N02: 非零退出 → operation_succeeded=false（得 ' + brief(j3) + '）')
  const j4 = await inv({ workspace_dir: TMP, name: 'debug_runner', request_id: 'rid-j3', args: { command: 'node -e "process.exit(3)"' } }, ctx)
  assert(j4?.error === 'request_unresolved', 'N02: 失败态同 id 重放被拒（得 ' + brief(j4) + '）')
  // 同 id 异载荷仍判冲突
  const j5 = await inv({ workspace_dir: TMP, name: 'debug_runner', request_id: 'rid-j1', args: { script: 'other.cjs' } }, ctx)
  assert(j5?.error === 'request_conflict', 'N02: 同 id 异载荷 → request_conflict（得 ' + brief(j5) + '）')
}

// ── K. N03（0.5.11）：建议动作参数类型保真 + 缺参不伪造 ──
{
  const am = await imp(join(__dirname, '..', 'workflow', 'action-map.js'))
  const a1 = am.buildInvokeAction('rename_symbol', 'file="src/a.js", symbol="rname", new_name="rname2", dry_run="false"')
  assert(a1.args.dry_run === false, 'N03: dry_run 字符串 false → 布尔（得 ' + JSON.stringify(a1.args.dry_run) + '）')
  assert(a1.args.file === 'src/a.js' && a1.missing_args.length === 0, 'N03: 带引号串/路径保真（得 ' + brief(a1) + '）')
  assert(a1.args_complete === true, 'N03: 参数齐全时 args_complete=true')
  const a2 = am.buildInvokeAction('rename_symbol', 'dry_run="false"')
  assert(a2.args.dry_run === false && a2.args_complete === false, 'N03: 缺参不标完整（得 ' + brief(a2) + '）')
  assert(a2.missing_args.includes('symbol') && a2.missing_args.includes('file'), 'N03: 缺参显式 required 差额（得 ' + brief(a2.missing_args) + '）')
  assert(!('workspace_dir' in a2.missing_args), 'N03: 出口注入的 workspace_dir 不算缺参')
  const a3 = am.buildInvokeAction('read_symbol', 'budget_hint=3, include_outline="true", locator={"file_path":"src/a.js"}, label="two words"')
  assert(a3.args.budget_hint === 3, 'N03: number 保真（得 ' + JSON.stringify(a3.args.budget_hint) + '）')
  assert(a3.args.include_outline === true, 'N03: 字符串 true → 布尔（按 schema 类型）（得 ' + JSON.stringify(a3.args.include_outline) + '）')
  assert(a3.args.locator && a3.args.locator.file_path === 'src/a.js', 'N03: 对象保真（得 ' + brief(a3.args.locator) + '）')
  assert(a3.args.label === undefined, 'N03: schema 外参数不进 args')
  assert(a3.unknown_args && a3.unknown_args.length === 1 && a3.unknown_args[0] === 'label', 'N03: schema 外参数进 unknown_args 不静默（得 ' + brief(a3.unknown_args) + '）')
  const a4 = am.buildInvokeAction('rename_symbol', 'file=..., symbol=foo')
  assert(a4.args_complete === false, 'N03: 省略号占位不冒充完整参数（得 ' + brief(a4) + '）')
  const text = 'Apply: rename_symbol(..., dry_run=false).'
  const out = am.sanitizeAdvisory(text)
  assert(/invoke_capability\(name='rename_symbol'/.test(out), 'N03: 文本改写仍走出口形式（得 ' + out + '）')
  assert(!/dry_run="false"/.test(out) && !/dry_run: *"false"/.test(out), 'N03: 改写文本不产出字符串布尔（得 ' + out + '）')
  const acts = am.extractInvokeActions('Check: rename_symbol(file="src/a.js", symbol=x, new_name=y)')
  assert(acts.length === 1 && acts[0].args.file === 'src/a.js' && acts[0].args_complete === true, 'N03: 结构化动作可回放（得 ' + brief(acts) + '）')
  assert(typeof acts[0].form === 'string' && /args=/.test(acts[0].form), 'N03: form 带具体 args')
}

console.log('=== test-invoke-safety: ' + pass + ' passed, ' + fail + ' failed ===')
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
process.exit(fail > 0 ? 1 : 0)
