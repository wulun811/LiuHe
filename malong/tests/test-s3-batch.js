// test-s3-batch.js — S3.1 多文件批写（code_batch）失败/恢复路径
// 覆盖：默认预览不落盘、跨文件 apply、输入乱序仍确定性、request_id 去重、异载荷拒绝、
//       all_or_nothing 失败回滚、best_effort 部分成功、W3 崩溃核对（全 intended）、
//       写前态可重放、混合/外部态 indeterminate、鉴权/参数/revision 错误。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP = join(os.tmpdir(), 'opencode', 's3-batch-test')
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
const WS = join(TMP, 'ws')
mkdirSync(join(WS, 'src'), { recursive: true })
process.env.MALONG_STATE_DIR = join(TMP, 'state')
process.env.MALONG_ENTRY_STATE = '1'

let pass = 0, fail = 0
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  FAIL:', msg) } }

const shared = await import(pathToFileURL(join(__dirname, '..', 'tools', 'entry-shared.js')).href)
const batch = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-code-batch', 'handler.js')).href)
const { TransactionStore } = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-edit-transaction', 'transaction-store.js')).href)
const ctx = { codeIndexService: null, langParserService: null }
const H = (s) => `sha256:${shared.sha256Hex(s)}`
const read = (f) => readFileSync(join(WS, f), 'utf-8')
const material = (ref, file, content) => ({ read_ref: ref, locator: { file_path: file }, canonical_path: file, file_version: { hash: H(content) }, symbol_version: null })
const patchW = (ref, o, n) => ({ read_ref: ref, edit_mode: 'patch', patch: { old_string: o, new_string: n } })

function mkTask(id, materials, operations = []) {
  const t = { task_id: id, revision: 1, route: 'change', lifecycle: 'active', node: 'read', materials, operations, workspace_dir: WS }
  shared.putTask(WS, t, { type: 'task_created', task: t })
  return t
}
// 构造 prepared 批操作（模拟写入未提交崩溃）；与 handler 的载荷哈希形状一致
function mkPreparedOp(task_id, request_id, baseHash, filesPre, filesIntended, file, oldS, newS) {
  return {
    operation_id: 'op_seed', request_id, kind: 'batch', state: 'prepared',
    files: [file], mode: 'all_or_nothing',
    pre_hashes: filesPre, intended_hashes: filesIntended,
    payload_hash: shared.payloadHash({ task_id, writes: [{ file, edit_mode: 'patch', patch: { old_string: oldS, new_string: newS }, content: null, boundary: null, base: baseHash }] }),
    created: new Date().toISOString(),
  }
}

// ── 1. 预览（缺省 dry_run）不落盘 ──
const A = 'src/a.txt', B = 'src/b.txt', C = 'src/c.txt', D = 'src/d.txt', E = 'src/e.txt', F = 'src/f.txt', G = 'src/g.txt'
writeFileSync(join(WS, A), 'alpha\nbeta\ngamma\n')
writeFileSync(join(WS, B), 'one\ntwo\n')
writeFileSync(join(WS, C), 'x\ny\n')
writeFileSync(join(WS, D), 'p\nq\n')
writeFileSync(join(WS, E), 'm\nn\n')
writeFileSync(join(WS, F), 'g\nh\n')
writeFileSync(join(WS, G), 'r\ns\n')
mkTask('task_pv', [material('ra', A, 'alpha\nbeta\ngamma\n'), material('rb', B, 'one\ntwo\n')])
let r = await batch.handle({ workspace_dir: WS, task_id: 'task_pv', writes: [patchW('ra', 'beta', 'BETA'), patchW('rb', 'two', 'TWO')] }, ctx)
assert(r.ok === true && r.observation?.effect === 'preview' && r.observation?.dry_run === true, '缺省 dry_run → 预览')
assert(r.observation?.files?.length === 2 && r.observation?.intended_files && Object.keys(r.observation.intended_files).length === 2, '预览列出 2 文件 + intended 哈希')
assert(read(A) === 'alpha\nbeta\ngamma\n' && read(B) === 'one\ntwo\n', '预览不落盘')

