import { join, extname, sep } from 'node:path'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { ErrorCodes, makeError, validateFilePath } from '../../error-codes.js'

const BUILTIN_RULES = [
  { id: 'no-bare-except', type: 'except_bare', severity: 'warning', message: 'bare except: catches all exceptions including SystemExit/KeyboardInterrupt', suggestion: 'use except AppException: or except (TypeError, ValueError):' },
  { id: 'no-debugger', type: 'call_banned', severity: 'error', banned: ['debugger', 'pdb.set_trace', 'breakpoint'], message: 'debugger breakpoint left in code', suggestion: 'remove before committing' },
  { id: 'no-eval', type: 'call_banned', severity: 'error', banned: ['eval', 'exec'], message: 'eval/exec is a security risk', suggestion: 'use ast.literal_eval or a safe parser' },
]

function loadProjectRules(workspaceDir, rulesetPath) {
  const path = rulesetPath ? join(workspaceDir, rulesetPath) : join(workspaceDir, '.ai-patterns.json')
  if (rulesetPath) {
    const pathCheck = validateFilePath(rulesetPath)
    if (pathCheck.blocked) return { rules: [], warnings: [{ reason: 'path_blocked', detail: pathCheck.detail }] }
  }
  if (!existsSync(path)) return { rules: [], warnings: [] }
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'))
    if (!data.rules || !Array.isArray(data.rules)) {
      return { rules: [], warnings: [{ reason: 'invalid_schema', detail: '.ai-patterns.json must have a "rules" array' }] }
    }
    const valid = []
    const warnings = []
    for (const rule of data.rules) {
      if (!rule.id || !rule.type) {
        warnings.push({ reason: 'schema_invalid', detail: `rule missing id or type: ${JSON.stringify(rule).slice(0, 80)}` })
        continue
      }
      valid.push(rule)
    }
    return { rules: valid, warnings }
  } catch (e) {
    return { rules: [], warnings: [{ reason: 'parse_failed', detail: e.message }] }
  }
}

function mkViolation(rule, location) {
  return {
    rule: rule.id,
    severity: rule.severity || 'warning',
    location,
    message: rule.message,
    ...(rule.suggestion ? { suggestion: rule.suggestion } : {}),
  }
}

// R22-⑪：三引号打开判定——逐字符扫描，单/双引号单字符串内的 `"""`/`'''` 跳过不打开
//（旧 regex `[^"']*?("""|''')` 会被 `x = '"""'` 内嵌三连污染 → 状态机错开 → 裸 except 漏报）
function tripleOpenIndex(line) {
  const n = line.length
  let i = 0
  while (i < n) {
    const ch = line[i]
    if (ch === '\\') { i += 2; continue }
    if ((ch === '"' && line[i + 1] === '"' && line[i + 2] === '"') || (ch === "'" && line[i + 1] === "'" && line[i + 2] === "'")) return i
    if (ch === '"' || ch === "'") {
      const q = ch
      i++
      while (i < n) {
        if (line[i] === '\\') { i += 2; continue }
        if (line[i] === q) break
        i++
      }
      i++
      continue
    }
    i++
  }
  return -1
}

function matchesPrefix(name, prefixes) {
  if (!prefixes || !prefixes.length) return true
  return prefixes.some(p => name.startsWith(p))
}

