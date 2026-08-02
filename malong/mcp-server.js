import { existsSync, mkdirSync, appendFileSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import net from 'node:net'
import ToolRegistry from './tool-registry.js'
import { runHealthCheck, cleanupStaleWorkspaces } from './health-check.js'
import crypto from 'node:crypto'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))

import { Semaphore } from './semaphore.js'

const REQUEST_TIMEOUT_MS = 120_000
const SEMAPHORE_TIMEOUT_MS = 60_000
const RECOMMENDED_HEAP_MB = 512
const DEFAULT_CONCURRENCY = 3
const HEAVY_TOOLS = new Set(['reindex'])
const MEMORY_CHECK_INTERVAL_MS = 30_000
const MEMORY_DANGER_MB = 480

// ── Rust 解析服务自动拉起 ──

const PARSE_SERVICE_SOCKET = `/tmp/malong-parse-${process.getuid()}.sock`
const PARSE_SERVICE_BIN = join(os.homedir(), '.local', 'bin', 'malong-parse')
const PARSE_SERVICE_BIN_ALT = join(__dirname, '..', 'malong-parse', 'target', 'release', 'malong-parse')

async function ensureParseService() {
  // 检查是否已运行
  if (existsSync(PARSE_SERVICE_SOCKET)) {
    try {
      const test = net.createConnection(PARSE_SERVICE_SOCKET)
      await new Promise((resolve, reject) => {
        test.on('connect', () => { test.destroy(); resolve(true) })
        test.on('error', reject)
        setTimeout(() => { test.destroy(); reject(new Error('timeout')) }, 1000)
      })
      crashLog('malong-parse already running')
      return
    } catch {}
  }

  // 查找二进制
  let binPath = PARSE_SERVICE_BIN
  if (!existsSync(binPath)) {
    binPath = PARSE_SERVICE_BIN_ALT
    if (!existsSync(binPath)) {
      crashLog('malong-parse binary not found, parse service unavailable')
      return
    }
  }

  // 启动服务
  try {
    const child = spawn(binPath, [], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    child.on('error', (e) => {
      // 二进制不可执行（EACCES/损坏 ELF 等）：异步错误，必须监听否则 uncaughtException 崩服务
      crashLog(`malong-parse spawn error: ${e.message}`)
    })
    child.unref()
    crashLog(`malong-parse started (pid=${child.pid})`)

    // 等待 socket 就绪
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 100))
      if (existsSync(PARSE_SERVICE_SOCKET)) {
        crashLog('malong-parse socket ready')
        return
      }
    }
    crashLog('malong-parse failed to start within 2s')
  } catch (e) {
    crashLog(`malong-parse spawn error: ${e.message}`)
  }
}

function checkV8HeapLimit() {
  const maxOldSpace = process.argv.find(a => a.startsWith('--max-old-space-size='))
  if (!maxOldSpace) {
    safeLog(`WARNING: V8 heap limit is unlimited. Start with --max-old-space-size=${RECOMMENDED_HEAP_MB}`)
    return 0
  }
  const heapMB = parseInt(maxOldSpace.split('=')[1], 10)
  if (heapMB > RECOMMENDED_HEAP_MB * 2) {
    safeLog(`WARNING: V8 heap limit is ${heapMB}MB. Consider --max-old-space-size=${RECOMMENDED_HEAP_MB}`)
  }
  return heapMB
}

function parseArgs() {
  const args = process.argv.slice(2)
  const opts = {}
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--workspace' && args[i + 1]) {
      opts.workspace = args[++i]
    } else if (args[i] === '--concurrency' && args[i + 1]) {
      opts.concurrency = parseInt(args[++i], 10) || DEFAULT_CONCURRENCY
    }
  }
  return opts
}

const cliOpts = parseArgs()
const baseDir = cliOpts.workspace || process.cwd()
const concurrency = cliOpts.concurrency || DEFAULT_CONCURRENCY
const semaphore = new Semaphore(concurrency)

const services = {}
const stateDir = join(baseDir, 'data', 'malong-mcp')
const workspacesDir = join(stateDir, 'workspaces')
if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true })
if (!existsSync(workspacesDir)) mkdirSync(workspacesDir, { recursive: true })

const CRASH_LOG = join(stateDir, 'crash.log')

