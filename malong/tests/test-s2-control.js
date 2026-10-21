// test-s2-control.js — S2 控制面（code_control）失败/边界路径
// 覆盖：status/resume 自包含简报、expand 四类 ref、result_stale 检测、cancel（正常/幂等/在途阻断）、
//       switch_route（goal_revision/证据保留）、W4 事件重建、鉴权/参数/revision 错误。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP = join(os.tmpdir(), 'opencode', 's2-control-test')
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
const WS = join(TMP, 'ws')
mkdirSync(WS, { recursive: true })
process.env.MALONG_STATE_DIR = join(TMP, 'state')
process.env.MALONG_ENTRY_STATE = '1'

let pass = 0, fail = 0
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  FAIL:', msg) } }

const shared = await import(pathToFileURL(join(__dirname, '..', 'tools', 'entry-shared.js')).href)
const store = await import(pathToFileURL(join(__dirname, '..', 'tools', 'entry-store.js')).href)
const control = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-code-control', 'handler.js')).href)
const statusMod = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-code-status', 'handler.js')).href)
const snapPath = (id) => join(process.env.MALONG_STATE_DIR, 'entry-tasks', store.wsHash(WS), `${id}.json`)

const F = 'a.txt'
const CONTENT = 'alpha\n'
writeFileSync(join(WS, F), CONTENT)
const h = (s) => `sha256:${shared.sha256Hex(s)}`
const material = { read_ref: 'read_1', locator: { file_path: F }, canonical_path: F, file_version: { hash: h(CONTENT) }, symbol_version: null }
const patchOp = { operation_id: 'op1', kind: 'patch', request_id: null, state: 'succeeded', file: F, result_file_hash: h(CONTENT), result_kind: 'partial' }
const evidence = { evidence_id: 'e1', kind: 'test', result: 'passed', operation_id: 'op1', scope: null, actual: { ran: true, exit_code: 0, duration_ms: 5 }, limitations: [] }
function mkTask(id, extra = {}) {
  const t = { task_id: id, revision: 1, route: 'change', goal: 'change alpha', node: 'check', lifecycle: 'active', materials: [material], operations: [patchOp], evidence: [evidence], candidates: [{ file_path: F, name: 'alpha' }], workspace_dir: WS, ...extra }
  shared.putTask(WS, t, { type: 'task_created', task: t })
  return t
}

// ── status / resume（validated 且未陈旧）──
mkTask('t1', { result_kind: 'validated' })
let r = await control.handle({ workspace_dir: WS, task_id: 't1', action: 'status' })
assert(r.ok === true && r.observation.result_stale === false && r.observation.counts.evidence === 1 && r.observation.result_kind === 'validated', 'status 汇总正确')
r = await control.handle({ workspace_dir: WS, task_id: 't1', action: 'resume' })
assert(r.observation.materials.length === 1 && r.observation.latest_operation.operation_id === 'op1' && typeof r.observation.next_step === 'string', 'resume 自包含简报')

// ── 14-B AC03：机械要求满足 → done 空动作 + host_required（交还宿主判断，不冒充业务完成）──
r = await control.handle({ workspace_dir: WS, task_id: 't1', action: 'status' })
assert(r.progress === 'done' && r.mechanical_requirements_met === true && r.goal_judgment === 'host_required', '14-B AC03 control status → done 合同（得 ' + JSON.stringify({ p: r.progress, m: r.mechanical_requirements_met, j: r.goal_judgment }) + '）')
r = await control.handle({ workspace_dir: WS, task_id: 't1', action: 'resume' })
assert(r.progress === 'done' && r.goal_judgment === 'host_required' && /host_required/i.test(r.observation.next_step), '14-B AC03 resume 交还口径（得 ' + (r.observation.next_step || '').slice(0, 80) + '）')
assert(r.allowed_actions.includes('code_read') && !r.allowed_actions.includes('code_patch'), 'validated → 允许 read 不允许写')

// ── expand 四类 ref ──
assert((await control.handle({ workspace_dir: WS, task_id: 't1', action: 'expand', ref: 'e1' })).observation.kind === 'evidence', 'expand evidence')
assert((await control.handle({ workspace_dir: WS, task_id: 't1', action: 'expand', ref: 'op1' })).observation.kind === 'operation', 'expand operation')
assert((await control.handle({ workspace_dir: WS, task_id: 't1', action: 'expand', ref: 'read_1' })).observation.kind === 'material', 'expand material')
assert((await control.handle({ workspace_dir: WS, task_id: 't1', action: 'expand', ref: 'candidates' })).observation.items.length === 1, 'expand candidates')
assert((await control.handle({ workspace_dir: WS, task_id: 't1', action: 'expand', ref: 'nope' })).error === 'unknown_ref', 'expand 未知 ref')
assert((await control.handle({ workspace_dir: WS, task_id: 't1', action: 'expand' })).error === 'missing_parameter', 'expand 缺 ref')

