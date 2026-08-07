// test-edit-transaction-ext.js — 事务分支补测（Y001-S4）
// 覆盖：edit_multi 多文件 / broadcast / atomic 失败回滚 / atomic=false 部分成功 /
//       undo_commit 恢复 + 链上限 3 / rollback 恢复 / name 净化 / 路径拦截
//       R22-⑳ 连续 begin 第一个活跃事务不被自愈误清（冻结期工作流实测 P1）
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}
const { handle } = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-edit-transaction', 'handler.js')).href)

const ws = join(os.tmpdir(), 'opencode', 'txn-ext-ws')
rmSync(ws, { recursive: true, force: true })
mkdirSync(ws, { recursive: true })
const ctx = { codeIndexService: null }
const f = (n, c) => writeFileSync(join(ws, n), c)

// ── ① edit_multi 多文件（file_edits per-file）→ staged 2 成功 ──
{
  f('a.js', 'const x = 1\n')
  f('b.js', 'const y = 2\n')
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'multi' }, ctx)
  const r = await handle({ workspace_dir: ws, action: 'edit_multi', txn_id: b.txnId, file_edits: [
    { file: 'a.js', edits: [{ old_string: 'const x = 1', new_string: 'const x = 10' }] },
    { file: 'b.js', edits: [{ old_string: 'const y = 2', new_string: 'const y = 20' }] },
  ] }, ctx)
  assert(r.status === 'staged' && r.summary.success === 2 && r.summary.failed === 0, `① 多文件 staged 2/0（得 ${JSON.stringify(r.summary)}）`)
  assert(readFileSync(join(ws, 'a.js'), 'utf-8').includes('const x = 10'), '① a.js 已改')
  assert(readFileSync(join(ws, 'b.js'), 'utf-8').includes('const y = 20'), '① b.js 已改')
  await handle({ workspace_dir: ws, action: 'rollback', txn_id: b.txnId }, ctx)
}

// ── ② edit_multi broadcast（files + edits 广播） ──
{
  f('c1.js', 'aaa\n')
  f('c2.js', 'aaa\n')
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'bcast' }, ctx)
  const r = await handle({ workspace_dir: ws, action: 'edit_multi', txn_id: b.txnId, files: ['c1.js', 'c2.js'], edits: [{ old_string: 'aaa', new_string: 'bbb' }] }, ctx)
  assert(r.status === 'staged' && r.summary.success === 2, `② broadcast 2 成功（得 ${JSON.stringify(r.summary)}）`)
  assert(readFileSync(join(ws, 'c2.js'), 'utf-8').trim() === 'bbb', '② c2.js 广播生效')
  await handle({ workspace_dir: ws, action: 'rollback', txn_id: b.txnId }, ctx)
}

// ── ③ edit_multi atomic=false 部分成功：B 文件失败不中断 ──
{
  f('d1.js', 'keep\n')
  f('d2.js', 'orig\n')
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'partial' }, ctx)
  const r = await handle({ workspace_dir: ws, action: 'edit_multi', txn_id: b.txnId, atomic: false, file_edits: [
    { file: 'd1.js', edits: [{ old_string: 'keep', new_string: 'changed' }] },
    { file: 'd2.js', edits: [{ old_string: 'nonexistent', new_string: 'x' }] },
  ] }, ctx)
  assert(r.status === 'staged' && r.summary.success === 1 && r.summary.failed === 1, `③ 部分成功 1/1（得 ${JSON.stringify(r.summary)}）`)
  assert(readFileSync(join(ws, 'd1.js'), 'utf-8').includes('changed'), '③ d1 已改')
  assert(readFileSync(join(ws, 'd2.js'), 'utf-8').trim() === 'orig', '③ d2 未动')
  await handle({ workspace_dir: ws, action: 'rollback', txn_id: b.txnId }, ctx)
  assert(readFileSync(join(ws, 'd1.js'), 'utf-8').trim() === 'keep', '③ rollback 后 d1 恢复')
}

// ── ④ edit_multi atomic=true 失败 → rolled_back + 文件恢复 ──
{
  f('e1.js', 'aaa\n')
  f('e2.js', 'orig\n')
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'atomicfail' }, ctx)
  const r = await handle({ workspace_dir: ws, action: 'edit_multi', txn_id: b.txnId, file_edits: [
    { file: 'e1.js', edits: [{ old_string: 'aaa', new_string: 'bbb' }] },
    { file: 'e2.js', edits: [{ old_string: 'nonexistent', new_string: 'x' }] },
  ] }, ctx)
  assert(r.status === 'rolled_back' && r.reason === 'atomic edit failed', `④ atomic 失败回滚（得 ${r.status}/${r.reason}）`)
  assert(readFileSync(join(ws, 'e1.js'), 'utf-8').trim() === 'aaa', '④ e1 已恢复原样')
  assert(readFileSync(join(ws, 'e2.js'), 'utf-8').trim() === 'orig', '④ e2 未动')
}

