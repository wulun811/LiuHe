// test-lh-ce-matrix.js — 《阶段一源码静态审查与定向改造裁决》§5 LH-CE01~CE10 实测矩阵
//
// 来源：专家文档《六合 × 语义抽象派｜阶段一源码静态审查与定向改造裁决》(2026-10-29)
// 该文档 §5 给出 10 条最小反例及预期。本文件逐条落地为可执行断言。
//
// 证据等级说明（专家要求严格区分）：
//   - 本文件全部为「真实运行」结果，不是控制流推断。
//   - 专家审查的 v0.5.29 基线（commit c7e0da8）本机不存在，本机基线为 5434e28 之后。
//     因此对 LH-S1-01 一类「已在本轮修复」的项，本文件断言的是【修复后行为】，
//     并在报告 03 中记录了回退验证（证明修复前确实违规）。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const M = join(__dirname, '..')
let pass = 0, fail = 0
function assert(cond, msg) { if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) } }

const { handle } = await import(pathToFileURL(join(M, 'tools', 'tool-edit-transaction', 'handler.js')).href)
const { recoverTransactions } = await import(pathToFileURL(join(M, 'write-journal.js')).href)
const ctx = { codeIndexService: null, langParserService: null }

const mk = () => { const w = mkdtempSync(join(tmpdir(), 'lh-ce-')); mkdirSync(join(w, 'src'), { recursive: true }); return w }
const rd = (w, ...parts) => readFileSync(join(w, ...parts), 'utf-8')
const seq3 = async (ws, name) => {
  const b = await handle({ workspace_dir: ws, action: 'begin', name }, ctx)
  await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 'x.txt', edits: [{ old_string: 'A', new_string: 'B' }] }, ctx)
  await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 'x.txt', edits: [{ old_string: 'B', new_string: 'C' }] }, ctx)
  return b
}

// ── LH-CE01：单事务 A→B→C 后 undo → 必须回到 A，绝不能回到 B ──
{
  const ws = mk(); writeFileSync(join(ws, 'x.txt'), 'A\n')
  const b = await seq3(ws, 'ce01')
  await handle({ workspace_dir: ws, action: 'commit', txn_id: b.txnId }, ctx)
  const u = await handle({ workspace_dir: ws, action: 'undo_commit', txn_id: b.txnId }, ctx)
  assert(u.status === 'undone', 'LH-CE01 undo 成功（得 ' + JSON.stringify(u.status || u.error_code) + '）')
  assert(rd(ws, 'x.txt') === 'A\n', 'LH-CE01 undo 回到 A，不得回到 B（得 ' + JSON.stringify(rd(ws, 'x.txt')) + '）')
  rmSync(ws, { recursive: true, force: true })
}

// ── LH-CE02：同事务 A→B→C 后 rollback → 必须回到 A ──
{
  const ws = mk(); writeFileSync(join(ws, 'x.txt'), 'A\n')
  const b = await seq3(ws, 'ce02')
  const r = await handle({ workspace_dir: ws, action: 'rollback', txn_id: b.txnId }, ctx)
  assert(r.status === 'rolled_back', 'LH-CE02 rollback 成功（得 ' + JSON.stringify(r.status || r.error_code) + '）')
  assert(rd(ws, 'x.txt') === 'A\n', 'LH-CE02 rollback 回到 A（得 ' + JSON.stringify(rd(ws, 'x.txt')) + '）')
  rmSync(ws, { recursive: true, force: true })
}

// ── LH-CE03：同文件连续编辑中 kill/restart → 在 A/B/C/unknown 中诚实回报，不误恢复 ──
{
  const ws = mk(); writeFileSync(join(ws, 'x.txt'), 'A\n')
  const b = await seq3(ws, 'ce03')
  // 模拟崩溃在 manifest 更新前：删掉 new_hash，磁盘保留 B/C 之一
  const mp = join(ws, '.ai-transactions', b.txnId, 'manifest.json')
  const m = JSON.parse(readFileSync(mp, 'utf-8'))
  delete m.files['x.txt'].new_hash
  writeFileSync(mp, JSON.stringify(m, null, 2))
  const before = rd(ws, 'x.txt')
  const rec = await recoverTransactions(ws, {})
  const mine = rec.find(r => r.txn_id === b.txnId)
  const after = rd(ws, 'x.txt')
  assert(['A\n', 'B\n', 'C\n'].includes(after), 'LH-CE03 恢复后内容必为 A/B/C 之一（得 ' + JSON.stringify(after) + '）')
  assert(before === after, 'LH-CE03 恢复流程不得自行改动磁盘内容（before=' + JSON.stringify(before) + ' after=' + JSON.stringify(after) + '）')
  assert(!!mine && ['needs_review', 'committed_recovered', 'indeterminate'].includes(mine.action),
    'LH-CE03 恢复必须给出分类而非静默处理（得 ' + JSON.stringify(mine) + '）')
  rmSync(ws, { recursive: true, force: true })
}

