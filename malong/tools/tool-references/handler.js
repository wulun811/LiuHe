// 六合工具集 — references handler

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

  const symbol = args?.symbol || ''
  if (!symbol) {
    return { error: 'symbol parameter required' }
  }

  const results = await codeIndexService.getReferences(symbol, args?.file)
  return { symbol, results, count: results.length, workspace_dir: workspaceDir }
}
