import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { checkFileStaleness, attachStalenessWarning } from '../../staleness.js'

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

  const staleness = await checkFileStaleness(codeIndexService, workspaceDir, file)
  const result = await codeIndexService.getModuleDependencies(file, { depth: args?.depth || 3 })
  const hasCircular = result?.circular_dependencies?.length > 0
  // r22：next_step 补 symbol——取文件首个顶层 function/class 名，impact 直接可查
  let firstSymbol = null
  try {
    const outline = await codeIndexService.getFileOutline(file, { depth: 1, includeRefs: false, includeTestRefs: false, maxItems: 10 })
    if (outline?.outline?.length) {
      const top = outline.outline.find(s => s.type === 'function' || s.type === 'class' || s.type === 'method')
      if (top) firstSymbol = top.name
    }
  } catch {}
  const impactHint = firstSymbol
    ? `impact_analysis(file="${file}", symbol="${firstSymbol}")`
    : `impact_analysis(file="${file}")`
  result.next_step = hasCircular
    ? 'Circular dependency detected. Use fix_imports to resolve.'
    : `To modify a dependency, check impact first: ${impactHint}`
  return attachStalenessWarning(result, staleness)
}
