// test-s5-worktree.js — S5.4a git_worktree 阶段化（code_worktree）失败/边界路径
// 覆盖：normalizeChanges 校验、previewChanges 判定、classifyWorktreeResult、preview 默认不落盘、
//       apply 委派+单操作+证据、request_id 去重/冲突、merge_failed_commit_preserved → indeterminate+status、
//       status 列出、鉴权/参数/版本/revision 错误。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP = join(os.tmpdir(), 'opencode', 's5-worktree-test')
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
const WS = join(TMP, 'ws')
mkdirSync(join(WS, 'src'), { recursive: true })
process.env.MALONG_STATE_DIR = join(TMP, 'state')
process.env.MALONG_ENTRY_STATE = '1'

let pass = 0, fail = 0
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  FAIL:', msg) } }

const shared = await import(pathToFileURL(join(__dirname, '..', 'tools', 'entry-shared.js')).href)
const wt = await import(pathToFileURL(join(__dirname, '..', 'workflow', 'worktree.js')).href)
const handler = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-code-worktree', 'handler.js')).href)

const read = (f) => readFileSync(join(WS, f), 'utf-8')
let RUNNER = async () => ({ success: true, branch: 'b', files: 1, commit: 'abcdef123456' })
const ctx = { codeIndexService: null, worktreeRunner: (...a) => RUNNER(...a) }

function mkTask(id, extra = {}) {
  const t = { task_id: id, revision: 1, route: 'change', lifecycle: 'active', node: 'edit', materials: [], operations: [], workspace_dir: WS, ...extra }
  shared.putTask(WS, t, { type: 'task_created', task: t })
  return t
}

// ── 0. 测试文件 ──
writeFileSync(join(WS, 'src', 'a.js'), 'old a\n')
writeFileSync(join(WS, 'src', 'same.js'), 'same\n')
writeFileSync(join(WS, 'src', 'del.js'), 'del\n')

// ── 1. normalizeChanges ──
assert(wt.normalizeChanges([]).error === 'missing_parameter', '空 changes → missing_parameter')
assert(wt.normalizeChanges([{ path: '' }]).error === 'invalid_parameter', '空 path → invalid_parameter')
assert(wt.normalizeChanges([{ path: 'x', new_content: 3 }]).error === 'invalid_parameter', 'new_content 非串 → invalid_parameter')
assert(wt.normalizeChanges([{ path: 'x', delete: 'yes' }]).error === 'invalid_parameter', 'delete 非布尔 → invalid_parameter')
assert(wt.normalizeChanges([{ path: 'x', new_content: 'a', delete: true }]).error === 'invalid_parameter', 'new_content+delete 互斥')
assert(wt.normalizeChanges([{ path: 'x', new_content: 'a' }]).ok === true, '合法 change 通过')

// ── 2. previewChanges ──
const pv = wt.previewChanges(WS, [
  { path: 'src/a.js', new_content: 'new a\n' },
  { path: 'src/same.js', new_content: 'same\n' },
  { path: 'src/new.js', new_content: 'brand new\n' },
  { path: 'src/del.js', delete: true },
  { path: 'src/missing_del.js', delete: true },
])
assert(pv[0].action === 'modify' && pv[0].changed === true, '存在且不同 → modify')
assert(pv[1].action === 'noop' && pv[1].changed === false, '内容相同 → noop')
assert(pv[2].action === 'add' && pv[2].changed === true, '不存在 → add')
assert(pv[3].action === 'delete', '存在且 delete → delete')
assert(pv[4].action === 'noop' && pv[4].reason === 'missing', '不存在且 delete → noop/missing')

// ── 3. classifyWorktreeResult ──
assert(wt.classifyWorktreeResult({ success: true }).opState === 'succeeded', 'success → succeeded')
assert(wt.classifyWorktreeResult({ success: false, error: 'merge_failed_commit_preserved' }).opState === 'indeterminate', 'preserved → indeterminate')
assert(wt.classifyWorktreeResult({ success: false, error: 'transaction_rolled_back' }).opState === 'failed', 'rollback → failed')

