// 六合工具集 — symbol_search handler

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

  const query = args?.query || ''
  // P2-B2：limit 负值 → SQL LIMIT -1 返回全表（几万条全量返回）；钳制到 [1, 500]
  const rawLimit = parseInt(args?.limit)
  const limit = Number.isNaN(rawLimit) ? 30 : Math.min(500, Math.max(1, rawLimit))

  if (!query) {
    return { error: 'missing_parameter', message: 'query is required', suggestion: 'Provide a symbol name substring to search (case-sensitive)' }
  }

  const results = await codeIndexService.searchSymbols(query, { limit })
  const res = { results, count: results.length, query, workspace_dir: workspaceDir }
  if (query.length === 1) {
    res.warning = 'single_char_query'
    res.suggestion = `Single-character query "${query}" is very broad. Use a longer substring for more targeted results.`
  }
  if (results.length === 0) {
    res.suggestion = `No symbols found. If files were recently added, call reindex(workspace_dir="${workspaceDir}") to update the index.`
    res.next_step = 'Check if workspace is indexed, or use glob to find the symbol manually.'
  } else {
    res.next_step = `Before modifying found symbols, check blast radius: impact_analysis(symbol="${results[0].name}")`
  }
  return res
}
