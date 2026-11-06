// test-edit-txn-undo-anchor.js — LH-CE04 / LH-S1-02：缺失恢复关键锚时不得自动 undo
//
// 背景（《阶段一源码静态审查与定向改造裁决》§3 LH-S1-02，P0）：
//
//   undoCommit / rollback 的防覆盖门写成：
//     if (meta.new_hash && curHash !== backupHash && curHash !== meta.new_hash) { skip('external_change') }
//
//   `meta.new_hash &&` 这个短路条件意味着：**一旦 new_hash 缺失，整个外部改动防护被跳过**，
//   于是 undo 会无条件把备份写回磁盘 —— 覆盖掉第三方在此期间的一切修改，并且回报
//   `undone`（无条件闭合成功）。
//
//   new_hash 会缺失的真实场景：写前 journal 持久化失败（updateJournalState 内部 try/catch 吞掉）、
//   旧版本事务目录、崩溃在 manifest 更新前。专家的判断是：
//   「关键问题不是在所有机器上一定发生，而是持久化失败不能参与安全判定。」
//
// 裁决（§6 B3）：undoCommit/rollback/restoreJournal 增加缺失 expected-after 的拒绝；
//   旧资产信息不全时只能人工复核，不自动覆盖。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) { if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) } }

const { handle } = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-edit-transaction', 'handler.js')).href)
const ctx = { codeIndexService: null, langParserService: null }

const mk = () => { const w = mkdtempSync(join(tmpdir(), 'undo-anchor-')); mkdirSync(join(w, 'src'), { recursive: true }); return w }
const rd = (w, f) => readFileSync(join(w, f), 'utf-8')

// ── LH-CE04-a：commit 后抹掉 new_hash，外部改动，再 undo ──
// 期望：NEEDS_REVIEW 类拒绝（或跳过），绝不覆盖外部改动，绝不回报无条件 undone
{
  const ws = mk()
  writeFileSync(join(ws, 'x.txt'), 'A\n')
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'ce04a' }, ctx)
  assert(!!b.txnId, 'CE04-a begin 成功（得 ' + JSON.stringify(b.error_code) + '）')

  const e = await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 'x.txt', edits: [{ old_string: 'A', new_string: 'B' }] }, ctx)
  assert(e.status === 'staged', 'CE04-a edit staged（得 ' + JSON.stringify(e.status || e.error_code) + '）')
  const c = await handle({ workspace_dir: ws, action: 'commit', txn_id: b.txnId }, ctx)
  assert(c.status === 'committed', 'CE04-a commit 成功（得 ' + JSON.stringify(c.status || c.error) + '）')

  // 抹掉恢复关键锚（模拟写前 journal 持久化失败 / 旧版本事务）
  const mp = join(ws, '.ai-transactions', 'recent', b.txnId, 'manifest.json')
  const m = JSON.parse(readFileSync(mp, 'utf-8'))
  delete m.files['x.txt'].new_hash
  delete m.files['x.txt'].last_txn_effect_hash
  writeFileSync(mp, JSON.stringify(m, null, 2))

  // 第三方在此期间修改
  writeFileSync(join(ws, 'x.txt'), 'EXTERNAL\n')

  const u = await handle({ workspace_dir: ws, action: 'undo_commit', txn_id: b.txnId }, ctx)
  const after = rd(ws, 'x.txt')

  // 核心 1：外部改动绝不能被抹掉
  assert(after === 'EXTERNAL\n',
    'CE04-a 缺 new_hash 时 undo 不得覆盖外部改动（得 ' + JSON.stringify(after) + '，期望 "EXTERNAL\\n"）')
  // 核心 2：不得谎报无条件闭合
  assert(u.status !== 'undone',
    'CE04-a 缺关键锚时不得回报 undone（得 ' + JSON.stringify(u.status) + '）')
  // 核心 3：必须给出可辨识的拒绝理由
  assert(!!(u.error_code || u.skipped?.length),
    'CE04-a 必须给出可辨识理由（得 ' + JSON.stringify({ st: u.status, ec: u.error_code, sk: u.skipped }) + '）')
  rmSync(ws, { recursive: true, force: true })
}

// ── LH-CE04-b：rollback 同样必须受保护 ──
{
  const ws = mk()
  writeFileSync(join(ws, 'x.txt'), 'A\n')
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'ce04b' }, ctx)
  await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 'x.txt', edits: [{ old_string: 'A', new_string: 'B' }] }, ctx)

  const mp = join(ws, '.ai-transactions', b.txnId, 'manifest.json')
  const m = JSON.parse(readFileSync(mp, 'utf-8'))
  delete m.files['x.txt'].new_hash
  delete m.files['x.txt'].last_txn_effect_hash
  writeFileSync(mp, JSON.stringify(m, null, 2))

  writeFileSync(join(ws, 'x.txt'), 'EXTERNAL\n')
  const r = await handle({ workspace_dir: ws, action: 'rollback', txn_id: b.txnId }, ctx)
  const after = rd(ws, 'x.txt')
  assert(after === 'EXTERNAL\n',
    'CE04-b 缺 new_hash 时 rollback 不得覆盖外部改动（得 ' + JSON.stringify(after) + '）')
  assert(r.status !== 'rolled_back',
    'CE04-b 不得回报无条件 rolled_back（得 ' + JSON.stringify(r.status) + '）')
  rmSync(ws, { recursive: true, force: true })
}

// ── LH-CE04-c：new_hash 存在且磁盘未变时，undo 仍应正常工作（不得过度拒绝）──
{
  const ws = mk()
  writeFileSync(join(ws, 'x.txt'), 'A\n')
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'ce04c' }, ctx)
  await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 'x.txt', edits: [{ old_string: 'A', new_string: 'B' }] }, ctx)
  await handle({ workspace_dir: ws, action: 'commit', txn_id: b.txnId }, ctx)
  const u = await handle({ workspace_dir: ws, action: 'undo_commit', txn_id: b.txnId }, ctx)
  assert(u.status === 'undone', 'CE04-c 正常路径仍应 undone（得 ' + JSON.stringify(u.status || u.error_code) + '）')
  assert(rd(ws, 'x.txt') === 'A\n', 'CE04-c 正常路径回到 A（得 ' + JSON.stringify(rd(ws, 'x.txt')) + '）')
  rmSync(ws, { recursive: true, force: true })
}

// ── LH-CE04-d：new_hash 存在但磁盘被外部改过 → 仍须 skip（不得回归）──
{
  const ws = mk()
  writeFileSync(join(ws, 'x.txt'), 'A\n')
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'ce04d' }, ctx)
  await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 'x.txt', edits: [{ old_string: 'A', new_string: 'B' }] }, ctx)
  await handle({ workspace_dir: ws, action: 'commit', txn_id: b.txnId }, ctx)
  writeFileSync(join(ws, 'x.txt'), 'EXTERNAL\n')
  const u = await handle({ workspace_dir: ws, action: 'undo_commit', txn_id: b.txnId }, ctx)
  assert(rd(ws, 'x.txt') === 'EXTERNAL\n', 'CE04-d 外部改动不被覆盖（得 ' + JSON.stringify(rd(ws, 'x.txt')) + '）')
  assert(u.status !== 'undone', 'CE04-d 不得回报 undone（得 ' + JSON.stringify(u.status) + '）')
  rmSync(ws, { recursive: true, force: true })
}

console.log('== test-edit-txn-undo-anchor: ' + pass + ' passed, ' + fail + ' failed ==')
if (fail > 0) process.exit(1)