// ── result_stale：文件被外部改动 ──
writeFileSync(join(WS, F), 'alpha changed\n')
r = await control.handle({ workspace_dir: WS, task_id: 't1', action: 'status' })
assert(r.observation.result_stale === true, 'status 检出 result_stale')
r = await control.handle({ workspace_dir: WS, task_id: 't1', action: 'resume' })
assert(r.observation.result_stale === true && r.allowed_actions.includes('code_check'), 'stale → resume 建议 code_check')

// ── result_stale：batch 成功写后外部改动（回归修复：此前只认 patch）──
{
  const cur = readFileSync(join(WS, F), 'utf-8')
  const batchOp = { operation_id: 'opb', kind: 'batch', state: 'succeeded', files: [F], result_hashes: { [F]: h(cur) }, result_kind: 'partial' }
  mkTask('t_batch', { operations: [batchOp], evidence: [] })
  assert((await control.handle({ workspace_dir: WS, task_id: 't_batch', action: 'status' })).observation.result_stale === false, 'batch 与当前一致 → 不 stale')
  writeFileSync(join(WS, F), 'alpha changed again\n')
  assert((await control.handle({ workspace_dir: WS, task_id: 't_batch', action: 'status' })).observation.result_stale === true, 'batch 后文件被改动 → result_stale true（回归修复）')
}

// ── switch_route：goal_revision+1、证据保留 ──
r = await control.handle({ workspace_dir: WS, task_id: 't1', action: 'switch_route', route: 'diagnose' })
assert(r.ok === true && r.observation.route === 'diagnose' && r.observation.goal_revision === 2 && r.observation.evidence_retained === 1, 'switch_route 成功且保留证据')
assert((await control.handle({ workspace_dir: WS, task_id: 't1', action: 'switch_route', route: 'nope' })).error === 'invalid_input', 'switch_route 非法 route')

// ── W4：快照缺失 → 事件重建保留 route/goal_revision ──
rmSync(snapPath('t1'), { force: true })
assert(!existsSync(snapPath('t1')), 'W4 前置：快照已删')
const rebuilt = store.getTask(WS, 't1')
assert(rebuilt && rebuilt.route === 'diagnose' && rebuilt.goal_revision === 2, 'W4 route_changed 重放')

// ── cancel：正常 + 幂等 ──
mkTask('t2', {})
r = await control.handle({ workspace_dir: WS, task_id: 't2', action: 'cancel', reason: 'superseded' })
assert(r.ok === true && r.observation.cancelled === true, 'cancel 正常')
assert(store.getTask(WS, 't2').lifecycle === 'cancelled', 'cancel 持久化 lifecycle')
const r2 = await control.handle({ workspace_dir: WS, task_id: 't2', action: 'cancel' })
assert(r2.observation.cancelled === true && r2.observation.idempotent === true, 'cancel 幂等')
// 第二轮审查：cancel reason 持久化并可查回
assert(store.getTask(WS, 't2').cancel_reason === 'superseded', 'cancel reason 持久化到 task')
assert((await control.handle({ workspace_dir: WS, task_id: 't2', action: 'status' })).observation.cancel_reason === 'superseded', 'status 透出 cancel_reason')

// ── cancel：在途 prepared → 不提前确认（§7.2）──
mkTask('t3', { operations: [{ operation_id: 'op_p', kind: 'patch', state: 'prepared', file: F, request_id: 'rq', payload_hash: 'sha256:x' }], result_kind: 'partial' })
r = await control.handle({ workspace_dir: WS, task_id: 't3', action: 'cancel' })
assert(r.observation.cancelled === false && r.observation.ambiguous === true && r.observation.blocked_by.length === 1, '在途 → cancel 不确认')
assert(store.getTask(WS, 't3').lifecycle === 'active', '在途 cancel 不改 lifecycle')

// ── cancel：indeterminate 无活 writer → 收口 abandoned 并放行（第二轮审查，解死锁）──
mkTask('t3b', { operations: [{ operation_id: 'op_i', kind: 'patch', state: 'indeterminate', file: F, request_id: 'rq2', payload_hash: 'sha256:y' }], result_kind: 'partial' })
r = await control.handle({ workspace_dir: WS, task_id: 't3b', action: 'cancel', reason: 'abandon it' })
assert(r.observation.cancelled === true && (r.observation.abandoned_operations || []).includes('op_i'), 'indeterminate → cancel 放行并标 abandoned')
const t3b = store.getTask(WS, 't3b')
assert(t3b.lifecycle === 'cancelled' && t3b.operations.find(o => o.operation_id === 'op_i')?.state === 'abandoned', 'indeterminate op 持久化为 abandoned')
assert((await control.handle({ workspace_dir: WS, task_id: 't3b', action: 'status' })).observation.pending_operations.length === 0, 'abandoned 后不再 pending')

