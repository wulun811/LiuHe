import { existsSync, mkdirSync, writeSync, writeFileSync, unlinkSync, appendFileSync, readFileSync, statSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { parseMalongignore, collectFiles } from './file-collector.js'

const args = process.argv.slice(2)
const wsIdx = args.indexOf('--workspace')
const workspaceDir = resolve(wsIdx >= 0 ? args[wsIdx + 1] : '0通天/')

const services = {}
const stateDir = join(process.cwd(), 'data', 'malong-mcp')
if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true })

const STATS_FILE = join(homedir(), '.config', 'opencode', 'edit-batch-stats.jsonl')

function recordStats(fileSize, numEdits) {
  const record = {
    timestamp: Date.now(),
    file_size_bytes: fileSize,
    num_edits: numEdits,
    estimated_tokens_saved: Math.ceil((numEdits - 1) * (fileSize / 4))
  }
  try {
    appendFileSync(STATS_FILE, JSON.stringify(record) + '\n')
  } catch {}
}

function getCumulativeStats() {
  if (!existsSync(STATS_FILE)) return { totalCalls: 0, totalEdits: 0, totalTokensSaved: 0 }
  try {
    const lines = readFileSync(STATS_FILE, 'utf-8').trim().split('\n').filter(Boolean)
    let totalCalls = 0, totalEdits = 0, totalTokensSaved = 0
    for (const line of lines) {
      try {
        const r = JSON.parse(line)
        totalCalls++
        totalEdits += r.num_edits
        totalTokensSaved += r.estimated_tokens_saved
      } catch {}
    }
    return { totalCalls, totalEdits, totalTokensSaved }
  } catch { return { totalCalls: 0, totalEdits: 0, totalTokensSaved: 0 } }
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
}

const malongignorePath = join(process.cwd(), '.malongignore')
const ignoreRules = parseMalongignore(malongignorePath)

let langParserMod, codeIndexMod, codeIndexInstance, repoMapMod
let _ready = false

async function initModules() {
  langParserMod = await import('./lang-parser.js')
  await langParserMod.init(core)
  codeIndexMod = await import('./code-index.js')
  await codeIndexMod.init(core)
  codeIndexInstance = (await import('./code-index.js')).default
  repoMapMod = await import('./repo-map.js')
  await repoMapMod.init(core)
  _ready = true
  core.log('info', `[mcp] modules initialized, workspace=${workspaceDir}, stateDir=${stateDir}`)
}

async function toolReindex() {
  if (codeIndexInstance._indexing) {
    return { status: 'already indexing' }
  }
  codeIndexInstance._indexing = true
  setImmediate(async () => {
    try {
      const t0 = Date.now()
      const files = collectFiles(workspaceDir, { ignoreRules })
      for (let i = 0; i < files.length; i++) {
        codeIndexInstance.indexFile(files[i].path, workspaceDir)
        if (i > 0 && i % 50 === 0) await new Promise(r => setImmediate(r))
      }
      const crossResolved = codeIndexInstance._resolveCrossFileRefs()
      codeIndexInstance._indexing = false
      core.log('info', `[mcp] reindex done: ${files.length} files, ${crossResolved} cross-refs, ${Date.now() - t0}ms`)
    } catch (e) {
      core.log('error', `[mcp] reindex failed: ${e.message}`)
      codeIndexInstance._indexing = false
    }
  })
  return { status: 'started', note: 'indexing in background, check with symbol_search when done (~3 min)' }
}

async function toolRepoMap(args_) {
  const svc = core.getService('repoMap')
  if (!svc) return { error: 'repoMap service not available' }
  const opts = {
    ignoreRules,
    relevantFiles: args_.relevantFiles,
    relevantEntities: args_.relevantEntities,
  }
  const result = args_?.focused
    ? await svc.generateFocused(args_.dir || workspaceDir, opts)
    : await svc.generate(args_.dir || workspaceDir, opts)
  return result
}

async function toolSymbolSearch(args_) {
  const svc = core.getService('codeIndex')
  if (!svc) return { error: 'codeIndex service not available' }
  const query = args_?.query || ''
  const limit = args_?.limit || 30
  if (!query) return { error: 'query parameter required' }
  const results = await svc.searchSymbols(query, { limit })
  return { results, count: results.length, query }
}

