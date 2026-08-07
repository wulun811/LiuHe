// test-crash-injection.js — r10(C)：崩溃时序注入——journal 恢复路径的真实落盘时序验证
// 覆盖：孤儿事务清理（state 缺失）、半写 state 保守保留、真实 SIGKILL 后 created/staged 恢复、
//       strict/best_effort 批次部分提交恢复、恢复可重入、fsync 写路径接口
import { join, dirname } from 'node:path'
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WS = join(os.tmpdir(), 'opencode', 'crash-injection-ws')
const TMP = join(os.tmpdir(), 'opencode', 'crash-injection-tmp')
const MOD = pathToFileURL(join(__dirname, '..', 'write-journal.js')).href

rmSync(WS, { recursive: true, force: true })
rmSync(TMP, { recursive: true, force: true })
mkdirSync(WS, { recursive: true })
mkdirSync(TMP, { recursive: true })

const { createJournal, updateJournalState, createBatchMarker, recoverJournals, pruneJournals, releaseBatchLock, JOURNAL_ROOT } = await import(MOD)
const { atomicWrite } = await import(pathToFileURL(join(__dirname, '..', 'path-guard.js')).href)
const { sha256 } = await import(pathToFileURL(join(__dirname, '..', 'hash-utils.js')).href)

let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++; console.log(`  ok: ${msg}`) } else { fail++; console.log(`  FAIL: ${msg}`) }
}
function jroot(ws = WS) { return join(ws, JOURNAL_ROOT, 'journal') }
function auditLog(ws) {
  try { return readFileSync(join(ws, JOURNAL_ROOT, 'audit.log'), 'utf-8') } catch { return '' }
}

// ── ① 孤儿目录三种形态：state.json 缺失（createJournal 中途崩溃）→ 清理 ──
console.log('\n── ① orphan removal (state missing = createJournal never completed) ──')
{
  const ws = join(TMP, 'orphan1')
  mkdirSync(join(ws, JOURNAL_ROOT, 'journal', 'txn_a', 'backup'), { recursive: true })
  writeFileSync(join(ws, JOURNAL_ROOT, 'journal', 'txn_a', 'manifest.json'), JSON.stringify({ txn_id: 'txn_a', file: 'a.js' }))
  writeFileSync(join(ws, JOURNAL_ROOT, 'journal', 'txn_a', 'backup', 'a.js'), 'let a = 1;')
  writeFileSync(join(ws, 'a.js'), 'let a = 1;')
  mkdirSync(join(ws, JOURNAL_ROOT, 'journal', 'txn_b', 'backup'), { recursive: true })
  writeFileSync(join(ws, JOURNAL_ROOT, 'journal', 'txn_b', 'backup', 'b.js'), 'let b = 1;')
  mkdirSync(join(ws, JOURNAL_ROOT, 'journal', 'txn_c'), { recursive: true })
  const r = await recoverJournals(ws)
  const orphaned = r.filter(x => x.action === 'orphan_removed').map(x => x.txn_id)
  assert(orphaned.includes('txn_a') && orphaned.includes('txn_b') && orphaned.includes('txn_c'),
    `orphan_removed txn_a/b/c（得 ${JSON.stringify(orphaned)}）`)
  assert(readdirSync(jroot(ws)).length === 0, 'journal 目录清空（无残留）')
  assert(auditLog(ws).includes('orphan_txn_removed') && auditLog(ws).includes('txn_a'), '审计记录 orphan_txn_removed')
}

// ── ② 半写 state（老版本直写残留坏 JSON）→ 保守保留 + 审计 ──
console.log('\n── ② unparseable state → kept for manual review ──')
{
  const ws = join(TMP, 'halfwrite')
  const dir = join(ws, JOURNAL_ROOT, 'journal', 'txn_hw')
  mkdirSync(join(dir, 'backup'), { recursive: true })
  writeFileSync(join(dir, 'state.json'), '{"txn_id":"txn_hw","state":"sta')  // 半截
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ txn_id: 'txn_hw', file: 'h.js' }))
  const r = await recoverJournals(ws)
  const kept = r.filter(x => x.action === 'unparseable_state_kept')
  assert(kept.length === 1 && existsSync(dir), `半写 state 保留不删（得 ${kept.length}）`)
  assert(auditLog(ws).includes('unparseable_txn_state'), '审计记录 unparseable_txn_state')
}

