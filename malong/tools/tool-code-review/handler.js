import { basename, extname, resolve } from 'node:path'
import { readFileSync, existsSync } from 'node:fs'

function guardPath(root, userPath) {
  // r23-fix3: LLM 可能传非字符串路径（数字/对象）→ resolve() 会抛 TypeError 崩溃
  if (typeof root !== 'string' || typeof userPath !== 'string' || userPath === '') return null
  const rootResolved = resolve(root)
  const resolved = resolve(rootResolved, userPath)
  return resolved === rootResolved || resolved.startsWith(rootResolved + '/') ? resolved : null
}

const KEYWORDS = new Set(['let', 'const', 'var', 'function', 'return', 'if', 'for', 'while', 'switch', 'case', 'break', 'continue', 'new', 'typeof', 'instanceof', 'import', 'export', 'from', 'class', 'extends', 'async', 'await', 'this', 'throw', 'try', 'catch', 'finally', 'else', 'default', 'in', 'of', 'do', 'void', 'delete', 'yield'])
const BUILTINS = new Set(['String', 'Number', 'Boolean', 'Object', 'Array', 'Function', 'Date', 'RegExp', 'Error', 'Promise', 'Map', 'Set', 'Symbol', 'BigInt', 'Math', 'JSON', 'Intl', 'NaN', 'Infinity', 'undefined', 'null', 'true', 'false'])
const SEARCH_REPLACE_RE = /<<<<<<<\s*SEARCH\s*([\s\S]*?)=======\s*([\s\S]*?)>>>>>>>\s*REPLACE/g
// r23-fix2: LLM 最常用的 patch 格式是 unified diff（--- a/ +++ b/ @@），必须支持
const COMMON_MODULES = new Set(['process', 'require', 'console', 'module', 'exports', 'Buffer', 'globalThis', 'window', 'document', 'fetch', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'])

function getNameConvention(fileName) {
  const base = basename(fileName, extname(fileName))
  if (/^[a-z]+(-[a-z0-9]+)*$/.test(base)) return 'kebab-case'
  if (/^[a-z]+([A-Z][a-z0-9]*)*$/.test(base)) return 'camelCase'
  if (/^[A-Z][a-z0-9]*([A-Z][a-z0-9]*)*$/.test(base)) return 'PascalCase'
  if (/^[a-z]+(_[a-z0-9]+)*$/.test(base)) return 'snake_case'
  return 'unknown'
}

function checkNaming(source, fileName) {
  const issues = []
  const ext = extname(fileName)
  const convention = getNameConvention(fileName)
  if (convention !== 'kebab-case' && convention !== 'camelCase') {
    issues.push({ severity: 'info', category: 'naming', message: `文件名 "${basename(fileName)}" 不是标准命名风格 (kebab/camelCase)`, line: 1 })
  }

  const srcStr = String(source)
  const names = { camel: new Set(), pascal: new Set(), snake: new Set(), upperSnake: new Set() }
  let m

  const camelRe = /\b([a-z][a-zA-Z0-9]*)\b/g
  while ((m = camelRe.exec(srcStr)) !== null) {
    const w = m[1]
    if (w.length >= 3 && !KEYWORDS.has(w) && !COMMON_MODULES.has(w)) names.camel.add(w)
  }
  const pascalRe = /\b([A-Z][a-zA-Z0-9]*)\b/g
  while ((m = pascalRe.exec(srcStr)) !== null) {
    if (m[1].length >= 3 && !BUILTINS.has(m[1])) names.pascal.add(m[1])
  }
  const snakeRe = /\b([a-z]+_[a-z0-9_]+)\b/g
  while ((m = snakeRe.exec(srcStr)) !== null) {
    if (m[1].length >= 4 && !m[1].startsWith('process.env')) names.snake.add(m[1])
  }
  const upperSnakeRe = /\b([A-Z]+_[A-Z0-9_]+)\b/g
  while ((m = upperSnakeRe.exec(srcStr)) !== null) names.upperSnake.add(m[1])

  const total = names.camel.size + names.pascal.size + names.snake.size + names.upperSnake.size
  if (total > 0) {
    const dominant = Math.max(names.camel.size, names.pascal.size, names.snake.size, names.upperSnake.size)
    const dominantName = dominant === names.camel.size ? 'camelCase'
      : dominant === names.pascal.size ? 'PascalCase'
      : dominant === names.snake.size ? 'snake_case' : 'UPPER_SNAKE_CASE'
    if (['.js', '.mjs', '.jsx'].includes(ext)) {
      if (dominantName === 'snake_case' && names.snake.size > names.camel.size * 1.5) {
        // r23-fix2: 给出具体违规行号，LLM 才能直接定位修复
        const badLines = new Set()
        let sm
        snakeRe.lastIndex = 0
        while ((sm = snakeRe.exec(srcStr)) !== null) {
          if (!sm[1].startsWith('process.env')) badLines.add(srcStr.slice(0, sm.index).split('\n').length)
        }
        const first = [...badLines][0] || 1
        issues.push({ severity: 'warn', category: 'naming', message: `JS 文件主要使用 snake_case (${names.snake.size} 处，如行 ${[...badLines].slice(0, 3).join(', ')}${badLines.size > 3 ? '…' : ''})，建议使用 camelCase`, line: first })
      }
    }
  }
  return issues
}

function checkComments(source, fileName) {
  const issues = []
  const lines = String(source).split('\n')
  const isJsLike = /\.(js|mjs|cjs|jsx|ts|tsx)$/i.test(fileName || '')
  const commentLines = lines.filter(l => {
    const t = l.trim()
    // '#' 只在非 JS 语言算注释（JS 私有字段 #foo 不算）
    return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || (t.startsWith('#') && !isJsLike)
  })
  const ratio = commentLines.length / Math.max(1, lines.length)
  const funcCount = (String(source).match(/function\s+\w+\(/g) || []).length
  const docCommentCount = (String(source).match(/\/\*\*[\s\S]*?\*\//g) || []).length

  if (funcCount > 0 && docCommentCount < funcCount * 0.5) {
    issues.push({ severity: 'info', category: 'documentation', message: `${funcCount} 个函数，仅 ${docCommentCount} 个有 JSDoc 注释`, line: 1 })
  }
  if (ratio < 0.03 && lines.length > 100) {
    issues.push({ severity: 'info', category: 'documentation', message: `注释比 ${(ratio * 100).toFixed(1)}%，建议增加注释（>100 行文件）`, line: 1 })
  }
  const todoLines = lines.map((l, i) => /\b(TODO|FIXME|HACK|XXX)\b/.test(l) ? i + 1 : null).filter(Boolean)
  if (todoLines.length > 0) {
    issues.push({ severity: 'info', category: 'maintainability', message: `存在 ${todoLines.length} 处 TODO/FIXME/HACK 标记（行 ${todoLines.slice(0, 5).join(', ')}${todoLines.length > 5 ? '…' : ''}）`, line: todoLines[0] })
  }
  return issues
}

function checkLongFunctions(source) {
  const issues = []
  const lines = String(source).split('\n')
  // 控制语句会匹配 methodMatch（if/for/while/catch/switch/with），必须排除
  const CONTROL_STATEMENTS = new Set(['if', 'for', 'while', 'catch', 'switch', 'with'])
  let inFunc = false, funcLine = 0, funcName = '', braceCount = 0, funcLines = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const funcMatch = line.match(/(?:async\s+)?function\s+(\w+)\s*\(/)
    const arrowMatch = line.match(/(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*{/)
    const methodMatch = line.match(/(\w+)\s*\([^)]*\)\s*{/)

    if (funcMatch) { inFunc = true; funcLine = i + 1; funcName = funcMatch[1]; braceCount = 1; funcLines = 1 }
    else if (arrowMatch) { inFunc = true; funcLine = i + 1; funcName = arrowMatch[1]; braceCount = 1; funcLines = 1 }
    else if (methodMatch && !inFunc && !CONTROL_STATEMENTS.has(methodMatch[1])) { inFunc = true; funcLine = i + 1; funcName = methodMatch[1]; braceCount = 1; funcLines = 1 }
    else if (inFunc) {
      for (const ch of line) { if (ch === '{') braceCount++; if (ch === '}') braceCount-- }
      funcLines++
      if (braceCount <= 0) {
        if (funcLines > 50) {
          issues.push({ severity: 'warn', category: 'complexity', message: `函数 "${funcName}" 有 ${funcLines} 行（建议 ≤50 行）`, line: funcLine })
        }
        inFunc = false; funcLines = 0
      }
    }
  }
  return issues
}

function checkDuplication(source) {
  const issues = []
  const lines = String(source).split('\n').map(l => l.trim()).filter(l => l.length > 20)
  const seen = new Map()
  for (let i = 0; i < lines.length; i++) {
    const key = lines[i].slice(0, 60)
    if (key.length >= 30) {
      if (seen.has(key)) seen.get(key).push(i + 1)
      else seen.set(key, [i + 1])
    }
  }
  for (const [, locations] of seen) {
    if (locations.length >= 3) {
      issues.push({ severity: 'warn', category: 'duplication', message: `重复代码块出现在行 ${locations.slice(0, 5).join(', ')}`, line: locations[0] })
    }
  }
  return issues
}

function reviewOne(source, filePath) {
  const issues = []
  issues.push(...checkNaming(source, filePath || 'unknown.js'))
  issues.push(...checkComments(source, filePath))
  issues.push(...checkLongFunctions(source))
  issues.push(...checkDuplication(source))

  const warnCount = issues.filter(r => r.severity === 'warn').length
  const infoCount = issues.filter(r => r.severity === 'info').length
  return {
    summary: {
      total_issues: issues.length,
      warnings: warnCount,
      infos: infoCount,
      score: Math.max(0, 100 - warnCount * 15 - infoCount * 3),
    },
    issues,
  }
}

function parseSearchReplaceBlocks(content) {
  const blocks = []
  let m
  SEARCH_REPLACE_RE.lastIndex = 0
  while ((m = SEARCH_REPLACE_RE.exec(content)) !== null) {
    const names = new Set()
    const pathRe = /([a-zA-Z0-9_/.-]+\.[a-z]+)/g
    let pm
    while ((pm = pathRe.exec(m[1] + '\n' + m[2])) !== null) names.add(pm[1])
    blocks.push({ search: m[1], replace: m[2], file: names.size === 1 ? [...names][0] : 'unknown' })
  }
  return blocks
}

// r23-fix2: unified diff 解析——按 --- / +++ 文件头分组，只收集 '+' 新增行作为审查对象
function parseUnifiedBlocks(content) {
  const blocks = []
  const segments = String(content).split(/\n(?=---\s(?:a\/|\/))/)
  for (const seg of segments) {
    const to = seg.match(/^\+\+\+\s+(?:b\/)?(.+)$/m)
    if (!to) continue
    const file = to[1].trim()
    if (file === '/dev/null') continue
    const lines = []
    for (const line of seg.split('\n')) {
      if (line.startsWith('@@') || line.startsWith('---') || line.startsWith('+++')) continue
      if (line.startsWith('+')) lines.push(line.slice(1))
    }
    if (lines.length > 0) blocks.push({ search: '', replace: lines.join('\n'), file })
  }
  return blocks
}

export async function handle(args, context) {
  const workspaceDir = args?.workspace_dir
  if (!workspaceDir) {
    return { error: 'missing_parameter', message: 'workspace_dir is required' }
  }
  const maxIssues = Math.min(Math.max(parseInt(args?.max_issues) || 50, 1), 200)

  if (args?.diff) {
    const srBlocks = parseSearchReplaceBlocks(args.diff)
    const uniBlocks = parseUnifiedBlocks(args.diff)
    const blocks = srBlocks.length > 0 ? srBlocks : uniBlocks
    if (blocks.length === 0) {
      // r23-fix2: 空块静默返回 blocks=0 会让 LLM 误以为审查通过
      return {
        error: 'invalid_diff_format',
        message: 'No SEARCH/REPLACE or unified diff blocks found in diff',
        suggestion: 'SEARCH/REPLACE: <<<<<<< SEARCH ... ======= ... >>>>>>> REPLACE; unified: --- a/x.js / +++ b/x.js / @@ -1,3 +1,4 @@ 带 + 行',
      }
    }
    const allIssues = []
    for (const block of blocks) {
      const result = reviewOne(block.replace, block.file)
      for (const i of result.issues) allIssues.push({ ...i, file: block.file })
    }
    const w = allIssues.filter(i => i.severity === 'warn').length
    const info = allIssues.filter(i => i.severity === 'info').length
    return {
      mode: 'diff',
      format: srBlocks.length > 0 ? 'search_replace' : 'unified',
      blocks_reviewed: blocks.length,
      files: [...new Set(blocks.map(b => b.file))],
      summary: { total_issues: allIssues.length, warnings: w, infos: info, score: Math.max(0, 100 - w * 15 - info * 3) },
      issues: allIssues.slice(0, maxIssues),
      truncated: allIssues.length > maxIssues,
    }
  }

  let source = args?.source
  let file = args?.file
  if (source === undefined && file) {
    const absPath = guardPath(workspaceDir, file)
    if (!absPath) {
      return { error: 'path_escape', message: `Path escapes workspace_dir: ${file}` }
    }
    if (!existsSync(absPath)) {
      return { error: 'file_not_found', message: `File not found: ${file}`, suggestion: 'Check the path is relative to workspace_dir and the file exists on disk' }
    }
    source = readFileSync(absPath, 'utf-8')
  }
  if (source === undefined) {
    return { error: 'missing_parameter', message: 'Provide file (relative to workspace_dir) or source' }
  }

  const result = reviewOne(source, file)
  return {
    mode: 'source',
    file,
    summary: result.summary,
    issues: result.issues.slice(0, maxIssues),
    truncated: result.issues.length > maxIssues,
    next_step: result.summary.warnings > 0
      ? 'Fix warnings above (long functions, duplication, naming).'
      : 'Code review passed with no warnings.',
  }
}