function safeLog(msg) {
  try { process.stderr.write(`[mcp] ${msg}\n`) } catch {}
}

function crashLog(msg) {
  const ts = new Date().toISOString()
  const line = `[${ts}] ${msg}\n`
  try { appendFileSync(CRASH_LOG, line) } catch {}
  safeLog(msg)
}

function getWorkspaceDir(workspaceDir) {
  const hash = crypto.createHash('md5').update(resolve(workspaceDir)).digest('hex').slice(0, 12)
  const wsDir = join(workspacesDir, hash)
  if (!existsSync(wsDir)) mkdirSync(wsDir, { recursive: true })
  return wsDir
}

const _configWarned = new Set()
const core = {
  stateDir,
  services,
  log(level, msg) { safeLog(`[${level}] ${msg}`) },
  emit() {},
  on() {},
  off() {},
  get(key, def) {
    // P2-A7：core.get 恒返回默认值 → 配置项丢失无感知。未知键只警告一次
    if (key && !_configWarned.has(key)) {
      _configWarned.add(key)
      safeLog(`WARNING: config key "${key}" not set — using default: ${typeof def === 'string' && def.length > 40 ? def.slice(0, 40) + '...' : JSON.stringify(def)}`)
    }
    return def
  },
  registerService(name, svc) { services[name] = svc },
  getService(name) { return services[name] },
  getWorkspaceDir,
}

let langParserMod, codeIndexMod, repoMapMod
let _ready = false
let _initialized = false
let registry
const activeRequests = new Map()

async function initModules() {
  // 确保 Rust 解析服务运行（在 lang-parser 初始化之前）
  await ensureParseService()
  
  langParserMod = await import('./lang-parser.js')
  await langParserMod.init(core)
  codeIndexMod = await import('./code-index.js')
  await codeIndexMod.init(core)
  repoMapMod = await import('./repo-map.js')
  await repoMapMod.init(core)

  const toolsDir = join(__dirname, 'tools')
  registry = new ToolRegistry(toolsDir, { log: core.log })
  await registry.loadAll()

  _ready = true
  crashLog(`modules initialized, stateDir=${stateDir}, tools=${registry.getToolCount()}, concurrency=${concurrency}, pid=${process.pid}`)

  const health = await runHealthCheck({
    stateDir, toolsDir, workspacesDir, registry, log: core.log, semaphore, activeRequests,
    parseService: core.getService('langParser'),
  })
  for (const c of health.checks) {
    safeLog(`[health] ${c.status === 'PASS' ? '✓' : c.status === 'CLEANED' ? '♻' : '✗'} ${c.name}: ${c.detail}`)
  }
  if (health.status !== 'ok') {
    safeLog(`[health] ${health.checks.filter(c => c.status === 'FAIL').length} failure(s) detected`)
  }

  // 工作区索引库自清理（治本 B）：启动时按 last activity 清 stale 缓存（可重建，删了下次 reindex 恢复）。
  // env MALONG_WS_GC_DAYS 控制阈值（默认 14 天，设 0 禁用）。
  const gcDays = Number(process.env.MALONG_WS_GC_DAYS ?? 14)
  if (gcDays > 0) {
    try {
      const gc = cleanupStaleWorkspaces(workspacesDir, { maxAgeDays: gcDays })
      if (gc.deleted_count > 0) crashLog(`workspace GC: pruned ${gc.deleted_count} stale workspace cache(s), freed ${gc.freed_mb}MB (max_age=${gcDays}d)`)
    } catch (e) {
      safeLog(`[gc] workspace cleanup failed (non-fatal): ${e.message}`)
    }
  }
}

function buildContext() {
  return {
    stateDir,
    workspacesDir,
    log: core.log,
    services,
    getWorkspaceDir,
    codeIndexService: core.getService('codeIndex'),
    repoMapService: core.getService('repoMap'),
    langParserService: core.getService('langParser'),
    runHealthCheck: () => runHealthCheck({
      stateDir, toolsDir: join(__dirname, 'tools'), workspacesDir, registry, log: core.log, semaphore, activeRequests,
      parseService: core.getService('langParser'),
    }),
    semaphore,
    activeRequests,
  }
}

