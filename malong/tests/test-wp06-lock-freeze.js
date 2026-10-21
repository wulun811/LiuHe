// test-wp06-lock-freeze.js — WP06 并发/崩溃收口：锁冻结受控故障场景（真双进程）
// 实证 write-runtime.js r9(F2 注) 窗口：持锁进程同步长操作冻结事件循环 → 心跳停摆 →
// mtime 超 STALE_LOCK_MS → 另一进程盗锁（窗口存在性）；盗锁后原持有者醒来 release
// 不得删新锁（r54 token 保护，无二次破坏）。STALE/心跳经 MALONG_TEST_* 注入缩短窗口。
// 关联覆盖：正向续租 test-r8、batch lock pid 判活 test-r9:184、GC 保护 test-journal-prune、
// AC20/21/27 各有直接引用测试——本文件补 WP06 行动清单点名的唯一缺口。
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) { if (cond) { pass++; console.log(`  ✓ ${msg}`) } else { fail++; console.error(`  ✗ FAIL: ${msg}`) } }

const WS = join(os.tmpdir(), 'opencode', 'wp06-freeze-ws')
try { rmSync(WS, { recursive: true, force: true }) } catch {}
mkdirSync(join(WS, 'src'), { recursive: true })
const TARGET = join(WS, 'src', 't.js')
writeFileSync(TARGET, 'export function t() { return 1 }\n')

const STALE = 2000
const FREEZE = 4500
const env = {
  ...process.env,
  MALONG_TEST_STALE_LOCK_MS: String(STALE),
  MALONG_TEST_HEARTBEAT_MS: '400',
}

function runChild() {
  const lines = []
  const proc = spawn(process.execPath, [join(__dirname, 'fixtures', 'lock-freeze-child.mjs'), TARGET, String(FREEZE)], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  proc.stdout.setEncoding('utf-8')
  proc.stdout.on('data', (d) => { lines.push(...d.trim().split('\n')) })
  proc.stderr.setEncoding('utf-8')
  let err = ''
  proc.stderr.on('data', (d) => { err += d })
  const exited = new Promise((resolve) => proc.on('exit', (code) => resolve({ code, err })))
  return { lines, exited, has: (marker) => lines.includes(marker) }
}

function waitFor(predicate, ms, step = 25) {
  return new Promise((resolve) => {
    const start = Date.now()
    const t = setInterval(() => {
      if (predicate() || Date.now() - start > ms) { clearInterval(t); resolve(predicate()) }
    }, step)
  })
}

const { acquireLock } = await import('../write-runtime.js')

console.log('== 场景 1：同步冻结 → 盗锁窗口存在（r9(F2 注) 实证）==')
{
  const child = runChild()
  const ready = await waitFor(() => child.has('CHILD_READY'), 5000)
  assert(ready, '子进程已持锁（CHILD_READY）')
  assert(existsSync(`${TARGET}.mlock`), '锁文件存在')

  const t0 = Date.now()
  const lock = await acquireLock(TARGET, 15000)
  const waited = Date.now() - t0
  assert(!lock.locked, '父进程盗锁成功（等待者最终进入）')
  assert(waited >= STALE - 300, `盗锁发生在 STALE(${STALE}ms) 之后而非立即（等了 ${waited}ms）——陈旧判定成立，窗口真实存在`)

  const stolenContent = JSON.parse(readFileSync(`${TARGET}.mlock`, 'utf-8'))
  const parentHeldAtSteal = stolenContent.token
  assert(typeof parentHeldAtSteal === 'string' && parentHeldAtSteal.length > 0, '盗得的锁带父进程 token')

  console.log('== 场景 2：原持有者醒来 release → 不删新锁（r54 token 无二次破坏）==')
  const done = await waitFor(() => child.has('CHILD_DONE'), FREEZE + 5000)
  assert(done, '子进程忙等结束并 release（CHILD_DONE）')
  const after = existsSync(`${TARGET}.mlock`) ? JSON.parse(readFileSync(`${TARGET}.mlock`, 'utf-8')) : null
  assert(after !== null, '父进程的锁仍在（子进程 release 未删他人锁）')
  assert(after && after.token === parentHeldAtSteal, '锁 token 未变（无二次盗锁/覆盖）')

  lock.release()
  assert(!existsSync(`${TARGET}.mlock`), '父进程 release 正常清理自己的锁')
  const r = await child.exited
  assert(r.code === 0, `子进程干净退出（code=0，得 ${r.code}${r.err ? ' stderr=' + r.err.slice(0, 200) : ''}）`)
}

console.log('== 场景 3：无注入 env 时模块正常加载（生产默认路径不受影响）==')
{
  delete process.env.MALONG_TEST_STALE_LOCK_MS
  const mod = await import(`../write-runtime.js?probe-${Date.now()}`)
  assert(typeof mod.acquireLock === 'function', 'write-runtime 在无注入 env 下正常加载')
}

console.log(`\n=== test-wp06-lock-freeze: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
