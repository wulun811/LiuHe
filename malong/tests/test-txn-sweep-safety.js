// test-txn-sweep-safety.js — R7-CE19（P0）：清扫只能删「可证明的终态」事务目录
//
// 专家反例（六合_0.6.1发版前反例复跑.mjs）只覆盖「坏 JSON」一种。
// 本文件按专家 §2 放行标准补足矩阵：
//   ① 坏 JSON manifest         → 保留，且备份仍可读回（不是「保留了个空壳」）
//   ② manifest 缺失            → 保留
//   ③ 新版未知状态             → 保留
//   ④ indeterminate / staged / needs_review → 保留
//   ⑤ 可证明终态（committed / rolled_back / abandoned）→ 正常回收
//   ⑥ 未超 TTL                 → 一律保留
//   ⑦ 多工作区隔离：A 的清扫碰不到 B
//   ⑧ 重复启动（构造多次）幂等：第一次保留，第二次仍保留
//   ⑨ 清扫不得改动工作区业务文件
//   ⑩ 保留原因可在 sweepReport 里查到（bounded health warning / reconciliation hint）
//
// 设计约束：不新增状态机，不改事务语义，只把「保护名单」翻成「允许名单」。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) pass++
  else { fail++; console.error('  FAIL:', msg) }
}

const { TransactionStore } = await import(pathToFileURL(join(root, 'tools/tool-edit-transaction/transaction-store.js')).href)

const DAY = 86400_000
const OLD = new Date(Date.now() - 9 * DAY)

// 造一个「已 stage（文件确实写成 B）」的事务目录，然后按需破坏 manifest
async function makeTxn(ws, name) {
  mkdirSync(ws, { recursive: true })
  writeFileSync(join(ws, 'hello.js'), 'const a = 1;\n')
  const store = new TransactionStore(ws, { sweep: false })
  const id = store.begin(name)
  await store.backupFile(id, 'hello.js')
  const r = await store.applyEdits(id, 'hello.js', [{ old_string: 'a = 1', new_string: 'a = 2' }])
  assert(r.status === 'staged', `${name}: 前置 stage 成功（得 ${r.status}）`)
  return id
}

function ageDir(dir) { utimesSync(dir, OLD, OLD) }
function txnDir(ws, id) { return join(ws, '.ai-transactions', id) }

const created = []
function freshWorkspace(tag) {
  const ws = mkdtempSync(join(tmpdir(), `lh-sweep-${tag}-`))
  created.push(ws)
  return ws
}

