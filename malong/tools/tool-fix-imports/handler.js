import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { validateFilePath, ErrorCodes, makeError } from '../../error-codes.js'
import { checkFileStaleness, attachStalenessWarning } from '../../staleness.js'

const BUILTINS_PY = new Set(['abs', 'all', 'any', 'bin', 'bool', 'bytearray', 'bytes', 'callable', 'chr', 'classmethod', 'compile', 'complex', 'delattr', 'dict', 'dir', 'divmod', 'enumerate', 'eval', 'exec', 'filter', 'float', 'format', 'frozenset', 'getattr', 'globals', 'hasattr', 'hash', 'hex', 'id', 'input', 'int', 'isinstance', 'issubclass', 'iter', 'len', 'list', 'locals', 'map', 'max', 'memoryview', 'min', 'next', 'object', 'oct', 'open', 'ord', 'pow', 'print', 'property', 'range', 'repr', 'reversed', 'round', 'set', 'setattr', 'slice', 'sorted', 'staticmethod', 'str', 'sum', 'super', 'tuple', 'type', 'vars', 'zip', '__import__', 'Exception', 'BaseException', 'ValueError', 'TypeError', 'KeyError', 'IndexError', 'RuntimeError', 'StopIteration', 'ArithmeticError', 'AttributeError', 'EOFError', 'ImportError', 'LookupError', 'NameError', 'OSError', 'SyntaxError', 'SystemError', 'UnboundLocalError', 'ZeroDivisionError', 'self', 'cls', 'None', 'True', 'False', 'NotImplemented', 'Ellipsis'])