// ── 4. preview 默认：不触 runner、不记操作 ──
mkTask('task_p')
let called = 0
RUNNER = async () => { called++; return { success: true } }
let r = await handler.handle({ workspace_dir: WS, task_id: 'task_p', changes: [{ path: 'src/a.js', new_content: 'zzz\n' }] }, ctx)
assert(r.ok === true && r.observation.effect === 'preview' && r.observation.dry_run === true, '默认 action=preview')
assert(called === 0 && read('src/a.js') === 'old a\n', 'preview 不触 git、不改文件')
assert(shared.getTask(WS, 'task_p').operations.length === 0, 'preview 不记操作')
// R5（0.5.14）：应用前说清副作用——apply 会提交并更新当前基分支，不等到 apply 后才知道
assert(r.observation.base?.ref === 'HEAD', 'R5 preview 标出 base/ref（得 ' + JSON.stringify(r.observation.base) + '）')
assert(r.observation.apply_plan?.commits_to_base_branch === true, 'R5 preview 标出会提交到基分支')
assert((r.observation.apply_plan?.steps || []).some(s => /fast-forward merge into the CURRENT branch/.test(s)), 'R5 preview 步骤写明 ff-merge 到当前分支（得 ' + JSON.stringify(r.observation.apply_plan?.steps) + '）')
assert((r.observation.apply_plan?.touches_files || []).includes('src/a.js'), 'R5 preview 列出触及文件')
assert(/merge failure → commit preserved/.test(String(r.observation.apply_plan?.failure_behavior)), 'R5 preview 说明失败保留/回滚行为')
{
  const mf = JSON.parse(readFileSync(join(__dirname, '..', 'tools', 'tool-code-worktree', 'manifest.json'), 'utf-8'))
  assert(/CURRENT branch/.test(mf.description), 'R5 工具描述写明 apply 更新当前分支（tools/list 可见，得 ' + mf.description.slice(0, 120) + '）')
}

// ── 5. apply 未显式 dry_run=false → 仍预览 ──
r = await handler.handle({ workspace_dir: WS, task_id: 'task_p', action: 'apply', changes: [{ path: 'src/a.js', new_content: 'zzz\n' }] }, ctx)
assert(r.ok === true && r.observation.dry_run === true && called === 0, 'apply 缺 dry_run=false → 仍预览')
assert(r.observation.applied === false && /PREVIEW only/.test(String(r.observation.summary)) && !!r.observation.warning, `狗粮r2: apply 缺 dry_run=false → 显式 applied:false + 警示（得 ${JSON.stringify({ a: r.observation.applied, s: r.observation.summary })}）`)

// ── 6. apply 成功：委派 + 单操作 + 证据 ──
RUNNER = async () => ({ success: true, branch: 'b1', files: 1, commit: 'abcdef123456' })
mkTask('task_ok')
r = await handler.handle({ workspace_dir: WS, task_id: 'task_ok', action: 'apply', dry_run: false, request_id: 'wt1', changes: [{ path: 'src/a.js', new_content: 'new a\n' }] }, ctx)
assert(r.ok === true && r.observation.committed === true, 'apply 提交')
assert(r.observation.operation?.state === 'succeeded' && r.observation.operation.kind === 'worktree', 'operation worktree succeeded')
assert(r.observation.commit === 'abcdef123456' && r.observation.branch === 'b1', '返回 commit/branch')
assert(r.observation.evidence?.source === 'git_worktree' && r.observation.evidence.provenance?.tool === 'git_worktree', 'T21 证据溯源 git_worktree')
assert(shared.getTask(WS, 'task_ok').evidence.some(e => e.kind === 'worktree:apply'), '证据持久化')

// ── 7. 去重（同 id 同载荷）──
r = await handler.handle({ workspace_dir: WS, task_id: 'task_ok', action: 'apply', dry_run: false, request_id: 'wt1', changes: [{ path: 'src/a.js', new_content: 'new a\n' }] }, ctx)
assert(r.ok === true && r.observation.deduplicated === true, '同 id 同载荷 → dedup')

// ── 8. 同 id 异载荷 → 拒绝 ──
r = await handler.handle({ workspace_dir: WS, task_id: 'task_ok', action: 'apply', dry_run: false, request_id: 'wt1', changes: [{ path: 'src/a.js', new_content: 'different\n' }] }, ctx)
assert(r.error === 'request_conflict', `同 id 异载荷 → request_conflict（得 ${r.error}）`)