try {
  // ── ① 坏 JSON manifest：保留，且备份仍可访问 ──
  {
    const ws = freshWorkspace('broken')
    const id = await makeTxn(ws, 'broken_json')
    const dir = txnDir(ws, id)
    writeFileSync(join(dir, 'manifest.json'), '{broken-json')
    ageDir(dir)
    new TransactionStore(ws) // 默认 sweep=true
    assert(existsSync(dir), '① 坏 JSON 目录必须保留（不得被当 unknown 删掉）')
    const backups = existsSync(join(dir, 'backup')) ? readdirSync(join(dir, 'backup')) : []
    assert(backups.length > 0, `① 备份材料仍可访问（backup 文件 ${JSON.stringify(backups)}）`)
    assert(backups.every(b => readFileSync(join(dir, 'backup', b)).length > 0), '① 备份内容非空（不是空壳）')
    assert(readFileSync(join(ws, 'hello.js'), 'utf-8').includes('a = 2'), '① 清扫不得改动工作区业务文件')
  }

  // ── ② manifest 缺失 ──
  {
    const ws = freshWorkspace('nomanifest')
    const id = await makeTxn(ws, 'no_manifest')
    const dir = txnDir(ws, id)
    rmSync(join(dir, 'manifest.json'), { force: true })
    ageDir(dir)
    new TransactionStore(ws)
    assert(existsSync(dir), '② manifest 缺失必须保留')
  }

  // ── ③ 新版未知状态 ──
  {
    const ws = freshWorkspace('newstate')
    const id = await makeTxn(ws, 'future_state')
    const dir = txnDir(ws, id)
    const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf-8'))
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...m, state: 'quarantined_v9', schema: 9 }))
    ageDir(dir)
    new TransactionStore(ws)
    assert(existsSync(dir), '③ 未知新版本状态必须保留（future-proof，不得按 unknown 删）')
  }

  // ── ④ 已知保护态 ──
  for (const st of ['staged', 'needs_review', 'indeterminate']) {
    const ws = freshWorkspace(`prot-${st}`)
    const id = await makeTxn(ws, `prot_${st}`)
    const dir = txnDir(ws, id)
    const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf-8'))
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...m, state: st }))
    ageDir(dir)
    new TransactionStore(ws)
    assert(existsSync(dir), `④ 保护态 ${st} 必须保留`)
  }

  // ── ⑤ 可证明终态 → 正常回收（不能因为怕删就永不清理） ──
  for (const st of ['committed', 'rolled_back', 'abandoned', 'undone', 'failed']) {
    const ws = freshWorkspace(`term-${st}`)
    const id = await makeTxn(ws, `term_${st}`)
    const dir = txnDir(ws, id)
    const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf-8'))
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...m, state: st }))
    ageDir(dir)
    new TransactionStore(ws)
    assert(!existsSync(dir), `⑤ 终态 ${st} 超龄应被回收（否则磁盘无界增长）`)
    assert(readFileSync(join(ws, 'hello.js'), 'utf-8').includes('a = 2'), `⑤ 回收 ${st} 不得回滚工作区文件`)
  }

  // ── ⑥ 未超 TTL 一律保留 ──
  {
    const ws = freshWorkspace('fresh')
    const id = await makeTxn(ws, 'fresh_txn')
    const dir = txnDir(ws, id)
    const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf-8'))
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...m, state: 'committed' }))
    new TransactionStore(ws)
    assert(existsSync(dir), '⑥ 未超 TTL 的终态也必须保留（在用事务不受影响）')
  }

  // ── ⑦ 多工作区隔离 ──
  {
    const wsA = freshWorkspace('wsA')
    const wsB = freshWorkspace('wsB')
    const idA = await makeTxn(wsA, 'a')
    const idB = await makeTxn(wsB, 'b')
    const dirA = txnDir(wsA, idA)
    const dirB = txnDir(wsB, idB)
    writeFileSync(join(dirA, 'manifest.json'), '{broken')
    writeFileSync(join(dirB, 'manifest.json'), '{broken')
    ageDir(dirA); ageDir(dirB)
    new TransactionStore(wsA)
    assert(existsSync(dirA) && existsSync(dirB), '⑦ 清扫 A 工作区不得影响 B 工作区目录')
  }

  // ── ⑧ 重复启动幂等 ──
  {
    const ws = freshWorkspace('idem')
    const id = await makeTxn(ws, 'idem_txn')
    const dir = txnDir(ws, id)
    writeFileSync(join(dir, 'manifest.json'), '{still-broken')
    ageDir(dir)
    for (let i = 0; i < 3; i++) new TransactionStore(ws)
    assert(existsSync(dir), '⑧ 连续 3 次启动（重复清扫）后目录仍保留')
  }

  // ── ⑩ 保留原因可查（bounded）+ 不误报为已恢复 ──
  {
    const ws = freshWorkspace('report')
    const id = await makeTxn(ws, 'report_txn')
    const dir = txnDir(ws, id)
    writeFileSync(join(dir, 'manifest.json'), '{broken')
    ageDir(dir)
    const store = new TransactionStore(ws)
    const report = store.sweepReport?.() || null
    assert(report != null, '⑩ 清扫必须留下可查报告（不得静默跳过）')
    if (report) {
      const kept = report.kept || []
      const hit = kept.find(k => k.txn_id === id)
      assert(!!hit, `⑩ 被保留的目录必须出现在报告里（kept=${JSON.stringify(kept)}）`)
      assert(hit && /manifest|unknown|unparse|cannot|unproven/i.test(String(hit.reason)), `⑩ 保留原因须说明「无法证明可删」（得 ${hit && hit.reason}）`)
      assert(report.swept == null || !(report.swept || []).includes(id), '⑩ 不得把保留项误报为已清扫')
      assert((report.kept || []).length <= 20, '⑩ 报告必须有界（≤20 条明细）')
    }
  }
} finally {
  for (const d of created) { try { rmSync(d, { recursive: true, force: true }) } catch {} }
}

console.log(`\n== test-txn-sweep-safety: ${pass} passed, ${fail} failed ==`)
if (fail > 0) process.exitCode = 1
