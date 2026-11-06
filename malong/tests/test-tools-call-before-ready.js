// test-tools-call-before-ready.js — 装载期 tools/call 必须排队等待，不得直接报错
//
// 真实缺陷（2026-11-05 自用试用实测，R21 产物）：
//   新进程起来后【不发 tools/list】直接 tools/call，5 次里有 2~3 次拿到
//   JSON-RPC -32000 "Server still loading modules, please retry in a few seconds"。
//   同一个「还没装完」状态，tools/list 会排队等待（waitForReady），tools/call 却直接失败。
//   调用方（agent / dsh）通常把它当真失败，而不是「等两秒再来」。
//
// 判据：initialize 完成后、不发 tools/list，直接 tools/call 必须成功。
// 重复 N 次新进程，任何一次 -32000 即判失败（这正是用户会遇到的情形）。

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MALONG = join(__dirname, '..')
const SERVER = join(MALONG, 'mcp-server.js')
const TMP = join(process.env.TMPDIR || '/tmp', 'opencode', 'test-ready-' + process.pid)

let pass = 0, fail = 0
const assert = (c, m) => { if (c) pass++; else { fail++; console.error('  FAIL: ' + m) } }

function makeWs(n) {
  const root = join(TMP, 'r' + n)
  const WS = join(root, 'ws'); const S = join(root, 'state')
  mkdirSync(join(WS, 'src'), { recursive: true }); mkdirSync(S, { recursive: true })
  writeFileSync(join(WS, 'src', 'impl.js'), '// outline 注释\nexport function buildOutlineNode(x) { return x }\n', 'utf-8')
  return { WS, S }
}

async function oneColdCall(n) {
  const { WS, S } = makeWs(n)
  const env = {
    ...process.env, MALONG_STATE_DIR: S,
    MALONG_TRACE: '', MALONG_SEARCH_LOG: '', MALONG_DEV_COLLECT: '',
  }
  if (process.env.MALONG_PARSE_BIN) env.MALONG_PARSE_BIN = process.env.MALONG_PARSE_BIN
  const ch = spawn(process.execPath, [SERVER], { cwd: WS, env, stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''
  ch.stderr.on('data', (d) => { stderr += d.toString() })
  const rl = createInterface({ input: ch.stdout })
  let id = 1
  const p = new Map()
  rl.on('line', (l) => {
    const s = l.trim(); if (!s) return
    let m; try { m = JSON.parse(s) } catch { return }
    if (m.id != null && p.has(m.id)) { const f = p.get(m.id); p.delete(m.id); f(m) }
  })
  const rpc = (me, pa) => new Promise((res, rej) => {
    const i = id++
    const t = setTimeout(() => { p.delete(i); rej(new Error('timeout ' + me)) }, 120000)
    p.set(i, (m) => { clearTimeout(t); res(m) })
    ch.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method: me, params: pa }) + '\n')
  })
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'ready', version: '1' } })
  ch.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n')
  // 关键：不发 tools/list，直接 tools/call
  let out
  try {
    const r = await rpc('tools/call', { name: 'code_task', arguments: { workspace_dir: WS, goal: '让 outline 支持 python' } })
    if (r.error) out = { kind: 'jsonrpc_error', code: r.error.code, message: r.error.message }
    else {
      const t = (r.result?.content || []).find((c) => c.type === 'text')
      if (!t) out = { kind: 'no_text' }
      else { try { const q = JSON.parse(t.text); out = { kind: q.ok ? 'ok' : 'tool_error', error: q.error } } catch { out = { kind: 'bad_json' } } }
    }
  } catch (e) {
    out = { kind: 'timeout', message: e.message }
  }
  try { ch.kill('SIGTERM') } catch {}
  await new Promise((r) => setTimeout(r, 500))
  try { ch.kill('SIGKILL') } catch {}
  return { out, stderr }
}

rmSync(TMP, { recursive: true, force: true })
const RUNS = 5
try {
  for (let i = 1; i <= RUNS; i++) {
    const { out } = await oneColdCall(i)
    assert(out.kind === 'ok',
      `第 ${i} 次新进程：initialize 后直接 tools/call 必须成功，实际 ${JSON.stringify(out)}` +
      (out.kind === 'jsonrpc_error' && out.code === -32000
        ? '（-32000 = 装载期被当成失败；同一状态 tools/list 会等待，tools/call 不该例外）' : ''))
  }
} catch (e) {
  fail++
  console.error('  执行异常: ' + e.message)
} finally {
  await new Promise((r) => setTimeout(r, 600))
  try { rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }) } catch {}
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
