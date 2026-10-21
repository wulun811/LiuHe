// test-s2-patch.js — S2.1 写路径（code_patch）失败/恢复路径
// 覆盖：默认预览不落盘、apply 落盘、request_id 去重幂等、同 id 异载荷拒绝、
//       base_version 陈旧 → VERSION_CONFLICT、W1 prepared 重试可收口、W2/W3 already_applied 恢复、
//       W4 快照缺失由事件重建（operation 事件重放）、任务/workspace/read_ref 鉴权错误。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP = join(os.tmpdir(), 'opencode', 's2-patch-test')
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
const WS = join(TMP, 'ws')
mkdirSync(join(WS, 'src'), { recursive: true })
process.env.MALONG_STATE_DIR = join(TMP, 'state')
process.env.MALONG_ENTRY_STATE = '1'

let pass = 0, fail = 0
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  FAIL:', msg) } }

const shared = await import(pathToFileURL(join(__dirname, '..', 'tools', 'entry-shared.js')).href)
const store = await import(pathToFileURL(join(__dirname, '..', 'tools', 'entry-store.js')).href)
const patch = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-code-patch', 'handler.js')).href)
const ctx = { codeIndexService: null, langParserService: null }
const snapPath = (id) => join(process.env.MALONG_STATE_DIR, 'entry-tasks', store.wsHash(WS), `${id}.json`)

const F = 'src/a.txt'
const ORIG = 'alpha\nbeta\ngamma\n'
writeFileSync(join(WS, F), ORIG)
const fileHashOf = (s) => `sha256:${shared.sha256Hex(s)}`

function mkTask(id, materials) {
  const t = {
    task_id: id, revision: 1, route: 'change', lifecycle: 'active', node: 'read',
    materials, operations: [], workspace_dir: WS,
  }
  shared.putTask(WS, t, { type: 'task_created', task: t })
  return t
}
const material = (ref, file, hash) => ({ read_ref: ref, locator: { file_path: file }, canonical_path: file, file_version: { hash }, symbol_version: null })

// ── 正常：缺省 dry_run → 预览不落盘 ──
mkTask('task_p', [material('read_1', F, fileHashOf(ORIG))])
let r = await patch.handle({ workspace_dir: WS, task_id: 'task_p', read_ref: 'read_1', edit_mode: 'patch', patch: { old_string: 'beta', new_string: 'BETA' } }, ctx)
assert(r.ok === true && r.observation?.effect === 'preview' && r.observation?.dry_run === true, '缺省 dry_run → 预览')
assert(readFileSync(join(WS, F), 'utf-8') === ORIG, '预览不落盘')

// ── 正常：apply 落盘 + revision 递增（prepared→succeeded）──
r = await patch.handle({ workspace_dir: WS, task_id: 'task_p', read_ref: 'read_1', edit_mode: 'patch', patch: { old_string: 'beta', new_string: 'BETA' }, dry_run: false, request_id: 'req_apply_1' }, ctx)
assert(r.ok === true && r.observation?.effect === 'workspace_write' && r.observation?.committed === true, 'apply 落盘')
assert(readFileSync(join(WS, F), 'utf-8') === 'alpha\nBETA\ngamma\n', '文件已改')
assert(r.task.revision === 3, `revision 1→3（prepared+succeeded，得 ${r.task?.revision}）`)
assert(r.observation?.operation?.state === 'succeeded', 'operation 记 succeeded')

// ── 去重：同 request_id 同载荷 → 幂等，不再写 ──
const r2 = await patch.handle({ workspace_dir: WS, task_id: 'task_p', read_ref: 'read_1', edit_mode: 'patch', patch: { old_string: 'beta', new_string: 'BETA' }, dry_run: false, request_id: 'req_apply_1' }, ctx)
assert(r2.ok === true && r2.observation?.deduplicated === true, '同 id 同载荷 → dedup 幂等')
assert(readFileSync(join(WS, F), 'utf-8') === 'alpha\nBETA\ngamma\n', 'dedup 不重复写')