// ── switch_route 后旧 validated 失效（第二轮审查）──
mkTask('t_val', { result_kind: 'validated', validated_goal_revision: 1, goal_revision: 1, operations: [], evidence: [] })
assert((await control.handle({ workspace_dir: WS, task_id: 't_val', action: 'status' })).observation.result_stale === false, 'switch 前 validated 不 stale（前置）')
await control.handle({ workspace_dir: WS, task_id: 't_val', action: 'switch_route', route: 'diagnose' })
assert((await control.handle({ workspace_dir: WS, task_id: 't_val', action: 'status' })).observation.result_stale === true, 'switch_route 后旧 validated → result_stale true')
r = await control.handle({ workspace_dir: WS, task_id: 't_val', action: 'resume' })
assert(r.allowed_actions.includes('code_check') && /re-run code_check/.test(r.observation.next_step), 'switch 后 resume 建议重新验证')

// ── 13-B：有效状态统一——stale validated 不先进完成分支 + reason 区分 + review audit 引导 ──
{
  writeFileSync(join(WS, F), 'alpha drift 13b\n')
  mkTask('t_13b_file', { result_kind: 'validated', validated_goal_revision: 1, goal_revision: 1, operations: [patchOp], evidence: [] })
  let st = await statusMod.handle({ workspace_dir: WS, task_id: 't_13b_file' })
  assert(st.observation.result_stale === true && st.observation.stale_reason === 'file_change', '13-B 文件变化 reason=file_change（得 ' + st.observation.stale_reason + '）')
  assert(st.next_action.tool === 'code_check' && /Files changed/.test(st.next_action.note), '13-B stale validated → next_action=code_check（得 ' + JSON.stringify(st.next_action.tool) + '）')

  st = await statusMod.handle({ workspace_dir: WS, task_id: 't_val' })
  assert(st.observation.stale_reason === 'goal_change' && st.next_action.tool === 'code_check' && st.next_action.note.includes('Goal/route changed'), '13-B goal 漂移 reason=goal_change + next_action=code_check（得 ' + JSON.stringify({ r: st.observation.stale_reason, t: st.next_action.tool }) + '）')
  r = await control.handle({ workspace_dir: WS, task_id: 't_val', action: 'resume' })
  assert(r.observation.next_step.includes('Goal/route changed') && !r.observation.next_step.includes('Target changed'), '13-B resume 区分目标变化文案（得 ' + r.observation.next_step.slice(0, 40) + '）')

  mkTask('t_13b_review', { route: 'review', result_kind: 'validated', validated_goal_revision: 1, goal_revision: 1, operations: [], evidence: [] })
  st = await statusMod.handle({ workspace_dir: WS, task_id: 't_13b_review' })
  assert(st.next_action.tool === 'code_audit' && /audit-driven/.test(st.next_action.note), '13-B review validated 无 audit → next_action=code_audit')
  const auditEv = { evidence_id: 'ea1', kind: 'audit:code_review', result: 'findings', depends_on: [] }
  mkTask('t_13b_review2', { route: 'review', result_kind: 'validated', validated_goal_revision: 1, goal_revision: 1, operations: [], evidence: [auditEv] })
  st = await statusMod.handle({ workspace_dir: WS, task_id: 't_13b_review2' })
  assert(st.next_action.tool === 'code_status' && st.next_action.awaiting_decision === true, '13-B/13-C review 已 audit → next_action=code_status + awaiting_decision（得 ' + st.next_action.tool + '）')

  mkTask('t_13b_pending', { result_kind: 'validated', validated_goal_revision: 1, goal_revision: 1, operations: [{ operation_id: 'op_ind', kind: 'patch', state: 'indeterminate', file: F }], evidence: [] })
  st = await statusMod.handle({ workspace_dir: WS, task_id: 't_13b_pending' })
  assert(st.observation.stale_reason === 'pending_work', '13-B indeterminate → pending_work（得 ' + st.observation.stale_reason + '）')
  assert(st.next_action.tool === 'code_read' && st.next_action.progress === 'indeterminate', '14-A/N2 indeterminate → 具体核查动作（读受影响文件，不再 status/waiting 自指）（得 ' + JSON.stringify({ t: st.next_action.tool, p: st.next_action.progress }) + '）')
  assert(st.next_action.args?.locator?.file_path === F && st.next_action.effect_judgment === 'host_required', '14-A/N2 核查动作指向已知受影响文件 + 交还宿主判断（得 ' + JSON.stringify(st.next_action) + '）')
  assert(/UNCONFIRMED|stopped ≠ rolled back/i.test(st.next_action.note), '14-A/N2 note 先核对且不把停止当回滚（得 ' + st.next_action.note + '）')

  // 14-A AC30：审查证据适用性——旧 revision/未运行/依赖漂移不得当「已完成审查」
  const auditEv14 = (over = {}) => ({ evidence_id: 'ea14', kind: 'audit:code_review', result: 'passed', goal_revision: 1, depends_on: [], ...over })
  mkTask('t_14a_goal', { route: 'review', goal_revision: 2, operations: [], evidence: [auditEv14()] })
  st = await statusMod.handle({ workspace_dir: WS, task_id: 't_14a_goal' })
  assert(st.next_action.tool === 'code_audit' && /does not apply/.test(st.next_action.note), '14-A AC30 旧 revision audit 不适用新目标（得 ' + JSON.stringify({ t: st.next_action.tool, n: (st.next_action.note || '').slice(0, 40) }) + '）')
  mkTask('t_14a_skip', { route: 'review', goal_revision: 1, operations: [], evidence: [auditEv14({ result: 'skipped' })] })
  st = await statusMod.handle({ workspace_dir: WS, task_id: 't_14a_skip' })
  assert(st.next_action.tool === 'code_audit' && /does not apply/.test(st.next_action.note), '14-A AC30 skipped audit 不算审查完成')
  mkTask('t_14a_drift', { route: 'review', goal_revision: 1, operations: [], evidence: [auditEv14({ depends_on: [{ file: F, hash: 'sha256:deadbeef' }] })] })
  st = await statusMod.handle({ workspace_dir: WS, task_id: 't_14a_drift' })
  assert(st.next_action.tool === 'code_audit' && /does not apply/.test(st.next_action.note), '14-A AC30 依赖漂移 audit 不适用（得 ' + st.next_action.tool + '）')
}