// ── ③ 孤儿复核不过（目标文件已被改 ≠ backup）→ 保守保留 ──
console.log('\n── ③ orphan with modified target → kept ──')
{
  const ws = join(TMP, 'orphan-modified')
  const dir = join(ws, JOURNAL_ROOT, 'journal', 'txn_om')
  mkdirSync(join(dir, 'backup'), { recursive: true })
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ txn_id: 'txn_om', file: 'm.js' }))
  writeFileSync(join(dir, 'backup', 'm.js'), 'let m = 1;')
  writeFileSync(join(ws, 'm.js'), 'let m = 1;\n// someone edited after crash\n')
  const r = await recoverJournals(ws)
  assert(existsSync(dir), '目标文件与 backup 不一致 → 目录保留')
  assert(!r.some(x => x.txn_id === 'txn_om' && x.action === 'orphan_removed'), '未误删（无 orphan_removed）')
}

// ── ④ 真实 SIGKILL：createJournal 后自杀 → recover → rolled_back，文件原内容保留 ──
console.log('\n── ④ real SIGKILL after createJournal ──')
{
  const ws = join(TMP, 'kill-create')
  const child = `const { join } = require('path')
const { mkdirSync, writeFileSync } = require('fs')
const M = require(process.env.MOD).default || require(process.env.MOD)
const ws = process.env.WS
mkdirSync(ws, { recursive: true })
const f = join(ws, 't.js')
writeFileSync(f, 'let a = 1;')
M.createJournal(ws, 't.js', f, 'let a = 1;', { editMode: 'patch' })
process.kill(process.pid, 'SIGKILL')`
  const res = spawnSync(process.execPath, ['-e', child], {
    env: { ...process.env, MOD: join(__dirname, '..', 'write-journal.js'), WS: ws },
  })
  assert(res.signal === 'SIGKILL', '子进程确被 SIGKILL 杀死')
  const r = await recoverJournals(ws)
  assert(r.some(x => x.action === 'rolled_back'), `created 残留 → rolled_back（得 ${JSON.stringify(r.map(x => x.action))}）`)
  assert(readFileSync(join(ws, 't.js'), 'utf-8') === 'let a = 1;', '目标文件未被修改')
}

// ── ⑤ 真实 SIGKILL：staged（文件已改）后自杀 → recover → committed 保留新内容 ──
console.log('\n── ⑤ real SIGKILL after staged ──')
{
  const ws = join(TMP, 'kill-staged')
  const newContent = 'let a = 1; let b = 2;'
  const newHash = sha256(Buffer.from(newContent))
  const child = `const { join } = require('path')
const { mkdirSync, writeFileSync } = require('fs')
const M = require(process.env.MOD)
const ws = process.env.WS
mkdirSync(ws, { recursive: true })
const f = join(ws, 't.js')
writeFileSync(f, 'let a = 1;')
const j = M.createJournal(ws, 't.js', f, 'let a = 1;', { editMode: 'patch' })
M.updateJournalState(j.dir, { state: 'staged', new_hash: process.env.NEW_HASH })
writeFileSync(f, process.env.NEW_CONTENT)
process.kill(process.pid, 'SIGKILL')`
  const res = spawnSync(process.execPath, ['-e', child], {
    env: { ...process.env, MOD: join(__dirname, '..', 'write-journal.js'), WS: ws, NEW_HASH: newHash, NEW_CONTENT: newContent },
  })
  assert(res.signal === 'SIGKILL', '子进程确被 SIGKILL 杀死')
  const r = await recoverJournals(ws)
  assert(r.some(x => x.action === 'committed'), `staged+已改名 → committed（得 ${JSON.stringify(r.map(x => x.action))}）`)
  assert(readFileSync(join(ws, 't.js'), 'utf-8') === newContent, '新内容保留（不误回滚）')
}

