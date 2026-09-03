// test-mcp-server-timeout.js — 二轮审查修复：工具超时后信号量槽位必须释放（原泄漏）
// 覆盖：慢工具超时 → 超时错误响应 → 槽位已还 → 后续工具调用不排队
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MALONG = join(__dirname, '..')
let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}

// 临时慢工具（1.5s）——测完删除
const SLOW_TOOL = join(MALONG, 'tools', 'tool-slow-test')
rmSync(SLOW_TOOL, { recursive: true, force: true })
mkdirSync(SLOW_TOOL, { recursive: true })
writeFileSync(join(SLOW_TOOL, 'manifest.json'), JSON.stringify({ name: 'slow_test', handler: 'handler.js' }))
writeFileSync(join(SLOW_TOOL, 'handler.js'), `
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
export async function handle(args, context) {
  await sleep(1500)
  return { success: true, slept: 1500 }
}
`)

const WS = join(os.tmpdir(), 'opencode', 'mcp-timeout-test-ws')
try { rmSync(WS, { recursive: true, force: true }) } catch {}
mkdirSync(WS, { recursive: true })
mkdirSync(join(WS, 'data'), { recursive: true })
const STATE_DIR = join(os.tmpdir(), 'opencode', 'mcp-timeout-test-state')
try { rmSync(STATE_DIR, { recursive: true, force: true }) } catch {}

const child = spawn(process.execPath, [join(MALONG, 'mcp-server.js'), '--workspace', WS], {
  stdio: ['pipe', 'pipe', 'pipe'],
  cwd: WS,
  env: { ...process.env, MALONG_STATE_DIR: STATE_DIR, MALONG_REQUEST_TIMEOUT_MS: '300' },
})

let buffer = ''
const pending = new Map()
let nextId = 0
function request(method, params) {
  const id = ++nextId
  return new Promise((resolve) => {
    pending.set(id, resolve)
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); resolve({ timeout: true }) }
    }, 10000)
  })
}
child.stdout.setEncoding('utf-8')
child.stdout.on('data', (chunk) => {
  buffer += chunk
  let idx
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx)
    buffer = buffer.slice(idx + 1)
    if (!line.trim()) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    if (msg.id && pending.has(msg.id)) {
      const resolve = pending.get(msg.id)
      pending.delete(msg.id)
      resolve(msg)
    }
  }
})
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// ── ① 等待服务就绪（模块加载中返回 -32000）──
console.log('\n── ① 等待服务就绪 ──')
{
  for (let i = 0; i < 20; i++) {
    const res = await request('tools/call', { name: 'health', arguments: { action: 'check' } })
    if (res.result) break
    await sleep(500)
  }
  const res = await request('tools/call', { name: 'health', arguments: { action: 'check' } })
  assert(res.result && !res.timeout, '服务就绪（health 返回 result）')
}

// ── ② 慢工具超时 → 超时错误响应 ──
console.log('\n── ② 慢工具超时 → 超时错误响应 ──')
{
  const t0 = Date.now()
  const res = await request('tools/call', { name: 'slow_test', arguments: {} })
  assert(!res.timeout, '慢工具调用有响应')
  assert(res.error && res.error.code === -32603 && /timeout/i.test(res.error.message), `超时错误响应（得 ${res.error?.code}: ${res.error?.message?.slice(0, 60)}）`)
  assert(Date.now() - t0 < 5000, '超时在注入的 300ms 内触发')
}

// ── ③ 等慢工具真正跑完（1.5s）→ 槽位释放 ──
console.log('\n── ③ 超时后槽位释放 → 后续调用不被排队阻塞 ──')
{
  await sleep(2000) // 慢工具已完成，releaseSlot 已执行
  const t0 = Date.now()
  const res = await request('tools/call', { name: 'health', arguments: { action: 'check' } })
  assert(!res.timeout, 'health 调用有响应')
  assert(res.result, 'health 返回 result')
  const elapsed = Date.now() - t0
  assert(elapsed < 8000, `health 未排队（原缺陷会排队 60s；实测 ${elapsed}ms）`)
}

// ── ③ shutdown ──
await request('shutdown', {})
child.kill()
// Windows 善后：子进程 cwd=WS，TerminateProcess 后句柄（CWD/SQLite DB）释放是异步的——
// 先等 exit 事件，再带重试删目录，否则 rmSync 与句柄释放赛跑报 EBUSY（本地实测稳定复现）
await new Promise((resolve) => {
  if (child.exitCode !== null) return resolve()
  child.once('exit', () => resolve())
})
await sleep(200)
for (const dir of [SLOW_TOOL, WS, STATE_DIR]) {
  for (let i = 0; ; i++) {
    try { rmSync(dir, { recursive: true, force: true }); break } catch (e) {
      if (i >= 10) throw e
      await sleep(200)
    }
  }
}

console.log(`\n== test-mcp-server-timeout: ${pass} passed, ${fail} failed ==`)
if (fail > 0) process.exit(1)