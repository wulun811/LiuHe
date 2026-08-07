// test-transaction-crash.js — R4a TransactionStore 崩溃恢复回归
// recoverTransactions 三场景：全未落盘→abandoned；已落盘(==new_hash)→committed_recovered；
// 外部修改→needs_review；begin 后无文件→orphan_removed；幂等（终态跳过）。
// 构造崩溃残留目录（等价 SIGKILL 后的磁盘状态），不依赖真子进程（恢复逻辑只看磁盘）。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0
let fail = 0
function assert(cond, msg) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`) }
  else { fail++; console.log(`  ✗ ${msg}`) }
}
const imp = (p) => import(pathToFileURL(p).href)
const { recoverTransactions } = await imp(join(__dirname, '..', 'write-journal.js'))
const { sha256 } = await imp(join(__dirname, '..', 'hash-utils.js'))

const WS = join(tmpdir(), 'opencode', 'txn-crash')
rmSync(WS, { recursive: true, force: true })
mkdirSync(WS, { recursive: true })
const txnRoot = join(WS, '.ai-transactions')

function makeTxn(txnId, { state = 'staged', files = {}, fileContent = null }) {
  const dir = join(txnRoot, txnId)
  mkdirSync(join(dir, 'backup'), { recursive: true })
  const manifest = { name: txnId, txnId, created: Date.now(), state, files }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  for (const [rel, meta] of Object.entries(files)) {
    if (meta.backupContent !== undefined) {
      writeFileSync(join(dir, 'backup', meta.backupName), meta.backupContent)
    }
    if (fileContent !== null) {
      writeFileSync(join(WS, rel), fileContent)
    }
  }
}

// ① begin 后无文件（孤儿）→ orphan_removed
// R22-⑳：孤儿清理有 60s 活跃保护（防连续 begin 误清活跃空事务）——
// 模拟真实崩溃残留（begin 后进程死，恢复发生在 60s 后）→ 超龄孤儿
{
  makeTxn('t1', { state: 'staged', files: {} })
  const m1 = JSON.parse(readFileSync(join(txnRoot, 't1', 'manifest.json'), 'utf-8'))
  m1.created = Date.now() - 120_000
  writeFileSync(join(txnRoot, 't1', 'manifest.json'), JSON.stringify(m1, null, 2))
  const r = await recoverTransactions(WS)
  assert(r.some(x => x.txn_id === 't1' && x.action === 'orphan_removed'), `孤儿事务删除（${JSON.stringify(r.filter(x => x.txn_id === 't1'))}）`)
  assert(!existsSync(join(txnRoot, 't1')), `孤儿目录已删`)
}

// ② 全未落盘（当前==backup）→ abandoned
{
  const content = 'original content'
  writeFileSync(join(WS, 'a.js'), content)
  makeTxn('t2', {
    files: { 'a.js': { backupName: 'a__js', backupContent: content } },
    fileContent: content,
  })
  const r = await recoverTransactions(WS)
  assert(r.some(x => x.txn_id === 't2' && x.action === 'abandoned'), `全未落盘 abandoned（${JSON.stringify(r.filter(x => x.txn_id === 't2'))}）`)
  assert(!existsSync(join(txnRoot, 't2')), `abandoned 目录已删`)
}

// ③ 已落盘（当前==new_hash）→ committed_recovered（保留目录供 undo）
{
  const backup = 'old content'
  const newContent = 'new content after edit'
  writeFileSync(join(WS, 'b.js'), newContent)
  makeTxn('t3', {
    files: { 'b.js': { backupName: 'b__js', backupContent: backup, new_hash: sha256(Buffer.from(newContent, 'utf-8')) } },
    fileContent: newContent,
  })
  const r = await recoverTransactions(WS)
  assert(r.some(x => x.txn_id === 't3' && x.action === 'committed_recovered'), `已落盘 committed_recovered（${JSON.stringify(r.filter(x => x.txn_id === 't3'))}）`)
  const m = JSON.parse(readFileSync(join(txnRoot, 't3', 'manifest.json'), 'utf-8'))
  assert(m.state === 'committed_recovered' && m.recovered_at, `manifest 补标 committed_recovered + recovered_at`)
  assert(existsSync(join(txnRoot, 't3')), `目录保留供 undo`)
}

// ④ 外部修改（当前≠backup≠new_hash）→ needs_review（永不覆盖）
{
  const backup = 'old content'
  writeFileSync(join(WS, 'c.js'), 'external change')
  makeTxn('t4', {
    files: { 'c.js': { backupName: 'c__js', backupContent: backup, new_hash: sha256(Buffer.from('edited by txn', 'utf-8')) } },
    fileContent: 'external change',
  })
  const r = await recoverTransactions(WS)
  assert(r.some(x => x.txn_id === 't4' && x.action === 'needs_review'), `外部修改 needs_review（${JSON.stringify(r.filter(x => x.txn_id === 't4'))}）`)
  assert(readFileSync(join(WS, 'c.js'), 'utf-8') === 'external change', `外部修改未被覆盖`)
  const m = JSON.parse(readFileSync(join(txnRoot, 't4', 'manifest.json'), 'utf-8'))
  assert(m.state === 'needs_review', `manifest 标 needs_review`)
}

// ⑤ 幂等：终态（committed/needs_review）跳过，再次调用零副作用
{
  const before = readdirSync(txnRoot).sort().join(',')
  const r2 = await recoverTransactions(WS)
  const after = readdirSync(txnRoot).sort().join(',')
  assert(before === after, `幂等：二次调用不删不改终态目录（${before}）`)
  assert(!r2.some(x => x.txn_id === 't3' || x.txn_id === 't4'), `终态事务不重复处理`)
}

rmSync(WS, { recursive: true, force: true })
console.log(`== test-transaction-crash: ${pass} passed, ${fail} failed ==`)
process.exit(fail > 0 ? 1 : 0)