async function toolReferences(args_) {
  const svc = core.getService('codeIndex')
  if (!svc) return { error: 'codeIndex service not available' }
  const symbol = args_?.symbol || ''
  if (!symbol) return { error: 'symbol parameter required' }
  const results = await svc.getReferences(symbol, args_.file)
  return { symbol, results, count: results.length }
}

async function toolImpactAnalysis(args_) {
  const svc = core.getService('codeIndex')
  if (!svc) return { error: 'codeIndex service not available' }
  const file = args_?.file || ''
  if (!file) return { error: 'file parameter required' }
  return await svc.getImpactAnalysis(file, { depth: args_.depth || 3 })
}

async function toolDepGraph(args_) {
  const svc = core.getService('codeIndex')
  if (!svc) return { error: 'codeIndex service not available' }
  const file = args_?.file || ''
  if (!file) return { error: 'file parameter required' }
  return await svc.getModuleDependencies(file, { depth: args_.depth || 3 })
}

async function toolEditBatch(args_) {
  const filePath = args_?.file_path || ''
  const editsRaw = args_?.edits || ''
  const dryRun = !!args_?.dry_run

  if (!filePath) return { error: 'file_path parameter required' }
  if (!editsRaw) return { error: 'edits parameter required' }

  const __dirname = dirname(fileURLToPath(import.meta.url))
  const pythonScript = join(__dirname, 'tools', 'batch_edit_mvp.py')
  const tmpFile = join(__dirname, 'tools', `.edit_batch_tmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`)

  try {
    writeFileSync(tmpFile, typeof editsRaw === 'string' ? editsRaw : JSON.stringify(editsRaw), 'utf-8')

    const args = [pythonScript, filePath, '--edits-file', tmpFile]
    if (dryRun) args.push('--dry-run')

    const stdout = execFileSync('python3', args, {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    })

    const delimiter = '---MALONG_BATCH_EDIT_JSON_END---'
    const delimIdx = stdout.indexOf(delimiter)
    const jsonStr = delimIdx >= 0 ? stdout.slice(0, delimIdx).trim() : stdout.trim()

    let result
    try {
      result = JSON.parse(jsonStr)
    } catch {
      return { result: stdout.trim() }
    }

    // Record stats on success (actual edits, not dry-run)
    if (result.success && !dryRun) {
      try {
        const fileStats = statSync(filePath)
        recordStats(fileStats.size, result.edits_applied || 0)
      } catch {}
    }

    // Attach cumulative stats to result
    const stats = getCumulativeStats()
    result.cumulative_stats = stats

    return result

  } catch (e) {
    if (e.stdout) {
      const out = typeof e.stdout === 'string' ? e.stdout : e.stdout.toString('utf-8')
      const delimIdx = out.indexOf('---MALONG_BATCH_EDIT_JSON_END---')
      const jsonStr = delimIdx >= 0 ? out.slice(0, delimIdx).trim() : out.trim()
      try {
        return JSON.parse(jsonStr)
      } catch {}
    }
    return { error: e.message || String(e) }
  } finally {
    try { unlinkSync(tmpFile) } catch {}
  }
}

