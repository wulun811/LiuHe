import { join } from 'node:path'
import { existsSync } from 'node:fs'

export async function handle(args, context) {
  const { codeIndexService, getWorkspaceDir } = context
  const workspaceDir = args?.workspace_dir

  if (!workspaceDir) {
    return { error: 'missing_parameter', message: 'workspace_dir is required' }
  }

  const dbPath = join(getWorkspaceDir(workspaceDir), 'code-index.db')
  if (!existsSync(dbPath)) {
    return { error: 'workspace_not_indexed', message: `Workspace not indexed: ${workspaceDir}`, suggestion: `Call reindex(workspace_dir="${workspaceDir}") first` }
  }

  if (!codeIndexService) {
    return { error: 'service_unavailable', message: 'codeIndex service not available' }
  }

  const symbol = args?.symbol
  const file = args?.file
  if (!symbol || !file) {
    return { error: 'missing_parameter', message: 'symbol and file are required' }
  }

  const includeOutline = args?.include_outline !== false
  const includeRefs = args?.include_refs !== false
  const includeChain = args?.include_chain !== false

  if (!includeOutline && !includeRefs && !includeChain) {
    return { error: 'invalid_input', message: 'at least one section required (include_outline, include_refs, or include_chain)' }
  }

  try { codeIndexService.initWorkspace(workspaceDir) } catch {}
  const t0 = Date.now()

  // P2-C11：allSettled——任一子查询失败（并发 reindex 的 DROP/CREATE INDEX 窗口等）
  // 不再丢弃已完成的 outline/refs
  const settle = (p) => (p ?? Promise.resolve(null)).then(v => ({ ok: true, v })).catch(e => ({ ok: false, v: null, reason: e.message }))
  const [outlineR, refsR, chainR] = await Promise.all([
    settle(includeOutline ? codeIndexService.getSymbols(file) : null),
    settle(includeRefs ? codeIndexService.getReferences(symbol) : null),
    settle(includeChain ? Promise.all([
      codeIndexService.getCallers(symbol),
      codeIndexService.getCallees(symbol),
    ]) : null),
  ])
  const outline = outlineR?.ok ? outlineR.v : null
  const refs = refsR?.ok ? refsR.v : null
  const chain = chainR?.ok ? chainR.v : null
  const partialFailures = [outlineR, refsR, chainR].filter(r => r && !r.ok && r.reason)

  const result = { symbol, file }
  const sections = []

  if (outline) {
    const functions = outline.filter(s => ['function', 'method'].includes(s.type))
    const classes = outline.filter(s => s.type === 'class')
    const variables = outline.filter(s => s.type === 'variable')
    result.outline = {
      functions: functions.map(s => ({ name: s.name, type: s.type, start_line: s.start_line, end_line: s.end_line })),
      classes: classes.map(s => ({ name: s.name, start_line: s.start_line, end_line: s.end_line })),
      variables: variables.length > 0 ? variables.map(s => ({ name: s.name, start_line: s.start_line })) : undefined,
      total_symbols: outline.length,
    }
    sections.push('outline')
  }

  if (refs) {
    result.references = { count: refs.length, results: refs.slice(0, 30) }
    if (refs.length > 30) result.references.truncated = true
    sections.push('references')
  }

  if (chain) {
    result.call_chain = {
      callers: (chain[0] || []).slice(0, 20),
      callees: (chain[1] || []).slice(0, 20),
    }
    sections.push('call_chain')
  }

  if ((!refs || refs.length === 0) && (!chain || (chain[0] || []).length === 0)) {
    try {
      const similar = await codeIndexService.searchSymbols(symbol.slice(0, Math.max(3, symbol.length - 2)))
      if (similar && similar.length > 0) {
        result.suggestions = similar.slice(0, 5).map(s => ({ name: s.name, file: s.file, type: s.type }))
      }
    } catch {}
  }

  result.metadata = { sections_included: sections, parse_time_ms: Date.now() - t0 }
  if (partialFailures.length > 0) {
    result.partial_failures = partialFailures.map(f => f.reason)
  }
  result.next_step = `Before modifying: impact_analysis(symbol="${symbol}", file="${file}"). After modifying: test_bridge(action="run")`
  return result
}
