// test-wp07-host-contract.js — WP07 文案、预算与宿主合同收口
// 真实 mcp-server 进程 + JSON-RPC，断言宿主合同四要素：
//   ① 旧客户端兼容：所有响应经 content[0].type='text' 传输且 JSON.parse 后结构无损（MCP serializer 合同）
//   ② 无强迫文案：tools/list 全部 manifest description 良性（无「必须先调用」类黑名单措辞）
//   ③ 门控一致：graph 档 tools/list 不暴露 classic 只读入口，且直接调用隐藏工具名被拒（不暗中可调）
//   ④ 真实宿主路径：tools/call 往返（连接/调用/完成）——重连/恢复/取消由 dogfood 会话实测登记
// 关联已有覆盖：expand 正确 ID → test-s2-control；AC24 预算截断 → test-output-budget/test-s5-budget；
// manifest 质量细节 → test-manifest-quality；目录 → test-s5-catalog。
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, rmSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) { if (cond) { pass++; console.log(`  ✓ ${msg}`) } else { fail++; console.error(`  ✗ FAIL: ${msg}`) } }

const WS = join(os.tmpdir(), 'opencode', 'wp07-host-ws')
const STATE = join(os.tmpdir(), 'opencode', 'wp07-host-state')
try { rmSync(WS, { recursive: true, force: true }) } catch {}
try { rmSync(STATE, { recursive: true, force: true }) } catch {}
mkdirSync(join(WS, 'src'), { recursive: true })

const env = {
  ...process.env,
  MALONG_INTERFACE: 'graph',
  MALONG_ENTRY_STATE: '1',
  MALONG_STATE_DIR: STATE,
}
const proc = spawn(process.execPath, [join(__dirname, '..', 'mcp-server.js'), '--workspace', WS], {
  cwd: WS, env, stdio: ['pipe', 'pipe', 'pipe'],
})
const NL = String.fromCharCode(10)
let buf = ''
let exited = false
const pending = new Map()
const timers = new Set()
let seq = 0
proc.stdout.setEncoding('utf-8')
proc.stdout.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf(NL)) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    let m
    try { m = JSON.parse(line) } catch { continue }
    if (m.id != null && pending.has(m.id)) { const f = pending.get(m.id); pending.delete(m.id); f(m) }
  }
})
proc.stderr.on('data', () => {})
proc.on('exit', () => { exited = true; for (const f of pending.values()) f({ error: { code: -1, message: 'server_exited' } }); pending.clear() })

function rpc(method, params, t = 20000) {
  const id = ++seq
  return new Promise((resolve, reject) => {
    if (exited) return reject(new Error('server_exited'))
    const to = setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout ' + method)) } }, t)
    timers.add(to)
    pending.set(id, (m) => { clearTimeout(to); timers.delete(to); resolve(m) })
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + NL)
  })
}
async function rpcWithRetry(method, params) {
  for (let attempt = 0; ; attempt++) {
    const r = await rpc(method, params).catch((e) => ({ error: { code: -1, message: String(e.message || e) } }))
    if (r.error && r.error.code === -32000 && /still loading/i.test(String(r.error.message)) && attempt < 20) {
      await new Promise((res) => setTimeout(res, 500))
      continue
    }
    return r
  }
}
// 宿主合同①：经 text 载荷往返，JSON.parse 后结构无损
async function callStructured(name, args) {
  const r = await rpcWithRetry('tools/call', { name, arguments: args })
  if (r.error) return { _rpcError: r.error.code, ok: false }
  const c = r.result && r.result.content && r.result.content[0]
  if (!c || c.type !== 'text') return { _rpcError: 'content_not_text', ok: false }
  try { return JSON.parse(c.text) } catch { return { _rpcError: 'text_not_json', ok: false } }
}

try {
  console.log('== ① 旧客户端兼容：协议级结构化 + tools/call 文本 JSON 无损 ==')
  {
    const ir = await rpcWithRetry('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'wp07-contract-test', version: '0' } })
    assert(ir.result && ir.result.protocolVersion && ir.result.serverInfo, 'initialize 协议级结构化（protocolVersion/serverInfo 直接在 result）')
    const lr = await rpcWithRetry('tools/list', {})
    assert(lr.result && Array.isArray(lr.result.tools), 'tools/list 协议级结构化（result.tools 数组）')
  }

  console.log('== ② 无强迫文案（tools/list 全 manifest 良性）==')
  let toolNames = []
  {
    const lr = await rpcWithRetry('tools/list', {})
    const tools = lr.result.tools
    const list = tools
    toolNames = list.map((t) => t.name)
    assert(list.length >= 10 && list.length <= 20, `MCP 目录为六合线白名单（${list.length} 工具，11 code_* + invoke_capability + edit_transaction）`)
    const offList = list.filter((t) => !(/^(code_|invoke_capability$|edit_transaction$)/.test(t.name)))
    assert(offList.length === 0, `目录与门控一致（白名单外混入: ${offList.map((t) => t.name).join(',') || '无'}）`)
    const banned = [/任何代码问题必须/i, /必须先调用/i, /must be called first/i, /must first call/i, /you must always/i]
    const bad = list.filter((t) => banned.some((re) => re.test(String(t.description || ''))))
    assert(bad.length === 0, `无强迫使用文案（违规: ${bad.map((t) => t.name).join(',') || '无'}）`)
    const noDesc = list.filter((t) => !String(t.description || '').trim())
    assert(noDesc.length === 0, `全部 description 非空（缺: ${noDesc.map((t) => t.name).join(',') || '无'}）`)
  }

  console.log('== ③ 门控一致：隐藏工具不暴露且不暗中可调 ==')
  {
    assert(!toolNames.includes('read_symbol'), 'classic read_symbol 不在 graph 档目录')
    assert(toolNames.includes('code_task') && toolNames.includes('code_status'), '三入口在 graph 档目录')
    const hidden = await callStructured('read_symbol', { workspace_dir: WS, file_path: 'src/t.js', name: 'x' })
    assert(hidden.ok === false && (hidden._rpcError !== undefined || hidden.error !== undefined), `直接调用隐藏工具被拒（${JSON.stringify(hidden._rpcError || hidden.error || hidden.message).slice(0, 80)}）`)
  }

  console.log('== ④ 真实宿主路径：tools/call 文本 JSON 合同 + 结构无损 ==')
  {
    const r = await rpcWithRetry('tools/call', { name: 'code_status', arguments: { workspace_dir: WS } })
    const c = r.result && r.result.content && r.result.content[0]
    assert(c && c.type === 'text', 'tools/call 响应经 content[0].type=text（旧客户端可读）')
    let st = null
    try { st = JSON.parse(c.text) } catch {}
    assert(st && st.ok === true && st.observation && Array.isArray(st.observation.tasks), 'text JSON.parse 后结构无损（tasks 列表在）')
  }
} finally {
  try { proc.kill() } catch {}
}

console.log(`\n=== test-wp07-host-contract: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
