import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import ToolRegistry from './tool-registry.js'
import { runHealthCheck } from './health-check.js'
import crypto from 'node:crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))

const REQUEST_TIMEOUT_MS = 120_000

function parseArgs() {
  const args = process.argv.slice(2)
  const opts = {}
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--workspace' && args[i + 1]) {
      opts.workspace = args[++i]
    }
  }
  return opts
}

const cliOpts = parseArgs()
const baseDir = cliOpts.workspace || process.cwd()

const services = {}
const stateDir = join(baseDir, 'data', 'malong-mcp')
const workspacesDir = join(stateDir, 'workspaces')
if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true })
if (!existsSync(workspacesDir)) mkdirSync(workspacesDir, { recursive: true })

// 获取 workspace 的数据库目录
function getWorkspaceDir(workspaceDir) {
  const hash = crypto.createHash('md5').update(resolve(workspaceDir)).digest('hex').slice(0, 12)
  const wsDir = join(workspacesDir, hash)
  if (!existsSync(wsDir)) mkdirSync(wsDir, { recursive: true })
  return wsDir
}

const core = {
  stateDir,
  services,
  log(level, msg) { process.stderr.write(`[${level}] ${msg}\n`) },
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
let registry

async function initModules() {
  langParserMod = await import('./lang-parser.js')
  await langParserMod.init(core)
  codeIndexMod = await import('./code-index.js')
  await codeIndexMod.init(core)
  repoMapMod = await import('./repo-map.js')
  await repoMapMod.init(core)

  // 初始化工具注册中心
  const toolsDir = join(__dirname, 'tools')
  registry = new ToolRegistry(toolsDir, { log: core.log })
  await registry.loadAll()

  _ready = true
  core.log('info', `[mcp] modules initialized, stateDir=${stateDir}, tools=${registry.getToolCount()}`)

  const health = await runHealthCheck({
    stateDir, toolsDir, workspacesDir, registry, log: core.log
  })
  for (const c of health.checks) {
    core.log('info', `[health] ${c.status === 'PASS' ? '✓' : c.status === 'CLEANED' ? '♻' : '✗'} ${c.name}: ${c.detail}`)
  }
  if (health.status !== 'ok') {
    core.log('warn', `[health] ${health.checks.filter(c => c.status === 'FAIL').length} failure(s) detected`)
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

function respond(id, result) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, result })
  process.stdout.write(msg + '\n')
}

function respondError(id, code, message) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })
  process.stdout.write(msg + '\n')
}

function handleRequest(req) {
  const { id, method, params } = req
  if (id == null) return

  switch (method) {
    case 'initialize':
      respond(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'malong-mcp', version: '0.2.0' },
      })
      break

    case 'ping':
      respond(id, 'pong')
      break

    case 'tools/list':
      respond(id, { tools: registry.listTools() })
      break

    case 'tools/call': {
      if (!_ready) {
        respondError(id, -32000, 'Server still loading modules, please retry in a few seconds')
        break
      }
      const { name, arguments: toolArgs } = params || {}
      
      if (!registry.hasTool(name)) {
        respondError(id, -32601, `Tool not found: ${name}`)
        break
      }

      const callTool = async () => {
        const context = buildContext()
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error(`Request timeout after ${REQUEST_TIMEOUT_MS}ms`)), REQUEST_TIMEOUT_MS)
        })
        const toolPromise = registry.callTool(name, toolArgs, context)
        const result = await Promise.race([toolPromise, timeoutPromise])
        respond(id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        })
      }
      callTool().catch(e => {
        respondError(id, -32603, e.message)
      })
      break
    }

    case 'shutdown':
      respond(id, {})
      process.exit(0)
      break

    default:
      if (method.startsWith('notifications/')) break
      respond(id, null)
  }
}

process.on('unhandledRejection', (reason) => {
  process.stderr.write(`[mcp] unhandled rejection: ${reason}\n`)
})

process.on('SIGPIPE', () => {
  process.stderr.write('[mcp] SIGPIPE received, exiting\n')
  process.exit(0)
})

process.on('SIGTERM', () => {
  process.stderr.write('[mcp] SIGTERM received, shutting down\n')
  process.exit(0)
})

process.on('SIGINT', () => {
  process.stderr.write('[mcp] SIGINT received, shutting down\n')
  process.exit(0)
})

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
        process.stderr.write(`[mcp] parse error: ${e.message}, line: ${trimmed.slice(0, 100)}\n`)
      }
    }
  }
})

process.stdin.on('end', () => {
  process.stderr.write('[mcp] stdin closed, exiting\n')
  process.exit(0)
})

process.stdin.on('close', () => {
  process.stderr.write('[mcp] stdin closed, exiting\n')
  process.exit(0)
})

initModules().then(() => {
  core.log('info', '[mcp] server ready')
}).catch(e => {
  process.stderr.write(`[mcp] init failed: ${e.stack}\n`)
  process.exit(1)
})
