import { resolve, sep } from 'node:path'

export const ErrorCodes = {
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  OLD_STRING_NOT_FOUND: 'OLD_STRING_NOT_FOUND',
  AMBIGUOUS_MATCH: 'AMBIGUOUS_MATCH',
  TXN_NOT_FOUND: 'TXN_NOT_FOUND',
  INVALID_INPUT: 'INVALID_INPUT',
  INVALID_ACTION: 'INVALID_ACTION',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  INDEX_STALE: 'INDEX_STALE',
  PATH_BLOCKED: 'PATH_BLOCKED',
  TIMEOUT: 'TIMEOUT',
  NO_MATCH: 'NO_MATCH',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
}

export function makeError(code, message, extra = {}) {
  return { error_code: code, error: code.toLowerCase(), message, ...extra }
}

const DENY_PATTERNS = [
  { pattern: /(^|[\/\\])\.git([\/\\]|$)/, name: '.git' },
  { pattern: /(^|[\/\\])\.env(\.|$)/, name: '.env' },
  { pattern: /\.pem$/i, name: '.pem' },
  { pattern: /\.key$/i, name: '.key' },
  { pattern: /(^|[\/\\])node_modules([\/\\]|$)/, name: 'node_modules' },
  { pattern: /(^|[\/\\])(\.?venv)([\/\\]|$)/, name: 'venv' },
  { pattern: /(^|[\/\\])__pycache__([\/\\]|$)/, name: '__pycache__' },
  { pattern: /(^|[\/\\])\.ai-transactions([\/\\]|$)/, name: '.ai-transactions' },
]

export function validateFilePath(filePath, workspaceDir) {
  if (!filePath || typeof filePath !== 'string') {
    return { blocked: true, reason: 'invalid_path', detail: 'file path is empty or not a string' }
  }
  const isAbsolute = filePath.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(filePath)

  if (isAbsolute) {
    // 绝对路径：仅当显式提供 workspaceDir 且路径 resolve 后落在 workspace 内才放行
    // （batch-edit 反向兼容契约）；否则拒绝——join(ws, abs) 会让绝对路径「胜出」→
    // 读写工作区外任意文件（递归进化第 5 轮 P0#1）
    if (workspaceDir) {
      const resolved = resolve(filePath)
      const wsResolved = resolve(workspaceDir)
      if (resolved === wsResolved || resolved.startsWith(wsResolved + sep)) {
        return { ok: true }
      }
      return { blocked: true, reason: 'path_traversal', detail: `absolute path outside workspace: ${filePath}` }
    }
    return { blocked: true, reason: 'absolute_path', detail: `absolute path is not allowed (must be workspace-relative): ${filePath}` }
  }

  if (filePath.includes('..')) {
    return { blocked: true, reason: 'path_traversal', detail: `file path contains "..": ${filePath}` }
  }

  for (const { pattern, name } of DENY_PATTERNS) {
    if (pattern.test(filePath)) {
      return { blocked: true, reason: 'protected_path', detail: `file path contains protected segment "${name}": ${filePath}` }
    }
  }
  return { ok: true }
}

export function findClosestMatch(content, oldStr) {
  if (!oldStr || !content) return null

  const normContent = content.replace(/\s+/g, ' ').trim()
  const normOld = oldStr.replace(/\s+/g, ' ').trim()
  if (normContent.includes(normOld)) {
    const result = {
      found_via: 'whitespace_normalized',
      similarity: 1.0,
      suggestion: 'old_string matches after whitespace normalization - check indentation/spacing',
    }
    const lines = content.split('\n')
    const oldLines = oldStr.split('\n')
    const wsDiff = _detectWhitespaceDiff(content, oldStr, _findBestLine(lines, oldLines))
    if (wsDiff) result.whitespace_diff = wsDiff
    return result
  }

  const lines = content.split('\n')
  const oldLines = oldStr.split('\n')
  const windowSize = Math.max(1, oldLines.length)
  let bestLine = -1
  let bestScore = 0
  let bestSnippet = ''

  for (let i = 0; i <= lines.length - windowSize; i++) {
    const window = lines.slice(i, i + windowSize).join('\n')
    const score = _jaccardSimilarity(window, oldStr)
    if (score > bestScore) {
      bestScore = score
      bestLine = i + 1
      const snippetLines = lines.slice(i, i + Math.min(windowSize + 1, 4))
      bestSnippet = snippetLines.join('\n')
      if (bestSnippet.length > 200) bestSnippet = bestSnippet.slice(0, 200) + '...'
    }
  }

  if (bestScore >= 0.3) {
    const result = {
      line: bestLine,
      similarity: Math.round(bestScore * 100) / 100,
      snippet: bestSnippet,
    }
    const wsDiff = _detectWhitespaceDiff(content, oldStr, bestLine)
    if (wsDiff) result.whitespace_diff = wsDiff
    return result
  }

  return null
}

function _findBestLine(lines, oldLines) {
  if (!oldLines.length) return 1
  const firstOld = oldLines[0].trim()
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === firstOld) return i + 1
  }
  let bestLine = 1, bestScore = 0
  for (let i = 0; i < lines.length; i++) {
    const score = _jaccardSimilarity(lines[i], oldLines[0])
    if (score > bestScore) { bestScore = score; bestLine = i + 1 }
  }
  return bestLine
}

function _jaccardSimilarity(a, b) {
  const tokensA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean))
  const tokensB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean))
  let intersection = 0
  for (const t of tokensA) {
    if (tokensB.has(t)) intersection++
  }
  const union = new Set([...tokensA, ...tokensB]).size
  return union > 0 ? intersection / union : 0
}

function _detectWhitespaceDiff(content, oldStr, bestLine) {
  const lines = content.split('\n')
  const oldLines = oldStr.split('\n')
  if (oldLines.length === 0) return null

  for (let j = 0; j < oldLines.length; j++) {
    const fileLine = lines[bestLine - 1 + j] || ''
    const oldLine = oldLines[j]
    if (fileLine.trim() !== oldLine.trim()) continue

    const fileIndent = fileLine.match(/^[\t ]*/)?.[0] || ''
    const oldIndent = oldLine.match(/^[\t ]*/)?.[0] || ''

    if (fileIndent !== oldIndent) {
      const fileSpaces = fileIndent.replace(/\t/g, '  ').length
      const oldSpaces = oldIndent.replace(/\t/g, '  ').length
      return {
        type: 'indentation_mismatch',
        line: bestLine + j,
        file_indent: fileSpaces,
        your_indent: oldSpaces,
        detail: `file uses ${fileSpaces} spaces at line ${bestLine + j}, your old_string uses ${oldSpaces} spaces`,
      }
    }

    const fileTrailing = fileLine.endsWith(' ') || fileLine.endsWith('\t')
    const oldTrailing = oldLine.endsWith(' ') || oldLine.endsWith('\t')
    if (fileTrailing !== oldTrailing) {
      return {
        type: 'trailing_whitespace',
        line: bestLine + j,
        detail: fileTrailing
          ? `file has trailing whitespace at line ${bestLine + j}, your old_string does not`
          : `your old_string has trailing whitespace at line ${bestLine + j}, file does not`,
      }
    }
  }

  return null
}
