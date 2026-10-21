// Real two-process MCP regression: pause B after its stale lookup, finish A, then resume B.
// Inspector controls scheduling only; the product handlers and filesystem remain unchanged.
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

if (typeof WebSocket === 'undefined') {
  console.log('NOT_RUN: test-invoke-claim-race requires a Node runtime with WebSocket (CI: Node 22)')
  process.exit(0)
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const base = mkdtempSync(join(tmpdir(), 'malong-claim-race-'))
const ws = base, state = join(base, 'state')
writeFileSync(join(ws, 'append.cjs'), 'require("node:fs").appendFileSync("counter.txt", "once\\n"); console.log("done")\n')
writeFileSync(join(ws, 'fail.cjs'), 'require("node:fs").appendFileSync("counter.txt", "once\\n"); process.exit(1)\n')
writeFileSync(join(ws, 'package.json'), '{"type":"module"}')
const trace = []
function client(tag, inspect = false) {
  const child = spawn(process.execPath, [...(inspect ? ['--inspect=127.0.0.1:0'] : []), join(root, 'mcp-server.js'), '--workspace', ws], {
    cwd: ws, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, MALONG_INTERFACE: 'graph', MALONG_ENTRY_STATE: '1', MALONG_STATE_DIR: state },
  })
  let buffer = '', stderr = '', seq = 0
  const pending = new Map()
  child.stderr.on('data', b => { stderr += b })
  child.stdout.on('data', b => {
    buffer += b
    let n
    while ((n = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, n); buffer = buffer.slice(n + 1)
      try {
        const m = JSON.parse(line)
        if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
      } catch {}
    }
  })
  async function rpc(method, params) {
    const id = ++seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(tag + ': timeout ' + method)) }, 30000)
      pending.set(id, m => { clearTimeout(timer); resolve(m) })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }
  async function call(name, args) {
    for (let i = 0; i < 40; i++) {
      const r = await rpc('tools/call', { name, arguments: args })
      if (r.error?.code === -32000) { await new Promise(r => setTimeout(r, 100)); continue }
      trace.push({ tag, name, args, response: r })
      if (r.error) throw new Error(JSON.stringify(r.error))
      return JSON.parse(r.result.content[0].text)
    }
    throw new Error(tag + ': server not ready')
  }
  async function stop() {
    child.stdin.end()
    if (child.exitCode !== null) return
    await new Promise(resolve => {
      child.once('exit', resolve)
      child.kill()
    })
  }
  return { rpc, call, stop, stderr: () => stderr }
}
const A = client('A'), B = client('B', true)
let socket, send, pass = 0, fail = 0
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  FAIL: ' + msg) } }
try {
  for (const c of [A, B]) {
    await c.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'claim-race-test', version: '1' } })
    await c.call('code_query', { workspace_dir: ws, mode: 'capabilities' })
  }
  const url = B.stderr().match(/ws:\/\/[^\s]+/)?.[0]
  if (!url) throw new Error('inspector URL missing')
  socket = new WebSocket(url)
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  let seq = 0, pauseWaiter = null
  const pending = new Map()
  socket.addEventListener('message', e => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
    if (m.method === 'Debugger.paused' && pauseWaiter) { const done = pauseWaiter; pauseWaiter = null; done() }
  })
  send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('inspector timeout: ' + method)) }, 15000)
    pending.set(id, r => { clearTimeout(timer); r.error ? reject(new Error(JSON.stringify(r.error))) : resolve(r.result) })
    socket.send(JSON.stringify({ id, method, params }))
  })
  await send('Debugger.enable')
  const handler = join(root, 'tools/tool-invoke-capability/handler.js')
  const line = readFileSync(handler, 'utf8').split(/\r?\n/).findIndex(s => s.includes('const claim = ledgerClaim(workspaceDir, reqId)'))
  if (line < 0) throw new Error('claim source line missing')
  await send('Debugger.setBreakpointByUrl', { url: pathToFileURL(handler).href, lineNumber: line, condition: 'reqId && reqId.startsWith("race-")' })
  const counter = () => existsSync(join(ws, 'counter.txt')) ? readFileSync(join(ws, 'counter.txt'), 'utf8') : ''
  for (const kind of ['same', 'conflict', 'failed']) {
    const request = { workspace_dir: ws, name: 'debug_runner', request_id: 'race-' + kind, args: { script: kind === 'failed' ? 'fail.cjs' : 'append.cjs' } }
    const paused = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pauseWaiter = null; reject(new Error('B did not pause')) }, 15000)
      pauseWaiter = () => { clearTimeout(timer); resolve() }
    })
    const before = counter()
    const bp = B.call('invoke_capability', kind === 'conflict' ? { ...request, args: { ...request.args, timeout: 31000 } } : request)
    // Attach rejection immediately while A runs, then inspect it after resuming.
    const observed = bp.then(value => ({ value }), error => ({ error }))
    await paused
    const a = await A.call('invoke_capability', request)
    const afterA = counter()
    await send('Debugger.resume')
    const b = await observed
    if (b.error) throw b.error
    assert(a.delegated === true && afterA !== before, kind + ': A really executed')
    assert(counter() === afterA, kind + ': B must not repeat the side effect')
    if (kind === 'same') assert(b.value.deduplicated === true && b.value.delegated === false, 'same: B deduplicates the completed request')
    if (kind === 'conflict') assert(b.value.error === 'request_conflict', 'conflict: stale B rejects a changed payload')
    if (kind === 'failed') assert(a.operation_succeeded === false && b.value.error === 'request_unresolved', 'failed: stale B refuses to replay a failed command')
  }
} catch (e) { fail++; console.error(e.stack || e) }
finally {
  if (send) { try { await send('Debugger.resume') } catch {} }
  if (socket) socket.close()
  await Promise.all([A.stop(), B.stop()])
  writeFileSync(join(base, 'trace.json'), JSON.stringify(trace, null, 2))
  writeFileSync(join(base, 'stderr.log'), A.stderr() + '\n--- B ---\n' + B.stderr())
}
console.log(`=== test-invoke-claim-race: ${pass} passed, ${fail} failed ===`)
if (fail) console.error('Evidence: ' + base)
process.exit(fail ? 1 : 0)