// ── ⑤ undo_commit：commit 后撤销恢复 backup ──
{
  f('u.js', 'before undo\n')
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'undome' }, ctx)
  await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 'u.js', edits: [{ old_string: 'before undo', new_string: 'after edit' }] }, ctx)
  const cm = await handle({ workspace_dir: ws, action: 'commit', txn_id: b.txnId }, ctx)
  assert(cm.status === 'committed', `⑤ commit（得 ${cm.status}）`)
  assert(readFileSync(join(ws, 'u.js'), 'utf-8').includes('after edit'), '⑤ 提交后文件已改')
  const un = await handle({ workspace_dir: ws, action: 'undo_commit', txn_id: b.txnId }, ctx)
  assert(un.status === 'undone' && un.files_restored === 1, `⑤ undo_commit 恢复（得 ${JSON.stringify(un)}）`)
  assert(readFileSync(join(ws, 'u.js'), 'utf-8').includes('before undo'), '⑤ 撤销后文件恢复')
}

// ── ⑥ undo 链上限 3：第 4 个 commit 挤出最早 recent ──
{
  const ids = []
  for (let i = 0; i < 4; i++) {
    f(`q${i}.js`, `v${i}\n`)
    const b = await handle({ workspace_dir: ws, action: 'begin', name: `q${i}` }, ctx)
    await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: `q${i}.js`, edits: [{ old_string: `v${i}`, new_string: `v${i}-edited` }] }, ctx)
    await handle({ workspace_dir: ws, action: 'commit', txn_id: b.txnId }, ctx)
    ids.push(b.txnId)
  }
  const earlyUndo = await handle({ workspace_dir: ws, action: 'undo_commit', txn_id: ids[0] }, ctx)
  assert(earlyUndo.error_code === 'TXN_NOT_FOUND', `⑥ 最早 txn 被挤出不可 undo（得 ${earlyUndo.error_code}）`)
  const lastUndo = await handle({ workspace_dir: ws, action: 'undo_commit', txn_id: ids[3] }, ctx)
  assert(lastUndo.status === 'undone', `⑥ 最新 txn 可 undo（得 ${lastUndo.status}）`)
  assert(readFileSync(join(ws, 'q3.js'), 'utf-8').includes('v3'), '⑥ q3.js 已恢复')
}

// ── ⑦ begin name 净化（穿越字符剥离） + 非法 action ──
{
  const b = await handle({ workspace_dir: ws, action: 'begin', name: '../evil/name' }, ctx)
  assert(b.status === 'ok' && !b.txnId.includes('..') && !b.txnId.includes('/'), `⑦ name 净化（得 ${b.txnId}）`)
  assert(!existsSync(join(ws, '..', 'evil')), '⑦ 无穿越目录')
  await handle({ workspace_dir: ws, action: 'rollback', txn_id: b.txnId }, ctx)
  const bad = await handle({ workspace_dir: ws, action: 'nonsense' }, ctx)
  assert(bad.error_code === 'INVALID_ACTION', '⑦ 非法 action')
}

// ── ⑦b begin 中文 name 保留（R22-②：CJK 是合法 POSIX 路径字符，消毒不再剥除） ──
{
  const b = await handle({ workspace_dir: ws, action: 'begin', name: '回滚验证' }, ctx)
  assert(b.status === 'ok' && b.txnId.includes('回滚验证') && !b.txnId.includes('/'), `⑦b 中文 name 保留且无路径分隔符（得 ${b.txnId}）`)
  assert(!b.txnId.includes('..'), '⑦b 仍挡 .. 穿越')
  await handle({ workspace_dir: ws, action: 'rollback', txn_id: b.txnId }, ctx)
}

// ── ⑧ edit_multi 路径拦截 ──
{
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'esc' }, ctx)
  const r = await handle({ workspace_dir: ws, action: 'edit_multi', txn_id: b.txnId, file_edits: [
    { file: '../escape.js', edits: [{ old_string: 'x', new_string: 'y' }] },
  ] }, ctx)
  assert(r.summary.failed === 1 && r.files[0].error_code === 'PATH_BLOCKED', `⑧ edit_multi 穿越拦截（得 ${JSON.stringify(r.summary)}）`)
  await handle({ workspace_dir: ws, action: 'rollback', txn_id: b.txnId }, ctx)
}

