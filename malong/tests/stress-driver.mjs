#!/usr/bin/env node
// stress-driver.mjs — 独立压测驱动（干净设计，非模板字符串）
// 模型：N 个客户端 worker 协程，在固定时长内持续发请求（模拟真实 LLM 高并发使用）。
//       服务端 concurrency 由 --concurrency 控制（信号量排队）。测 RSS 峰值 / OOM / 吞吐 / 延迟 / 错误。
// 用法: node stress-driver.mjs --malong-dir DIR --fixture DIR --state-dir DIR \
//         --concurrency C --workers W --seconds S --mode steady|cold
// 输出: 最后一行 JSON: {"concurrency":..,"workers":..,"completed":..,"errors":..,"peakRssMb":..,"p50":..,"p95":..,"oom":..,"errSamples":[..]}

import { spawn } from 'node:child_process'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

// ── 参数解析 ──
const argv = process.argv.slice(2)
const arg = (name, def) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 ? argv[i + 1] : def
}
const MALONG = arg('malong-dir', '/app')
const FIXTURE = arg('fixture', '/tmp/fixture')
const STATE_DIR = arg('state-dir', '/tmp/mstate')
const CONCURRENCY = parseInt(arg('concurrency', '3'), 10)
const WORKERS = parseInt(arg('workers', '6'), 10)
const SECONDS = parseInt(arg('seconds', '20'), 10)
const MODE = arg('mode', 'steady')

// ── 构造真实读目标（跨包的 file/symbol 对）──
const targets = []
try {
  const srcDir = join(FIXTURE, 'src')
  for (const pkg of readdirSync(srcDir)) {
    const dir = join(srcDir, pkg)
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.py')) continue
      const rel = `src/${pkg}/${f}`
      const num = f.match(/mod_(\d+)/)?.[1] ?? '0'
      targets.push({ file: rel, symbol: `func_${num}_1`, klass: `Klass${num}` })
    }
  }
} catch (e) {
  console.error('build targets failed:', e.message)
}
if (!targets.length) targets.push({ file: 'src/pkg0/mod_0.py', symbol: 'func_0_1', klass: 'Klass0' })

// ── 启动 MCP server ──
const child = spawn(process.execPath, [
  '--max-old-space-size=480', '--expose-gc',
  join(MALONG, 'mcp-server.js'),
  '--workspace', FIXTURE,
  '--state-dir', STATE_DIR,
  '--concurrency', String(CONCURRENCY),
], { stdio: ['pipe', 'pipe', 'pipe'] })

// ── JSON-RPC 客户端（id 关联 + 逐请求计时）──
let buf = ''
let stderrBuf = ''
const pending = new Map()
let nextId = 1
let oom = false

child.stdout.setEncoding('utf-8')
child.stdout.on('data', (d) => {
  buf += d
  let idx
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim()
    buf = buf.slice(idx + 1)
    if (!line) continue
    let j
    try { j = JSON.parse(line) } catch { continue }
    if (j.id != null && pending.has(j.id)) {
      const p = pending.get(j.id)
      pending.delete(j.id)
      p.resolve(j)
    }
  }
})
child.stderr.setEncoding('utf-8')
child.stderr.on('data', (d) => {
  stderrBuf += d
  const s = d
  if (s.includes('heap out of memory') || s.includes('FATAL') || s.includes('JavaScript heap')) {
    oom = true
  }
})
child.on('exit', (code, signal) => {
  if (signal === 'SIGKILL' || code === 134 || code === 137) oom = true
  for (const p of pending.values()) p.reject(new Error('server exited'))
  pending.clear()
})

function call(method, params, timeoutMs = 90000) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        reject(new Error('client timeout ' + timeoutMs + 'ms'))
      }
    }, timeoutMs)
    pending.set(id, {
      resolve: (j) => { clearTimeout(timer); resolve(j) },
      reject: (e) => { clearTimeout(timer); reject(e) },
    })
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
  })
}

// ── RSS 采样 ──
let peakRssKb = 0
const sampler = setInterval(() => {
  try {
    const st = readFileSync(`/proc/${child.pid}/status`, 'utf8')
    const m = st.match(/VmRSS:\s+(\d+)/)
    if (m) peakRssKb = Math.max(peakRssKb, parseInt(m[1], 10))
  } catch {}
}, 100)