const BUILTINS_JS = new Set(['Array', 'Boolean', 'Date', 'Error', 'Function', 'JSON', 'Map', 'Math', 'Number', 'Object', 'Promise', 'Proxy', 'RegExp', 'Set', 'String', 'Symbol', 'WeakMap', 'WeakSet', 'console', 'document', 'window', 'global', 'globalThis', 'process', 'require', 'module', 'exports', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate', 'queueMicrotask', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'undefined', 'NaN', 'Infinity', 'Buffer', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'AbortController', 'fetch', 'Response', 'Request', 'Headers', 'encodeURI', 'encodeURIComponent', 'decodeURI', 'decodeURIComponent', 'escape', 'unescape', 'eval', 'Function', 'Atomics', 'SharedArrayBuffer', 'WeakRef', 'FinalizationRegistry', 'structuredClone', 'performance', 'navigator', 'location', 'history', 'localStorage', 'sessionStorage', 'FormData', 'Blob', 'File', 'ReadableStream', 'WritableStream', 'TransformStream', 'Event', 'EventTarget', 'MessageChannel', 'MessagePort', 'BroadcastChannel', 'Worker', 'crypto', 'Crypto', 'CryptoKey', 'Intl', 'Reflect', 'RegExp', 'AggregateError', 'BigInt', 'BigInt64Array', 'BigUint64Array', 'ArrayBuffer', 'DataView', 'Float32Array', 'Float64Array', 'Int8Array', 'Int16Array', 'Int32Array', 'Uint8Array', 'Uint16Array', 'Uint32Array', 'Uint8ClampedArray'])

const BUILTINS_TS = new Set([...BUILTINS_JS, 'Partial', 'Required', 'Readonly', 'Record', 'Pick', 'Omit', 'Exclude', 'Extract', 'NonNullable', 'ReturnType', 'InstanceType', 'Parameters', 'Awaited'])

const BUILTINS_GO = new Set(['append', 'cap', 'close', 'complex', 'copy', 'delete', 'imag', 'len', 'make', 'new', 'panic', 'print', 'println', 'real', 'recover', 'bool', 'byte', 'complex64', 'complex128', 'error', 'float32', 'float64', 'int', 'int8', 'int16', 'int32', 'int64', 'rune', 'string', 'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'uintptr', 'fmt', 'os', 'io', 'strings', 'strconv', 'sync', 'context', 'errors', 'log', 'net', 'http', 'json', 'time', 'sort', 'math', 'rand', 'path', 'filepath', 'bufio', 'bytes', 'regexp', 'encoding', 'reflect', 'testing', 'runtime', 'defer', 'go', 'chan', 'range', 'select', 'fallthrough', 'goto', 'nil', 'true', 'false', 'iota'])

const BUILTINS_RS = new Set(['println', 'print', 'format', 'vec', 'String', 'Vec', 'Box', 'Rc', 'Arc', 'Cell', 'RefCell', 'HashMap', 'HashSet', 'BTreeMap', 'BTreeSet', 'Option', 'Result', 'Some', 'None', 'Ok', 'Err', 'Self', 'self', 'super', 'crate', 'mod', 'use', 'pub', 'fn', 'let', 'mut', 'const', 'static', 'impl', 'trait', 'struct', 'enum', 'type', 'where', 'for', 'loop', 'while', 'if', 'else', 'match', 'return', 'break', 'continue', 'move', 'async', 'await', 'dyn', 'ref', 'unsafe', 'extern', 'macro', 'true', 'false'])

const BUILTINS_MAP = { python: BUILTINS_PY, javascript: BUILTINS_JS, typescript: BUILTINS_TS, go: BUILTINS_GO, rust: BUILTINS_RS }

const SOURCE_EXTS = new Set(['.js', '.mjs', '.cjs', '.mts', '.cts', '.py', '.go', '.rs'])

const KEYWORDS = new Set(['if', 'else', 'for', 'while', 'return', 'import', 'from', 'class', 'def', 'function', 'const', 'let', 'var', 'async', 'await', 'export', 'default', 'extends', 'implements', 'new', 'throw', 'try', 'catch', 'finally', 'switch', 'case', 'break', 'continue', 'typeof', 'instanceof', 'void', 'delete', 'in', 'of', 'this', 'super', 'yield', 'except', 'as', 'with', 'lambda', 'pass', 'raise', 'global', 'nonlocal', 'assert', 'elif', 'not', 'and', 'or', 'is', 'del', 'true', 'false', 'null'])

const SPECIAL = new Set(['__name__', '__file__', '__init__', '__str__', '__repr__'])

const _fixImportsCache = new Map()
const _fixImportsCacheMax = 100

export async function handle(args, context) {
  const { codeIndexService, getWorkspaceDir, langParserService } = context
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

  const pathCheck = validateFilePath(file)
  if (pathCheck.blocked) {
    return makeError(ErrorCodes.PATH_BLOCKED, pathCheck.detail, { file, reason: pathCheck.reason })
  }

  const absPath = join(workspaceDir, file)
  if (!existsSync(absPath)) return { error: 'file_not_found', file, suggestion: `Check that the file exists at ${absPath}` }

  const staleness = await checkFileStaleness(codeIndexService, workspaceDir, file)

  let fileMtime = 0
  try { fileMtime = statSync(absPath).mtimeMs } catch {}
  const cacheKey = `${workspaceDir}\0${file}\0${autoFix}\0${maxCandidates}\0${fileMtime}`
  if (!autoFix && _fixImportsCache.has(cacheKey)) return _fixImportsCache.get(cacheKey)

  const issues = []
  const content = readFileSync(absPath, 'utf-8')
  const lines = content.split('\n')
  const lang = detectLanguage(file)

  let analysis = await analyzeFileAST(content, lang, file, langParserService) || analyzeFile(content, lang, file)

  for (const sym of analysis.undefinedSymbols) {
    const candidates = await findCandidates(codeIndexService, sym, file, maxCandidates)
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

  const removals = computeRemovals(analysis.imports, analysis.usedSymbols, lines, content, issues)

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

    const applied = applyRemovals(newLines, removals)
    fixesApplied.imports_removed = applied.whole
    fixesApplied.imports_trimmed = applied.partial

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

    for (const r of removals) {
      if (r.type === 'partial') {
        transactionReady.push({ file, old_string: r.oldLine, new_string: r.newLine })
      } else {
        transactionReady.push({ file, old_string: r.oldLine, new_string: '' })
      }
    }
  }

  const result = { file, issues, fixes_applied: fixesApplied }
  if (!autoFix && transactionReady.length > 0) {
    result.transaction_ready = transactionReady
  }

  if (issues.length === 0) {
    result.hint = 'No import issues found. If you recently changed function signatures, use impact_analysis to check for broken callers.'
    result.next_step = 'Check dead code: sweep_dead_code()'
  } else {
    result.next_step = `Fix ${issues.length} issue(s) via edit_transaction, then verify: test_bridge(action="run")`
  }

  attachStalenessWarning(result, staleness)

  if (!autoFix) {
    _fixImportsCache.set(cacheKey, result)
    if (_fixImportsCache.size > _fixImportsCacheMax) {
      const oldest = _fixImportsCache.keys().next().value
      _fixImportsCache.delete(oldest)
    }
  }

  return result
}

function computeRemovals(imports, usedSymbols, lines, content, issues) {
  const groups = new Map()
  for (const imp of imports) {
    const isUnused = !usedSymbols.has(imp.name) && !imp.name.startsWith('_')
    if (!isUnused) continue
    const key = imp.key || `l${imp.line}`
    if (!groups.has(key)) groups.set(key, { line: imp.line, statement: imp.statement, stmtStart: imp.stmtStart, stmtEnd: imp.stmtEnd, specs: [], total: 0 })
    const g = groups.get(key)
    g.specs.push({ name: imp.name, kind: imp.kind, specStart: imp.specStart, specEnd: imp.specEnd })
  }
  for (const imp of imports) {
    const key = imp.key || `l${imp.line}`
    if (groups.has(key)) groups.get(key).total++
  }

  const removals = []
  for (const g of groups.values()) {
    const unusedNames = g.specs.map(s => s.name)
    const allNamed = g.specs.every(s => s.kind === 'named' || s.kind === 'require-named')
    const hasPos = g.stmtStart != null && g.specs.every(s => s.specStart != null)
    const singleLine = hasPos && content.slice(g.stmtStart, g.stmtEnd).indexOf('\n') === -1
    const partial = allNamed && hasPos && singleLine && g.specs.length < g.total

    if (partial) {
      const lineIdx = g.line - 1
      const lineText = lines[lineIdx]
      if (lineText == null) continue
      const newLine = removeNamedFromStatement(lineText, g.stmtStart, g.specs)
      if (newLine == null || newLine === lineText) {
        issues.push({ type: 'unused_import', import: g.statement, unused: unusedNames, line: g.line })
        removals.push({ type: 'whole', lineIdx, oldLine: lineText })
      } else if (newLine.trim() === '') {
        issues.push({ type: 'unused_import', import: g.statement, unused: unusedNames, line: g.line })
        removals.push({ type: 'whole', lineIdx, oldLine: lineText })
      } else {
        issues.push({ type: 'unused_import', import: g.statement, unused: unusedNames, line: g.line, partial: true })
        removals.push({ type: 'partial', lineIdx, oldLine: lineText, newLine })
      }
    } else {
      for (const s of g.specs) {
        issues.push({ type: 'unused_import', import: g.statement, unused: [s.name], line: g.line })
      }
      removals.push({ type: 'whole', lineIdx: g.line - 1, oldLine: lines[g.line - 1] })
    }
  }

  removals.sort((a, b) => b.lineIdx - a.lineIdx)
  return removals
}

function removeNamedFromStatement(lineText, stmtStart, unusedSpecs) {
  const rel = unusedSpecs.map(s => ({ start: s.specStart - stmtStart, end: s.specEnd - stmtStart })).sort((a, b) => a.start - b.start)
  const open = lineText.indexOf('{')
  const close = lineText.lastIndexOf('}')
  if (open === -1 || close === -1 || close < open) return null
  const inner = lineText.slice(open + 1, close)
  const innerStart = open + 1
  const items = []
  let ci = 0
  for (const part of inner.split(',')) {
    const start = inner.indexOf(part, ci)
    items.push({ text: part, start: innerStart + start, end: innerStart + start + part.length })
    ci = start + part.length
  }
  const unusedSet = new Set()
  for (const r of rel) {
    const m = items.find(it => r.start >= it.start && r.end <= it.end)
    if (m) unusedSet.add(m)
  }
  if (unusedSet.size === 0) return null
  const kept = items.filter(it => !unusedSet.has(it) && it.text.trim() !== '')
  if (kept.length === 0) return lineText.slice(0, open).trimEnd()
  const keptText = kept.map(k => k.text.trim()).join(', ')
  return lineText.slice(0, open) + '{ ' + keptText + ' }' + lineText.slice(close + 1)
}

function applyRemovals(newLines, removals) {
  let whole = 0, partial = 0
  for (const r of removals) {
    if (r.lineIdx < 0 || r.lineIdx >= newLines.length) continue
    if (r.type === 'partial') { newLines[r.lineIdx] = r.newLine; partial++ }
    else { newLines[r.lineIdx] = ''; whole++ }
  }
  return { whole, partial }
}

async function analyzeFileAST(content, lang, currentFile, langParser) {
  if (!langParser || (lang !== 'javascript' && lang !== 'typescript')) return null
  const ext = lang === 'typescript' ? '.ts' : '.js'

  // async path: try extractAllAsync first
  try {
    const asyncResult = await langParser.extractAllAsync(content, ext)
    if (asyncResult && asyncResult.symbols?.length) {
      const definedSymbols = new Set()
      const usedSymbols = new Set()
      const imports = []
      const symbolLines = Object.create(null)
      const relativeImports = []

      for (const sym of asyncResult.symbols) {
        definedSymbols.add(sym.name)
        symbolLines[sym.name] = sym.startLine
      }
      for (const ref of asyncResult.refs || []) {
        if (ref.type === 'call') usedSymbols.add(ref.name)
        if (ref.type === 'import') {
          imports.push({ name: ref.symbols?.[0] || ref.module || '', line: ref.line, statement: `import ${ref.module || ''}`, key: `l${ref.line}`, kind: 'named', stmtStart: -1, stmtEnd: -1 })
          if (ref.module?.startsWith('.')) {
            relativeImports.push({ module: ref.module, line: ref.line, relative: ref.module, absolute: resolveRelativeImport(ref.module, currentFile) || ref.module })
          }
          for (const symName of ref.symbols || []) definedSymbols.add(symName)
        }
      }

      const builtins = BUILTINS_MAP[lang] || BUILTINS_JS
      const undefinedSymbols = []
      for (const sym of usedSymbols) {
        if (KEYWORDS.has(sym) || SPECIAL.has(sym) || builtins.has(sym) || sym.startsWith('__')) continue
        if (sym === sym.toUpperCase() && sym.length > 2) continue
        if (sym.includes('.')) continue
        if (!definedSymbols.has(sym)) undefinedSymbols.push(sym)
      }
      return { definedSymbols, usedSymbols, imports, undefinedSymbols: [...new Set(undefinedSymbols)], symbolLines, relativeImports }
    }
  } catch {}

  return null
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
  const symbolLines = Object.create(null)
  const relativeImports = []

  const pyImportRe = /^(?:from\s+(\S+)\s+)?import\s+(.+)$/
  const importLineRe = lang === 'python'
    ? pyImportRe
    : /^(?:import\s+|const\s+(?:\{[^}]+\}|\w+)\s*=\s*(?:require\(|(?:await\s+)?import\())/

  const defRe = /^(?:\s*)(?:export\s+)?(?:async\s+)?(?:function\s+|def\s+|class\s+|const\s+(\S+)\s*=|let\s+(\S+)\s*=|var\s+(\S+)\s*=)/

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()

    if (lang === 'python') {
      const importMatch = trimmed.match(pyImportRe)
      if (importMatch) {
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
      }
    } else {
      let jm
      if ((jm = trimmed.match(/^import\s+\{([^}]+)\}\s+from\s+['"]/))) {
        jm[1].split(',').forEach(s => {
          const name = s.trim().split(/\s+as\s+/).pop().trim()
          if (name) imports.push({ name, line: i + 1, statement: trimmed })
        })
      } else if ((jm = trimmed.match(/^import\s+(\w+)\s+from\s+['"]/))) {
        imports.push({ name: jm[1], line: i + 1, statement: trimmed })
      } else if ((jm = trimmed.match(/^import\s+\*\s+as\s+(\w+)\s+from\s+['"]/))) {
        imports.push({ name: jm[1], line: i + 1, statement: trimmed })
      } else if ((jm = trimmed.match(/^const\s+\{([^}]+)\}\s*=\s*require\(/))) {
        jm[1].split(',').forEach(s => {
          const name = s.trim().split(/[\s:]+/).pop().trim()
          if (name) imports.push({ name, line: i + 1, statement: trimmed })
        })
      } else if ((jm = trimmed.match(/^const\s+(\w+)\s*=\s*require\(/))) {
        imports.push({ name: jm[1], line: i + 1, statement: trimmed })
      } else if ((jm = trimmed.match(/^const\s+(\w+)\s*=\s*(?:await\s+)?import\(/))) {
        imports.push({ name: jm[1], line: i + 1, statement: trimmed })
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
      const name = parts[1]?.replace(/[:{(].*$/, '')
      if (name && !name.startsWith('(')) { definedSymbols.add(name); symbolLines[name] = i + 1 }
    }

    if (lang !== 'python') {
      const msMatch = trimmed.match(/^(?:async\s+)?(\w+)\s*\(([^)]*)\)\s*\{/)
      if (msMatch && !KEYWORDS.has(msMatch[1])) {
        definedSymbols.add(msMatch[1]); symbolLines[msMatch[1]] = i + 1
        for (const p of msMatch[2].split(',')) {
          const pname = p.trim().split(/[\s=]/)[0]
          if (pname && /^[a-zA-Z_]\w*$/.test(pname)) definedSymbols.add(pname)
        }
      }
      const destructMatch = trimmed.match(/^(?:const|let|var)\s+\{([^}]+)\}\s*=/)
      if (destructMatch) {
        destructMatch[1].split(',').forEach(s => {
          const parts = s.trim().split(/\s*:\s*/)
          const name = (parts.length > 1 ? parts[1] : parts[0]).split(/[\s=]/)[0]
          if (name && /^[a-zA-Z_]\w*$/.test(name)) definedSymbols.add(name)
        })
      }
      const bareDeclMatch = trimmed.match(/^(?:let|var)\s+([a-zA-Z_$][\w$]*(?:\s*,\s*[a-zA-Z_$][\w$]*)*)\s*$/)
      if (bareDeclMatch) {
        bareDeclMatch[1].split(',').forEach(s => { const n = s.trim(); if (n) definedSymbols.add(n) })
      }
      const forOfMatch = trimmed.match(/for\s+\((?:const|let|var)\s+(\w+)\s+(?:of|in)\s/)
      if (forOfMatch) definedSymbols.add(forOfMatch[1])
      const arrowParamRe = /(?:,\s*|\(\s*)(\w+(?:\s*,\s*\w+)*)\s*\)?\s*=>/g
      let apm
      while ((apm = arrowParamRe.exec(trimmed)) !== null) {
        apm[1].split(',').forEach(s => { const n = s.trim(); if (n && /^[a-zA-Z_]\w*$/.test(n)) definedSymbols.add(n) })
      }
    }

    if (lang === 'python') {
      const assignMatch = trimmed.match(/^(\w+)\s*(?::\s*[\w\[\], |]+)?\s*=[^=]/)
      if (assignMatch && !KEYWORDS.has(assignMatch[1])) { definedSymbols.add(assignMatch[1]); symbolLines[assignMatch[1]] = i + 1 }

      const paramMatch = trimmed.match(/def\s+\w+\s*\(([^)]*)\)/)
      if (paramMatch) {
        for (const p of paramMatch[1].split(',')) {
          const pname = p.trim().split(/[\s:=]/)[0]
          if (pname && /^[a-zA-Z_]\w*$/.test(pname)) definedSymbols.add(pname)
        }
      }

      const exceptMatch = trimmed.match(/except\s+[\w.]+\s+as\s+(\w+)/)
      if (exceptMatch) definedSymbols.add(exceptMatch[1])

      const forMatch = trimmed.match(/for\s+(\w+)\s+in\s/)
      if (forMatch) definedSymbols.add(forMatch[1])

      const withMatch = trimmed.match(/with\s+.+\s+as\s+(\w+)/)
      if (withMatch) definedSymbols.add(withMatch[1])
    } else {
      const jsParamMatch = trimmed.match(/(?:function\s+\w+|(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?function)\s*\(([^)]*)\)/)
      if (jsParamMatch) {
        for (const p of jsParamMatch[1].split(',')) {
          const pname = p.trim().split(/[\s=]/)[0]
          if (pname && /^[a-zA-Z_]\w*$/.test(pname)) definedSymbols.add(pname)
        }
      }
      const arrowMatch = trimmed.match(/(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?\(([^)]*)\)\s*=>/)
      if (arrowMatch) {
        for (const p of arrowMatch[1].split(',')) {
          const pname = p.trim().split(/[\s=]/)[0]
          if (pname && /^[a-zA-Z_]\w*$/.test(pname)) definedSymbols.add(pname)
        }
      }
      const catchMatch = trimmed.match(/catch\s*\(\s*(\w+)/)
      if (catchMatch) definedSymbols.add(catchMatch[1])
    }
  }

  const builtins = BUILTINS_MAP[lang] || BUILTINS_PY

  const cleaned = stripCommentsAndStrings(content, lang)
  const cleanedLines = cleaned.split('\n')
  const idRe = /(?<!\.)\b([a-zA-Z_]\w*)/g
  for (let li = 0; li < cleanedLines.length; li++) {
    const cl = cleanedLines[li].trim()
    if (!cl || importLineRe.test(cl)) continue
    for (const m of cl.matchAll(idRe)) {
      const name = m[1]
      const after = cl.slice(m.index + name.length).trimStart()
      if (after.startsWith('=') && !after.startsWith('==')) continue
      if (after.startsWith(':') && !after.startsWith('::')) continue
      if (!builtins.has(name)) {
        usedSymbols.add(name)
      }
    }
  }

  if (lang === 'python') {
    const stringAnnotationRe = /(?<=\w)\s*:\s*["']([A-Za-z_]\w*(?:\s*\|\s*[A-Za-z_]\w*)*)["']/g
    let match
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
    if (sym === sym.toUpperCase() && sym.length > 2) continue
    if (sym.includes('.')) continue
    if (!definedSymbols.has(sym)) {
      undefinedSymbols.push(sym)
    }
  }

  return { definedSymbols, usedSymbols, imports, undefinedSymbols: [...new Set(undefinedSymbols)], symbolLines, relativeImports }
}

function stripCommentsAndStrings(content, lang) {
  let s = content
  if (lang === 'python') {
    s = s.replace(/"""[\s\S]*?"""/g, ' ')
    s = s.replace(/'''[\s\S]*?'''/g, ' ')
    s = s.replace(/#.*$/gm, ' ')
    s = s.replace(/"(?:[^"\\]|\\.)*"/g, ' ')
    s = s.replace(/'(?:[^'\\]|\\.)*'/g, ' ')
  } else {
    s = s.replace(/\/\*[\s\S]*?\*\//g, ' ')
    s = s.replace(/\/\/.*$/gm, ' ')
    s = s.replace(/`(?:[^`\\]|\\.)*`/g, ' ')
    s = s.replace(/"(?:[^"\\]|\\.)*"/g, ' ')
    s = s.replace(/'(?:[^'\\]|\\.)*'/g, ' ')
  }
  return s
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

async function findCandidates(codeIndexService, symbol, file, maxCandidates) {
  try {
    const refs = (await codeIndexService.getReferences(symbol)) || []
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