// ── 2. 跨文件 apply（输入乱序，锁按路径排序，结果确定）+ revision 1→3 ──
r = await batch.handle({ workspace_dir: WS, task_id: 'task_pv', dry_run: false, request_id: 'rq1', writes: [patchW('rb', 'two', 'TWO'), patchW('ra', 'beta', 'BETA')] }, ctx)
assert(r.ok === true && r.observation?.committed === true && r.observation?.files?.length === 2, '跨文件 apply 落盘')
assert(read(A) === 'alpha\nBETA\ngamma\n' && read(B) === 'one\nTWO\n', '两文件均已改（乱序输入）')
assert(r.task.revision === 3, `revision 1→3（prepared+succeeded，得 ${r.task?.revision}）`)
assert(r.observation?.operation?.state === 'succeeded' && r.observation.operation.kind === 'batch', 'operation 记 batch succeeded')

// ── 2c. WP08R-4（c1b 实拍）：顶层 read_ref 继承同文件 base（模型把 code_patch 习惯带进 code_batch）──
const Hh = 'src/h.txt', Ii = 'src/i.txt'
writeFileSync(join(WS, Hh), 'h1\nh2\n')
mkTask('task_topref', [material('rh', Hh, 'h1\nh2\n')])
let rt = await batch.handle({ workspace_dir: WS, task_id: 'task_topref', dry_run: false, read_ref: 'rh', writes: [{ locator: { file_path: Hh }, edit_mode: 'patch', patch: { old_string: 'h1', new_string: 'H1' } }] }, ctx)
assert(rt.ok === true && read(Hh) === 'H1\nh2\n', `顶层 read_ref 同文件继承 base 并落盘（得 ok=${rt.ok} err=${rt.error}/${rt.conflict_type}）`)
writeFileSync(join(WS, Ii), 'i1\n')
mkTask('task_topref2', [material('ri', Ii, 'i1\n')])
const rt2 = await batch.handle({ workspace_dir: WS, task_id: 'task_topref2', dry_run: false, read_ref: 'ri', writes: [{ locator: { file_path: Hh }, edit_mode: 'patch', patch: { old_string: 'H1', new_string: 'H1x' } }] }, ctx)
assert(rt2.error === 'VERSION_CONFLICT' && rt2.conflict_type === 'NO_BASE', `顶层 read_ref 不同文件不继承（得 ${rt2.error}/${rt2.conflict_type}）`)
const rt3 = await batch.handle({ workspace_dir: WS, task_id: 'task_topref2', dry_run: false, read_ref: 'nope', writes: [{ locator: { file_path: Ii }, edit_mode: 'patch', patch: { old_string: 'i1', new_string: 'I1' } }] }, ctx)
assert(rt3.error === 'read_ref_not_found', `顶层未知 read_ref → read_ref_not_found（得 ${rt3.error}）`)

// ── WP08R-5 P5：形状错误带样板 ──
const rt4 = await batch.handle({ workspace_dir: WS, task_id: 'task_pv', writes: [{ edit_mode: 'patch', patch: { old_string: 'x', new_string: 'X' } }] }, ctx)
assert(rt4.error === 'missing_parameter' && /Item shape/.test(rt4.suggestion || ''), `write 项缺锚 → suggestion 含 Item shape 样板（得 ${rt4.suggestion}）`)
const rt5 = await batch.handle({ workspace_dir: WS, task_id: 'task_topref2', dry_run: false, writes: [{ read_ref: 'ri', edit_mode: 'patch', patch: 'nope' }] }, ctx)
assert(rt5.error === 'missing_parameter' && /each write item needs patch/.test(rt5.message || ''), `write 项 patch 传字符串 → 消息含形状（得 ${rt5.message}）`)

// ── 3. 去重：同 request_id 同载荷 → 幂等 ──
const r2 = await batch.handle({ workspace_dir: WS, task_id: 'task_pv', dry_run: false, request_id: 'rq1', writes: [patchW('rb', 'two', 'TWO'), patchW('ra', 'beta', 'BETA')] }, ctx)
assert(r2.ok === true && r2.observation?.deduplicated === true, '同 id 同载荷 → dedup')

// ── 4. 同 request_id 异载荷 → 拒绝 ──
const r3 = await batch.handle({ workspace_dir: WS, task_id: 'task_pv', dry_run: false, request_id: 'rq1', writes: [patchW('ra', 'alpha', 'ALPHA')] }, ctx)
assert(r3.error === 'request_conflict', `同 id 异载荷 → request_conflict（得 ${r3.error}）`)

