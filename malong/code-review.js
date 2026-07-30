import { extname, basename } from 'node:path'

export const name = 'malong-code-review'
export const version = '0.1.0'

let _core, _codeQuality

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

  const camelRe = /\b([a-z][a-zA-Z0-9]*)\b/g
  const pascalRe = /\b([A-Z][a-zA-Z0-9]*)\b/g
  const snakeRe = /\b([a-z]+_[a-z0-9_]+)\b/g
  const upperSnakeRe = /\b([A-Z]+_[A-Z0-9_]+)\b/g

  let m
  const names = { camel: new Set(), pascal: new Set(), snake: new Set(), upperSnake: new Set() }

  const srcStr = typeof source === 'string' ? source : String(source)
  while ((m = camelRe.exec(srcStr)) !== null) {
    const w = m[1]
    if (w.length >= 3 && !/^(let|const|var|function|return|if|for|while|switch|case|break|continue|new|typeof|instanceof|import|export|from|class|extends|async|await|this|throw|try|catch|finally|else|default|in|of|do|void|delete|yield)$/.test(w))
      names.camel.add(w)
  }
  while ((m = pascalRe.exec(srcStr)) !== null) {
    const w = m[1]
    if (w.length >= 3 && !['String', 'Number', 'Boolean', 'Object', 'Array', 'Function', 'Date', 'RegExp', 'Error', 'Promise', 'Map', 'Set', 'Symbol', 'BigInt', 'Math', 'JSON', 'Intl', 'NaN', 'Infinity', 'undefined', 'null', 'true', 'false'].includes(w))
      names.pascal.add(w)
  }
  while ((m = snakeRe.exec(srcStr)) !== null) {
    const w = m[1]
    if (w.length >= 4 && !w.startsWith('process.env')) names.snake.add(w)
  }
  while ((m = upperSnakeRe.exec(srcStr)) !== null) names.upperSnake.add(m[1])

  const total = names.camel.size + names.pascal.size + names.snake.size + names.upperSnake.size
  if (total > 0) {
    const dominant = Math.max(names.camel.size, names.pascal.size, names.snake.size, names.upperSnake.size)
    const dominantName = dominant === names.camel.size ? 'camelCase' :
      dominant === names.pascal.size ? 'PascalCase' :
      dominant === names.snake.size ? 'snake_case' : 'UPPER_SNAKE_CASE'

    if (ext === '.js' || ext === '.mjs' || ext === '.jsx') {
      if (dominantName === 'snake_case' && names.snake.size > names.camel.size * 1.5) {
        issues.push({ severity: 'warn', category: 'naming', message: `JS 文件主要使用 snake_case (${names.snake.size} 处)，建议使用 camelCase`, line: 1 })
      }
    }
  }
  return issues
}

