#!/usr/bin/env node
// test-wp04-receipts.js — WP04 Receipt 与 Trust Lite 贯通写路（批 A：统一 receipt serializer）
// 两层：格式合同测试（serializeReceipt/opGuarantee 纯函数）+ 实际文件回归
// （code_patch / code_batch / code_maintain apply 响应挂 observation.receipt）。
// 合同：effect 与 state_commit 分离（AC15）、三类操作保证边界、hash 三元组如实
// （result=intended，回读未做在 limitations 声明）、files 截断显示、classic 字段保留。
import { join, dirname, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP = join(os.tmpdir(), 'opencode', 'wp04-receipts')
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
const WS = join(TMP, 'ws')
mkdirSync(join(WS, 'src'), { recursive: true })
process.env.MALONG_STATE_DIR = join(TMP, 'state')
process.env.MALONG_ENTRY_STATE = '1'

let pass = 0, fail = 0
function assert(cond, msg) { if (cond) { pass++; console.log(`  ✓ ${msg}`) } else { fail++; console.log(`  ✗ ${msg}`) } }

const shared = await import(pathToFileURL(join(__dirname, '..', 'tools', 'entry-shared.js')).href)
const receipt = await import(pathToFileURL(join(__dirname, '..', 'workflow', 'receipt.js')).href)
const patch = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-code-patch', 'handler.js')).href)
const batch = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-code-batch', 'handler.js')).href)
const maintain = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-code-maintain', 'handler.js')).href)
const maintainLib = await import(pathToFileURL(join(__dirname, '..', 'workflow', 'maintain.js')).href)
const ctx = { codeIndexService: null, langParserService: null }
const H = (s) => `sha256:${shared.sha256Hex(s)}`

const A = 'src/a.js', B = 'src/b.js', PY = 'src/p.py'
writeFileSync(join(WS, A), 'alpha\nbeta\ngamma\n')
writeFileSync(join(WS, B), 'one\ntwo\n')
writeFileSync(join(WS, PY), 'x = 1\ny = 2\n')
const material = (ref, file, content) => ({ read_ref: ref, locator: { file_path: file }, canonical_path: file, file_version: { hash: H(content) }, symbol_version: null })
function mkTask(id, route, materials, operations = []) {
  const t = { task_id: id, revision: 1, route, lifecycle: 'active', node: 'read', materials, operations, workspace_dir: WS }
  shared.putTask(WS, t, { type: 'task_created', task: t })
  return t
}

console.log('== 格式合同：serializeReceipt / opGuarantee ==')
{
  const r1 = receipt.serializeReceipt({ kind: 'patch', operation_id: 'op1', files: [{ file: 'f.js' }], committed: true })
  assert(r1.state_commit === 'committed' && r1.effect === 'workspace_write' && r1.result_kind === 'partial', 'committed=true → state_commit=committed（AC15 applied/状态提交分离）')
  const r2 = receipt.serializeReceipt({ kind: 'patch', operation_id: 'op2', files: [{ file: 'f.js' }], committed: false })
  assert(r2.state_commit === 'pending', 'committed=false → state_commit=pending（不把 partial 写 success）')
  assert(r2.receipt_version === receipt.RECEIPT_VERSION && typeof receipt.RECEIPT_VERSION === 'number', 'receipt_version 显式')
  const f = r1.files[0]
  assert(f.hashes && 'pre' in f.hashes && 'intended' in f.hashes && 'result' in f.hashes, 'hash 三元组 pre/intended/result 固定形状')
  assert(r1.limitations.some(l => l.includes('read-back')), '回读声明在 limitations（不冒充已验证）')
  assert(r2.limitations.some(l => l.includes('not performed on this path')), '默认（未回读路径）声明如实')
  const r4 = receipt.serializeReceipt({ kind: 'patch', files: [{ file: 'f.js' }], committed: true, readback: 'enforced' })
  assert(r4.limitations.some(l => l.includes('READBACK_MISMATCH')), 'readback enforced 声明与实际一致（批 C 后写路径已强制回读）')
  const many = Array.from({ length: 55 }, (_, i) => ({ file: `f${i}.js` }))
  const r3 = receipt.serializeReceipt({ kind: 'batch', files: many, committed: true })
  assert(r3.files.length === 50 && r3.files_omitted === 5, 'files 截断显示（50 + files_omitted）')
  assert(r1.index_sync.state === 'unknown', 'index_sync 缺省 unknown 如实')
  const g1 = receipt.opGuarantee('patch', true)
  const g2 = receipt.opGuarantee('delete')
  const g3 = receipt.opGuarantee('patch', false)
  assert(g1.op_class === 'create' && g2.op_class === 'unsupported' && g3.op_class === 'modify', '三类操作保证边界：create/unsupported/modify')
}

console.log('== 实际文件回归：code_patch apply 挂 receipt ==')
{
  mkTask('task_p', 'change', [material('ra', A, 'alpha\nbeta\ngamma\n')])
  const r = await patch.handle({
    workspace_dir: WS, task_id: 'task_p', read_ref: 'ra', request_id: 'wp4p',
    edit_mode: 'patch', patch: { old_string: 'beta', new_string: 'BETA' }, dry_run: false,
  }, ctx)
  const rc = r.observation?.receipt
  assert(r.ok === true && rc && rc.receipt_version === 1 && rc.kind === 'patch', 'patch apply 响应挂统一 receipt')
  assert(rc.state_commit === 'committed' && rc.op_class === 'modify' && rc.request_id === 'wp4p', 'state_commit/op_class/request_id 如实')
  assert(rc.files.length === 1 && rc.files[0].file === A && rc.files[0].status === 'written', 'file/status 记录')
  assert(rc.files[0].hashes.intended && rc.files[0].hashes.result === rc.files[0].hashes.intended, 'intended/result hash 记录（声明未回读）')
  assert(rc.limitations.some(l => l.includes('enforced') && l.includes('READBACK_MISMATCH')), 'patch receipt 声明回读已强制（与现实一致）')
  assert(r.next_action?.tool === 'code_check' && r.observation.target && r.observation.diff !== undefined, 'classic 字段保留（target/diff/next_action 不变）')
}

console.log('== 实际文件回归：code_batch apply 挂 receipt ==')
{
  mkTask('task_b', 'change', [material('rb', B, 'one\ntwo\n'), material('ra2', A, readFileSync(join(WS, A), 'utf-8'))])
  const r = await batch.handle({
    workspace_dir: WS, task_id: 'task_b', dry_run: false, request_id: 'wp4b',
    writes: [
      { read_ref: 'rb', edit_mode: 'patch', patch: { old_string: 'two', new_string: 'TWO' } },
      { read_ref: 'ra2', edit_mode: 'patch', patch: { old_string: 'gamma', new_string: 'GAMMA' } },
    ],
  }, ctx)
  const rc = r.observation?.receipt
  assert(r.ok === true && rc && rc.kind === 'batch' && rc.state_commit === 'committed', 'batch apply 响应挂统一 receipt')
  assert(rc.files.length === 2 && rc.files.every(f => f.hashes.result), 'batch receipt 逐文件 hash 三元组')
  assert(rc.index_sync !== undefined, 'index_sync 字段在（state 如实）')
  assert(r.observation.effect === 'workspace_write' && r.observation.files?.length === 2, 'classic 字段保留（effect/files 不变）')
}

console.log('== 实际文件回归：code_maintain apply 挂 receipt ==')
{
  let ANALYZE_MAP = {
    [PY]: { file: PY, issues: [{ type: 'undefined_symbol' }], transaction_ready: [{ file: PY, old_string: 'x = 1\n', new_string: 'import os\nx = 1\n' }] },
  }
  const analyzeStub = async ({ file }) => ANALYZE_MAP[file] || { file, issues: [] }
  const mctx = { ...ctx, maintainAnalyze: analyzeStub }
  mkTask('task_m', 'maintain', [material('rpy', PY, 'x = 1\ny = 2\n')])
  const r = await maintain.handle({ workspace_dir: WS, task_id: 'task_m', action: 'apply', dry_run: false, request_id: 'wp4m' }, mctx)
  const rc = r.observation?.receipt
  assert(r.ok === true && rc && rc.kind === 'maintain' && rc.state_commit === 'committed', 'maintain apply 响应挂统一 receipt')
  assert(rc.files.length === 1 && rc.files[0].file === PY && rc.files[0].hashes.result, 'maintain receipt 文件与 hash')
  assert(readFileSync(join(WS, PY), 'utf-8') === 'import os\nx = 1\ny = 2\n', '文件真实变更')
  assert(r.observation.evidence?.kind === 'maintain:import_fix', 'classic 字段保留（evidence 不变）')
}

console.log('== 实际文件回归：edit_transaction commit/undo 挂 receipt（批 B）==')
{
  const etx = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-edit-transaction', 'handler.js')).href)
  const TXF = 'src/tx.js'
  writeFileSync(join(WS, TXF), 'one\n')
  const b = await etx.handle({ workspace_dir: WS, action: 'begin', name: 'wp4t' }, ctx)
  const txnId = b.txnId || b.txn_id
  assert(typeof txnId === 'string', 'begin 返回 txn_id')
  await etx.handle({ workspace_dir: WS, action: 'edit', txn_id: txnId, file: TXF, edits: [{ old_string: 'one', new_string: 'ONE' }] }, ctx)
  assert(readFileSync(join(WS, TXF), 'utf-8') === 'ONE\n', 'staged 编辑已写盘')
  const c = await etx.handle({ workspace_dir: WS, action: 'commit', txn_id: txnId }, ctx)
  assert(c.status === 'committed' && c.receipt?.kind === 'txn_commit' && c.receipt.state_commit === 'committed', 'commit 响应挂统一 receipt')
  assert(c.receipt.recovery?.available === true && c.receipt.recovery.checked === 'backup_dir_present', 'recovery 查实（recent backup 目录存在）')
  const u = await etx.handle({ workspace_dir: WS, action: 'undo_commit', txn_id: txnId }, ctx)
  assert((u.status === 'undone' || u.status === 'undone_partial') && u.receipt?.kind === 'txn_undo', 'undo 响应挂统一 receipt')
  assert(readFileSync(join(WS, TXF), 'utf-8') === 'one\n', 'undo 真实还原')
  assert(typeof u.receipt.recovery?.available === 'boolean' && u.receipt.recovery.checked === 'txn_dir_present', 'undo recovery 按目录查实（不冒充）')
  assert(u.receipt.index_sync?.state === 'not_reported', 'P6-a 无 codeIndex 服务 → index_sync=not_reported（不再用 unknown 冒充）')

  // P6-b：有 codeIndex 服务时，undo 回执 index_sync=synced 且真的补抽过
  let indexedUndo = 0
  const ctxIdx = { ...ctx, codeIndexService: { indexFile: async () => { indexedUndo++; return { symbols: 1 } } } }
  const TX2 = 'src/tx2.js'
  writeFileSync(join(WS, TX2), 'aaa\n')
  const b2 = await etx.handle({ workspace_dir: WS, action: 'begin', name: 'wp4t2' }, ctxIdx)
  const t2 = b2.txnId || b2.txn_id
  await etx.handle({ workspace_dir: WS, action: 'edit', txn_id: t2, file: TX2, edits: [{ old_string: 'aaa', new_string: 'AAA' }] }, ctxIdx)
  await etx.handle({ workspace_dir: WS, action: 'commit', txn_id: t2 }, ctxIdx)
  const u2 = await etx.handle({ workspace_dir: WS, action: 'undo_commit', txn_id: t2 }, ctxIdx)
  assert(u2.receipt.index_sync?.state === 'synced' && indexedUndo >= 1, 'P6-b 有 codeIndex 服务 → undo 回执 synced（实际补抽过）')
}

console.log('== P3（0.5.17 狗粮）：写后自动续基（wbase_*）==')
{
  const C = 'src/rw.js'
  writeFileSync(join(WS, C), 'one\ntwo\n')
  mkTask('task_p3', 'change', [material('rp3', C, 'one\ntwo\n')])
  const r1 = await patch.handle({
    workspace_dir: WS, task_id: 'task_p3', read_ref: 'rp3',
    edit_mode: 'patch', patch: { old_string: 'one', new_string: 'ONE' }, dry_run: false,
  }, ctx)
  const wb = r1.observation?.write_read_refs || {}
  assert(wb && typeof wb[C] === 'string' && wb[C].startsWith('wbase_'), 'P3-a code_patch apply 后返回 write_read_refs（wbase_*）')

  const r2 = await patch.handle({
    workspace_dir: WS, task_id: 'task_p3', read_ref: wb[C],
    edit_mode: 'patch', patch: { old_string: 'two', new_string: 'TWO' }, dry_run: false,
  }, ctx)
  assert(r2.ok === true && readFileSync(join(WS, C), 'utf-8') === 'ONE\nTWO\n', 'P3-b 不重读，直接用 wbase 二次编辑成功')

  // 外部改动后，旧 wbase 不得放行（安全不降）
  writeFileSync(join(WS, C), 'EXTERNAL\n')
  const r3 = await patch.handle({
    workspace_dir: WS, task_id: 'task_p3', read_ref: wb[C],
    edit_mode: 'patch', patch: { old_string: 'EXTERNAL', new_string: 'X' }, dry_run: false,
  }, ctx)
  assert(r3.ok === false && /VERSION_CONFLICT|FILE_CHANGED/.test(JSON.stringify(r3)), 'P3-c 两次写之间外部改动 → wbase base 仍报冲突')

  // code_batch 同样续基
  const B3 = 'src/rw2.js'
  writeFileSync(join(WS, B3), 'alpha\nbeta\n')
  mkTask('task_p3b', 'change', [material('rb3', B3, 'alpha\nbeta\n')])
  const b1 = await batch.handle({
    workspace_dir: WS, task_id: 'task_p3b', dry_run: false,
    writes: [{ read_ref: 'rb3', patch: { old_string: 'alpha', new_string: 'ALPHA' } }],
  }, ctx)
  const bwb = b1.observation?.write_read_refs || {}
  assert(bwb && bwb[B3]?.startsWith('wbase_'), 'P3-d code_batch apply 后返回 write_read_refs')
  const b2 = await batch.handle({
    workspace_dir: WS, task_id: 'task_p3b', dry_run: false,
    writes: [{ read_ref: bwb[B3], patch: { old_string: 'beta', new_string: 'BETA' } }],
  }, ctx)
  assert(b2.ok === true && readFileSync(join(WS, B3), 'utf-8') === 'ALPHA\nBETA\n', 'P3-e 不重读，用 wbase 批量二次编辑成功')

  // P3-f/g：同 request_id 重放带回首次登记的 wbase（不新建基准、不推 revision）
  const DED = 'src/rw3.js'
  writeFileSync(join(WS, DED), 'zero\n')
  mkTask('task_p3d', 'change', [material('rd3', DED, 'zero\n')])
  const argsD = {
    workspace_dir: WS, task_id: 'task_p3d', read_ref: 'rd3', request_id: 'p3dedup1',
    edit_mode: 'patch', patch: { old_string: 'zero', new_string: 'ZERO' }, dry_run: false,
  }
  const d1 = await patch.handle(argsD, ctx)
  const d2 = await patch.handle(argsD, ctx)
  const dr1 = d1.observation?.write_read_refs?.[DED]
  const dr2 = d2.observation?.write_read_refs?.[DED]
  assert(d2.observation?.deduplicated === true && !!dr2 && dr2 === dr1, 'P3-f 同 request_id 重放带回同一 wbase（不新建基准）')
  assert(d2.task?.revision === d1.task?.revision, 'P3-g 重放不推 revision')
}

console.log('== P2（0.5.18）：undo 新建文件 → 删除同步，回执与实际索引一致 ==')
{
  const etx = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-edit-transaction', 'handler.js')).href)
  const relOf = (abs) => relative(WS, abs).split(/[\\/]/).join('/')
  const idx = new Set()
  const svc = {
    initWorkspace: async () => {},
    getSymbolByStableId: () => null,
    findSymbolsInFile: () => [],
    getFileMtime: () => 0,
    clearCachesForFile: () => {},
    markIndexDirty: () => {},
    async indexFile(abs) { idx.add(relOf(abs)); return { symbols: 1 } },
    async removeFile(abs) { idx.delete(relOf(abs)); return { removed: true } },
  }
  const ctxSync = { ...ctx, codeIndexService: svc }
  mkTask('task_p2c', 'change', [])
  const NEWF = 'src/ghost-new.js'
  const b = await batch.handle({
    workspace_dir: WS, task_id: 'task_p2c', dry_run: false,
    writes: [{ create: true, locator: { file_path: NEWF }, content: 'export function GhostReceipt() { return 1 }\n' }],
  }, ctxSync)
  assert(b.ok === true && existsSync(join(WS, NEWF)), 'P2-a create 落盘')
  assert(idx.has(NEWF), 'P2-b create 写后索引登记')
  const u = await etx.handle({ workspace_dir: WS, action: 'undo_commit', txn_id: b.undo?.txn_id }, ctxSync)
  assert(u.status === 'undone' && !existsSync(join(WS, NEWF)), 'P2-c undo 删除物理文件')
  assert(!idx.has(NEWF), 'P2-d undo 后索引已删除（旧实现保留 → 本断言红）')
  assert(u.receipt.index_sync?.state === 'synced', 'P2-e 删除同步成功后才报 synced')

  // 删除同步失败 → partial + pending，不能绿灯
  const failing = { ...svc, async removeFile() { throw new Error('delete boom') } }
  const ctxFail = { ...ctx, codeIndexService: failing }
  mkTask('task_p2f', 'change', [])
  const NEWF2 = 'src/ghost-fail.js'
  const b2 = await batch.handle({
    workspace_dir: WS, task_id: 'task_p2f', dry_run: false,
    writes: [{ create: true, locator: { file_path: NEWF2 }, content: 'export const X = 1\n' }],
  }, ctxFail)
  const u2 = await etx.handle({ workspace_dir: WS, action: 'undo_commit', txn_id: b2.undo?.txn_id }, ctxFail)
  assert(u2.receipt.index_sync?.state === 'partial' && (u2.receipt.index_sync.pending || []).includes(NEWF2), 'P2-f 删除同步失败 → partial/pending（不谎报 synced）')

  // P2-g：混合批量——恢复已有文件 + 删除新建文件，两路都要同步
  const KEEP = 'src/mix-keep.js'
  writeFileSync(join(WS, KEEP), 'keep\n')
  mkTask('task_p2m', 'change', [material('rmix', KEEP, 'keep\n')])
  const MIXNEW = 'src/mix-new.js'
  const bm = await batch.handle({
    workspace_dir: WS, task_id: 'task_p2m', dry_run: false,
    writes: [
      { read_ref: 'rmix', patch: { old_string: 'keep', new_string: 'KEEP' } },
      { create: true, locator: { file_path: MIXNEW }, content: 'export const MixNew = 1\n' },
    ],
  }, ctxSync)
  assert(bm.ok === true && idx.has(MIXNEW) && idx.has(KEEP), 'P2-g 混合批量写入（已有+新建）')
  const um = await etx.handle({ workspace_dir: WS, action: 'undo_commit', txn_id: bm.undo?.txn_id }, ctxSync)
  assert(um.status === 'undone' && readFileSync(join(WS, KEEP), 'utf-8') === 'keep\n' && !existsSync(join(WS, MIXNEW)), 'P2-h 混合 undo：已有恢复 + 新建删除')
  assert(idx.has(KEEP) && !idx.has(MIXNEW), 'P2-i 混合 undo 索引：恢复的保留、新建的删除')
  assert(um.receipt.index_sync?.state === 'synced', 'P2-j 混合两路都完成才报 synced')

  // P2-k/l：重复 undo → 明确 already_undone/错误，且不重复执行、不破坏状态与索引
  const ur = await etx.handle({ workspace_dir: WS, action: 'undo_commit', txn_id: bm.undo?.txn_id }, ctxSync)
  assert(ur.status === 'already_undone' || !!ur.error_code, 'P2-k 重复 undo 明确 already_undone/错误（得 ' + String(ur.status || ur.error_code || ur.error) + '）')
  assert(!existsSync(join(WS, MIXNEW)) && readFileSync(join(WS, KEEP), 'utf-8') === 'keep\n' && idx.has(KEEP) && !idx.has(MIXNEW), 'P2-l 重复 undo 不破坏文件/索引状态')
}

console.log('== 写后回读实测：mismatch → indeterminate + 同 request_id 恢复（批 C）==')
{
  process.env.MALONG_TEST_READBACK_MISMATCH = '1'
  mkTask('task_rb', 'change', [material('rrb', A, readFileSync(join(WS, A), 'utf-8'))])
  const bad = await patch.handle({
    workspace_dir: WS, task_id: 'task_rb', read_ref: 'rrb', request_id: 'rbrb',
    edit_mode: 'patch', patch: { old_string: 'BETA', new_string: 'BETA2' }, dry_run: false,
  }, ctx)
  assert(bad.ok === false && bad.code === 'READBACK_MISMATCH', '回读不一致 → READBACK_MISMATCH（不冒充成功）')
  assert(readFileSync(join(WS, A), 'utf-8').includes('BETA2'), '文件已写的事实不隐瞒')
  const op = shared.getTask(WS, 'task_rb').operations.find(o => o.request_id === 'rbrb')
  assert(op?.state === 'indeterminate', `op 状态 indeterminate 非伪 failed（得 ${op?.state}）`)
  delete process.env.MALONG_TEST_READBACK_MISMATCH
  const rec = await patch.handle({
    workspace_dir: WS, task_id: 'task_rb', read_ref: 'rrb', request_id: 'rbrb',
    edit_mode: 'patch', patch: { old_string: 'BETA', new_string: 'BETA2' }, dry_run: false,
  }, ctx)
  assert(rec.ok === true, '同 request_id 重试 → 按 intended hash reconcile 恢复终态')
}

console.log('== assemble 分块落盘挂 receipt（批 B 补全）==')
{
  const etx2 = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-edit-transaction', 'handler.js')).href)
  const AF = 'src/asm.js'
  writeFileSync(join(WS, AF), 'l1\nl2\nl3\n')
  const shared2 = shared
  const b2 = await etx2.handle({ workspace_dir: WS, action: 'begin', name: 'wp4a' }, ctx)
  const tid2 = b2.txnId || b2.txn_id
  await etx2.handle({ workspace_dir: WS, action: 'edit_chunk', txn_id: tid2, file: AF, seq: 1, total: 2, lines: ['L1', 'L2'] }, ctx)
  await etx2.handle({ workspace_dir: WS, action: 'edit_chunk', txn_id: tid2, file: AF, seq: 2, total: 2, lines: ['L3'] }, ctx)
  const expectSha = 'sha256:' + shared2.sha256Hex('l1\nl2\nl3\n')
  const asm = await etx2.handle({ workspace_dir: WS, action: 'assemble', txn_id: tid2, file: AF, expect_sha: expectSha }, ctx)
  assert(asm.status === 'staged' && asm.new_hash && asm.receipt?.kind === 'txn_assemble', 'assemble 响应挂 receipt + 实测 new_hash 透出')
  assert(asm.receipt.files[0].hashes.result === asm.new_hash, 'receipt result hash = 写入内容实测 hash')
  assert(asm.receipt.recovery?.available === true, 'recovery 查实（backup 目录存在）')
  assert(readFileSync(join(WS, AF), 'utf-8') === 'L1\nL2\nL3', 'assemble 真实落盘（chunk join 无尾随换行）')
}

console.log(`\n=== test-wp04-receipts: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
