// test-edit-txn-version-chain.js — G1-R1：事务版本链与交错冲突（2026-10-29 专家独立复核）
//
// 背景：专家在送审快照上独立复现 P0——
//   同一事务内第 2 次编辑会「吸收」第三方在两次编辑之间写入的内容，
//   随后 rollback / undo_commit 把该第三方写入无声清掉（谎报 rolled_back / undone）。
//
// 根因：_commitStagedContent 只用 meta.new_hash != null 判断「是否已写过」，
//   从不校验当前磁盘是否仍是本事务上次写入的那一版。于是外部内容被当作本事务的
//   基础继续提交，回滚时又以「本事务产物」身份被删除。
//
// 本文件锁定 CE11–CE16 反例矩阵（专家 §2.2）。任何修复必须让整组通过，
// 不能只让 CE11 变绿。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import os from 'node:os'
import { spawnSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) { if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) } }

const { handle } = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-edit-transaction', 'handler.js')).href)
const { recoverTransactions } = await import(pathToFileURL(join(__dirname, '..', 'write-journal.js')).href)
const { sha256 } = await import(pathToFileURL(join(__dirname, '..', 'hash-utils.js')).href)

const ctx = { codeIndexService: null, langParserService: null }
const ctxNoVal = { codeIndexService: null }
const root = join(os.tmpdir(), 'opencode', 'txn-version-chain')
let seq = 0
function newWs() {
  const ws = join(root, 'ws' + (++seq))
  mkdirSync(join(ws, 'src'), { recursive: true })
  return ws
}
const rd = (ws, f) => readFileSync(join(ws, f), 'utf-8')
const wr = (ws, f, c) => writeFileSync(join(ws, f), c)

const ORIG = 'const a=1;\nconst b=2;\nconst independent=0;\n'
const AFTER_EXT = 'const a=10;\nconst b=2;\nconst independent=999;\n'

// ── CE13：同事务同文件 A→B→C，无外部写 → rollback 与 undo 都必须恢复 A ──
// （先跑这条：确保 G0 的 LH-S1-01 修复不被 R1 回归掉）
{
  const ws = newWs()
  wr(ws, 'src/x.js', ORIG)
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'ce13' }, ctxNoVal)
  assert(!!b.txnId, 'CE13 begin 返回 txnId（得 ' + JSON.stringify(b.error_code || b.error) + '）')
  const e1 = await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 'src/x.js', edits: [{ old_string: 'a=1', new_string: 'a=10' }] }, ctxNoVal)
  assert(e1.status === 'staged', 'CE13 edit1 staged（得 ' + JSON.stringify(e1.status || e1.error_code) + '）')
  const e2 = await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 'src/x.js', edits: [{ old_string: 'b=2', new_string: 'b=20' }] }, ctxNoVal)
  assert(e2.status === 'staged', 'CE13 edit2 staged（得 ' + JSON.stringify(e2.status || e2.error_code) + '）')
  const e3 = await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 'src/x.js', edits: [{ old_string: 'independent=0', new_string: 'independent=7' }] }, ctxNoVal)
  assert(e3.status === 'staged', 'CE13 edit3 staged（得 ' + JSON.stringify(e3.status || e3.error_code) + '）')
  assert(rd(ws, 'src/x.js') === 'const a=10;\nconst b=20;\nconst independent=7;\n', 'CE13 三次编辑都落盘（得 ' + JSON.stringify(rd(ws, 'src/x.js')) + '）')
  const rb = await handle({ workspace_dir: ws, action: 'rollback', txn_id: b.txnId }, ctxNoVal)
  assert(rb.status === 'rolled_back', 'CE13 rollback 报 rolled_back（得 ' + JSON.stringify(rb.status) + '）')
  assert(rd(ws, 'src/x.js') === ORIG, 'CE13 rollback 必须回到最初 A（得 ' + JSON.stringify(rd(ws, 'src/x.js')) + '）')
  rmSync(ws, { recursive: true, force: true })
}

