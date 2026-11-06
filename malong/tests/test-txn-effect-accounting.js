// test-txn-effect-accounting.js — 2026-11-05 发布前真机走查
//
// 真机实测（/tmp/opencode/dogfood-061）：
//   rollback 全跳过（external_change）返回 files_restored=0，但 receipt.effect 仍是
//   workspace_write、state_commit 仍是 committed——回执声称写了，实际一个文件都没恢复。
//   同一类问题也在 undo_commit 的全跳过路径（partial 仍是 committed）。
//
// 判据：
//   effect 只描述真实发生的恢复写入：restored>0 → workspace_write，否则 none；
//   state_commit 只描述操作是否终态：rollback/undo 完整 → committed，partial/可重试 → pending。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP = join(os.tmpdir(), 'opencode', 'txn-effect-accounting-test')
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
const WS = join(TMP, 'ws')
mkdirSync(WS, { recursive: true })
process.env.MALONG_STATE_DIR = join(TMP, 'state')

let pass = 0, fail = 0
const assert = (cond, msg) => { if (cond) pass++; else { fail++; console.error('  FAIL:', msg) } }
const imp = (p) => import(pathToFileURL(p).href)
const txn = await imp(join(__dirname, '..', 'tools', 'tool-edit-transaction', 'handler.js'))
const ctx = {}

const write = (f, s) => writeFileSync(join(WS, f), s)
const read = (f) => readFileSync(join(WS, f), 'utf-8')
const begin = async (name) => {
  const r = await txn.handle({ workspace_dir: WS, action: 'begin', name }, ctx)
  assert(r.ok === true, `begin ${name}（得 ${JSON.stringify(r.error || r.txnId)}）`)
  return r.txnId
}
const edit = async (txn_id, file, old_string, new_string) => {
  const r = await txn.handle({ workspace_dir: WS, action: 'edit', txn_id, file, edits: [{ old_string, new_string }] }, ctx)
  assert(r.ok === true, `edit ${file}（得 ${JSON.stringify(r.error || r.status)}）`)
  return r
}
const commit = async (txn_id) => txn.handle({ workspace_dir: WS, action: 'commit', txn_id }, ctx)
const rollback = async (txn_id) => txn.handle({ workspace_dir: WS, action: 'rollback', txn_id }, ctx)
const undo = async (txn_id) => txn.handle({ workspace_dir: WS, action: 'undo_commit', txn_id }, ctx)

// ── ① rollback 全跳过：0 个恢复 → effect=none / state_commit=pending ──
{
  write('a.js', 'a-original\n')
  const id = await begin('rb-all-skipped')
  await edit(id, 'a.js', 'a-original\n', 'a-staged\n')
  write('a.js', 'a-external\n')
  const r = await rollback(id)
  assert(r.status === 'rolled_back_partial' && r.files_restored === 0, `① 全跳过 files_restored=0（得 ${JSON.stringify({ s: r.status, n: r.files_restored })}）`)
  assert(r.receipt?.effect === 'none', `① effect=none（得 ${JSON.stringify(r.receipt?.effect)}）`)
  assert(r.receipt?.state_commit === 'pending', `① state_commit=pending（得 ${JSON.stringify(r.receipt?.state_commit)}）`)
  assert(r.receipt?.files?.[0]?.status === 'skipped:external_change', `① 逐文件标 skipped（得 ${JSON.stringify(r.receipt?.files)}）`)
}

// ── ② rollback 恢复 1 / 跳过 1：effect=workspace_write，但仍未终态 → pending ──
{
  write('b1.js', 'b1-original\n')
  write('b2.js', 'b2-original\n')
  const id = await begin('rb-partial-one')
  await edit(id, 'b1.js', 'b1-original\n', 'b1-staged\n')
  await edit(id, 'b2.js', 'b2-original\n', 'b2-staged\n')
  write('b2.js', 'b2-external\n')
  const r = await rollback(id)
  assert(r.status === 'rolled_back_partial' && r.files_restored === 1, `② 部分恢复 files_restored=1（得 ${JSON.stringify({ s: r.status, n: r.files_restored })}）`)
  assert(r.receipt?.effect === 'workspace_write', `② 有恢复 → effect=workspace_write（得 ${JSON.stringify(r.receipt?.effect)}）`)
  assert(r.receipt?.state_commit === 'pending', `② 未终态 → state_commit=pending（得 ${JSON.stringify(r.receipt?.state_commit)}）`)
  assert(r.receipt?.files?.find(f => f.file === 'b1.js')?.status === 'restored', `② b1 逐文件标 restored（得 ${JSON.stringify(r.receipt?.files)}）`)
  assert(r.receipt?.files?.find(f => f.file === 'b2.js')?.status === 'skipped:external_change', `② b2 逐文件标 skipped（得 ${JSON.stringify(r.receipt?.files)}）`)
  assert(read('b1.js') === 'b1-original\n', '② b1 已恢复')
  assert(read('b2.js') === 'b2-external\n', '② b2 保持外部内容')
}