// ── 5. all_or_nothing 失败回滚：D 的 base 陈旧 → C 已写后回滚 ──
mkTask('task_roll', [material('rc', C, 'x\ny\n'), material('rd', D, 'STALE_BASE')])
r = await batch.handle({ workspace_dir: WS, task_id: 'task_roll', dry_run: false, request_id: 'rq_roll', writes: [patchW('rc', 'x', 'X'), patchW('rd', 'p', 'P')] }, ctx)
assert(r.error === 'VERSION_CONFLICT' && r.file === D, `批失败于 D（得 ${r.error}/${r.file}）`)
assert(read(C) === 'x\ny\n', 'all_or_nothing 回滚了已写文件 C')

// ── 5b. item_index 必须是「输入下标」而非路径排序后的组内下标（live 狗粮发现）──
// 输入序 [A(valid), D(stale)]，路径序同：D 是输入第 2 条（index=1），旧实现报组内 idx=0 → 误导
mkTask('task_idx', [material('ra2', A, read(A)), material('rd2', D, 'STALE_BASE')])
r = await batch.handle({ workspace_dir: WS, task_id: 'task_idx', dry_run: false, request_id: 'rq_idx', writes: [patchW('ra2', 'BETA', 'beta'), patchW('rd2', 'p', 'P')] }, ctx)
assert(r.error === 'VERSION_CONFLICT' && r.file === D, `item_index 用例失败于 D（得 ${r.error}/${r.file}）`)
assert(r.item_index === 1, `item_index=输入下标 1（旧实现为组内 idx=0；得 ${r.item_index}）`)

// ── 5c. WP08R-2 G2：批错误 next_action 可执行化（args+全参）+ NO_BASE 文案 ──
mkTask('task_nb', [])
r = await batch.handle({ workspace_dir: WS, task_id: 'task_nb', dry_run: false, request_id: 'rq_nb', writes: [{ edit_mode: 'patch', locator: { file_path: C }, patch: { old_string: 'x', new_string: 'X' } }] }, ctx)
assert(r.error === 'VERSION_CONFLICT' && r.conflict_type === 'NO_BASE', `批无 base → NO_BASE（得 ${r.error}/${r.conflict_type}）`)
assert(/symbol read does not establish a file base/.test(r.message || ''), `批 NO_BASE 文案点明 symbol 读不建立 file base（得 ${r.message}）`)
assert(r.next_action?.args && !('params' in r.next_action) && r.next_action.args.workspace_dir === WS && r.next_action.args.task_id === 'task_nb' && r.next_action.args.locator?.file_path === C, `批错误 next_action 全参可执行（得 ${JSON.stringify(r.next_action)}）`)

// ── 5c2. WP08R-3 A2：预览免 base（无 read_ref 也 OK，先看再读）+ apply 仍 NO_BASE（5c 已证）──
mkTask('task_nb2', [])
r = await batch.handle({ workspace_dir: WS, task_id: 'task_nb2', writes: [{ edit_mode: 'patch', locator: { file_path: C }, patch: { old_string: 'x', new_string: 'X' } }] }, ctx)
assert(r.ok === true && r.observation?.dry_run === true && r.observation?.preview_without_base === true, `无 base 批预览 → OK + preview_without_base（得 ${JSON.stringify(r.observation || r.error)}）`)
assert(r.next_action?.tool === 'code_read' && r.next_action?.args?.locator?.file_path === C, `无 base 批预览 next_action → code_read（得 ${JSON.stringify(r.next_action)}）`)
assert(read(C) === 'x\ny\n', '无 base 批预览不落盘')

