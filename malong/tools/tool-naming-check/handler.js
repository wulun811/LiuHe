import { join, extname } from 'node:path'
import { existsSync } from 'node:fs'
import Database from 'better-sqlite3'
import { ErrorCodes, makeError, validateFilePath } from '../../error-codes.js'

const EXT_MAP = { python: '.py', javascript: '.js', typescript: '.ts', go: '.go', rust: '.rs', java: '.java' }
const EXT_TO_LANG = { '.py': 'python', '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.ts': 'typescript', '.tsx': 'typescript', '.go': 'go', '.rs': 'rust', '.java': 'java' }

const SEMANTIC_GROUPS = {
  get: ['get', 'fetch', 'retrieve', 'load', 'read', 'query'],
  create: ['create', 'make', 'build', 'new', 'add', 'insert'],
  delete: ['delete', 'remove', 'destroy', 'drop', 'clear', 'purge'],
  update: ['update', 'modify', 'change', 'set', 'edit', 'patch'],
  check: ['check', 'validate', 'verify', 'ensure', 'assert'],
}

const FRAMEWORK_IDIOMS = new Set([
  'setUp', 'tearDown', 'useEffect', 'useState', 'useCallback', 'useMemo',
  'useRef', 'useContext', 'useReducer', 'useLayoutEffect', 'useImperativeHandle',
  'componentDidMount', 'componentDidUpdate', 'componentWillUnmount', 'render',
  'main', 'handler', 'init', 'setup', 'teardown', 'run', 'execute',
])

function classifyStyle(name) {
  if (/^[a-z]+(_[a-z0-9]+)+$/.test(name)) return 'snake_case'
  if (/^[a-z][a-zA-Z0-9]*$/.test(name) && /[A-Z]/.test(name)) return 'camelCase'
  if (/^[A-Z][a-zA-Z0-9]*$/.test(name)) return 'PascalCase'
  return null
}

function extractVerb(name) {
  const clean = name.replace(/^[_#]+/, '')
  if (clean.includes('_')) return clean.split('_')[0]
  const m = clean.match(/^[a-z]+/)
  return m ? m[0] : clean
}

function detectStyle(db, ext) {
  const rows = db.prepare(`
    SELECT s.name FROM symbols s JOIN files f ON s.file_id = f.id
    WHERE f.path LIKE ? AND s.type IN ('function', 'method', 'variable')
  `).all(`%${ext}`)
  const counts = { snake_case: 0, camelCase: 0, PascalCase: 0 }
  for (const r of rows) {
    const s = classifyStyle(r.name)
    if (s) counts[s]++
  }
  const total = counts.snake_case + counts.camelCase + counts.PascalCase
  if (!total) return { snake_case: 0, camelCase: 0, PascalCase: 0, dominant: null }
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1])
  return {
    snake_case: Math.round(counts.snake_case / total * 100) / 100,
    camelCase: Math.round(counts.camelCase / total * 100) / 100,
    PascalCase: Math.round(counts.PascalCase / total * 100) / 100,
    dominant: sorted[0][0],
  }
}

function learnVerbs(db, ext) {
  const rows = db.prepare(`
    SELECT s.name FROM symbols s JOIN files f ON s.file_id = f.id
    WHERE f.path LIKE ? AND s.type IN ('function', 'method')
  `).all(`%${ext}`)
  const verbs = {}
  for (const r of rows) {
    const v = extractVerb(r.name)
    ;(verbs[v] ??= []).push(r.name)
  }
  return verbs
}

function checkSemantic(symbol, verbPrefs) {
  if (FRAMEWORK_IDIOMS.has(symbol)) return null
  const verb = extractVerb(symbol)
  for (const [, synonyms] of Object.entries(SEMANTIC_GROUPS)) {
    if (!synonyms.includes(verb)) continue
    const groupCounts = Object.fromEntries(synonyms.map(s => [s, (verbPrefs[s] ?? []).length]))
    const total = Object.values(groupCounts).reduce((a, b) => a + b, 0)
    if (!total) continue
    const sorted = Object.entries(groupCounts).sort((a, b) => b[1] - a[1])
    const [dominantVerb, dominantCount] = sorted[0]
    if (dominantVerb !== verb && dominantCount >= 3 && dominantCount / total >= 0.7) {
      return {
        symbol,
        issue: 'semantic_inconsistency',
        detail: `project uses '${dominantVerb}' in ${dominantCount} functions`,
        suggestion: symbol.replace(verb, dominantVerb),
        confidence: Math.round(dominantCount / total * 100) / 100,
        evidence: (verbPrefs[dominantVerb] ?? []).slice(0, 4),
      }
    }
  }
  return null
}

export async function handle(args, context) {
  const workspaceDir = args?.workspace_dir
  if (!workspaceDir) return makeError(ErrorCodes.INVALID_INPUT, 'workspace_dir is required')

  const file = args?.file
  if (!file) return makeError(ErrorCodes.INVALID_INPUT, 'file is required')

  const pathCheck = validateFilePath(file)
  if (pathCheck.blocked) return makeError(ErrorCodes.PATH_BLOCKED, pathCheck.detail, { file, reason: pathCheck.reason })

  const newSymbols = args?.new_symbols
  if (!Array.isArray(newSymbols)) return makeError(ErrorCodes.INVALID_INPUT, 'new_symbols must be an array of strings')

  const ext = extname(file)
  const lang = args?.lang || EXT_TO_LANG[ext]
  if (!lang || !EXT_MAP[lang]) {
    return makeError(ErrorCodes.INVALID_INPUT, `unsupported language: ${lang || ext}`, {
      supported: Object.keys(EXT_MAP).join(', ')
    })
  }

  const { getWorkspaceDir } = context
  const dbPath = join(getWorkspaceDir(workspaceDir), 'code-index.db')
  if (!existsSync(dbPath)) {
    return makeError(ErrorCodes.INDEX_STALE, `Workspace not indexed: ${workspaceDir}`, {
      suggestion: `Call reindex(workspace_dir="${workspaceDir}") first`
    })
  }

  let db
  try {
    db = new Database(dbPath, { readonly: true })
  } catch (e) {
    return makeError(ErrorCodes.SERVICE_UNAVAILABLE, `Cannot open database: ${e.message}`)
  }

  try {
    const targetExt = EXT_MAP[lang]
    const projectStyle = detectStyle(db, targetExt)
    const verbPrefs = learnVerbs(db, targetExt)

    const issues = []
    for (const sym of newSymbols) {
      if (FRAMEWORK_IDIOMS.has(sym)) continue

      const style = classifyStyle(sym)
      if (style && projectStyle.dominant && style !== projectStyle.dominant && projectStyle[projectStyle.dominant] >= 0.7) {
        const suggestion = style === 'camelCase' && projectStyle.dominant === 'snake_case'
          ? sym.replace(/([A-Z])/g, '_$1').toLowerCase()
          : style === 'snake_case' && projectStyle.dominant === 'camelCase'
            ? sym.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
            : null
        issues.push({
          symbol: sym,
          issue: 'style_inconsistency',
          detail: `${lang} project uses ${projectStyle.dominant} (${Math.round(projectStyle[projectStyle.dominant] * 100)}%), but '${sym}' is ${style}`,
          ...(suggestion ? { suggestion } : {}),
          confidence: projectStyle[projectStyle.dominant],
        })
      }

      const semantic = checkSemantic(sym, verbPrefs)
      if (semantic) issues.push(semantic)
    }

    return {
      file,
      lang,
      project_style: projectStyle,
      new_symbols_checked: newSymbols.length,
      issues,
    }
  } finally {
    db.close()
  }
}
