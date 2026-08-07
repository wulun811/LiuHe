// patch_parser — SEARCH/REPLACE 补丁解析/应用（B13 缺口二）
// 复用 patch-parser.js（r34 深度修复）的 parseBlocks/applyBlocks，纯计算无文件 IO（file 可选）。
// 工具内返回错误对象，不 throw。

import { readFileSync } from 'node:fs'
import { join, relative, isAbsolute } from 'node:path'
import { parseBlocks, applyBlocks } from '../../patch-parser.js'

// r41: file 模式必须真实文件系统（getWorkspaceDir 沙箱映射只有索引 db，读不到真实文件）
function isInsideWorkspace(ws, abs) {
  const rel = relative(ws, abs)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function traceId() {
  return `trc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function makeError(code, message, suggestion) {
  return { error: code, message, ...(suggestion ? { suggestion } : {}), trace_id: traceId() }
}

export async function handle(args, context) {
  const { getWorkspaceDir } = context
  const workspaceDir = args?.workspace_dir
  const text = args?.text
  if (!workspaceDir) {
    return makeError('missing_parameter', 'workspace_dir is required', 'Provide the absolute path to the project root directory.')
  }
  if (!text || typeof text !== 'string') {
    return makeError('missing_parameter', 'text is required', 'Provide LLM output containing SEARCH/REPLACE blocks.')
  }

  let blocks = []
  try {
    blocks = parseBlocks(text)
  } catch (e) {
    return makeError('parse_failed', `Failed to parse patch blocks: ${e.message}`, 'Check the patch format (```patch / <<<<<<< SEARCH).')
  }
  const result = {
    blocks: blocks.map((b, i) => ({
      index: i,
      old_string: b.search,
      new_string: b.replace,
      insert_only: !b.search.trim(),
    })),
    block_count: blocks.length,
    parse_errors: [],
  }
  // R22-⑦（拷打发现）：未闭合 block（patch 在 >>>>>>> REPLACE 前截断）旧实现静默 break 丢弃——LLM 截断输出时用户看到的是"解析成功"假象；显式标注
  if (blocks.unclosed === true) {
    result.parse_errors.push('unclosed_block: patch ends before >>>>>>> REPLACE (truncated output?) — parsed blocks may be incomplete')
  }
  if (blocks.length === 0 && /<<<<<<< SEARCH/.test(text) === false) {
    result.note = 'no SEARCH/REPLACE markers found — nothing to apply'
  }

  if (args?.file) {
    // r43: 非字符串 file 会让 join() 抛 TypeError（r23-fix3 同教训）——先返回错误对象
    if (typeof args.file !== 'string') {
      return makeError('invalid_input', 'file must be a string', 'Provide a file path relative to workspace_dir.')
    }
    const fileAbs = join(workspaceDir, args.file)
    if (!isInsideWorkspace(workspaceDir, fileAbs)) {
      return makeError('path_blocked', `file escapes workspace: ${fileAbs}`, 'Provide a file path relative to workspace_dir.')
    }
    let content
    try {
      content = readFileSync(fileAbs, 'utf-8')
    } catch {
      return makeError('file_not_found', `File not found: ${args.file}`, 'Provide a file path relative to workspace_dir that exists.')
    }
    const applied = applyBlocks(content, blocks)
    result.file = args.file
    result.applied = applied.applied.length
    result.applied_blocks = applied.applied
    // r43: 死逻辑清理——blocks.indexOf(e) 对对象引用比较恒 -1，结果恒等于 i，直接取 i
    result.errors = applied.errors.map((e, i) => ({ index: i, message: e.error }))
    result.dry_run = true
    result.diff_preview = applied.applied.length > 0
  }

  return result
}