// ── 5d. WP08R-2 G4：预览回显策略——小载荷回显 writes；>2KB 改「复用」指示 ──
const ECHO = 'src/echo.txt'
writeFileSync(join(WS, ECHO), 'e1\ne2\n')
mkTask('task_echo', [material('re1', ECHO, 'e1\ne2\n')])
r = await batch.handle({ workspace_dir: WS, task_id: 'task_echo', request_id: 'rq_echo_small', writes: [patchW('re1', 'e1', 'E1')] }, ctx)
assert(r.ok === true && r.observation?.dry_run === true, `小载荷预览 OK（得 ${r.error || 'ok'}）`)
assert(Array.isArray(r.next_action?.args?.writes) && r.next_action.args.writes.length === 1 && r.next_action.args.dry_run === false, `小载荷回显 writes（得 ${JSON.stringify(r.next_action?.args)}）`)
mkTask('task_echo_big', [material('re2', ECHO, 'e1\ne2\n')])
r = await batch.handle({ workspace_dir: WS, task_id: 'task_echo_big', request_id: 'rq_echo_big', writes: [patchW('re2', 'e1', 'X'.repeat(3000))] }, ctx)
assert(r.ok === true && r.observation?.dry_run === true, `大载荷预览 OK（得 ${r.error || r.message || 'ok'}）`)
assert(r.next_action?.args && r.next_action.args.writes === undefined && r.next_action.args.dry_run === false, `大载荷不回显 writes（得 ${JSON.stringify(r.next_action?.args)}）`)
assert(/too large to echo/.test(r.next_action?.note || ''), `大载荷 note 指示复用（得 ${r.next_action?.note}）`)

// ── 6. best_effort 部分成功：C 写、D 失败，整体 success + partial_failures ──
mkTask('task_be', [material('rc', C, 'x\ny\n'), material('rd', D, 'STALE_BASE')])
// ── 6-pre. live 审查：best_effort dry-run 预览必须可预览（部分失败不该报 ALL_FILES_FAILED）──
r = await batch.handle({ workspace_dir: WS, task_id: 'task_be', request_id: 'rq_be_prev', policy: { all_or_nothing: false }, writes: [patchW('rc', 'x', 'X'), patchW('rd', 'p', 'P')] }, ctx)
assert(r.ok === true && r.observation?.dry_run === true && r.error === undefined, `best_effort 预览不报 ALL_FILES_FAILED（得 ok=${r.ok} error=${JSON.stringify(r.error)}）`)
assert(Array.isArray(r.observation?.partial_failures) && r.observation.partial_failures.length === 1, '预览报告部分失败清单')
r = await batch.handle({ workspace_dir: WS, task_id: 'task_be', dry_run: false, request_id: 'rq_be', policy: { all_or_nothing: false }, writes: [patchW('rc', 'x', 'X'), patchW('rd', 'p', 'P')] }, ctx)
assert(r.ok === true && r.observation?.committed === true && read(C) === 'X\ny\n', 'best_effort 写了 C')
assert(Array.isArray(r.observation?.partial_failures) && r.observation.partial_failures.length === 1, 'best_effort 记录 D 失败')
assert(r.observation?.partial_failures?.[0]?.item_index === 1, `partial_failures 带输入下标（得 ${r.observation?.partial_failures?.[0]?.item_index}）`)

// ── 6-pre2. 第二轮审查：dry-run 全失败仍为预览成功、error 不出现 ALL_FILES_FAILED ──
mkTask('task_be2', [material('rd3', D, 'WRONG_BASE_1'), material('rg3', G, 'WRONG_BASE_2')])
r = await batch.handle({ workspace_dir: WS, task_id: 'task_be2', request_id: 'rq_be2p', policy: { all_or_nothing: false }, writes: [patchW('rd3', 'p', 'P'), patchW('rg3', 'r', 'R')] }, ctx)
assert(r.ok === true && r.observation?.dry_run === true && r.error === undefined, `dry-run 全失败不报 ALL_FILES_FAILED（得 error=${JSON.stringify(r.error)}）`)
assert((r.observation?.partial_failures || []).length === 2, 'dry-run 全失败列出 2 条 partial_failures')
// ── 6-pre3. 第二轮审查：真实 best_effort 全失败 → 必须失败并归因 ──
r = await batch.handle({ workspace_dir: WS, task_id: 'task_be2', dry_run: false, request_id: 'rq_be2r', policy: { all_or_nothing: false }, writes: [patchW('rd3', 'p', 'P'), patchW('rg3', 'r', 'R')] }, ctx)
assert(r.ok === false, `真实 best_effort 全失败 → ok=false（得 ok=${r.ok}）`)
assert(r.error != null, `真实全失败必须带错误归因（得 ${JSON.stringify(r.error)}）`)

