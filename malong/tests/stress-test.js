#!/usr/bin/env node
// stress-test.js — malong MCP 512MB 内存限制压测（三阶段）
// Phase 1: 单工具内存画像（38 工具逐个，--expose-gc 归零测增量）
// Phase 2: 并发阶梯（docker --memory=512m 真 cgroup 限制，测峰值 RSS / OOM / 吞吐 / 延迟）
// Phase 3: 排队机制验证（真实 MCP 进程，慢工具制造排队，验证 FIFO/超时/账本恢复）
// 用法: node --expose-gc tests/stress-test.js --phase 1|2|3 [--concurrency N] [--docker]

import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MALONG_DIR = join(__dirname, '..')
const TOOLS_DIR = join(MALONG_DIR, 'tools')
const FIXTURE = '/tmp/opencode/stress-fixture'
const REPO_DOCS = '/home/chen/1q/0bore/docs/六合工具集/docs'
const OUT_DIR = existsSync(REPO_DOCS) ? REPO_DOCS : join(MALONG_DIR, 'docs')

const phase = process.argv.indexOf('--phase')
const PHASE = phase >= 0 ? process.argv[phase + 1] : '1'
const CONCURRENCY = parseInt((process.argv.find((a, i) => process.argv[i - 1] === '--concurrency')) || '3', 10)
const USE_DOCKER = process.argv.includes('--docker')

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const gc = () => { if (global.gc) global.gc() }

