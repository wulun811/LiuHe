// code_search — 意图分类多路融合搜索（B13 缺口五）
// 复用 code-search.js 的 search 服务（9 意图 + 符号/文件/调用链融合 + 排序）。
// 工具内返回错误对象，不 throw。

import { join } from 'node:path'
import { existsSync } from 'node:fs'

function traceId() {
  return `trc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function makeError(code, message, suggestion) {
  return { error: code, message, ...(suggestion ? { suggestion } : {}), trace_id: traceId() }
}

export async function handle(args, context) {
  const { codeSearchService, codeIndexService, getWorkspaceDir } = context
  const workspaceDir = args?.workspace_dir
  const query = args?.query
  if (!workspaceDir) {
    return makeError('missing_parameter', 'workspace_dir is required', 'Provide the absolute path to the project root directory.')
  }
  // R22-⑯：非字符串 workspace_dir 让 getWorkspaceDir→resolve 裸抛 TypeError
  if (typeof workspaceDir !== 'string') {
    return makeError('invalid_input', `workspace_dir must be a string (got ${typeof workspaceDir})`, 'Provide a valid workspace directory path.')
  }
  if (!query || typeof query !== 'string') {
    return makeError('missing_parameter', 'query is required', 'Provide a natural-language or symbol query.')
  }

  const dbPath = join(getWorkspaceDir(workspaceDir), 'code-index.db')
  if (!existsSync(dbPath)) {
    return makeError('workspace_not_indexed', `Workspace not indexed: ${workspaceDir}`, `Call reindex(workspace_dir="${workspaceDir}") first`)
  }
  if (!codeSearchService?.search) {
    return makeError('service_unavailable', 'codeSearch service not available', 'Check MCP server configuration and ensure code-search.js is loaded')
  }
  // r47: codeIndex 连接是懒初始化（MCP 进程重启后 _db=null，db 文件残留 ≠ 连接已打开）——
  // 不 ensure 则 self._db.prepare 抛错被 search 内部 catch 吞掉 → 恒 0 命中（实测：重启后直接搜 0，reindex 后立即命中）
  let initWarning = null
  if (codeIndexService?.initWorkspace) {
    // R22-⑰（第四轮审核 P1）：initWorkspace 失败不再静默——否则 DB 损坏/连接失败时用户只看到 0 matches
    try {
      await codeIndexService.initWorkspace(workspaceDir)
    } catch (e) {
      initWarning = `initWorkspace failed: ${e?.message || String(e)}`
    }
  }

  const limit = Math.max(1, Math.min(50, parseInt(args?.limit) || 10))
  try {
    const r = await codeSearchService.search(query, { topK: limit })
    return {
      query: r.query,
      intent: r.intent,
      results: r.results.slice(0, limit),
      count: r.results.length,
      summary: `${r.results.length} matches found`,
      ...(initWarning ? { init_warning: initWarning } : {}),
      next_step: r.results.length > 0
        ? 'To inspect a hit: read_symbol(file=..., name=...) or references(symbol=...)'
        : 'No matches. Try references(symbol=...) or reindex if the workspace changed.',
    }
  } catch (e) {
    return makeError('search_failed', `Search failed: ${e.message}${initWarning ? ` (${initWarning})` : ''}`, 'Ensure the workspace is indexed.')
  }
}
