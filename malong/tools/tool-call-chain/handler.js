import { join } from 'node:path'
import { existsSync, statSync } from 'node:fs'

export async function handle(args, context) {
  const startTime = Date.now()
  const { codeIndexService, getWorkspaceDir } = context
  const workspaceDir = args?.workspace_dir

  if (!workspaceDir) {
    return { error: 'missing_parameter', message: 'workspace_dir is required', suggestion: 'Provide the absolute path to the project root directory. Call reindex first if this is a new workspace.' }
  }

  const dbPath = join(getWorkspaceDir(workspaceDir), 'code-index.db')
  if (!existsSync(dbPath)) {
    return { error: 'workspace_not_indexed', message: `Workspace not indexed: ${workspaceDir}`, suggestion: `Call reindex(workspace_dir="${workspaceDir}") first` }
  }

  if (!codeIndexService) {
    return { error: 'service_unavailable', message: 'codeIndex service not available', suggestion: 'Check MCP server configuration and ensure code-index.js is loaded' }
  }

  codeIndexService.initWorkspace(workspaceDir)

  const file = args?.file || ''
  if (!file) {
    return { error: 'missing_parameter', message: 'file is required', suggestion: 'Provide a file path relative to workspace_dir (e.g. "src/auth.py")' }
  }

  const line = parseInt(args?.line) || 0
  const depthRaw = parseInt(args?.depth)
  const depth = Number.isNaN(depthRaw) ? 2 : Math.max(0, Math.min(depthRaw, 10))
  const maxCallers = parseInt(args?.max_callers) || 20
  const maxCallees = parseInt(args?.max_callees) || 20

  let symbol = args?.symbol
  let symbolSignature = null

  if (!symbol && line > 0) {
    const symbols = codeIndexService.getSymbolsAtLine(file, line)
    if (symbols && symbols.length > 0) {
      const top = symbols.find(s => s.type === 'function' || s.type === 'method' || s.type === 'class')
        || symbols[symbols.length - 1]
      symbol = top.name
      symbolSignature = top.signature || null
    }
  }

  if (!symbol) {
    return { error: 'missing_parameter', message: 'Could not determine symbol from file+line. Provide symbol explicitly.', suggestion: 'Provide a symbol name, or ensure the file is indexed and line falls within a function/class definition.' }
  }

  const impact = await codeIndexService.getImpactAnalysis(file, {
    symbol,
    depth,
    maxCallers: Math.max(maxCallers, maxCallees)
  })

  let indexStale = false
  const absPath = join(workspaceDir, file)
  try {
    const diskMtime = statSync(absPath).mtimeMs
    const indexedMtime = codeIndexService.getFileMtime(file)
    if (diskMtime > indexedMtime) indexStale = true
  } catch {}

  const result = {
    target: {
      file,
      line: line || undefined,
      symbol: impact.target_symbol || symbol,
      signature: symbolSignature || undefined,
      risk_level: impact.risk_level || 'unknown'
    },
    callers: formatCallers(impact, 'callers'),
    truncated_callers: impact.truncated_callers || false,
    callees: formatCallees(impact),
    truncated_callees: impact.truncated_callees || false,
    test_references: formatTestRefs(impact),
    recently_modified: checkRecentModifications(workspaceDir, impact),
    metadata: {
      parse_time_ms: Date.now() - startTime,
      cache_hit: !!impact._fromCache,
      ...(indexStale ? { index_stale: true } : {}),
      ...(impact.summary ? {
        total_callers: impact.summary.direct_callers + impact.summary.indirect_callers,
        total_callees: impact.summary.total_callees || 0
      } : {})
    }
  }

  if (indexStale) {
    result.warning = 'index_stale'
    result.suggestion = `File "${file}" was modified after last index. Call reindex to refresh.`
  }

  return result
}

function formatCallers(impact, key) {
  const callers = impact[key] || []
  return callers.map(c => ({
    file: c.file,
    line: c.line,
    function: c.function || c.caller_function || 'unknown',
    distance: c.depth || 1,
    via: c.via || undefined,
    context: c.context || undefined
  }))
}

function formatCallees(impact) {
  const callees = impact.callees || []
  return callees.map(c => ({
    file: c.callee_file || c.file,
    line: c.callee_line || c.line,
    name: c.function || c.name,
    distance: 1,
    call_expr: c.call_expr || undefined
  }))
}

function formatTestRefs(impact) {
  const refs = (impact.test_references || impact.test_refs || [])
  return refs.map(r => ({
    file: r.file,
    line: r.line,
    test: r.test || r.function || 'unknown'
  }))
}

function checkRecentModifications(workspaceDir, impact, thresholdMinutes = 5) {
  const now = Date.now()
  const files = new Set()
  const collect = (items) => {
    if (!items) return
    for (const item of (Array.isArray(items) ? items : [])) {
      if (item.file) files.add(item.file)
    }
  }
  collect(impact.callers)
  collect(impact.callees)
  collect(impact.test_references)
  collect(impact.test_refs)

  const modified = []
  for (const relFile of files) {
    try {
      const absPath = join(workspaceDir, relFile)
      const mtime = statSync(absPath).mtimeMs
      const diffMinutes = (now - mtime) / 60000
      if (diffMinutes < thresholdMinutes) {
        modified.push({ file: relFile, minutes_ago: Math.floor(diffMinutes) })
      }
    } catch {}
  }

  return modified
}
