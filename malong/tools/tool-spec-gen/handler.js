// spec_gen — 从代码符号生成模块/API 规范（B13 缺口六）
// 基于 code-index 符号表：exports（顶层 function/class/const + 类方法）+ 参数启发式解析 +
// 调用示例（references 计数）。0% LLM。工具内返回错误对象，不 throw。

import { join, sep, resolve } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'

function traceId() {
  return `trc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function makeError(code, message, suggestion) {
  return { error: code, message, ...(suggestion ? { suggestion } : {}), trace_id: traceId() }
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// 参数启发式：从签名行解析参数名（无 AST 依赖，够用；兼容 Python def / JS function / 类方法）
// R22-⑪：旧 parseParams 只认 `function 名(`——Python/Go/JS 方法 params 恒空（spec 谎报无参数）
function parseParamsFromLine(line, name) {
  const re = new RegExp(`(?:def\\s+|async\\s+def\\s+|function\\s+|async\\s+function\\s+)?${escapeRegex(name)}\\s*\\(([^)]*)\\)`)
  const m = line.match(re)
  if (!m) return []
  return m[1].split(',').map(s => s.trim()).filter(s => s)
    .map(s => s.split('=')[0].trim().replace(/^\.\.\./, ''))
    .map(s => s.replace(/\s*:\s*[^,=]+$/, '').trim())
    .map(s => s.replace(/[{}\[\]]/g, '').trim())
    .filter(s => s)
}

const EXPORT_KINDS = ['function', 'class', 'method', 'variable', 'const', 'let', 'var']

// R22-⑪：旧实现只 filter 顶层 items——类的方法在 outline.children 里从不展开（Python 类 0 方法）；递归收集
function collectExports(items, sourceLines, out) {
  for (const s of items) {
    if (EXPORT_KINDS.includes(s.type)) {
      const entry = { name: s.name, kind: s.type, line: s.start_line }
      if (s.type === 'function' || s.type === 'method') {
        // 优先索引侧 signature（真实签名）；缺失时按 start_line 读源码行
        entry.params = (s.signature && s.signature.includes('('))
          ? parseParamsFromLine(s.signature, s.name)
          : parseParamsFromLine(sourceLines[s.start_line - 1] || '', s.name)
      }
      if (s.ref_count !== undefined) entry.usage_count = s.ref_count
      out.push(entry)
    }
    if (s.type === 'class' && Array.isArray(s.children) && s.children.length > 0) {
      collectExports(s.children, sourceLines, out)
    }
  }
}

export async function handle(args, context) {
  const { codeIndexService, getWorkspaceDir } = context
  const workspaceDir = args?.workspace_dir
  const file = args?.file
  if (!workspaceDir) {
    return makeError('missing_parameter', 'workspace_dir is required', 'Provide the absolute path to the project root directory.')
  }
  // R22-⑯：非字符串 workspace_dir 让 getWorkspaceDir→resolve 裸抛 TypeError
  if (typeof workspaceDir !== 'string') {
    return makeError('invalid_input', `workspace_dir must be a string (got ${typeof workspaceDir})`, 'Provide a valid workspace directory path.')
  }
  if (!file) {
    return makeError('missing_parameter', 'file is required', 'Provide a file path relative to workspace_dir.')
  }
  // R22-⑯：非字符串 file 让 resolve 裸抛 TypeError
  if (typeof file !== 'string') {
    return makeError('invalid_input', `file must be a string (got ${typeof file})`, 'Provide a valid file path.')
  }
  const dbPath = join(getWorkspaceDir(workspaceDir), 'code-index.db')
  if (!existsSync(dbPath)) {
    return makeError('workspace_not_indexed', `Workspace not indexed: ${workspaceDir}`, `Call reindex(workspace_dir="${workspaceDir}") first`)
  }
  if (!codeIndexService?.getFileOutline) {
    return makeError('service_unavailable', 'codeIndex service not available', 'Check MCP server configuration and ensure code-index.js is loaded')
  }

  // R22-⑯：initWorkspace 异常不透出崩溃——抄 inspect/code-search 的 try/catch 模式
  try { await codeIndexService.initWorkspace(workspaceDir) } catch {}
  // r52: 源码必须从真实 workspace 读——getWorkspaceDir 沙箱目录只含 code-index.db，此前 params 恒空（parseParams 对空 source 返回 []）
  // r54(P0-4): resolve 归一化——workspaceDir 带尾斜杠时 `ws + sep` = `/ws//` 恒不匹配，合法文件被误判逃逸
  const wsNorm = resolve(workspaceDir)
  const absPath = resolve(wsNorm, file)
  if (!absPath.startsWith(wsNorm + sep)) {
    return makeError('invalid_input', `File escapes workspace: ${file}`)
  }
  let source = ''
  try { source = readFileSync(absPath, 'utf-8') } catch (e) {
    // r11(L2)：读失败不静默——旧 catch{} 后 params 全空且无提示（LLM 以为模块无参数）
    if (!existsSync(absPath)) {
      return makeError('file_not_found', `File not found: ${file}`, 'Provide an existing file path relative to workspace_dir.')
    }
    return makeError('read_failed', `Failed to read ${file}: ${e.message}`, 'Check file permissions and retry.')
  }

  try {
    const outline = await codeIndexService.getFileOutline(file, { depth: 1, includeRefs: true, includeTestRefs: false, maxItems: 0 })
    const items = outline?.outline || []
    const sourceLines = source.split('\n')
    const exports = []
    collectExports(items, sourceLines, exports)
    return {
      file,
      spec: {
        exports,
        export_count: exports.length,
        examples: exports.slice(0, 3).map(e => ({
          name: e.name,
          kind: e.kind,
          snippet: (e.kind === 'function' || e.kind === 'method') && e.params?.length
            ? `${e.name}(${e.params.join(', ')})`
            : (e.kind === 'function' || e.kind === 'method') ? `${e.name}()` : `${e.name}`,
        })),
      },
      next_step: exports.length > 0 ? 'To document behavior, read_symbol(file=..., name=...) per export.' : 'No top-level exports found.',
    }
  } catch (e) {
    return makeError('spec_failed', `Spec generation failed: ${e.message}`, 'Ensure the workspace is indexed.')
  }
}
