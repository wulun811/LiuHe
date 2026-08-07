// test-index-repair.js — R18 索引恢复模型回归
// ① recoverJournals 对 committed+index_pending 的 journal 启动补抽（成功→清标记+index_repaired）
// ② 补抽失败→index_repair_failed（标记保留，下次再试）
// ③ writeSymbol 写后重抽失败→journal 记 index_pending
// ④ batch-edit delegateWrite 重抽失败→journal 记 index_pending
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0
let fail = 0
function assert(cond, msg) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`) }
  else { fail++; console.log(`  ✗ ${msg}`) }
}
const imp = (p) => import(pathToFileURL(p).href)
const { recoverJournals, recoverTransactions, createJournal, updateJournalState, JOURNAL_ROOT } = await imp(join(__dirname, '..', 'write-journal.js'))
const { sha256 } = await imp(join(__dirname, '..', 'hash-utils.js'))

const WS = join(tmpdir(), 'opencode', 'index-repair')
try { rmSync(WS, { recursive: true, force: true }) } catch {}
mkdirSync(join(WS, 'src'), { recursive: true })

function makeState(txnDir, state) {
  mkdirSync(join(WS, JOURNAL_ROOT, 'journal', txnDir, 'backup'), { recursive: true })
  writeFileSync(join(WS, JOURNAL_ROOT, 'journal', txnDir, 'manifest.json'), JSON.stringify({ txn_id: txnDir, file: 'src/app.js' }, null, 2))
  writeFileSync(join(WS, JOURNAL_ROOT, 'journal', txnDir, 'state.json'), JSON.stringify({ txn_id: txnDir, ...state }, null, 2))
}

// ── ① 补抽成功：committed + index_pending → indexFile 被调 + 标记清除 ──
makeState('t1', { state: 'committed', index_pending: true, index_pending_reason: 'boom' })
let repaired = null
let repairedTxns = []
const svcOk = {
  async indexFile(absPath) {
    repaired = absPath
    return { symbols: 1, refs: 0 }
  },
}
const r1 = await recoverJournals(WS, { codeIndexService: svcOk })
const t1State = JSON.parse(readFileSync(join(WS, JOURNAL_ROOT, 'journal', 't1', 'state.json'), 'utf-8'))
assert((repaired || '').replace(/\\/g, '/').endsWith('src/app.js'), `① recoverJournals 补抽调用 indexFile（${repaired || 'null'}）`)
assert(t1State.index_pending === false, '① 补抽成功清除 index_pending')
assert(r1.some(x => x.action === 'index_repaired'), '① recovered 记录 index_repaired')

// ── ② 补抽失败：indexFile 抛错 → index_repair_failed + 标记保留 ──
makeState('t2', { state: 'rolled_back', index_pending: true, index_pending_reason: 'boom' })
const svcFail = {
  async indexFile() { throw new Error('db locked') },
}
const r2 = await recoverJournals(WS, { codeIndexService: svcFail })
const t2State = JSON.parse(readFileSync(join(WS, JOURNAL_ROOT, 'journal', 't2', 'state.json'), 'utf-8'))
assert(t2State.index_pending === true, '② 补抽失败保留 index_pending（下次再试）')
assert(r2.some(x => x.action === 'index_repair_failed' && x.reason === 'db locked'), '② recovered 记录 index_repair_failed')

// ── ②b 不传 codeIndexService：不补抽也不报错（向后兼容） ──
const r2b = await recoverJournals(WS)
assert(!r2b.some(x => x.action === 'index_repaired' || x.action === 'index_repair_failed'), '②b 无 codeIndexService 时跳过补抽')
rmSync(join(WS, JOURNAL_ROOT, 'journal', 't1'), { recursive: true, force: true })
rmSync(join(WS, JOURNAL_ROOT, 'journal', 't2'), { recursive: true, force: true })

// ── ③ writeSymbol 写后重抽失败 → journal index_pending ──
const APP = join(WS, 'src', 'app.js')
const CONTENT = 'export function gamma() { return 3 }\n'
writeFileSync(APP, CONTENT)
const writeRuntime = await imp(join(__dirname, '..', 'write-runtime.js'))
const failingSvc = {
  indexFile() { throw new Error('parse crash') },
  markIndexDirty() {},
  getFileByPath() { return null },
  updateContentHash() {},
  getSymbolByStableId() { return null },
  findSymbolsInFile() {
    return [{ name: 'gamma', type: 'function', kind: 'function', stable_id: 'js:src/app.js::gamma#function', start_line: 1, end_line: 1, body_hash: 'x', signature_hash: 'y', signature: 'gamma' }]
  },
  clearCachesForFile() {},
}
const wsRes = await writeRuntime.writeSymbol(
  {
    workspace_dir: WS,
    locator: { file_path: 'src/app.js', name: 'gamma' },
    content: 'export function delta() { return 4 }\n',
    editMode: 'replace_symbol',
    boundary: 'full',
    allow_unsafe_no_base: true,
  },
  { codeIndexService: failingSvc }
)
const jdir = wsRes.txn_id ? join(WS, JOURNAL_ROOT, 'journal', wsRes.txn_id) : null
assert(jdir && existsSync(join(jdir, 'state.json')), `③ writeSymbol 创建 journal（txn=${wsRes.txn_id || 'null'}）`)
if (jdir) {
  const st = JSON.parse(readFileSync(join(jdir, 'state.json'), 'utf-8'))
  assert(st.index_pending === true && st.index_pending_reason === 'parse crash', '③ 重抽失败 journal 记 index_pending')
  assert(st.state === 'committed', '③ 写本身成功（state=committed，仅索引补抽挂起）')
}

// ── ④ batch-edit delegateWrite 重抽失败 → journal index_pending ──
const { delegateWrite } = await imp(join(__dirname, '..', 'tools', 'tool-batch-edit', 'handler.js'))
const dw = await delegateWrite({
  absPath: APP,
  filePath: 'src/app.js',
  workspaceDir: WS,
  originalContent: readFileSync(APP, 'utf-8'),
  finalContent: 'export function epsilon() { return 5 }\n',
  codeIndexService: failingSvc,
})
assert(dw.ok === true, `④ delegateWrite 写成功（${JSON.stringify(dw.error || 'ok')}）`)
if (dw.journal) {
  const st = JSON.parse(readFileSync(join(dw.journal.dir, 'state.json'), 'utf-8'))
  assert(st.index_pending === true && st.index_pending_reason === 'parse crash', '④ delegateWrite 重抽失败 journal 记 index_pending')
  assert(st.state === 'committed', '④ 写本身成功（state=committed）')
}

// ── ⑤ 端到端：index_pending journal 经 recoverJournals(ws, {codeIndexService}) 补抽成功 ──
writeFileSync(APP, 'export function zeta() { return 6 }\n')
const e2e = await delegateWrite({
  absPath: APP,
  filePath: 'src/app.js',
  workspaceDir: WS,
  originalContent: readFileSync(APP, 'utf-8'),
  finalContent: 'export function eta() { return 7 }\n',
  codeIndexService: failingSvc,
})
let repairedE2E = null
const r5 = await recoverJournals(WS, { codeIndexService: { async indexFile(absPath) { repairedE2E = absPath; return {} } } })
assert(repairedE2E === APP, `⑤ 补抽命中真实 APP 路径（${repairedE2E}）`)
const st5 = JSON.parse(readFileSync(join(e2e.journal.dir, 'state.json'), 'utf-8'))
assert(st5.index_pending === false, '⑤ 端到端补抽后标记清除')

try { rmSync(WS, { recursive: true, force: true }) } catch {}

// ── ⑥ recoverTransactions：终态 manifest index_pending 补抽 + backupName 越界守卫 ──
mkdirSync(join(WS, 'src'), { recursive: true })
const txnRoot = join(WS, '.ai-transactions')
function makeTxn(txnId, manifest, inRecent = false) {
  // R22-④：commit 后事务在 recent/ 下——补抽场景必须构造真实状态（旧测试写顶层是生产不可达的假绿灯）
  const base = inRecent ? join(txnRoot, 'recent') : txnRoot
  const dir = join(base, txnId)
  mkdirSync(join(dir, 'backup'), { recursive: true })
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  return dir
}
const t3 = makeTxn('t3', {
  name: 't3', state: 'committed',
  index_pending: true,
  index_pending_files: ['src/app.js'],
  files: { 'src/app.js': { backupName: 'b3' } },
}, true)
writeFileSync(join(t3, 'backup', 'b3'), 'backup-content')
writeFileSync(join(WS, 'src', 'app.js'), 'new-content')
let repaired3 = null
const r6 = await recoverTransactions(WS, { codeIndexService: { async indexFile(absPath) { repaired3 = absPath; return {} } } })
assert((repaired3 || '').replace(/\\/g, '/').endsWith('src/app.js'), `⑥ recoverTransactions 补抽 index_pending（${repaired3 || 'null'}）`)
const m3 = JSON.parse(readFileSync(join(t3, 'manifest.json'), 'utf-8'))
assert(m3.index_pending === undefined, '⑥ 补抽成功清除 manifest index_pending')
assert(r6.some(x => x.action === 'index_repaired'), '⑥ recovered 记录 index_repaired')
// backupName 越界：../../../../etc/passwd → 跳过（不 readFileSync 外部）
const t4 = makeTxn('t4', {
  name: 't4', state: 'staged',
  files: { 'src/app.js': { backupName: '../../../../../../etc/passwd', new_hash: sha256('x') } },
})
writeFileSync(join(WS, 'src', 'app.js'), 'whatever')
const r7 = await recoverTransactions(WS)
// 越界项被跳过 → knownCount=0 → needs_review（判定资料不全，保守保留不删）——守卫生效的副作用
const t4Rec = r7.find(x => x.txn_id === 't4')
assert(t4Rec?.action === 'needs_review' && t4Rec?.reason === 'insufficient recovery data', `⑦ 越界 backupName 被跳过不计（knownCount=0 → needs_review 保守保留：${JSON.stringify(t4Rec)}）`)
const m4 = JSON.parse(readFileSync(join(t4, 'manifest.json'), 'utf-8'))
assert(m4.state === 'needs_review' && existsSync(t4), '⑦ 越界事务未删、未误判 abandoned/committed（外部文件未被读取）')

try { rmSync(WS, { recursive: true, force: true }) } catch {}
console.log(`\n== test-index-repair: ${pass} passed, ${fail} failed ==`)
if (fail > 0) process.exit(1)