async function checkRules(file, content, rules, langParser) {
  const ext = extname(file)
  // R22-⑪：空/纯空白文件不该报 unsupported_language（parse 空串无符号是预期，不是语言不支持）
  if (!String(content).trim()) return { violations: [], warnings: [] }
  let refs = [], symbols = []
  try {
    const result = await langParser.extractAllAsync(content, ext)
    refs = result.refs || []
    symbols = result.symbols || []
  } catch (e) {
    return { violations: [], warnings: [{ file, reason: `parse_failed: ${e.message}` }] }
  }
  if (!refs.length && !symbols.length) return { violations: [], warnings: [{ file, reason: 'unsupported_language' }] }

  const violations = []
  const warnings = []

  for (const rule of rules) {
    if (rule._comment) continue
    try {
      switch (rule.type) {
        case 'decorator_required': {
          for (const func of symbols.filter(s => ['function', 'method'].includes(s.type))) {
            if (!matchesPrefix(func.name, rule.match?.function_prefix)) continue
            if (!func.decorators?.includes(rule.decorator)) {
              violations.push(mkViolation(rule, { function: func.name, line: func.startLine }))
            }
          }
          break
        }
        case 'call_banned': {
          if (!rule.banned?.length) break
          for (const call of refs.filter(r => r.type === 'call')) {
            if (rule.banned.includes(call.name) || rule.banned.some(b => b.endsWith('.' + call.name))) {
              violations.push(mkViolation(rule, { line: call.line }))
            }
          }
          if (rule.banned.includes('debugger') && ['.js', '.mjs', '.cjs', '.ts', '.tsx'].includes(ext)) {
            const lines = content.split('\n')
            for (let i = 0; i < lines.length; i++) {
              if (/^\s*debugger\s*;?\s*$/.test(lines[i])) violations.push(mkViolation(rule, { line: i + 1 }))
            }
          }
          break
        }
        case 'except_bare': {
          const lines = content.split('\n')
          let inString = false
          let openDelim = null
          for (let i = 0; i < lines.length; i++) {
            const trimmed = lines[i].trim()
            if (trimmed.startsWith('#')) continue
            if (!inString) {
              // 打开三引号：支持前缀（f"""）与赋值（x = """）——行内任意位置首个三引号
              // 旧实现只认行首：赋值形式不识别（收尾行被当新打开 → 剩余全漏检）——
              // 递归进化第 5 轮 P1#12
              // 7（T14）：[^"'#]*? 可空匹配 → 引擎可从注释内位置重新锚定，`x = 5  # """` 命中注释文本
              const codePart = trimmed.replace(/#.*$/, '')
              const openIdx = tripleOpenIndex(codePart)
              if (openIdx >= 0) {
                const open = codePart.slice(openIdx, openIdx + 3)
                const rest = codePart.slice(openIdx + 3)
                if (!rest.includes(open)) { inString = true; openDelim = open }
                continue
              }
              if (/^\s*except\s*:/.test(lines[i])) {
                violations.push(mkViolation(rule, { line: i + 1 }))
              }
            } else if (trimmed.includes(openDelim)) {
              inString = false
            }
          }
          break
        }
        case 'call_required_wrapper': {
          if (!rule.banned?.length) break
          const wrapper = rule.wrapper
          for (const call of refs.filter(r => r.type === 'call')) {
            if (!rule.banned.includes(call.name)) continue
            if (wrapper) {
              const enclosing = symbols.find(s =>
                ['function', 'method'].includes(s.type) &&
                s.startLine <= call.line && s.endLine >= call.line
              )
              if (enclosing && (enclosing.name === wrapper || enclosing.name.endsWith(`_${wrapper}`) || enclosing.name.endsWith(wrapper))) continue
            }
            violations.push(mkViolation(rule, { line: call.line, ...(wrapper ? { required_wrapper: wrapper } : {}) }))
          }
          break
        }
        default:
          warnings.push({ rule: rule.id, reason: `unknown_rule_type: ${rule.type}` })
      }
    } catch (e) {
      violations.push({ rule: rule.id, error: `rule_check_failed: ${e.message}` })
    }
  }
  return { violations, warnings }
}

export async function handle(args, context) {
  const workspaceDir = args?.workspace_dir
  if (!workspaceDir) return makeError(ErrorCodes.INVALID_INPUT, 'workspace_dir is required')
  // R22-⑯：非字符串 workspace_dir 让 join 裸抛 TypeError
  if (typeof workspaceDir !== 'string') return makeError(ErrorCodes.INVALID_INPUT, `workspace_dir must be a string (got ${typeof workspaceDir})`)

  const file = args?.file
  if (!file) return makeError(ErrorCodes.INVALID_INPUT, 'file is required')

  const pathCheck = validateFilePath(file)
  if (pathCheck.blocked) return makeError(ErrorCodes.PATH_BLOCKED, pathCheck.detail, { file, reason: pathCheck.reason })

  const absPath = join(workspaceDir, file)
  if (!existsSync(absPath)) return makeError(ErrorCodes.FILE_NOT_FOUND, `File does not exist: ${file}`, { file, suggestion: 'check the file path, or use glob to locate it' })
  // R22-⑯：symlink 逃逸守卫——file 指向 workspace 内 symlink 到外部文件时外部源码被规则扫描
  try {
    const realWs = realpathSync(workspaceDir)
    const realAbs = realpathSync(absPath)
    if (realAbs !== realWs && !realAbs.startsWith(realWs + sep)) {
      return makeError(ErrorCodes.PATH_BLOCKED, `file resolves outside workspace: ${absPath}`, { file, reason: 'symlink_escape' })
    }
  } catch {
    return makeError(ErrorCodes.PATH_BLOCKED, `cannot resolve file path: ${absPath}`, { file, reason: 'resolve_failed' })
  }

  const langParser = context?.langParserService
  if (!langParser) return makeError(ErrorCodes.SERVICE_UNAVAILABLE, 'lang-parser service not available', {
    suggestion: 'This tool requires the MCP server context. Ensure malong MCP server is running.'
  })

  let content
  try {
    content = readFileSync(absPath, 'utf-8')
  } catch (e) {
    return makeError(ErrorCodes.FILE_NOT_FOUND, `Cannot read file: ${e.message}`, { file })
  }
  const { rules: projectRules, warnings: ruleWarnings } = loadProjectRules(workspaceDir, args?.ruleset)
  const projectIds = new Set(projectRules.map(r => r.id))
  const allRules = [...BUILTIN_RULES.filter(r => !projectIds.has(r.id)), ...projectRules]

  const { violations, warnings: checkWarnings } = await checkRules(file, content, allRules, langParser)
  const allWarnings = [...ruleWarnings, ...checkWarnings]

  return {
    file,
    rules_active: allRules.length,
    violations,
    next_step: violations.length
      ? 'Fix violations, then re-run guard_patterns.'
      : 'Clean. Verify with test_bridge(action="run").',
    ...(allWarnings.length ? { warnings: allWarnings } : {}),
  }
}