function safeRespond(id, result) {
  try {
    const msg = JSON.stringify({ jsonrpc: '2.0', id, result })
    process.stdout.write(msg + '\n')
  } catch (e) {
    crashLog(`stdout write failed (result): ${e.code || e.message}`)
  }
}

function safeRespondError(id, code, message) {
  try {
    const msg = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })
    process.stdout.write(msg + '\n')
  } catch (e) {
    crashLog(`stdout write failed (error): ${e.code || e.message}`)
  }
}

function handleRequest(req) {
  const { id, method, params } = req
  if (id == null) return

  switch (method) {
    case 'initialize':
      _initialized = true
      crashLog(`initialize from client, pid=${process.pid}`)
      safeRespond(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'malong-mcp', version: '0.3.0' },
      })
      break

    case 'ping':
      safeRespond(id, 'pong')
      break

    case 'tools/list':
      if (!_ready || !registry) {
        safeRespondError(id, -32000, 'Server still loading modules, please retry in a few seconds')
        break
      }
      safeRespond(id, { tools: registry.listTools() })
      break

    case 'tools/call': {
      if (!_ready) {
        safeRespondError(id, -32000, 'Server still loading modules, please retry in a few seconds')
        break
      }
      const { name, arguments: toolArgs } = params || {}

      if (!registry.hasTool(name)) {
        safeRespondError(id, -32601, `Tool not found: ${name}`)
        break
      }

      const weight = HEAVY_TOOLS.has(name) ? concurrency : 1
      const reqId = `${id}_${name}_${Date.now()}`
      activeRequests.set(reqId, { name, startTime: Date.now() })

      const callTool = async () => {
        const lock = await semaphore.acquire(weight, SEMAPHORE_TIMEOUT_MS)
        if (lock?.timedOut) {
          activeRequests.delete(reqId)
          safeRespondError(id, -32603, `Semaphore wait timeout after ${SEMAPHORE_TIMEOUT_MS}ms — queue congestion or a stuck tool. Retry later.`)
          return
        }
        let timer
        let timedOut = false
        try {
          const context = buildContext()
          const timeoutPromise = new Promise((_, reject) => {
            timer = setTimeout(() => {
              timedOut = true
              reject(new Error(`Request timeout after ${REQUEST_TIMEOUT_MS}ms`))
            }, REQUEST_TIMEOUT_MS)
          })
          const toolPromise = registry.callTool(name, toolArgs, context)
          toolPromise.catch(() => {})

          await Promise.race([toolPromise, timeoutPromise])
          if (!timedOut) {
            safeRespond(id, {
              content: [{ type: 'text', text: JSON.stringify(await toolPromise, null, 2) }],
            })
          }
        } catch (e) {
          if (timedOut) {
            // B1：race 超时必以 rejection 结算，之前 try 内 else 分支不可达 = 超时零响应（A5 死代码）。
            // 超时响应必须在 catch 里发；工具本身仍在跑（已 .catch 兜住），结果丢弃
            safeRespondError(id, -32603, `Request timeout after ${REQUEST_TIMEOUT_MS}ms`)
            crashLog(`tool ${name} completed AFTER timeout (${REQUEST_TIMEOUT_MS}ms) — result discarded`)
          } else {
            safeRespondError(id, -32603, e.message)
          }
        } finally {
          clearTimeout(timer)
          semaphore.release(weight)
          activeRequests.delete(reqId)
        }
      }
      callTool().catch(e => {
        activeRequests.delete(reqId)
        crashLog(`callTool top-level catch: ${name} — ${e.stack || e.message}`)
        safeRespondError(id, -32603, e.message)
      })
      break
    }

    case 'shutdown':
      safeRespond(id, {})
      // B8：等 stdout 排空再退出（旧：立即 exit 丢弃未写完缓冲 → 响应半帧 JSON）
      process.stdout.end(() => process.exit(0))
      setTimeout(() => process.exit(0), 1000).unref()
      break

    default:
      if (method.startsWith('notifications/')) break
      // B10：未知方法必须回 JSON-RPC -32601（旧：safeRespond(id, null) 把失败当成功）
      safeRespondError(id, -32601, `Method not found: ${method}`)
  }
}

process.on('unhandledRejection', (reason) => {
  crashLog(`unhandled rejection: ${reason}`)
})