// ── ⑨ edit_multi 参数校验 ──
{
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'argcheck' }, ctx)
  const noFe = await handle({ workspace_dir: ws, action: 'edit_multi', txn_id: b.txnId }, ctx)
  assert(noFe.error_code === 'INVALID_INPUT', '⑨ 缺 file_edits')
  const badFe = await handle({ workspace_dir: ws, action: 'edit_multi', txn_id: b.txnId, file_edits: [{ file: 'x.js' }] }, ctx)
  assert(badFe.error_code === 'INVALID_INPUT', '⑨ file_edits 缺 edits 数组')
  await handle({ workspace_dir: ws, action: 'rollback', txn_id: b.txnId }, ctx)
}

// ── ⑩ 已终结事务再 edit → TXN_NOT_FOUND（r50：此前 backupFile 读不存在 manifest 抛 ENOENT 裸异常） ──
{
  f('t.js', 'const t = 1\n')
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'stale' }, ctx)
  const rb = await handle({ workspace_dir: ws, action: 'rollback', txn_id: b.txnId }, ctx)
  assert(rb.status === 'rolled_back', '⑩ rollback 成功')
  let threw = false
  let r
  try {
    r = await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 't.js', edits: [{ old_string: 'const t = 1', new_string: 'const t = 2' }] }, ctx)
  } catch {
    threw = true
  }
  assert(!threw, '⑩ rollback 后再 edit 不抛异常')
  assert(r?.error_code === 'TXN_NOT_FOUND', `⑩ 返回 TXN_NOT_FOUND（得 ${r?.error_code}）`)
  assert(readFileSync(join(ws, 't.js'), 'utf-8').includes('const t = 1'), '⑩ 文件未被误改')
}

// ── ⑪ 父目录 .gitignore 已含条目 → 不创建子项目冗余 .gitignore（r50） ──
{
  const parentWs = join(ws, 'parent')
  const childWs = join(parentWs, 'child')
  mkdirSync(childWs, { recursive: true })
  writeFileSync(join(parentWs, '.gitignore'), '.ai-transactions/\n')
  const ch = await handle({ workspace_dir: childWs, action: 'begin', name: 'gitignore' }, ctx)
  assert(ch.status === 'ok', '⑪ 父级已忽略时 begin 正常')
  assert(!existsSync(join(childWs, '.gitignore')), '⑪ 不创建子项目 .gitignore')
  assert(existsSync(join(parentWs, '.gitignore')), '⑪ 父级 .gitignore 保留')
  await handle({ workspace_dir: childWs, action: 'rollback', txn_id: ch.txnId }, ctx)
}

// ⑫ R22-⑳：连续 begin——第二个 begin 的自愈不得误清第一个活跃空事务（旧逻辑当孤儿删 → TXN_NOT_FOUND）
{
  writeFileSync(join(ws, 'a.txt'), 'aaa')
  const b1 = await handle({ workspace_dir: ws, action: 'begin', name: 'wf-live-1' }, ctx)
  assert(b1.status === 'ok' && b1.txnId, `⑫ b1 begin（得 ${b1.status}）`)
  const b2 = await handle({ workspace_dir: ws, action: 'begin', name: 'wf-live-2' }, ctx)
  assert(b2.status === 'ok' && b2.txnId, `⑫ b2 begin（得 ${b2.status}）`)
  // b1 仍存活：edit 不报 TXN_NOT_FOUND
  const e1 = await handle({ workspace_dir: ws, action: 'edit', txn_id: b1.txnId, file: 'a.txt', edits: [{ old_string: 'aaa', new_string: 'aaa1' }] }, ctx)
  assert(e1.status === 'staged', `⑫ b1 编辑成功（得 ${e1.status}:${e1.error_code || ''}——旧实现 b2.begin 自愈误删 b1）`)
  // 收尾：两事务都正常提交
  const c1 = await handle({ workspace_dir: ws, action: 'commit', txn_id: b1.txnId }, ctx)
  const c2 = await handle({ workspace_dir: ws, action: 'commit', txn_id: b2.txnId }, ctx)
  assert((c1.status === 'committed' || c1.status === 'ok') && (c2.status === 'committed' || c2.status === 'ok'),
    `⑫ 双事务提交（${c1.status}/${c2.status}）`)
  // 真孤儿（created 超 60s）仍被清——手动改 manifest.created 模拟
  const b3 = await handle({ workspace_dir: ws, action: 'begin', name: 'wf-stale-orphan' }, ctx)
  const orphanDir = join(ws, '.ai-transactions', b3.txnId)
  const m = JSON.parse(readFileSync(join(orphanDir, 'manifest.json'), 'utf-8'))
  m.created = Date.now() - 120_000
  writeFileSync(join(orphanDir, 'manifest.json'), JSON.stringify(m, null, 2))
  const { recoverTransactions } = await import(pathToFileURL(join(__dirname, '..', 'write-journal.js')).href)
  const rec = await recoverTransactions(ws, {})
  assert(rec.some(r => r.txn_id === b3.txnId && r.action === 'orphan_removed'), `⑫ 超龄孤儿仍被清（得 ${JSON.stringify(rec.map(r => r.action))}）`)
}

