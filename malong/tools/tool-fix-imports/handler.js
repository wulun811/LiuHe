import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs'

const BUILTINS_PY = new Set(['abs', 'all', 'any', 'bin', 'bool', 'bytearray', 'bytes', 'callable', 'chr', 'classmethod', 'compile', 'complex', 'delattr', 'dict', 'dir', 'divmod', 'enumerate', 'eval', 'exec', 'filter', 'float', 'format', 'frozenset', 'getattr', 'globals', 'hasattr', 'hash', 'hex', 'id', 'input', 'int', 'isinstance', 'issubclass', 'iter', 'len', 'list', 'locals', 'map', 'max', 'memoryview', 'min', 'next', 'object', 'oct', 'open', 'ord', 'pow', 'print', 'property', 'range', 'repr', 'reversed', 'round', 'set', 'setattr', 'slice', 'sorted', 'staticmethod', 'str', 'sum', 'super', 'tuple', 'type', 'vars', 'zip', '__import__', 'Exception', 'BaseException', 'ValueError', 'TypeError', 'KeyError', 'IndexError', 'RuntimeError', 'StopIteration', 'ArithmeticError', 'AttributeError', 'EOFError', 'ImportError', 'LookupError', 'NameError', 'OSError', 'SyntaxError', 'SystemError', 'UnboundLocalError', 'ZeroDivisionError'])

const BUILTINS_JS = new Set(['Array', 'Boolean', 'Date', 'Error', 'Function', 'JSON', 'Map', 'Math', 'Number', 'Object', 'Promise', 'Proxy', 'RegExp', 'Set', 'String', 'Symbol', 'WeakMap', 'WeakSet', 'console', 'document', 'window', 'global', 'process', 'require', 'module', 'exports', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'undefined', 'NaN', 'Infinity', 'Buffer', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'AbortController', 'fetch', 'Response', 'Request', 'Headers'])

const BUILTINS_TS = new Set([...BUILTINS_JS, 'Partial', 'Required', 'Readonly', 'Record', 'Pick', 'Omit', 'Exclude', 'Extract', 'NonNullable', 'ReturnType', 'InstanceType', 'Parameters', 'Awaited'])

