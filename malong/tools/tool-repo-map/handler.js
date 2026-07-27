// 六合工具集 — repo_map handler

import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { parseMalongignore } from '../../file-collector.js'

export async function handle(args, context) {
  const { repoMapService, getWorkspaceDir } = context
  const workspaceDir = args?.workspace_dir

  if (!workspaceDir) {
    return { error: 'workspace_dir parameter required — specify the project root directory to map' }
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

  if (!repoMapService) {
    return { error: 'repoMap service not available' }
  }

  const malongignorePath = join(workspaceDir, '.malongignore')
  const ignoreRules = existsSync(malongignorePath) ? parseMalongignore(malongignorePath) : null

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
