import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { checkFileStaleness, attachStalenessWarning, ensureIndexed } from '../../staleness.js'

export async function handle(args, context) {
  const { codeIndexService, getWorkspaceDir } = context
  const workspaceDir = args?.workspace_dir

  if (!workspaceDir) {
    return { error: 'missing_parameter', message: 'workspace_dir is required', suggestion: 'Provide the absolute path to the project root directory. Call reindex first if this is a new workspace.' }
  }

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

  codeIndexService.initWorkspace(workspaceDir)

  const file = args?.file || ''
  if (!file) {
    return { error: 'missing_parameter', message: 'file is required', suggestion: 'Provide a file path relative to workspace_dir (e.g. "scripts/lib/tools/spawn.mjs")' }
  }

  const staleness = checkFileStaleness(codeIndexService, workspaceDir, file)
  let result = await codeIndexService.getModuleDependencies(file, { depth: args?.depth || 3 })
  if (result?.error === 'file_not_found' && ensureIndexed(codeIndexService, workspaceDir, file)) {
    result = await codeIndexService.getModuleDependencies(file, { depth: args?.depth || 3 })
    if (result && !result.error) result.auto_indexed = true
  }
  return attachStalenessWarning(result, staleness)
}
