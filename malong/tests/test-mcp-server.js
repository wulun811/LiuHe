// test-mcp-server.js — MCP 协议层端到端（r34：此前 mcp-server.js 566 行零测试）
// 进程级 spawn：换行分隔 JSON-RPC 2.0 over stdio。
// 覆盖：initialize / ping / tools/list / tools/call（命中+未知工具）/ 未知方法 / shutdown 退出
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}

const WS = join(os.tmpdir(), 'opencode', 'mcp-test-ws')
try { rmSync(WS, { recursive: true, force: true }) } catch {}
mkdirSync(WS, { recursive: true })
mkdirSync(join(WS, 'data'), { recursive: true })

const STATE_DIR = join(os.tmpdir(), 'opencode', 'mcp-test-state')
try { rmSync(STATE_DIR, { recursive: true, force: true }) } catch {}
const child = spawn(process.execPath, [join(__dirname, '..', 'mcp-server.js'), '--workspace', WS], {
  stdio: ['pipe', 'pipe', 'pipe'],
  cwd: WS,
  // r37-fix2：状态目录定向，防止 registry 使用统计写真实 ~/.config/malong/
  // 0.5.24（breaking）：默认档 = 六和线 13；本段验 MCP 协议管道 + classic 工具 health → 显式 classic
  env: { ...process.env, MALONG_STATE_DIR: STATE_DIR, MALONG_INTERFACE: 'classic' },
})

let buffer = ''
const pending = new Map()
let nextId = 0

function request(method, params) {
  const id = ++nextId
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        reject(new Error(`timeout waiting for ${method} response`))
      }
    }, 8000)
    pending.set(id, { resolve, reject, timer })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
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
      const { resolve, timer } = pending.get(msg.id)
      clearTimeout(timer)
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

// 测试计时修复：Promise.race 的计时器/退出等待的兜底 timer 不清理会拖住事件循环（尾部多等 8s+3s）。
function raceTimeout(promise, ms, fallback) {
  let timer
  return Promise.race([
    promise,
    new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms) }),
  ]).finally(() => clearTimeout(timer))
}
function waitExit(child, ms = 3000) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode)
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('TIMEOUT'), ms)
    child.once('exit', (code) => { clearTimeout(timer); resolve(code) })
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
const pkgVersion = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')).version
assert(init.result?.serverInfo?.version === pkgVersion, `serverInfo.version 与 package.json 一致（得 ${init.result?.serverInfo?.version}，期望 ${pkgVersion}）`)
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

// ── dogfood-050 r4：入场绑定——跨工作区符号读取不得因「最后触碰的库」漂移（假 SYMBOL_NOT_FOUND）──
{
  const WS2x = join(os.tmpdir(), 'opencode', 'mcp-test-ws2')
  try { rmSync(WS2x, { recursive: true, force: true }) } catch {}
  mkdirSync(WS2x, { recursive: true })
  writeFileSync(join(WS2x, 'other.js'), 'function other() { return 1 }\nmodule.exports = { other }\n')
  const idx2 = await request('tools/call', { name: 'reindex', arguments: { workspace_dir: WS2x, blocking: true } })
  assert(!idx2.error, `r4 第二工作区 reindex 成功（error=${JSON.stringify(idx2.error)}）`)
  // 此刻最后触碰的是 WS2x；读 WS 的符号（不带 file_path）必须仍在 WS 解析
  const rsCross = await request('tools/call', { name: 'read_symbol', arguments: { workspace_dir: WS, locator: { symbol_id: 'js:src/app.js::hotReload#function' } } })
  const rsText = rsCross.result?.content?.[0]?.text || ''
  const rsJson = (() => { try { return JSON.parse(rsText) } catch { return {} } })()
  assert(!rsJson.error && rsJson.symbol?.name === 'hotReload', `r4 跨工作区 read_symbol 命中（error=${rsJson.error || 'none'}，${rsText.slice(0, 150)}）`)
  try { rmSync(WS2x, { recursive: true, force: true }) } catch {}
}

// ── tools/call 未知工具 → -32601 ──
const badTool = await request('tools/call', { name: 'no_such_tool_xyz', arguments: {} })
assert(badTool.error?.code === -32601, `未知工具返回 -32601（实际 ${badTool.error?.code}）`)
assert(String(badTool.error.message).includes('no_such_tool_xyz'), '未知工具错误信息含工具名')

// ── LH-007：门控工具显式拒绝（classic 默认 env 下 code_task 被 interface 白名单门控）──
const gatedTool = await request('tools/call', { name: 'code_task', arguments: { workspace_dir: WS, goal: 'x' } })
assert(gatedTool.error?.code === -32601, `门控工具返回 -32601（实际 ${gatedTool.error?.code}）`)
assert(/not available in the current interface/i.test(String(gatedTool.error?.message)), `门控错误说明原因（得 ${gatedTool.error?.message}）`)

// ── 未知方法 → -32601 ──
const badMethod = await request('not_a_real_method', {})
assert(badMethod.error?.code === -32601, `未知方法返回 -32601（实际 ${badMethod.error?.code}）`)

