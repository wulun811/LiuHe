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
// Phase 2: 并发压测（docker --memory=512m，调用独立驱动 stress-driver.mjs）
// ═══════════════════════════════════════════
// 设计：稳态负载（索引已建好），N 个客户端 worker 持续发请求（真实 LLM 高并发模式）。
//   表 A：固定服务端 concurrency=3（部署默认），扫客户端在途请求数 → "能扛多少并发"
//   表 B：固定高负载 workers=24，扫服务端 concurrency → "服务端开几并发最优"
//   关键观察：RSS 是否平稳（内存是否瓶颈）、何时队列超时出错、吞吐/延迟拐点
const DOCKER_BASE = [
  'run', '--rm', '--memory=512m',
  '-v', '/home/chen/1q/0AIT/node_modules:/app/node_modules',
  '-v', '/home/chen/1q/0AIT/plugins/malong:/app',
  '-v', '/home/chen/.local/bin/malong-parse:/root/.local/bin/malong-parse',
  '-v', '/tmp/opencode/stress-fixture:/tmp/fixture',
  '-w', '/app', 'node:22-slim',
]

function runDriver({ concurrency, workers, seconds = 20, mode = 'steady' }) {
  const cmd = [
    ...DOCKER_BASE,
    'node', '/app/tests/stress-driver.mjs',
    '--malong-dir', '/app',
    '--fixture', '/tmp/fixture',
    '--state-dir', '/tmp/mstate',
    '--concurrency', String(concurrency),
    '--workers', String(workers),
    '--seconds', String(seconds),
    '--mode', mode,
  ]
  const out = execFileSync('docker', cmd, { encoding: 'utf8', timeout: 300000 })
  const m = out.match(/RESULT_JSON (.+)/)
  if (!m) {
    console.log('    无 RESULT_JSON，输出片段:', out.slice(-300))
    return { concurrency, workers, completed: 0, errors: -1, throughput: 0, peakRssMb: 0, p50: 0, p95: 0, p99: 0, oom: true, errSamples: ['no output'] }
  }
  return JSON.parse(m[1])
}

function fmtRow(r, label, labelVal) {
  const rssPct = Math.round(r.peakRssMb / 512 * 100)
  const errNote = r.errors > 0 ? ` (${[...new Set(r.errSamples || [])].slice(0, 2).join('; ')})` : ''
  return `| ${labelVal} | ${r.completed} | ${r.errors}${errNote} | ${r.throughput} | ${r.peakRssMb} | ${rssPct}% | ${r.oom ? '是' : '否'} | ${r.p50} | ${r.p95} | ${r.p99} |`
}

async function phase2() {
  console.log('═══ Phase 2: 真并发压测（docker --memory=512m，剔除 reindex，DB 重分析负载）═══')
  if (!USE_DOCKER) {
    console.log('需要 --docker 标志（docker --memory=512m 真 cgroup 限制）')
    return
  }

  // 表 A：并发扫描——服务端 concurrency 与客户端 workers 同步加大（workers=2×concurrency 灌满管道）
  // 直接回答"512MB 能扛多少并发"：看 RSS 拐点 / 吞吐是否随并发增长 / 何时 OOM 或队列超时
  console.log('\n── 表 A：并发扫描（concurrency 与 workers 同步加大，DB 重分析负载）──')
  const connLevels = [1, 8, 16, 32, 64, 128]
  const rows = []
  for (const c of connLevels) {
    const w = c * 2
    console.log(`  → concurrency=${c} workers=${w} ...`)
    const r = runDriver({ concurrency: c, workers: w, seconds: 15 })
    rows.push(r)
    console.log(`    完成=${r.completed} 错误=${r.errors} 吞吐=${r.throughput}/s RSS=${r.peakRssMb}MB P50=${r.p50} P95=${r.p95}${r.oom ? ' OOM!' : ''}`)
  }

  // 表 B：Storm 冲突矩阵——高并发读+写混合打共享热点文件，验证零撕裂 + DB 完整性
  console.log('\n── 表 B：Storm 冲突矩阵（concurrency=32，32 路读+写混合，验证正确性）──')
  const storm = runDriver({ concurrency: 32, workers: 32, seconds: 15, mode: 'storm' })
  console.log(`    读=${storm.reads} 写成功=${storm.writesOk} 写冲突=${storm.writesConflict} 错误=${storm.errors} 撕裂=${storm.torn} DB损坏=${storm.integrityFail} RSS=${storm.peakRssMb}MB`)
  console.log(`    冲突码分布: ${JSON.stringify(storm.conflictCodes)}  终态: ${storm.finalContent}`)

  const header = '| concurrency / workers | 完成 | 错误 | 吞吐 (call/s) | 峰值 RSS (MB) | 512MB 占比 | OOM | P50 (ms) | P95 (ms) | P99 (ms) |'
  const sep = '|---|---|---|---|---|---|---|---|---|---|'
  const md = [
    '# STRESS-512MB 压测报告 — Phase 2 真并发',
    '',
    `> 生成时间: ${new Date().toISOString()}  |  docker --memory=512m  |  稳态 2000 文件代码库（索引预建，测量期零 reindex）`,
    '> 负载模型：DB 重分析工具为主（impact_analysis/references/symbol_search/call_chain/dep_graph 80% + 读 20%），workers=2×concurrency 灌满管道',
    '',
    '## 表 A：并发扫描（concurrency 与 workers 同步加大）',
    '',
    header, sep,
    ...rows.map(r => fmtRow(r, 'concurrency', `${r.concurrency} / ${r.workers}`)),
    '',
    '## 表 B：Storm 冲突矩阵（concurrency=32，32 路读+写混合打共享热点文件）',
    '',
    fmtStorm(storm),
    '',
    '## 结论',
    '',
    ...buildConclusion(rows, storm),
    '',
  ]
  writeFileSync(join(OUT_DIR, 'STRESS-512MB-phase2.md'), md.join('\n'))
  console.log(`\n报告已写入: ${join(OUT_DIR, 'STRESS-512MB-phase2.md')}`)
}

