// test-r2-semaphore.js — R2（P1）semaphore 槽位泄漏回归
// 验证：handler 抛异常（crash 路径）后，槽位必须释放——否则 health 的
// weight 感知探针会报 "slots leaked"。
// 探针工具 tools/tool-r2-throw（handler 直接 throw）在测试内创建/删除，不污染工具集。
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, rmSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`) } else { fail++; console.log(`  ✗ ${msg}`) }
}

const THROW_DIR = join(__dirname, '..', 'tools', 'tool-r2-throw')
// 自建探针工具（handler 直接 throw），结束后删除——不依赖外部预置
{
  const { writeFileSync } = await import('node:fs')
  rmSync(THROW_DIR, { recursive: true, force: true })
  mkdirSync(THROW_DIR, { recursive: true })
  writeFileSync(join(THROW_DIR, 'manifest.json'), JSON.stringify({
    name: 'r2_throw_probe',
    version: '1.0.0',
    description: 'R2 test probe: intentional throw to verify semaphore slot release on handler crash',
    inputSchema: { type: 'object', properties: {} },
    handler: './handler.js',
    protocol_version: '1.0',
    tags: ['test'],
  }, null, 2))
  writeFileSync(join(THROW_DIR, 'handler.js'), `export async function handle() {
  throw new Error('R2 probe intentional throw')
}
`)
}
const WS = join(os.tmpdir(), 'opencode', 'r2-sem-ws')
const STATE = join(os.tmpdir(), 'opencode', 'r2-sem-state')
rmSync(WS, { recursive: true, force: true }); mkdirSync(WS, { recursive: true })
rmSync(STATE, { recursive: true, force: true })

const child = spawn(process.execPath, [join(__dirname, '..', 'mcp-server.js'), '--workspace', WS], {
  stdio: ['pipe', 'pipe', 'pipe'], cwd: WS, env: { ...process.env, MALONG_STATE_DIR: STATE },
})
child.stderr.on('data', () => {})
let buffer = ''
const pending = new Map()
let nextId = 0
function request(method, params, timeoutMs = 15000) {
  const id = ++nextId
  return new Promise((res, rej) => {
    pending.set(id, { res, rej })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout')) } }, timeoutMs)
  })
}
child.stdout.setEncoding('utf-8')
child.stdout.on('data', (chunk) => {
  buffer += chunk
  let idx
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx); buffer = buffer.slice(idx + 1)
    if (!line.trim()) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    if (msg.id && pending.has(msg.id)) { const { res } = pending.get(msg.id); pending.delete(msg.id); res(msg) }
  }
})
const sleep = ms => new Promise(r => setTimeout(r, ms))

let ready = false
for (let i = 0; i < 40 && !ready; i++) {
  try { const r = await request('tools/list', {}, 3000); if (r.result?.tools) ready = true } catch {}
  if (!ready) await sleep(300)
}
assert(ready, '服务 ready（tools/list 成功）')
await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'r2-test', version: '0' } })

// ① 探针工具已注册
const list = await request('tools/list', {})
const names = (list.result?.tools || []).map(t => t.name)
assert(names.includes('r2_throw_probe'), `探针工具 r2_throw_probe 已注册`)

// ② 调用探针 → handler 抛错 → mcp-server 返回 -32603（crash 路径）
const crash = await request('tools/call', { name: 'r2_throw_probe', arguments: {} })
assert(crash.error && String(crash.error.message).includes('intentional throw'), `探针抛错经 crash 路径返回（code=${crash.error?.code}，msg=${String(crash.error?.message).slice(0, 50)}）`)

// ③ 槽位已释放：health 的 Semaphore 检查必须 PASS（无 slots leaked）
// health 自身占 weight=1，若探针槽位泄漏 current=2 > activeWeight=1 → FAIL
const health = await request('tools/call', { name: 'health', arguments: {} })
const healthText = health.result?.content?.[0]?.text || ''
const hJson = JSON.parse(healthText)
const semCheck = hJson.checks.find(c => c.name === 'Semaphore')
assert(semCheck && semCheck.status === 'PASS', `handler 抛错后槽位释放（Semaphore=${semCheck?.status} — ${semCheck?.detail}）`)

// ④ 后续正常请求不受影响
const pingOk = await request('tools/call', { name: 'health', arguments: {} })
assert(!pingOk.error, `后续请求正常响应`)

child.stdin.end()
await sleep(500)
child.kill()
rmSync(THROW_DIR, { recursive: true, force: true })

console.log(`== test-r2-semaphore: ${pass} passed, ${fail} failed ==`)
process.exit(fail > 0 ? 1 : 0)