// ── 14-A AC31：在途优先（live job / 运行中 op）——不得被「完成」覆盖，确认停止后恢复常规出口 ──
{
  const { startJob, cancelJob } = await import(pathToFileURL(join(__dirname, '..', 'workflow', 'jobs.js')).href)
  mkTask('t_14a_job', { result_kind: 'validated', validated_goal_revision: 1, goal_revision: 1, operations: [], evidence: [] })
  const job = startJob({ workspaceDir: WS, task_id: 't_14a_job', kind: 'check', run: ({ signal }) => new Promise(res => { signal.addEventListener('abort', () => res({ ok: false, cancelled: true })); setTimeout(() => res({ ok: true }), 8000) }) })
  let stj = await statusMod.handle({ workspace_dir: WS, task_id: 't_14a_job' })
  assert(stj.next_action.tool === 'code_control' && stj.next_action.progress === 'waiting' && stj.next_action.args?.job_id === job.job_id, '14-A AC31 运行中 job → waiting + job 身份可见（得 ' + JSON.stringify(stj.next_action || null) + '）')
  assert(/do not start a second run/.test(stj.next_action.note), '14-A AC31 waiting note 防二次运行')
  const cj = await cancelJob(WS, job.job_id, { waitMs: 3000 })
  assert(cj.cancelled === true, '14-A AC31 前置：cancel 确认停止（得 ' + JSON.stringify(cj) + '）')
  stj = await statusMod.handle({ workspace_dir: WS, task_id: 't_14a_job' })
  assert(stj.next_action === null && stj.progress === 'done' && stj.goal_judgment === 'host_required', '14-A/14-B 停止后 → done 空动作（得 ' + JSON.stringify({ na: stj.next_action, p: stj.progress }) + '）')
  mkTask('t_14a_op', { result_kind: 'validated', validated_goal_revision: 1, goal_revision: 1, operations: [{ operation_id: 'op_run', kind: 'check', state: 'running' }], evidence: [] })
  const stOp = await statusMod.handle({ workspace_dir: WS, task_id: 't_14a_op' })
  assert(stOp.next_action.tool === 'code_control' && stOp.next_action.progress === 'waiting', '14-A AC31 运行中 operation → waiting（得 ' + JSON.stringify({ t: stOp.next_action.tool, p: stOp.next_action.progress }) + '）')
}

// ── 参数/鉴权/revision 错误 ──
assert((await control.handle({ workspace_dir: WS, task_id: 't1', action: 'bogus' })).error === 'invalid_input', '未知 action')
assert((await control.handle({ workspace_dir: WS, task_id: 'ghost', action: 'status' })).error === 'task_not_found', '未知 task')
assert((await control.handle({ workspace_dir: join(TMP, 'other'), task_id: 't1', action: 'status' })).error === 'invalid_input', 'workspace 不存在')
assert((await control.handle({ workspace_dir: WS, task_id: 't1', action: 'switch_route', route: 'review', expected_state_revision: 99 })).error === 'revision_conflict', 'revision 冲突')

console.log(`\n=== test-s2-control: ${pass} passed, ${fail} failed ===`)
process.exit(fail > 0 ? 1 : 0)