function fmtStorm(s) {
  const codes = Object.entries(s.conflictCodes || {}).map(([k, v]) => `${k}×${v}`).join(', ') || '无'
  const errNote = s.errSamples?.length ? '（' + s.errSamples.join('; ') + '）' : ''
  return [
    '| 指标 | 值 |',
    '|---|---|',
    `| 并发读完成 | ${s.reads} |`,
    `| 并发写成功 | ${s.writesOk} |`,
    `| 并发写冲突 | ${s.writesConflict}（${codes}） |`,
    `| 错误 | ${s.errors}${errNote} |`,
    `| 热点文件撕裂 | ${s.torn ? '是 ❌' : '否 ✓'}（终态: \`${s.finalContent}\`） |`,
    `| DB integrity_check | ${s.integrityFail ? 'FAIL ❌' : 'PASS ✓'} |`,
    `| 峰值 RSS | ${s.peakRssMb}MB |`,
    `| OOM | ${s.oom ? '是 ❌' : '否 ✓'} |`,
  ].join('\n')
}

function buildConclusion(rows, storm) {
  const maxRss = Math.max(...rows.map(r => r.peakRssMb))
  const anyOom = rows.some(r => r.oom)
  const firstErr = rows.find(r => r.errors > 0)
  const lastClean = [...rows].reverse().find(r => r.errors === 0 && !r.oom)
  const thru = rows.map(r => r.throughput)
  const maxThru = Math.max(...thru)
  const thruAtMax = rows[thru.indexOf(maxThru)]
  const scales = thru[thru.length - 1] > thru[0] * 1.5
  const c0 = rows[0].concurrency, cN = rows[rows.length - 1].concurrency
  const lines = [
    `- **内存天花板**：并发从 ${c0} 拉到 ${cN}（workers 同步 ${rows[0].workers}→${rows[rows.length - 1].workers}），峰值 RSS 最高 ${maxRss}MB（512MB 的 ${Math.round(maxRss / 512 * 100)}%），${anyOom ? '出现 OOM ❌' : '全程零 OOM ✓'}。${maxRss < 400 ? '内存余量充足，512MB 远未压满——并发上限不由内存决定。' : 'RSS 已逼近 512MB，内存成为硬约束。'}`,
    `- **零错误最大并发**：${lastClean ? `concurrency=${lastClean.concurrency}（workers=${lastClean.workers}）内零错误零 OOM` : '所有档位均有错误'}${firstErr ? `；concurrency=${firstErr.concurrency} 起出错（${(firstErr.errSamples || []).slice(0, 1).join('; ')}）` : ''}。`,
    `- **吞吐是否随并发扩展**：${scales ? `是——从 ${thru[0]} call/s（concurrency=${c0}）增至 ${maxThru} call/s（concurrency=${thruAtMax.concurrency}），工具确实在并行。` : `否——吞吐全程 ~${Math.round(thru.reduce((a, b) => a + b, 0) / thru.length)} call/s 基本不随并发增长，说明 DB 重工具被 better-sqlite3 同步查询串行化在 Node 事件循环上，加并发槽无法提速（这是真问题，需评估是否优化）。`}`,
    `- **并发正确性（Storm，32 路读+写混合）**：热点文件${storm.torn ? '出现撕裂 ❌（原子性被破坏，必须修）' : '零撕裂 ✓（原子 rename 守住）'}；DB integrity_check ${storm.integrityFail ? 'FAIL ❌（必须修）' : 'PASS ✓'}；并发写冲突码 ${Object.keys(storm.conflictCodes || {}).join('/') || '无'}（受控冲突，无静默覆盖）。`,
  ]
  return lines
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