// ── 同 request_id 异载荷 → 拒绝 ──
const r3 = await patch.handle({ workspace_dir: WS, task_id: 'task_p', read_ref: 'read_1', edit_mode: 'patch', patch: { old_string: 'alpha', new_string: 'ALPHA' }, dry_run: false, request_id: 'req_apply_1' }, ctx)
assert(r3.error === 'request_conflict', `同 id 异载荷 → request_conflict（得 ${r3.error}）`)
assert(readFileSync(join(WS, F), 'utf-8') === 'alpha\nBETA\ngamma\n', '拒绝后文件不变')

// ── 陈旧 base_version → VERSION_CONFLICT ──
const r4 = await patch.handle({ workspace_dir: WS, task_id: 'task_p', read_ref: 'read_1', edit_mode: 'patch', patch: { old_string: 'BETA', new_string: 'beta' }, dry_run: false, request_id: 'req_stale_1' }, ctx)
assert(r4.error === 'VERSION_CONFLICT' && r4.conflict_type === 'FILE_CHANGED', `陈旧 base → FILE_CHANGED（得 ${r4.error}/${r4.conflict_type}）`)
assert(r4.suggestion && /code_read/.test(r4.suggestion) && !/read_symbol/.test(r4.suggestion) && r4.next_action?.tool === 'code_read', `VERSION_CONFLICT 指引归一 code_read（得 suggestion=${r4.suggestion}, next=${r4.next_action?.tool}）`)

// ── WP08R-2 G2：错误 next_action 可执行化（args + 全参，取出即调用）+ NO_BASE 文案 ──
assert(r4.next_action?.args && !('params' in r4.next_action) && r4.next_action.args.workspace_dir === WS && r4.next_action.args.task_id === 'task_p' && r4.next_action.args.locator?.file_path === F, `错误 next_action 可执行化：args+全参（得 ${JSON.stringify(r4.next_action)}）`)
// ── WP08R-3 A2：预览免 base（先看 diff/校验再决定读不读）+ apply 仍 NO_BASE ──
mkTask('task_nb', [])
const rnb = await patch.handle({ workspace_dir: WS, task_id: 'task_nb', locator: { file_path: F }, edit_mode: 'patch', patch: { old_string: 'alpha', new_string: 'ALPHA' } }, ctx)
assert(rnb.ok === true && rnb.observation?.dry_run === true && rnb.observation?.preview_without_base === true, `无 base 预览 → OK + preview_without_base（得 ${JSON.stringify(rnb.observation || rnb.error)}）`)
assert(rnb.observation?.diff && rnb.observation?.new_version?.file?.hash, `无 base 预览仍给 diff/校验（得 ${JSON.stringify(Object.keys(rnb.observation || {}))}）`)
assert(rnb.next_action?.tool === 'code_read' && rnb.next_action?.args?.workspace_dir === WS && rnb.next_action?.args?.task_id === 'task_nb' && rnb.next_action?.args?.locator?.file_path === F, `无 base 预览 next_action → 可执行 code_read（得 ${JSON.stringify(rnb.next_action)}）`)
assert(readFileSync(join(WS, F), 'utf-8') === 'alpha\nBETA\ngamma\n', '无 base 预览不落盘')
const rnbA = await patch.handle({ workspace_dir: WS, task_id: 'task_nb', locator: { file_path: F }, edit_mode: 'patch', patch: { old_string: 'alpha', new_string: 'ALPHA' }, dry_run: false }, ctx)
assert(rnbA.error === 'VERSION_CONFLICT' && rnbA.conflict_type === 'NO_BASE', `无 base apply → 仍 NO_BASE（得 ${rnbA.error}/${rnbA.conflict_type}）`)
assert(/symbol read does not establish a file base/.test(rnbA.message || ''), `NO_BASE 文案点明 symbol 读不建立 file base（得 ${rnbA.message}）`)
assert(rnbA.next_action?.args?.workspace_dir === WS && rnbA.next_action?.args?.task_id === 'task_nb' && rnbA.next_action?.args?.locator?.file_path === F, `NO_BASE next_action 全参可执行（得 ${JSON.stringify(rnbA.next_action)}）`)