// ── 6-pre4. 第二轮审查：reconcileBatch 收口 CAS 失败 → state_commit_pending（不谎报 committed）──
{
  const rbOp = { operation_id: 'op_rb', request_id: 'rq_rb', kind: 'batch', state: 'prepared', files: [D, G], pre_hashes: { [D]: H('x'), [G]: H('y') }, intended_hashes: { [D]: H(read(D)), [G]: H(read(G)) }, created: 'seed' }
  const conflicted = batch.reconcileBatch(WS, 'task_be2', 99999, rbOp, 'change')
  assert(conflicted.error === 'state_commit_pending', `reconcileBatch CAS 冲突 → state_commit_pending（得 ${JSON.stringify(conflicted.error)}）`)
}

// ── 7. W3 崩溃核对：写已完成但终态未提交 → 全 intended 收口，不重写 ──
const ePre = H('m\nn\n'), eInt = H('m\nN\n')
writeFileSync(join(WS, E), 'm\nN\n') // 模拟“已写”
mkTask('task_w3', [material('re', E, 'm\nn\n')], [mkPreparedOp('task_w3', 'rq_w3', H('m\nn\n'), { [E]: ePre }, { [E]: eInt }, E, 'n', 'N')])
r = await batch.handle({ workspace_dir: WS, task_id: 'task_w3', dry_run: false, request_id: 'rq_w3', writes: [patchW('re', 'n', 'N')] }, ctx)
assert(r.ok === true && r.observation?.recovered === true, 'W3 全 intended → 恢复收口')
assert(read(E) === 'm\nN\n', 'W3 恢复不重复写')

// ── 8. 混合/外部态 → indeterminate（既非全 pre 也非全 intended）──
const fPre = H('g\nh\n'), fInt = H('g\nH\n')
writeFileSync(join(WS, F), 'g\nX\n') // 外部改成第三种态
mkTask('task_ind', [material('rf', F, 'g\nh\n')], [mkPreparedOp('task_ind', 'rq_ind', H('g\nh\n'), { [F]: fPre }, { [F]: fInt }, F, 'h', 'H')])
r = await batch.handle({ workspace_dir: WS, task_id: 'task_ind', dry_run: false, request_id: 'rq_ind', writes: [patchW('rf', 'h', 'H')] }, ctx)
assert(r.error === 'indeterminate', `混合态 → indeterminate（得 ${r.error}）`)
assert(read(F) === 'g\nX\n', 'indeterminate 不覆盖外部改动')

// ── 9. 写前态可重放：prepared 但文件仍为写前 → 重试并成功 ──
mkTask('task_re', [material('rg', G, 'r\ns\n')], [mkPreparedOp('task_re', 'rq_re', H('r\ns\n'), { [G]: H('r\ns\n') }, { [G]: H('r\nS\n') }, G, 's', 'S')])
r = await batch.handle({ workspace_dir: WS, task_id: 'task_re', dry_run: false, request_id: 'rq_re', writes: [patchW('rg', 's', 'S')] }, ctx)
assert(r.ok === true && r.observation?.committed === true && read(G) === 'r\nS\n', '写前态 → 安全重放成功')

// ── 10. 参数/鉴权/revision 错误 ──
assert((await batch.handle({ workspace_dir: WS, task_id: 'task_pv', writes: [] }, ctx)).error === 'missing_parameter', '空 writes → missing_parameter')
assert((await batch.handle({ workspace_dir: WS, task_id: 'task_pv', writes: [patchW('nope', 'a', 'b')] }, ctx)).error === 'read_ref_not_found', '未知 read_ref')
assert((await batch.handle({ workspace_dir: WS, task_id: 'task_pv', writes: [{ read_ref: 'ra', edit_mode: 'bogus' }] }, ctx)).error === 'invalid_input', '非法 edit_mode')
assert((await batch.handle({ workspace_dir: WS, task_id: 'ghost', writes: [patchW('ra', 'a', 'b')] }, ctx)).error === 'task_not_found', '未知 task')
assert((await batch.handle({ workspace_dir: join(TMP, 'other'), task_id: 'task_pv', writes: [patchW('ra', 'a', 'b')] }, ctx)).error === 'invalid_input', 'workspace 不存在')
assert((await batch.handle({ workspace_dir: WS, task_id: 'task_pv', expected_state_revision: 99, writes: [patchW('ra', 'a', 'b')] }, ctx)).error === 'revision_conflict', 'revision 冲突')

