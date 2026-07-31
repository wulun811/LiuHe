import { join, extname } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'

function detectIndentStyle(content) {
  const lines = content.split('\n')
  let spaces2 = 0, spaces4 = 0, tabs = 0
  for (const line of lines) {
    const m = /^(\s+)/.exec(line)
    if (!m) continue
    const ws = m[1]
    if (ws.includes('\t')) tabs++
    else if (ws.length % 4 === 0) spaces4++
    else if (ws.length % 2 === 0) spaces2++
  }
  if (tabs > spaces4 && tabs > spaces2) return { style: 'tab', size: 1 }
  if (spaces4 >= spaces2) return { style: 'space', size: 4 }
  return { style: 'space', size: 2 }
}

function checkIndentation(newContent, indentStyle) {
  const errors = []
  const lines = newContent.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue
    const m = /^(\s+)/.exec(line)
    if (!m) continue
    const ws = m[1]

    if (indentStyle.style === 'tab') {
      if (ws.includes(' ') && !ws.includes('\t')) {
        errors.push({ line: i + 1, message: `expected tab indent, found ${ws.length} spaces`, severity: 'warning' })
      }
    } else {
      if (ws.includes('\t')) {
        errors.push({ line: i + 1, message: `expected ${indentStyle.size}-space indent, found tab`, severity: 'warning' })
      } else if (ws.length % indentStyle.size !== 0) {
        errors.push({ line: i + 1, message: `expected ${indentStyle.size}-space indent, found ${ws.length} spaces`, severity: 'warning', suggestion: `change to ${Math.round(ws.length / indentStyle.size) * indentStyle.size} spaces` })
      }
    }
  }
  return errors
}

function checkSyntaxBasic(newContent, ext) {
  const errors = []
  const lines = newContent.split('\n')

  const openers = { '(': ')', '[': ']', '{': '}' }
  const closers = new Set([')', ']', '}'])
  const stack = []
  let inMultiLineString = false
  let multiLineStringChar = ''

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    let inString = inMultiLineString
    let stringChar = multiLineStringChar

    for (let j = 0; j < line.length; j++) {
      const ch = line[j]
      if (inString) {
        if (stringChar.length === 3) {
          if (line.slice(j, j + 3) === stringChar) {
            inString = false
            multiLineStringChar = ''
            j += 2
          }
          continue
        }
        if (ch === stringChar && line[j - 1] !== '\\') {
          inString = false
          multiLineStringChar = ''
        }
        continue
      }
      if (ext === '.py') {
        const tri = line.slice(j, j + 3)
        if (tri === '"""' || tri === "'''") {
          inString = true
          stringChar = tri
          multiLineStringChar = tri
          j += 2
          continue
        }
      }
      if (ch === '"' || ch === "'" || ch === '`') { inString = true; stringChar = ch; continue }
      if (ch === '#' && ext === '.py') break
      if (ch === '/' && line[j + 1] === '/') break

      if (openers[ch]) {
        stack.push({ char: ch, line: i + 1, col: j + 1 })
      } else if (closers.has(ch)) {
        const top = stack.pop()
        if (!top) {
          errors.push({ line: i + 1, col: j + 1, message: `unexpected '${ch}'`, severity: 'error' })
        } else if (openers[top.char] !== ch) {
          errors.push({ line: i + 1, col: j + 1, message: `mismatched '${ch}', expected '${openers[top.char]}' (opened at line ${top.line})`, severity: 'error' })
        }
      }
    }
    inMultiLineString = inString && (stringChar.length === 3 || stringChar === '`')
    multiLineStringChar = inMultiLineString ? stringChar : ''
  }

  for (const unclosed of stack) {
    errors.push({ line: unclosed.line, col: unclosed.col, message: `unclosed '${unclosed.char}'`, severity: 'error' })
  }

  return errors
}

