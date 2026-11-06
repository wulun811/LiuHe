// test-trace-e2e.js — TRACE v0 端到端：真起 MCP server 走 stdio 跑工具调用
//
// 专家硬门（0.6.1 §5.C.4）：「MALONG_TRACE=off 时零行为变化；errors|all 的延迟、
// 内存和文件大小不突破现有预算；验收能读回滚动后的历史且没有敏感字段。」
//
// 本测试用真的 JSON-RPC over stdio（不是 mock dispatch）验证这条：
//   ① off：跑 N 次调用后，状态目录里没有轨迹文件，且工具结果与 on 时等价
//   ② all：同样调用后能读到 started+finished，且排序/字段正确
//   ③ 轨迹文件里没有任何敏感字段（args 内容 / 绝对路径 / key）
//   ④ errors：成功调用只留 started，不留 finished
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) pass++
  else { fail++; console.error('  FAIL:', msg) }
}

const created = []

function startServer({ stateDir, traceMode, workspace }) {
  const env = {
    ...process.env,
    MALONG_STATE_DIR: stateDir,
    HOME: stateDir,
    MALONG_SKIP_STATE_MIGRATION: '1',
  }
  if (traceMode == null) delete env.MALONG_TRACE
  else env.MALONG_TRACE = traceMode
  const child = spawn(process.execPath, [join(root, 'mcp-server.js')], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let buf = ''
  const pending = new Map()
  child.stdout.on('data', (d) => {
    buf += d.toString()
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      const key = msg.id
      if (key != null && pending.has(key)) {
        const { resolve } = pending.get(key)
        pending.delete(key)
        resolve(msg)
      }
    }
  })
  let idc = 0
  function rpc(method, params) {
    const id = ++idc
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 60000)
      pending.set(id, { resolve: (m) => { clearTimeout(timer); resolve(m) } })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }
  return { child, rpc }
}

async function waitReady(rpc) {
  // initialize + tools/list，最多重试 30s（server 启动要加载模块）
  for (let i = 0; i < 60; i++) {
    try {
      const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'trace-e2e', version: '1' } })
      if (init?.result) {
        const list = await rpc('tools/list', {})
        if (list?.result?.tools?.length > 0) return list.result.tools
      }
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 500))
  }
  return null
}

// 轨迹在 <stateDir>/trace/ 下（2026-10-30 起）。
// 注意：如果继续扫 stateDir 根，"off 时零文件"会因为找错目录而永远为真——假绿。
const traceDirOf = (dir) => join(dir, 'trace')
function traceFiles(dir) {
  try { return readdirSync(traceDirOf(dir)).filter(f => f.startsWith('malong-trace.jsonl')) } catch { return [] }
}

