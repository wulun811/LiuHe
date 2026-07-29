import { join, extname } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'

const BUILTIN_EXCEPTIONS = new Set([
  'Exception', 'BaseException', 'ValueError', 'TypeError', 'KeyError', 'IndexError',
  'AttributeError', 'RuntimeError', 'IOError', 'OSError', 'FileNotFoundError',
  'ImportError', 'ModuleNotFoundError', 'StopIteration', 'GeneratorExit',
  'SystemExit', 'KeyboardInterrupt', 'AssertionError', 'NameError', 'SyntaxError',
  'ZeroDivisionError', 'OverflowError', 'NotImplementedError', 'RecursionError',
  'Error', 'ReferenceError', 'RangeError', 'URIError', 'EvalError',
])

const EXCEPTION_PATTERNS = {
  not_found: ['not found', '不存在', 'missing', 'no such', 'does not exist', '未找到'],
  validation: ['invalid', '格式错误', '验证失败', 'must be', 'required', '不能为空', 'malformed'],
  auth: ['未授权', 'unauthorized', '权限', 'forbidden', '认证', 'permission', 'denied'],
  rate_limit: ['rate limit', '频率', 'too many', '限流', 'throttl'],
}

const NAME_MAP = {
  not_found: ['NotFoundError', 'NotFoundException', 'NotFound'],
  validation: ['ValidationError', 'ValidationException', 'InvalidInputError'],
  auth: ['AuthError', 'AuthException', 'AuthenticationError', 'PermissionError'],
  rate_limit: ['RateLimitError', 'RateLimitException', 'TooManyRequestsError'],
}

function classifyMessage(message) {
  const lower = (message || '').toLowerCase()
  for (const [category, patterns] of Object.entries(EXCEPTION_PATTERNS)) {
    if (patterns.some(p => lower.includes(p))) return category
  }
  return 'unknown'
}

function extractExceptionHierarchy(codeIndexService) {
  if (!codeIndexService) return {}
  try {
    const errorSyms = codeIndexService.searchSymbolsSync?.('Error') || []
    const excSyms = codeIndexService.searchSymbolsSync?.('Exception') || []
    const hierarchy = {}
    for (const s of [...errorSyms, ...excSyms]) {
      if (s.type === 'class') {
        hierarchy[s.name] = { base: 'Exception', module: s.file, file: s.file, line: s.start_line }
      }
    }
    return hierarchy
  } catch { return {} }
}

function checkRaises(content, ext) {
  const raises = []
  const lines = content.split('\n')

  const isPython = ext === '.py'
  const isJS = ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx'].includes(ext)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    let m

    if (isPython) {
      m = /^\s*raise\s+(\w+)(?:\s*\(\s*["'](.+?)["']\s*\))?/.exec(line)
    } else if (isJS) {
      m = /throw\s+new\s+(\w+)(?:\s*\(\s*["'`](.+?)["'`]\s*\))?/.exec(line)
    }

    if (m) {
      raises.push({ line: i + 1, exception: m[1], message: m[2] || null, raw: line.trim() })
    }
  }
  return raises
}

export async function handle(args, context) {
  const { codeIndexService, getWorkspaceDir } = context
  const workspaceDir = args?.workspace_dir

  if (!workspaceDir) {
    return { error: 'missing_parameter', message: 'workspace_dir is required' }
  }

  const file = args?.file
  if (!file) {
    return { error: 'missing_parameter', message: 'file is required' }
  }

  const absPath = join(workspaceDir, file)
  if (!existsSync(absPath)) {
    return { error: 'file_not_found', message: `File not found: ${file}` }
  }

  const content = readFileSync(absPath, 'utf-8')
  const ext = extname(file)

  let hierarchy = {}
  if (codeIndexService) {
    const dbPath = join(getWorkspaceDir(workspaceDir), 'code-index.db')
    if (existsSync(dbPath)) {
      try {
        codeIndexService.initWorkspace(workspaceDir)
        const results = await codeIndexService.searchSymbols('Error')
        const results2 = await codeIndexService.searchSymbols('Exception')
        for (const s of [...(results || []), ...(results2 || [])]) {
          if (s.type === 'class') {
            hierarchy[s.name] = { base: 'Exception', module: s.file, file: s.file, line: s.start_line }
          }
        }
      } catch {}
    }
  }

  const raises = checkRaises(content, ext)
  const issues = []
  const projectExcNames = Object.keys(hierarchy)

  for (const r of raises) {
    if (!BUILTIN_EXCEPTIONS.has(r.exception)) continue
    if (projectExcNames.length === 0) continue

    const category = classifyMessage(r.message)
    let suggested = null

    if (category !== 'unknown') {
      const candidates = NAME_MAP[category] || []
      suggested = candidates.find(c => hierarchy[c]) || null
    }

    if (suggested) {
      issues.push({
        type: 'wrong_exception',
        line: r.line,
        raised: r.exception,
        message: r.message,
        suggestion: `raise ${suggested}('${r.message || '...'}')`,
        reason: `项目中 '${category}' 场景用 ${suggested}`,
      })
    } else {
      issues.push({
        type: 'builtin_exception',
        line: r.line,
        raised: r.exception,
        message: r.message,
        suggestion: `use a specific project exception (${projectExcNames.slice(0, 5).join(', ')})`,
        reason: `项目有 ${projectExcNames.length} 个自定义异常`,
      })
    }
  }

  const builtinCount = raises.filter(r => BUILTIN_EXCEPTIONS.has(r.exception)).length
  const customCount = raises.filter(r => !BUILTIN_EXCEPTIONS.has(r.exception)).length

  return {
    file,
    project_exceptions: hierarchy,
    issues,
    summary: {
      raises_checked: raises.length,
      issues_found: issues.length,
      project_exception_count: projectExcNames.length,
      builtin_usage_ratio: raises.length > 0 ? Math.round(builtinCount / raises.length * 100) / 100 : 0,
    },
  }
}