function checkSymbolRefs(newContent, ext, codeIndexService) {
  if (!codeIndexService) return []
  const errors = []

  const defined = new Set()
  const used = new Set()
  const lines = newContent.split('\n')

  for (const line of lines) {
    let m
    if (ext === '.py') {
      m = /(?:def|class)\s+(\w+)/.exec(line)
      if (m) defined.add(m[1])
      m = /(?:import|from)\s+.*?(?:import\s+)?(\w+)/.exec(line)
      if (m) defined.add(m[1])
    } else {
      m = /(?:function|class|const|let|var)\s+(\w+)/.exec(line)
      if (m) defined.add(m[1])
      m = /import\s+(?:{([^}]+)}|(\w+))/.exec(line)
      if (m) {
        if (m[1]) m[1].split(',').forEach(s => defined.add(s.trim().split(/\s+as\s+/).pop().trim()))
        if (m[2]) defined.add(m[2])
      }
    }

    // P2-C4：\b[A-Z]\w+\b 不剥字符串/注释 → 字符串/注释里的 HttpRequest 假报 possibly undefined
    const code = line
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/.*$|#.*$/g, ' ')
      .replace(/`(?:[^`\\]|\\.)*`/g, ' ')
      .replace(/"(?:[^"\\]|\\.)*"/g, ' ')
      .replace(/'(?:[^'\\]|\\.)*'/g, ' ')
    const ids = code.match(/\b[A-Z]\w+\b/g) || []
    for (const id of ids) used.add(id)
  }

  const BUILTINS = new Set(['String', 'Number', 'Boolean', 'Object', 'Array', 'Map', 'Set', 'Promise', 'Error', 'TypeError', 'ValueError', 'Exception', 'True', 'False', 'None', 'Dict', 'List', 'Optional', 'Tuple', 'Int', 'Float'])

  for (const sym of used) {
    if (defined.has(sym) || BUILTINS.has(sym)) continue
    errors.push({ symbol: sym, message: `possibly undefined: ${sym}`, severity: 'info' })
  }

  return errors.slice(0, 10)
}

export async function handle(args, context) {
  const { codeIndexService } = context
  const workspaceDir = args?.workspace_dir

  if (!workspaceDir) {
    return { error: 'missing_parameter', message: 'workspace_dir is required' }
  }

  const file = args?.file
  const newContent = args?.new_content
  if (!file || !newContent) {
    return { error: 'missing_parameter', message: 'file and new_content are required' }
  }

  const ext = extname(file)
  const absPath = join(workspaceDir, file)

  let originalContent = ''
  if (existsSync(absPath)) {
    try { originalContent = readFileSync(absPath, 'utf-8') } catch {}
  }

  const checks = {}

  const syntaxErrors = checkSyntaxBasic(newContent, ext)
  checks.syntax = {
    status: syntaxErrors.length === 0 ? 'pass' : 'fail',
    errors: syntaxErrors.length > 0 ? syntaxErrors : undefined,
  }

  if (originalContent) {
    const indentStyle = detectIndentStyle(originalContent)
    const indentErrors = checkIndentation(newContent, indentStyle)
    checks.indentation = {
      status: indentErrors.length === 0 ? 'pass' : indentErrors.some(e => e.severity === 'error') ? 'fail' : 'warn',
      detected_style: `${indentStyle.style === 'tab' ? 'tab' : indentStyle.size + '-space'}`,
      errors: indentErrors.length > 0 ? indentErrors.slice(0, 10) : undefined,
    }
  } else {
    checks.indentation = { status: 'skip', reason: 'original file not found' }
  }

  const symbolErrors = checkSymbolRefs(newContent, ext, codeIndexService)
  checks.symbol_references = {
    status: symbolErrors.length === 0 ? 'pass' : 'warn',
    errors: symbolErrors.length > 0 ? symbolErrors : undefined,
  }

  const errorCount = [checks.syntax, checks.indentation, checks.symbol_references]
    .reduce((n, c) => n + (c.errors?.filter(e => e.severity === 'error').length || 0), 0)
  const warnCount = [checks.syntax, checks.indentation, checks.symbol_references]
    .reduce((n, c) => n + (c.errors?.filter(e => e.severity !== 'error').length || 0), 0)

  let nextStep = null
  if (errorCount === 0) {
    nextStep = `Validation passed. Apply with edit_transaction.`
  } else {
    nextStep = `Fix the errors above, then re-validate.`
  }

  return {
    valid: errorCount === 0,
    checks,
    summary: { errors: errorCount, warnings: warnCount, fixable: errorCount > 0 },
    next_step: nextStep,
  }
}
