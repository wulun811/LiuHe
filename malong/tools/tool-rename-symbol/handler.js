import { join } from 'node:path'
import { readFileSync, readdirSync } from 'node:fs'
import { TransactionStore } from '../tool-edit-transaction/transaction-store.js'
import { scanCjsRequires } from '../../cjs-imports.js'

const SOURCE_EXTS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts', '.py', '.go', '.rs', '.java', '.rb', '.php'])

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function getStringRanges(line) {
  const ranges = []
  let i = 0
  while (i < line.length) {
    const ch = line[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      const start = i
      i++
      while (i < line.length && line[i] !== ch) {
        if (line[i] === '\\') i++
        i++
      }
      ranges.push([start, i])
    } else if (ch === '/' && line[i + 1] === '/') {
      ranges.push([i, line.length])
      break
    } else if (ch === '/' && line[i + 1] === '*') {
      const end = line.indexOf('*/', i + 2)
      ranges.push([i, end === -1 ? line.length : end + 2])
      i = end === -1 ? line.length : end + 2
      continue
    } else if (ch === '#') {
      ranges.push([i, line.length])
      break
    }
    i++
  }
  return ranges
}

function replaceOutsideStrings(line, re, replacement) {
  const ranges = getStringRanges(line)
  let result = ''
  let lastEnd = 0
  let m
  re.lastIndex = 0
  while ((m = re.exec(line)) !== null) {
    const inString = ranges.some(([s, e]) => m.index >= s && m.index < e)
    if (!inString) {
      result += line.slice(lastEnd, m.index) + replacement
      lastEnd = m.index + m[0].length
    }
  }
  result += line.slice(lastEnd)
  return result
}

function findTextRefs(workspaceDir, symbol, maxFiles = 300, maxResults = 100) {
  const results = []
  const re = new RegExp(`\\b${escapeRegex(symbol)}\\b`)
  const scanned = { files: 0 }
  walk(workspaceDir, workspaceDir, re, results, scanned, maxFiles, maxResults)
  return results
}

// 15（P2）：作用域保护——被改名符号在本文件的局部绑定名 ≠ symbol 时，只允许改 import 行。
// 例：app.js `const { process: libProcess } = require('./lib.js')` 局部绑定名是 libProcess，
// 裸 token `process`（如 process.env 的 Node 全局）与 lib.js::process 无关，改名不应连坐。
// 若存在同名的同形绑定（`{ process }` / `import { process }`）则保守放行全部（改错比漏改安全）。
function computeScopeRestriction(content, symbol) {
  const lines = content.split('\n')
  const aliasedLines = new Set()
  let bindsSameName = false

  for (const imp of scanCjsRequires(content)) {
    if (!imp.aliasMap) continue
    for (const [local, original] of Object.entries(imp.aliasMap)) {
      if (original !== symbol) continue
      if (local === symbol) bindsSameName = true
      else aliasedLines.add(imp.line)
    }
  }

  const asRe = new RegExp(`\\b${escapeRegex(symbol)}\\s+as\\s+(\\w+)`, 'g')
  for (let i = 0; i < lines.length; i++) {
    let m
    asRe.lastIndex = 0
    while ((m = asRe.exec(lines[i])) !== null) {
      if (m[1] === symbol) bindsSameName = true
      else aliasedLines.add(i + 1)
    }
  }

  return bindsSameName ? null : (aliasedLines.size ? aliasedLines : null)
}

function walk(baseDir, dir, re, results, scanned, maxFiles, maxResults) {
  if (scanned.files >= maxFiles || results.length >= maxResults) return
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    if (scanned.files >= maxFiles || results.length >= maxResults) break
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '__pycache__' || entry.name === 'venv' || entry.name === 'dist' || entry.name === 'build') continue
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(baseDir, fullPath, re, results, scanned, maxFiles, maxResults)
    } else if (entry.isFile()) {
      const ext = fullPath.slice(fullPath.lastIndexOf('.'))
      if (!SOURCE_EXTS.has(ext)) continue
      scanned.files++
      const relPath = fullPath.startsWith(baseDir + '/') ? fullPath.slice(baseDir.length + 1) : fullPath
      try {
        const lines = readFileSync(fullPath, 'utf-8').split('\n')
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            results.push({ path: relPath, line: i + 1, context: lines[i].trim() })
            if (results.length >= maxResults) break
          }
        }
      } catch {}
    }
  }
}