// ── ⑥ strict 批次部分提交 → 已提交文件回滚 + marker 删除 ──
console.log('\n── ⑥ batch strict partial commit → rollback committed ──')
{
  const ws = join(TMP, 'batch-strict')
  mkdirSync(ws, { recursive: true })
  writeFileSync(join(ws, 'f1.js'), 'let f1 = 1;')
  writeFileSync(join(ws, 'f2.js'), 'let f2 = 1;')
  const j1 = createJournal(ws, 'f1.js', join(ws, 'f1.js'), 'let f1 = 1;', { editMode: 'patch' })
  const j2 = createJournal(ws, 'f2.js', join(ws, 'f2.js'), 'let f2 = 1;', { editMode: 'patch' })
  const new1 = 'let f1 = 1; let f1b = 2;'
  updateJournalState(j1.dir, { state: 'staged', new_hash: sha256(Buffer.from(new1)) })
  writeFileSync(join(ws, 'f1.js'), new1)
  updateJournalState(j1.dir, { state: 'committed' })
  const { batchId } = createBatchMarker(ws, ['f1.js', 'f2.js'], 'strict')
  updateJournalState(j2.dir, { state: 'staged', new_hash: sha256(Buffer.from('let f2 = 1;')) })
  const markerPath = join(ws, JOURNAL_ROOT, 'batches', `${batchId}.json`)
  const marker = JSON.parse(readFileSync(markerPath, 'utf-8'))
  marker.txnIds = [j1.txnId, j2.txnId]
  atomicWrite(markerPath, JSON.stringify(marker, null, 2), { fsync: true })
  releaseBatchLock(ws)
  const r = await recoverJournals(ws)
  assert(r.some(x => x.action === 'batch_partial_rollback'), `strict 部分提交 → batch_partial_rollback（得 ${JSON.stringify(r.map(x => x.action))}）`)
  assert(readFileSync(join(ws, 'f1.js'), 'utf-8') === 'let f1 = 1;', '已提交的 f1.js 回滚到 backup 内容')
  assert(!existsSync(markerPath), '批次 marker 删除')
}

// ── ⑦ best_effort 批次部分提交 → 已提交保留（用户可见成功结果不回滚）──
console.log('\n── ⑦ batch best_effort partial → kept ──')
{
  const ws = join(TMP, 'batch-best')
  mkdirSync(ws, { recursive: true })
  writeFileSync(join(ws, 'f1.js'), 'let f1 = 1;')
  writeFileSync(join(ws, 'f2.js'), 'let f2 = 1;')
  const j1 = createJournal(ws, 'f1.js', join(ws, 'f1.js'), 'let f1 = 1;', { editMode: 'patch' })
  const j2 = createJournal(ws, 'f2.js', join(ws, 'f2.js'), 'let f2 = 1;', { editMode: 'patch' })
  const new1 = 'let f1 = 1; let f1b = 2;'
  updateJournalState(j1.dir, { state: 'staged', new_hash: sha256(Buffer.from(new1)) })
  writeFileSync(join(ws, 'f1.js'), new1)
  updateJournalState(j1.dir, { state: 'committed' })
  const { batchId } = createBatchMarker(ws, ['f1.js', 'f2.js'], 'best_effort')
  const markerPath = join(ws, JOURNAL_ROOT, 'batches', `${batchId}.json`)
  const marker = JSON.parse(readFileSync(markerPath, 'utf-8'))
  marker.txnIds = [j1.txnId, j2.txnId]
  atomicWrite(markerPath, JSON.stringify(marker, null, 2), { fsync: true })
  releaseBatchLock(ws)
  const r = await recoverJournals(ws)
  assert(r.some(x => x.action === 'batch_best_effort_partial_kept'), `best_effort → partial_kept（得 ${JSON.stringify(r.map(x => x.action))}）`)
  assert(readFileSync(join(ws, 'f1.js'), 'utf-8') === new1, '已提交内容保留（不回滚）')
  assert(!existsSync(markerPath), '批次 marker 删除')
}