// ═══════════════════════════════════════════
// Phase 1: 单工具内存画像
// ═══════════════════════════════════════════
async function phase1() {
  console.log('═══ Phase 1: 单工具内存画像 ═══')
  const { default: ToolRegistry } = await import(join(MALONG_DIR, 'tool-registry.js'))
  const registry = new ToolRegistry(TOOLS_DIR, { log: () => {} })
  registry._usagePath = '/tmp/opencode/stress-usage.jsonl'
  await registry.loadAll()
  const names = registry.getToolNames()
  console.log(`tools: ${names.length}`)

  // 真实服务链装配（镜像 mcp-server.js initModules）
  const workspacesDir = '/tmp/opencode/stress-ws'
  const getWorkspaceDir = (workspaceDir) => {
    const hash = createHash('md5').update(resolve(workspaceDir)).digest('hex').slice(0, 12)
    const wsDir = join(workspacesDir, hash)
    if (!existsSync(wsDir)) mkdirSync(wsDir, { recursive: true })
    return wsDir
  }
  const services = {}
  const core = {
    stateDir: '/tmp/opencode/stress-state',
    services,
    log() {},
    emit() {},
    on() {},
    off() {},
    get() { return undefined },
    registerService(name, svc) { services[name] = svc },
    getService(name) { return services[name] },
    getWorkspaceDir,
  }
  try {
    const langParserMod = await import(join(MALONG_DIR, 'lang-parser.js'))
    await langParserMod.init(core)
  } catch (e) {
    console.log('  [warn] lang-parser init 失败:', e.message?.slice(0, 80))
  }
  try {
    const codeIndexMod = await import(join(MALONG_DIR, 'code-index.js'))
    await codeIndexMod.init(core)
  } catch (e) {
    console.log('  [warn] code-index init 失败:', e.message?.slice(0, 80))
  }
  try {
    const repoMapMod = await import(join(MALONG_DIR, 'repo-map.js'))
    await repoMapMod.init(core)
  } catch (e) {
    console.log('  [warn] repo-map init 失败:', e.message?.slice(0, 80))
  }

  const ctx = {
    workspace_dir: FIXTURE,
    log: () => {},
    stateDir: '/tmp/opencode/stress-state',
    workspacesDir,
    getWorkspaceDir,
    services,
    codeIndexService: services.codeIndex,
    repoMapService: services.repoMap,
    langParserService: services.langParser,
    semaphore: { current: 0, max: 3, queue: [] },
    activeRequests: new Map(),
  }
  mkdirSync(ctx.stateDir, { recursive: true })

  // 预建索引：让读/引用类工具有真实数据可查（不计入单工具画像）
  if (services.codeIndex) {
    try {
      const t0 = Date.now()
      await registry.callTool('reindex', { workspace_dir: FIXTURE, blocking: true }, ctx)
      console.log(`  [setup] reindex 预建索引完成 (${Math.round((Date.now() - t0) / 1000)}s)`)
    } catch (e) {
      console.log('  [warn] 预建索引失败:', e.message?.slice(0, 100))
    }
  }
  const file = 'src/pkg1/mod0.py'
  const ARGS = {
    'reindex': { workspace_dir: FIXTURE, blocking: true },
    'read_symbol': { workspace_dir: FIXTURE, locator: { file_path: file, name: 'func_1' } },
    'read_outline': { workspace_dir: FIXTURE, file, depth: 1 },
    'call_chain': { workspace_dir: FIXTURE, file, line: 5 },
    'inspect': { workspace_dir: FIXTURE, file, symbol: 'func_1' },
    'references': { workspace_dir: FIXTURE, symbol: 'func_1', file },
    'symbol_search': { workspace_dir: FIXTURE, query: 'func_1' },
    'dep_graph': { workspace_dir: FIXTURE, file },
    'impact_analysis': { workspace_dir: FIXTURE, file, symbol: 'func_1' },
    'trace_symbol': { workspace_dir: FIXTURE, symbol: 'func_1', file },
    'repo_map': { workspace_dir: FIXTURE, focused: true },
    'active_todos': { workspace_dir: FIXTURE },
    'code_review': { workspace_dir: FIXTURE, file },
    'style_sniffer': { workspace_dir: FIXTURE, scope: 'src' },
    'security_review': { workspace_dir: FIXTURE, file },
    'config_drift': { workspace_dir: FIXTURE, file },
    'dependency_gatekeeper': { workspace_dir: FIXTURE, file },
    'exception_guard': { workspace_dir: FIXTURE, file },
    'guard_patterns': { workspace_dir: FIXTURE, file },
    'sweep_dead_code': { workspace_dir: FIXTURE, scope: 'src', include_files: false },
    'find_tests': { workspace_dir: FIXTURE, file },
    'fix_imports': { workspace_dir: FIXTURE, file, auto_fix: false },
    'rename_symbol': { workspace_dir: FIXTURE, symbol: 'func_1', new_name: 'func_renamed', file, dry_run: true },
    'mock_sync': { workspace_dir: FIXTURE, file, function: 'func_1' },
    'naming_consistency': { workspace_dir: FIXTURE, file, new_symbols: ['func_1'] },
    'diff_facts': { workspace_dir: FIXTURE, since: 'last_txn' },
    'edit_collision_guard': { workspace_dir: FIXTURE, file, action: 'record_read' },
    'sandbox_validate': { workspace_dir: FIXTURE, file, new_content: 'def func_1(x, y):\n    return x + y\n' },
    'edit_batch': { workspace_dir: FIXTURE, file, edits: [{ old_string: 'x + y', new_string: 'x + y + 1' }], dry_run: true },
    'edit_transaction': { workspace_dir: FIXTURE, action: 'begin', name: 'stress-test' },
    'write_symbol': { workspace_dir: FIXTURE, locator: { file_path: file, name: 'func_1' }, base_version: {}, content: 'def func_1(x, y):\n    return x + y\n', dry_run: true },
    'write_symbols': { workspace_dir: FIXTURE, writes: [{ file_path: file, content: 'def func_1(x, y):\n    return x + y\n' }], dry_run: true },
    'test_bridge': { workspace_dir: FIXTURE, action: 'suggest', file },
    'debug_runner': { workspace_dir: FIXTURE, command: 'python3 -c "print(1)"' },
    'git_worktree': { workspace_dir: FIXTURE, changes: [], dry_run: true },
    'health': { workspace_dir: FIXTURE, action: 'check' },
    'feedback': { workspace_dir: FIXTURE, tool: 'stress-test', issue: 'stress test' },
    'gc': { workspace_dir: FIXTURE },
  }

  const results = []
  const TOOL_TIMEOUT = 30_000
  for (const name of names) {
    if (!ARGS[name]) continue
    gc()
    await sleep(50)
    const m0 = process.memoryUsage()
    const t0 = performance.now()
    let ok = true, err = ''
    try {
      await Promise.race([
        registry.callTool(name, ARGS[name], ctx),
        new Promise((_, rej) => setTimeout(() => rej(new Error('TOOL_TIMEOUT 30s')), TOOL_TIMEOUT)),
      ])
    } catch (e) {
      ok = false
      err = (e.message || '').split('\n')[0].slice(0, 60)
    }
    const dur = performance.now() - t0
    gc()
    await sleep(50)
    gc()
    const m1 = process.memoryUsage()
    results.push({
      tool: name,
      rss_delta_mb: Math.round((m1.rss - m0.rss) / 1048576 * 10) / 10,
      heap_delta_mb: Math.round((m1.heapUsed - m0.heapUsed) / 1048576 * 10) / 10,
      duration_ms: Math.round(dur),
      ok,
      err,
    })
    console.log(`${ok ? '✓' : '✗'} ${name}: rss Δ=${results[results.length - 1].rss_delta_mb}MB, heap Δ=${results[results.length - 1].heap_delta_mb}MB, ${Math.round(dur)}ms${err ? ' (' + err + ')' : ''}`)
  }

  const okRes = results.filter(r => r.ok)
  const sorted = [...okRes].sort((a, b) => b.rss_delta_mb - a.rss_delta_mb)
  console.log('\n═══ 内存增量 TOP 10（正常调用）═══')
  sorted.slice(0, 10).forEach(r =>
    console.log(`  ${r.tool.padEnd(24)} rss Δ=${String(r.rss_delta_mb).padStart(6)}MB  heap Δ=${String(r.heap_delta_mb).padStart(6)}MB  ${r.duration_ms}ms`))

  const md = [
    '# STRESS-512MB 压测报告',
    '',
    `> 生成时间: ${new Date().toISOString()}  |  node ${process.version}  |  Phase 1 单工具内存画像`,
    '',
    '## Phase 1: 每工具内存增量（相对基线，--expose-gc 归零）',
    '',
    '| 工具 | RSS Δ (MB) | heapUsed Δ (MB) | 耗时 (ms) | 状态 |',
    '|---|---|---|---|---|',
    ...results.map(r => `| ${r.tool} | ${r.rss_delta_mb} | ${r.heap_delta_mb} | ${r.duration_ms} | ${r.ok ? 'ok' : r.err} |`),
    '',
  ]
  writeFileSync(join(OUT_DIR, 'STRESS-512MB.md'), md.join('\n'))
  console.log(`\n报告已写入: ${join(OUT_DIR, 'STRESS-512MB.md')}`)
}

