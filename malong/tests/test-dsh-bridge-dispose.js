// test-dsh-bridge-dispose.js — R1（0.6.2）：cordis 4 fiber 卸载必须杀掉 MCP 子进程且不重启
//
// 背景：0.6.1 用 ctx.on("dispose", ...) 注册清理；cordis 4.1.0 在 fiber 卸载时不会 emit
// "dispose"（只 emit internal/*），监听器永远不执行。子进程的 exit 回调仍会 scheduleRestart，
// 于是已卸载的 bridge 会把 mcp-server 拉起来，和新的安装实例共用 stateDir。
//
// 本测试不依赖 DSH 本体：用 fake ctx 模拟 cordis 4 的 effect 语义（factory 立即执行，
// fiber 卸载调用返回的 disposer），并用一个 echo 型假 MCP server 记录每次 spawn 的 PID。
// 断言：dispose 后子进程退出；等待超过 restart backoff 后没有第二个 PID。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MALONG = join(__dirname, '..')
const TMP = join(tmpdir(), 'opencode', 'dsh-bridge-dispose')
const FAKE = join(TMP, 'fake-mcp-server.mjs')
const SPAWN_LOG = join(TMP, 'spawns.log')

let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++; console.log('  ok ' + msg) }
  else { fail++; console.error('  FAIL: ' + msg) }
}

const FAKE_SOURCE = String.raw`
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const NL = String.fromCharCode(10)
const log = process.env.FAKE_SPAWN_LOG
if (log) appendFileSync(log, String(process.pid) + NL)

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake-mcp', version: '0.0.0' } } }) + NL)
  } else if (msg.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [] } }) + NL)
  } else if (msg.method === 'tools/call') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'ok' }] } }) + NL)
  }
})

if (process.env.FAKE_IGNORE_TERM === '1') {
  process.on('SIGTERM', () => {})
} else {
  process.on('SIGTERM', () => process.exit(0))
}
setInterval(() => {}, 1000).unref()
`

function alive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

function readPids() {
  try {
    return readFileSync(SPAWN_LOG, 'utf-8').trim().split(String.fromCharCode(10)).filter(Boolean).map(Number)
  } catch { return [] }
}

async function waitFor(fn, ms) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (fn()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return fn()
}

async function runCase(label, ignoreTerm) {
  rmSync(SPAWN_LOG, { force: true })
  const saved = process.env.FAKE_IGNORE_TERM
  if (ignoreTerm) process.env.FAKE_IGNORE_TERM = '1'
  else delete process.env.FAKE_IGNORE_TERM
  let disposeFn = null
  let pids = []
  try {
    let effectLabel = null
    const ctx = {
      tools: { register() {} },
      effect(execute, label) {
        effectLabel = label
        disposeFn = execute()
        return disposeFn
      },
      on(event) {
        if (event === 'dispose') throw new Error('cordis 4 must not use ctx.on("dispose")')
      },
    }
    const bridge = await import(pathToFileURL(join(MALONG, 'dsh', 'dsh-bridge.mjs')).href + '?dispose=' + (ignoreTerm ? 'ignore-term' : 'normal'))
    let applyError = null
    try {
      await bridge.apply(ctx, { serverPath: FAKE, stateDir: TMP, toolCallTimeoutMs: 5000 })
    } catch (e) {
      applyError = e
    }
    assert(!applyError, label + '：bridge apply 成功（' + (applyError ? applyError.message : 'ok') + '）')
    if (applyError) return
    assert(effectLabel === 'malong-dsh-bridge lifecycle', label + '：用 ctx.effect 注册生命周期清理（label=' + effectLabel + '）')
    assert(typeof disposeFn === 'function', label + '：effect factory 返回 disposer')
    const spawned = await waitFor(() => readPids().length === 1, 3000)
    assert(spawned, label + '：fake mcp-server 已启动')
    pids = readPids()
    const pid = pids[0]
    assert(typeof pid === 'number' && pid > 0, label + '：记录到子进程 pid')
    assert(alive(pid), label + '：dispose 前子进程存活（pid=' + pid + '）')
    if (typeof disposeFn === 'function') disposeFn()
    const dead = await waitFor(() => !alive(pid), 4500)
    assert(dead, label + '：dispose 后子进程已退出（pid=' + pid + '）')
    await new Promise((r) => setTimeout(r, 1600))
    const after = readPids()
    assert(after.length === 1, label + '：dispose 后不得重启（spawn 次数=' + after.length + '）')
  } finally {
    try { if (typeof disposeFn === 'function') disposeFn() } catch {}
    for (const pid of pids) {
      try { process.kill(pid, 'SIGKILL') } catch {}
    }
    if (saved === undefined) delete process.env.FAKE_IGNORE_TERM
    else process.env.FAKE_IGNORE_TERM = saved
  }
}

rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })
writeFileSync(FAKE, FAKE_SOURCE)
process.env.FAKE_SPAWN_LOG = SPAWN_LOG

console.log('== test-dsh-bridge-dispose: cordis 4 effect cleanup ==')
if (process.platform === 'win32') {
  console.log('== skipped: DSH bridge is Linux-verified only; no POSIX signal assertions on win32 ==')
  process.exit(0)
}
await runCase('SIGTERM 正常退出', false)
await runCase('忽略 SIGTERM → 2s 后 SIGKILL 兜底', true)
rmSync(TMP, { recursive: true, force: true })
console.log('')
console.log('== test-dsh-bridge-dispose: ' + pass + ' passed, ' + fail + ' failed ==')
process.exit(fail > 0 ? 1 : 0)
