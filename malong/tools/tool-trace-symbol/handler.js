import { join } from 'node:path'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'

const SOURCE_EXTS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts', '.py', '.go', '.rs', '.java', '.rb', '.php'])

const _traceCache = new Map()
const _traceCacheMax = 200

const VERB_PREFIXES = /^(get|set|handle|process|create|delete|update|find|check|validate|login|logout|register|send|fetch|load|save|init|start|stop|run|execute|parse|format|convert|transform|filter|sort|map|reduce|count|verify|authenticate|authorize|encrypt|decrypt|encode|decode|read|write|open|close|connect|disconnect|subscribe|unsubscribe|emit|on|off|add|remove|insert|append|push|pop|shift|unshift)/

function detectMisuse(symbol) {
  if (!symbol) return null
  if (VERB_PREFIXES.test(symbol) || (symbol.includes('_') && !/^[A-Z_]+$/.test(symbol))) {
    return {
      warning: 'likely_wrong_tool',
      suggestion: `"${symbol}" looks like a function/method name. For function impact analysis, use impact_analysis(symbol="${symbol}"). For line-level callers, use call_chain(line=N).`
    }
  }
  return null
}

export async function handle(args, context) {
  const { codeIndexService, getWorkspaceDir } = context
  const workspaceDir = args?.workspace_dir

  if (!workspaceDir) {
    return { error: 'missing_parameter', message: 'workspace_dir is required', suggestion: 'Provide the absolute path to the project root directory. Call reindex first.' }
  }

  const dbPath = join(getWorkspaceDir(workspaceDir), 'code-index.db')
  if (!existsSync(dbPath)) {
    return { error: 'workspace_not_indexed', message: `Workspace not indexed: ${workspaceDir}`, suggestion: `Call reindex(workspace_dir="${workspaceDir}") first` }
  }

  if (!codeIndexService) {
    return { error: 'service_unavailable', message: 'codeIndex service not available', suggestion: 'Check MCP server configuration and ensure code-index.js is loaded' }
  }

  codeIndexService.initWorkspace(workspaceDir)

  const symbol = args?.symbol || ''
  const file = args?.file || ''
  const includeLiterals = !!args?.include_literals
  const maxResults = parseInt(args?.max_results) || 30

  if (!symbol) return { error: 'missing_parameter', message: 'symbol is required', suggestion: 'Provide a symbol name to trace (e.g. "MAX_RETRY_COUNT")' }
  if (!file) return { error: 'missing_parameter', message: 'file is required', suggestion: 'Provide a file path relative to workspace_dir where the symbol is defined' }

  const misuseWarning = detectMisuse(symbol)

  const absFilePath = join(workspaceDir, file)
  let fileMtime = 0
  try { fileMtime = statSync(absFilePath).mtimeMs } catch {}
  const cacheKey = `${workspaceDir}\0${symbol}\0${file}\0${includeLiterals}\0${maxResults}\0${fileMtime}`
  const wasCached = _traceCache.has(cacheKey)
  if (wasCached) return _traceCache.get(cacheKey)

  const result = {
    symbol,
    file,
    value: null,
    value_line: null,
    dynamic: false,
    direct_references: [],
    truncated: false,
    suspected_literals: [],
    suggestion: null
  }

  const valueInfo = extractSymbolValue(absFilePath, symbol)
  if (valueInfo) {
    result.value = valueInfo.value
    result.value_line = valueInfo.line
    if (valueInfo.dynamic) {
      result.dynamic = true
      result.raw_value = valueInfo.raw
    }
  }

  const refs = await codeIndexService.getReferences(symbol, file)
  result.direct_references = (refs || []).slice(0, maxResults).map(r => ({
    file: r.source_file || r.file || r.caller_file,
    line: r.line || 0,
    context: r.context || null
  }))
  result.truncated = (refs || []).length > maxResults

  if (includeLiterals && valueInfo) {
    const value = valueInfo.value
    if (value !== null && value !== undefined) {
      const literals = findLiteralReferences(workspaceDir, String(value), symbol)
      result.suspected_literals = literals.slice(0, maxResults)
    }
  }

  if (result.suspected_literals && result.suspected_literals.length > 0 && result.value !== null) {
    result.suggestion = {
      action: 'replace_literal_with_symbol',
      symbol,
      count: result.suspected_literals.length
    }
  }

  try {
    const indexedMtime = codeIndexService.getFileMtime(file)
    if (fileMtime > indexedMtime) {
      result.warning = 'index_stale'
      result.suggestion = `File "${file}" was modified after last index. References may be incomplete. Call reindex to refresh.`
    }
  } catch {}

  if (misuseWarning) {
    result.misuse_warning = misuseWarning
  }

  _traceCache.set(cacheKey, result)
  if (_traceCache.size > _traceCacheMax) {
    const oldest = _traceCache.keys().next().value
    _traceCache.delete(oldest)
  }

  return result
}

