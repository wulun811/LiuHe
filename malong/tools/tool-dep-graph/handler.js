// 六合工具集 — dep_graph handler

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

  const file = args?.file || ''
  if (!file) {
    return { error: 'file parameter required' }
  }

  return await codeIndexService.getModuleDependencies(file, { depth: args?.depth || 3 })
}
