import { existsSync, mkdirSync, appendFileSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
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
    await new Promise(resolve => this.queue.push({ resolve, weight }))
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
    stateDir, toolsDir, workspacesDir, registry, log: core.log
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
      stateDir, toolsDir: join(__dirname, 'tools'), workspacesDir, registry, log: core.log
    }),
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
}).catch(e => {
  crashLog(`init failed: ${e.stack}`)
  process.exit(1)
})