// ── 11. live 审查：非代码文件写后重抽异常不逃逸（提交后不误报 failed，锁/标记不泄漏）──
const ctxThrow = {
  codeIndexService: {
    getFileByPath: () => ({ path: G }),
    updateContentHash: () => { throw new Error('index boom') },
    markIndexDirty: () => {},
  },
  langParserService: null,
}
mkTask('task_nc', [material('rg2', G, read(G))])
r = await batch.handle({ workspace_dir: WS, task_id: 'task_nc', dry_run: false, request_id: 'rq_nc', writes: [patchW('rg2', 'S', 'SS')] }, ctxThrow)
assert(r.ok === true && r.observation?.committed === true, `非代码重抽异常不逃逸（得 ok=${r.ok} err=${JSON.stringify(r.error)}）`)
assert(r.observation?.reindex?.[G]?.status === 'failed', `reindex 记录 failed（得 ${JSON.stringify(r.observation?.reindex)}）`)
assert(!existsSync(join(WS, '.malong', 'batches', '.batch-lock')), '批次锁已释放（无残留）')

// ── 12. 16-B（专家复验 §5）：批量 undo 范围——任一成员 token 恢复整批；外部改动整批阻断不部分恢复 ──
const H1 = 'src/h1.txt', H2 = 'src/h2.txt'
writeFileSync(join(WS, H1), 'h1v1\n'); writeFileSync(join(WS, H2), 'h2v1\n')
mkTask('task_undo', [material('rh1', H1, 'h1v1\n'), material('rh2', H2, 'h2v1\n')])
const ru = await batch.handle({ workspace_dir: WS, task_id: 'task_undo', dry_run: false, request_id: 'rq_undo', writes: [patchW('rh1', 'h1v1', 'h1v2'), patchW('rh2', 'h2v1', 'h2v2')] }, ctx)
assert(ru.ok === true && ru.undo?.txn_id, `16-B 批量写返回 undo token（得 ok=${ru.ok}）`)
assert(ru.undo.scope === 'batch' && typeof ru.undo.batch_id === 'string', `16-B undo 声明 batch 范围（得 ${JSON.stringify({ scope: ru.undo.scope, batch_id: ru.undo.batch_id })}）`)
const store = new TransactionStore(WS, { sweep: false })
const u1 = await store.undoCommit(ru.undo.txn_id)
assert(u1.status === 'undone' && u1.files_restored === 2 && u1.batch?.total === 2, `16-B 一次 token 恢复整批（得 ${JSON.stringify(u1)}）`)
assert(read(H1) === 'h1v1\n' && read(H2) === 'h2v1\n', '16-B 两文件均回写写前')
const u2 = await store.undoCommit(ru.undo.txn_id)
assert(u2.status === 'already_undone' && u2.files_restored === 0, `16-B 再撤销幂等（得 ${JSON.stringify(u2)}）`)
const rb = await batch.handle({ workspace_dir: WS, task_id: 'task_undo', dry_run: false, request_id: 'rq_undo2', writes: [patchW('rh1', 'h1v1', 'h1v3'), patchW('rh2', 'h2v1', 'h2v3')] }, ctx)
assert(rb.ok === true && rb.undo?.txn_id, `16-B 二批写成功（得 ok=${rb.ok}）`)
writeFileSync(join(WS, H2), 'h2-external\n')
const ub = await store.undoCommit(rb.undo.txn_id)
assert(ub.error_code === 'undo_conflict' && Array.isArray(ub.batch?.blocked) && ub.batch.blocked.length === 1 && ub.batch.blocked[0].code === 'EXTERNAL_CHANGE', `16-B 外部改动整批阻断并归因（得 ${JSON.stringify(ub)}）`)
assert(read(H1) === 'h1v3\n', '16-B 可恢复成员未被部分恢复')