function extractSymbolValue(absPath, symbol) {
  try {
    if (!existsSync(absPath)) return null
    const content = readFileSync(absPath, 'utf-8')
    const lines = content.split('\n')

    const assignmentRegex = new RegExp(`^(?:\\s*\\w+\\s+)?${escapeRegex(symbol)}\\s*(?::\\s*\\w+)?\\s*=\\s*(.+)`)
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(assignmentRegex)
      if (match) {
        let value = match[1].trim().replace(/,$/, '').replace(/#.*$/, '').trim()
        if (value.length > 0 && value.length < 200) {
          if (/^[a-zA-Z_]\w*\(/.test(value) || value.includes(' lambda ') || value.includes(' new ')) {
            return { value: null, dynamic: true, raw: value, line: i + 1 }
          }
          try { value = JSON.parse(value) } catch {}
          return { value, line: i + 1 }
        }
      }
    }
    return null
  } catch {
    return null
  }
}

function findLiteralReferences(workspaceDir, literalValue, excludeSymbol, maxFiles = 200) {
  const results = []
  const scanned = { files: 0 }

  try {
    walkDir(workspaceDir, workspaceDir, literalValue, excludeSymbol, results, scanned, maxFiles)
  } catch {}

  results.sort((a, b) => b.confidence - a.confidence)
  return results
}

function walkDir(baseDir, currentDir, literalValue, excludeSymbol, results, scanned, maxFiles) {
  if (scanned.files >= maxFiles) return
  let entries
  try { entries = readdirSync(currentDir, { withFileTypes: true }) } catch { return }

  for (const entry of entries) {
    if (scanned.files >= maxFiles) break
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '.ai-transactions') continue
    const fullPath = join(currentDir, entry.name)

    if (entry.isDirectory()) {
      walkDir(baseDir, fullPath, literalValue, excludeSymbol, results, scanned, maxFiles)
    } else if (entry.isFile()) {
      const ext = fullPath.slice(fullPath.lastIndexOf('.'))
      if (!SOURCE_EXTS.has(ext)) continue
      scanned.files++

      try {
        const content = readFileSync(fullPath, 'utf-8')
        const lines = content.split('\n')
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]
          if (!line.includes(literalValue) || line.includes(excludeSymbol)) continue
          if (!hasBoundaryMatch(line, literalValue)) continue
          if (isInCommentOrString(line, literalValue)) continue
          const confidence = calcConfidence(line, literalValue)
          if (confidence >= 0.5) {
            const relPath = fullPath.startsWith(baseDir + '/') ? fullPath.slice(baseDir.length + 1) : fullPath
            results.push({ file: relPath, line: i + 1, context: line.trim(), confidence: Math.round(confidence * 100) / 100, level: confidence >= 0.8 ? 'high' : 'medium' })
          }
        }
      } catch {}
    }
  }
}

function isInCommentOrString(line, value) {
  const commentIdx = line.indexOf('#')
  const strIdx = line.indexOf('"')
  const strIdx2 = line.indexOf("'")
  const valueIdx = line.indexOf(value)
  if (commentIdx >= 0 && valueIdx > commentIdx) return true
  if (strIdx >= 0 && valueIdx > strIdx) {
    const endStr = line.indexOf('"', strIdx + 1)
    if (endStr < 0 || valueIdx < endStr) return true
  }
  if (strIdx2 >= 0 && valueIdx > strIdx2) {
    const endStr = line.indexOf("'", strIdx2 + 1)
    if (endStr < 0 || valueIdx < endStr) return true
  }
  return false
}

function calcConfidence(line, value) {
  let score = 1.0
  if (line.includes('=') || line.includes('==')) score -= 0.2
  if (line.trimStart().startsWith('#')) score -= 0.5
  if (line.trimStart().startsWith('//')) score -= 0.5
  if (line.includes('print') || line.includes('log') || line.includes('console.')) score -= 0.2
  if (line.includes('def ') || line.includes('function ')) score -= 0.3
  if (line.includes('assert')) score -= 0.1
  const count = line.split(value).length - 1
  if (count > 2) score -= 0.2
  return Math.max(0, score)
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function hasBoundaryMatch(line, value) {
  if (/^\w+$/.test(value)) {
    const re = new RegExp(`\\b${escapeRegex(value)}\\b`)
    return re.test(line)
  }
  return line.includes(value)
}