// ── WP08R-3 A3：批量劝导（同 task 同文件第 2 次弱 / 第 3 次起强；预览也带）──
const HINTF = 'src/hint.txt'
writeFileSync(join(WS, HINTF), 'a\nb\nc\n')
mkTask('task_hint', [])
const rh1 = await patch.handle({ workspace_dir: WS, task_id: 'task_hint', locator: { file_path: HINTF }, base_version: { file: { hash: fileHashOf('a\nb\nc\n') } }, edit_mode: 'patch', patch: { old_string: 'a', new_string: 'a1' }, dry_run: false, request_id: 'rq_hint1' }, ctx)
assert(rh1.ok === true && !rh1.batch_hint, `第 1 次 patch 无批量提示（得 ${rh1.batch_hint}）`)
const rh2 = await patch.handle({ workspace_dir: WS, task_id: 'task_hint', locator: { file_path: HINTF }, base_version: { file: { hash: fileHashOf('a1\nb\nc\n') } }, edit_mode: 'patch', patch: { old_string: 'b', new_string: 'b1' }, dry_run: false, request_id: 'rq_hint2' }, ctx)
assert(rh2.ok === true && /2nd code_patch/.test(rh2.batch_hint || ''), `第 2 次 patch → 弱批量提示（得 ${rh2.batch_hint}）`)
const rh3 = await patch.handle({ workspace_dir: WS, task_id: 'task_hint', locator: { file_path: HINTF }, base_version: { file: { hash: fileHashOf('a1\nb1\nc\n') } }, edit_mode: 'patch', patch: { old_string: 'c', new_string: 'c1' }, dry_run: false, request_id: 'rq_hint3' }, ctx)
assert(rh3.ok === true && /STOP single-edit mode/.test(rh3.batch_hint || '') && /code_batch/.test(rh3.batch_hint || ''), `第 3 次 patch → 强批量提示（得 ${rh3.batch_hint}）`)
assert(/STOP single-edit mode/.test(rh3.next_step || ''), `第 3 次 patch → next_step 同步强化（得 ${rh3.next_step}）`)
const rhP = await patch.handle({ workspace_dir: WS, task_id: 'task_hint', locator: { file_path: HINTF }, edit_mode: 'patch', patch: { old_string: 'a1', new_string: 'a2' } }, ctx)
assert(rhP.ok === true && /STOP single-edit mode/.test(rhP.batch_hint || ''), `预览（第 4 次调用）也带强提示（得 ${rhP.batch_hint}）`)
assert(rhP.next_action?.tool === 'code_read' && readFileSync(join(WS, HINTF), 'utf-8') === 'a1\nb1\nc1\n', '强提示预览仍不落盘')
// WP08R-5 批次2：错误路径也带批量提示（c1 实拍：写错误循环里毫无劝导）+ 弱提示带形状样板
const rhE = await patch.handle({ workspace_dir: WS, task_id: 'task_hint', locator: { file_path: HINTF }, base_version: { file: { hash: fileHashOf('STALE\n') } }, edit_mode: 'patch', patch: { old_string: 'a1', new_string: 'a2' }, dry_run: false, request_id: 'rq_hintE' }, ctx)
assert(rhE.error === 'VERSION_CONFLICT' && /STOP single-edit mode/.test(rhE.batch_hint || ''), `错误路径也带批量提示（得 ${rhE.error}/${rhE.batch_hint}）`)
assert(/writes: \[\{read_ref/.test(rh2.batch_hint || ''), `弱提示带 code_batch 形状样板（得 ${rh2.batch_hint}）`)

// ── 失败路径：old_string 不存在（预览期即拒；base 取当前态否则先撞冲突）──
mkTask('task_miss', [material('read_1', F, fileHashOf('alpha\nBETA\ngamma\n'))])
const rbad = await patch.handle({ workspace_dir: WS, task_id: 'task_miss', read_ref: 'read_1', edit_mode: 'patch', patch: { old_string: 'nope', new_string: 'x' } }, ctx)
assert(rbad.error === 'PATCH_OLD_STRING_NOT_FOUND', `old_string 未命中（得 ${rbad.error}）`)

// ── 鉴权/参数错误 ──
assert((await patch.handle({ workspace_dir: WS, task_id: 'ghost' }, ctx)).error === 'task_not_found', '未知 task')
assert((await patch.handle({ workspace_dir: join(TMP, 'other'), task_id: 'task_p' }, ctx)).error === 'invalid_input', 'workspace 不存在')
assert((await patch.handle({ workspace_dir: WS, task_id: 'task_p', read_ref: 'read_x' }, ctx)).error === 'read_ref_not_found', '未知 read_ref')
assert((await patch.handle({ workspace_dir: WS, task_id: 'task_p' }, ctx)).error === 'missing_parameter', '缺 locator/read_ref')

// ── W1：prepared 后崩溃 → 同 request_id 重试可收口 ──
const F1 = 'src/w1.txt', O1 = 'one\ntwo\n'
writeFileSync(join(WS, F1), O1)
mkTask('task_w1', [material('read_1', F1, fileHashOf(O1))])
const PATCH1 = { old_string: 'two', new_string: 'TWO' }
const ph1 = shared.payloadHash({ task_id: 'task_w1', file: F1, edit_mode: 'patch', patch: PATCH1, content: null, boundary: null })
shared.updateTaskCas(WS, 'task_w1', 1, (t) => {
  const p = { operation_id: 'op_w1', request_id: 'req_w1', payload_hash: ph1, state: 'prepared', kind: 'patch', file: F1, read_ref: 'read_1', base_version: { file: { hash: fileHashOf(O1) } }, pre_file_hash: fileHashOf(O1), created: 'seed' }
  t.operations = [p]; t.node = 'edit'
  return { type: 'operation', data: { operation: p, node: 'edit' } }
})
assert(readFileSync(join(WS, F1), 'utf-8') === O1, 'W1 前置：文件未改')
r = await patch.handle({ workspace_dir: WS, task_id: 'task_w1', read_ref: 'read_1', edit_mode: 'patch', patch: PATCH1, dry_run: false, request_id: 'req_w1' }, ctx)
assert(r.ok === true && readFileSync(join(WS, F1), 'utf-8') === 'one\nTWO\n', 'W1 prepared 重试落盘')
assert(r.observation?.operation?.state === 'succeeded', 'W1 重试后 op=succeeded')

// ── W1c 第二轮审查：reconcile 收口 CAS 失败 → state_commit_pending（不谎报 recovered/committed）──
{
  const curW1 = readFileSync(join(WS, F1), 'utf-8')
  const p = { operation_id: 'op_w1c', request_id: 'req_w1c', payload_hash: 'sha256:zzz', state: 'prepared', kind: 'patch', file: F1, read_ref: 'read_1', pre_file_hash: fileHashOf('not-the-current-content'), intended_file_hash: fileHashOf(curW1), created: 'seed' }
  const conflicted = patch.reconcileOperation(WS, 'task_w1', 99999, p, 'change')
  assert(conflicted.error === 'state_commit_pending', `W1c CAS 冲突 → state_commit_pending（得 ${JSON.stringify(conflicted.error)}）`)
}

// ── W2/W3：写已完成但终态未提交 → write_symbol already_applied 收口 ──
const F3 = 'src/w3.txt'
writeFileSync(join(WS, F3), 'one\nTWO\n') // 已呈目标态（模拟写后崩溃）
mkTask('task_w3', [material('read_1', F3, fileHashOf('one\ntwo\n'))])
const PATCH3 = { old_string: 'two', new_string: 'TWO' }
const ph3 = shared.payloadHash({ task_id: 'task_w3', file: F3, edit_mode: 'patch', patch: PATCH3, content: null, boundary: null })
shared.updateTaskCas(WS, 'task_w3', 1, (t) => {
  const p = { operation_id: 'op_w3', request_id: 'req_w3', payload_hash: ph3, state: 'prepared', kind: 'patch', file: F3, read_ref: 'read_1', base_version: { file: { hash: fileHashOf('one\ntwo\n') } }, pre_file_hash: fileHashOf('one\ntwo\n'), intended_file_hash: fileHashOf('one\nTWO\n'), created: 'seed' }
  t.operations = [p]; t.node = 'edit'
  return { type: 'operation', data: { operation: p, node: 'edit' } }
})
r = await patch.handle({ workspace_dir: WS, task_id: 'task_w3', read_ref: 'read_1', edit_mode: 'patch', patch: PATCH3, dry_run: false, request_id: 'req_w3' }, ctx)
assert(r.ok === true && r.observation?.recovered === true, 'W3 已写未提交 → intended 核对收口')
assert(r.observation?.operation?.state === 'succeeded' && readFileSync(join(WS, F3), 'utf-8') === 'one\nTWO\n', 'W3 收口且文件不再变')

// ── 无 request_id + 已呈目标态 → write_symbol already_applied 幂等 ──
const F4 = 'src/w2.txt'
writeFileSync(join(WS, F4), 'one\nTWO\n')
mkTask('task_aa', [material('read_1', F4, fileHashOf('one\nTWO\n'))])
r = await patch.handle({ workspace_dir: WS, task_id: 'task_aa', read_ref: 'read_1', edit_mode: 'patch', patch: { old_string: 'two', new_string: 'TWO' }, dry_run: false }, ctx)
assert(r.ok === true && r.observation?.operation?.already_applied === true, 'target 已存在 → already_applied')
assert(readFileSync(join(WS, F4), 'utf-8') === 'one\nTWO\n', 'already_applied 不重复写')

// ── W4：快照缺失 → 事件重建（operation 事件重放）──
rmSync(snapPath('task_p'), { force: true })
assert(!existsSync(snapPath('task_p')), 'W4 前置：快照已删')
const rebuilt = store.getTask(WS, 'task_p')
assert(rebuilt && Array.isArray(rebuilt.operations) && rebuilt.operations.length === 1, 'W4 事件重建保留 operation')
assert(rebuilt.operations[0].state === 'succeeded' && rebuilt.result_kind === 'partial', 'W4 operation 终态与 result_kind 重放')

// ── Q2：code_patch create:true —— 预览/落盘/幂等/已存在拒绝/undo token ──
{
  mkTask('task_create', [])
  const NEWF = 'src/created.txt'
  r = await patch.handle({ workspace_dir: WS, task_id: 'task_create', create: true, locator: { file_path: NEWF }, content: 'hello\nworld\n' }, ctx)
  assert(r.ok === true && r.observation?.effect === 'preview' && !existsSync(join(WS, NEWF)), `Q2 create 预览不落盘（得 ${JSON.stringify(r.error || r.observation?.summary)}）`)
  assert(/syntax unverified/.test(r.observation?.summary || ''), `Q3 预览诚实标注 syntax skip（得 ${r.observation?.summary}）`)
  assert(!r.observation?.preview_without_base && r.next_action?.tool === 'code_patch' && r.next_action?.args?.create === true && r.next_action?.args?.edit_mode === undefined, `狗粮r2: create 预览不误报缺 base，next_action → apply 且不带 edit_mode（得 ${JSON.stringify({ pwb: r.observation?.preview_without_base, next: r.next_action?.tool, create: r.next_action?.args?.create, em: r.next_action?.args?.edit_mode })}）`)
  r = await patch.handle({ workspace_dir: WS, task_id: 'task_create', create: true, locator: { file_path: NEWF }, content: 'hello\nworld\n', dry_run: false, request_id: 'req_create_1' }, ctx)
  assert(r.ok === true && r.observation?.committed === true && readFileSync(join(WS, NEWF), 'utf-8') === 'hello\nworld\n', 'Q2 create apply 落盘')
  assert(r.undo?.token && r.undo.expires_at && r.undo.via === 'edit_transaction(action=undo_commit)', 'Q2 create 返回可消费 undo（expires_at/via 就位）')
  const rdup = await patch.handle({ workspace_dir: WS, task_id: 'task_create', create: true, locator: { file_path: NEWF }, content: 'hello\nworld\n', dry_run: false, request_id: 'req_create_1' }, ctx)
  assert(rdup.ok === true && rdup.observation?.deduplicated === true, 'Q2 create 同 request_id 幂等')
  const rex = await patch.handle({ workspace_dir: WS, task_id: 'task_create', create: true, locator: { file_path: NEWF }, content: 'x\n', dry_run: false, request_id: 'req_create_2' }, ctx)
  assert(rex.error === 'FILE_EXISTS', `Q2 已存在 → FILE_EXISTS（得 ${rex.error}）`)
}

// ── WP08R-5 P5：参数形状错误消息带正确形状样板（W4-C 实拍一次改不对）──
const STR = 'src/str.txt'
writeFileSync(join(WS, STR), 'one\ntwo\n')
mkTask('task_str', [material('read_s', STR, fileHashOf('one\ntwo\n'))])
r = await patch.handle({ workspace_dir: WS, task_id: 'task_str', read_ref: 'read_s', edit_mode: 'patch', patch: 'let cap = 10' }, ctx)
assert(r.error === 'missing_parameter' && /patch must be an object/.test(r.message || ''), `patch 传字符串 → 消息含正确形状（得 ${r.message}）`)
r = await patch.handle({ workspace_dir: WS, task_id: 'task_str', edit_mode: 'patch', patch: { old_string: 'one', new_string: 'ONE' } }, ctx)
assert(r.error === 'missing_parameter' && /Apply shape/.test(r.suggestion || ''), `缺锚 → suggestion 含 Apply shape 样板（得 ${r.suggestion}）`)

// ── G2-D（ADR-019 D3）：写安全参数显式化——allow_unsafe_no_base / safety 经 code_patch 透传到 writeSymbol ──
{
  const F9 = 'src/g2d.txt'
  writeFileSync(join(WS, F9), 'one\ntwo\n')
  mkTask('task_g2d', [])
  const rNo = await patch.handle({ workspace_dir: WS, task_id: 'task_g2d', locator: { file_path: F9 }, edit_mode: 'patch', patch: { old_string: 'one', new_string: 'ONE' }, dry_run: false }, ctx)
  assert(rNo.ok !== true || rNo.observation?.committed !== true, 'G2-D 无 base 且无 flag → 不落盘（默认安全门）')
  assert(readFileSync(join(WS, F9), 'utf-8') === 'one\ntwo\n', 'G2-D 无 flag 时文件未变')
  const rForce = await patch.handle({ workspace_dir: WS, task_id: 'task_g2d', locator: { file_path: F9 }, edit_mode: 'patch', patch: { old_string: 'one', new_string: 'ONE' }, dry_run: false, allow_unsafe_no_base: true }, ctx)
  assert(rForce.ok === true && rForce.observation?.committed === true, `G2-D allow_unsafe_no_base=true → 无 base 也放行（得 ${JSON.stringify(rForce.error || rForce.observation?.summary)}）`)
  assert(readFileSync(join(WS, F9), 'utf-8') === 'ONE\ntwo\n', 'G2-D 强制写落盘')
  const rBlk = await patch.handle({ workspace_dir: WS, task_id: 'task_g2d', create: true, locator: { file_path: 'src/g2d-bad.js' }, content: 'const x = {;\n', dry_run: false }, ctx)
  assert(rBlk.ok !== true && /VALIDATION_FAILED/.test(rBlk.error || ''), `G2-D 默认拦语法硬错（得 ${rBlk.error}）`)
  const rOk2 = await patch.handle({ workspace_dir: WS, task_id: 'task_g2d', create: true, locator: { file_path: 'src/g2d-bad.js' }, content: 'const x = {;\n', dry_run: false, safety: { block_on_validation_error: false } }, ctx)
  assert(rOk2.ok === true && rOk2.observation?.committed === true, `G2-D safety.block_on_validation_error=false 透传生效（得 ${JSON.stringify(rOk2.error || rOk2.observation?.summary)}）`)
}

// ── R22 修复 #3（单品路径）：非代码（JSON）不跑括号校验——含 URL 的合法 JSON 预演不被误拒 ──
{
  const FJ = 'src/plock-like.json'
  const JC = '{"resolved":"https://u","integrity":"sha512-abc","version":"1.0.0"}\n'
  writeFileSync(join(WS, FJ), JC)
  mkTask('task_json_gate', [material('rj', FJ, fileHashOf(JC))])
  const rj = await patch.handle({ workspace_dir: WS, task_id: 'task_json_gate', read_ref: 'rj', edit_mode: 'patch', patch: { old_string: '"version":"1.0.0"', new_string: '"version":"2.0.0"' }, dry_run: true }, ctx)
  assert(rj.ok === true, 'R22 #3 单品 JSON 含 URL 预演不被误拒（得 ok=' + rj.ok + ' err=' + rj.error + '）')
}

console.log('\n=== test-s2-patch: ' + pass + ' passed, ' + fail + ' failed ===')
process.exit(fail > 0 ? 1 : 0)