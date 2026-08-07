import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync, statSync, unlinkSync } from 'node:fs'
import { execFile } from 'node:child_process'
import os from 'node:os'
import { validateFilePath, ErrorCodes, makeError } from '../../error-codes.js'
import { getPythonCmd } from '../../python-cmd.js'
import { checkBracketBalance } from '../../write-edit.js'
import { attachStalenessWarning } from '../../staleness.js'
import { acquireLock } from '../../write-runtime.js'

const BUILTINS_PY = new Set(['abs', 'all', 'any', 'bin', 'bool', 'bytearray', 'bytes', 'callable', 'chr', 'classmethod', 'compile', 'complex', 'delattr', 'dict', 'dir', 'divmod', 'enumerate', 'eval', 'exec', 'filter', 'float', 'format', 'frozenset', 'getattr', 'globals', 'hasattr', 'hash', 'hex', 'id', 'input', 'int', 'isinstance', 'issubclass', 'iter', 'len', 'list', 'locals', 'map', 'max', 'memoryview', 'min', 'next', 'object', 'oct', 'open', 'ord', 'pow', 'print', 'property', 'range', 'repr', 'reversed', 'round', 'set', 'setattr', 'slice', 'sorted', 'staticmethod', 'str', 'sum', 'super', 'tuple', 'type', 'vars', 'zip', '__import__', 'Exception', 'BaseException', 'ValueError', 'TypeError', 'KeyError', 'IndexError', 'RuntimeError', 'StopIteration', 'ArithmeticError', 'AttributeError', 'EOFError', 'ImportError', 'LookupError', 'NameError', 'OSError', 'SyntaxError', 'SystemError', 'UnboundLocalError', 'ZeroDivisionError', 'self', 'cls', 'None', 'True', 'False', 'NotImplemented', 'Ellipsis', 'FileNotFoundError', 'SystemExit', 'KeyboardInterrupt', 'GeneratorExit', 'MemoryError', 'RecursionError', 'NotImplementedError', 'PermissionError', 'TimeoutError', 'ConnectionError', 'BrokenPipeError', 'IsADirectoryError', 'NotADirectoryError', 'StopAsyncIteration', 'ModuleNotFoundError', 'BufferError', 'FloatingPointError', 'OverflowError', 'ReferenceError', 'IndentationError', 'TabError', 'UnicodeError', 'UnicodeEncodeError', 'UnicodeDecodeError', 'AssertionError', 'DeprecationWarning', 'UserWarning', 'FutureWarning', 'bytes', 'bytearray', 'staticmethod', 'classmethod', 'property', 'delattr', 'hasattr', 'issubclass', 'isinstance', 'getattr', 'setattr'])

