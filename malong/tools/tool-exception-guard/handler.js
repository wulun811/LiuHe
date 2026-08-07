import { join, extname, sep, resolve } from 'node:path'
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
      // r54(P2): 行尾注释内的三引号会误触发状态机（lazy 前缀可从注释内重新锚定）→ 其后 raise 全漏检。
      // 仅当 # 之前无三引号时才认定其后是注释并剥除（# 在三引号内则保留整行，防 `"""a#b"""` 回归）
      let codePart = trimmed
      const hashIdx = trimmed.indexOf('#')
      if (hashIdx >= 0) {
        const beforeHash = trimmed.slice(0, hashIdx)
        if (!beforeHash.includes('"""') && !beforeHash.includes("'''")) codePart = beforeHash
      }
      if (!inString) {
        const open = codePart.match(/(?:[frbu]{0,2})?[^"']*?("""|''')/)?.[1]
        if (open) {
          const rest = codePart.slice(codePart.indexOf(open) + open.length)
          if (!rest.includes(open)) { inString = true; openDelim = open }
          continue
        }
      } else {
        if (codePart.includes(openDelim)) inString = false
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

// 8：Rust panic-family 启发式检查。Rust 无异常层级——错误用 Result/Option + ? 传播，
// panic!/unwrap/expect 用于不可恢复错误。在库/生产代码里滥用是反模式，但在测试/main/
// 文档化不变量里是惯用法。故：跳过测试代码与 fn main，其余报告为 heuristic（指向 clippy 精确 lint）。
function checkRustPanic(content, file) {
  const lines = content.split('\n')
  const issues = []

  // 测试文件（路径）整体跳过
  if (/(^|\/)tests?\//.test(file) || /(^|\/)(test_[^/]+|[^/]+_test)\.rs$/.test(file)) {
    return {
      file, paradigm: 'result', issues: [],
      summary: { panic_family_count: 0, skipped: 'test file' },
      next_step: 'Test file — panic-family calls are idiomatic in tests; no check needed.',
    }
  }

  const braceDelta = (l) => {
    let d = 0, inStr = null
    for (let k = 0; k < l.length; k++) {
      const ch = l[k]
      if (inStr) { if (ch === '\\') { k++; continue } if (ch === inStr) inStr = null; continue }
      if (ch === '"' || ch === "'") { inStr = ch; continue }
      if (ch === '{') d++
      else if (ch === '}') d--
    }
    return d
  }
  const findBlockEnd = (startIdx) => {
    let depth = 0, opened = false
    for (let j = startIdx; j < lines.length; j++) {
      const d = braceDelta(lines[j])
      depth += d
      if (d > 0) opened = true
      if (opened && depth <= 0) return j
    }
    return lines.length - 1
  }
  // 计算跳过的行区间（1-based 闭区间）：#[cfg(test)] mod 块 + fn main 块
  const skipRanges = []
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (/\bfn\s+main\b/.test(trimmed)) {
      skipRanges.push([i + 1, findBlockEnd(i) + 1])
    } else if (/#\[cfg\(test\)\]/.test(trimmed)) {
      let blockStart = i
      for (let j = i; j < Math.min(i + 3, lines.length); j++) {
        if (/\b(mod|fn)\s+\w+/.test(lines[j])) { blockStart = j; break }
      }
      skipRanges.push([blockStart + 1, findBlockEnd(blockStart) + 1])
    }
  }
  const inSkip = (lineNo) => skipRanges.some(([a, b]) => lineNo >= a && lineNo <= b)

  const PANIC_RE = /(?:\b(?:panic|unimplemented|todo)!|\.unwrap\(\)|\.expect\()/
  let count = 0
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1
    if (inSkip(lineNo)) continue
    const line = lines[i].replace(/\/\/.*$/, '')
    const m = PANIC_RE.exec(line)
    if (!m) continue
    count++
    // \b 不能锚 .method（. 与前字符均非词字符无边界）——故宏名带 \b，方法形式不带；call 统一清洗
    const call = m[0].replace(/^\./, '').replace(/[(!].*$/, '')
    issues.push({
      type: 'rust_panic_family',
      line: lineNo,
      call,
      confidence: 'heuristic',
      suggestion: 'In library/production code, prefer returning Result/Option and propagating with ? instead of ' + call,
      note: 'Heuristic: unwrap/expect/panic are idiomatic for documented invariants and non-library code. clippy lints (unwrap_used/expect_used/panic) give precise, configurable detection.',
    })
  }

  return {
    file,
    paradigm: 'result',
    issues,
    summary: { panic_family_count: count, issues_found: issues.length, language_supported: true },
    next_step: issues.length > 0
      ? `Found ${count} panic-family call(s) outside tests/main. Review: propagate errors with Result + ? where appropriate. clippy -W clippy::unwrap_used for precise linting.`
      : 'No panic-family calls outside tests/main. Error handling looks disciplined.',
  }
}

export async function handle(args, context) {
  const { codeIndexService, getWorkspaceDir } = context
  const workspaceDir = args?.workspace_dir

  if (!workspaceDir) {
    return { error: 'missing_parameter', message: 'workspace_dir is required' }
  }

  const file = args?.file
  // R22-⑪（拷打发现）：非字符串 file 让 resolve/join 裸抛——前置类型校验
  if (typeof file !== 'string') {
    return { error: 'invalid_input', message: `file must be a string (got ${typeof file})` }
  }
  if (!file) {
    return { error: 'missing_parameter', message: 'file is required' }
  }

  // r54(P0-4): resolve 归一化——workspaceDir 带尾斜杠时 `ws + sep` = `/ws//` 恒不匹配，合法文件被误判逃逸
  const wsNorm = resolve(workspaceDir)
  const absPath = resolve(wsNorm, file)
  if (!absPath.startsWith(wsNorm + sep)) {
    return { error: 'invalid_input', message: `File escapes workspace: ${file}` }
  }
  if (!existsSync(absPath)) {
    return { error: 'file_not_found', message: `File not found: ${file}` }
  }

  // r54(P1): readFileSync 无 try/catch——目录(EISDIR)/不可读文件裸异常违反错误对象契约
  let content
  try { content = readFileSync(absPath, 'utf-8') } catch (e) {
    return { error: 'file_not_found', message: `Cannot read file: ${file} (${e.code || e.message})` }
  }
  const ext = extname(file)
  const SUPPORTED_EXTS = new Set(['.py', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.rs'])
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

  // 8：Rust 无异常层级（用 Result/panic 范式）——独立的 panic-family 启发式检查，不复用 Python 层级逻辑
  if (ext === '.rs') {
    return checkRustPanic(content, file)
  }

  let hierarchy = Object.create(null)
  // 11#5：异常层级按目标语言同族过滤——旧实现从整库 searchSymbols 收所有 *Error/*Exception 类，
  // Python 测试 fixture（auth.py）与 OLD/ 旧码的异常混进来，再建议给 JS 文件（让 JS 的 throw new Error
  // 改用 Python 的 ValidationError）= 跨语言误报。现：只收同语言族（sameLang）。
  // 注：不按 fixtures/OLD 路径排除——测试常以 fixtures 为工作区根，路径排除会误伤（p2 A8/T2）；
  // 跨语言误报由 sameLang 完整解决即可。
  // r12（隔壁实战教训）：sancai 的 YamlError 被建议给 tongtian——跨语言已修，跨模块没修。
  // 模块边界（inModuleBoundary）：异常类须与目标文件共享目录树（file 目录子树 + 祖先链直接子文件），
  // 同工作区不同子系统的异常不再互相污染。边界内无异常类时回退全库 + hierarchy_scope 标注。
  const JS_EXTS = ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx']
  const isPy = ext === '.py'
  const sameLang = (f) => isPy ? f.endsWith('.py') : JS_EXTS.some(e => f.endsWith(e))
  const normRel = (p) => String(p || '').replace(/\\/g, '/')
  // r12：模块边界——target 的 dirname ∈ {file 的 dirname 子树, 祖先链任意层}
  const inModuleBoundary = (targetRel, fileRel) => {
    const t = normRel(targetRel)
    const f = normRel(fileRel)
    if (!t || !f) return true
    const td = t.slice(0, t.lastIndexOf('/'))
    const fd = f.slice(0, f.lastIndexOf('/'))
    if (!td || !fd) return true
    if (td === fd || td.startsWith(fd + '/')) return true
    let d = fd
    while (d) {
      if (d === td) return true
      d = d.slice(0, d.lastIndexOf('/'))
    }
    return false
  }
  let hierarchyScope = null
  const hierarchyOrigins = []
  const collectHierarchy = (list) => {
    let added = 0
    for (const s of list) {
      // R22-⑪：名字形态过滤——searchSymbols 子串匹配会把 ErrorHandler/errorFactory 等非异常类混入层级（报告 P2）
      if (s.type === 'class' && sameLang(s.file) && /(?:Error|Exception)$/.test(s.name)) {
        if (!inModuleBoundary(s.file, file)) continue
        hierarchy[s.name] = { base: isPy ? 'Exception' : 'Error', module: s.file, file: s.file, line: s.start_line }
        hierarchyOrigins.push(s.file)
        added++
      }
    }
    return added
  }
  if (codeIndexService) {
    const dbPath = join(getWorkspaceDir(workspaceDir), 'code-index.db')
    if (existsSync(dbPath)) {
      try {
        await codeIndexService.initWorkspace(workspaceDir)
        const results = await codeIndexService.searchSymbols('Error')
        const results2 = await codeIndexService.searchSymbols('Exception')
        collectHierarchy([...(results || []), ...(results2 || [])])
        if (Object.keys(hierarchy).length > 0) hierarchyScope = 'module'
      } catch {}
    }
  }

  // r12：walk 收集单次遍历——先按模块边界过滤；边界内无异常类再回退全库（一次遍历两次过滤，避免重复读盘）
  if (Object.keys(hierarchy).length === 0) {
    const walkCollect = () => {
      const found = []
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
          } else if (entry.isFile() && sameLang(full)) {
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
          // 11#5：Python `class X(Base)` vs JS `class X extends Base`；r12: export class 形态（原 ^class 锚定行首永远匹配不到 export class）
          const classRe = isPy ? /^(?:export\s+)?class\s+(\w+)\s*\((\w+)\)/gm : /^(?:export\s+)?class\s+(\w+)\s+extends\s+(\w+)/gm
          let cm
          while ((cm = classRe.exec(c)) !== null) {
            if (/Error|Exception/.test(cm[2])) {
              const relPath = filePath.startsWith(workspaceDir + '/') ? filePath.slice(workspaceDir.length + 1) : filePath
              found.push({ name: cm[1], base: cm[2], relPath, line: c.slice(0, cm.index).split('\n').length })
            }
          }
        } catch {}
      }
      return found
    }
    const applyHierarchy = (found, filter) => {
      for (const f of found) {
        if (filter && !filter(f.relPath)) continue
        hierarchy[f.name] = { base: f.base, module: f.relPath, file: f.relPath, line: f.line }
        hierarchyOrigins.push(f.relPath)
      }
    }
    const found = walkCollect()
    applyHierarchy(found, (rel) => inModuleBoundary(rel, file))
    // r12：边界内无异常类 → 回退全库（行为退化到旧状，但 hierarchy_scope 标注 + 跨模块提示）
    if (Object.keys(hierarchy).length === 0) applyHierarchy(found)
  }
  hierarchyScope = hierarchyScope || (hierarchyOrigins.some(o => inModuleBoundary(o, file)) ? 'module' : 'project')

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
    nextStep = `No raise/throw issues found by pattern check — not a full exception-design review.`
  }

  return {
    file,
    coverage: 'pattern-scan (raise/throw shape + module-scoped hierarchy); exception design/flow NOT covered',
    project_exceptions: hierarchy,
    // r12：hierarchy 收集范围——module=仅目标文件所在模块（同语言同模块）；project=模块内无异常类回退全库（跨模块异常可能混入，需人工甄别）
    hierarchy_scope: hierarchyScope,
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
