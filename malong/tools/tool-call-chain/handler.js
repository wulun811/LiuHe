import { join } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { checkFileStaleness, attachStalenessWarning } from '../../staleness.js'

function detectMisuse(args) {
  const line = parseInt(args?.line) || 0
  const symbol = args?.symbol
  if (symbol && line === 0) {
    return {
      warning: 'likely_wrong_tool',
      suggestion: `You provided symbol="${symbol}" but no line number. For symbol-level impact analysis, use impact_analysis(symbol="${symbol}") which includes risk level and test references. call_chain is designed for line-level precision when you know the line but not the symbol name.`
    }
  }
  return null
}

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

  const misuseWarning = detectMisuse(args)

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

  const staleness = await checkFileStaleness(codeIndexService, workspaceDir, file)
  const impact = await codeIndexService.getImpactAnalysis(file, {
    symbol,
    depth,
    maxCallers: Math.max(maxCallers, maxCallees)
  })

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
    callees: formatCallees(impact, maxCallees),
    truncated_callees: impact.truncated_callees || (impact.callees || []).length > maxCallees,
    test_references: formatTestRefs(impact),
    recently_modified: checkRecentModifications(workspaceDir, impact),
    next_step: `For full blast radius + risk level + test references, use impact_analysis(symbol="${impact.target_symbol || symbol}")`,
    metadata: {
      parse_time_ms: Date.now() - startTime,
      cache_hit: !!impact._fromCache,
      // P2-B1：旧代码引用不存在的 impact.summary（恒 undefined）→ 改用 caller_count
      total_callers: impact.caller_count ? impact.caller_count.direct + impact.caller_count.indirect : (impact.callers || []).length,
      total_callees: (impact.callees || []).length
    }
  }

  attachStalenessWarning(result, staleness)

  if (misuseWarning) {
    result.misuse_warning = misuseWarning
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

function formatCallees(impact, maxCallees = 20) {
  const callees = impact.callees || []
  const seen = new Set()
  const result = []
  for (const c of callees) {
    if (maxCallees > 0 && result.length >= maxCallees) break // P2-B1：max_callees 生效
    const entry = {
      file: c.callee_file || c.file,
      line: c.callee_line || c.line,
      name: c.function || c.name,
      distance: 1,
      call_expr: c.call_expr || undefined
    }
    const key = `${entry.file}:${entry.line}:${entry.name}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(entry)
  }
  return result
}

function formatTestRefs(impact) {
  const refs = (impact.callers || []).filter(c => c.type === 'test')
  return refs.map(r => ({
    file: r.file,
    line: r.line,
    test: r.function || r.test || 'unknown'
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