// ═══════════════════════════════════════════
// Phase 2: 并发阶梯（docker --memory=512m）
// ═══════════════════════════════════════════
async function phase2() {
  console.log('═══ Phase 2: 并发阶梯 ═══')
  if (!USE_DOCKER) {
    console.log('需要 --docker 标志（docker --memory=512m 真 cgroup 限制）')
    return
  }
  const conns = [1, 3, 6, 9, 12]
  const rows = []
  for (const c of conns) {
    const r = await dockerConcurrencyTest(c)
    rows.push(r)
  }
  const md = [
    '# STRESS-512MB 压测报告',
    '',
    `> 生成时间: ${new Date().toISOString()}  |  Phase 2 并发阶梯（docker --memory=512m）`,
    '',
    '## Phase 2: 并发阶梯结果',
    '',
    '| 并发 | 峰值 RSS (MB) | OOM | 成功/总 | 吞吐 (call/s) | P50 (ms) | P95 (ms) |',
    '|---|---|---|---|---|---|---|',
    ...rows.map(r => `| ${r.concurrency} | ${r.peak_rss_mb} | ${r.oom ? '是' : '否'} | ${r.succeeded}/${r.total} | ${r.throughput} | ${r.p50} | ${r.p95} |`),
    '',
  ]
  writeFileSync(join(OUT_DIR, 'STRESS-512MB-phase2.md'), md.join('\n'))
  console.log(`\n报告已写入: ${join(OUT_DIR, 'STRESS-512MB-phase2.md')}`)
}

