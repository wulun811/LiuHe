import { existsSync, mkdirSync, appendFileSync, writeFileSync, statSync, openSync, renameSync, unlinkSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import net from 'node:net'
import ToolRegistry from './tool-registry.js'
import { runHealthCheck, cleanupStaleWorkspaces } from './health-check.js'
import crypto from 'node:crypto'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))

import { Semaphore, heavyToolWeight } from './semaphore.js'

const REQUEST_TIMEOUT_MS = 120_000
const SEMAPHORE_TIMEOUT_MS = 60_000
const RECOMMENDED_HEAP_MB = 512
// r10e(F3)：并发 3 → 5——实测 RSS 194MB/heap 12MB 内存充足（上限 480MB），3 槽在 verify_pipeline 120s 长任务占 1 槽时
// reindex(weight=3) 永远凑不齐 3 槽 → 排队 60s 超时；5 槽下长任务占 1 槽仍有 4 槽供其余工具，reindex 也能并行等待
// r11(H1)：weight 改为 heavyToolWeight(concurrency)（=max(3, floor(n/2))）——旧实现 weight=concurrency 使 5 槽下
// reindex 需 5 槽全空，比 3 槽更难凑齐，r10e 修复实际无效；现在 weight 恒 < 槽数，普通工具与 reindex 永可并行
const DEFAULT_CONCURRENCY = 5
const HEAVY_TOOLS = new Set(['reindex'])
const MEMORY_CHECK_INTERVAL_MS = 30_000
const MEMORY_DANGER_MB = 480

// ── Rust 解析服务自动拉起 ──
// r35-fix: Windows 无 getuid → UID 兜底 0（与 parse-client.js 同款守卫）

const UID = typeof process.getuid === 'function' ? process.getuid() : 0
// r55: Windows 无 Unix socket——daemon 走 TCP 127.0.0.1:MALONG_PORT（parse-client.js 已有 IS_WIN 分支，此处补齐）
const IS_WIN = process.platform === 'win32'
// r9(H14)：parse-client 的 socket 路径已跟随 env（r8 F4 pid 同步）——mcp-server 的检查/spawn 探测
// 还硬编码默认路径 → 设了 MALONG_SOCKET 的会话双 spawn / 孤儿 daemon
const PARSE_SERVICE_SOCKET = process.env.MALONG_SOCKET || `/tmp/malong-parse-${UID}.sock`
const PARSE_SERVICE_TCP_PORT = parseInt(process.env.MALONG_PORT || '31001', 10)
// r53: MALONG_PARSE_BIN env 覆盖（与 parse-client 对齐——此前启动 daemon 用硬编码路径，运行期重启用 env 路径，用户设 env 后两个路径 daemon 可能并存）
const PARSE_SERVICE_BIN = process.env.MALONG_PARSE_BIN || process.env.MALONG_PARSE_BIN_ALT || join(os.homedir(), '.local', 'bin', 'malong-parse')
const PARSE_SERVICE_BIN_ALT = join(__dirname, '..', 'malong-parse', 'target', 'release', 'malong-parse')

// r55: Windows 无 /tmp 语义——spawn 锁放用户数据目录，与 parse-stderr.log 同址
const PARSE_SPAWN_LOCK = IS_WIN
  ? join(os.homedir(), '.local', 'share', 'malong', '.parse-spawn.lock')
  : join(dirname(PARSE_SERVICE_SOCKET), '.parse-spawn.lock')

// r11(M3)：daemon stderr 落盘——旧实现 stdio ignore 把 tracing 日志（SLOW/PANIC/TIMEOUT 等排障关键）全丢 /dev/null，
// r10-B 的 rotate_stdout_log_if_needed 只对 shell 重定向生效，程序化 spawn 是 no-op；
// 此处打开 fd2 到 ~/.local/share/malong/parse-stderr.log（>50MB 简单轮转保留一份）
function openParseStderrFd() {
  const dir = join(os.homedir(), '.local', 'share', 'malong')
  mkdirSync(dir, { recursive: true })
  const logPath = join(dir, 'parse-stderr.log')
  try {
    const st = statSync(logPath)
    if (st.size > 50 * 1024 * 1024) renameSync(logPath, `${logPath}.1`)
  } catch {}
  return openSync(logPath, 'a')
}

// R22-⑱（第五轮核实）：daemon spawn 无原子锁——两个 MCP 进程同时探测失败 → 双 spawn → 一个 EADDRINUSE 变孤儿。
// O_EXCL 锁 + mtime stale（>10s 无 socket 视为崩溃残留）：获取失败 = 另一进程正在启动 → 等 socket 出现。

function acquireSpawnLock() {
  try {
    mkdirSync(dirname(PARSE_SPAWN_LOCK), { recursive: true })
    writeFileSync(PARSE_SPAWN_LOCK, `${process.pid} ${Date.now()}`, { flag: 'wx' })
    return true
  } catch {
    try {
      const st = statSync(PARSE_SPAWN_LOCK)
      if (Date.now() - st.mtimeMs > 10_000) {
        try { unlinkSync(PARSE_SPAWN_LOCK) } catch {}
        return acquireSpawnLock()
      }
    } catch {}
    return false
  }
}

