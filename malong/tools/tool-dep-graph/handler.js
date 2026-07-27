// 六合工具集 — dep_graph handler

export async function handle(args, context) {
  const { codeIndexService } = context

  if (!codeIndexService) {
    return { error: 'codeIndex service not available' }
  }

  const file = args?.file || ''
  if (!file) {
    return { error: 'file parameter required' }
  }

  return await codeIndexService.getModuleDependencies(file, { depth: args?.depth || 3 })
}