export async function handle(args, context) {
  const { codeIndexService, getWorkspaceDir } = context
  const workspaceDir = args?.workspace_dir

  if (!workspaceDir) {
    return { error: 'missing_parameter', message: 'workspace_dir is required' }
  }

  const symbol = args?.symbol
  const newName = args?.new_name
  let file = args?.file
  const dryRun = args?.dry_run !== false

  if (!symbol || !newName || !file) {
    return { error: 'missing_parameter', message: 'symbol, new_name, and file are required' }
  }

  if (symbol === newName) {
    return { error: 'invalid_input', message: 'new_name must differ from symbol' }
  }

  // 验证 new_name 是合法标识符
  if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(newName)) {
    return { error: 'invalid_input', message: `"${newName}" is not a valid identifier. Must match /^[a-zA-Z_$][a-zA-Z0-9_$]*$/` }
  }

  codeIndexService?.initWorkspace(workspaceDir)

  // 16：file 参数共用守卫——定义文件无效（目录/不存在）时提前返回，不再静默 definition=null
  if (codeIndexService?.resolveFileArg) {
    const resolved = codeIndexService.resolveFileArg(file)
    if (!resolved.ok) return { error: resolved.error.code, message: resolved.error.message, suggestion: resolved.error.suggestion }
    file = resolved.path
  }

  let semanticRefs = []
  if (codeIndexService) {
    try { semanticRefs = await codeIndexService.getReferences(symbol) || [] } catch {}
  }

  const textRefs = findTextRefs(workspaceDir, symbol)

  const seen = new Set()
  const allRefs = []
  for (const r of [...textRefs, ...semanticRefs.map(s => ({ path: s.path, line: 0, context: '' }))]) {
    const key = `${r.path}:${r.line}`
    if (!seen.has(key)) { seen.add(key); allRefs.push(r) }
  }

  if (allRefs.length === 0) {
    return { error: 'not_found', message: `No references found for "${symbol}"`, suggestion: `Call reindex(workspace_dir="${workspaceDir}") to update the index` }
  }

  const byFile = new Map()
  for (const ref of allRefs) {
    if (!ref?.path) continue // 脏数据防御（索引缺 path 字段时不崩 handler）
    if (!byFile.has(ref.path)) byFile.set(ref.path, [])
    byFile.get(ref.path).push(ref)
  }

  const editsPerFile = []
  let totalEdits = 0

  for (const [relPath, refs] of byFile) {
    const absPath = join(workspaceDir, relPath)
    let content
    try { content = readFileSync(absPath, 'utf-8') } catch { continue }

    // 15（P2）：别名绑定文件（局部名 ≠ symbol）只改 import 行，裸 token 不改
    const scopeRestriction = computeScopeRestriction(content, symbol)

    const lines = content.split('\n')
    const wordRe = new RegExp(`\\b${escapeRegex(symbol)}\\b`, 'g')
    const fileEdits = []

    for (const ref of refs) {
      const lineIdx = ref.line - 1
      if (lineIdx < 0 || lineIdx >= lines.length) continue
      if (scopeRestriction && !scopeRestriction.has(ref.line)) continue
      const line = lines[lineIdx]
      if (!wordRe.test(line)) continue
      wordRe.lastIndex = 0

      const stripped = line.replace(/(['"`])(?:(?!\1).)*\1/g, '""')
      if (!wordRe.test(stripped)) continue
      wordRe.lastIndex = 0

      const newLine = replaceOutsideStrings(line, wordRe, newName)
      if (newLine !== line) {
        fileEdits.push({ line: ref.line, old: line, new: newLine })
      }
    }

    if (fileEdits.length > 0) {
      editsPerFile.push({ file: relPath, edits: fileEdits })
      totalEdits += fileEdits.length
    }
  }

  if (totalEdits === 0) {
    return { symbol, new_name: newName, files_changed: 0, total_edits: 0, message: 'No word-boundary matches found (all matches may be in strings/comments)' }
  }

  let definition = null
  if (codeIndexService) {
    try {
      const syms = await codeIndexService.getSymbols(file)
      const def = (syms || []).find(s => s.name === symbol)
      if (def) definition = { file, line: def.start_line, type: def.type }
    } catch {}
  }

  let conflictWarning = null
  if (codeIndexService) {
    try {
      const existing = await codeIndexService.searchSymbols(newName)
      if (existing && existing.length > 0) {
        conflictWarning = `"${newName}" already exists as ${existing[0].type} in ${existing[0].file}`
      }
    } catch {}
  }

  let affectedCallers = []
  if (codeIndexService) {
    try {
      const callers = await codeIndexService.getCallers(symbol)
      affectedCallers = [...new Set((callers || []).map(c => c.caller_file))].slice(0, 10)
    } catch {}
  }

  const result = {
    symbol,
    new_name: newName,
    dry_run: dryRun,
    files_changed: editsPerFile.length,
    total_edits: totalEdits,
    edits_per_file: editsPerFile,
    definition,
    conflict_warning: conflictWarning,
    affected_callers: affectedCallers.length > 0 ? affectedCallers : undefined,
    next_step: dryRun
      ? `Apply: rename_symbol(..., dry_run=false). Then verify: test_bridge(action="run")`
      : `Verify: test_bridge(action="run"). Check mocks: mock_sync(file="${file}", function="${symbol}")`,
  }

  if (!dryRun) {
    const store = new TransactionStore(workspaceDir)
    const txnId = store.begin(`rename_${symbol}_to_${newName}`)
    let failed = false
    for (const { file: f, edits } of editsPerFile) {
      store.backupFile(txnId, f)
      const editResult = store.applyEdits(txnId, f, edits.map(e => ({
        old_string: e.old,
        new_string: e.new,
      })))
      if (editResult.error_code) {
        store.rollback(txnId)
        result.status = 'rolled_back'
        result.error = editResult.error
        result.failed_file = f
        failed = true
        break
      }
    }
    if (!failed) {
      store.commit(txnId)
      result.status = 'committed'
      result.txn_id = txnId
    }
  }

  return result
}