async function dockerConcurrencyTest(concurrency) {
  const R = 12 // 每轮 12 个请求混合负载
  const script = `
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const child = spawn('node', ['--max-old-space-size=480', '--expose-gc', '/app/mcp-server.js',
  '--workspace', '/tmp/fixture', '--state-dir', '/tmp/mstate', '--concurrency', '${concurrency}'], {
  stdio: ['pipe', 'pipe', 'pipe'],
})
let buf = ''
const done = new Map()
let peakRssKb = 0
let startMs = 0
const memTimer = setInterval(() => {
  try {
    const status = fs.readFileSync('/proc/' + child.pid + '/status', 'utf8')
    const m = status.match(/VmRSS:\\s+(\\d+)/)
    if (m) peakRssKb = Math.max(peakRssKb, parseInt(m[1], 10))
  } catch {}
}, 100)
child.stdout.on('data', d => {
  buf += d.toString()
  let idx
  while ((idx = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1)
    if (!line) continue
    try {
      const j = JSON.parse(line)
      if (j.id != null && j.id >= 10) {
        done.set(j.id, { ms: Date.now() - startMs, error: j.error ? 1 : 0 })
      }
    } catch {}
  }
})
child.stderr.on('data', d => {
  const s = d.toString()
  if (s.includes('OOM') || s.includes('FATAL') || s.includes('heap out of memory')) process.stderr.write('[child] ' + s.slice(0, 150) + '\\n')
})
const tools = ['reindex', 'read_symbol', 'read_outline', 'call_chain', 'references', 'symbol_search']
const argsFor = (t) => t === 'reindex' ? { workspace_dir: '/tmp/fixture', blocking: true }
  : t === 'read_symbol' ? { workspace_dir: '/tmp/fixture', locator: { file_path: 'src/pkg1/mod0.py', name: 'func_1' } }
  : { workspace_dir: '/tmp/fixture', file: 'src/pkg1/mod0.py' }
child.stdin.write(JSON.stringify({ id: 1, method: 'initialize', params: {} }) + '\\n')
const grace = setInterval(() => {
  if (!child.exitCode === null) { clearInterval(grace) }
}, 500)
setTimeout(() => {
  // 等待 MCP server 就绪（initialize 响应后）
  startMs = Date.now()
  for (let i = 0; i < ${R}; i++) {
    const t = tools[i % tools.length]
    child.stdin.write(JSON.stringify({ id: 10 + i, method: 'tools/call', params: { name: t, arguments: argsFor(t) } }) + '\\n')
  }
}, 4000)
const deadline = Date.now() + 120000
const poll = setInterval(() => {
  const killed = child.exitCode !== null && child.signalCode === 'SIGKILL'
  if ((done.size >= ${R}) || Date.now() > deadline || killed) {
    clearInterval(poll); clearInterval(memTimer)
    const ms = Array.from(done.values()).map(x => x.ms).sort((a, b) => a - b)
    const p = (q) => ms.length ? ms[Math.min(ms.length - 1, Math.floor(ms.length * q))] : 0
    const errs = Array.from(done.values()).filter(x => x.error).length
    console.log('RESULT ' + JSON.stringify({
      concurrency: ${concurrency}, total: ${R}, succeeded: done.size - errs,
      oom: killed || done.size === 0,
      peak_rss_kb: peakRssKb,
      elapsed_ms: Date.now() - startMs,
      p50: p(0.5), p95: p(0.95),
    }))
    child.kill('SIGKILL')
    setTimeout(() => process.exit(0), 100)
  }
}, 200)
setTimeout(() => {
  clearInterval(memTimer)
  console.log('RESULT ' + JSON.stringify({ concurrency: ${concurrency}, total: ${R}, succeeded: 0, oom: true, peak_rss_kb: peakRssKb, elapsed_ms: 120000, p50: 0, p95: 0 }))
  process.exit(1)
}, 130000)
`
  writeFileSync('/tmp/opencode/stress-phase2-inline.js', script)
  const dockerCmd = [
    'run', '--rm', '--memory=512m',
    '-v', '/home/chen/1q/0AIT/node_modules:/app/node_modules',
    '-v', '/home/chen/1q/0AIT/plugins/malong:/app',
    '-v', '/home/chen/.local/bin/malong-parse:/usr/local/bin/malong-parse',
    '-v', '/tmp/opencode/stress-fixture:/tmp/fixture',
    '-v', '/tmp/opencode/stress-phase2-inline.js:/tmp/stress-phase2.js',
    '-w', '/app', 'node:22-slim',
    'sh', '-c', 'node /tmp/stress-phase2.js',
  ]
  console.log(`  → concurrency=${concurrency} 压测进行中...`)
  const out = execFileSync('docker', dockerCmd, { encoding: 'utf8', timeout: 150000 })
  const m = out.match(/RESULT (.+)/)
  if (!m) {
    console.log('    无 RESULT 输出，原始输出片段:', out.slice(-300))
    return { concurrency, peak_rss_mb: 0, oom: true, succeeded: 0, total: 12, throughput: 0, p50: 0, p95: 0 }
  }
  const j = JSON.parse(m[1])
  const r = { concurrency: j.concurrency, peak_rss_mb: Math.round(j.peak_rss_kb / 1024), oom: j.oom, succeeded: j.succeeded, total: j.total, throughput: Math.round(j.succeeded / (j.elapsed_ms / 1000) * 10) / 10, p50: j.p50, p95: j.p95 }
  console.log(`    peak RSS=${r.peak_rss_mb}MB, ok=${r.succeeded}/${r.total}, ${r.throughput} call/s, P50=${r.p50}ms P95=${r.p95}ms${r.oom ? ' OOM!' : ''}`)
  return r
}

