// 六合工具集 - impact_analysis handler

import { join } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { isConstantName } from '../misuse-helpers.js'
import { checkFileStaleness, attachStalenessWarning } from '../../staleness.js'

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

  if (!workspaceDir) {
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

  codeIndexService.initWorkspace(workspaceDir)

  const file = args?.file || ''
  if (!file) {
    return { error: 'missing_parameter', message: 'file is required', suggestion: 'Provide a file path relative to workspace_dir (e.g. "scripts/lib/tools/spawn.mjs")' }
  }

  const opts = {}
  const symbols = args?.symbols
  if (Array.isArray(symbols) && symbols.length > 0 && !args?.symbol) {
    const results = []
    for (const sym of symbols) {
      const symOpts = { symbol: sym, changeType: opts.changeType || 'modify', maxCallers: opts.maxCallers || 20, depth: opts.depth || 2 }
      if (args?.change_type) {
        const VALID_CHANGE_TYPES = ['modify', 'delete', 'rename']
        symOpts.changeType = VALID_CHANGE_TYPES.includes(args.change_type) ? args.change_type : 'modify'
      }
      if (args?.max_callers) symOpts.maxCallers = args.max_callers
      if (args?.depth) {
        const d = parseInt(args.depth)
        symOpts.depth = (d > 0 && d <= 10) ? d : 2
      }
      const misuseWarning = detectMisuse(sym)
      const result = await codeIndexService.getImpactAnalysis(file, symOpts)
      attachStalenessWarning(result, checkFileStaleness(codeIndexService, workspaceDir, file))
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
  if (args?.max_callers) opts.maxCallers = args.max_callers
  if (args?.depth) {
    const d = parseInt(args.depth)
    opts.depth = (d > 0 && d <= 10) ? d : 2
  }

  const misuseWarning = detectMisuse(args?.symbol)
  const result = await codeIndexService.getImpactAnalysis(file, opts)

  attachStalenessWarning(result, checkFileStaleness(codeIndexService, workspaceDir, file))

  if (misuseWarning) {
    result.misuse_warning = misuseWarning
  }

  return result
}