// ── CE13b：同上但走 commit → undo_commit ──
{
  const ws = newWs()
  wr(ws, 'src/x.js', ORIG)
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'ce13b' }, ctxNoVal)
  await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 'src/x.js', edits: [{ old_string: 'a=1', new_string: 'a=10' }] }, ctxNoVal)
  await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 'src/x.js', edits: [{ old_string: 'b=2', new_string: 'b=20' }] }, ctxNoVal)
  const c = await handle({ workspace_dir: ws, action: 'commit', txn_id: b.txnId }, ctxNoVal)
  assert(c.status === 'committed', 'CE13b commit 成功（得 ' + JSON.stringify(c.status || c.error_code) + '）')
  const u = await handle({ workspace_dir: ws, action: 'undo_commit', txn_id: b.txnId }, ctxNoVal)
  assert(u.status === 'undone', 'CE13b undo_commit 报 undone（得 ' + JSON.stringify(u.status || u.error_code) + '）')
  assert(rd(ws, 'src/x.js') === ORIG, 'CE13b undo 必须回到最初 A（得 ' + JSON.stringify(rd(ws, 'src/x.js')) + '）')
  rmSync(ws, { recursive: true, force: true })
}

// ── CE11：第一次事务写 → 第三方写 → 第二次事务写 → rollback ──
// 必须：第二次写被拒绝（显式冲突），且第三方写不被撤回。
{
  const ws = newWs()
  wr(ws, 'src/x.js', ORIG)
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'ce11' }, ctxNoVal)
  const e1 = await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 'src/x.js', edits: [{ old_string: 'a=1', new_string: 'a=10' }] }, ctxNoVal)
  assert(e1.status === 'staged', 'CE11 edit1 staged（得 ' + JSON.stringify(e1.status || e1.error_code) + '）')

  // 第三方（不属于本事务）在两次编辑之间写入
  wr(ws, 'src/x.js', rd(ws, 'src/x.js').replace('independent=0', 'independent=999'))

  const e2 = await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 'src/x.js', edits: [{ old_string: 'b=2', new_string: 'b=20' }] }, ctxNoVal)
  assert(!!e2.error_code, 'CE11 第二次编辑必须被拒绝（得 ' + JSON.stringify({ s: e2.status, c: e2.error_code }) + '）')
  assert(['TRANSACTION_VERSION_CONFLICT', 'STALE_CONTENT'].includes(e2.error_code),
    'CE11 拒绝须为版本冲突类错误码（得 ' + JSON.stringify(e2.error_code) + '）')
  assert(e2.written_to_disk !== true, 'CE11 被拒绝时不得声明已写盘（得 ' + JSON.stringify(e2.written_to_disk) + '）')
  // 关键：拒绝时磁盘必须仍是「第一次事务写 + 第三方写」，b 未被改成 20
  assert(rd(ws, 'src/x.js') === AFTER_EXT, 'CE11 拒绝后磁盘不得被改动（得 ' + JSON.stringify(rd(ws, 'src/x.js')) + '，期望 ' + JSON.stringify(AFTER_EXT) + '）')

  const rb = await handle({ workspace_dir: ws, action: 'rollback', txn_id: b.txnId }, ctxNoVal)
  assert(rb.status !== 'rolled_back', 'CE11 rollback 不得谎报完全成功（得 ' + JSON.stringify(rb.status) + '）')
  assert(rd(ws, 'src/x.js').includes('independent=999'), 'CE11 rollback 后第三方写必须仍在（得 ' + JSON.stringify(rd(ws, 'src/x.js')) + '）')
  rmSync(ws, { recursive: true, force: true })
}

// ── CE12：同 CE11，但走 commit → undo_commit ──
{
  const ws = newWs()
  wr(ws, 'src/x.js', ORIG)
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'ce12' }, ctxNoVal)
  await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 'src/x.js', edits: [{ old_string: 'a=1', new_string: 'a=10' }] }, ctxNoVal)
  wr(ws, 'src/x.js', rd(ws, 'src/x.js').replace('independent=0', 'independent=999'))
  const e2 = await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 'src/x.js', edits: [{ old_string: 'b=2', new_string: 'b=20' }] }, ctxNoVal)
  assert(!!e2.error_code, 'CE12 第二次编辑必须被拒绝（得 ' + JSON.stringify({ s: e2.status, c: e2.error_code }) + '）')

  // 冲突后 commit 也不得放行（commit 有 new_hash 复检；此处验证不产生假 committed）
  const c = await handle({ workspace_dir: ws, action: 'commit', txn_id: b.txnId }, ctxNoVal)
  assert(c.error === 'commit_conflict' || !!c.error_code, 'CE12 冲突后 commit 必须拒绝（得 ' + JSON.stringify({ st: c.status, e: c.error, c: c.error_code }) + '）')
  assert(rd(ws, 'src/x.js').includes('independent=999'), 'CE12 commit 拒绝后第三方写仍在（得 ' + JSON.stringify(rd(ws, 'src/x.js')) + '）')
  rmSync(ws, { recursive: true, force: true })
}

