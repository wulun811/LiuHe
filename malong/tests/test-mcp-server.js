// test-mcp-server.js — MCP 协议层端到端（r34：此前 mcp-server.js 566 行零测试）
// 进程级 spawn：换行分隔 JSON-RPC 2.0 over stdio。
// 覆盖：initialize / ping / tools/list / tools/call（命中+未知工具）/ 未知方法 / shutdown 退出
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
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

const STATE_DIR = join(os.tmpdir(), 'opencode', 'mcp-test-state')
rmSync(STATE_DIR, { recursive: true, force: true })
const child = spawn(process.execPath, [join(__dirname, '..', 'mcp-server.js'), '--workspace', WS], {
  stdio: ['pipe', 'pipe', 'pipe'],
  cwd: WS,
  // r37-fix2：状态目录定向，防止 registry 使用统计写真实 ~/.config/malong/
  env: { ...process.env, MALONG_STATE_DIR: STATE_DIR },
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

// ── r46: code_search 服务接线端到端（此前 buildContext/initModules 漏接线 → 恒 service_unavailable）──
// 注意：src/app.js 保留不删——r47 重启用例依赖其索引数据
{
  const srcDir = join(WS, 'src')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, 'app.js'), 'export function hotReload() { return 42 }\nexport const VERSION = "1.0"\n')
  const idx = await request('tools/call', { name: 'reindex', arguments: { workspace_dir: WS, blocking: true } })
  assert(!idx.error, `reindex 调用成功（error=${JSON.stringify(idx.error)}）`)
  const cs = await request('tools/call', { name: 'code_search', arguments: { workspace_dir: WS, query: 'hotReload' } })
  assert(!cs.error, `code_search 调用成功（error=${JSON.stringify(cs.error)}）`)
  const csText = cs.result?.content?.[0]?.text || ''
  const csJson = JSON.parse(csText)
  assert(!csJson.error && csJson.count >= 1, `code_search 命中（count=${csJson.count}，${csText.slice(0, 150)}）`)
}

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
if (child.exitCode === null) await new Promise(r => { child.on('exit', r); setTimeout(r, 3000) })

// ── r47: 同 STATE_DIR 重启 server 后直接 code_search（不 reindex）→ 命中 ──
// codeIndex 连接懒初始化：db 文件残留 ≠ 连接已打开，此前搜索抛错被吞 → 恒 0 命中
{
  const child3 = spawn(process.execPath, [join(__dirname, '..', 'mcp-server.js'), '--workspace', WS], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: WS,
    env: { ...process.env, MALONG_STATE_DIR: STATE_DIR },
  })
  let out3 = '', err3 = ''
  child3.stdout.setEncoding('utf-8')
  child3.stderr.on('data', d => { err3 += d })
  child3.stdout.on('data', d => { out3 += d })
  let nextId3 = 0
  const pending3 = new Map()
  const req3 = (method, params) => new Promise((res, rej) => {
    const i = ++nextId3
    pending3.set(i, { res, rej })
    child3.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n')
    setTimeout(() => { if (pending3.has(i)) { pending3.delete(i); rej(new Error('timeout ' + method)) } }, 20000)
  })
  child3.stdout.on('data', (chunk) => {
    out3 += chunk
    let idx
    while ((idx = out3.indexOf('\n')) >= 0) {
      const line = out3.slice(0, idx); out3 = out3.slice(idx + 1)
      try { const m = JSON.parse(line); if (pending3.has(m.id)) { pending3.get(m.id).res(m); pending3.delete(m.id) } } catch {}
    }
  })
  const out3raw = { get: () => out3 } // 兼容上面输出拼接
  await req3('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } })
  child3.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  await new Promise(r => setTimeout(r, 3000))
  const cs3 = await req3('tools/call', { name: 'code_search', arguments: { workspace_dir: WS, query: 'hotReload' } })
  const cs3Text = cs3.result?.content?.[0]?.text || ''
  const cs3Json = (() => { try { return JSON.parse(cs3Text) } catch { return {} } })()
  assert(!cs3Json.error && cs3Json.count >= 1, `r47 重启后直接搜索命中（count=${cs3Json.count}，${cs3Text.slice(0, 150)}）`)
  child3.kill()
  await new Promise(r => { child3.on('exit', r); setTimeout(r, 3000) })
}

rmSync(WS, { recursive: true, force: true })

// ── r37-fix3：干净 cwd（无 data/ 目录）启动不崩——宿主（codex/claude 等）以任意 cwd 启动的场景 ──
{
  const WS2 = join(os.tmpdir(), 'opencode', 'mcp-test-ws-clean')
  rmSync(WS2, { recursive: true, force: true })
  mkdirSync(WS2, { recursive: true }) // 只建 ws 根，不建 data/ —— 复现 UDS EACCES 崩溃场景
  const child2 = spawn(process.execPath, [join(__dirname, '..', 'mcp-server.js'), '--workspace', WS2], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: WS2,
    env: { ...process.env, MALONG_STATE_DIR: STATE_DIR },
  })
  let out2 = '', err2 = ''
  child2.stdout.on('data', d => { out2 += d })
  child2.stderr.on('data', d => { err2 += d })
  const rq2 = (id, obj) => new Promise(res => {
    const before = out2.length
    const h = d => {
      const lines = out2.slice(before).split('\n').filter(Boolean)
      for (const l of lines) {
        try { const m = JSON.parse(l); if (m.id === id) { child2.stdout.off('data', h); res(m); return } } catch {}
      }
    }
    child2.stdout.on('data', h)
    child2.stdin.write(JSON.stringify(obj) + '\n')
  })
  const init2 = await rq2(1, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } })
  assert(init2.result?.serverInfo?.name === 'malong-mcp', '干净 cwd 下 initialize 成功')
  let list2 = null
  for (let i = 0; i < 30 && !list2?.result?.tools; i++) {
    await new Promise(r => setTimeout(r, 300))
    list2 = await rq2(2, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
  }
  assert(list2?.result?.tools?.length === 44, `干净 cwd 启动 44 工具（B13 增 6，实际 ${list2?.result?.tools?.length}）`)
  assert(!err2.includes('FATAL'), '干净 cwd 启动无 FATAL 崩溃')
  child2.kill()
  // r39-fix: 等子进程真正退出再清理——SIGTERM 后 mcp-server 仍在 flush 状态目录(data/malong-mcp)，
  // 立即 rmSync(recursive) 与其写入竞态 → rimraf ENOTEMPTY 崩测试（flaky：dev 侥幸未触发，liuhe 复现）
  if (child2.exitCode === null) await new Promise(r => { child2.on('exit', r); setTimeout(r, 3000) })
  rmSync(WS2, { recursive: true, force: true })
}

console.log(`== test-mcp-server: ${pass} passed, ${fail} failed ==`)
if (fail > 0) process.exit(1)