// ── 8b. live 审查 J1：同 id 同长度不同内容 → 必须 request_conflict（旧实现只比 len 会静默去重）──
r = await handler.handle({ workspace_dir: WS, task_id: 'task_ok', action: 'apply', dry_run: false, request_id: 'wt1', changes: [{ path: 'src/a.js', new_content: 'new b\n' }] }, ctx)
assert(r.error === 'request_conflict', `同 id 同长度不同内容 → request_conflict（得 ${r.error || JSON.stringify(r.observation?.deduplicated)}）`)

// ── 9. merge 失败但提交保留 → indeterminate + 证据 + status 可见 ──
RUNNER = async () => ({ success: false, error: 'merge_failed_commit_preserved', branch: 'b2', commit: 'deadbeefcafe', detail: 'git merge b2' })
mkTask('task_pre')
r = await handler.handle({ workspace_dir: WS, task_id: 'task_pre', action: 'apply', dry_run: false, request_id: 'wt2', changes: [{ path: 'src/a.js', new_content: 'x\n' }] }, ctx)
assert(r.ok === true && r.observation.committed === false && r.preserved === true, 'preserved → committed=false + preserved')
assert(r.observation.operation.state === 'indeterminate' && r.observation.operation.branch === 'b2', 'op indeterminate 保留分支')
assert(r.observation.evidence.result === 'unknown' && r.observation.evidence.limitations.some(l => l.includes('preserved')), '证据 unknown + 保留分支限制')
r = await handler.handle({ workspace_dir: WS, task_id: 'task_pre', action: 'status' }, ctx)
assert(r.observation.preserved.length === 1 && r.observation.preserved[0].branch === 'b2', 'status 列出保留分支')

// ── 10. 回滚失败 → failed 操作 ──
RUNNER = async () => ({ success: false, error: 'transaction_rolled_back', message: 'verify failed' })
mkTask('task_rb')
r = await handler.handle({ workspace_dir: WS, task_id: 'task_rb', action: 'apply', dry_run: false, request_id: 'wt3', changes: [{ path: 'src/a.js', new_content: 'y\n' }] }, ctx)
assert(r.observation.operation.state === 'failed' && r.observation.evidence.result === 'failed', '回滚 → failed')
assert(r.observation.effect === 'none' && r.observation.result_kind === undefined, '狗粮r3: 回滚回执 effect=none 且不继承旧 result_kind（得 ' + JSON.stringify({ effect: r.observation.effect, result_kind: r.observation.result_kind }) + '）')
// dogfood-050（P2 修复）：失败原因必须可诊断（旧实现只回 transaction_rolled_back）
assert(r.observation.operation.error_detail === 'verify failed', `op.error_detail 记录失败原因（得 ${r.observation.operation.error_detail}）`)
assert(r.error_message === 'verify failed', `顶层 error_message 透出（得 ${r.error_message}）`)
assert(String(r.observation.summary).includes('Reason: verify failed'), `summary 带 Reason（得 ${r.observation.summary}）`)

// ── 10b. verify 失败透传 exit code + 输出 tail（dogfood-050 P2）──
RUNNER = async () => ({ success: false, error: 'transaction_rolled_back', message: 'verification failed (exit 3): boom', verify: { exit_code: 3, stdout_tail: '', stderr_tail: 'boom' } })
mkTask('task_rbv')
r = await handler.handle({ workspace_dir: WS, task_id: 'task_rbv', action: 'apply', dry_run: false, request_id: 'wt3b', changes: [{ path: 'src/a.js', new_content: 'z\n' }] }, ctx)
assert(r.verify && r.verify.exit_code === 3 && r.verify.stderr_tail === 'boom', `顶层 verify 透出（得 ${JSON.stringify(r.verify)}）`)
assert(String(r.error_message).includes('boom'), `error_message 含 verify 输出（得 ${r.error_message}）`)
assert(r.observation.evidence.actual && String(r.observation.evidence.actual.message || '').includes('boom'), 'evidence.actual.message 含 verify 输出')

// ── 11. status：空 task ──
mkTask('task_empty')
r = await handler.handle({ workspace_dir: WS, task_id: 'task_empty', action: 'status' }, ctx)
assert(r.ok === true && r.observation.transactions.length === 0, 'status 空任务 0 事务')