const TOOLS = [
  {
    name: 'malong_reindex',
    description: 'Trigger full re-index of the 0通天/ project. Call this once before using other tools — first-time index takes ~3 minutes (456 files, tree-sitter parsing). Subsequent calls are fast if nothing changed.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'malong_repo_map',
    description: 'Generate a structured code map of the project. Full output is ~36K tokens (~456 files with top-level symbols). For token-efficient queries, use focused=true + relevantEntities to get a targeted ~50 token map of only the files containing specific symbols.',
    inputSchema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'Root directory to map (default: workspace root, a subdir of 0通天/)' },
        focused: { type: 'boolean', description: 'If true, limit output to ~2000 tokens by pruning symbols. Combine with relevantEntities for best results.' },
        relevantFiles: { type: 'array', items: { type: 'string' }, description: 'Only include these specific files (paths relative to workspace root, e.g. ["scripts/lib/tools/spawn.mjs"])' },
        relevantEntities: { type: 'array', items: { type: 'string' }, description: 'Only include files that contain these top-level symbols (e.g. ["spawnFixer", "agentLoop"])' },
      },
    },
  },
  {
    name: 'malong_symbol_search',
    description: 'Search for symbols (functions, classes, methods, variables) by name across the entire 0通天/ project. Returns file path, line number, and symbol type. Substring match — e.g. query "spawnFix" finds both "spawnFixer" and "_handleSpawnFixer".',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Symbol name substring to search (case-sensitive)' },
        limit: { type: 'number', description: 'Max results (default 30)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'malong_references',
    description: 'Find all cross-file references to a symbol (call targets, imports, extends). NOTE: searches by target_name stored in refs table — for member expressions like spawn.spawnFixer, search "spawn.spawnFixer" not just "spawnFixer". For best results, first use malong_symbol_search to confirm the exact symbol name, then search references.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Symbol name / call target to find references for' },
        file: { type: 'string', description: 'Restrict search to a specific file (path relative to workspace root, e.g. "scripts/lib/tools/spawn.mjs")' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'malong_impact_analysis',
    description: 'Analyze the impact scope of changing a file. Returns direct callers (which functions call symbols defined in this file) plus transitive callers up to N levels deep. Use this before modifying shared utilities to understand the blast radius.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'File path relative to 0通天/ (e.g. "scripts/lib/tools/spawn.mjs", not the full absolute path)' },
        depth: { type: 'number', description: 'Transitive caller depth (default 3, max 10)' },
      },
      required: ['file'],
    },
  },
  {
    name: 'malong_dep_graph',
    description: 'Show the import dependency graph for a file — what modules it imports (directImports) and transitive dependencies up to N levels deep. Use this to understand module coupling before refactoring.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'File path relative to 0通天/ (e.g. "scripts/lib/tools/spawn.mjs")' },
        depth: { type: 'number', description: 'Transitive depth (default 3, max 10)' },
      },
      required: ['file'],
    },
  },
  {
    name: 'malong_edit_batch',
    description: 'Batch edit: apply multiple text replacements to a single file atomically. Saves tokens vs multiple edit calls. Whitespace-tolerant: trailing spaces normalized during matching. Each old_string must uniquely match in original file (unless replace_all=true). Does NOT support chained replacement (A→B→C); merge as single edit (A→C). Returns error_summary with all errors aggregated. Includes usage stats (cumulative_stats).',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to edit' },
        edits: { type: 'string', description: 'JSON array of edits. Example: [{"old_string":"foo","new_string":"bar","replace_all":false}]' },
        dry_run: { type: 'boolean', description: 'Preview changes as unified diff, do not apply' },
      },
      required: ['file_path', 'edits'],
    },
  },
]

function respond(id, result) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, result })
  writeSync(1, msg + '\n')
}

function respondError(id, code, message) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })
  writeSync(1, msg + '\n')
}

function handleRequest(req) {
  const { id, method, params } = req
  if (id == null) return

  switch (method) {
    case 'initialize':
      respond(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'malong-mcp', version: '0.1.0' },
      })
      break

    case 'ping':
      respond(id, 'pong')
      break

    case 'tools/list':
      respond(id, { tools: TOOLS })
      break

    case 'tools/call': {
      if (!_ready) {
        respondError(id, -32000, 'Server still loading modules, please retry in a few seconds')
        break
      }
      const { name, arguments: toolArgs } = params || {}
      const callTool = async () => {
        let result
        switch (name) {
          case 'malong_reindex':
            result = await toolReindex()
            break
          case 'malong_repo_map':
            result = await toolRepoMap(toolArgs)
            break
          case 'malong_symbol_search':
            result = await toolSymbolSearch(toolArgs)
            break
          case 'malong_references':
            result = await toolReferences(toolArgs)
            break
          case 'malong_impact_analysis':
            result = await toolImpactAnalysis(toolArgs)
            break
          case 'malong_dep_graph':
            result = await toolDepGraph(toolArgs)
            break
          case 'malong_edit_batch':
            result = await toolEditBatch(toolArgs)
            break
          default:
            respondError(id, -32601, `Tool not found: ${name}`)
            return
        }
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

initModules().then(() => {
  core.log('info', '[mcp] server ready')
}).catch(e => {
  process.stderr.write(`[mcp] init failed: ${e.stack}\n`)
  process.exit(1)
})