// ⑬ R22-⑳（冻结期工作流实测 P1）：崩溃恢复标记 committed_recovered 的事务（在 txnRoot 顶层，不在 recent/）
// 可 undo——旧实现 undoCommit 只查 recent/ → TXN_NOT_FOUND，崩溃残留永远无法撤销
{
  writeFileSync(join(ws, 'a.txt'), 'aaa')
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'wf-recover-undo' }, ctx)
  assert(b.status === 'ok', `⑬ begin（得 ${b.status}）`)
  const e = await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 'a.txt', edits: [{ old_string: 'aaa', new_string: 'aaa2' }] }, ctx)
  assert(e.status === 'staged', `⑬ edit（得 ${e.status}）`)
  // 模拟崩溃恢复：目录留在顶层（不移动 recent）+ state 标记 committed_recovered
  const txnDir = join(ws, '.ai-transactions', b.txnId)
  assert(!existsSync(join(ws, '.ai-transactions', 'recent', b.txnId)), '⑬ 前置：目录在顶层（不在 recent/）')
  const m = JSON.parse(readFileSync(join(txnDir, 'manifest.json'), 'utf-8'))
  m.state = 'committed_recovered'
  writeFileSync(join(txnDir, 'manifest.json'), JSON.stringify(m, null, 2))
  // 正常路径：undo 顶层 committed_recovered 事务成功
  const u = await handle({ workspace_dir: ws, action: 'undo_commit', txn_id: b.txnId }, ctx)
  assert(u.status === 'undone' && u.files_restored === 1, `⑬ undo committed_recovered（得 ${u.status}:${u.error_code || ''}——旧实现 TXN_NOT_FOUND）`)
  assert(readFileSync(join(ws, 'a.txt'), 'utf8') === 'aaa', '⑬ 文件已回滚')
  assert(!existsSync(txnDir), '⑬ 事务目录已清')
  // 失败路径：顶层 staged（非 committed_recovered）不被误撤
  const b2 = await handle({ workspace_dir: ws, action: 'begin', name: 'wf-recover-staged' }, ctx)
  await handle({ workspace_dir: ws, action: 'edit', txn_id: b2.txnId, file: 'a.txt', edits: [{ old_string: 'aaa', new_string: 'aaa3' }] }, ctx)
  const u2 = await handle({ workspace_dir: ws, action: 'undo_commit', txn_id: b2.txnId }, ctx)
  assert(u2.error_code === 'TXN_NOT_FOUND', `⑬ 顶层 staged 不误撤（得 ${u2.status}:${u2.error_code || ''}）`)
  assert(readFileSync(join(ws, 'a.txt'), 'utf8') === 'aaa3', '⑬ staged 文件未被 undo 动')
  await handle({ workspace_dir: ws, action: 'rollback', txn_id: b2.txnId }, ctx)
  // 失败路径：顶层非 committed_recovered 终态（abandoned）不误撤
  const b3 = await handle({ workspace_dir: ws, action: 'begin', name: 'wf-recover-abandoned' }, ctx)
  await handle({ workspace_dir: ws, action: 'edit', txn_id: b3.txnId, file: 'a.txt', edits: [{ old_string: 'aaa', new_string: 'aaa4' }] }, ctx)
  const t3 = join(ws, '.ai-transactions', b3.txnId)
  const m3 = JSON.parse(readFileSync(join(t3, 'manifest.json'), 'utf-8'))
  m3.state = 'abandoned'
  writeFileSync(join(t3, 'manifest.json'), JSON.stringify(m3, null, 2))
  const u3 = await handle({ workspace_dir: ws, action: 'undo_commit', txn_id: b3.txnId }, ctx)
  assert(u3.error_code === 'TXN_NOT_FOUND', `⑬ 顶层 abandoned 不误撤（得 ${u3.status}:${u3.error_code || ''}）`)
}

rmSync(ws, { recursive: true, force: true })

console.log(`== test-edit-transaction-ext: ${pass} passed, ${fail} failed ==`)
if (fail > 0) process.exit(1)