const BUILTINS_GO = new Set(['append', 'cap', 'close', 'complex', 'copy', 'delete', 'imag', 'len', 'make', 'new', 'panic', 'print', 'println', 'real', 'recover', 'bool', 'byte', 'complex64', 'complex128', 'error', 'float32', 'float64', 'int', 'int8', 'int16', 'int32', 'int64', 'rune', 'string', 'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'uintptr', 'fmt', 'os', 'io', 'strings', 'strconv', 'sync', 'context', 'errors', 'log', 'net', 'http', 'json', 'time', 'sort', 'math', 'rand', 'path', 'filepath', 'bufio', 'bytes', 'regexp', 'encoding', 'reflect', 'testing', 'runtime', 'defer', 'go', 'chan', 'range', 'select', 'fallthrough', 'goto', 'nil', 'true', 'false', 'iota'])

const BUILTINS_RS = new Set(['println', 'print', 'format', 'vec', 'String', 'Vec', 'Box', 'Rc', 'Arc', 'Cell', 'RefCell', 'HashMap', 'HashSet', 'BTreeMap', 'BTreeSet', 'Option', 'Result', 'Some', 'None', 'Ok', 'Err', 'Self', 'self', 'super', 'crate', 'mod', 'use', 'pub', 'fn', 'let', 'mut', 'const', 'static', 'impl', 'trait', 'struct', 'enum', 'type', 'where', 'for', 'loop', 'while', 'if', 'else', 'match', 'return', 'break', 'continue', 'move', 'async', 'await', 'dyn', 'ref', 'unsafe', 'extern', 'macro', 'true', 'false'])

const BUILTINS_MAP = { python: BUILTINS_PY, javascript: BUILTINS_JS, typescript: BUILTINS_TS, go: BUILTINS_GO, rust: BUILTINS_RS }

const SOURCE_EXTS = new Set(['.js', '.mjs', '.cjs', '.mts', '.cts', '.py', '.go', '.rs'])

const KEYWORDS = new Set(['if', 'else', 'for', 'while', 'return', 'import', 'from', 'class', 'def', 'function', 'const', 'let', 'var', 'async', 'await', 'export', 'default', 'extends', 'implements', 'new', 'throw', 'try', 'catch', 'finally', 'switch', 'case', 'break', 'continue', 'typeof', 'instanceof', 'void', 'delete', 'in', 'of', 'this', 'super', 'yield'])

const SPECIAL = new Set(['__name__', '__file__', '__init__', '__str__', '__repr__'])

const _fixImportsCache = new Map()
const _fixImportsCacheMax = 200

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

  const file = args?.file || ''
  const autoFix = !!args?.auto_fix
  const maxCandidates = parseInt(args?.max_candidates) || 10

  if (!file) return { error: 'missing_parameter', message: 'file is required', suggestion: 'Provide a file path relative to workspace_dir (e.g. "src/new_feature.py")' }

  const absPath = join(workspaceDir, file)
  if (!existsSync(absPath)) return { error: 'file_not_found', file, suggestion: `Check that the file exists at ${absPath}` }

  let fileMtime = 0
  try { fileMtime = statSync(absPath).mtimeMs } catch {}
  const cacheKey = `${workspaceDir}\0${file}\0${autoFix}\0${maxCandidates}\0${fileMtime}`
  if (!autoFix && _fixImportsCache.has(cacheKey)) return _fixImportsCache.get(cacheKey)

  const issues = []
  const content = readFileSync(absPath, 'utf-8')
  const lines = content.split('\n')
  const lang = detectLanguage(file)

  const analysis = analyzeFile(content, lang, file)

  for (const sym of analysis.undefinedSymbols) {
    const candidates = findCandidates(codeIndexService, sym, file, maxCandidates)
    issues.push({
      type: 'undefined_symbol',
      symbol: sym,
      line: analysis.symbolLines[sym] || 0,
      suggestion: candidates.length > 0 ? `from ${candidates[0].module} import ${sym}` : `Define "${sym}" or add the appropriate import`,
      candidates: candidates.slice(0, maxCandidates)
    })
  }

  const depGraph = await codeIndexService.getModuleDependencies(file, { depth: 5 }) || {}
  const moduleName = fileToModule(file)
  const cycle = detectCycle(moduleName, depGraph)
  if (cycle) {
    issues.push({
      type: 'circular_import',
      modules: cycle,
      cycle: cycle.join(' → '),
      suggestion: { action: 'extract_shared_types', target: suggestSharedModule(cycle) }
    })
  }

  for (const imp of analysis.imports) {
    if (!analysis.usedSymbols.has(imp.name) && !imp.name.startsWith('_')) {
      issues.push({ type: 'unused_import', import: imp.statement, line: imp.line })
    }
  }

  for (const rel of analysis.relativeImports) {
    issues.push({
      type: 'relative_import',
      relative: rel.relative,
      absolute: rel.absolute,
      line: rel.line,
      suggestion: `from ${rel.absolute} import ...`
    })
  }

  let fixesApplied = null
  if (autoFix && issues.length > 0) {
    fixesApplied = { imports_added: 0, imports_removed: 0 }
    const newLines = [...lines]

    const undefinedIssues = issues.filter(i => i.type === 'undefined_symbol' && i.candidates.length > 0)
    if (undefinedIssues.length > 0) {
      const seenModules = new Set()
      const stmts = undefinedIssues.map(i => {
        const c = i.candidates[0]
        if (seenModules.has(c.module)) return null
        seenModules.add(c.module)
        return `from ${c.module} import ${i.symbol}`
      }).filter(Boolean)
      if (stmts.length > 0) {
        const insertLine = findImportInsertLine(newLines) || 0
        newLines.splice(insertLine, 0, ...stmts)
        fixesApplied.imports_added = stmts.length
      }
    }

    const unusedIssues = issues.filter(i => i.type === 'unused_import')
    if (unusedIssues.length > 0) {
      for (const issue of unusedIssues) {
        const idx = issue.line - 1
        if (idx >= 0 && idx < newLines.length) {
          newLines[idx] = ''
          fixesApplied.imports_removed++
        }
      }
    }

    writeFileSync(absPath, newLines.join('\n'), 'utf-8')
  }

  const transactionReady = []
  if (!autoFix) {
    const undefinedIssues = issues.filter(i => i.type === 'undefined_symbol' && i.candidates.length > 0)
    if (undefinedIssues.length > 0) {
      const seenModules = new Set()
      const stmts = undefinedIssues.map(i => {
        const c = i.candidates[0]
        if (seenModules.has(c.module)) return null
        seenModules.add(c.module)
        return `from ${c.module} import ${i.symbol}`
      }).filter(Boolean)
      if (stmts.length > 0) {
        const insertLine = findImportInsertLine(lines) || 0
        const oldText = lines.slice(0, insertLine).join('\n') + (insertLine > 0 ? '\n' : '')
        const newText = oldText + stmts.join('\n') + '\n'
        transactionReady.push({ file, old_string: oldText, new_string: newText })
      }
    }

    const unusedIssues = issues.filter(i => i.type === 'unused_import')
    for (const issue of unusedIssues) {
      const idx = issue.line - 1
      if (idx >= 0 && idx < lines.length) {
        transactionReady.push({ file, old_string: lines[idx], new_string: '' })
      }
    }
  }

  const result = { file, issues, fixes_applied: fixesApplied }
  if (!autoFix && transactionReady.length > 0) {
    result.transaction_ready = transactionReady
  }

  if (issues.length === 0) {
    result.hint = 'No import issues found. If you recently changed function signatures, use impact_analysis to check for broken callers.'
  }

  if (!autoFix) {
    _fixImportsCache.set(cacheKey, result)
    if (_fixImportsCache.size > _fixImportsCacheMax) {
      const oldest = _fixImportsCache.keys().next().value
      _fixImportsCache.delete(oldest)
    }
  }

  return result
}

function detectLanguage(filePath) {
  if (filePath.endsWith('.py')) return 'python'
  if (filePath.endsWith('.js') || filePath.endsWith('.mjs') || filePath.endsWith('.cjs') || filePath.endsWith('.jsx')) return 'javascript'
  if (filePath.endsWith('.ts') || filePath.endsWith('.tsx') || filePath.endsWith('.mts') || filePath.endsWith('.cts')) return 'typescript'
  if (filePath.endsWith('.go')) return 'go'
  if (filePath.endsWith('.rs')) return 'rust'
  return 'unknown'
}

function analyzeFile(content, lang, currentFile = '') {
  const lines = content.split('\n')
  const definedSymbols = new Set()
  const usedSymbols = new Set()
  const imports = []
  const undefinedSymbols = []
  const symbolLines = {}
  const relativeImports = []

  const importRe = lang === 'python'
    ? /^(?:from\s+(\S+)\s+)?import\s+(.+)$/
    : /^(?:import\s+(.+)|const\s+(?:\{[^}]+\}|(\S+))\s*=\s*require\(|import\s+(?:\{[^}]+\}|(\S+))\s+from\s+['"]|const\s+(\S+)\s*=\s*(?:await\s+)?import\()/

  const defRe = /^(?:\s*)(?:export\s+)?(?:async\s+)?(?:function\s+|def\s+|class\s+|const\s+(\S+)\s*=|let\s+(\S+)\s*=|var\s+(\S+)\s*=)/

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()

    const importMatch = trimmed.match(importRe)
    if (importMatch) {
      if (lang === 'python') {
        const module = importMatch[1] || ''
        if (module.startsWith('.')) {
          const absModule = resolveRelativeImport(module, currentFile)
          relativeImports.push({ relative: module, absolute: absModule, line: i + 1 })
        }
        if (importMatch[1]) {
          const names = importMatch[2].split(',').map(s => {
            const parts = s.trim().split(/\s+as\s+/)
            return { name: parts[parts.length - 1].trim(), line: i + 1, statement: trimmed }
          })
          imports.push(...names)
        } else {
          const names = importMatch[2] ? importMatch[2].split(',').map(s => {
            const parts = s.trim().split(/\s+as\s+/)
            return { name: parts[parts.length - 1].trim(), line: i + 1, statement: trimmed }
          }) : []
          imports.push(...names)
        }
      } else {
        const names = importMatch.slice(1).filter(Boolean).flatMap(s => s ? s.split(',').map(x => x.trim().replace(/[{}]/g, '').split(/\s+as\s+/).pop()) : [])
        names.forEach(n => { if (n) imports.push({ name: n, line: i + 1, statement: trimmed }) })
      }
    }

    const defMatch = trimmed.match(defRe)
    if (defMatch) {
      const name = defMatch.slice(1).find(Boolean)
      if (name) { definedSymbols.add(name); symbolLines[name] = i + 1 }
    }

    const strippedDef = trimmed.replace(/^(?:export|async)\s+/, '')
    if (strippedDef.startsWith('def ') || strippedDef.startsWith('function ') || strippedDef.startsWith('class ')) {
      const parts = strippedDef.split(/[\s(]/)
      const name = parts[1]
      if (name && !name.startsWith('(')) { definedSymbols.add(name); symbolLines[name] = i + 1 }
    }
  }

  const builtins = BUILTINS_MAP[lang] || BUILTINS_PY

  const idRe = /(?<!\.)\b([a-zA-Z_]\w*)/g
  let match
  while ((match = idRe.exec(content)) !== null) {
    const name = match[1]
    if (!builtins.has(name) && name !== name.toUpperCase()) {
      usedSymbols.add(name)
    }
  }

  if (lang === 'python') {
    const stringAnnotationRe = /:\s*["']([A-Za-z_]\w*(?:\s*\|\s*[A-Za-z_]\w*)*)["']/g
    while ((match = stringAnnotationRe.exec(content)) !== null) {
      const types = match[1].split(/\s*\|\s*/)
      for (const t of types) {
        const name = t.trim()
        if (name && !builtins.has(name) && name !== name.toUpperCase()) {
          usedSymbols.add(name)
        }
      }
    }
  }

  imports.forEach(imp => definedSymbols.add(imp.name))

  for (const sym of usedSymbols) {
    if (KEYWORDS.has(sym) || SPECIAL.has(sym) || builtins.has(sym) || sym.startsWith('__')) continue
    if (!definedSymbols.has(sym)) {
      undefinedSymbols.push(sym)
    }
  }

  return { definedSymbols, usedSymbols, imports, undefinedSymbols: [...new Set(undefinedSymbols)], symbolLines, relativeImports }
}

function resolveRelativeImport(relativeModule, currentFile) {
  if (!currentFile) return relativeModule
  const parts = currentFile.replace(/\.[^.]+$/, '').split('/')
  parts.pop()
  let dots = 0
  while (dots < relativeModule.length && relativeModule[dots] === '.') dots++
  const remaining = relativeModule.slice(dots)
  const up = dots - 1
  const base = parts.slice(0, Math.max(0, parts.length - up))
  if (remaining) {
    return [...base, remaining].join('.')
  }
  return base.join('.') || '.'
}

function findCandidates(codeIndexService, symbol, file, maxCandidates) {
  try {
    const refs = codeIndexService.getReferences(symbol) || []
    return refs
      .filter(r => (r.source_file || r.file || r.caller_file) !== file)
      .slice(0, maxCandidates)
      .map(r => ({
        module: fileToModule(r.source_file || r.file || r.caller_file),
        name: symbol,
        line: r.line || 0
      }))
  } catch {
    return []
  }
}

function detectCycle(startModule, depGraph) {
  if (!depGraph || !depGraph.directImports) return null
  const directModules = depGraph.directImports.map(d => fileToModule(d.path || d.module || ''))
  const visited = new Set()
  const path = []
  function dfs(module) {
    if (path.includes(module)) {
      const idx = path.indexOf(module)
      return path.slice(idx)
    }
    if (visited.has(module)) return null
    visited.add(module)
    path.push(module)
    if (module && depGraph.transitiveImports && depGraph.transitiveImports[module]) {
      for (const dep of depGraph.transitiveImports[module]) {
        const result = dfs(fileToModule(dep.path || dep.module || dep))
        if (result) return result
      }
    }
    path.pop()
    return null
  }
  return dfs(startModule)
}

function fileToModule(filePath) {
  if (!filePath) return ''
  return filePath.replace(/\.[^.]+$/, '').replace(/[/\\]/g, '.')
}

function suggestSharedModule(cycle) {
  const parts = cycle[0].split('.')
  parts.pop()
  return parts.join('.') + '.types'
}

function findImportInsertLine(lines) {
  let lastImport = -1
  for (let i = 0; i < Math.min(lines.length, 50); i++) {
    const t = lines[i].trim()
    if (t.startsWith('from ') || t.startsWith('import ')) {
      lastImport = i
    } else if (t && !t.startsWith('#') && !t.startsWith('//') && !t.startsWith('"') && !t.startsWith("'")) {
      if (lastImport >= 0) return lastImport + 1
      return i
    }
  }
  return lastImport >= 0 ? lastImport + 1 : 0
}