// ═══════════════════════════════════════════
// Phase 3: 排队机制验证（真实 MCP 进程）
// ═══════════════════════════════════════════
function spawnMcpServer(concurrency, workspacesDir) {
  const child = spawn(process.execPath, [
    '--max-old-space-size=480', '--expose-gc',
    join(MALONG_DIR, 'mcp-server.js'),
    '--workspace', FIXTURE,
    '--state-dir', '/tmp/opencode/stress-mcp-state',
    '--concurrency', String(concurrency),
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, MALONG_WS_DIR: workspacesDir },
  })
  let buf = ''
  const pending = new Map()
  child.stdout.setEncoding('utf-8')
  child.stdout.on('data', (d) => {
    buf += d
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1)
      if (!line) continue
      let j
      try { j = JSON.parse(line) } catch { continue }
      if (j.id != null && pending.has(j.id)) {
        pending.get(j.id)({ ...j, _at: Date.now() })
        pending.delete(j.id)
      }
    }
  })
  const stderrChunks = []
  child.stderr.setEncoding('utf-8')
  child.stderr.on('data', (d) => stderrChunks.push(d))
  return {
    child,
    call: (id, method, params) => new Promise((resolve) => {
      pending.set(id, resolve)
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
    }),
    waitReady: async () => {
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('server init timeout')), 30000)
        const poll = setInterval(() => {
          const txt = stderrChunks.join('')
          if (txt.includes('server ready') || txt.includes('modules initialized')) {
            clearInterval(poll); clearTimeout(t); resolve()
          }
        }, 200)
      })
    },
    stderr: () => stderrChunks.join(''),
  }
}

