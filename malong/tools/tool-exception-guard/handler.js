import { join, extname } from 'node:path'
import { existsSync, readFileSync, readdirSync } from 'node:fs'

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

function checkRaises(content, ext) {
  const raises = []
  const lines = content.split('\n')

  const isPython = ext === '.py'
  const isJS = ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx'].includes(ext)
  let inString = false
  let openDelim = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    let m

    if (isPython) {
      // P2-B3：三引号字符串里的 raise 示例文本不误报（状态机同 guard-patterns）
      const trimmed = line.trim()
      if (trimmed.startsWith('#')) continue
      if (!inString) {
        const open = trimmed.match(/(?:[frbu]{0,2})?[^"'#]*?("""|''')/)?.[1]
        if (open) {
          const rest = trimmed.slice(trimmed.indexOf(open) + open.length)
          if (!rest.includes(open)) { inString = true; openDelim = open }
          continue
        }
      } else {
        if (trimmed.includes(openDelim)) inString = false
        continue
      }
      m = /^\s*raise\s+(\w+)/.exec(line)
      if (m) {
        let fullLine = line
        let j = i
        while (!fullLine.includes(')') && fullLine.includes('(') && j < lines.length - 1) {
          j++
          fullLine += ' ' + lines[j].trim()
        }
        const msgM = /\(\s*["'](.+?)["']\s*\)/.exec(fullLine)
        raises.push({ line: i + 1, exception: m[1], message: msgM ? msgM[1] : null, raw: line.trim() })
      }
    } else if (isJS) {
      m = /throw\s+new\s+(\w+)(?:\s*\(\s*["'`](.+?)["'`]\s*\))?/.exec(line)
      if (m) {
        raises.push({ line: i + 1, exception: m[1], message: m[2] || null, raw: line.trim() })
      }
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
  const SUPPORTED_EXTS = new Set(['.py', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx'])
  const languageSupported = SUPPORTED_EXTS.has(ext)
  if (!languageSupported) {
    return {
      file,
      error: 'unsupported_language',
      message: `exception_guard 仅支持 Python/JS/TS，不支持 ${ext} 文件（跳过检查，不误报）`,
      project_exceptions: {},
      issues: [],
      summary: {
        raises_checked: 0,
        issues_found: 0,
        project_exception_count: 0,
        builtin_usage_ratio: 0,
        language_supported: false,
      },
      next_step: `Use exception_guard on a .py/.js/.ts file instead`,
    }
  }

  let hierarchy = Object.create(null)
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

  if (Object.keys(hierarchy).length === 0) {
    try {
      const dirs = []
      const walkDir = (dir, depth) => {
        if (depth > 3) return
        let entries
        try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
        for (const entry of entries) {
          if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '__pycache__' || entry.name === 'venv' || entry.name === 'dist' || entry.name === 'build') continue
          const full = join(dir, entry.name)
          if (entry.isDirectory()) {
            walkDir(full, depth + 1)
          } else if (entry.isFile() && entry.name.endsWith('.py')) {
            dirs.push(full)
          }
        }
      }
      walkDir(workspaceDir, 0)
      const srcDir = join(workspaceDir, 'src')
      if (srcDir !== workspaceDir) walkDir(srcDir, 0)
      for (const filePath of dirs) {
        try {
          const c = readFileSync(filePath, 'utf-8')
          const classRe = /^class\s+(\w+)\s*\((\w+)\)/gm
          let cm
          while ((cm = classRe.exec(c)) !== null) {
            if (/Error|Exception/.test(cm[2])) {
              const relPath = filePath.startsWith(workspaceDir + '/') ? filePath.slice(workspaceDir.length + 1) : filePath
              hierarchy[cm[1]] = { base: cm[2], module: relPath, file: relPath, line: c.slice(0, cm.index).split('\n').length }
            }
          }
        } catch {}
      }
    } catch {}
  }

  const raises = checkRaises(content, ext)
  const issues = []
  const projectExcNames = Object.keys(hierarchy)

  for (const r of raises) {
    if (!BUILTIN_EXCEPTIONS.has(r.exception)) continue
    // P2-B3：项目无自定义异常时不再静默跳过 —— 在 warnings 里说明检查被跳过，
    // 避免「Exception usage is clean」的虚假结论
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

  let nextStep = null
  if (issues.length > 0) {
    nextStep = `Fix issues via edit_transaction, then verify: test_bridge(action="run")`
  } else if (projectExcNames.length === 0 && raises.some(r => BUILTIN_EXCEPTIONS.has(r.exception))) {
    nextStep = `Project has no custom exceptions — builtin-usage check skipped (raise statements found: ${raises.length}).`
  } else {
    nextStep = `Exception usage is clean.`
  }

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
    next_step: nextStep,
  }
}
