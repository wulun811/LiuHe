// 六合工具集 — repo_map handler

export async function handle(args, context) {
  const { repoMapService, workspaceDir, ignoreRules } = context

  if (!repoMapService) {
    return { error: 'repoMap service not available' }
  }

  const opts = {
    ignoreRules,
    relevantFiles: args?.relevantFiles,
    relevantEntities: args?.relevantEntities,
  }

  if (args?.focused) {
    return await repoMapService.generateFocused(args.dir || workspaceDir, opts)
  }
  return await repoMapService.generate(args.dir || workspaceDir, opts)
}