// ── 13. 16-D（Windows 复验 not_run 收口）：批次标记降级（非 BATCH_LOCK_BUSY 异常）→
// scope=per_file + entries 逐文件 token；每个 entry 单独撤销只恢复自己的文件 ──
const WS2 = join(TMP, 'ws-degraded')
mkdirSync(join(WS2, '.malong'), { recursive: true })
writeFileSync(join(WS2, '.malong', 'batches'), 'occupied-by-file')  // 占位文件：createBatchMarker mkdirSync 失败（非批次锁忙）
writeFileSync(join(WS2, 'd1.txt'), 'd1v1\n'); writeFileSync(join(WS2, 'd2.txt'), 'd2v1\n')
const t2 = { task_id: 'task_degraded', revision: 1, route: 'change', lifecycle: 'active', node: 'read', materials: [material('rd1', 'd1.txt', 'd1v1\n'), material('rd2', 'd2.txt', 'd2v1\n')], operations: [], workspace_dir: WS2 }
shared.putTask(WS2, t2, { type: 'task_created', task: t2 })
const rdeg = await batch.handle({ workspace_dir: WS2, task_id: 'task_degraded', dry_run: false, request_id: 'rq_deg', writes: [patchW('rd1', 'd1v1', 'd1v2'), patchW('rd2', 'd2v1', 'd2v2')] }, ctx)
assert(rdeg.ok === true && rdeg.observation?.committed === true && readFileSync(join(WS2, 'd1.txt'), 'utf-8') === 'd1v2\n', `16-D 降级批仍成功（得 ok=${rdeg.ok} err=${JSON.stringify(rdeg.error)}）`)
assert(rdeg.undo?.scope === 'per_file' && Array.isArray(rdeg.undo.entries) && rdeg.undo.entries.length === 2 && !rdeg.undo.batch_id, `16-D 降级信封 scope=per_file + entries 逐文件 token（得 ${JSON.stringify({ scope: rdeg.undo?.scope, n: rdeg.undo?.entries?.length, batch_id: rdeg.undo?.batch_id })}）`)
const store2 = new TransactionStore(WS2, { sweep: false })
const d1 = await store2.undoCommit(rdeg.undo.entries[0].txn_id)
assert(d1.status === 'undone' && d1.files_restored === 1, `16-D entry1 单独撤销恢复 1 文件（得 ${JSON.stringify(d1)}）`)
const d2 = await store2.undoCommit(rdeg.undo.entries[1].txn_id)
assert(d2.status === 'undone' && d2.files_restored === 1, `16-D entry2 单独撤销恢复 1 文件（得 ${JSON.stringify(d2)}）`)
assert(readFileSync(join(WS2, 'd1.txt'), 'utf-8') === 'd1v1\n' && readFileSync(join(WS2, 'd2.txt'), 'utf-8') === 'd2v1\n', '16-D 两文件均经逐文件 token 恢复')

// ── G2-D（ADR-019 D3）：code_batch 顶层 allow_unsafe_no_base 透传（无 base 批次显式放行）──
const WS3 = join(TMP, 'ws-g2d')
mkdirSync(WS3, { recursive: true })
writeFileSync(join(WS3, 'g1.txt'), 'a1\nb1\n')
writeFileSync(join(WS3, 'g2.txt'), 'c1\nd1\n')
const t3 = { task_id: 'task_g2d_b', revision: 1, route: 'change', lifecycle: 'active', node: 'read', materials: [], operations: [], workspace_dir: WS3 }
shared.putTask(WS3, t3, { type: 'task_created', task: t3 })
const rNoBase = await batch.handle({ workspace_dir: WS3, task_id: 'task_g2d_b', dry_run: false, writes: [{ locator: { file_path: 'g1.txt' }, edit_mode: 'patch', patch: { old_string: 'a1', new_string: 'A1' } }] }, ctx)
assert(rNoBase.ok !== true || rNoBase.observation?.committed !== true, 'G2-D 批无 base 且无 flag → 不落盘')
assert(readFileSync(join(WS3, 'g1.txt'), 'utf-8') === 'a1\nb1\n', 'G2-D 批无 flag 文件未变')
const rForceB = await batch.handle({ workspace_dir: WS3, task_id: 'task_g2d_b', dry_run: false, allow_unsafe_no_base: true, writes: [{ locator: { file_path: 'g1.txt' }, edit_mode: 'patch', patch: { old_string: 'a1', new_string: 'A1' } }, { locator: { file_path: 'g2.txt' }, edit_mode: 'patch', patch: { old_string: 'c1', new_string: 'C1' } }] }, ctx)
assert(rForceB.ok === true && rForceB.observation?.committed === true, `G2-D 批 allow_unsafe_no_base → 无 base 放行（得 ${JSON.stringify(rForceB.error || rForceB.observation?.summary)}）`)
assert(readFileSync(join(WS3, 'g1.txt'), 'utf-8') === 'A1\nb1\n' && readFileSync(join(WS3, 'g2.txt'), 'utf-8') === 'C1\nd1\n', 'G2-D 批强制写落盘（两文件）')

