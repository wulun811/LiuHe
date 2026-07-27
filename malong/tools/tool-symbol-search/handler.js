// 六合工具集 — symbol_search handler

export async function handle(args, context) {
  const { codeIndexService } = context
  const workspaceDir = args?.workspace_dir

  if (!workspaceDir) {
    return { error: 'workspace_dir parameter required — specify the project root directory. Call reindex first if this is a new workspace.' }
  }

  if (!codeIndexService) {
    return { error: 'codeIndex service not available' }
  }

  // 初始化 workspace 数据库
  codeIndexService.initWorkspace(workspaceDir)

  const query = args?.query || ''
  const limit = args?.limit || 30

  if (!query) {
    return { error: 'query parameter required' }
  }

  const results = await codeIndexService.searchSymbols(query, { limit })
  return { results, count: results.length, query, workspace_dir: workspaceDir }
}