function checkComments(source) {
  const issues = []
  const lines = source.split('\n')
  const codeLines = lines.filter(l => l.trim() && !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
  const commentLines = lines.filter(l => l.trim().startsWith('//') || l.trim().startsWith('*') || l.trim().startsWith('/*') || l.trim().startsWith('#'))
  const ratio = commentLines.length / Math.max(1, lines.length)
  const funcCount = (source.match(/function\s+\w+\(/g) || []).length
  const docCommentCount = (source.match(/\/\*\*[\s\S]*?\*\//g) || []).length

  if (funcCount > 0 && docCommentCount < funcCount * 0.5) {
    issues.push({ severity: 'info', category: 'documentation', message: `${funcCount} 个函数，仅 ${docCommentCount} 个有 JSDoc 注释`, line: 1 })
  }
  if (ratio < 0.03 && lines.length > 100) {
    issues.push({ severity: 'info', category: 'documentation', message: `注释比 ${(ratio * 100).toFixed(1)}%，建议增加注释（>100 行文件）`, line: 1 })
  }
  const todoCount = (source.match(/\b(TODO|FIXME|HACK|XXX)\b/g) || []).length
  if (todoCount > 0) {
    issues.push({ severity: 'info', category: 'maintainability', message: `存在 ${todoCount} 处 TODO/FIXME/HACK 标记`, line: 1 })
  }
  return issues
}

function checkLongFunctions(source) {
  const issues = []
  const lines = source.split('\n')
  let inFunc = false, funcLine = 0, funcName = '', braceCount = 0, funcLines = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const funcMatch = line.match(/(?:async\s+)?function\s+(\w+)\s*\(/)
    const arrowMatch = line.match(/(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*{/)
    const methodMatch = line.match(/(\w+)\s*\([^)]*\)\s*{/)

    if (funcMatch) { inFunc = true; funcLine = i + 1; funcName = funcMatch[1]; braceCount = 1; funcLines = 1 }
    else if (arrowMatch) { inFunc = true; funcLine = i + 1; funcName = arrowMatch[1]; braceCount = 1; funcLines = 1 }
    else if (methodMatch && !inFunc) { inFunc = true; funcLine = i + 1; funcName = methodMatch[1]; braceCount = 1; funcLines = 1 }
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
  const lines = source.split('\n').map(l => l.trim()).filter(l => l.length > 20)
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

export async function init(core) {
  _core = core
  _codeQuality = core.getService('codeQuality')

  core.registerService('codeReview', {
    async review(source, filePath, opts) {
      const results = []
      const s = String(source)

      results.push(...checkNaming(s, filePath || 'unknown.js'))
      results.push(...checkComments(s))
      results.push(...checkLongFunctions(s))
      results.push(...checkDuplication(s))

      if (_codeQuality) {
        try {
          const q = await _codeQuality.scoreSource(s, filePath || '')
          if (q.overall < 0.6) {
            results.push({ severity: 'warn', category: 'quality', message: `代码质量总分 ${(q.overall * 100).toFixed(0)}/100，低于建议值 60`, line: 1 })
          }
          for (const [dim, info] of Object.entries(q.dimensions || {})) {
            if (info.score < 0.5) {
              results.push({ severity: 'info', category: 'quality', message: `维度 "${dim}" 得分 ${(info.score * 100).toFixed(0)}/100: ${info.description || ''}`, line: 1 })
            }
          }
          results._qualityScore = q
        } catch {}
      }

      const warnCount = results.filter(r => r.severity === 'warn').length
      const infoCount = results.filter(r => r.severity === 'info').length

      return {
        summary: {
          totalIssues: results.length,
          warnings: warnCount,
          infos: infoCount,
          score: Math.max(0, 100 - warnCount * 15 - infoCount * 3),
        },
        issues: results,
        qualityScore: results._qualityScore || null,
      }
    },

    async reviewDiff(diffContent, fileName, opts) {
      const blocks = parseSearchReplaceBlocks(diffContent)
      const allIssues = []
      for (const block of blocks) {
        const result = await this.review(block.replace, block.file || fileName, opts)
        allIssues.push(...result.issues.map(i => ({ ...i, file: block.file || fileName })))
      }
      const w = allIssues.filter(i => i.severity === 'warn').length
      const info = allIssues.filter(i => i.severity === 'info').length
      return {
        summary: { totalIssues: allIssues.length, warnings: w, infos: info, score: Math.max(0, 100 - w * 15 - info * 3) },
        issues: allIssues,
      }
    },
  })
}

function parseSearchReplaceBlocks(content) {
  const blocks = []
  const re = /<<<<<<<\s*SEARCH\s*([\s\S]*?)=======\s*([\s\S]*?)>>>>>>>\s*REPLACE/g
  let m
  while ((m = re.exec(content)) !== null) {
    blocks.push({ search: m[1], replace: m[2], file: extractFileName(m[1], m[2]) })
  }
  return blocks
}

function extractFileName(search, replace) {
  const pathRe = /([a-zA-Z0-9_/.-]+\.[a-z]+)/g
  let m
  const names = new Set()
  while ((m = pathRe.exec(search + '\n' + replace)) !== null) names.add(m[1])
  return names.size === 1 ? [...names][0] : 'unknown'
}

export async function start() {}
export async function stop() {}
