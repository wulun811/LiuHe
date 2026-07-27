// 六合工具集 — references handler

import { join } from 'node:path'
import { existsSync } from 'node:fs'

export async function handle(args, context) {
  const { codeIndexService, getWorkspaceDir } = context
  const workspaceDir = args?.workspace_dir

  if (!workspaceDir) {
    return { error: 'missing_parameter', message: 'workspace_dir is required', suggestion: 'Provide the absolute path to the project root directory. Call reindex first if this is a new workspace.' }
  }

  // 检查 workspace 是否已索引
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

  // 初始化 workspace 数据库
  codeIndexService.initWorkspace(workspaceDir)

  const symbol = args?.symbol || ''
  if (!symbol) {
    return { error: 'missing_parameter', message: 'symbol is required', suggestion: 'Provide a symbol name / call target to find references for' }
  }

  const results = await codeIndexService.getReferences(symbol, args?.file)
  return { symbol, results, count: results.length, workspace_dir: workspaceDir }
}
