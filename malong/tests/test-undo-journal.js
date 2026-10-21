// test-undo-journal.js — Q1 用户级撤销（restoreJournal / undo_commit 双命名空间）
// 覆盖：编辑型恢复 / 外部修改拒绝 / 已恢复幂等 / created 撤销删除 / 未提交拒绝 /
//       非法 txnId / 不存在 journal / TransactionStore.undoCommit fallback / undone 终态可被 prune
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}
const { createJournal, updateJournalState, restoreJournal, pruneJournals, JOURNAL_RETENTION_HOURS } =
  await import(pathToFileURL(join(__dirname, '..', 'write-journal.js')).href)
const { TransactionStore } = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-edit-transaction', 'transaction-store.js')).href)
const { sha256 } = await import(pathToFileURL(join(__dirname, '..', 'hash-utils.js')).href)

const TMP = join(os.tmpdir(), 'opencode', 'undo-journal-test')
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
mkdirSync(TMP, { recursive: true })

// 造一个已提交的写链事务（编辑型），返回 { txnId, dir, abs }
function seedCommitted(ws, fileRel, original, newContent, extraState = {}) {
  const abs = join(ws, fileRel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, newContent)
  const j = createJournal(ws, fileRel, abs, original, { editMode: 'patch', ...extraState })
  updateJournalState(j.dir, { state: 'committed', committed_at: new Date().toISOString(), new_hash: sha256(newContent) })
  return { txnId: j.txnId, dir: j.dir, abs }
}

// ── ① 编辑型恢复：current == new_hash → 回写 backup，标 undone ──
{
  const ws = join(TMP, 'ws1'); mkdirSync(ws, { recursive: true })
  const { txnId, abs } = seedCommitted(ws, 'src/a.js', 'const a = 1\n', 'const a = 2\n')
  const r = await restoreJournal(ws, txnId)
  assert(r.ok === true && r.status === 'undone' && r.files_restored === 1, `① 恢复成功（得 ${JSON.stringify(r)}）`)
  assert(readFileSync(abs, 'utf-8') === 'const a = 1\n', '① 内容回写为写前')
  const again = await restoreJournal(ws, txnId)
  assert(again.ok === true && again.status === 'already_undone', `① 二次撤销幂等 already_undone（得 ${JSON.stringify(again)}）`)
}

// ── ② 外部修改拒绝：current 既非 new_hash 也非 backup → EXTERNAL_CHANGE，不覆盖 ──
{
  const ws = join(TMP, 'ws2'); mkdirSync(ws, { recursive: true })
  const { txnId, abs } = seedCommitted(ws, 'b.js', 'old\n', 'new\n')
  writeFileSync(abs, 'external\n')
  const r = await restoreJournal(ws, txnId)
  assert(r.ok === false && r.code === 'EXTERNAL_CHANGE', `② 外部修改拒绝（得 ${JSON.stringify(r)}）`)
  assert(readFileSync(abs, 'utf-8') === 'external\n', '② 不覆盖外部修改')
}

// ── ③ 已恢复幂等：current == backup → already_restored ──
{
  const ws = join(TMP, 'ws3'); mkdirSync(ws, { recursive: true })
  const { txnId, abs } = seedCommitted(ws, 'c.js', 'old\n', 'new\n')
  writeFileSync(abs, 'old\n')
  const r = await restoreJournal(ws, txnId)
  assert(r.ok === true && r.status === 'already_restored', `③ 已恢复幂等（得 ${JSON.stringify(r)}）`)
}

// ── ④ created 事务撤销 = 删除新建文件 ──
{
  const ws = join(TMP, 'ws4'); mkdirSync(ws, { recursive: true })
  const { txnId, abs } = seedCommitted(ws, 'created.js', '', 'fresh\n', { created: true })
  const r = await restoreJournal(ws, txnId)
  assert(r.ok === true && r.status === 'undone' && r.deleted === true, `④ created 撤销删除（得 ${JSON.stringify(r)}）`)
  assert(!existsSync(abs), '④ 新文件已删除')
}