// ── 12. 鉴权/参数/版本/revision ──
assert((await handler.handle({ task_id: 'task_p', changes: [{ path: 'a' }] }, ctx)).error === 'missing_parameter', '缺 workspace_dir')
assert((await handler.handle({ workspace_dir: join(TMP, 'nope'), task_id: 'x', changes: [{ path: 'a' }] }, ctx)).error === 'invalid_input', 'workspace 不存在')
assert((await handler.handle({ workspace_dir: WS, changes: [{ path: 'a' }] }, ctx)).error === 'missing_parameter', '缺 task_id')
assert((await handler.handle({ workspace_dir: WS, task_id: 'ghost', changes: [{ path: 'a' }] }, ctx)).error === 'task_not_found', '未知 task')
assert((await handler.handle({ workspace_dir: WS, task_id: 'task_p', action: 'bogus', changes: [{ path: 'a' }] }, ctx)).error === 'invalid_input', '非法 action')
assert((await handler.handle({ workspace_dir: WS, task_id: 'task_p', action: 'apply', dry_run: false }, ctx)).error === 'missing_parameter', 'apply 缺 changes → missing_parameter')
mkTask('task_ver', { schema_version: 2 })
assert((await handler.handle({ workspace_dir: WS, task_id: 'task_ver', action: 'status' }, ctx)).error === 'task_version_unsupported', '版本更新 → task_version_unsupported')
assert((await handler.handle({ workspace_dir: WS, task_id: 'task_ok', expected_state_revision: 99, action: 'status' }, ctx)).error === 'revision_conflict', 'revision 冲突')

// ── 13. live 审查 J2：runner 执行期间 revision 被并发改动 → CAS 有界重试仍持久化 operation ──
RUNNER = async () => {
  const cur = shared.getTask(WS, 'task_cas')
  shared.updateTaskCas(WS, 'task_cas', cur.revision, (t) => { t.node = 'orient'; return { type: 'node', data: { node: 'orient' } } })
  return { success: true, branch: 'b_cas', files: 1, commit: 'cafebabe1234' }
}
mkTask('task_cas')
r = await handler.handle({ workspace_dir: WS, task_id: 'task_cas', action: 'apply', dry_run: false, request_id: 'wt_cas', changes: [{ path: 'src/a.js', new_content: 'cas\n' }] }, ctx)
assert(r.ok === true && r.observation.committed === true && r.observation.operation?.state === 'succeeded', `CAS 冲突重试后提交成功（得 committed=${r.observation?.committed} state=${r.observation?.operation?.state}）`)
assert(shared.getTask(WS, 'task_cas').operations.some(o => o.operation_id === r.observation.operation.operation_id), 'operation 记录已持久化（不再丢失）')