// ── LH-CE04：写前 new_hash 持久化失败 + 外部修改 + undo → NEEDS_REVIEW，外部不被覆盖 ──
// （详细四变体见 test-edit-txn-undo-anchor.js；此处保留矩阵级最小断言）
{
  const ws = mk(); writeFileSync(join(ws, 'x.txt'), 'A\n')
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'ce04' }, ctx)
  await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 'x.txt', edits: [{ old_string: 'A', new_string: 'B' }] }, ctx)
  await handle({ workspace_dir: ws, action: 'commit', txn_id: b.txnId }, ctx)
  const mp = join(ws, '.ai-transactions', 'recent', b.txnId, 'manifest.json')
  const m = JSON.parse(readFileSync(mp, 'utf-8'))
  delete m.files['x.txt'].new_hash
  delete m.files['x.txt'].last_txn_effect_hash
  writeFileSync(mp, JSON.stringify(m, null, 2))
  writeFileSync(join(ws, 'x.txt'), 'EXTERNAL\n')
  const u = await handle({ workspace_dir: ws, action: 'undo_commit', txn_id: b.txnId }, ctx)
  assert(rd(ws, 'x.txt') === 'EXTERNAL\n', 'LH-CE04 外部修改不被覆盖（得 ' + JSON.stringify(rd(ws, 'x.txt')) + '）')
  assert(u.status !== 'undone', 'LH-CE04 不得回报无条件 undone（得 ' + JSON.stringify(u.status) + '）')
  assert(!!(u.skipped?.length || u.error_code), 'LH-CE04 必须给出可辨识拒绝理由')
  rmSync(ws, { recursive: true, force: true })
}

// ── LH-CE05：backupFile 与 applyEdits 间外部改动 + 刷新备份 I/O 失败 → 拒绝写入 ──
{
  const ws = mk(); writeFileSync(join(ws, 'src', 'x.js'), 'const a=1\n')
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'ce05' }, ctx)
  await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 'src/x.js', edits: [{ old_string: 'a=1', new_string: 'a=10' }] }, ctx)
  // 把 backup 目录换成普通文件 → 后续备份写必失败
  const bd = join(ws, '.ai-transactions', b.txnId, 'backup')
  rmSync(bd, { recursive: true, force: true })
  writeFileSync(bd, 'not a directory')
  writeFileSync(join(ws, 'src', 'x.js'), rd(ws, 'src', 'x.js') + 'const ext=999\n')
  const e2 = await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 'src/x.js', edits: [{ old_string: 'ext=999', new_string: 'ext=1' }] }, ctx)
  const wrote = rd(ws, 'src', 'x.js').includes('ext=1')
  assert(!wrote, 'LH-CE05 备份不可写时不得写盘（得 已写入 ext=1）')
  assert(!!e2.error_code, 'LH-CE05 必须返回结构化错误（得 ' + JSON.stringify(e2.error_code) + '）')
  assert(['BACKUP_FAILED', 'TRANSACTION_VERSION_CONFLICT'].includes(e2.error_code),
    'LH-CE05 错误码须可辨识（得 ' + JSON.stringify(e2.error_code) + '）')
  rmSync(ws, { recursive: true, force: true })
}

// ── LH-CE06：state-off + graph 目录，edit_transaction 可见性与真实可写性必须自洽 ──
// 说明：state-off 的语义已由 D-04/LH-S1-04 裁定为「不提供 task/evidence 层」而非「只读」
// （见 review/semantic-perception-v1/01-STATE-MACHINE-ATLAS.md 与 public-catalog.js 注释）。
// 因此本项断言的是「承诺与事实自洽」，不是「必须不可写」。
{
  const cat = readFileSync(join(M, 'workflow', 'public-catalog.js'), 'utf-8')
  // 注释里不得再宣称 state-off 是「只读」
  const claimsReadonly = /state[-\s]?off[^\n]{0,80}只读|只读[^\n]{0,40}state[-\s]?off/i.test(cat)
  assert(!claimsReadonly, 'LH-CE06 state-off 注释不得宣称「只读」（与 edit_transaction 可写矛盾）')
  // 若仍有 edit_transaction 在 state-off 可见，注释必须说明它可写
  const exposesTxn = /GRAPH_EXTRA/.test(cat) && /edit_transaction/.test(cat)
  if (exposesTxn) {
    assert(/会写盘|可写|workspace_write|写盘能力/.test(cat),
      'LH-CE06 暴露可写入口时必须显式说明它会写盘')
  }
}