// ── ⑤ created 事务 + 文件被外部改过 → 拒绝删除 ──
{
  const ws = join(TMP, 'ws5'); mkdirSync(ws, { recursive: true })
  const { txnId, abs } = seedCommitted(ws, 'created2.js', '', 'fresh\n', { created: true })
  writeFileSync(abs, 'touched\n')
  const r = await restoreJournal(ws, txnId)
  assert(r.ok === false && r.code === 'EXTERNAL_CHANGE', `⑤ created 外部修改拒绝（得 ${JSON.stringify(r)}）`)
  assert(existsSync(abs), '⑤ 文件保留')
}

// ── ⑥ 未提交（staged）拒绝 ──
{
  const ws = join(TMP, 'ws6'); mkdirSync(ws, { recursive: true })
  const abs = join(ws, 'd.js'); writeFileSync(abs, 'x\n')
  const j = createJournal(ws, 'd.js', abs, 'o\n', { editMode: 'patch', state: 'staged', new_hash: sha256('x\n') })
  const r = await restoreJournal(ws, j.txnId)
  assert(r.ok === false && r.code === 'NOT_COMMITTED', `⑥ staged 拒绝（得 ${JSON.stringify(r)}）`)
}

// ── ⑦ 非法 txnId / 不存在 journal ──
{
  const ws = join(TMP, 'ws7'); mkdirSync(ws, { recursive: true })
  const bad = await restoreJournal(ws, '../../etc/passwd')
  assert(bad.ok === false && bad.code === 'TXN_NOT_FOUND', `⑦ 穿越 txnId 拒绝（得 ${JSON.stringify(bad)}）`)
  const miss = await restoreJournal(ws, 'txn_nope')
  assert(miss.ok === false && miss.code === 'JOURNAL_NOT_FOUND', `⑦ 不存在 journal（得 ${JSON.stringify(miss)}）`)
  assert(String(miss.suggestion || '').includes(String(JOURNAL_RETENTION_HOURS)), '⑦ 提示含保留窗口')
}

// ── ⑧ TransactionStore.undoCommit fallback：经典未命中 → 写链 journal ──
{
  const ws = join(TMP, 'ws8'); mkdirSync(ws, { recursive: true })
  const { txnId, abs } = seedCommitted(ws, 'e.js', 'before\n', 'after\n')
  const store = new TransactionStore(ws, { sweep: false })
  const r = await store.undoCommit(txnId)
  assert(r.status === 'undone' && r.via === 'write-journal', `⑧ fallback 命中写链 journal（得 ${JSON.stringify(r)}）`)
  assert(readFileSync(abs, 'utf-8') === 'before\n', '⑧ 文件已恢复')
  // 经典不存在的 txn → 仍结构化 TXN_NOT_FOUND
  const nf = await store.undoCommit('txn_does_not_exist')
  assert(nf.error_code === 'TXN_NOT_FOUND', `⑧ 双空间都不存在仍报 TXN_NOT_FOUND（得 ${JSON.stringify(nf)}）`)
}

// ── ⑨ undone 是终态：不被 PRUNE 保护，过龄可清（生命周期收口） ──
{
  const ws = join(TMP, 'ws9'); mkdirSync(ws, { recursive: true })
  const { txnId, dir } = seedCommitted(ws, 'f.js', 'p\n', 'q\n')
  await restoreJournal(ws, txnId)
  const old = new Date(Date.now() - 48 * 3600 * 1000).toISOString()
  const st = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf-8'))
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ ...st, committed_at: old, undone_at: old }))
  pruneJournals(ws, { force: true })
  assert(!existsSync(dir), '⑨ undone 过龄被清理')
}

// ── ⑩ journal manifest 归一：调用方传绝对路径（edit_batch 协议侧归一）→ 存相对 + undo 可用 ──
{
  const ws = join(TMP, 'ws10'); mkdirSync(ws, { recursive: true })
  const rel = 'g.js'
  const abs = join(ws, rel)
  writeFileSync(abs, 'new\n')
  const j = createJournal(ws, abs, abs, 'old\n', { editMode: 'edit_batch', state: 'staged' })
  const mf = JSON.parse(readFileSync(join(j.dir, 'manifest.json'), 'utf-8'))
  assert(mf.file === rel, `⑩ manifest 存 workspace-relative（得 ${mf.file}）`)
  updateJournalState(j.dir, { state: 'committed', new_hash: sha256('new\n') })
  const r = await restoreJournal(ws, j.txnId)
  assert(r.ok === true && r.status === 'undone', `⑩ 绝对路径写入的 journal 可 undo（得 ${JSON.stringify(r)}）`)
  assert(readFileSync(abs, 'utf-8') === 'old\n', '⑩ 文件内容已恢复')
}