// ── 14~17. 第二轮审查 worktree W1/W3：prepared 重试按文件状态对账，不盲目重跑 ──
const noRun = async () => { throw new Error('runner must not run') }
const HH = (s) => `sha256:${shared.sha256Hex(s)}`
const seedOp = (taskId, op) => {
  const cur = shared.getTask(WS, taskId)
  shared.updateTaskCas(WS, taskId, cur.revision, (t) => {
    t.operations = [op]
    return { type: 'operation', data: { operation: op, node: 'worktree' } }
  })
}
// 14. 已 intended（模拟 runner 已合并、op 未收口）→ 收口不重跑
{
  const ph = shared.payloadHash({ task_id: 'task_rec', kind: 'worktree', message: null, verify_cmd: null, changes: [{ path: 'src/a.js', exists: 'content', content: 'recovered\n' }] })
  mkTask('task_rec')
  seedOp('task_rec', { operation_id: 'op_rec', request_id: 'wt_rec', payload_hash: ph, state: 'prepared', kind: 'worktree', files: ['src/a.js'], pre_hashes: { 'src/a.js': HH('old a\n') }, intended_hashes: { 'src/a.js': HH('recovered\n') }, created: 'seed' })
  writeFileSync(join(WS, 'src', 'a.js'), 'recovered\n')
  RUNNER = noRun
  r = await handler.handle({ workspace_dir: WS, task_id: 'task_rec', action: 'apply', dry_run: false, request_id: 'wt_rec', changes: [{ path: 'src/a.js', new_content: 'recovered\n' }] }, ctx)
  assert(r.ok === true && r.observation.recovered === true && r.observation.committed === true, `W1/W3 已 applied → 收口不重跑（得 ${JSON.stringify(r.error || r.observation?.summary)}）`)
  assert(shared.getTask(WS, 'task_rec').operations.find(o => o.operation_id === 'op_rec')?.state === 'succeeded', 'W1/W3 op 收口 succeeded')
}
// 15. mixed/external → indeterminate（不覆盖外部改动）
{
  const ph = shared.payloadHash({ task_id: 'task_mix', kind: 'worktree', message: null, verify_cmd: null, changes: [{ path: 'src/a.js', exists: 'content', content: 'mix\n' }] })
  mkTask('task_mix')
  seedOp('task_mix', { operation_id: 'op_mix', request_id: 'wt_mix', payload_hash: ph, state: 'prepared', kind: 'worktree', files: ['src/a.js'], pre_hashes: { 'src/a.js': HH('old a\n') }, intended_hashes: { 'src/a.js': HH('mix\n') }, created: 'seed' })
  writeFileSync(join(WS, 'src', 'a.js'), 'third\n')
  RUNNER = noRun
  r = await handler.handle({ workspace_dir: WS, task_id: 'task_mix', action: 'apply', dry_run: false, request_id: 'wt_mix', changes: [{ path: 'src/a.js', new_content: 'mix\n' }] }, ctx)
  assert(r.error === 'indeterminate', `W3 mixed → indeterminate（得 ${JSON.stringify(r.error)}）`)
  assert(shared.getTask(WS, 'task_mix').operations.find(o => o.operation_id === 'op_mix')?.state === 'indeterminate', 'W3 mixed op 落 indeterminate')
  assert(read('src/a.js') === 'third\n', 'W3 mixed 不覆盖外部改动')
}
// 16. preserved 分支同 id 重试 → 幂等返回现状，不重跑
{
  const ph = shared.payloadHash({ task_id: 'task_pres', kind: 'worktree', message: null, verify_cmd: null, changes: [{ path: 'src/a.js', exists: 'content', content: 'pres\n' }] })
  mkTask('task_pres')
  seedOp('task_pres', { operation_id: 'op_pres', request_id: 'wt_pres', payload_hash: ph, state: 'indeterminate', kind: 'worktree', files: ['src/a.js'], preserved: true, branch: 'b_pres', commit: 'deadbee', created: 'seed' })
  RUNNER = noRun
  r = await handler.handle({ workspace_dir: WS, task_id: 'task_pres', action: 'apply', dry_run: false, request_id: 'wt_pres', changes: [{ path: 'src/a.js', new_content: 'pres\n' }] }, ctx)
  assert(r.ok === true && r.observation.deduplicated === true && r.observation.branch === 'b_pres', `preserved 重试 → 幂等返回分支（得 ${JSON.stringify(r.error || r.observation?.branch)}）`)
}
// 17. allPre → 安全重放（runner 正常执行）
{
  const ph = shared.payloadHash({ task_id: 'task_replay', kind: 'worktree', message: null, verify_cmd: null, changes: [{ path: 'src/same.js', exists: 'content', content: 'replay\n' }] })
  mkTask('task_replay')
  seedOp('task_replay', { operation_id: 'op_replay', request_id: 'wt_replay', payload_hash: ph, state: 'prepared', kind: 'worktree', files: ['src/same.js'], pre_hashes: { 'src/same.js': HH('same\n') }, intended_hashes: { 'src/same.js': HH('replay\n') }, created: 'seed' })
  let ran = 0
  RUNNER = async () => { ran++; return { success: true, branch: 'b_replay', commit: 'cafef00d' } }
  r = await handler.handle({ workspace_dir: WS, task_id: 'task_replay', action: 'apply', dry_run: false, request_id: 'wt_replay', changes: [{ path: 'src/same.js', new_content: 'replay\n' }] }, ctx)
  assert(r.ok === true && r.observation.committed === true && ran === 1, `allPre → 安全重放执行（得 ran=${ran}）`)
}

console.log(`\n=== test-s5-worktree: ${pass} passed, ${fail} failed ===`)
process.exit(fail > 0 ? 1 : 0)