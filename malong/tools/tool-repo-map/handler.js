// 六合工具集 — repo_map handler

import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { parseMalongignore } from '../../file-collector.js'

export async function handle(args, context) {
  const { repoMapService, getWorkspaceDir } = context
  const workspaceDir = args?.workspace_dir

  if (!workspaceDir) {
    return { error: 'missing_parameter', message: 'workspace_dir is required', suggestion: 'Provide the absolute path to the project root directory to map' }
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
    return { error: 'service_unavailable', message: 'repoMap service not available', suggestion: 'Check MCP server configuration and ensure repo-map.js is loaded' }
  }

  // P2-C12：args.dir 必须落在 workspace 内（旧：可映射任意目录 /etc）
  // r54(P1): 相对 dir 按 workspace_dir 解析——旧实现 resolve(scanDir) 用进程 cwd，workspace≠cwd 时合法子目录被误判 PATH_BLOCKED
  const { resolve, sep } = await import('node:path')
  let scanDir = args.dir ? resolve(workspaceDir, args.dir) : resolve(workspaceDir)
  const resolvedDir = resolve(scanDir)
  const resolvedWs = resolve(workspaceDir)
  if (resolvedDir !== resolvedWs && !resolvedDir.startsWith(resolvedWs + sep)) {
    return { error: 'PATH_BLOCKED', message: `dir escapes workspace: ${scanDir}` }
  }

  const malongignorePath = join(workspaceDir, '.malongignore')
  const ignoreRules = existsSync(malongignorePath) ? parseMalongignore(malongignorePath) : []

  const opts = {
    ignoreRules,
    workspaceDir,
    relevantFiles: args?.relevantFiles,
    relevantEntities: args?.relevantEntities,
  }

  if (args?.focused) {
    return await repoMapService.generateFocused(scanDir, opts)
  }
  return await repoMapService.generate(scanDir, opts)
}