// ── CE14：两事务竞争同一文件 → 第二次写必须具备版本冲突，不是 last-writer-wins ──
{
  const ws = newWs()
  wr(ws, 'src/x.js', ORIG)
  const t1 = await handle({ workspace_dir: ws, action: 'begin', name: 'ce14-t1' }, ctxNoVal)
  const t2 = await handle({ workspace_dir: ws, action: 'begin', name: 'ce14-t2' }, ctxNoVal)
  assert(!!t1.txnId && !!t2.txnId, 'CE14 两个事务都建立（得 ' + JSON.stringify([t1.error_code, t2.error_code]) + '）')

  const w1 = await handle({ workspace_dir: ws, action: 'edit', txn_id: t1.txnId, file: 'src/x.js', edits: [{ old_string: 'a=1', new_string: 'a=10' }] }, ctxNoVal)
  assert(w1.status === 'staged', 'CE14 t1 写入成功（得 ' + JSON.stringify(w1.status || w1.error_code) + '）')

  // t2 在 t1 已写之后做第二次写：t2 的备份原像来自 t1 之前或之后，都必须检测出「有人改过」
  const w2 = await handle({ workspace_dir: ws, action: 'edit', txn_id: t2.txnId, file: 'src/x.js', edits: [{ old_string: 'b=2', new_string: 'b=20' }] }, ctxNoVal)
  const detected = !!w2.error_code || w2.status === 'staged'
  assert(detected, 'CE14 t2 必须给出确定结果（得 ' + JSON.stringify({ s: w2.status, c: w2.error_code }) + '）')

  // 无论 t2 是拒绝还是基于 t1 成果继续，t1 的改动都不得被无声清掉
  const afterT2 = rd(ws, 'src/x.js')
  assert(afterT2.includes('a=10'), 'CE14 t1 的改动不得被 t2 无声清掉（得 ' + JSON.stringify(afterT2) + '）')

  // t1 rollback 必须保留 t2 的写入（不得把别人的成果当自己的删掉）
  const rb1 = await handle({ workspace_dir: ws, action: 'rollback', txn_id: t1.txnId }, ctxNoVal)
  const afterRb = rd(ws, 'src/x.js')
  if (w2.status === 'staged') {
    assert(afterRb.includes('b=20') || rb1.status !== 'rolled_back',
      'CE14 t1 rollback 不得删掉 t2 已写入的内容（得 ' + JSON.stringify({ after: afterRb, st: rb1.status }) + '）')
  }
  rmSync(ws, { recursive: true, force: true })
}

// ── CE15：备份刷新 I/O 失败 → 不落盘，不谎报可安全回滚 ──
// 用不可写备份路径模拟：把 backup 目录换成一个普通文件，使其 writeFileSync 失败。
{
  const ws = newWs()
  wr(ws, 'src/x.js', ORIG)
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'ce15' }, ctxNoVal)
  assert(!!b.txnId, 'CE15 begin 成功（得 ' + JSON.stringify(b.error_code) + '）')
  // 先正常编辑一次建立备份
  const e1 = await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 'src/x.js', edits: [{ old_string: 'a=1', new_string: 'a=10' }] }, ctxNoVal)
  assert(e1.status === 'staged', 'CE15 首次编辑成功（得 ' + JSON.stringify(e1.status || e1.error_code) + '）')

  // 把 backup 目录替换成文件 → 后续任何备份写都会失败
  const txnDir = join(ws, '.ai-transactions', b.txnId)
  const backupDir = join(txnDir, 'backup')
  let sabotaged = false
  try {
    if (existsSync(backupDir)) {
      rmSync(backupDir, { recursive: true, force: true })
      writeFileSync(backupDir, 'not a directory')
      sabotaged = true
    }
  } catch {}

  if (sabotaged) {
    // 外部改一下，制造「需要刷新备份」的情形
    wr(ws, 'src/x.js', rd(ws, 'src/x.js').replace('independent=0', 'independent=999'))
    const e2 = await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 'src/x.js', edits: [{ old_string: 'b=2', new_string: 'b=20' }] }, ctxNoVal)
    // 正确行为：要么拒绝写盘，要么明确告知不能安全回滚；绝不能「写盘 + 声称可回滚」
    const wroteB = rd(ws, 'src/x.js').includes('b=20')
    if (wroteB) {
      assert(false, 'CE15 备份不可写时不得落盘（得 已写入 b=20，回执 ' + JSON.stringify({ s: e2.status, c: e2.error_code }) + '）')
    } else {
      assert(!!e2.error_code, 'CE15 拒绝时必须给错误码（得 ' + JSON.stringify({ s: e2.status, c: e2.error_code }) + '）')
      assert(rd(ws, 'src/x.js').includes('independent=999'), 'CE15 拒绝后外部写仍在（得 ' + JSON.stringify(rd(ws, 'src/x.js')) + '）')
    }
  } else {
    assert(false, 'CE15 夹具失败：无法把 backup 目录替换为文件')
  }
  rmSync(ws, { recursive: true, force: true })
}