// ── shutdown：响应后进程退出 ──
const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)))
const shut = await request('shutdown', {})
assert(shut.result && !shut.error, 'shutdown 返回成功')
const code = await raceTimeout(exited, 8000, 'TIMEOUT')
assert(code !== 'TIMEOUT', `shutdown 后进程退出（code=${code}）`)

if (child.exitCode === null && code === 'TIMEOUT') child.kill()
if (child.exitCode === null) await waitExit(child, 3000)

// ── r47: 同 STATE_DIR 重启 server 后直接 code_search（不 reindex）→ 命中 ──
// codeIndex 连接懒初始化：db 文件残留 ≠ 连接已打开，此前搜索抛错被吞 → 恒 0 命中
{
  const child3 = spawn(process.execPath, [join(__dirname, '..', 'mcp-server.js'), '--workspace', WS], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: WS,
    // 0.5.24：默认档 = 六和线 → code_search（classic 工具）需显式 classic
    env: { ...process.env, MALONG_STATE_DIR: STATE_DIR, MALONG_INTERFACE: 'classic' },
  })
  let out3 = '', err3 = ''
  child3.stdout.setEncoding('utf-8')
  child3.stderr.on('data', d => { err3 += d })
  child3.stdout.on('data', d => { out3 += d })
  let nextId3 = 0
  const pending3 = new Map()
  const req3 = (method, params) => new Promise((res, rej) => {
    const i = ++nextId3
    const timer = setTimeout(() => { if (pending3.has(i)) { pending3.delete(i); rej(new Error('timeout ' + method)) } }, 20000)
    pending3.set(i, { res: (m) => { clearTimeout(timer); res(m) }, rej: (e) => { clearTimeout(timer); rej(e) } })
    child3.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n')
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
  // 测试提速：固定等 3s → 条件轮询（通常第一次就命中）
  let cs3Text = ''
  let cs3Json = {}
  for (let i = 0; i < 40; i++) {
    const cs3 = await req3('tools/call', { name: 'code_search', arguments: { workspace_dir: WS, query: 'hotReload' } }).catch(() => null)
    cs3Text = cs3?.result?.content?.[0]?.text || ''
    try { cs3Json = JSON.parse(cs3Text) } catch { cs3Json = {} }
    if (!cs3Json.error && cs3Json.count >= 1) break
    await new Promise(r => setTimeout(r, 200))
  }
  assert(!cs3Json.error && cs3Json.count >= 1, `r47 重启后直接搜索命中（count=${cs3Json.count}，${cs3Text.slice(0, 150)}）`)
  child3.kill()
  await waitExit(child3, 3000)
}

try { rmSync(WS, { recursive: true, force: true }) } catch {}

// ── r37-fix3：干净 cwd（无 data/ 目录）启动不崩——宿主（codex/claude 等）以任意 cwd 启动的场景 ──
{
  const WS2 = join(os.tmpdir(), 'opencode', 'mcp-test-ws-clean')
  try { rmSync(WS2, { recursive: true, force: true }) } catch {}
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
  assert(list2?.result?.tools?.length === 13, `干净 cwd 启动默认六和线 13 工具（实际 ${list2?.result?.tools?.length}）`)
  assert(!err2.includes('FATAL'), '干净 cwd 启动无 FATAL 崩溃')
  child2.kill()
  // r39-fix: 等子进程真正退出再清理——SIGTERM 后 mcp-server 仍在 flush 状态目录(data/malong-mcp)，
  // 立即 rmSync(recursive) 与其写入竞态 → rimraf ENOTEMPTY 崩测试（flaky：dev 侥幸未触发，liuhe 复现）
  if (child2.exitCode === null) await waitExit(child2, 3000)
  try { rmSync(WS2, { recursive: true, force: true }) } catch {}
}

// ── 0.5.24（breaking）：默认档翻到六和线后，显式 classic 仍必须给 44 全量（回退路径可达）──
{
  const WS3 = join(os.tmpdir(), 'opencode', 'mcp-test-ws-classic')
  try { rmSync(WS3, { recursive: true, force: true }) } catch {}
  mkdirSync(WS3, { recursive: true })
  const childClassic = spawn(process.execPath, [join(__dirname, '..', 'mcp-server.js'), '--workspace', WS3], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: WS3,
    env: { ...process.env, MALONG_STATE_DIR: STATE_DIR, MALONG_INTERFACE: 'classic' },
  })
  let outC = '', errC = ''
  childClassic.stdout.on('data', d => { outC += d })
  childClassic.stderr.on('data', d => { errC += d })
  const rqC = (id, obj) => new Promise(res => {
    const before = outC.length
    const h = d => {
      const lines = outC.slice(before).split('\n').filter(Boolean)
      for (const l of lines) {
        try { const m = JSON.parse(l); if (m.id === id) { childClassic.stdout.off('data', h); res(m); return } } catch {}
      }
      childClassic.stdout.on('data', h)
    }
    childClassic.stdout.on('data', h)
    childClassic.stdin.write(JSON.stringify(obj) + '\n')
  })
  await rqC(1, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } })
  let listC = null
  for (let i = 0; i < 30 && !listC?.result?.tools; i++) {
    await new Promise(r => setTimeout(r, 300))
    listC = await rqC(2, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
  }
  assert(listC?.result?.tools?.length === 44, `显式 MALONG_INTERFACE=classic → 44 工具（实际 ${listC?.result?.tools?.length}）`)
  assert(!errC.includes('FATAL'), 'classic 档启动无 FATAL 崩溃')
  childClassic.kill()
  if (childClassic.exitCode === null) await waitExit(childClassic, 3000)
  try { rmSync(WS3, { recursive: true, force: true }) } catch {}
}

