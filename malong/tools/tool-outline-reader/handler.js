import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { attachStalenessWarning, ensureIndexed } from '../../staleness.js'
import { validateFilePath } from '../../error-codes.js'
import { guardReadPath } from '../../path-guard.js'

export async function handle(args, context) {
  const { codeIndexService, getWorkspaceDir } = context
  const workspaceDir = args?.workspace_dir

  if (!workspaceDir) {
    return { error: 'missing_parameter', message: 'workspace_dir is required', suggestion: 'Provide the absolute path to the project root directory. Call reindex first if this is a new workspace.' }
  }

  const dbPath = join(getWorkspaceDir(workspaceDir), 'code-index.db')
  if (!existsSync(dbPath)) {
    return { error: 'workspace_not_indexed', message: `Workspace not indexed: ${workspaceDir}`, suggestion: `Call reindex(workspace_dir="${workspaceDir}") first` }
  }

  if (!codeIndexService) {
    return { error: 'service_unavailable', message: 'codeIndex service not available', suggestion: 'Check MCP server configuration and ensure code-index.js is loaded' }
  }

  await codeIndexService.initWorkspace(workspaceDir)

  const file = args?.file || ''
  if (!file) {
    return { error: 'missing_parameter', message: 'file is required', suggestion: 'Provide a file path relative to workspace_dir (e.g. "src/auth.py")' }
  }
  // r11：绝对路径归一化（resolveFileArg 共享守卫：绝对→相对、目录/不存在→结构化错误）——
  // 旧实现直接用原始 file：绝对路径时 staleness/getFileOutline 查不到（db 存相对路径）→ 恒 not_indexed
  const resolved = codeIndexService?.resolveFileArg?.(file)
  const normFile = resolved?.ok ? resolved.path : file
  if (resolved && !resolved.ok) {
    return { error: resolved.error.code, message: resolved.error.message, suggestion: resolved.error.suggestion }
  }
  // r54(P0-1): staleness/indexFile 前必须先校验——否则 `../` 经 checkFileStaleness 自动索引逃逸 workspace
  const v = validateFilePath(normFile, workspaceDir)
  if (v.blocked) {
    return { error: 'PATH_BLOCKED', message: `file blocked: ${v.detail}`, suggestion: 'Provide a file path inside workspace_dir (no "..", no absolute paths outside workspace)' }
  }
  // r9(B1)：读侧 realpath 守卫——链接名绕过防护（.env 等敏感文件被 symlink 别名索引进库 → 符号/内容回显给 LLM）
  const guardR = guardReadPath(workspaceDir, normFile)
  if (guardR.blocked) {
    return { error: 'PATH_BLOCKED', message: guardR.detail, suggestion: 'Path resolves outside workspace or to a protected file via symlink' }
  }

  const opts = {}
  if (args?.depth !== undefined) { const d = parseInt(args.depth); opts.depth = Number.isNaN(d) ? 1 : Math.max(0, Math.min(d, 10)) }
  if (args?.include_refs) opts.includeRefs = true
  if (args?.include_test_refs) opts.includeTestRefs = true
  if (args?.max_items) { const m = parseInt(args.max_items); opts.maxItems = Number.isNaN(m) ? 50 : Math.max(1, m) }

  // R19-②：保鲜由 getFileOutline 内部 ensureFreshFile 统一承担
  let result = await codeIndexService.getFileOutline(normFile, opts)
  if ((result?.error === 'file_not_found' || result?.error === 'not_indexed_yet') && (await ensureIndexed(codeIndexService, workspaceDir, normFile))) {
    result = await codeIndexService.getFileOutline(normFile, opts)
    if (result && !result.error) result.auto_indexed = true
  }
  if (result && !result.error) {
    const firstSymbol = result?.outline?.[0]?.name || result?.symbols?.[0]?.name || result?.functions?.[0]?.name || 'symbol'
    result.next_step = `Before editing, check callers: impact_analysis(file="${normFile}", symbol="${firstSymbol}")`
  }
  return attachStalenessWarning(result, result?.freshness)
}