process.on('uncaughtException', (err) => {
  crashLog(`FATAL uncaught exception: ${err.stack || err}`)
  writeCrashDump('uncaughtException')
  process.stderr.end(() => process.exit(1))
  setTimeout(() => process.exit(1), 500).unref()
})

process.on('SIGPIPE', () => {
  crashLog('SIGPIPE received (ignored, waiting for stdin close)')
})

process.on('SIGTERM', () => {
  crashLog('SIGTERM received, shutting down')
  writeCrashDump('SIGTERM')
  // B8：stdout 先排空再退出，防响应半帧
  process.stdout.end(() => process.exit(0))
  setTimeout(() => process.exit(0), 1000).unref()
})

process.on('SIGINT', () => {
  crashLog('SIGINT received, shutting down')
  writeCrashDump('SIGINT')
  process.stdout.end(() => process.exit(0))
  setTimeout(() => process.exit(0), 1000).unref()
})

process.on('exit', (code) => {
  crashLog(`process exiting with code=${code}, pid=${process.pid}, uptime=${Math.round(process.uptime())}s`)
})

function writeCrashDump(reason) {
  try {
    const mem = process.memoryUsage()
    const dump = {
      timestamp: new Date().toISOString(),
      reason,
      pid: process.pid,
      uptime_s: Math.round(process.uptime()),
      node_version: process.version,
      platform: os.platform(),
      memory: {
        rss_mb: Math.round(mem.rss / 1048576),
        heap_used_mb: Math.round(mem.heapUsed / 1048576),
        heap_total_mb: Math.round(mem.heapTotal / 1048576),
        external_mb: Math.round(mem.external / 1048576),
      },
      system: {
        total_mem_mb: Math.round(os.totalmem() / 1048576),
        free_mem_mb: Math.round(os.freemem() / 1048576),
        load_avg: os.loadavg().map(l => Math.round(l * 100) / 100),
      },
      semaphore: {
        current: semaphore.current,
        max: semaphore.max,
        queue_length: semaphore.queue.length,
      },
      active_requests: Array.from(activeRequests.entries()).map(([k, v]) => ({
        id: k,
        tool: v.name,
        elapsed_ms: Date.now() - v.startTime,
      })),
      argv: process.argv.join(' '),
    }
    const dumpPath = join(stateDir, 'last-crash-dump.json')
    writeFileSync(dumpPath, JSON.stringify(dump, null, 2))
    crashLog(`crash dump written: ${dumpPath}`)
  } catch {}
}

let buffer = ''
process.stdin.setEncoding('utf-8')
process.stdin.on('data', chunk => {
  buffer += chunk
  const lines = buffer.split('\n')
  buffer = lines.pop()
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed) {
      try {
        handleRequest(JSON.parse(trimmed))
      } catch (e) {
        crashLog(`parse error: ${e.message}, line: ${trimmed.slice(0, 100)}`)
      }
    }
  }
})

let _stdinClosed = false
process.stdin.on('end', () => {
  if (_initialized && !_stdinClosed) {
    _stdinClosed = true
    crashLog('stdin ended after init, exiting')
    writeCrashDump('stdin_end')
    process.stderr.end(() => process.exit(0))
    setTimeout(() => process.exit(0), 500).unref()
  } else if (!_initialized && !_stdinClosed) {
    // B9：握手前客户端断开 → 之前永不退出（watchdog interval 保活事件循环）→ 僵尸进程 + 孤儿 parse daemon。
    // 留 2s 握手窗口，窗口内无 initialize 则退出
    _stdinClosed = true
    setTimeout(() => process.exit(0), 2000).unref()
  }
})

process.stdin.on('close', () => {
  if (_initialized && !_stdinClosed) {
    _stdinClosed = true
    crashLog('stdin closed after init, exiting')
    writeCrashDump('stdin_close')
    process.stderr.end(() => process.exit(0))
    setTimeout(() => process.exit(0), 500).unref()
  } else if (!_initialized && !_stdinClosed) {
    _stdinClosed = true
    setTimeout(() => process.exit(0), 2000).unref()
  }
})

process.stdout.on('error', (e) => {
  crashLog(`stdout error: ${e.code || e.message}`)
})