// ── G：正常 stdin EOF（客户端关会话）→ 优雅退出，不得写 last-crash-dump ──
{
  const WS3 = join(os.tmpdir(), 'opencode', 'mcp-test-ws3')
  try { rmSync(WS3, { recursive: true, force: true }) } catch {}
  mkdirSync(join(WS3, 'data'), { recursive: true })
  const STATE3 = join(os.tmpdir(), 'opencode', 'mcp-test-state3')
  try { rmSync(STATE3, { recursive: true, force: true }) } catch {}
  const child3 = spawn(process.execPath, [join(__dirname, '..', 'mcp-server.js'), '--workspace', WS3], {
    stdio: ['pipe', 'pipe', 'pipe'], cwd: WS3,
    env: { ...process.env, MALONG_STATE_DIR: STATE3 },
  })
  let buf3 = ''
  child3.stdout.setEncoding('utf-8')
  child3.stdout.on('data', (c) => { buf3 += c })
  child3.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } }) + '\n')
  const t0 = Date.now()
  while (!buf3.includes('"malong-mcp"') && Date.now() - t0 < 8000) await new Promise(r => setTimeout(r, 50))
  assert(buf3.includes('"malong-mcp"'), 'G 前置：initialize 成功')
  const exited3 = new Promise((resolve) => child3.on('exit', (code) => resolve(code)))
  child3.stdin.end()
  const code3 = await raceTimeout(exited3, 8000, 'TIMEOUT')
  assert(code3 === 0, `G stdin EOF 后优雅退出 code=0（得 ${code3}）`)
  const dumpPath = join(STATE3, 'last-crash-dump.json')
  assert(!existsSync(dumpPath), 'G 正常 stdin EOF 不写 last-crash-dump（此前 reason=stdin_end 误记 crash）')
  if (child3.exitCode === null) child3.kill()
  try { rmSync(WS3, { recursive: true, force: true }) } catch {}
}

// ── U 集成：目标 workspaces 启动时已被预建（live 复现：迁移被整体跳过）→ 仍须按条目合并 ──
{
  const WS4 = join(os.tmpdir(), 'opencode', 'mcp-test-ws4')
  const STATE4 = join(os.tmpdir(), 'opencode', 'mcp-test-state4')
  try { rmSync(WS4, { recursive: true, force: true }) } catch {}
  try { rmSync(STATE4, { recursive: true, force: true }) } catch {}
  mkdirSync(join(WS4, 'data', 'malong-mcp', 'workspaces', 'w9'), { recursive: true })
  writeFileSync(join(WS4, 'data', 'malong-mcp', 'workspaces', 'w9', 'code-index.db'), 'legacy-db')
  mkdirSync(join(STATE4, 'workspaces'), { recursive: true })
  const child4 = spawn(process.execPath, [join(__dirname, '..', 'mcp-server.js'), '--workspace', WS4], {
    stdio: ['pipe', 'pipe', 'pipe'], cwd: WS4,
    env: { ...process.env, MALONG_STATE_DIR: STATE4 },
  })
  let buf4 = ''
  child4.stdout.setEncoding('utf-8')
  child4.stdout.on('data', (c) => { buf4 += c })
  child4.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } }) + '\n')
  const t4 = Date.now()
  while (!buf4.includes('"malong-mcp"') && Date.now() - t4 < 8000) await new Promise(r => setTimeout(r, 50))
  assert(buf4.includes('"malong-mcp"'), 'U 迁移集成：initialize 成功')
  assert(existsSync(join(STATE4, 'workspaces', 'w9', 'code-index.db')), 'U 目标 workspaces 已存在时按条目合并（w9 迁入）')
  assert(!existsSync(join(WS4, 'data', 'malong-mcp', 'workspaces', 'w9')), 'U 合并后旧条目移除')
  const exited4 = new Promise((resolve) => child4.on('exit', (code) => resolve(code)))
  child4.stdin.end()
  const code4 = await raceTimeout(exited4, 8000, 'TIMEOUT')
  assert(code4 === 0, `U 迁移集成：优雅退出（得 ${code4}）`)
  if (child4.exitCode === null) child4.kill()
  try { rmSync(WS4, { recursive: true, force: true }) } catch {}
  try { rmSync(STATE4, { recursive: true, force: true }) } catch {}
}

console.log(`== test-mcp-server: ${pass} passed, ${fail} failed ==`)
if (fail > 0) process.exit(1)
