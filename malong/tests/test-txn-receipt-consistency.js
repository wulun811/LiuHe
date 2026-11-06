// test-txn-receipt-consistency.js — F21/F22（2026-11-05 极限风暴）
//
// 真机实测：
//  ① commit 回执 file_hashes[].readback_verified=true，同一份 receipt.limitations 却说
//     "post-write read-back verification is not performed on this path"，自相矛盾；
//  ② edit_multi atomic=true 失败回滚后返回 ok:true（status=rolled_back / reason=atomic edit failed），
//     与 edit_transaction「失败 ok:false」的出口契约相反。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP = join(os.tmpdir(), 'opencode', 'txn-receipt-consistency-test')
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
const WS = join(TMP, 'ws')
mkdirSync(WS, { recursive: true })
process.env.MALONG_STATE_DIR = join(TMP, 'state')

let pass = 0, fail = 0
const assert = (cond, msg) => { if (cond) pass++; else { fail++; console.error('  FAIL:', msg) } }
const imp = (p) => import(pathToFileURL(p).href)
const txn = await imp(join(__dirname, '..', 'tools', 'tool-edit-transaction', 'handler.js'))
const ctx = {}

writeFileSync(join(WS, 'a.js'), 'export const a = 1\nexport const keep = 2\n')
let committedTxnId = null

// ── ① commit 回读声明必须与 readback_verified 一致 ──
{
  const b = await txn.handle({ workspace_dir: WS, action: 'begin', name: 'receipt' }, ctx)
  assert(b.ok === true && !!b.txnId, '① begin ok（得 ' + JSON.stringify(b.error || b.txnId) + '）')
  const e = await txn.handle({ workspace_dir: WS, action: 'edit', txn_id: b.txnId, file: 'a.js', edits: [{ old_string: 'export const keep = 2', new_string: 'export const keep = 3' }] }, ctx)
  assert(e.ok === true && e.edits_applied === 1, '① edit 1 条（得 ' + JSON.stringify(e.error || e.edits_applied) + '）')
  const c = await txn.handle({ workspace_dir: WS, action: 'commit', txn_id: b.txnId }, ctx)
  assert(c.ok === true && c.status === 'committed', '① commit ok（得 ' + JSON.stringify(c.error || c.status) + '）')
  committedTxnId = b.txnId
  const lim = (c.receipt?.limitations || []).join(' ')
  assert(!/not performed/.test(lim), '① limitations 不得再说未做回读（得 ' + JSON.stringify(lim) + '）')
  assert(c.receipt?.readback_verified === true, '① receipt.readback_verified=true（得 ' + JSON.stringify(c.receipt?.readback_verified) + '）')
  assert(c.file_hashes?.['a.js']?.readback_verified === true, '① 文件级 readback_verified=true（得 ' + JSON.stringify(c.file_hashes?.['a.js']) + '）')
  assert(readFileSync(join(WS, 'a.js'), 'utf-8').includes('keep = 3'), '① 文件已提交')
}

// ── ② atomic edit_multi 失败回滚：ok 必须为 false ──
{
  const b = await txn.handle({ workspace_dir: WS, action: 'begin', name: 'atomicfail' }, ctx)
  const r = await txn.handle({
    workspace_dir: WS, action: 'edit_multi', txn_id: b.txnId, atomic: true,
    file_edits: [
      { file: 'a.js', edits: [{ old_string: 'export const a = 1', new_string: 'export const a = 9' }] },
      { file: 'b.js', edits: [{ old_string: 'export const nope = 0', new_string: 'export const nope = 1' }] },
    ],
  }, ctx)
  assert(r.ok === false, '② atomic 失败必须 ok:false（得 ' + JSON.stringify(r.ok) + '）')
  assert(r.status === 'rolled_back' && r.reason === 'atomic edit failed', '② 状态仍是 rolled_back/atomic edit failed（得 ' + JSON.stringify({ status: r.status, reason: r.reason }) + '）')
  assert(readFileSync(join(WS, 'a.js'), 'utf-8').includes('export const a = 1'), '② a.js 已回滚')
  assert(!readFileSync(join(WS, 'a.js'), 'utf-8').includes('a = 9'), '② a.js 不得留下半截修改')
}

// ── ③ 已提交事务：info 与重复 commit 都必须可核对，不得报 TXN_NOT_FOUND ──
{
  const i = await txn.handle({ workspace_dir: WS, action: 'info', txn_id: committedTxnId }, ctx)
  assert(i.ok === true, '③ info 已提交事务 ok:true（得 ' + JSON.stringify({ ok: i.ok, error: i.error_code }) + '）')
  assert(i.transaction?.state === 'committed' && i.transaction?.location === 'recent', '③ info 必须标明 committed/recent（得 ' + JSON.stringify({ state: i.transaction?.state, loc: i.transaction?.location }) + '）')
  const again = await txn.handle({ workspace_dir: WS, action: 'commit', txn_id: committedTxnId }, ctx)
  assert(again.ok === true && again.status === 'committed', '③ 重复 commit 必须幂等成功（得 ' + JSON.stringify({ ok: again.ok, error: again.error_code, status: again.status }) + '）')
  assert(again.already_committed === true && again.files_changed === 1, '③ 重复 commit 标明 already_committed 且 files_changed=1（得 ' + JSON.stringify({ already: again.already_committed, changed: again.files_changed }) + '）')
  assert(readFileSync(join(WS, 'a.js'), 'utf-8').includes('keep = 3'), '③ 重复 commit 不得二次改写')
}

try { rmSync(TMP, { recursive: true, force: true }) } catch {}
console.log('== test-txn-receipt-consistency: ' + pass + ' passed, ' + fail + ' failed ==')
process.exit(fail > 0 ? 1 : 0)