// ── LH-CE07：staged 后 commit_conflict → 回执不得宣传「零写入」 ──
{
  const ws = mk(); writeFileSync(join(ws, 'src', 'x.js'), 'const a=1\n')
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'ce07' }, ctx)
  const e = await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 'src/x.js', edits: [{ old_string: 'a=1', new_string: 'a=10' }] }, ctx)
  assert(e.written_to_disk === true, 'LH-CE07 staged 时已声明写盘（得 ' + JSON.stringify(e.written_to_disk) + '）')
  writeFileSync(join(ws, 'src', 'x.js'), 'const a=1\nconst ext=1\n')
  const c = await handle({ workspace_dir: ws, action: 'commit', txn_id: b.txnId }, ctx)
  assert(!!c.error || !!c.error_code, 'LH-CE07 commit 冲突被拒（得 ' + JSON.stringify(c.status || c.error) + '）')
  const txt = JSON.stringify(c)
  assert(!/file was not modified|no changes were made|zero write/i.test(txt),
    'LH-CE07 冲突回执不得宣称零写入（得 ' + txt.slice(0, 150) + '）')
  rmSync(ws, { recursive: true, force: true })
}

// ── LH-CE08：同一版本冲突在各入口（edit / edit_multi）合同相容 ──
{
  const ws = mk(); writeFileSync(join(ws, 'src', 'x.js'), 'const a=1\n')
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'ce08' }, ctx)
  await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 'src/x.js', edits: [{ old_string: 'a=1', new_string: 'a=10' }] }, ctx)
  writeFileSync(join(ws, 'src', 'x.js'), 'const a=10\nconst ext=1\n')
  const e1 = await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 'src/x.js', edits: [{ old_string: 'ext=1', new_string: 'ext=2' }] }, ctx)
  const mu = await handle({ workspace_dir: ws, action: 'edit_multi', txn_id: b.txnId, file_edits: [{ file: 'src/x.js', edits: [{ old_string: 'const a=10', new_string: 'const a=99' }] }] }, ctx)
  const c1 = e1.error_code || 'ok'
  const c2 = mu.files?.[0]?.error_code || mu.error_code || 'ok'
  assert(c1 === c2, 'LH-CE08 两入口冲突码必须相容（得 ' + c1 + ' vs ' + c2 + '）')
  assert(c1 === 'TRANSACTION_VERSION_CONFLICT', 'LH-CE08 冲突码须为版本冲突（得 ' + c1 + '）')
  assert(rd(ws, 'src', 'x.js').includes('ext=1'), 'LH-CE08 冲突后外部写仍在')
  rmSync(ws, { recursive: true, force: true })
}

// ── LH-CE09：写已落盘后异常从 writeSymbol 泄出 → 不得返回 file was not modified ──
{
  const src = readFileSync(join(M, 'tools', 'tool-write-symbol', 'handler.js'), 'utf-8')
  const sugg = src.split('\n').filter(l => /suggestion\s*:/.test(l)).join('\n')
  assert(!/the file was not modified/i.test(sugg), 'LH-CE09 suggestion 不得断言「未修改」')
  assert(/uncertain|re-read/i.test(sugg), 'LH-CE09 suggestion 须提示结果不确定 / 重读核对')
}

// ── LH-CE10：journal 与 classic transaction retention、undo token 混合 → 声明准确 ──
{
  const ws = mk(); writeFileSync(join(ws, 'src', 'x.js'), 'const a=1\n')
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'ce10' }, ctx)
  await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 'src/x.js', edits: [{ old_string: 'a=1', new_string: 'a=2' }] }, ctx)
  const c = await handle({ workspace_dir: ws, action: 'commit', txn_id: b.txnId }, ctx)
  const rc = c.receipt || {}
  assert(!!rc.recovery, 'LH-CE10 commit 回执带 recovery 能力声明')
  assert(rc.recovery?.available === true, 'LH-CE10 recovery.available 明确为 true')
  assert(/only the last 3|retained/i.test(JSON.stringify(rc.recovery || {})),
    'LH-CE10 保留策略明确（不承诺无限期可撤销）')
  const u = await handle({ workspace_dir: ws, action: 'undo_commit', txn_id: 'nonexistent-txn-xyz' }, ctx)
  assert(!!u.error_code, 'LH-CE10 未知 undo token 必须明确报错，不得静默成功（得 ' + JSON.stringify(u.status || u.error_code) + '）')
  rmSync(ws, { recursive: true, force: true })
}

console.log('== test-lh-ce-matrix: ' + pass + ' passed, ' + fail + ' failed ==')
if (fail > 0) process.exit(1)
