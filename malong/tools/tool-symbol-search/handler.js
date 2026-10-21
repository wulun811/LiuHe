// 六合工具集 — symbol_search handler

import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { parseMalongignore } from '../../file-collector.js'

export async function handle(args, context) {
  const { codeIndexService, getWorkspaceDir } = context
  const workspaceDir = args?.workspace_dir

  if (typeof workspaceDir !== 'string' || !workspaceDir) {
    return { error: 'missing_parameter', message: 'workspace_dir is required', suggestion: 'Provide the absolute path to the project root directory. Call reindex first if this is a new workspace.' }
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

  if (!codeIndexService) {
    return { error: 'service_unavailable', message: 'codeIndex service not available', suggestion: 'Check MCP server configuration and ensure code-index.js is loaded' }
  }

  // 初始化 workspace 数据库
  await codeIndexService.initWorkspace(workspaceDir)

  const query = args?.query || ''
  // 第二轮审查：非串 query 不得进入 LIKE/正则路径（{} 裸抛）
  if (args?.query != null && typeof args.query !== 'string') {
    return { error: 'invalid_input', message: `query must be a string (got ${typeof args.query})`, suggestion: 'Provide a symbol name substring.' }
  }
  // P2-B2：limit 负值 → SQL LIMIT -1 返回全表（几万条全量返回）；钳制到 [1, 500]
  const rawLimit = parseInt(args?.limit)
  const limit = Number.isNaN(rawLimit) ? 30 : Math.min(500, Math.max(1, rawLimit))

  if (!query) {
    return { error: 'missing_parameter', message: 'query is required', suggestion: 'Provide a symbol name substring to search' }
  }

  // R22-⑪：staleness 前置——搜索前先保鲜结果文件（与 references ensureFreshFile 同模式；mtime 未变时廉价）
  // 保鲜可能重索引符号，之后重查一次确保结果反映最新磁盘
  let results = await codeIndexService.searchSymbols(query, { limit })
  if (codeIndexService?.ensureFreshFile && results.length > 0) {
    // R22-⑰（第四轮审核 P1）：去重后再保鲜——同文件多结果（如类方法群）时避免 N 次冗余 statSync/realpath
    const uniqueFiles = [...new Set(results.map(r => r.file))]
    await Promise.allSettled(uniqueFiles.map(f => codeIndexService.ensureFreshFile(f)))
    results = await codeIndexService.searchSymbols(query, { limit })
  }
  // dogfood-050（P1 + 防抖窗口补强）：陈旧索引自愈——
  // 旧实现只在有结果时对结果文件保鲜：① 零命中假空自锁；② watcher 防抖窗口内查询有命中但漏新结果。
  // 统一：有界刷新陈旧文件（refreshStaleFiles）后重查一次（有命中时同样兜底）。
  let refreshedStale = 0
  if (typeof codeIndexService?.refreshStaleFiles === 'function') {
    try {
      const info = await codeIndexService.refreshStaleFiles()
      refreshedStale = info?.refreshed || 0
      if (refreshedStale > 0) results = await codeIndexService.searchSymbols(query, { limit })
    } catch {}
  }
  const res = { results, count: results.length, query, workspace_dir: workspaceDir }
  if (refreshedStale > 0) res.refreshed_stale = refreshedStale
  if (query.length === 1) {
    res.warning = 'single_char_query'
    res.suggestion = `Single-character query "${query}" is very broad. Use a longer substring for more targeted results.`
  }
  if (results.length === 0) {
    // 空结果主因是查询词不匹配（ASCII 大小写不敏感，实为 SQLite LIKE）而非索引过期——staleness 已由上方 ensureFreshFile 前置保鲜。
    // 旧实现无条件建议 reindex，agent 在 fresh 索引上会照做白烧一轮全量重抽。
    res.suggestion = refreshedStale > 0
      ? `No symbols match "${query}" after refreshing ${refreshedStale} stale file(s) — the index is up to date for the scanned files. Try a different casing or a shorter substring.`
      : `No symbols match "${query}". Matching is ASCII case-insensitive (SQLite LIKE); non-ASCII is case-sensitive: try a shorter substring or another case. Only call reindex(workspace_dir="${workspaceDir}") if files were recently added.`
    // R2：工作区有 .malongignore 时提示“排除文件不可搜”——避免零命中误判为拼写问题
    try {
      const rules = parseMalongignore(join(workspaceDir, '.malongignore'))
      if (rules.length) res.suggestion += ` This workspace has .malongignore (${rules.length} rule(s)); excluded files are not searchable here — pass an explicit target to code_task to cover them.`
    } catch {}
    res.next_step = 'Try a shorter or differently-cased substring, or use code_search with a natural-language query.'
  } else {
    const top = results[0]
    // H05（0.5.14）：建议动作给完整可执行参数（mode=impact 需 file；缺 file 的示例会被拒）
    res.next_step = 'Before modifying found symbols, check blast radius: code_query(mode="impact", workspace_dir="' + workspaceDir + '", file="' + (top.file || top.path || '') + '", symbol="' + top.name + '")'
  }
  return res
}
