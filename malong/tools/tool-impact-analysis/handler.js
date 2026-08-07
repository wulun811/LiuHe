// 六合工具集 - impact_analysis handler

import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { isConstantName } from '../misuse-helpers.js'
import { attachStalenessWarning } from '../../staleness.js'
import { validateFilePath } from '../../error-codes.js'

function detectMisuse(symbol) {
  if (!symbol) return null
  if (isConstantName(symbol)) {
    return {
      warning: 'likely_wrong_tool',
      suggestion: `"${symbol}" looks like a constant name. For tracing constant values and finding hardcoded copies, use trace_symbol(symbol="${symbol}").`
    }
  }
  return null
}

export async function handle(args, context) {
  const { codeIndexService, getWorkspaceDir } = context
  const workspaceDir = args?.workspace_dir

  if (typeof workspaceDir !== 'string' || !workspaceDir) {
    return { error: 'missing_parameter', message: 'workspace_dir is required', suggestion: 'Provide the absolute path to the project root directory. Call reindex first if this is a new workspace.' }
  }

  const dbPath = join(getWorkspaceDir(workspaceDir), 'code-index.db')
  if (!existsSync(dbPath)) {
    return {
      error: 'workspace_not_indexed',
      message: `Workspace not indexed: ${workspaceDir}`,
      suggestion: `Call reindex(workspace_dir="${workspaceDir}") first`
    }
  }

  if (!codeIndexService) {
    return { error: 'service_unavailable', message: 'codeIndex service not available', suggestion: 'Check MCP server configuration and ensure code-index.js is loaded' }
  }

  await codeIndexService.initWorkspace(workspaceDir)

  const file = args?.file || ''
  if (!file) {
    return { error: 'missing_parameter', message: 'file is required', suggestion: 'Provide a file path relative to workspace_dir (e.g. "scripts/lib/tools/spawn.mjs")' }
  }
  // r54(P0-1): staleness/indexFile 前必须先校验——否则 `../` 经 checkFileStaleness 自动索引逃逸 workspace
  const v = validateFilePath(file, workspaceDir)
  if (v.blocked) {
    return { error: 'PATH_BLOCKED', message: `file blocked: ${v.detail}`, suggestion: 'Provide a file path inside workspace_dir (no "..", no absolute paths outside workspace)' }
  }

  const opts = {}
  // R19-②：保鲜由服务层 getImpactAnalysis 内部 ensureFreshFile 统一承担
  // Y002-S4：输出预算控制——max_results（默认 20，0=不限；max_callers 为向后兼容别名）
  opts.maxCallers = 20
  if (args?.max_results !== undefined || args?.max_callers !== undefined) {
    const raw = args?.max_results !== undefined ? args.max_results : args.max_callers
    const m = parseInt(raw)
    opts.maxCallers = Number.isFinite(m) && m >= 0 ? m : 20
  }
  const ctxMode = args?.context_mode
  opts.contextMode = ['none', 'snippet', 'full'].includes(ctxMode) ? ctxMode : 'snippet'
  const symbols = args?.symbols
  if (Array.isArray(symbols) && symbols.length > 0 && !args?.symbol) {
    const results = []
    for (const sym of symbols) {
      const symOpts = { symbol: sym, changeType: opts.changeType || 'modify', maxCallers: opts.maxCallers, depth: opts.depth || 2, contextMode: opts.contextMode }
      if (args?.change_type) {
        const VALID_CHANGE_TYPES = ['modify', 'delete', 'rename']
        symOpts.changeType = VALID_CHANGE_TYPES.includes(args.change_type) ? args.change_type : 'modify'
      }
      if (args?.depth) {
        const d = parseInt(args.depth)
        symOpts.depth = (d > 0 && d <= 10) ? d : 2
      }
      const misuseWarning = detectMisuse(sym)
      const result = await codeIndexService.getImpactAnalysis(file, symOpts)
      attachStalenessWarning(result, result.freshness)
      if (misuseWarning) result.misuse_warning = misuseWarning
      results.push(result)
    }
    return { symbols: results, file, batch: true }
  }

  if (args?.symbol) opts.symbol = args.symbol
  if (args?.change_type) {
    const VALID_CHANGE_TYPES = ['modify', 'delete', 'rename']
    opts.changeType = VALID_CHANGE_TYPES.includes(args.change_type) ? args.change_type : 'modify'
  }
  if (args?.depth) {
    const d = parseInt(args.depth)
    opts.depth = (d > 0 && d <= 10) ? d : 2
  }

  const misuseWarning = detectMisuse(args?.symbol)
  const result = await codeIndexService.getImpactAnalysis(file, opts)

  attachStalenessWarning(result, result.freshness)

  if (misuseWarning) {
    result.misuse_warning = misuseWarning
  }

  const directN = result.caller_count?.direct || 0
  const testN = result.caller_count?.test || 0
  if (result.risk_level === 'high') {
    result.next_step = `High risk (${directN} direct + ${testN} test callers). Before modifying: sandbox_validate(workspace_dir="${workspaceDir}", file="${file}", new_content=...) to pre-validate. After: test_bridge(action="run")`
  } else if (result.risk_level === 'medium') {
    result.next_step = `Medium risk (${directN} direct + ${testN} test callers). Review callers above before modifying. After: test_bridge(action="run")`
  } else {
    result.next_step = `After modifying, verify: test_bridge(action="run")`
  }

  return result
}
