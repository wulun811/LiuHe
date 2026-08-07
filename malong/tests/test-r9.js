// test-r9.js — 第九轮审计修复锁定
// 覆盖：validateFilePath 段级正则（P8）、锁超时安全释放（P1）、batch-edit 写守卫+唯一 tmp（P2/P3）、
//       rollback backupName 读穿守卫+计数（P6/P7）、best_effort 批次不回滚（F4）、txn 泄漏清扫（H11）、
//       security-review glob 跳过标注（H6）、错误契约归一化（H10）、双 daemon 启动竞态（B8）。
import { join, dirname, basename } from 'node:path'
import { mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync, readFileSync, readdirSync, utimesSync } from 'node:fs'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MALONG = dirname(__dirname)
const imp = (p) => import(pathToFileURL(p).href)

let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`) } else { fail++; console.error(`  ✗ FAIL: ${msg}`) }
}
const tmp = (tag) => {
  const ws = join(os.tmpdir(), 'opencode', `r9-${tag}-${process.pid}`)
  rmSync(ws, { recursive: true, force: true })
  mkdirSync(ws, { recursive: true })
  return ws
}

// ── P8：validateFilePath 段级匹配（foo..bar.txt 合法；../ 拦截） ──
console.log('── P8 validateFilePath segment regex ──')
{
  const { validateFilePath } = await imp(join(MALONG, 'error-codes.js'))
  assert(validateFilePath('foo..bar.txt').ok === true, 'foo..bar.txt 合法文件名放行')
  assert(validateFilePath('v1.0..1.js').ok === true, 'v1.0..1.js 放行')
  assert(validateFilePath('../x').blocked === true, '../x 拦截')
  assert(validateFilePath('a/../b').blocked === true, 'a/../b 拦截')
  assert(validateFilePath('..').blocked === true, '.. 拦截')
}

// ── P1：acquireLock 超时返回安全对象（不抛 TypeError） ──
console.log('── P1 lock timeout safe object ──')
{
  const { acquireLock } = await imp(join(MALONG, 'write-runtime.js'))
  const ws = tmp('lock')
  const target = join(ws, 'f.txt')
  writeFileSync(target, 'x')
  const lockPath = `${target}.mlock`
  writeFileSync(lockPath, JSON.stringify({ pid: 999999, token: 'other', ts: Date.now() }))
  utimesSync(lockPath, new Date(), new Date())
  const l = await acquireLock(target, 300)
  assert(l.locked === true, '300ms 争用超时返回 locked')
  assert(typeof l.release === 'function', '超时对象带安全空 release（旧实现 undefined → TypeError）')
  l.release()
  rmSync(ws, { recursive: true, force: true })
}

// ── P2/P3：batch-edit delegateWrite symlink 守卫 + 不写穿 ──
console.log('── P2 batch-edit write guard ──')
{
  const { delegateWrite } = await imp(join(MALONG, 'tools/tool-batch-edit/handler.js'))
  const ws = tmp('batch')
  const outside = join(ws, '..', `r9-outside-${process.pid}.txt`)
  writeFileSync(outside, 'ORIGINAL')
  symlinkSync(outside, join(ws, 'victim.txt'))
  const r = await delegateWrite({
    absPath: join(ws, 'victim.txt'),
    filePath: 'victim.txt',
    workspaceDir: ws,
    originalContent: 'ORIGINAL',
    finalContent: 'EVIL',
  })
  assert(r.error?.code === 'PATH_BLOCKED', `symlink 写穿被拒（得 ${JSON.stringify(r.error)}）`)
  assert(readFileSync(outside, 'utf-8') === 'ORIGINAL', '外部文件未被写入')
  rmSync(outside, { force: true })
  rmSync(ws, { recursive: true, force: true })
}

// ── P6/P7：rollback 植入绝对 backupName → 跳过+计数，不读穿 ──
console.log('── P6/P7 rollback backupName guard + honest count ──')
{
  const { TransactionStore } = await imp(join(MALONG, 'tools/tool-edit-transaction/transaction-store.js'))
  const ws = tmp('backup')
  writeFileSync(join(ws, 'a.txt'), 'v1')
  const store = new TransactionStore(ws)
  const txnId = store.begin('t')
  await store.backupFile(txnId, 'a.txt')
  writeFileSync(join(ws, 'a.txt'), 'v2')
  // 植入 manifest：backupName 带 .. 穿越（join 会吸收绝对路径，.. 段才会真正逃出 backupDir）
  const txnDir = join(ws, '.ai-transactions', txnId)
  const manifestPath = join(txnDir, 'manifest.json')
  const m = JSON.parse(readFileSync(manifestPath, 'utf-8'))
  m.files['a.txt'].backupName = 'sub/../../../../etc/hostname'
  writeFileSync(manifestPath, JSON.stringify(m, null, 2))
  const r = await store.rollback(txnId)
  assert(r.files_restored === 0, `恶意 backupName 不算恢复数（得 ${r.files_restored}）`)
  assert(Array.isArray(r.skipped) && r.skipped.some(s => s.reason === 'backup_escape'), `skipped 列出 backup_escape（得 ${JSON.stringify(r.skipped)}）`)
  assert(readFileSync(join(ws, 'a.txt'), 'utf-8') === 'v2', '文件保持 v2 未被 /etc/hostname 内容覆盖')
  rmSync(ws, { recursive: true, force: true })
}

// ── F4：best_effort 批次崩溃恢复不回滚已提交文件 ──
console.log('── F4 best_effort batch no-rollback ──')
{
  const jr = await imp(join(MALONG, 'write-journal.js'))
  const { sha256 } = await imp(join(MALONG, 'hash-utils.js'))
  const ws = tmp('beb')
  mkdirSync(join(ws, '.malong', 'journal'), { recursive: true })
  writeFileSync(join(ws, 'a1.txt'), 'v2')
  const j1 = jr.createJournal(ws, 'a1.txt', join(ws, 'a1.txt'), 'v1', { editMode: 'patch', state: 'staged' })
  jr.updateJournalState(j1.dir, { state: 'staged', new_hash: sha256('v2') })
  jr.updateJournalState(j1.dir, { state: 'committed', committed_at: new Date().toISOString() })
  writeFileSync(join(ws, 'a2.txt'), 'v1')
  const j2 = jr.createJournal(ws, 'a2.txt', join(ws, 'a2.txt'), 'v1', { editMode: 'patch', state: 'staged' })
  jr.updateJournalState(j2.dir, { state: 'staged', new_hash: sha256('v2') })
  const mb = jr.createBatchMarker(ws, ['a1.txt', 'a2.txt'], 'best_effort')
  jr.updateBatchMarker(ws, mb.batchId, { txnIds: [j1.txnId, j2.txnId] })
  jr.releaseBatchLock(ws)
  const rec = await jr.recoverJournals(ws)
  assert(!rec.some(r => r.action === 'batch_partial_rollback'), 'best_effort 批次不回滚已提交文件')
  assert(readFileSync(join(ws, 'a1.txt'), 'utf-8') === 'v2', 'a1 保持 v2（用户可见的成功结果未被撤销）')
  rmSync(ws, { recursive: true, force: true })
}

// ── F4b：strict 批次崩溃于 marker.txnIds 滞后窗口（f1 已提交、f2 journal 未建）必须回滚 f1 ──
console.log('── F4b strict batch marker-lag window rollback ──')
{
  const jr = await imp(join(MALONG, 'write-journal.js'))
  const { sha256 } = await imp(join(MALONG, 'hash-utils.js'))
  const ws = tmp('lag')
  mkdirSync(join(ws, '.malong', 'journal'), { recursive: true })
  writeFileSync(join(ws, 'a1.txt'), 'v2')
  const j1 = jr.createJournal(ws, 'a1.txt', join(ws, 'a1.txt'), 'v1', { editMode: 'patch', state: 'staged' })
  jr.updateJournalState(j1.dir, { state: 'staged', new_hash: sha256('v2') })
  jr.updateJournalState(j1.dir, { state: 'committed', committed_at: new Date().toISOString() })
  // 崩溃点：f2 createJournal 前——marker.txnIds 只有 [t1]（滞后），但 marker.files 是全集
  const mb = jr.createBatchMarker(ws, ['a1.txt', 'a2.txt'], 'strict')
  jr.updateBatchMarker(ws, mb.batchId, { txnIds: [j1.txnId] })
  jr.releaseBatchLock(ws)
  const rec = await jr.recoverJournals(ws)
  assert(rec.some(r => r.action === 'batch_partial_rollback'), 'F4b: strict 批次 marker 滞后窗口必须回滚已提交 f1')
  assert(readFileSync(join(ws, 'a1.txt'), 'utf-8') === 'v1', 'F4b: a1 回滚到 v1（半批不残留）')
  // 旧 marker 无 files 字段（兼容）：退化为 txnIds 判定（1<1 不回滚——保持旧行为，不误回滚）
  rmSync(ws, { recursive: true, force: true })
  const ws2 = tmp('lag2')
  mkdirSync(join(ws2, '.malong', 'journal'), { recursive: true })
  writeFileSync(join(ws2, 'a1.txt'), 'v2')
  const j1b = jr.createJournal(ws2, 'a1.txt', join(ws2, 'a1.txt'), 'v1', { editMode: 'patch', state: 'staged' })
  jr.updateJournalState(j1b.dir, { state: 'staged', new_hash: sha256('v2') })
  jr.updateJournalState(j1b.dir, { state: 'committed', committed_at: new Date().toISOString() })
  const mbOld = jr.createBatchMarker(ws2, ['a1.txt', 'a2.txt'], 'strict')
  jr.updateBatchMarker(ws2, mbOld.batchId, { txnIds: [j1b.txnId] })
  const markerPath = join(ws2, '.malong', 'batches', mbOld.batchId + '.json')
  const m2 = JSON.parse(readFileSync(markerPath, 'utf-8'))
  delete m2.files
  writeFileSync(markerPath, JSON.stringify(m2))
  jr.releaseBatchLock(ws2)
  const rec2 = await jr.recoverJournals(ws2)
  assert(!rec2.some(r => r.action === 'batch_partial_rollback'), 'F4b: 旧 marker 无 files 退化 txnIds 判定（不误回滚）')
  rmSync(ws2, { recursive: true, force: true })
}

// ── F4c：R22-⑯ 批次锁——存活批次不被并发恢复踩踏；锁释放后恢复正常回滚；并发建批次 BATCH_LOCK_BUSY ──
console.log('── F4c batch lock: live batch protected, stale batch recoverable, concurrent create busy ──')
{
  const jr = await imp(join(MALONG, 'write-journal.js'))
  const { sha256 } = await imp(join(MALONG, 'hash-utils.js'))
  const ws = tmp('lock')
  mkdirSync(ws, { recursive: true })
  writeFileSync(join(ws, 'f1.js'), 'let f1 = 2;')
  writeFileSync(join(ws, 'f2.js'), 'let f2 = 1;')
  const j1 = jr.createJournal(ws, 'f1.js', join(ws, 'f1.js'), 'let f1 = 1;', { editMode: 'patch' })
  jr.updateJournalState(j1.dir, { state: 'staged', new_hash: sha256('let f1 = 2;') })
  jr.updateJournalState(j1.dir, { state: 'committed' })
  const { batchId } = jr.createBatchMarker(ws, ['f1.js', 'f2.js'], 'strict')
  jr.updateBatchMarker(ws, batchId, { txnIds: [j1.txnId] })
  // ① 锁存活（批次运行中）→ recoverBatches 跳过，不踩踏
  const r1 = await jr.recoverJournals(ws)
  assert(!r1.some(r => r.action === 'batch_partial_rollback'), 'F4c: 存活批次不被并发恢复踩踏')
  assert(readFileSync(join(ws, 'f1.js'), 'utf-8') === 'let f1 = 2;', 'F4c: 存活批次 f1 保持新内容')
  // ② 锁释放（批次已死）→ 崩溃恢复正常回滚
  jr.releaseBatchLock(ws)
  const r2 = await jr.recoverJournals(ws)
  assert(r2.some(r => r.action === 'batch_partial_rollback'), 'F4c: 锁释放后恢复正常崩溃回滚')
  assert(readFileSync(join(ws, 'f1.js'), 'utf-8') === 'let f1 = 1;', 'F4c: f1 回滚到原内容')
  // ③ 并发建批次 → 第二个 BATCH_LOCK_BUSY
  const m1 = jr.createBatchMarker(ws, ['a'], 'strict')
  let busy = false
  try { jr.createBatchMarker(ws, ['b'], 'strict') } catch (e) { busy = e.code === 'BATCH_LOCK_BUSY' }
  jr.finishBatchMarker(ws, m1.batchId)
  assert(busy, 'F4c: 并发建批次 → BATCH_LOCK_BUSY')
  rmSync(ws, { recursive: true, force: true })
}
console.log('── H11 stale txn sweep ──')
{
  const { TransactionStore } = await imp(join(MALONG, 'tools/tool-edit-transaction/transaction-store.js'))
  const ws = tmp('sweep')
  const stale = join(ws, '.ai-transactions', 'orphan-txn')
  mkdirSync(join(stale, 'backup'), { recursive: true })
  writeFileSync(join(stale, 'manifest.json'), '{}')
  const old = new Date(Date.now() - 8 * 24 * 3600 * 1000)
  utimesSync(stale, old, old)
  const fresh = join(ws, '.ai-transactions', 'live-txn')
  mkdirSync(join(fresh, 'backup'), { recursive: true })
  writeFileSync(join(fresh, 'manifest.json'), '{}')
  const store = new TransactionStore(ws)
  assert(!existsSync(stale), '超龄（8 天）孤儿事务目录被清扫')
  assert(existsSync(fresh), '新鲜事务目录保留')
  rmSync(ws, { recursive: true, force: true })
}

// ── H6：security-review glob 超限跳过计数 ──
console.log('── H6 ignored_glob_entries visible ──')
{
  const sr = await imp(join(MALONG, 'tools/tool-security-review/handler.js'))
  const ws = tmp('glob')
  writeFileSync(join(ws, '.ai-patterns.json'), JSON.stringify({ securityIgnore: [{ files: ['a/**/b/**/c/**/d/**/e.js'], rules: ['sql-concat'] }] }))
  writeFileSync(join(ws, 'x.js'), 'let a = 1;')
  const r = await sr.handle({ workspace_dir: ws, scope: '.' }, {})
  assert(r.ignored_glob_entries === 1, `glob ** 段>3 跳过计数可见（得 ${r.ignored_glob_entries}）`)
  rmSync(ws, { recursive: true, force: true })
}

// ── H10：错误契约归一化（嵌套 {success:false, error:{code}} → error_code 取 code） ──
console.log('── H10 error normalization ──')
{
  const { default: ToolRegistry } = await imp(join(MALONG, 'tool-registry.js'))
  const usagePath = join(tmp('usage'), 'usage.jsonl')
  const reg = new ToolRegistry(join(MALONG, 'tools'), { usagePath })
  reg.tools.set('r9-stub', {
    description: 'stub',
    inputSchema: { type: 'object' },
    handler: async () => ({ success: false, error: { code: 'BOOM', message: 'kaboom' } }),
  })
  await reg.callTool('r9-stub', {}, {})
  const lines = readFileSync(usagePath, 'utf-8').trim().split('\n')
  const last = JSON.parse(lines[lines.length - 1])
  assert(last.error_code === 'BOOM', `嵌套错误形状归一化为 code（得 ${last.error_code}）`)
}

// ── B8：双 daemon 并发启动竞态（败者退出、pid 文件归胜者） ──
console.log('── B8 dual daemon startup race ──')
{
  const bin = join(MALONG, '..', '..', '..', 'malong-parse', 'target', 'release', 'malong-parse')
  if (!existsSync(bin)) {
    console.log('  (skip: release binary not built)')
    pass++
  } else {
    const sock = join(os.tmpdir(), 'opencode', `r9-race-${process.pid}.sock`)
    const env = { ...process.env, MALONG_SOCKET: sock }
    const spawnDaemon = () => new Promise((resolve) => {
      const child = spawn(bin, [], { env, stdio: 'ignore' })
      child.on('exit', (code) => resolve({ code }))
      child.unref?.()
    })
    const first = spawn(bin, [], { env, stdio: 'ignore' })
    // 等第一个 bind 成功
    let bound = false
    for (let i = 0; i < 50; i++) {
      await new Promise(r => setTimeout(r, 100))
      if (existsSync(sock)) { bound = true; break }
    }
    assert(bound, '第一个 daemon 绑定 socket')
    const second = await spawnDaemon()
    const pidFile = `${sock}.pid`
    const pidContent = existsSync(pidFile) ? readFileSync(pidFile, 'utf-8').trim() : ''
    assert(second.code !== null, `第二个 daemon 退出（败者经 pid 检查优雅退出或 bind 失败，code=${second.code}）`)
    assert(pidContent === String(first.pid), `pid 文件归胜者（得 ${pidContent}, 期望 ${first.pid}——败者未覆盖）`)
    // 胜者必须仍可服务（health 请求有响应）
    const net = await import('node:net')
    const health = await new Promise((resolve) => {
      const c = net.default.createConnection(sock)
      let buf = Buffer.alloc(0)
      const timer = setTimeout(() => { c.destroy(); resolve(null) }, 3000)
      c.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk])
        if (buf.length >= 4) {
          const len = buf.readUInt32BE(0)
          if (buf.length >= 4 + len) {
            clearTimeout(timer)
            c.destroy()
            resolve(JSON.parse(buf.slice(4, 4 + len).toString()))
          }
        }
      })
      const msg = JSON.stringify({ id: 'b8-health', method: 'health', params: {} })
      const body = Buffer.from(msg)
      const frame = Buffer.alloc(4 + body.length)
      frame.writeUInt32BE(body.length, 0)
      body.copy(frame, 4)
      c.write(frame)
    })
    assert(health !== null && health.result?.pid === first.pid, `胜者 daemon 存活并可服务（得 pid=${health?.result?.pid}, 期望 ${first.pid}）`)
    first.kill('SIGTERM')
    await new Promise(r => setTimeout(r, 500))
    try { rmSync(sock, { force: true }) } catch {}
    try { rmSync(`${sock}.pid`, { force: true }) } catch {}
  }
}

console.log(`\nr9: ${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
