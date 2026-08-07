// 六合工具集 — symbol_search handler

import { join } from 'node:path'
import { existsSync } from 'node:fs'

export async function handle(args, context) {
  const { codeIndexService, getWorkspaceDir } = context
  const workspaceDir = args?.workspace_dir

  if (typeof workspaceDir !== 'string' || !workspaceDir) {
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
  await codeIndexService.initWorkspace(workspaceDir)

  const query = args?.query || ''
  // P2-B2：limit 负值 → SQL LIMIT -1 返回全表（几万条全量返回）；钳制到 [1, 500]
  const rawLimit = parseInt(args?.limit)
  const limit = Number.isNaN(rawLimit) ? 30 : Math.min(500, Math.max(1, rawLimit))

  if (!query) {
    return { error: 'missing_parameter', message: 'query is required', suggestion: 'Provide a symbol name substring to search (case-sensitive)' }
  }

  // R22-⑪：staleness 前置——搜索前先保鲜结果文件（与 references ensureFreshFile 同模式；mtime 未变时廉价）
  // 保鲜可能重索引符号，之后重查一次确保结果反映最新磁盘
  let results = await codeIndexService.searchSymbols(query, { limit })
  if (codeIndexService?.ensureFreshFile && results.length > 0) {
    // R22-⑰（第四轮审核 P1）：去重后再保鲜——同文件多结果（如类方法群）时避免 N 次冗余 statSync/realpath
    const uniqueFiles = [...new Set(results.map(r => r.file))]
    await Promise.allSettled(uniqueFiles.map(f => codeIndexService.ensureFreshFile(f)))
    results = await codeIndexService.searchSymbols(query, { limit })
  }
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
