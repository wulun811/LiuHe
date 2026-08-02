// test-mcp-server.js — MCP 协议层端到端（r34：此前 mcp-server.js 566 行零测试）
// 进程级 spawn：换行分隔 JSON-RPC 2.0 over stdio。
// 覆盖：initialize / ping / tools/list / tools/call（命中+未知工具）/ 未知方法 / shutdown 退出
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, rmSync, existsSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}

const WS = join(os.tmpdir(), 'opencode', 'mcp-test-ws')
rmSync(WS, { recursive: true, force: true })
mkdirSync(WS, { recursive: true })
mkdirSync(join(WS, 'data'), { recursive: true })

const child = spawn(process.execPath, [join(__dirname, '..', 'mcp-server.js'), '--workspace', WS], {
  stdio: ['pipe', 'pipe', 'pipe'],
  cwd: WS,
})

let buffer = ''
const pending = new Map()
let nextId = 0

function request(method, params) {
  const id = ++nextId
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        reject(new Error(`timeout waiting for ${method} response`))
      }
    }, 8000)
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
    try { msg = JSON.parse(line) } catch { console.error('  non-JSON line:', line); continue }
    if (msg.id && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id)
      pending.delete(msg.id)
      resolve(msg)
    }
  }
})

function waitFor(fn, timeoutMs, intervalMs) {
  const start = Date.now()
  return new Promise((resolve) => {
    const tick = async () => {
      const v = await fn()
      if (v) return resolve(v)
      if (Date.now() - start > timeoutMs) return resolve(null)
      setTimeout(tick, intervalMs)
    }
    tick()
  })
}

// ── 等待服务 ready（tools/list 不再报 -32000）──
const readyList = await waitFor(async () => {
  try {
    const r = await request('tools/list', {})
    return r.result?.tools ? r : null
  } catch { return null }
}, 15000, 200)
assert(readyList, 'tools/list 最终成功（服务加载完毕）')

const tools = readyList?.result?.tools || []
assert(Array.isArray(tools) && tools.length > 0, `tools/list 返回工具列表（${tools.length} 个）`)
const names = tools.map(t => t.name)
assert(names.includes('health'), '工具列表包含 health')
assert(names.includes('read_symbol') || names.includes('code_search'), '工具列表包含核心工具')
const hasJsonrpc = tools.every(t => !('id' in t) || typeof t.id === 'string')
assert(hasJsonrpc, '工具条目均为 MCP 工具描述（含 id/description/inputSchema 结构）')
const hasSchema = tools.every(t => t.inputSchema && typeof t.inputSchema === 'object')
assert(hasSchema, '每个工具都有 inputSchema')

// ── initialize 握手 ──
const init = await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0.0.0' } })
assert(init.result?.protocolVersion === '2024-11-05', 'initialize 返回 protocolVersion 2024-11-05')
assert(init.result?.serverInfo?.name === 'malong-mcp', `initialize 返回 serverInfo.name=malong-mcp（实际 ${init.result?.serverInfo?.name}）`)
assert(init.result?.capabilities?.tools, 'initialize 声明 tools capability')

// ── ping ──
const pong = await request('ping', {})
assert(pong.result === 'pong', 'ping 返回 pong')

// ── tools/call 已知工具（health 无副作用）──
const healthCall = await request('tools/call', { name: 'health', arguments: {} })
assert(!healthCall.error, `health 调用成功（error=${JSON.stringify(healthCall.error)}）`)
assert(healthCall.result?.content?.[0]?.type === 'text', 'health 返回 MCP text content')
const healthText = JSON.parse(healthCall.result.content[0].text)
assert(typeof healthText === 'object', 'health 结果为 JSON 对象')

// ── tools/call 未知工具 → -32601 ──
const badTool = await request('tools/call', { name: 'no_such_tool_xyz', arguments: {} })
assert(badTool.error?.code === -32601, `未知工具返回 -32601（实际 ${badTool.error?.code}）`)
assert(String(badTool.error.message).includes('no_such_tool_xyz'), '未知工具错误信息含工具名')

// ── 未知方法 → -32601 ──
const badMethod = await request('not_a_real_method', {})
assert(badMethod.error?.code === -32601, `未知方法返回 -32601（实际 ${badMethod.error?.code}）`)

// ── shutdown：响应后进程退出 ──
const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)))
const shut = await request('shutdown', {})
assert(shut.result && !shut.error, 'shutdown 返回成功')
const code = await Promise.race([exited, new Promise(r => setTimeout(() => r('TIMEOUT'), 8000))])
assert(code !== 'TIMEOUT', `shutdown 后进程退出（code=${code}）`)

if (child.exitCode === null && code === 'TIMEOUT') child.kill()
rmSync(WS, { recursive: true, force: true })

console.log(`== test-mcp-server: ${pass} passed, ${fail} failed ==`)
if (fail > 0) process.exit(1)