const BUILTINS_JS = new Set(['Array', 'Boolean', 'Date', 'Error', 'Function', 'JSON', 'Map', 'Math', 'Number', 'Object', 'Promise', 'Proxy', 'RegExp', 'Set', 'String', 'Symbol', 'WeakMap', 'WeakSet', 'console', 'document', 'window', 'global', 'globalThis', 'process', 'require', 'module', 'exports', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate', 'queueMicrotask', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'undefined', 'NaN', 'Infinity', 'Buffer', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'AbortController', 'fetch', 'Response', 'Request', 'Headers', 'encodeURI', 'encodeURIComponent', 'decodeURI', 'decodeURIComponent', 'escape', 'unescape', 'eval', 'Function', 'Atomics', 'SharedArrayBuffer', 'WeakRef', 'FinalizationRegistry', 'structuredClone', 'performance', 'navigator', 'location', 'history', 'localStorage', 'sessionStorage', 'FormData', 'Blob', 'File', 'ReadableStream', 'WritableStream', 'TransformStream', 'Event', 'EventTarget', 'MessageChannel', 'MessagePort', 'BroadcastChannel', 'Worker', 'crypto', 'Crypto', 'CryptoKey', 'Intl', 'Reflect', 'RegExp', 'AggregateError', 'BigInt', 'BigInt64Array', 'BigUint64Array', 'ArrayBuffer', 'DataView', 'Float32Array', 'Float64Array', 'Int8Array', 'Int16Array', 'Int32Array', 'Uint8Array', 'Uint16Array', 'Uint32Array', 'Uint8ClampedArray'])

const BUILTINS_TS = new Set([...BUILTINS_JS, 'Partial', 'Required', 'Readonly', 'Record', 'Pick', 'Omit', 'Exclude', 'Extract', 'NonNullable', 'ReturnType', 'InstanceType', 'Parameters', 'Awaited'])

const BUILTINS_GO = new Set(['append', 'cap', 'close', 'complex', 'copy', 'delete', 'imag', 'len', 'make', 'new', 'panic', 'print', 'println', 'real', 'recover', 'bool', 'byte', 'complex64', 'complex128', 'error', 'float32', 'float64', 'int', 'int8', 'int16', 'int32', 'int64', 'rune', 'string', 'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'uintptr', 'fmt', 'os', 'io', 'strings', 'strconv', 'sync', 'context', 'errors', 'log', 'net', 'http', 'json', 'time', 'sort', 'math', 'rand', 'path', 'filepath', 'bufio', 'bytes', 'regexp', 'encoding', 'reflect', 'testing', 'runtime', 'defer', 'go', 'chan', 'range', 'select', 'fallthrough', 'goto', 'nil', 'true', 'false', 'iota'])

const BUILTINS_RS = new Set(['println', 'print', 'format', 'vec', 'String', 'Vec', 'Box', 'Rc', 'Arc', 'Cell', 'RefCell', 'HashMap', 'HashSet', 'BTreeMap', 'BTreeSet', 'Option', 'Result', 'Some', 'None', 'Ok', 'Err', 'Self', 'self', 'super', 'crate', 'mod', 'use', 'pub', 'fn', 'let', 'mut', 'const', 'static', 'impl', 'trait', 'struct', 'enum', 'type', 'where', 'for', 'loop', 'while', 'if', 'else', 'match', 'return', 'break', 'continue', 'move', 'async', 'await', 'dyn', 'ref', 'unsafe', 'extern', 'macro', 'true', 'false'])

const BUILTINS_MAP = { python: BUILTINS_PY, javascript: BUILTINS_JS, typescript: BUILTINS_TS, go: BUILTINS_GO, rust: BUILTINS_RS }
// R8：fix_imports 实际支持分析的规则语言——go/java/unknown 无 import 规则，
// 旧实现 analyzeFileAST/analyzeFile 对其 undefined_symbols 全量垃圾输出
const SUPPORTED_LANGS = new Set(['python', 'javascript', 'typescript', 'rust'])

// r28-fix：补 .jsx/.ts/.tsx/.java（import 语义真实存在）；C 用 include、Bash 无 import，不加
const SOURCE_EXTS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts', '.py', '.go', '.rs', '.java'])

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

  await codeIndexService.initWorkspace(workspaceDir)

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

  // R19-②：fix-imports 主查询为文件系统文本扫描——保鲜走服务层统一入口（带守卫，行为等价旧 checkFileStaleness）
  const staleness = await codeIndexService.ensureFreshFile?.(file)

  let fileMtime = 0
  try { fileMtime = statSync(absPath).mtimeMs } catch {}
  const cacheKey = `${workspaceDir}\0${file}\0${autoFix}\0${maxCandidates}\0${fileMtime}`
  if (!autoFix && _fixImportsCache.has(cacheKey)) return _fixImportsCache.get(cacheKey)

  const issues = []
  // r54(P1): readFileSync 无 try/catch——file 为目录(EISDIR)/不可读时裸异常违反错误对象契约
  let content
  try { content = readFileSync(absPath, 'utf-8') } catch (e) {
    return { error: 'invalid_input', file, message: `Cannot read file: ${file} (${e.code || e.message})`, suggestion: 'Provide a readable source file (not a directory).' }
  }
  const lines = content.split('\n')
  const lang = detectLanguage(file)

  // R8：无规则语言（.go/.java/未知后缀）显式不支持——旧实现 analyzeFileAST/analyzeFile 对 go 无
  // import 规则 → undefined_symbols 全量垃圾，LLM 会被误导去"修复"。返回 supported:false 而非空壳。
  if (!SUPPORTED_LANGS.has(lang)) {
    return {
      file, language: lang, supported: false,
      note: `${lang} analysis not implemented; results omitted to avoid false positives`,
      issues: [], fixes_applied: null,
    }
  }

  let analysis
  if (lang === 'rust') {
    // 8：Rust 走 parser refs（Phase 1 填了 name=绑定名）。只报告不 auto-fix——
    // trait 导入（use Trait）经方法调用隐式使用、pub use 是 re-export，静态无法判，auto-删会破坏代码
    analysis = await analyzeRustFile(content, file, langParserService)
  } else {
    analysis = await analyzeFileAST(content, lang, file, langParserService) || analyzeFile(content, lang, file)
  }

  for (const sym of analysis.undefinedSymbols) {
    const candidates = await findCandidates(codeIndexService, sym, file, maxCandidates)
    issues.push({
      type: 'undefined_symbol',
      symbol: sym,
      line: analysis.symbolLines[sym] || 0,
      suggestion: candidates.length > 0 ? importSuggestion(lang, candidates[0].module, sym) : `Define "${sym}" or add the appropriate import`,
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

  if (lang === 'rust') {
    // 8：Rust 未用导入只报告（启发式）——trait 隐式使用/re-export 无法静态判，绝不 auto-fix
    for (const iss of issues) {
      if (iss.type === 'unused_import') {
        iss.confidence = 'heuristic'
        iss.note = 'Rust trait imports (use Trait) may be used implicitly via methods; pub use re-exports are intentional API. Verify before removing — fix_imports never auto-removes Rust imports.'
      }
    }
  }

  // 10（F1）：JS/TS 相对导入是 ESM 常态，不当问题报；旧实现恒报且建议 Python 点分路径（乱码）
  if (lang !== 'javascript' && lang !== 'typescript') for (const rel of analysis.relativeImports) {
    issues.push({
      type: 'relative_import',
      relative: rel.relative,
      absolute: rel.absolute,
      line: rel.line,
      suggestion: `from ${rel.absolute} import ...`
    })
  }

  let fixesApplied = null
  if (autoFix && issues.length > 0 && lang !== 'rust') {
    fixesApplied = { imports_added: 0, imports_removed: 0 }
    const newLines = [...lines]

    const undefinedIssues = issues.filter(i => i.type === 'undefined_symbol' && i.candidates.length > 0 && i.candidates[0].module) // 10（F1）：空模块候选不给导入补丁，防插入 `from  import X` 腐蚀文件
    if (undefinedIssues.length > 0) {
      const seenModules = new Set()
      const stmts = undefinedIssues.map(i => {
        const c = i.candidates[0]
        if (seenModules.has(c.module)) return null
        seenModules.add(c.module)
        return importSuggestion(lang, c.module, i.symbol)
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

    // 合防护栏：写盘前语法验证，失败则不写（防误报转破坏）
    const guard = await verifySyntax(newLines.join('\n'), lang)
    if (guard.ok) {
      // r8(D5)：锁 + TOCTOU——auto_fix 分析全程数秒，窗口内文件可能被改；锁内重读比对一致才写
      const lock = await acquireLock(absPath, 30000)
      // r9(P1)：30s 争用超时 {locked:true} 无 release——旧代码 finally 调 release 抛 TypeError 逃逸出 handler
      if (lock.locked) {
        fixesApplied = null
        issues.push({ type: 'file_locked', message: 'File is locked by another writer (30s); re-run fix_imports.' })
      } else {
        try {
          const curNow = readFileSync(absPath, 'utf-8')
          if (curNow !== content) {
            fixesApplied = null
            issues.push({ type: 'file_changed_during_fix', message: 'File changed during analysis; re-run fix_imports.' })
          } else {
            writeFileSync(absPath, newLines.join('\n'), 'utf-8')
          }
        } finally {
          lock.release()
        }
      }
    } else {
      fixesApplied = null
      issues.push({ type: 'syntax_guard_blocked', message: `auto-fix would break syntax: ${guard.detail}` })
    }
  }

  const transactionReady = []
  if (!autoFix) {
    const undefinedIssues = issues.filter(i => i.type === 'undefined_symbol' && i.candidates.length > 0 && i.candidates[0].module) // 10（F1）：空模块候选不给导入补丁，防插入 `from  import X` 腐蚀文件
    if (undefinedIssues.length > 0) {
      const seenModules = new Set()
      const stmts = undefinedIssues.map(i => {
        const c = i.candidates[0]
        if (seenModules.has(c.module)) return null
        seenModules.add(c.module)
        return importSuggestion(lang, c.module, i.symbol)
      }).filter(Boolean)
      if (stmts.length > 0) {
        const insertLine = findImportInsertLine(lines) || 0
        // r52: insertLine=0（文件首行即代码）时 oldText='' → applyEdits 的 `if (!oldStr) continue` 静默跳过，补丁永远插不进；跳过该文件的事务补丁（autoFix 的 splice(0,0) 不受影响）
        if (insertLine > 0) {
          const oldText = lines.slice(0, insertLine).join('\n') + (insertLine > 0 ? '\n' : '')
          const newText = oldText + stmts.join('\n') + '\n'
          transactionReady.push({ file, old_string: oldText, new_string: newText })
        }
      }
    }

    if (lang !== 'rust') {
      // 8：Rust 只报告不给 transaction_ready 删除补丁——启发式有误报（trait/re-export），防用户盲用破坏代码
      // Y001-S2: block 类型整块删除（多行 import 全未用）
      for (const r of removals) {
        if (r.type === 'block') {
          transactionReady.push({ file, old_string: r.oldText, new_string: '' })
        } else if (r.type === 'partial') {
          transactionReady.push({ file, old_string: r.oldLine, new_string: r.newLine })
        } else {
          transactionReady.push({ file, old_string: r.oldLine, new_string: '' })
        }
      }
    }

    // 合防护栏：补丁集应用后的语法验证，失败则整体丢弃（防误报转破坏）
    if (transactionReady.length > 0) {
      const patched = [...lines]
      for (const r of removals) {
        if (r.type === 'block') {
          for (let k = r.startIdx; k <= r.endIdx && k < patched.length; k++) patched[k] = ''
          continue
        }
        if (r.lineIdx < 0 || r.lineIdx >= patched.length) continue
        patched[r.lineIdx] = r.type === 'partial' ? r.newLine : ''
      }
      // r54(P2): 语法护栏也模拟 import 插入——旧实现只模拟 removals，insertStmts 算后从未用，插入的 import 未过验证
      const insertStmts = transactionReady.filter(t => t.new_string.startsWith('from ') || t.new_string.startsWith('import '))
      if (insertStmts.length > 0) patched.splice(0, 0, ...insertStmts.map(s => s.new_string))
      const guard = await verifySyntax(patched.join('\n'), lang)
      if (!guard.ok) {
        transactionReady.length = 0
        issues.push({ type: 'syntax_guard_blocked', message: `proposed fixes would break syntax: ${guard.detail}` })
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
  // 10（F1）：导入行号集——usage 文本扫描排除 import 行本身，否则导入名在自己那行恒「被用」
  const importLineSet = new Set(imports.map(i => i.line))
  // Y001-S2：多行块行集——成员行不自身计 used（importLineSet 只含起始行）
  const blockLineSet = new Set()
  for (const imp of imports) {
    if (!imp.multiLine) continue
    for (let k = imp.blockStart; k <= imp.blockEnd; k++) blockLineSet.add(k)
  }
  for (const imp of imports) {
    if (imp.kind === 'side-effect' || !imp.name) continue
    // 10（F1）：unused 判定加文本扫描——捕获 net.createConnection / new X() / 值传递等非调用用法。
    // 旧实现只看 usedSymbols（仅 call）→ default/namespace 导入经成员访问被误报 unused（如 net）
    const isUnused = !usedSymbols.has(imp.name) && !isImportNameUsed(imp.name, lines, importLineSet, blockLineSet) && !imp.name.startsWith('_')
    if (!isUnused) continue
    const key = imp.key || `l${imp.line}`
    if (!groups.has(key)) groups.set(key, { line: imp.line, statement: imp.statement, stmtStart: imp.stmtStart, stmtEnd: imp.stmtEnd, specs: [], total: 0, multiLine: imp.multiLine === true, continuation: imp.continuation === true, blockStart: imp.blockStart, blockEnd: imp.blockEnd })
    const g = groups.get(key)
    g.specs.push({ name: imp.name, kind: imp.kind, specStart: imp.specStart, specEnd: imp.specEnd, specLine: imp.specLine })
  }
  for (const imp of imports) {
    if (imp.kind === 'side-effect' || !imp.name) continue
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
      // Y001-S2: 多行块——全未用 → 块级整删；部分未用 → 成员物理行级修剪（成员混排在起始行则跳过提示人工）
      if (g.multiLine && g.blockStart != null) {
        const allUnused = g.specs.length >= g.total
        if (allUnused) {
          for (const s of g.specs) {
            issues.push({ type: 'unused_import', import: g.statement, unused: [s.name], line: g.line })
          }
          removals.push({ type: 'block', startIdx: g.blockStart - 1, endIdx: g.blockEnd - 1, oldText: lines.slice(g.blockStart - 1, g.blockEnd).join('\n') })
          continue
        }
        const removable = g.specs.filter(s => s.specLine != null && s.specLine > g.line)
        // 债务5: 反斜杠续行块部分未用无法行级修剪（删成员行 → 悬空 \ 语法错），只块删安全
        if (g.continuation || removable.length !== g.specs.length) {
          for (const s of g.specs) {
            issues.push({ type: 'unused_import', import: g.statement, unused: [s.name], line: g.line, partial: true, skipped: 'multi-line import: manual fix required' })
          }
          continue
        }
        for (const s of g.specs) {
          issues.push({ type: 'unused_import', import: g.statement, unused: [s.name], line: g.line, partial: true })
          removals.push({ type: 'partial', lineIdx: s.specLine - 1, oldLine: lines[s.specLine - 1], newLine: '' })
        }
        continue
      }
      const lineText = lines[g.line - 1]
      if (lineText == null) continue
      // 单行 named import 部分未用 → 修剪而非整行删（防误删在用成员）
      if (g.specs.length < g.total && lineText.includes('} from')) {
        const pruned = pruneNamedImportLine(lineText, unusedNames)
        if (pruned !== null && pruned !== lineText) {
          issues.push({ type: 'unused_import', import: g.statement, unused: unusedNames, line: g.line, partial: true })
          removals.push({ type: 'partial', lineIdx: g.line - 1, oldLine: lineText, newLine: pruned })
          continue
        }
      }
      // 多行 import 部分未用：不自动删（跨行重写风险），提示人工
      if (g.specs.length < g.total && g.statement.includes('} from')) {
        issues.push({ type: 'unused_import', import: g.statement, unused: unusedNames, line: g.line, partial: true, skipped: 'multi-line import: manual fix required' })
        continue
      }
      for (const s of g.specs) {
        issues.push({ type: 'unused_import', import: g.statement, unused: [s.name], line: g.line })
      }
      removals.push({ type: 'whole', lineIdx: g.line - 1, oldLine: lineText })
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

// 无位置信息时的行文本修剪（正则路径）：按成员名匹配，保留在用成员
function pruneNamedImportLine(lineText, unusedNames) {
  const open = lineText.indexOf('{')
  const close = lineText.lastIndexOf('}')
  if (open === -1 || close === -1 || close < open) return null
  const inner = lineText.slice(open + 1, close)
  const items = inner.split(',').map(s => s.trim()).filter(Boolean)
  const kept = items.filter(s => {
    const n = s.split(/\s+as\s+/).pop().trim()
    return !unusedNames.includes(n)
  })
  if (kept.length === 0) return null
  return lineText.slice(0, open) + '{ ' + kept.join(', ') + ' }' + lineText.slice(close + 1)
}

function applyRemovals(newLines, removals) {
  let whole = 0, partial = 0
  for (const r of removals) {
    if (r.type === 'block') {
      for (let k = r.startIdx; k <= r.endIdx && k < newLines.length; k++) newLines[k] = ''
      whole++
      continue
    }
    if (r.lineIdx < 0 || r.lineIdx >= newLines.length) continue
    if (r.type === 'partial') { newLines[r.lineIdx] = r.newLine; partial++ }
    else { newLines[r.lineIdx] = ''; whole++ }
  }
  return { whole, partial }
}

async function analyzeRustFile(content, currentFile, langParser) {
  const lines = content.split('\n')
  const result = { imports: [], usedSymbols: new Set(), undefinedSymbols: [], symbolLines: Object.create(null), relativeImports: [] }
  let refs = []
  if (langParser) {
    try {
      const r = await langParser.extractAllAsync(content, '.rs')
      refs = r?.refs || []
      for (const s of r?.symbols || []) result.symbolLines[s.name] = s.startLine
    } catch {}
  }
  const useLines = new Set()
  for (const ref of refs) {
    if (ref.type !== 'import' || !ref.name) continue
    const stmt = (lines[ref.line - 1] || '').trim()
    // 8：pub use 是 re-export（公共 API），不报 unused
    if (/^pub\s+(?:\([^)]*\)\s+)?use\b/.test(stmt)) continue
    result.imports.push({ name: ref.name, line: ref.line, statement: stmt, kind: 'rust-use', module: ref.module || '', key: `l${ref.line}` })
    useLines.add(ref.line)
  }
  // usedSymbols：全文标识符扫描（排除 use 行与行注释）。保守方向——宁可多收（少报 unused）。
  // 块注释内的词不剥 → 只会多收 → 更少误报，安全。undefinedSymbols 恒空（rustc owns 未定义检测，避免误报）。
  // 注意：不用 BUILTINS_RS 过滤——那会把 HashMap/String 等的「使用」也滤掉，导致在用导入误报未用
  const idRe = /\b([a-zA-Z_]\w*)\b/g
  for (let i = 0; i < lines.length; i++) {
    if (useLines.has(i + 1)) continue
    const line = lines[i].replace(/\/\/.*$/, '')
    let m
    while ((m = idRe.exec(line)) !== null) {
      result.usedSymbols.add(m[1])
    }
  }
  return result
}

// 10（F1）：按语言生成导入建议语法——旧实现恒 Python `from X import Y`，对 JS/TS/Go/Rust 是乱码
function importSuggestion(lang, module, sym) {
  const mod = module || '...'
  if (lang === 'javascript' || lang === 'typescript') return `import { ${sym} } from '${mod}'`
  if (lang === 'go') return `import "${mod}" // ${sym}`
  if (lang === 'rust') return `use ${mod}::${sym};`
  return `from ${mod} import ${sym}`
}

// 10（F1）：导入名是否真被使用——全文标识符扫描（排除 import 行），捕获成员访问/构造/值传递等非调用用法
// Y001-S2：增加块行跳过——多行 import 成员行不计自身（否则部分未用检不出）
function isImportNameUsed(name, lines, importLineSet, blockLineSet) {
  const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
  for (let i = 0; i < lines.length; i++) {
    if (importLineSet.has(i + 1)) continue
    if (blockLineSet && blockLineSet.has(i + 1)) continue
    if (re.test(lines[i])) return true
  }
  return false
}

// 10（F1）：JS/TS 局部作用域收集（参数/局部声明/解构/catch）——与 regex 路径同源逻辑，parser 路径补齐用，
// 消除对局部量（resolve/reject/done 等）调用的 undefined_symbol 误报
function collectJsScope(content) {
  const locals = new Set()
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    const msMatch = trimmed.match(/^(?:async\s+)?(\w+)\s*\(([^)]*)\)\s*\{/)
    if (msMatch && !KEYWORDS.has(msMatch[1])) {
      locals.add(msMatch[1])
      for (const p of msMatch[2].split(',')) {
        const pname = p.trim().split(/[\s=]/)[0]
        if (pname && /^[a-zA-Z_]\w*$/.test(pname)) locals.add(pname)
      }
    }
    const destructMatch = trimmed.match(/^(?:const|let|var)\s+\{([^}]+)\}\s*=/)
    if (destructMatch) destructMatch[1].split(',').forEach(s => {
      const parts = s.trim().split(/\s*:\s*/); const name = (parts.length > 1 ? parts[1] : parts[0]).split(/[\s=]/)[0]
      if (name && /^[a-zA-Z_]\w*$/.test(name)) locals.add(name)
    })
    const arrDestructMatch = trimmed.match(/^(?:const|let|var)\s+\[([^\]]+)\]\s*=/)
    if (arrDestructMatch) arrDestructMatch[1].split(',').forEach(s => {
      const n = s.trim().split(/[\s=]/)[0]; if (n && /^[a-zA-Z_]\w*$/.test(n)) locals.add(n)
    })
    const declAssign = trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=/)
    if (declAssign) locals.add(declAssign[1])
    const bareDeclMatch = trimmed.match(/^(?:let|var)\s+([a-zA-Z_$][\w$]*(?:\s*,\s*[a-zA-Z_$][\w$]*)*)\s*$/)
    if (bareDeclMatch) bareDeclMatch[1].split(',').forEach(s => { const n = s.trim(); if (n) locals.add(n) })
    const forOfMatch = trimmed.match(/for\s+\((?:const|let|var)\s+(\w+)\s+(?:of|in)\s/)
    if (forOfMatch) locals.add(forOfMatch[1])
    const cForMatch = trimmed.match(/for\s*\(\s*(?:let|const|var)\s+(\w+)\s*=/)
    if (cForMatch) locals.add(cForMatch[1])
    const arrowParamRe = /(?:,\s*|\(\s*)(\w+(?:\s*,\s*\w+)*)\s*\)?\s*=>/g
    let apm
    while ((apm = arrowParamRe.exec(trimmed)) !== null) apm[1].split(',').forEach(s => { const n = s.trim(); if (n && /^[a-zA-Z_]\w*$/.test(n)) locals.add(n) })
    const arrowSingleRe = /([a-zA-Z_$][\w$]*)\s*=>/g
    let asm
    while ((asm = arrowSingleRe.exec(trimmed)) !== null) {
      const prev = trimmed[asm.index - 1] || ''
      if (prev !== '.' && !/[\w$]/.test(prev)) locals.add(asm[1])
    }
    const catchMatch = trimmed.match(/\bcatch\s*\(\s*([a-zA-Z_$][\w$]*)/)
    if (catchMatch) locals.add(catchMatch[1])
  }
  for (const kw of KEYWORDS) locals.delete(kw)
  return locals
}

async function analyzeFileAST(content, lang, currentFile, langParser) {
  if (!langParser || (lang !== 'javascript' && lang !== 'typescript')) return null
  const ext = lang === 'typescript' ? '.ts' : '.js'
  const lines = content.split('\n') // 7（T5）：旧引用未定义变量 lines → ReferenceError 被 catch 吞 → AST 分析恒死代码
  // Y001-S2: 多行块元数据（供 computeRemovals 块级删/成员行修剪；原 AST 路径多行整删残留后续行 → syntax_guard_blocked）
  const multiLineImports = extractMultiLineImports(lines, lang)
  const multiLineInfo = new Map()
  for (const m of multiLineImports) {
    if (!m.multiLine) continue
    if (!multiLineInfo.has(m.line)) multiLineInfo.set(m.line, { statement: m.statement, blockStart: m.blockStart, blockEnd: m.blockEnd, specLines: new Map() })
    multiLineInfo.get(m.line).specLines.set(m.name, m.specLine)
  }

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
      // 10（F1）：parser 路径补 JS 局部作用域——旧实现只有顶层符号+导入，对 resolve/reject/done 等局部量
      // 的调用被误报 undefined_symbol（regex 路径早有此分析，parser 路径漏了）
      if (lang === 'javascript' || lang === 'typescript') for (const n of collectJsScope(content)) definedSymbols.add(n)
      for (const ref of asyncResult.refs || []) {
        if (ref.type === 'call') usedSymbols.add(ref.name)
        if (ref.type === 'import') {
          const lineText = lines[ref.line - 1] || ''
          let members = ref.symbols || []
          // 兜底：parser 对 node:/裸导入不给 symbols 时，从行文本提取 {..} 成员（ESM named import）
          if (members.length === 0) {
            const bm = lineText.match(/^import\s+\{([^}]+)\}\s+from\s+['"]/)
            if (bm) members = bm[1].split(',').map(s => s.trim().split(/\s+as\s+/).pop().trim()).filter(Boolean)
          }
          const module = ref.module || ''
          // 副作用导入（import 'x.css' / import 'module' 无成员）：不参与 unused/undefined 判定
          if (!module && members.length === 0) {
            imports.push({ name: '', line: ref.line, statement: lineText, key: `l${ref.line}`, kind: 'side-effect', stmtStart: -1, stmtEnd: -1 })
            continue
          }
          const nsMatch = lineText.match(/^import\s+\*\s+as\s+(\w+)\s+from\s+['"]/)
          const dmatch = lineText.match(/^import\s+(\w+)\s+from\s+['"]/)
          const namespaceName = nsMatch?.[1] || ''
          const defaultName = dmatch?.[1] || ''
          const importNames = members.length > 0
            ? members
            : (namespaceName ? [namespaceName] : (defaultName ? [defaultName] : []))
          for (const symName of importNames) {
            definedSymbols.add(symName)
            const ml = multiLineInfo.get(ref.line)
            imports.push(ml
              ? { name: symName, line: ref.line, statement: ml.statement, key: `l${ref.line}`, kind: 'named', stmtStart: -1, stmtEnd: -1, multiLine: true, blockStart: ml.blockStart, blockEnd: ml.blockEnd, specLine: ml.specLines.get(symName) ?? -1 }
              : { name: symName, line: ref.line, statement: lineText, key: `l${ref.line}`, kind: 'named', stmtStart: -1, stmtEnd: -1 })
          }
          if (module.startsWith('.')) {
            relativeImports.push({ module, line: ref.line, relative: module, absolute: resolveRelativeImport(module, currentFile) || module })
          }
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

// 合防护栏：补丁集应用后的真实语法验证（node --check / python ast.parse），失败即弃
// r11(H2)：execFile 异步化——旧 spawnSync 同步子进程最长 8s 冻结整个 MCP 事件循环
function runSyntaxCheck(cmd, argsList) {
  return new Promise((resolve) => {
    execFile(cmd, argsList, { timeout: 8000 }, (err, _so, se) => resolve(err ? String(se || err.message).split('\n')[0] : null))
  })
}

async function verifySyntax(text, lang) {
  if (lang === 'python') {
    const tmp = join(os.tmpdir(), `fiximports-${process.pid}-${Date.now()}.py`)
    writeFileSync(tmp, text)
    try {
      const err = await runSyntaxCheck(getPythonCmd(), ['-c', `import ast; ast.parse(open(${JSON.stringify(tmp)}).read())`])
      return err ? { ok: false, detail: err } : { ok: true }
    } finally {
      try { unlinkSync(tmp) } catch {}
    }
  }
  if (lang === 'javascript') {
    const tmp = join(os.tmpdir(), `fiximports-${process.pid}-${Date.now()}.js`)
    writeFileSync(tmp, text)
    try {
      const err = await runSyntaxCheck(process.execPath, ['--check', tmp])
      return err ? { ok: false, detail: err } : { ok: true }
    } finally {
      try { unlinkSync(tmp) } catch {}
    }
  }
  if (lang === 'typescript') {
    // node --check 不认 TS 语法：括号平衡兜底
    const b = checkBracketBalance(text)
    return b.ok ? { ok: true } : { ok: false, detail: b.detail }
  }
  return { ok: true }
}

// 多行 import 块压平（JS/TS `import {…}` + Python `from x import (…)` + Python 反斜杠续行，行号 = 起始行）
// Y001-S2: 成员带块元数据（blockStart/blockEnd 1-based + specLine 成员物理行），
// 使 computeRemovals 能做块级整删 / 成员行级修剪（原 JS 多行部分未用只报不删、Python 直接放弃）
// Y001 债务5: Python 反斜杠续行（`from x import a, \` + `    b`）同括号块压平（原续行行不匹配逐行
// 正则 → 续行成员 undefined_symbol 误报 + 残留无法修；ast.parse 背书续行合法，可安全自动删）
function extractMultiLineImports(lines, lang) {
  const result = []
  if (lang === 'python') {
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim()
      const m = t.match(/^from\s+(\S+)\s+import\s+\(([^)]*)$/)
      if (m) {
        // r10e：首行行尾注释（`import (  # noqa: E402`）必须在拼接前剥除——
        // 注释在续行成员之前，flat 后剥会把第一个成员一起删（q3_lite_real ensure_worktree 丢失）
        const block = [t.replace(/#.*$/, '')]
        let j = i + 1
        while (j < lines.length && !lines[j].includes(')')) {
          block.push(lines[j])
          j++
        }
        if (j >= lines.length) continue
        const endIdx = j
        const flat = [...block, lines[endIdx]].join(' ').replace(/\s+/g, ' ')
        const fm = flat.match(/^from\s+\S+\s+import\s+\(([^)]*)\)\s*$/)
        if (!fm) continue
        for (const s of fm[1].split(',')) {
          // r10e：剥行尾注释——`import (  # noqa: E402` 首行注释混入 flat 后污染成员名
          const specText = s.trim().replace(/#.*$/, '')
          if (!specText) continue
          const name = specText.split(/\s+as\s+/).pop().trim()
          if (!name || name === '*') continue
          result.push({
            name,
            module: m[1],
            line: i + 1,
            statement: flat,
            multiLine: true,
            blockStart: i + 1,
            blockEnd: endIdx + 1,
            specLine: locateSpecLine(lines, i, endIdx, specText),
          })
        }
        i = endIdx
        continue
      }
      // 反斜杠续行：起始行以 \ 结尾，块结束于首个非 \ 结尾行
      if (!/^(?:from\s+\S+\s+)?import\s+/.test(t) || !t.endsWith('\\')) continue
      const block = [t.replace(/#.*$/, '')]
      let j = i + 1
      while (j < lines.length && lines[j].trim().endsWith('\\')) {
        block.push(lines[j])
        j++
      }
      if (j >= lines.length) continue
      const endIdx = j
      block.push(lines[endIdx])
      const flat = block.join(' ').replace(/\\/g, '').replace(/\s+/g, ' ').trim()
      const fm = flat.match(/^(?:from\s+(\S+)\s+)?import\s+(.+)$/)
      if (!fm) continue
      for (const s of fm[2].split(',')) {
        const specText = s.trim()
        if (!specText) continue
        const name = specText.split(/\s+as\s+/).pop().trim()
        if (!name || name === '*') continue
        result.push({
          name,
          module: fm[1] || '',
          line: i + 1,
          statement: flat,
          multiLine: true,
          // 债务5: 续行块成员行级修剪会破坏续行链（删成员行 → 悬空 \ 语法错），
          // 仅块删安全——computeRemovals 据此对部分未用走 skipped
          continuation: true,
          blockStart: i + 1,
          blockEnd: endIdx + 1,
          specLine: locateSpecLine(lines, i, endIdx, specText),
        })
      }
      i = endIdx
    }
    return result
  }
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim()
    if (t.startsWith('import {') && !t.includes('} from')) {
      const block = [t]
      let j = i + 1
      while (j < lines.length && !lines[j].includes('} from')) {
        block.push(lines[j])
        j++
      }
      if (j < lines.length) {
        const endIdx = j
        const flat = [...block, lines[endIdx]].join(' ').replace(/\s+/g, ' ')
        const m = flat.match(/^import\s+\{([^}]+)\}\s+from\s+['"][^'"]+['"]\s*;?\s*$/)
        if (m) {
          for (const s of m[1].split(',')) {
            const specText = s.trim()
            if (!specText) continue
            const name = specText.split(/\s+as\s+/).pop().trim()
            if (!name) continue
            result.push({
              name,
              line: i + 1,
              statement: flat,
              multiLine: true,
              blockStart: i + 1,
              blockEnd: endIdx + 1,
              specLine: locateSpecLine(lines, i, endIdx, specText),
            })
          }
        }
        i = endIdx
      }
    }
  }
  return result
}

// Y001-S2: 成员物理行反查（1-based；按 spec 首词匹配 `name,` / `name as x,`，找不到返回 -1）
function locateSpecLine(lines, startIdx, endIdx, specText) {
  const first = specText.split(/\s+/)[0]
  const esc = first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`^\\s*${esc}\\s*(,|as\\s+|$)`)
  for (let k = startIdx; k <= endIdx; k++) {
    if (re.test(lines[k])) return k + 1
  }
  return -1
}

function detectLanguage(filePath) {
  if (filePath.endsWith('.py')) return 'python'
  if (filePath.endsWith('.js') || filePath.endsWith('.mjs') || filePath.endsWith('.cjs') || filePath.endsWith('.jsx')) return 'javascript'
  if (filePath.endsWith('.ts') || filePath.endsWith('.tsx') || filePath.endsWith('.mts') || filePath.endsWith('.cts')) return 'typescript'
  if (filePath.endsWith('.go')) return 'go'
  if (filePath.endsWith('.rs')) return 'rust'
  return 'unknown'
}

export function analyzeFile(content, lang, currentFile = '') {
  const lines = content.split('\n')
  const definedSymbols = new Set()
  const usedSymbols = new Set()
  const imports = []
  const undefinedSymbols = []
  const symbolLines = Object.create(null)
  const relativeImports = []
  const multiLineImports = extractMultiLineImports(lines, lang)
  // Y001-S2: 多行块行集合——块内行不再参与逐行 import 解析 / usage 扫描（防残缺成员与自身计 used）
  const multiLineBlockLines = new Set()
  for (const m of multiLineImports) {
    if (!m.multiLine) continue
    for (let k = m.blockStart; k <= m.blockEnd; k++) multiLineBlockLines.add(k)
  }

  const pyImportRe = /^(?:from\s+(\S+)\s+)?import\s+(.+)$/
  const importLineRe = lang === 'python'
    ? pyImportRe
    : /^(?:import\s+|const\s+(?:\{[^}]+\}|\w+)\s*=\s*(?:require\(|(?:await\s+)?import\())/

  const defRe = /^(?:\s*)(?:export\s+)?(?:async\s+)?(?:function\s+|def\s+|class\s+|const\s+(\S+)\s*=|let\s+(\S+)\s*=|var\s+(\S+)\s*=)/

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()

    if (lang === 'python') {
      // Y001-S2: 已压平的多行块行跳过（否则起始行 `from x import (a,` 产生残缺成员）
      if (multiLineBlockLines.has(i + 1)) continue
      const importMatch = trimmed.match(pyImportRe)
      if (importMatch) {
        const module = importMatch[1] || ''
        if (module.startsWith('.')) {
          const absModule = resolveRelativeImport(module, currentFile)
          relativeImports.push({ relative: module, absolute: absModule, line: i + 1 })
        }
        const specText = (importMatch[2] || '').replace(/#.*$/, '').replace(/^\(|\)$/g, '') // 7：from x import (a, b) 括号剥除，否则名含 '(' 报 undefined；r10e：剥行尾注释（# noqa 等污染成员名）
        const names = specText.split(',').map(s => {
          const parts = s.trim().split(/\s+as\s+/)
          return { name: parts[parts.length - 1].trim(), line: i + 1, statement: trimmed }
        }).filter(n => n.name && n.name !== '*') // 7：`from os import *` 通配导入永不 used → 删行 = 运行时 NameError
        // 7（T8）：`import os.path` 使用判定按首段（代码引用 os）；`import a, b` 逐项取首段
        const normalized = names.map(n => ({ ...n, name: n.name.split('.')[0] }))
        imports.push(...normalized)
      }
    } else {
      let jm
      if (trimmed.startsWith('import type ')) {
        // 7（T13）：TS 类型导入跳过——import type { Foo } 捕获 'type' → 恒真误报删除合法导入
      } else if ((jm = trimmed.match(/^import\s+\{([^}]+)\}\s+from\s+['"]/))) {
        jm[1].split(',').forEach(s => {
          let name = s.trim().split(/\s+as\s+/).pop().trim()
          name = name.replace(/^type\s+/, '') // 7：import { type Bar, used } 的内联 type 修饰
          if (name) imports.push({ name, line: i + 1, statement: trimmed })
        })
      } else if ((jm = trimmed.match(/^import\s+(\w+)\s*,\s*\{([^}]+)\}\s+from\s+['"]/))) {
        // 7（T9）：import React, { useState } from 'react'（默认+命名混合）旧全不匹配 → useState 报 undefined
        imports.push({ name: jm[1], line: i + 1, statement: trimmed })
        jm[2].split(',').forEach(s => {
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

    const strippedDef = trimmed.replace(/^(?:export|async)\s+(?:export|async)\s+/, '').replace(/^(?:export|async)\s+/, '')
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
      const arrDestructMatch = trimmed.match(/^(?:const|let|var)\s+\[([^\]]+)\]\s*=/)
      if (arrDestructMatch) {
        arrDestructMatch[1].split(',').forEach(s => {
          const n = s.trim().split(/[\s=]/)[0]
          if (n && /^[a-zA-Z_]\w*$/.test(n)) definedSymbols.add(n)
        })
      }
      const bareDeclMatch = trimmed.match(/^(?:let|var)\s+([a-zA-Z_$][\w$]*(?:\s*,\s*[a-zA-Z_$][\w$]*)*)\s*$/)
      if (bareDeclMatch) {
        bareDeclMatch[1].split(',').forEach(s => { const n = s.trim(); if (n) definedSymbols.add(n) })
      }
      const forOfMatch = trimmed.match(/for\s+\((?:const|let|var)\s+(\w+)\s+(?:of|in)\s/)
      if (forOfMatch) definedSymbols.add(forOfMatch[1])
      const cForMatch = trimmed.match(/for\s*\(\s*(?:let|const|var)\s+(\w+)\s*=/)
      if (cForMatch) definedSymbols.add(cForMatch[1])
      const arrowParamRe = /(?:,\s*|\(\s*)(\w+(?:\s*,\s*\w+)*)\s*\)?\s*=>/g
      let apm
      while ((apm = arrowParamRe.exec(trimmed)) !== null) {
        apm[1].split(',').forEach(s => { const n = s.trim(); if (n && /^[a-zA-Z_]\w*$/.test(n)) definedSymbols.add(n) })
      }
      // 无括号单参数 arrow（如 new Promise(resolve => ...)）：=> 左侧标识符即参数
      const arrowSingleRe = /([a-zA-Z_$][\w$]*)\s*=>/g
      let asm
      while ((asm = arrowSingleRe.exec(trimmed)) !== null) {
        const prev = trimmed[asm.index - 1] || ''
        if (prev !== '.' && !/[\w$]/.test(prev)) definedSymbols.add(asm[1])
      }
    }

    if (lang === 'python') {
      // r10e：多目标赋值 `st, en = f()` / 星号解包 `a, *rest = x`——旧正则只认行首单名 → st/en 误报 undefined
      const assignMatch = trimmed.match(/^((?:\([^)]*\)|\[[^\]]*\]|[a-zA-Z_]\w*|\*[a-zA-Z_]\w*)(?:\s*,\s*(?:\([^)]*\)|\[[^\]]*\]|[a-zA-Z_]\w*|\*[a-zA-Z_]\w*))*)\s*(?::\s*[\w\[\], |]+)?\s*=[^=]/)
      if (assignMatch) {
        const targets = assignMatch[1]
          .replace(/\(|\)|\[|\]/g, '')
          .split(',')
          .map(s => s.trim().replace(/^\*+/, ''))
          .filter(Boolean)
        for (const t of targets) {
          if (/^[a-zA-Z_]\w*$/.test(t) && !KEYWORDS.has(t)) { definedSymbols.add(t); symbolLines[t] = i + 1 }
        }
      }

      // r10e：链式赋值 `a = b = c = 0`——旧正则只收行首 a → b/c 误报；`x == y` 排除；
      // 关键字参数 f(a=1) 误收无害（少报方向）
      for (const cm of trimmed.matchAll(/([a-zA-Z_]\w*)\s*=(?!=)/g)) {
        const cname = cm[1]
        if (!KEYWORDS.has(cname)) { definedSymbols.add(cname); symbolLines[cname] = i + 1 }
      }

      const paramMatch = trimmed.match(/def\s+\w+\s*\(([^)]*)\)/)
      if (paramMatch) {
        for (const p of paramMatch[1].split(',')) {
          // r10e：剥 *args/**kwargs 星号——`def f(*a, **kw)` 的 a/kw 使用时报 undefined
          const pname = p.trim().replace(/^\*+/, '').split(/[\s:=]/)[0]
          if (pname && /^[a-zA-Z_]\w*$/.test(pname)) definedSymbols.add(pname)
        }
      }

      // r10e：lambda 参数收集——`key=lambda x: -x[1]` 的 x 在体内使用；`lambda *args:` 剥 *
      const lambdaMatch = trimmed.match(/lambda\s+([^:]+):/)
      if (lambdaMatch) {
        for (const lp of lambdaMatch[1].split(',')) {
          const lname = lp.trim().replace(/^\*+/, '').split(/[=)]/)[0]
          if (lname && /^[a-zA-Z_]\w*$/.test(lname)) definedSymbols.add(lname)
        }
      }

      const exceptMatch = trimmed.match(/except\s+.*\s+as\s+([a-zA-Z_]\w*)/)
      if (exceptMatch) definedSymbols.add(exceptMatch[1])

      // r10e：for 元组/嵌套解包/列表推导——`for (a, b) in` / `for i, (fpath, score) in` /
      // `[y for y in z]` / 跨行推导（`for k, v in\n    pairs`，trim 后行尾 in 无空白 → in(?: |$)）。
      // 注释/字符串误收无害（少报方向）
      for (const fm of trimmed.matchAll(/for\s+([^:]+?)\s+in(?:\s|$)/g)) {
        const targets = fm[1].replace(/\(|\)|\[|\]/g, '').split(',')
        for (const t of targets) {
          const name = t.trim().replace(/^\*+/, '')
          if (/^[a-zA-Z_]\w*$/.test(name)) definedSymbols.add(name)
        }
      }

      // r10e：多 with as `with open(a) as f1, open(b) as f2`——旧正则只抓最后一个 → f1 误报
      const withMatch = trimmed.match(/with\s+([^:]+):/)
      if (withMatch) {
        for (const am of withMatch[1].matchAll(/(?:\s|^)as\s+([a-zA-Z_]\w*)/g)) {
          definedSymbols.add(am[1])
        }
      }
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

  // r10e：多行 def 参数收集——`def f(\n    a: int,\n    b: str) -> T:` 单行 paramMatch 漏收 → 参数误报 undefined
  if (lang === 'python') {
    const dlines = content.split('\n')
    for (let di = 0; di < dlines.length; di++) {
      if (!/^\s*def\s+\w+\s*\(/.test(dlines[di])) continue
      let depth = 0
      let sig = ''
      let dj = di
      for (; dj < dlines.length; dj++) {
        sig += ' ' + dlines[dj].trim()
        for (const c of dlines[dj]) {
          if (c === '(') depth++
          else if (c === ')') { depth--; if (depth <= 0) break }
        }
        if (depth <= 0) break
      }
      const pm = /def\s+\w+\s*\(([\s\S]*)\)\s*(?::|->|$)/.exec(sig)
      if (!pm) continue
      for (const p of pm[1].split(',')) {
        // r10e：多行 def 同样剥 *args/**kwargs 星号
        const pname = p.trim().replace(/^\*+/, '').split(/[\s:=]/)[0]
        if (pname && /^[a-zA-Z_]\w*$/.test(pname) && !KEYWORDS.has(pname)) {
          definedSymbols.add(pname)
        }
      }
    }
  }

  const builtins = BUILTINS_MAP[lang] || BUILTINS_PY

  const cleaned = stripCommentsAndStrings(content, lang)
  const cleanedLines = cleaned.split('\n')
  const idRe = /(?<!\.)\b([a-zA-Z_]\w*)/g
  for (let li = 0; li < cleanedLines.length; li++) {
    const cl = cleanedLines[li].trim()
    // Y001-S2: 多行块行不自身计 used（否则块内成员名恒「被用」，部分未用检不出）
    if (!cl || importLineRe.test(cl) || multiLineBlockLines.has(li + 1)) continue
    for (const m of cl.matchAll(idRe)) {
      const name = m[1]
      const after = cl.slice(m.index + name.length).trimStart()
      if (after.startsWith('=') && !after.startsWith('==')) continue
      if (after.startsWith(':') && !after.startsWith('::')) continue
      // r10e：bytes/raw/f-string 前缀字面量（b"..." f"..." r"..."）——b/f/r 不是变量
      if (after.startsWith('"') || after.startsWith("'")) continue
      if (!builtins.has(name)) {
        usedSymbols.add(name)
      }
    }
  }

  if (lang === 'python') {
    // r10e：锚定行首（`^\s*`）——旧正则把 `{0: "forward"}` 的字符串值当类型注解（dict 值误报）
    const stringAnnotationRe = /^\s*[A-Za-z_]\w*\s*:\s*["']([A-Za-z_]\w*(?:\s*\|\s*[A-Za-z_]\w*)*)["']/gm
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

  imports.push(...multiLineImports)
  imports.forEach(imp => definedSymbols.add(imp.name))

  // Y001-S2: Python 多行块相对导入重建（块行跳过逐行解析后此处补齐，按块去重）
  if (lang === 'python') {
    const seenBlocks = new Set()
    for (const m of multiLineImports) {
      if (!m.module?.startsWith('.') || seenBlocks.has(m.blockStart)) continue
      seenBlocks.add(m.blockStart)
      const absModule = resolveRelativeImport(m.module, currentFile)
      relativeImports.push({ relative: m.module, absolute: absModule, line: m.line })
    }
  }

  for (const sym of usedSymbols) {
    if (KEYWORDS.has(sym) || SPECIAL.has(sym) || builtins.has(sym) || sym.startsWith('__') || sym === '_') continue
    if (sym === sym.toUpperCase() && sym.length > 2) continue
    if (sym.includes('.')) continue
    if (!definedSymbols.has(sym)) {
      undefinedSymbols.push(sym)
    }
  }

  return { definedSymbols, usedSymbols, imports, undefinedSymbols: [...new Set(undefinedSymbols)], symbolLines, relativeImports }
}

// r10e：转义感知的字符串闭合查找（处理 \' \" 与三引号）
function findStringClose(s, start, closeSeq) {
  for (let i = start; i + closeSeq.length <= s.length; i++) {
    if (s[i] === '\\') { i++; continue }
    if (s.slice(i, i + closeSeq.length) === closeSeq) return i
  }
  return -1
}

// r10e：f-string 提取 {expr} 内标识符（与旧正则逻辑一致）
function extractFStringExprs(inner) {
  let out = ''
  // r10e：双花括号转义（{{...}} 是字面量输出，不是表达式）——旧正则把 {{expansions, recall}} 当 expr → 全误报
  const re = /\{\{|\}\}|\{([^{}]*)\}/g
  let mm
  while ((mm = re.exec(inner)) !== null) {
    if (mm[0] === '{{' || mm[0] === '}}') continue
    const expr = mm[1]
      .replace(/['"][^'"]*['"]/g, ' ')
      .replace(/\s*\.\s*\w+(?:\s*\([^)]*\))?/g, '') // 属性访问/方法调用 → 只留对象名
      .replace(/[^\w\s_]/g, ' ')
    out += ' ' + expr + ' '
  }
  return out || ' '
}

// r10e：字符级扫描版字符串/注释剥除——旧正则对交替引号（strip('"').strip("'")）互相错位
// → 跨行吞代码（targeted_supplement.py 行 27 后 URL 全残留）。状态机一次 pass，
// 字符串内 #/引号天然安全；顺带覆盖三引号 f-string（f"""..."""）与 b/r/u 前缀。
function stripPyCommentsAndStrings(s) {
  let out = ''
  let i = 0
  while (i < s.length) {
    const ch = s[i]
    if (ch === '#') {
      while (i < s.length && s[i] !== '\n') { i++ }
      out += ' '
      continue
    }
    if ((ch === 'b' || ch === 'r' || ch === 'u' || ch === 'B' || ch === 'R' || ch === 'U') && (s[i + 1] === '"' || s[i + 1] === "'")) {
      out += ' '; i++
      continue
    }
    if ((ch === 'f' || ch === 'F') && (s[i + 1] === '"' || s[i + 1] === "'")) {
      const q = s[i + 1]
      const triple = s[i + 2] === q && s[i + 3] === q
      const start = triple ? i + 4 : i + 2
      const close = triple ? q + q + q : q
      const end = findStringClose(s, start, close)
      if (end === -1) { out += ' '; i++; continue }
      out += extractFStringExprs(s.slice(start, end))
      i = end + close.length
      continue
    }
    if (ch === '"' || ch === "'") {
      const q = ch
      const triple = s[i + 1] === q && s[i + 2] === q
      const start = triple ? i + 3 : i + 1
      const close = triple ? q + q + q : q
      const end = findStringClose(s, start, close)
      if (end === -1) { out += ' '; i++; continue }
      out += ' '
      i = end + close.length
      continue
    }
    out += ch
    i++
  }
  return out
}

function stripCommentsAndStrings(content, lang) {
  let s = content
  if (lang === 'python') {
    // r10e：状态机替换整段正则（f-string/前缀/双单引号/三引号/# 注释一次 pass）
    return stripPyCommentsAndStrings(content)
  } else {
    s = s.replace(/\/\*[\s\S]*?\*\//g, ' ')
    // r10e：`//` 注释剥除放最后——先剥模板字符串/正则/字符串（内部 // 随之消失），再剥真注释；
    // 旧顺序：模板字符串内的 // 被先破坏 → 反引号不闭合 → 跨行吞代码（与 python # 同 bug）
    s = s.replace(/`(?:[^`\\]|\\.)*`/g, m => {
      // 模板字符串：只保留 ${expr} 表达式中的标识符（剥掉字符串字面量），普通文本弃掉
      let rest = m
      const parts = []
      let mm
      while ((mm = /\$\{([^{}]*)\}/.exec(rest)) !== null) {
        parts.push(mm[1].replace(/['"][^'"]*['"]/g, ' '))
        rest = rest.slice(mm.index + mm[0].length)
      }
      return ' ' + parts.join(' ') + ' '
    })
    // 7（T11）：旧正则剥除只看 body 首字符非空格——`a/b/c` 除法链 body 首字符 'a' 也非空格 → 误剥。
    // 正则字面量只在前置字符是「表达式开符」（=([{:;,!&|? 或行首）时剥除；return /re/ 等场景
    // 转为不剥（安全方向：漏剥最多误报 undefined，误剥会删在用导入）
    s = s.replace(/(^|[=([{:;,!&|?])\s*\/((?:\\.|[^\\/\n])(?:(?:[^\\/\n]|\\.)*?))\/([gimsuy]*)/g, '$1 ')
    s = s.replace(/"(?:[^"\\]|\\.)*"/g, ' ')
    s = s.replace(/'(?:[^'\\]|\\.)*'/g, ' ')
    s = s.replace(/\/\/.*$/gm, ' ')
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
  // r10e：候选只认「别处的顶层定义」——旧实现用 getReferences（使用点）当候选，局部变量
  // 只要在别文件碰巧出现过就被建议 `from x import v`（荒谬修复）。查定义后局部变量
  // （parent_id 非空）天然排除；无 findDefinitions 的旧 service 保守返回 []（不给补丁）。
  try {
    const defs = (await codeIndexService.findDefinitions?.(symbol)) || []
    return defs
      .filter(d => d.path !== file)
      .slice(0, maxCandidates)
      .map(d => ({
        module: fileToModule(d.path),
        name: symbol,
        line: d.start_line || 0
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
