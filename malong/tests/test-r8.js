// test-r8.js — 第八轮审计修复锁定
// 覆盖：transaction-store symlink 逃逸 + 植入 manifest 越界 + txnId 消毒（B1/B2）、
//       read-symbol symlink 守卫（B3）、security-review glob ** 段上限（C1）、
//       _cleanRecent commit 时间淘汰（D4）、write_symbols 批次标记清理（F10）。
import { join, dirname, basename } from 'node:path'
import { mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MALONG = dirname(__dirname)
const imp = (p) => import(pathToFileURL(p).href)

let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`) } else { fail++; console.error(`  ✗ FAIL: ${msg}`) }
}
const tmp = (tag) => {
  const ws = join(os.tmpdir(), 'opencode', `r8-${tag}-${process.pid}`)
  rmSync(ws, { recursive: true, force: true })
  mkdirSync(ws, { recursive: true })
  return ws
}

// ── B1：edit_transaction applyEdits 写穿 symlink → 拒绝 ──
console.log('── B1 transaction-store symlink escape ──')
{
  const { TransactionStore } = await imp(join(MALONG, 'tools/tool-edit-transaction/transaction-store.js'))
  const ws = tmp('symlink')
  const outside = join(ws, '..', `r8-outside-${process.pid}.txt`)
  writeFileSync(outside, 'original-external')
  writeFileSync(join(ws, 'app.py'), 'return 1')
  try { symlinkSync(outside, join(ws, 'victim.py')) } catch (e) { console.error('  symlink failed:', e.message) }
  const store = new TransactionStore(ws)
  const txnId = store.begin('t1')
  const r = await store.applyEdits(txnId, 'victim.py', [{ old_string: 'original-external', new_string: 'PWNED' }])
  assert(r.error_code === 'PATH_BLOCKED' && /symlink escape/.test(r.message || ''), `写穿 symlink 应 PATH_BLOCKED（得 ${r.error_code}:${r.message}）`)
  assert(readFileSync(outside, 'utf-8') === 'original-external', `外部文件不应被改`)
  rmSync(ws, { recursive: true, force: true })
  rmSync(outside, { force: true })
}

// ── B2：植入 manifest 的 ../ fileRel → undoCommit/rollback 不越界写 ──
console.log('── B2 planted manifest escape blocked ──')
{
  const { TransactionStore } = await imp(join(MALONG, 'tools/tool-edit-transaction/transaction-store.js'))
  const ws = tmp('planted')
  const outside = join(ws, '..', `r8-planted-${process.pid}.txt`)
  writeFileSync(outside, 'safe')
  const recent = join(ws, '.ai-transactions', 'recent', 'evil')
  mkdirSync(join(recent, 'backup'), { recursive: true })
  writeFileSync(join(recent, 'manifest.json'), JSON.stringify({
    txnId: 'evil', created: 1,
    files: { [`../${basename(outside)}`]: { backupName: 'b', size: 4 } },
  }))
  writeFileSync(join(recent, 'backup', 'b'), 'PWNED')
  const store = new TransactionStore(ws)
  const r = await store.undoCommit('evil')
  assert(readFileSync(outside, 'utf-8') === 'safe', `植入 manifest 不应越界写（得 ${readFileSync(outside, 'utf-8')}）`)
  const r2 = await store.undoCommit('../../..')
  assert(r2.error_code === 'TXN_NOT_FOUND', `穿越 txnId 应被拒（得 ${r2.error_code}）`)
  rmSync(ws, { recursive: true, force: true })
  rmSync(outside, { force: true })
}

// ── B3：read_symbol 读穿 symlink → PATH_BLOCKED ──
console.log('── B3 read-symbol symlink guard ──')
{
  const { handle } = await imp(join(MALONG, 'tools/tool-read-symbol/handler.js'))
  const ws = tmp('rsym')
  const secret = join(ws, '..', `r8-secret-${process.pid}.key`)
  writeFileSync(secret, 'TOP-SECRET')
  writeFileSync(join(ws, 'real.js'), 'const x = 1')
  try { symlinkSync(secret, join(ws, 'notes.py')) } catch {}
  let r = await handle({ workspace_dir: ws, locator: { file_path: 'notes.py' } }, {})
  assert(r.error === 'PATH_BLOCKED', `symlink 指向 .key 应 PATH_BLOCKED（得 ${r.error}:${r.message}）`)
  rmSync(ws, { recursive: true, force: true })
  rmSync(secret, { force: true })
}

// ── C1：security-review glob ** 段 >3 → 条目跳过不挂 ──
console.log('── C1 security-review glob backtracking cap ──')
{
  const { handle } = await imp(join(MALONG, 'tools/tool-security-review/handler.js'))
  const ws = tmp('glob')
  const evil = { securityIgnore: [{ files: ['**/**/**/**/**/**/**/**/**/x'], rules: ['debug-log'] }] }
  writeFileSync(join(ws, '.ai-patterns.json'), JSON.stringify(evil))
  const deep = 'a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q/r/s/t/u/v/w/x/y/z/1/2/3/4/5/6/7/8/9/0'
  writeFileSync(join(ws, 'deep.js'), `console.log(${JSON.stringify(deep)})\n`)
  const t0 = Date.now()
  const r = await handle({ workspace_dir: ws, scope: '.' }, {})
  const elapsed = Date.now() - t0
  assert(elapsed < 3000, `9 段 ** glob 不应指数回溯（耗时 ${elapsed}ms）`)
  assert(Array.isArray(r.results), `扫描应正常返回`)
  rmSync(ws, { recursive: true, force: true })
}

// ── D4：_cleanRecent 按 commit 时间淘汰 ──
console.log('── D4 cleanRecent commit-time eviction ──')
{
  const { TransactionStore } = await imp(join(MALONG, 'tools/tool-edit-transaction/transaction-store.js'))
  const ws = tmp('recent')
  writeFileSync(join(ws, 'a.txt'), 'aaa')
  writeFileSync(join(ws, 'b.txt'), 'bbb')
  writeFileSync(join(ws, 'c.txt'), 'ccc')
  writeFileSync(join(ws, 'd.txt'), 'ddd')
  const store = new TransactionStore(ws)
  const A = store.begin('A')
  const B = store.begin('B')
  const C = store.begin('C')
  await store.backupFile(A, 'a.txt')
  await store.applyEdits(A, 'a.txt', [{ old_string: 'aaa', new_string: 'aaa1' }])
  await store.backupFile(B, 'b.txt')
  await store.applyEdits(B, 'b.txt', [{ old_string: 'bbb', new_string: 'bbb1' }])
  await store.backupFile(C, 'c.txt')
  await store.applyEdits(C, 'c.txt', [{ old_string: 'ccc', new_string: 'ccc1' }])
  store.commit(C)
  store.commit(B)
  store.commit(A)
  const D = store.begin('D')
  await store.backupFile(D, 'd.txt')
  await store.applyEdits(D, 'd.txt', [{ old_string: 'ddd', new_string: 'ddd1' }])
  store.commit(D)
  // 交错事务后：最晚提交的是 D 与 A——A 必须仍可 undo（旧实现按 begin mtime 会删掉 A）
  const r = await store.undoCommit(A)
  assert(r.status === 'undone', `A（次新提交）应可 undo（得 ${r.status}:${r.error_code || r.message || ''}）`)
  assert(readFileSync(join(ws, 'a.txt'), 'utf-8') === 'aaa', `A 的内容应被还原`)
  rmSync(ws, { recursive: true, force: true })
}

// ── F10：write_symbols 成功后批次标记清理 ──
console.log('── F10 batch marker cleanup ──')
{
  const { writeSymbols } = await imp(join(MALONG, 'write-runtime.js'))
  const ws = tmp('batch')
  writeFileSync(join(ws, 'f1.txt'), 'hello\n')
  writeFileSync(join(ws, 'f2.txt'), 'world\n')
  const ctx = { getWorkspaceDir: (w) => join(w, '.malong-ws') }
  const r = await writeSymbols({
    workspace_dir: ws,
    allow_unsafe_no_base: true,
    writes: [
      { file_path: 'f1.txt', edit_mode: 'patch', patch: { old_string: 'hello', new_string: 'hello1' } },
      { file_path: 'f2.txt', edit_mode: 'patch', patch: { old_string: 'world', new_string: 'world1' } },
    ],
  }, ctx)
  assert(r.success === true, `批量写应成功（得 ${JSON.stringify(r.error || r.success)}）`)
  const batches = join(ws, '.malong', 'batches')
  const left = existsSync(batches) ? readdirSync(batches).filter(f => f.endsWith('.json')) : []
  assert(left.length === 0, `批次标记应被清理（残留 ${left.length}）`)
  assert(readFileSync(join(ws, 'f1.txt'), 'utf-8') === 'hello1\n', `f1 内容正确`)
  rmSync(ws, { recursive: true, force: true })
}

// ── E1：锁续租（心跳期间 mtime 刷新） ──
console.log('── E1 lock heartbeat keeps lock fresh ──')
{
  const { acquireLock } = await imp(join(MALONG, 'write-runtime.js'))
  const ws = tmp('hb')
  const f = join(ws, 'x.txt')
  writeFileSync(f, 'x')
  const l1 = await acquireLock(f, 1000)
  const mtime1 = statSync(`${f}.mlock`).mtimeMs
  await new Promise(r => setTimeout(r, 17000))
  const mtime2 = statSync(`${f}.mlock`).mtimeMs
  assert(mtime2 > mtime1, `持锁 17s 后锁 mtime 应被心跳刷新（${mtime1} → ${mtime2}）`)
  l1.release()
  rmSync(ws, { recursive: true, force: true })
}

console.log(`\ntest-r8: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
