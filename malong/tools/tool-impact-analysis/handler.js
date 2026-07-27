// 六合工具集 - impact_analysis handler

import { join } from 'node:path'
import { existsSync } from 'node:fs'

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

  return await codeIndexService.getImpactAnalysis(file, opts)
}