initModules().then(() => {
  const heapMB = checkV8HeapLimit()
  crashLog(`server ready, V8 heap=${heapMB}MB, concurrency=${concurrency}, pid=${process.pid}`)

  if (typeof global.gc === 'function') {
    safeLog('[mcp] --expose-gc detected, periodic GC + memory monitoring enabled')
    setInterval(() => {
      try {
        global.gc()
        const mem = process.memoryUsage()
        const rssMB = Math.round(mem.rss / 1048576)
        if (rssMB > MEMORY_DANGER_MB) {
          crashLog(`MEMORY WARNING: RSS=${rssMB}MB (danger threshold=${MEMORY_DANGER_MB}MB), heap=${Math.round(mem.heapUsed / 1048576)}MB, active_requests=${activeRequests.size}`)
        }
      } catch {}
    }, MEMORY_CHECK_INTERVAL_MS)
  }

  // Watchdog: 每 30 秒检查一次健康状态
  let watchdogRestarts = 0
  const MAX_AUTO_RESTARTS = 3
  let lastAutoRestart = 0
  let watchdogRunning = false

  setInterval(async () => {
    if (watchdogRunning) return // P2-A6：健康检查（含 DB integrity_check）超过间隔时不重叠
    watchdogRunning = true
    try {
      const health = await runHealthCheck({
        stateDir, toolsDir: join(__dirname, 'tools'), workspacesDir, registry, log: core.log, semaphore, activeRequests
      })

      // 检查是否有 FAIL 状态
      const failChecks = health.checks.filter(c => c.status === 'FAIL')
      if (failChecks.length > 0) {
        crashLog(`WATCHDOG: ${failChecks.length} FAIL checks: ${failChecks.map(c => c.name).join(', ')}`)

        // 如果是内存问题，尝试 GC
        const memCheck = health.checks.find(c => c.name === 'Memory RSS')
        if (memCheck && memCheck.status === 'FAIL' && typeof global.gc === 'function') {
          try {
            global.gc()
            const mem = process.memoryUsage()
            crashLog(`WATCHDOG: forced GC, RSS now ${Math.round(mem.rss / 1048576)}MB`)
          } catch {}
        }

        // 自动软重启：单进程 MCP 无 supervisor，无法真重启自己 —— 诚实地报告并复位可复位状态，
        // 由外层（opencode）重启进程（递归进化第 5 轮 P1#14：旧实现只打日志谎称已重启）
        const now = Date.now()
        if (now - lastAutoRestart > 300_000 && watchdogRestarts < MAX_AUTO_RESTARTS) {
          watchdogRestarts++
          lastAutoRestart = now
          crashLog(`WATCHDOG: restart #${watchdogRestarts}/${MAX_AUTO_RESTARTS} required (FAIL checks) — no supervisor to self-restart; resetting semaphore and requesting manual restart.`)
          try {
            if (semaphore.reset) semaphore.reset()
          } catch (e) {
            crashLog(`WATCHDOG: semaphore reset failed: ${e.message}`)
          }
        }
      }

      // 检查卡死请求
      const stuckCheck = health.checks.find(c => c.name === 'Active Requests')
      if (stuckCheck && stuckCheck.status === 'WARN') {
        crashLog(`WATCHDOG: ${stuckCheck.detail}`)
      }

      // 检查信号量死锁
      const semCheck = health.checks.find(c => c.name === 'Semaphore')
      if (semCheck && semCheck.status === 'FAIL') {
        const now = Date.now()
        if (now - lastAutoRestart > 300_000 && watchdogRestarts < MAX_AUTO_RESTARTS) {
          watchdogRestarts++
          lastAutoRestart = now
          crashLog(`WATCHDOG: semaphore deadlock — restart #${watchdogRestarts}/${MAX_AUTO_RESTARTS} required (no supervisor; resetting semaphore, manual restart advised)`)
          try {
            if (semaphore.reset) semaphore.reset()
          } catch (e) {
            crashLog(`WATCHDOG: semaphore reset failed: ${e.message}`)
          }
        }
      }
    } catch (e) {
      crashLog(`WATCHDOG error: ${e.message}`)
    } finally {
      watchdogRunning = false
    }
  }, 30_000)
}).catch(e => {
  crashLog(`init failed: ${e.stack}`)
  process.exit(1)
})