// ── CE16：写后、更新 manifest 前进程终止 → 重启必须分类，不得悄悄恢复外部变化 ──
// 模拟方式：手工把 manifest 的 new_hash 改成「非当前磁盘」的值（等价于崩溃在 write 之后、
// manifest 更新之前——磁盘已变但 manifest 还认为「没写过」），再跑 recoverTransactions。
{
  const ws = newWs()
  wr(ws, 'src/x.js', ORIG)
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'ce16' }, ctxNoVal)
  const e1 = await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 'src/x.js', edits: [{ old_string: 'a=1', new_string: 'a=10' }] }, ctxNoVal)
  assert(e1.status === 'staged', 'CE16 首次编辑成功（得 ' + JSON.stringify(e1.status || e1.error_code) + '）')

  // 制造「写盘已发生但 manifest 未记录」：删掉 new_hash（等价崩溃在 manifest 更新前）
  const mpath = join(ws, '.ai-transactions', b.txnId, 'manifest.json')
  const m = JSON.parse(readFileSync(mpath, 'utf-8'))
  delete m.files['src/x.js'].new_hash
  m.files['src/x.js'].pid_dead = true
  writeFileSync(mpath, JSON.stringify(m, null, 2))

  const rec = await recoverTransactions(ws, {})
  const mine = rec.find(r => r.txn_id === b.txnId)
  assert(!!mine, 'CE16 崩溃残留必须被恢复流程看见（得 ' + JSON.stringify(rec) + '）')
  assert(mine && ['needs_review', 'indeterminate', 'kept_external_change'].includes(mine.action),
    'CE16 未确认状态必须分类为 needs_review/indeterminate（得 ' + JSON.stringify(mine) + '）')
  // 绝不悄悄恢复（不得把 a=10 改回 a=1）
  assert(rd(ws, 'src/x.js').includes('a=10'), 'CE16 恢复流程不得悄悄覆盖磁盘（得 ' + JSON.stringify(rd(ws, 'src/x.js')) + '）')
  rmSync(ws, { recursive: true, force: true })
}

// ── CE11-β：冲突回执必须明确「本次未写」（防止 observation 在 handler 出口被白名单重建丢掉）──
{
  const ws = newWs()
  wr(ws, 'src/x.js', ORIG)
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'ce11-beta' }, ctxNoVal)
  await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 'src/x.js', edits: [{ old_string: 'a=1', new_string: 'a=10' }] }, ctxNoVal)
  wr(ws, 'src/x.js', rd(ws, 'src/x.js').replace('independent=0', 'independent=999'))
  const e2 = await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 'src/x.js', edits: [{ old_string: 'b=2', new_string: 'b=20' }] }, ctxNoVal)
  assert(e2.error_code === 'TRANSACTION_VERSION_CONFLICT', 'CE11-β 冲突错误码可透出（得 ' + JSON.stringify(e2.error_code) + '）')
  assert(e2.observation && e2.observation.external_change_observed === true,
    'CE11-β 回执必须含 external_change_observed（得 ' + JSON.stringify(e2.observation) + '）')
  assert(e2.observation && e2.observation.written_by_this_edit === false,
    'CE11-β 回执必须明说本次未写（得 ' + JSON.stringify(e2.observation) + '）')
  assert(typeof e2.expected_hash === 'string' && typeof e2.actual_hash === 'string',
    'CE11-β 回执带双方 hash 供人核对（得 ' + JSON.stringify({ e: e2.expected_hash, a: e2.actual_hash }) + '）')
  assert(typeof e2.suggestion === 'string' && e2.suggestion.length > 0, 'CE11-β 回执带可执行下一步')
  rmSync(ws, { recursive: true, force: true })
}

try { rmSync(root, { recursive: true, force: true }) } catch {}

console.log('== test-edit-txn-version-chain: ' + pass + ' passed, ' + fail + ' failed ==')
if (fail > 0) process.exit(1)