function releaseSpawnLock() {
  try { unlinkSync(PARSE_SPAWN_LOCK) } catch {}
}

// r55: 探测 daemon 是否可连——Windows 用 TCP 127.0.0.1:port，Unix 用 socket 文件连接测试
function probeParseService(timeoutMs = 1000) {
  return new Promise((resolve) => {
    const test = IS_WIN
      ? net.createConnection({ host: '127.0.0.1', port: PARSE_SERVICE_TCP_PORT })
      : net.createConnection(PARSE_SERVICE_SOCKET)
    const done = (ok) => { test.destroy(); resolve(ok) }
    test.on('connect', () => done(true))
    test.on('error', () => done(false))
    setTimeout(() => done(false), timeoutMs)
  })
}

async function ensureParseService() {
  // 检查是否已运行（Windows 无 socket 文件——probe 直接试 TCP 连接）
  if (await probeParseService(1000)) {
    crashLog('malong-parse already running')
    return
  }
  crashLog('malong-parse probe failed; will spawn new daemon')

  // 查找二进制
  let binPath = PARSE_SERVICE_BIN
  if (!existsSync(binPath) && process.platform === 'win32' && existsSync(binPath + '.exe')) {
    binPath = binPath + '.exe'
  }
  if (!existsSync(binPath)) {
    binPath = PARSE_SERVICE_BIN_ALT
    if (!existsSync(binPath) && process.platform === 'win32' && existsSync(binPath + '.exe')) {
      binPath = binPath + '.exe'
    }
    if (!existsSync(binPath)) {
      crashLog('malong-parse binary not found, parse service unavailable')
      return
    }
  }

  // 启动服务
  try {
    if (!acquireSpawnLock()) {
      // 另一进程正在启动 daemon——等服务可连（最多 2s），不重复 spawn
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 100))
        if (await probeParseService(200)) {
          crashLog('malong-parse ready (other process)')
          return
        }
      }
      crashLog('malong-parse spawn lock held but service never appeared; giving up')
      return
    }
    const child = spawn(binPath, [], {
      detached: true,
      stdio: ['ignore', 'ignore', openParseStderrFd()],
    })
    child.on('error', (e) => {
      // 二进制不可执行（EACCES/损坏 ELF 等）：异步错误，必须监听否则 uncaughtException 崩服务
      crashLog(`malong-parse spawn error: ${e.message}`)
    })
    child.unref()
    crashLog(`malong-parse started (pid=${child.pid})`)

    // 等待服务就绪（Windows 等 TCP 端口，Unix 等 socket）
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 100))
      if (await probeParseService(200)) {
        crashLog('malong-parse ready')
        releaseSpawnLock()
        return
      }
    }
    crashLog('malong-parse failed to start within 2s')
    releaseSpawnLock()
  } catch (e) {
    releaseSpawnLock()
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
  const hash = crypto.createHash('md5').update(resolve(workspaceDir)).digest('hex').slice(0, 12) // malong-ignore: 仅用于生成缓存目录名，非安全用途
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
  // r46: code-search 服务此前从未接线——initModules 只加载三个模块，code_search 工具在 MCP 下恒报 service_unavailable
  await (await import('./code-search.js')).init(core)

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
  // env MALONG_WS_GC_DAYS 控制阈值（r10：默认 3 天，设 0 禁用）。
  const gcDays = Number(process.env.MALONG_WS_GC_DAYS ?? 3)
  if (gcDays > 0) {
    try {
      // r9(F10/H12)：启动 GC 保护本进程全部已初始化 workspace（不只当前一个）——
      // 多会话共享 stateDir 时，B 进程启动会把 A 进程在用但无写入的库删掉
      const protect = []
      try { protect.push(...(core.getService('codeIndex')?.getTouchedWorkspaceHashes?.() || [])) } catch {}
      const gc = cleanupStaleWorkspaces(workspacesDir, { maxAgeDays: gcDays, protect })
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
    // r46: code_search 工具的服务接线（此前 buildContext 漏暴露，handler 恒 undefined → service_unavailable）
    codeSearchService: core.getService('codeSearch'),
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

// r55: 客户端（opencode）收到 tools/list 的 -32000 会立即关闭 stdin kill 进程——初始化（含 Windows daemon TCP 等待）
// 超过客户端重试窗口时永远连不上。未就绪改为轮询等待 _ready 后再响应（上限 15s，超过仍报错兜底）。
function waitForReady(id) {
  let waited = 0
  const timer = setInterval(() => {
    waited += 250
    if (_ready && registry) {
      clearInterval(timer)
      safeRespond(id, { tools: registry.listTools() })
    } else if (waited >= 15_000) {
      clearInterval(timer)
      safeRespondError(id, -32000, 'Server still loading modules, please retry in a few seconds')
    }
  }, 250)
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
        waitForReady(id)
        break
      }
      safeRespond(id, { tools: registry.listTools() })
      break

    case 'tools/call': {
      if (!_ready) {
        safeRespondError(id, -32000, 'Server still loading modules, please retry in a few seconds')
        break
      }
      const { name, arguments: toolArgsRaw } = params || {}
      // R21b：参数宽容层——某些客户端（通天插件等）可能把参数文本当字符串降级传参；
      // 能解析则用解析结果，否则显式报错（opencode 不会这么传，parse 失败客户端即拒，零副作用）
      let toolArgs = toolArgsRaw
      if (typeof toolArgsRaw === 'string') {
        try { toolArgs = JSON.parse(toolArgsRaw) } catch {
          safeRespondError(id, -32603, 'Invalid tool arguments: expected object, received string that is not valid JSON')
          break
        }
      }

      if (!registry.hasTool(name)) {
        safeRespondError(id, -32601, `Tool not found: ${name}`)
        break
      }

      const weight = HEAVY_TOOLS.has(name) ? heavyToolWeight(concurrency) : 1
      const reqId = `${id}_${name}_${Date.now()}`
      activeRequests.set(reqId, { name, startTime: Date.now(), weight })

      const callTool = async () => {
        const lock = await semaphore.acquire(weight, SEMAPHORE_TIMEOUT_MS)
        if (lock?.timedOut) {
          activeRequests.delete(reqId)
          // r10e(F3)：超时信息附当前占用者明细——旧文案只报 “stuck tool”，LLM 不知道谁占着槽/还要等多久 → 盲目重试撞同一窗口
          const busy = Array.from(activeRequests.entries()).map(([k, v]) => `${v.name}(${Math.round((Date.now() - v.startTime) / 1000)}s)`)
          const sem = semaphore.getStatus()
          safeRespondError(id, -32603, `Semaphore wait timeout after ${SEMAPHORE_TIMEOUT_MS}ms — 槽位占用中：current=${sem.current}/${sem.max}，队列=${sem.queue.length}（weight ${sem.queue.map(q => q.weight).join(',')}）` + (busy.length ? `，正在执行：${busy.join(', ')}` : '') + `。建议：先调 health 看占用，或等 ${busy.join('/') || '当前请求'} 结束后重试。`)
          return
        }
        let timer
        let timedOut = false
        // R2：released 标志——release 只执行一次。catch 里的 else 分支（handler/安全响应抛错）与
        // safeRespond 内层 finally 的 release 可能同时触发，无标志会 double release（负计数污染探针）。
        let released = false
        const releaseSlot = () => {
          if (!released) {
            released = true
            semaphore.release(weight)
          }
        }
        try {
          const context = buildContext()
          const timeoutPromise = new Promise((_, reject) => {
            timer = setTimeout(() => {
              timedOut = true
              reject(new Error(`Request timeout after ${REQUEST_TIMEOUT_MS}ms`))
            }, REQUEST_TIMEOUT_MS)
          })
          // r8(F9)：信号量在工具真正结束时释放——旧实现超时即放账，僵尸工具仍在跑 → 并发超限 + 客户端重试与僵尸写交错
          // r9(F9)：先响应后释放——finally 挂工具上会让 release 先于 safeRespond（大结果 stringify 可达百 ms 级同步），
          // 期间新重工具（reindex weight=3）抢占全部槽位 → 旧响应被推迟 → 客户端超时重试 → 重复副作用
          const rawPromise = registry.callTool(name, toolArgs, context)
          rawPromise.catch(() => {})
          await Promise.race([rawPromise, timeoutPromise])
          if (!timedOut) {
            try {
              safeRespond(id, {
                content: [{ type: 'text', text: JSON.stringify(await rawPromise, null, 2) }],
              })
            } finally {
              releaseSlot()
            }
          } else {
            // 超时路径：release 挂到工具真正结束（r8 F9 语义保留）——僵尸未停槽位不放
            rawPromise.then(releaseSlot, releaseSlot)
          }
        } catch (e) {
          if (timedOut) {
            // B1：race 超时必以 rejection 结算，之前 try 内 else 分支不可达 = 超时零响应（A5 死代码）。
            // 超时响应必须在 catch 里发；工具本身仍在跑（已 .catch 兜住），结果丢弃
            safeRespondError(id, -32603, `Request timeout after ${REQUEST_TIMEOUT_MS}ms`)
            crashLog(`tool ${name} completed AFTER timeout (${REQUEST_TIMEOUT_MS}ms) — result discarded`)
          } else {
            // R2：handler 抛异常 = 工具已结束，槽位必须还（与超时路径释放语义一致）
            releaseSlot()
            // 审核补（R10）：DB 不可用（BUSY/损坏）透出 service_unavailable（-32001）而非笼统内部错误
            safeRespondError(id, e?.code === 'service_unavailable' ? -32001 : -32603, e.message)
          }
        } finally {
          clearTimeout(timer)
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
        // 由外层（MCP 宿主）重启进程（递归进化第 5 轮 P1#14：旧实现只打日志谎称已重启）
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
