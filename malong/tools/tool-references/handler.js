// 六合工具集 — references handler

import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { isConstantName } from '../misuse-helpers.js'

function detectMisuse(symbol) {
  if (!symbol) return null
  if (isConstantName(symbol)) {
    return {
      warning: 'likely_wrong_tool',
      suggestion: `"${symbol}" looks like a constant. For tracing its value and finding hardcoded copies, use trace_symbol(symbol="${symbol}").`
    }
  }
  return null
}

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

  const symbol = args?.symbol || ''
  if (!symbol) {
    return { error: 'missing_parameter', message: 'symbol is required', suggestion: 'Provide a symbol name / call target to find references for' }
  }

  const misuseWarning = detectMisuse(symbol)

  // 16：file 参数共用守卫——无效（目录/绝对路径/不存在）时返回结构化错误，绝不静默
  let fileArg = args?.file
  if (fileArg && codeIndexService?.resolveFileArg) {
    // R22-④（审核修复）：resolveFileArg 前先保鲜（ensureFreshFile 自动重抽）——
    // 未索引文件在此补齐，避免 FILE_NOT_INDEXED 死胡同建议（重试不触发任何索引）；
    // 排除文件（.malongignore）保鲜无效 → 走 resolveFileArg 结构化错误（suggestion 已改准确）
    if (codeIndexService?.ensureFreshFile) {
      try { await codeIndexService.ensureFreshFile(fileArg) } catch {}
    }
    const resolved = codeIndexService.resolveFileArg(fileArg)
    if (!resolved.ok) return { error: resolved.error.code, message: resolved.error.message, suggestion: resolved.error.suggestion, workspace_dir: workspaceDir }
    fileArg = resolved.path
  }

  let results = await codeIndexService.getReferences(symbol, fileArg)
  // R17-1（审核透出修复）：服务层在数组上挂 truncated 属性，JSON 序列化会丢——handler 显式透出到结果对象
  // （后续 kind 过滤/next_step 逻辑不动——truncated 标记独立保留）
  const refsTruncated = Array.isArray(results) && results.truncated === true
  const result = { symbol, results, count: results.length, workspace_dir: workspaceDir }
  if (refsTruncated) result.truncated = true
  // R19-②：服务层 freshness（getReferences 有 filePath 时数组挂属性）——JSON 序列化会丢，显式透出
  if (Array.isArray(results) && results.freshness) result.auto_indexed = true
  // Y002-S4：kind 过滤（call/import/use/assign/extends/implements 及逗号组合）——
  // 通用名噪声治理（搜 `get` 曾返回 14 条混杂引用）
  if (args?.kind) {
    const validKinds = new Set(['call', 'import', 'use', 'assign', 'extends', 'implements'])
    const wanted = String(args.kind).split(',').map(k => k.trim()).filter(k => validKinds.has(k))
    if (wanted.length > 0) {
      const filtered = results.filter(r => wanted.includes(r.kind))
      if (filtered.length < results.length) {
        result.kind_filtered = { requested: wanted, dropped: results.length - filtered.length }
      }
      result.results = filtered
      result.count = filtered.length
    } else if (results.length > 0) {
      result.kind_filter_note = `no valid kind in "${args.kind}"; valid: ${[...validKinds].join(',')}`
    }
  }

  // r52: kind 过滤后必须用过滤后结果判定
  // R22-①（text_fallback 移除）：索引空 = 真无引用或文件未索引——不再做 300 文件上限的静默文本扫描回退
  // （回退的子串匹配假阳性 + 截断漏报比空结果更误导）。R19 保鲜已覆盖未索引文件（ensureFreshFile 自动重抽）。
  if (result.results.length === 0) {
    if (result.kind_filtered) {
      // R22-④（审核修复）：kind 过滤清空结果时权威声明是错误声明（索引里有 N 条其他 kind 的引用）——自相矛盾必须消除
      result.suggestion = `No references match kind="${args.kind}" (${result.kind_filtered.dropped} refs of other kinds in index). Remove the kind filter to see them.`
    } else if (fileArg) {
      // R22-⑤（试用发现）：file 限定空结果时权威声明是误导——符号可能在索引其他文件有引用，只是不在该文件内
      // r59：同响应附带全 workspace 预览（cap 20 + total），省一次往返；全 workspace 也空才维持权威声明
      try {
        const allRefs = await codeIndexService.getReferences(symbol)
        if (Array.isArray(allRefs) && allRefs.length > 0) {
          result.workspace_preview = { total: allRefs.length, results: allRefs.slice(0, 20) }
          result.suggestion = `No references to "${symbol}" in ${fileArg}, but ${allRefs.length} found elsewhere in workspace — see workspace_preview (first 20). Call references(workspace_dir=..., symbol="${symbol}") without file filter for the full list.`
        } else {
          result.suggestion = `No references to "${symbol}" in ${fileArg} nor elsewhere in the workspace index.`
        }
      } catch {
        result.suggestion = `No references to "${symbol}" in ${fileArg}. Remove the file filter to search the whole workspace.`
      }
    } else {
      result.suggestion = `No references in index for "${symbol}". This is authoritative: the symbol is not referenced by indexed code (or the file is not indexed — reindex(workspace_dir="${workspaceDir}") if files were recently added).`
    }
  }
  
  if (misuseWarning) {
    result.misuse_warning = misuseWarning
  }

  if (result.results.length > 0) {
    result.next_step = `For test refs: find_tests(file="${fileArg || ''}")`
  }

  return result
}