// ── ⑪ 旧格式兼容：修复前 journal 的 manifest.file 为绝对路径 → 读侧归一后仍可 undo ──
{
  const ws = join(TMP, 'ws11'); mkdirSync(ws, { recursive: true })
  const rel = 'h.js'
  const abs = join(ws, rel)
  writeFileSync(abs, 'new2\n')
  const j = createJournal(ws, rel, abs, 'old2\n', { editMode: 'edit_batch', state: 'staged' })
  // 模拟旧格式：直接改写 manifest 为绝对路径
  writeFileSync(join(j.dir, 'manifest.json'), JSON.stringify({ txn_id: j.txnId, file: abs, edit_mode: 'edit_batch', created_at: new Date().toISOString() }))
  updateJournalState(j.dir, { state: 'committed', new_hash: sha256('new2\n') })
  const r = await restoreJournal(ws, j.txnId)
  assert(r.ok === true && r.status === 'undone', `⑪ 旧绝对路径 manifest 可 undo（得 ${JSON.stringify(r)}）`)
  assert(readFileSync(abs, 'utf-8') === 'old2\n', '⑪ 旧格式文件已恢复')
}

// ── ⑫ 16-B 批量：同 batch_id 任一 token → 整批恢复；幂等；返回 batch 归因 ──
{
  const ws = join(TMP, 'ws12'); mkdirSync(ws, { recursive: true })
  const a = seedCommitted(ws, 'ba.js', 'a1\n', 'a2\n', { batch_id: 'batch_t1' })
  const b = seedCommitted(ws, 'bb.js', 'b1\n', 'b2\n', { batch_id: 'batch_t1' })
  const r = await restoreJournal(ws, a.txnId)
  assert(r.ok === true && r.status === 'undone' && r.files_restored === 2, `⑫ 单 token 恢复整批（得 ${JSON.stringify(r)}）`)
  assert(readFileSync(a.abs, 'utf-8') === 'a1\n' && readFileSync(b.abs, 'utf-8') === 'b1\n', '⑫ 两文件均回写写前')
  assert(r.batch && r.batch.batch_id === 'batch_t1' && r.batch.total === 2, '⑫ 返回 batch 归因')
  const again = await restoreJournal(ws, b.txnId)
  assert(again.ok === true && again.status === 'already_undone' && again.files_restored === 0, `⑫ 二次撤销幂等（得 ${JSON.stringify(again)}）`)
}

// ── ⑬ 16-B 批量外部改动：整批阻断，不部分恢复（all-or-nothing 预检） ──
{
  const ws = join(TMP, 'ws13'); mkdirSync(ws, { recursive: true })
  const a = seedCommitted(ws, 'ca.js', 'a1\n', 'a2\n', { batch_id: 'batch_t2' })
  const b = seedCommitted(ws, 'cb.js', 'b1\n', 'b2\n', { batch_id: 'batch_t2' })
  writeFileSync(b.abs, 'b-ext\n')
  const r = await restoreJournal(ws, a.txnId)
  assert(r.ok === false && r.code === 'BATCH_BLOCKED', `⑬ 整批阻断（得 ${JSON.stringify(r)}）`)
  assert(readFileSync(a.abs, 'utf-8') === 'a2\n', '⑬ 可恢复成员也未被部分恢复')
  assert((r.batch?.blocked || []).length === 1 && r.batch.blocked[0].code === 'EXTERNAL_CHANGE', '⑬ 阻断归因列出外部改动成员')
  assert(!/individually|or undo each member/i.test(String(r.suggestion || '')), '⑬ 阻断文案不再引导逐成员 token 撤销（整批全阻断口径）')
}

console.log(`=== test-undo-journal: ${pass} passed, ${fail} failed ===`)
process.exit(fail > 0 ? 1 : 0)