// ── 等待 server ready ──
async function waitReady(timeoutMs = 60000) {
  const t0 = Date.now()
  while (!stderrBuf.includes('server ready')) {
    if (Date.now() - t0 > timeoutMs) throw new Error('server not ready in ' + timeoutMs + 'ms')
    await new Promise((r) => setTimeout(r, 200))
  }
}

// ── 工具请求构造（稳态：以读为主 + 少量增量 reindex）──
let pick = 0
function nextReadReq() {
  const t = targets[pick++ % targets.length]
  const kind = pick % 10
  if (kind === 0) return { name: 'reindex', arguments: { workspace_dir: FIXTURE, blocking: true, threshold: 5000 } }
  if (kind === 1) return { name: 'repo_map', arguments: { workspace_dir: FIXTURE, focused: true } }
  if (kind === 2) return { name: 'read_symbol', arguments: { workspace_dir: FIXTURE, locator: { file_path: t.file, name: t.symbol } } }
  if (kind === 3) return { name: 'call_chain', arguments: { workspace_dir: FIXTURE, file: t.file, line: 5 } }
  if (kind === 4) return { name: 'references', arguments: { workspace_dir: FIXTURE, symbol: t.symbol, file: t.file } }
  if (kind === 5) return { name: 'dep_graph', arguments: { workspace_dir: FIXTURE, file: t.file } }
  if (kind === 6) return { name: 'impact_analysis', arguments: { workspace_dir: FIXTURE, file: t.file, symbol: t.symbol } }
  if (kind === 7) return { name: 'read_outline', arguments: { workspace_dir: FIXTURE, file: t.file } }
  if (kind === 8) return { name: 'symbol_search', arguments: { workspace_dir: FIXTURE, query: t.symbol } }
  return { name: 'read_symbol', arguments: { workspace_dir: FIXTURE, locator: { file_path: t.file, name: t.klass } } }
}

// ── 主流程 ──
async function main() {
  await call('initialize', {})
  await waitReady()

  // 稳态模式：先建一次索引（不计入指标）
  if (MODE === 'steady') {
    await call('tools/call', { name: 'reindex', arguments: { workspace_dir: FIXTURE, blocking: true, threshold: 5000 } }, 180000)
  }

  // 测量阶段
  const latencies = []
  const errSamples = new Set()
  let completed = 0
  let errors = 0
  const deadline = Date.now() + SECONDS * 1000
  const startMs = Date.now()

  async function workerLoop() {
    while (Date.now() < deadline && !oom) {
      const req = nextReadReq()
      const t0 = Date.now()
      try {
        const j = await call('tools/call', req, 90000)
        const ms = Date.now() - t0
        if (j.error) {
          errors++
          errSamples.add((j.error.message || JSON.stringify(j.error)).slice(0, 60))
        } else {
          completed++
          latencies.push(ms)
        }
      } catch (e) {
        errors++
        errSamples.add((e.message || 'unknown').slice(0, 60))
      }
    }
  }

  await Promise.all(Array.from({ length: WORKERS }, () => workerLoop()))

  // 收尾
  await new Promise((r) => setTimeout(r, 300))
  clearInterval(sampler)
  latencies.sort((a, b) => a - b)
  const pct = (q) => latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * q))] : 0
  const elapsed = (Date.now() - startMs) / 1000

  const result = {
    concurrency: CONCURRENCY,
    workers: WORKERS,
    mode: MODE,
    completed,
    errors,
    throughput: Math.round(completed / elapsed * 10) / 10,
    peakRssMb: Math.round(peakRssKb / 1024),
    p50: pct(0.5),
    p95: pct(0.95),
    p99: pct(0.99),
    oom,
    errSamples: [...errSamples].slice(0, 4),
  }
  console.log('RESULT_JSON ' + JSON.stringify(result))
  child.kill('SIGKILL')
  setTimeout(() => process.exit(0), 200)
}

main().catch((e) => {
  console.log('RESULT_JSON ' + JSON.stringify({ concurrency: CONCURRENCY, workers: WORKERS, mode: MODE, completed: 0, errors: 1, peakRssMb: Math.round(peakRssKb / 1024), oom, fatal: e.message.slice(0, 120), errSamples: [e.message.slice(0, 80)] }))
  try { child.kill('SIGKILL') } catch {}
  process.exit(1)
})
