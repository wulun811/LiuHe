import { existsSync, mkdirSync, appendFileSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import net from 'node:net'
import ToolRegistry from './tool-registry.js'
import { runHealthCheck } from './health-check.js'
import crypto from 'node:crypto'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))

const REQUEST_TIMEOUT_MS = 120_000
const RECOMMENDED_HEAP_MB = 512
const DEFAULT_CONCURRENCY = 3
const HEAVY_TOOLS = new Set(['reindex', 'repo_map'])
const MEMORY_CHECK_INTERVAL_MS = 30_000
const MEMORY_DANGER_MB = 480

// ── Rust 解析服务自动拉起 ──

const PARSE_SERVICE_SOCKET = `/tmp/malong-parse-${process.getuid()}.sock`
const PARSE_SERVICE_BIN = join(os.homedir(), '.local', 'bin', 'malong-parse')
const PARSE_SERVICE_BIN_ALT = join(__dirname, '..', '..', '..', 'malong-parse', 'target', 'release', 'malong-parse')

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

class Semaphore {
  constructor(max) {
    this.max = max
    this.current = 0
    this.queue = []
  }

  async acquire(weight = 1) {
    if (this.current + weight <= this.max && this.queue.length === 0) {
      this.current += weight
      return
    }
    await new Promise(resolve => this.queue.push({ resolve, weight, waitTime: Date.now() }))
  }

  release(weight = 1) {
    this.current -= weight
    while (this.queue.length > 0) {
      const next = this.queue[0]
      if (this.current + next.weight <= this.max) {
        this.queue.shift()
        this.current += next.weight
        next.resolve()
      } else {
        break
      }
    }
  }

  getStatus() {
    return {
      current: this.current,
      max: this.max,
      queue: this.queue.map(q => ({ weight: q.weight, waiting: Date.now() - q.waitTime })),
    }
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

const core = {
  stateDir,
  services,
  log(level, msg) { safeLog(`[${level}] ${msg}`) },
  emit() {},
  on() {},
  off() {},
  get(_, def) { return def },
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
        await semaphore.acquire(weight)
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

          const result = await Promise.race([toolPromise, timeoutPromise])
          if (!timedOut) {
            safeRespond(id, {
              content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            })
          } else {
            crashLog(`tool ${name} completed AFTER timeout (${REQUEST_TIMEOUT_MS}ms) — result discarded`)
          }
        } catch (e) {
          if (!timedOut) {
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
      process.exit(0)
      break

    default:
      if (method.startsWith('notifications/')) break
      safeRespond(id, null)
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
  process.stderr.end(() => process.exit(0))
  setTimeout(() => process.exit(0), 500).unref()
})

process.on('SIGINT', () => {
  crashLog('SIGINT received, shutting down')
  writeCrashDump('SIGINT')
  process.stderr.end(() => process.exit(0))
  setTimeout(() => process.exit(0), 500).unref()
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
  }
})

process.stdin.on('close', () => {
  if (_initialized && !_stdinClosed) {
    _stdinClosed = true
    crashLog('stdin closed after init, exiting')
    writeCrashDump('stdin_close')
    process.stderr.end(() => process.exit(0))
    setTimeout(() => process.exit(0), 500).unref()
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

  setInterval(async () => {
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

        // 自动软重启（每 5 分钟最多一次，最多 3 次）
        const now = Date.now()
        if (now - lastAutoRestart > 300_000 && watchdogRestarts < MAX_AUTO_RESTARTS) {
          crashLog(`WATCHDOG: auto-restart #${watchdogRestarts + 1} triggered by FAIL checks`)
          if (typeof global.gc === 'function') {
            try { global.gc() } catch {}
          }
          watchdogRestarts++
          lastAutoRestart = now
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
        crashLog(`WATCHDOG: semaphore deadlock detected, auto-restart`)
        const now = Date.now()
        if (now - lastAutoRestart > 300_000 && watchdogRestarts < MAX_AUTO_RESTARTS) {
          crashLog(`WATCHDOG: auto-restart #${watchdogRestarts + 1} triggered by semaphore deadlock`)
          if (typeof global.gc === 'function') {
            try { global.gc() } catch {}
          }
          watchdogRestarts++
          lastAutoRestart = now
        }
      }
    } catch (e) {
      crashLog(`WATCHDOG error: ${e.message}`)
    }
  }, 30_000)
}).catch(e => {
  crashLog(`init failed: ${e.stack}`)
  process.exit(1)
})
