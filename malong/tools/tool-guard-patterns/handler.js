import { join, extname } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
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

function matchesPrefix(name, prefixes) {
  if (!prefixes || !prefixes.length) return true
  return prefixes.some(p => name.startsWith(p))
}

function checkRules(file, content, rules, langParser) {
  const ext = extname(file)
  let tree
  try { tree = langParser.parse(content, ext) } catch (e) {
    return { violations: [], warnings: [{ file, reason: `parse_failed: ${e.message}` }] }
  }
  if (!tree) return { violations: [], warnings: [{ file, reason: 'unsupported_language' }] }

  const violations = []
  const warnings = []
  let refs, symbols
  try {
    refs = langParser.extractReferences(tree, content)
    symbols = langParser.extractSymbols(tree, content)
  } catch (e) {
    return { violations: [], warnings: [{ file, reason: `extract_failed: ${e.message}` }] }
  }

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
            if (rule.banned.includes(call.name)) {
              violations.push(mkViolation(rule, { line: call.line }))
            }
          }
          break
        }
        case 'except_bare': {
          const lines = content.split('\n')
          let inString = false
          for (let i = 0; i < lines.length; i++) {
            const trimmed = lines[i].trim()
            if (trimmed.startsWith('#')) continue
            if (trimmed.startsWith('"""') || trimmed.startsWith("'''")) { inString = !inString; continue }
            if (inString) continue
            if (/^\s*except\s*:/.test(lines[i])) {
              violations.push(mkViolation(rule, { line: i + 1 }))
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

  const file = args?.file
  if (!file) return makeError(ErrorCodes.INVALID_INPUT, 'file is required')

  const pathCheck = validateFilePath(file)
  if (pathCheck.blocked) return makeError(ErrorCodes.PATH_BLOCKED, pathCheck.detail, { file, reason: pathCheck.reason })

  const absPath = join(workspaceDir, file)
  if (!existsSync(absPath)) return makeError(ErrorCodes.FILE_NOT_FOUND, `File does not exist: ${file}`, { file })

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
  const activeBuiltins = BUILTIN_RULES
  const { rules: projectRules, warnings: ruleWarnings } = loadProjectRules(workspaceDir, args?.ruleset)
  const allRules = [...activeBuiltins, ...projectRules]

  const { violations, warnings: checkWarnings } = checkRules(file, content, allRules, langParser)
  const allWarnings = [...ruleWarnings, ...checkWarnings]

  return {
    file,
    rules_active: allRules.length,
    violations,
    ...(allWarnings.length ? { warnings: allWarnings } : {}),
  }
}