// ── ③ rollback 完整：1 个恢复 → workspace_write / committed ──
{
  write('c.js', 'c-original\n')
  const id = await begin('rb-full')
  await edit(id, 'c.js', 'c-original\n', 'c-staged\n')
  const r = await rollback(id)
  assert(r.status === 'rolled_back' && r.files_restored === 1, `③ 完整回滚（得 ${JSON.stringify({ s: r.status, n: r.files_restored })}）`)
  assert(r.receipt?.effect === 'workspace_write', `③ effect=workspace_write（得 ${JSON.stringify(r.receipt?.effect)}）`)
  assert(r.receipt?.state_commit === 'committed', `③ state_commit=committed（得 ${JSON.stringify(r.receipt?.state_commit)}）`)
  assert(r.receipt?.files?.find(f => f.file === 'c.js')?.status === 'restored', `③ 完整回滚列出 c.js restored（得 ${JSON.stringify(r.receipt?.files)}）`)
}

// ── ④ 空事务 rollback：0 个恢复，但操作完整 → effect=none / committed ──
{
  const id = await begin('rb-empty')
  const r = await rollback(id)
  assert(r.status === 'rolled_back' && r.files_restored === 0, `④ 空事务回滚（得 ${JSON.stringify({ s: r.status, n: r.files_restored })}）`)
  assert(r.receipt?.effect === 'none', `④ effect=none（得 ${JSON.stringify(r.receipt?.effect)}）`)
  assert(r.receipt?.state_commit === 'committed', `④ state_commit=committed（得 ${JSON.stringify(r.receipt?.state_commit)}）`)
}

// ── ⑤ undo 全跳过：0 个恢复 → effect=none / pending ──
{
  write('d.js', 'd-original\n')
  const id = await begin('undo-all-skipped')
  await edit(id, 'd.js', 'd-original\n', 'd-staged\n')
  await commit(id)
  write('d.js', 'd-external\n')
  const u = await undo(id)
  assert(u.status === 'undone_partial' && u.files_restored === 0, `⑤ undo 全跳过（得 ${JSON.stringify({ s: u.status, n: u.files_restored })}）`)
  assert(u.receipt?.effect === 'none', `⑤ effect=none（得 ${JSON.stringify(u.receipt?.effect)}）`)
  assert(u.receipt?.state_commit === 'pending', `⑤ state_commit=pending（得 ${JSON.stringify(u.receipt?.state_commit)}）`)
  assert(u.receipt?.files?.find(f => f.file === 'd.js')?.status === 'skipped:external_change', `⑤ undo 全跳过列出 d.js skipped（得 ${JSON.stringify(u.receipt?.files)}）`)
}

// ── ⑥ undo 完整：1 个恢复 → workspace_write / committed ──
{
  write('e.js', 'e-original\n')
  const id = await begin('undo-full')
  await edit(id, 'e.js', 'e-original\n', 'e-staged\n')
  await commit(id)
  const u = await undo(id)
  assert(u.status === 'undone' && u.files_restored === 1, `⑥ undo 完整（得 ${JSON.stringify({ s: u.status, n: u.files_restored })}）`)
  assert(u.receipt?.effect === 'workspace_write', `⑥ effect=workspace_write（得 ${JSON.stringify(u.receipt?.effect)}）`)
  assert(u.receipt?.state_commit === 'committed', `⑥ state_commit=committed（得 ${JSON.stringify(u.receipt?.state_commit)}）`)
  assert(u.receipt?.files?.find(f => f.file === 'e.js')?.status === 'restored', `⑥ undo 完整列出 e.js restored（得 ${JSON.stringify(u.receipt?.files)}）`)
}

try { rmSync(TMP, { recursive: true, force: true }) } catch {}
console.log('== test-txn-effect-accounting: ' + pass + ' passed, ' + fail + ' failed ==')
process.exit(fail > 0 ? 1 : 0)