// ── ⑨ 真实 SIGKILL：writeSymbols 批量中途崩溃（主进程持 f2 锁制造精确崩溃点）──
console.log('\n── ⑨ real SIGKILL during writeSymbols batch (f2 locked) ──')
{
  const ws = join(TMP, 'kill-batch')
  const f1 = join(ws, 'f1.js')
  const f2 = join(ws, 'f2.js')
  mkdirSync(ws, { recursive: true })
  writeFileSync(f1, 'let f1 = 1;')
  writeFileSync(f2, 'let f2 = 1;')
  // 主进程持 f2 锁：子进程 writeSymbols 在 f2 acquireLock（30s 超时）阻塞，f1 正常提交 → kill
  // 崩溃点 = f1 committed + marker.txnIds 滞后（f2 journal 未建）——R22-⑦ marker.files 全集判定必须回滚 f1
  const { acquireLock } = await import(pathToFileURL(join(__dirname, '..', 'write-runtime.js')).href)
  const f2Lock = await acquireLock(f2, 40000)
  const child = `const { join } = require('path')
const { mkdirSync } = require('fs')
const { writeSymbols } = require(process.env.MOD)
const ws = process.env.WS
mkdirSync(ws, { recursive: true })
writeSymbols({
  workspace_dir: ws,
  allow_unsafe_no_base: true,
  policy: { all_or_nothing: true },
  writes: [
    { file_path: 'f1.js', edit_mode: 'patch', patch: { old_string: 'let f1 = 1;', new_string: 'let f1 = 1; let f1b = 2;' } },
    { file_path: 'f2.js', edit_mode: 'patch', patch: { old_string: 'let f2 = 1;', new_string: 'let f2 = 1; let f2b = 2;' } },
  ],
}, { codeIndexService: null, langParserService: null, getWorkspaceDir: () => ws }).catch(() => {})`
  const { spawn } = await import('node:child_process')
  const childProc = spawn(process.execPath, ['-e', child], { env: { ...process.env, MOD: join(__dirname, '..', 'write-runtime.js'), WS: ws } })
  // 轮询 f1 提交（内容变化）→ 精确 kill
  let f1Committed = false
  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 100))
    if (readFileSync(f1, 'utf-8').includes('f1b')) { f1Committed = true; break }
  }
  assert(f1Committed, 'f1 在 kill 前已提交（崩溃点就位）')
  if (f1Committed) {
    // R22-⑯：等子进程释放 f1 锁（此时它已阻塞在 f2 锁上）——kill 后 f1.mlock 不残留，
    // recoverBatches 的 acquireLock 立即成功，避免慢盘 CI 上 30s 竞态挂死
    for (let i = 0; i < 200 && existsSync(f1 + '.mlock'); i++) {
      await new Promise(r => setTimeout(r, 25))
    }
    childProc.kill('SIGKILL')
  }
  await new Promise(r => childProc.once('exit', r))
  f2Lock.release()
  // R22-⑯：子进程 SIGKILL 后锁残留——手动释放后再恢复
  releaseBatchLock(ws)
  const r = await recoverJournals(ws)
  assert(r.some(x => x.action === 'batch_partial_rollback'), `strict 半批崩溃 → batch_partial_rollback（得 ${JSON.stringify(r.map(x => x.action))}）`)
  assert(readFileSync(f1, 'utf-8') === 'let f1 = 1;', 'f1 回滚到原始内容（半批不残留，原子性）')
  const batchesDir = join(ws, JOURNAL_ROOT, 'batches')
  assert(existsSync(batchesDir) ? readdirSync(batchesDir).filter(f => f.endsWith('.json')).length === 0 : true, '批次 marker 已删')
}

// ── ⑩ 恢复可重入：第二次 recover 无重复动作 ──
console.log('\n── ⑩ recover re-entrancy ──')
{
  const ws = join(TMP, 'reenter')
  const dir = join(ws, JOURNAL_ROOT, 'journal', 'txn_r')
  mkdirSync(join(dir, 'backup'), { recursive: true })
  writeFileSync(join(dir, 'state.json'), '{"txn_id":"txn_r","state":"created"}')
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ txn_id: 'txn_r', file: 'r.js' }))
  const r1 = await recoverJournals(ws)
  const r2 = await recoverJournals(ws)
  assert(r1.some(x => x.action === 'rolled_back'), `首次 recover → rolled_back`)
  assert(r2.every(x => x.action !== 'rolled_back' || !x.txn_id), '二次 recover 无重复回滚动作')
}

// ── ⑨ atomicWrite fsync 路径接口 + prune 对终态孤儿无残留 ──
console.log('\n── ⑨ atomicWrite fsync + prune sanity ──')
{
  const f = join(TMP, 'fsync-target.txt')
  atomicWrite(f, 'fsync content', { fsync: true })
  assert(readFileSync(f, 'utf-8') === 'fsync content', 'atomicWrite({fsync:true}) 正常落盘')
  atomicWrite(f, 'no-fsync content')
  assert(readFileSync(f, 'utf-8') === 'no-fsync content', 'atomicWrite 默认路径正常')
  const p = pruneJournals(join(TMP, 'no-such-prune-dir'), { force: true })
  assert(p.pruned === 0 && p.skipped_throttle === false, 'prune 无目录 no-op')
}

console.log(`\n== test-crash-injection: ${pass} passed, ${fail} failed ==`)
process.exit(fail > 0 ? 1 : 0)