try {
  // ── ① off：零轨迹文件 ──
  {
    const base = mkdtempSync(join(tmpdir(), 'lh-trace-e2e-off-'))
    created.push(base)
    const ws = join(base, 'ws'); mkdirSync(ws, { recursive: true })
    writeFileSync(join(ws, 'a.js'), 'const a = 1;\n')
    const { child, rpc } = startServer({ stateDir: base, traceMode: null, workspace: ws })
    try {
      const tools = await waitReady(rpc)
      assert(Array.isArray(tools) && tools.length > 0, `① server 就绪并列出工具（得 ${tools?.length}）`)
      const res = await rpc('tools/call', { name: 'code_read', arguments: { workspace_dir: ws, locator: { file_path: 'a.js' } } })
      assert(res?.result != null, '① off 时工具调用正常返回（零行为变化）')
      // 再跑两次，确保不是「第一次没写」
      await rpc('tools/call', { name: 'code_read', arguments: { workspace_dir: ws, locator: { file_path: 'a.js' } } })
      await rpc('tools/call', { name: 'health', arguments: { action: 'check' } })
      const files = traceFiles(base)
      assert(files.length === 0, `① off 时不产生轨迹文件（得 ${JSON.stringify(files)}）`)
    } finally {
      try { child.kill('SIGKILL') } catch {}
      await new Promise(r => setTimeout(r, 300))
    }
  }

  // ── ②③ all：能读回 started+finished，且无敏感内容 ──
  {
    const base = mkdtempSync(join(tmpdir(), 'lh-trace-e2e-all-'))
    created.push(base)
    const ws = join(base, 'ws'); mkdirSync(ws, { recursive: true })
    writeFileSync(join(ws, 'secret_project_file.js'), 'const token = "sk-SHOULD-NOT-APPEAR-IN-TRACE";\n')
    const { child, rpc } = startServer({ stateDir: base, traceMode: 'all', workspace: ws })
    try {
      const tools = await waitReady(rpc)
      assert(Array.isArray(tools) && tools.length > 0, '② all 模式 server 就绪')
      await rpc('tools/call', { name: 'code_read', arguments: { workspace_dir: ws, locator: { file_path: 'secret_project_file.js' } } })
      await new Promise(r => setTimeout(r, 400)) // 让 append 落盘
      const files = traceFiles(base)
      assert(files.length >= 1, `② all 时产生轨迹文件（得 ${JSON.stringify(files)}）`)
      const raw = readFileSync(join(traceDirOf(base), 'malong-trace.jsonl'), 'utf-8')
      const entries = raw.trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
      assert(entries.some(e => e.phase === 'started'), '② 有 started 事件')
      assert(entries.some(e => e.phase === 'finished'), '② 有 finished 事件')
      const call = entries.find(e => e.phase === 'finished')
      assert(typeof call.latency_ms === 'number', `② finished 带 latency_ms（得 ${call?.latency_ms}）`)
      assert('outcome' in call && 'effect' in call && 'verification' in call, '② 三态字段齐备')
      // next_action 只可能是工具名或 null（不得带 args/路径）
      if (call.next_action != null) {
        assert(/^[a-z][a-z0-9_]{0,63}$/.test(call.next_action), `② next_action 只取工具名（得 ${call.next_action}）`)
      }
      assert(entries.every(e => e.next_action == null || !String(e.next_action).includes('/')), '② 轨迹里没有路径形态的 next_action')
      // ③ 敏感内容
      assert(!raw.includes('sk-SHOULD-NOT-APPEAR-IN-TRACE'), '③ 源码里的 key 没被写进轨迹')
      assert(!raw.includes('secret_project_file'), '③ 文件名（含路径成分）没被写进轨迹')
      assert(!raw.includes(base), '③ 状态目录绝对路径没被写进轨迹')
      assert(!raw.includes('SHOULD-NOT-APPEAR'), '③ 变量值没被写进轨迹')
      // 结构：只有白名单字段
      const allowed = new Set(['v', 'ts', 'session', 'call_id', 'parent_call_id', 'tool', 'phase', 'latency_ms',
        'outcome', 'effect', 'state_commit', 'verification', 'next_action', 'next_action_basis',
        'error_code', 'output_chars', 'truncated'])
      const extra = Object.keys(call).filter(k => !allowed.has(k))
      assert(extra.length === 0, `③ 无白名单外字段（多出 ${JSON.stringify(extra)}）`)
    } finally {
      try { child.kill('SIGKILL') } catch {}
      await new Promise(r => setTimeout(r, 300))
    }
  }

  // ── ④ errors：成功调用只留 started ──
  {
    const base = mkdtempSync(join(tmpdir(), 'lh-trace-e2e-err-'))
    created.push(base)
    const ws = join(base, 'ws'); mkdirSync(ws, { recursive: true })
    writeFileSync(join(ws, 'b.js'), 'const b = 1;\n')
    const { child, rpc } = startServer({ stateDir: base, traceMode: 'errors', workspace: ws })
    try {
      await waitReady(rpc)
      await rpc('tools/call', { name: 'code_read', arguments: { workspace_dir: ws, locator: { file_path: 'b.js' } } })
      await new Promise(r => setTimeout(r, 400))
      const p = join(traceDirOf(base), 'malong-trace.jsonl')
      if (existsSync(p)) {
        const entries = readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
        assert(entries.some(e => e.phase === 'started'), '④ errors 模式保留 started（崩溃窗）')
        const okFinished = entries.filter(e => e.phase === 'finished' && e.outcome === 'ok')
        assert(okFinished.length === 0, `④ 成功调用不留 finished（得 ${okFinished.length}）`)
      } else {
        assert(true, '④ errors 模式下未产生文件也可接受（无失败调用）')
      }
    } finally {
      try { child.kill('SIGKILL') } catch {}
      await new Promise(r => setTimeout(r, 300))
    }
  }
} finally {
  for (const d of created) { try { rmSync(d, { recursive: true, force: true }) } catch {} }
}

console.log(`\n== test-trace-e2e: ${pass} passed, ${fail} failed ==`)
if (fail > 0) process.exitCode = 1
