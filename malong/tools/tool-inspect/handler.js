import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { attachStalenessWarning } from '../../staleness.js'

export async function handle(args, context) {
  const { codeIndexService, getWorkspaceDir } = context
  const workspaceDir = args?.workspace_dir

  if (!workspaceDir) {
    return { error: 'missing_parameter', message: 'workspace_dir is required' }
  }
  // R22-⑯：非字符串 workspace_dir 让 getWorkspaceDir→resolve 裸抛 TypeError
  if (typeof workspaceDir !== 'string') {
    return { error: 'invalid_input', message: `workspace_dir must be a string (got ${typeof workspaceDir})` }
  }

  const dbPath = join(getWorkspaceDir(workspaceDir), 'code-index.db')
  if (!existsSync(dbPath)) {
    return { error: 'workspace_not_indexed', message: `Workspace not indexed: ${workspaceDir}`, suggestion: `Call reindex(workspace_dir="${workspaceDir}") first` }
  }

  if (!codeIndexService) {
    return { error: 'service_unavailable', message: 'codeIndex service not available' }
  }

  const symbol = args?.symbol
  let file = args?.file
  if (!symbol || !file) {
    return { error: 'missing_parameter', message: 'symbol and file are required' }
  }

  // 16：file 参数共用守卫——无效（目录/不存在）时返回结构化错误，不再静默空
  if (codeIndexService?.resolveFileArg) {
    const resolved = codeIndexService.resolveFileArg(file)
    if (!resolved.ok) return { error: resolved.error.code, message: resolved.error.message, suggestion: resolved.error.suggestion }
    file = resolved.path
  }

  const includeOutline = args?.include_outline !== false
  const includeRefs = args?.include_refs !== false
  const includeChain = args?.include_chain !== false

  if (!includeOutline && !includeRefs && !includeChain) {
    return { error: 'invalid_input', message: 'at least one section required (include_outline, include_refs, or include_chain)' }
  }

  // R22-⑪：initWorkspace 异常不再静默吞——透出 init_warning（报告 INFO：旧 catch{} 无日志无提示）
  let initWarn = null
  try { await codeIndexService.initWorkspace(workspaceDir) } catch (e) { initWarn = `initWorkspace failed: ${e.message}` }
  const t0 = Date.now()

  // Y002-S2：inspect 保鲜——getSymbols 内部 ensureFreshFile 统一承担（R19-②）
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
  // R22-⑰（第四轮审核 P1）：partial_failures 带 section 归属——agent 才能针对性重试对应 section
  const partialFailures = [
    { section: 'outline', r: outlineR },
    { section: 'references', r: refsR },
    { section: 'call_chain', r: chainR },
  ].filter(x => x.r && !x.r.ok && x.r.reason)

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
  if (initWarn) result.init_warning = initWarn
  if (partialFailures.length > 0) {
    result.partial_failures = partialFailures.map(f => ({ section: f.section, reason: f.r.reason }))
  }
  result.next_step = `Before modifying: impact_analysis(symbol="${symbol}", file="${file}"). After modifying: test_bridge(action="run")`
  return attachStalenessWarning(result, outlineR?.ok ? outlineR.v?.freshness : null)
}