// ── R22 失败路径（真阳性修复 #1，2026-10-12）：批内校验失败必须返回 VALIDATION_FAILED，不得 INTERNAL ──
// 背景：writeSymbols 全组验证段的 buildValidationFailure 引用循环外变量 w → ReferenceError('w is not defined')
// 仅在「校验失败且安全策略拦写」分支触发（平时不可见）；本测试先红后绿锁定。
const V1 = 'src/val1.js', V2 = 'src/val2.js'
writeFileSync(join(WS, V1), 'const v1 = 1\n')
writeFileSync(join(WS, V2), 'const v2a = 1\nconst v2b = 2\n')
mkTask('task_valfail1', [material('rv1', V1, 'const v1 = 1\n')])
r = await batch.handle({ workspace_dir: WS, task_id: 'task_valfail1', writes: [patchW('rv1', 'const v1 = 1', 'const v1 = {')] }, ctx)
assert(r.ok === false && r.error === 'VALIDATION_FAILED', '校验失败单条 → VALIDATION_FAILED（得 ok=' + r.ok + ' error=' + r.error + ' msg=' + String(r.message || '').slice(0, 60) + '）')
assert(read(V1) === 'const v1 = 1\n', '校验失败不落盘')
mkTask('task_valfail2', [material('rv2', V2, 'const v2a = 1\nconst v2b = 2\n')])
r = await batch.handle({ workspace_dir: WS, task_id: 'task_valfail2', writes: [patchW('rv2', 'const v2a = 1', 'const v2a = {'), patchW('rv2', 'const v2b = 2', 'const v2b = 3')] }, ctx)
assert(r.ok === false && r.error === 'VALIDATION_FAILED', '校验失败多条同文件 → VALIDATION_FAILED（得 ok=' + r.ok + ' error=' + r.error + '）')
// 0.5.29：batch 的 mapBatchError 同样丢弃过 validation（与 code_patch 同根）——
// 修复前这里只有一句泛化文本，无法定位是哪个文件、哪一行错
assert(r.validation != null, 'B1 batch 校验失败带 validation 详情（得 ' + JSON.stringify(r.validation) + '）')
assert(r.validation?.syntax?.status === 'fail' || r.validation?.bracket?.status === 'fail', 'B2 validation 如实报告判据为 fail（得 ' + JSON.stringify(r.validation) + '）')
assert(read(V2) === 'const v2a = 1\nconst v2b = 2\n', '校验失败多条不落盘')

// R22 修复 #3：非代码（JSON）不跑括号校验——含 URL 的合法 JSON 可正常预演（旧实现误报 unclosed 拦写）
const J1 = 'src/pkgs.json'
const J1C = '{"resolved":"https://u","integrity":"sha512-abc","version":"1.0.0"}\n'
writeFileSync(join(WS, J1), J1C)
mkTask('task_valjson', [material('rj', J1, J1C)])
r = await batch.handle({ workspace_dir: WS, task_id: 'task_valjson', writes: [patchW('rj', '"version":"1.0.0"', '"version":"2.0.0"')] }, ctx)
assert(r.ok === true && r.observation && r.observation.effect === 'preview', '含 URL 的合法 JSON 批预演成功（得 ok=' + r.ok + ' err=' + r.error + ' msg=' + String(r.message || '').slice(0, 70) + '）')

console.log('\n=== test-s3-batch: ' + pass + ' passed, ' + fail + ' failed ===')
process.exit(fail > 0 ? 1 : 0)