function awaitImportChildProcess() {
  return { spawn }
}

async function phase3() {  console.log('═══ Phase 3: 排队机制验证（真实 MCP 进程）═══')

  // ── 3a. 真实进程排队：concurrency=3，6 个并发慢调用（debug_runner sleep 2s）
  // 预期：前 3 立即执行，后 3 排队 ~2s；完成时间分两批（~2s / ~4s）
  {
    const wsDir = '/tmp/opencode/stress-mcp-ws'
    rmSync(wsDir, { recursive: true, force: true })
    mkdirSync(wsDir, { recursive: true })
    const srv = spawnMcpServer(3, wsDir)
    await srv.waitReady()
    await srv.call(1, 'initialize', {})
    const sendAt = Date.now()
    const N = 6
    const ids = []
    for (let i = 0; i < N; i++) ids.push(100 + i)
    const results = await Promise.all(ids.map((id, i) =>
      srv.call(id, 'tools/call', {
        name: 'debug_runner',
        arguments: { workspace_dir: FIXTURE, command: `sleep 2; echo "task${i} done"` },
      })))
    results.forEach((r, i) => {
      const ms = r._at - sendAt
      console.log(`  task${i}: ${Math.round(ms)}ms ${r.error ? 'ERROR: ' + r.error.message?.slice(0, 50) : 'ok'}`)
    })
    const times = results.map((r, i) => ({ i, ms: r._at - sendAt, err: !!r.error }))
    const firstBatch = times.filter(t => t.ms < 2500)
    const secondBatch = times.filter(t => t.ms >= 2500)
    console.log(`  第一批（≤2.5s）: ${firstBatch.length} 个（预期 3），第二批: ${secondBatch.length} 个（预期 3）`)
    const ok = firstBatch.length === 3 && secondBatch.length === 3 && times.every(t => !t.err)
    console.log(ok ? '  ✓ 排队机制正常：3+3 分批，FIFO 生效' : '  ✗ 排队行为不符预期')
    srv.child.kill('SIGKILL')
  }

  // ── 3b. Semaphore 单测补充：超时兜底 + weight 独占（防回归）
  {
    const { Semaphore } = await import(join(MALONG_DIR, 'semaphore.js'))
    const s2 = new Semaphore(3)
    await s2.acquire(); await s2.acquire(); await s2.acquire()
    const t0 = Date.now()
    const r = await s2.acquire(1, 50)
    const wait = Date.now() - t0
    console.log(`  满 3 后 acquire(50ms): timedOut=${!!r?.timedOut}, 实际等待=${wait}ms, 队列=${s2.queue.length}`)
    console.log((r?.timedOut && s2.queue.length === 0) ? '  ✓ 超时兜底：超时项已出队，账本未污染' : '  ✗ 超时兜底失败')

    const s3 = new Semaphore(3)
    await s3.acquire(); await s3.acquire(); await s3.acquire()
    let w = false
    const p = (async () => { await s3.acquire(3, 1000); w = true })()
    await sleep(50)
    console.log(`  reindex weight=3 在 3 槽满时: 等待中=${!w}（预期 true）`)
    s3.release(); s3.release(); s3.release()
    await p
    console.log(`  槽空后重获取成功=${w}`)
  }
}

// ═══════════════════════════════════════════
const t0 = performance.now()
if (PHASE === '1') await phase1()
else if (PHASE === '2') await phase2()
else if (PHASE === '3') await phase3()
else console.log('用法: node --expose-gc tests/stress-test.js --phase 1|2|3 [--concurrency N] [--docker]')
console.log(`\n总耗时 ${Math.round((performance.now() - t0) / 1000)}s`)
