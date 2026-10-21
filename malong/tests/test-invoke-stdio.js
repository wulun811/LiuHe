// test-invoke-stdio.js — G1 出口证据：真实 MCP stdio 链（ADR-018）
// graph+state：tools/list 含 invoke_capability → code_query(capabilities) 枚举 44 → code_query(capability) describe →
//             invoke_capability 调到原实现（active_todos）→ 隐藏原名 read_symbol 直呼仍被门控拒绝。
// state 关闭：invoke_capability 不在目录，直呼被 STATE 拒绝。
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  FAIL:', msg) } }

const WS = join(os.tmpdir(), 'opencode', 'invoke-stdio-ws')
try { rmSync(WS, { recursive: true, force: true }) } catch {}
mkdirSync(WS, { recursive: true })
writeFileSync(join(WS, 'a.js'), 'export const a = 1\n// TODO: stdio probe\n')

function makeClient(tag, env) {
  const stateDir = join(os.tmpdir(), 'opencode', 'invoke-stdio-state-' + tag)
  try { rmSync(stateDir, { recursive: true, force: true }) } catch {}
  const child = spawn(process.execPath, [join(__dirname, '..', 'mcp-server.js'), '--workspace', WS], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: WS,
    env: { ...process.env, MALONG_STATE_DIR: stateDir, ...env },
  })
  let buffer = '', seq = 0, exited = false
  const pending = new Map()
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
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
    }
  })
  child.on('exit', () => { exited = true })
  function rpc(method, params, t = 20000) {
    const id = ++seq
    return new Promise((resolve, reject) => {
      if (exited) return reject(new Error('server_exited'))
      const to = setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout ' + method)) } }, t)
      pending.set(id, (m) => { clearTimeout(to); resolve(m) })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }
  async function rpcRetry(method, params) {
    for (let i = 0; ; i++) {
      const r = await rpc(method, params).catch((e) => ({ error: { code: -1, message: String(e.message || e) } }))
      if (r.error && r.error.code === -32000 && /still loading/i.test(String(r.error.message)) && i < 30) {
        await new Promise((res) => setTimeout(res, 500))
        continue
      }
      return r
    }
  }
  async function call(name, args) {
    const r = await rpcRetry('tools/call', { name, arguments: args })
    if (r.error) return { _rpcError: r.error, ok: false }
    const c = r.result && r.result.content && r.result.content[0]
    if (!c || c.type !== 'text') return { _rpcError: { code: 'content_not_text' }, ok: false }
    try { return JSON.parse(c.text) } catch { return { _rpcError: { code: 'text_not_json' }, ok: false } }
  }
  return { child, rpcRetry, call, kill: () => { try { child.kill() } catch {} } }
}

// ── A. graph + state（日常档）──
const A = makeClient('stateful', { MALONG_INTERFACE: 'graph', MALONG_ENTRY_STATE: '1' })
try {
  const ir = await A.rpcRetry('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'g1-stdio', version: '0' } })
  assert(ir.result && ir.result.serverInfo, 'initialize ok')
  const lr = await A.rpcRetry('tools/list', {})
  const names = (lr.result?.tools || []).map((t) => t.name)
  assert(names.includes('invoke_capability'), 'graph+state 目录含 invoke_capability')
  assert(names.length === 13, 'graph+state 目录 13 项（得 ' + names.length + '）')

  const caps = await A.call('code_query', { workspace_dir: WS, mode: 'capabilities', limit: 100 })
  assert(caps.ok === true && caps.result?.total === 44 && caps.result?.items?.length === 44, 'stdio 枚举原 44 项（得 ' + (caps.result?.total) + '）')

  const desc = await A.call('code_query', { workspace_dir: WS, mode: 'capability', name: 'read_symbol' })
  assert(desc.ok === true && desc.result?.schema?.properties?.locator, 'stdio describe：schema 完整')
  assert(Array.isArray(desc.result?.adapter?.context_services), 'stdio describe：adapter 状态透出')
  assert(typeof desc.result?.call_template?.full_outlet === 'string' && desc.result.call_template.full_outlet.includes('invoke_capability'), 'describe 指向保底出口')

  const invd = await A.call('invoke_capability', { workspace_dir: WS, name: 'active_todos' })
  assert(invd.ok === true && invd.delegated === true, 'stdio invoke：委派成功')
  assert(invd.result && invd.result.total_todos === 1, 'stdio invoke：原实现真实执行（1 个 TODO）')

  const direct = await A.call('read_symbol', { workspace_dir: WS })
  assert(direct.ok === false, '隐藏原名直呼仍被拒')
  const why = JSON.stringify(direct._rpcError || direct).toLowerCase()
  assert(why.includes('read_symbol'), '拒因点名工具（不再与不存在混淆）')

  // ── N01（0.5.11 复审）：真实 stdio 下参数校验失败不留 prepared、纠错不被锁死 ──
  const tr = await A.call('code_task', { workspace_dir: WS, goal: 'n01 stdio: invalid args must not lock the request' })
  const tId = tr?.task?.task_id || null
  assert(!!tId, 'N01 stdio: 建任务（得 ' + JSON.stringify(tr).slice(0, 120) + '）')
  const badArgs = { create: true, locator: { file_path: 'n01.js' }, content: 'export const n1 = 1\n', dry_run: 'false' }
  const n1 = await A.call('invoke_capability', { workspace_dir: WS, name: 'write_symbol', task_id: tId, request_id: 'rid-n01', args: badArgs })
  assert(n1.error === 'invalid_input', 'N01 stdio: 首错 invalid_input（得 ' + JSON.stringify(n1).slice(0, 160) + '）')
  assert(existsSync(join(WS, 'n01.js')) === false, 'N01 stdio: 首错无文件变化')
  const n1s = await A.call('code_control', { workspace_dir: WS, task_id: tId, action: 'status' })
  assert(n1s.progress !== 'in_flight', 'N01 stdio: status 不假称在途（得 ' + n1s.progress + '）')
  const n1b = await A.call('invoke_capability', { workspace_dir: WS, name: 'write_symbol', task_id: tId, request_id: 'rid-n01', args: badArgs })
  assert(n1b.error === 'invalid_input', 'N01 stdio: 原样重试仍 invalid_input（不得 request_unresolved；得 ' + JSON.stringify(n1b).slice(0, 160) + '）')
  const n1c = await A.call('invoke_capability', { workspace_dir: WS, name: 'write_symbol', task_id: tId, request_id: 'rid-n01', args: { ...badArgs, dry_run: false } })
  assert(n1c.ok === true && n1c.operation_succeeded === true, 'N01 stdio: 修正后可执行（得 ' + JSON.stringify(n1c).slice(0, 160) + '）')

  // ── N02（0.5.11 复审）：真实 stdio 下无 task 命令同请求不得执行两次 ──
  writeFileSync(join(WS, 'append.cjs'), 'const fs=require("fs"),p=require("path").join(__dirname,"counter.txt");fs.appendFileSync(p,"x\\n")\n')
  const n2args = { script: 'append.cjs' }
  const n2a = await A.call('invoke_capability', { workspace_dir: WS, name: 'debug_runner', request_id: 'rid-n02', args: n2args })
  assert(n2a.ok === true && n2a.operation_succeeded === true, 'N02 stdio: 首次命令成功（得 ' + JSON.stringify(n2a).slice(0, 160) + '）')
  const cPath = join(WS, 'counter.txt')
  const c1 = existsSync(cPath) ? readFileSync(cPath, 'utf-8').split('\n').filter(Boolean).length : 0
  assert(c1 === 1, 'N02 stdio: 首次只追加一次（得 ' + c1 + '）')
  const n2b = await A.call('invoke_capability', { workspace_dir: WS, name: 'debug_runner', request_id: 'rid-n02', args: n2args })
  assert(n2b.deduplicated === true && n2b.delegated === false, 'N02 stdio: 同 id 同载荷幂等（得 ' + JSON.stringify(n2b).slice(0, 160) + '）')
  const c2 = readFileSync(cPath, 'utf-8').split('\n').filter(Boolean).length
  assert(c2 === 1, 'N02 stdio: 不产生第二次追加（得 ' + c2 + '）')
} finally { A.kill() }

// ── B. state 关闭：保底出口不可见且不可直呼 ──
// 0.5.24：状态层默认开 → 「关闭」必须显式 MALONG_ENTRY_STATE=0
const B = makeClient('stateless', { MALONG_INTERFACE: 'graph', MALONG_ENTRY_STATE: '0' })
try {
  await B.rpcRetry('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'g1-stdio-b', version: '0' } })
  const lr = await B.rpcRetry('tools/list', {})
  const names = (lr.result?.tools || []).map((t) => t.name)
  assert(!names.includes('invoke_capability'), 'state 关闭：invoke_capability 不在目录')
  assert(names.length === 5, 'state 关闭：graph 目录 5 项（得 ' + names.length + '）')
  const r = await B.call('invoke_capability', { workspace_dir: WS, name: 'active_todos' })
  assert(r.ok === false && /state|not available/i.test(JSON.stringify(r._rpcError || r)), 'state 关闭：直呼被 STATE 门控拒绝')
} finally { B.kill() }

setTimeout(() => {
  console.log('\n=== test-invoke-stdio: ' + pass + ' passed, ' + fail + ' failed ===')
  process.exit(fail > 0 ? 1 : 0)
}, 3000)
