import { join, extname } from 'node:path'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { ErrorCodes, makeError } from '../../error-codes.js'

const MAX_FILES = 50
const TEST_PATTERNS = [/^test_/, /_test\./, /\.test\./, /\.spec\./, /\/tests?\//, /\/__tests__\//]

function isTestFile(path) {
  return TEST_PATTERNS.some(p => p.test(path))
}

function findTxn(txnRoot, since) {
  if (!existsSync(txnRoot)) return null
  const dirs = readdirSync(txnRoot, { withFileTypes: true }).filter(d => d.isDirectory())
  if (!dirs.length) return null

  if (since === 'last_txn' || !since) {
    let latest = null, latestTime = 0
    for (const d of dirs) {
      try {
        const manifest = JSON.parse(readFileSync(join(txnRoot, d.name, 'manifest.json'), 'utf-8'))
        if (manifest.created > latestTime) { latestTime = manifest.created; latest = { ...manifest, dirName: d.name } }
      } catch {}
    }
    return latest
  }

  const txnId = since.startsWith('txn:') ? since.slice(4) : since
  for (const d of dirs) {
    try {
      const manifest = JSON.parse(readFileSync(join(txnRoot, d.name, 'manifest.json'), 'utf-8'))
      if (manifest.txnId === txnId) return { ...manifest, dirName: d.name }
    } catch {}
  }
  return null
}

function collectChanges(workspaceDir, txnRoot, txn) {
  const changes = []
  const warnings = []
  const files = Object.entries(txn.files || {})
  const truncated = files.length > MAX_FILES
  const toProcess = truncated ? files.slice(0, MAX_FILES) : files

  for (const [fileRel, meta] of toProcess) {
    if (meta.skipped) { warnings.push({ file: fileRel, reason: 'skipped_in_txn' }); continue }
    const backupPath = join(txnRoot, txn.dirName, 'backup', meta.backupName || fileRel.replace(/\//g, '__'))
    if (!existsSync(backupPath)) { warnings.push({ file: fileRel, reason: 'backup_missing' }); continue }
    const currentPath = join(workspaceDir, fileRel)
    if (!existsSync(currentPath)) { warnings.push({ file: fileRel, reason: 'file_deleted' }); continue }
    try {
      changes.push({
        file: fileRel,
        before: readFileSync(backupPath, 'utf-8'),
        after: readFileSync(currentPath, 'utf-8'),
        isTest: isTestFile(fileRel),
      })
    } catch (e) {
      warnings.push({ file: fileRel, reason: `read_error: ${e.message}` })
    }
  }
  return { changes, warnings, truncated }
}

function diffLines(before, after) {
  const bLines = before.split('\n')
  const aLines = after.split('\n')
  let added = 0, removed = 0
  const maxLen = Math.max(bLines.length, aLines.length)
  for (let i = 0; i < maxLen; i++) {
    if (i >= bLines.length) added++
    else if (i >= aLines.length) removed++
    else if (bLines[i] !== aLines[i]) { added++; removed++ }
  }
  return { added, removed }
}

const SYMBOL_PATTERNS = [
  { re: /^\s*def\s+(\w+)\s*\(/, type: 'function' },
  { re: /^\s*class\s+(\w+)/, type: 'class' },
  { re: /^\s*(?:async\s+)?function\s+(\w+)\s*\(/, type: 'function' },
  { re: /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[^=])\s*=>/, type: 'function' },
  { re: /^\s*func\s+(?:\([^)]*\)\s*)?(\w+)\s*\(/, type: 'function' },
  { re: /^\s*(?:pub\s+)?fn\s+(\w+)\s*[<(]/, type: 'function' },
  { re: /^\s*(?:pub\s+)?(?:struct|enum|trait|impl)\s+(\w+)/, type: 'class' },
]

function extractSymbolsRegex(content) {
  const syms = []
  for (const line of content.split('\n')) {
    for (const { re, type } of SYMBOL_PATTERNS) {
      const m = line.match(re)
      if (m) { syms.push({ name: m[1], type, signature: line.trim() }); break }
    }
  }
  return syms
}

function extractSymbols(content, ext, langParser) {
  if (langParser) {
    try {
      const tree = langParser.parse(content, ext)
      if (tree) {
        const result = langParser.extractSymbols(tree, content, ext)
        const syms = Array.isArray(result) ? result : (result?.symbols || [])
        if (syms.length) return syms
      }
    } catch {}
  }
  return extractSymbolsRegex(content)
}

function extractChanges(change, langParser) {
  const ext = extname(change.file)
  const beforeSyms = extractSymbols(change.before, ext, langParser)
  const afterSyms = extractSymbols(change.after, ext, langParser)
  if (!beforeSyms.length && !afterSyms.length) return []

  const out = []
  for (const sym of afterSyms) {
    const prev = beforeSyms.find(s => s.name === sym.name && s.type === sym.type)
    if (!prev) out.push({ file: change.file, symbol: sym.name, type: sym.type, change: 'added' })
    else if (prev.signature !== sym.signature) {
      out.push({ file: change.file, symbol: sym.name, type: sym.type, change: 'signature_changed', before: prev.signature, after: sym.signature })
    }
  }
  for (const sym of beforeSyms) {
    if (!afterSyms.find(s => s.name === sym.name && s.type === sym.type)) {
      out.push({ file: change.file, symbol: sym.name, type: sym.type, change: 'removed' })
    }
  }
  return out
}

async function checkCallerSync(symbolsChanged, filesInChange, codeIndexService, workspaceDir) {
  if (!codeIndexService) return { status: 'skipped', reason: 'code-index service not available (requires MCP context)' }
  try { codeIndexService.initWorkspace(workspaceDir) } catch { return { status: 'skipped', reason: 'workspace not indexed' } }
  const result = []
  for (const sym of symbolsChanged.filter(s => s.change === 'signature_changed')) {
    try {
      const { callers } = await codeIndexService.getImpactAnalysis(sym.file, { symbol: sym.symbol })
      const notUpdated = callers.filter(c => !filesInChange.includes(c.file)).map(c => c.file)
      result.push({
        symbol: sym.symbol,
        total_callers: callers.length,
        updated_in_change: callers.length - notUpdated.length,
        not_updated: [...new Set(notUpdated)],
      })
    } catch (e) {
      result.push({ symbol: sym.symbol, error: `impact_analysis_failed: ${e.message}` })
    }
  }
  return result
}

function checkTestSync(changes, workspaceDir) {
  const sourceChanged = changes.filter(c => !c.isTest).map(c => c.file)
  const testChanged = changes.filter(c => c.isTest).map(c => c.file)
  const testsPossiblyStale = []
  const testsNotFound = []

  for (const src of sourceChanged) {
    const base = src.replace(/\.[^.]+$/, '').replace(/^src\//, '')
    const name = base.split('/').pop()
    const ext = extname(src)
    const expectedTests = []
    if (ext === '.py') {
      expectedTests.push(`test_${name}.py`, `${name}_test.py`, `tests/test_${name}.py`)
    } else if (['.js', '.mjs', '.cjs'].includes(ext)) {
      expectedTests.push(`${name}.test.js`, `${name}.spec.js`, `__tests__/${name}.test.js`)
    } else if (['.ts', '.tsx', '.mts', '.cts'].includes(ext)) {
      expectedTests.push(`${name}.test.ts`, `${name}.spec.ts`, `__tests__/${name}.test.ts`)
    } else if (ext === '.go') {
      expectedTests.push(`${name}_test.go`)
    } else if (ext === '.rs') {
      expectedTests.push(`${name}_test.rs`)
    }
    for (const t of expectedTests) {
      if (testChanged.some(tc => tc.includes(t))) continue
      if (existsSync(join(workspaceDir, t))) {
        if (!testsPossiblyStale.includes(t)) testsPossiblyStale.push(t)
      } else {
        if (!testsNotFound.includes(t) && testsNotFound.length < 2) testsNotFound.push(t)
      }
    }
  }
  return {
    source_changed: sourceChanged,
    test_changed: testChanged,
    tests_possibly_stale: testsPossiblyStale,
    ...(testsNotFound.length ? { tests_not_found: testsNotFound } : {}),
  }
}

export async function handle(args, context) {
  const workspaceDir = args?.workspace_dir
  if (!workspaceDir) return makeError(ErrorCodes.INVALID_INPUT, 'workspace_dir is required')

  const since = args?.since || 'last_txn'
  const txnRoot = join(workspaceDir, '.ai-transactions')

  const txn = findTxn(txnRoot, since)
  if (!txn) {
    if (!existsSync(txnRoot)) {
      return makeError(ErrorCodes.NO_MATCH, 'no .ai-transactions/ found', { suggestion: 'workflow: edit_transaction(begin) → edit_transaction(edit) → edit_transaction(commit) → diff_facts' })
    }
    return makeError(ErrorCodes.TXN_NOT_FOUND, `transaction not found: ${since}`, { suggestion: 'use edit_transaction(action=begin) to create a new transaction' })
  }

  const { changes, warnings, truncated } = collectChanges(workspaceDir, txnRoot, txn)

  const filesChanged = changes.map(c => ({
    path: c.file,
    ...diffLines(c.before, c.after),
    is_test: c.isTest,
  }))

  const langParser = context?.langParserService
  const symbolsChanged = []
  for (const c of changes) {
    symbolsChanged.push(...extractChanges(c, langParser))
  }

  const filesInChange = changes.map(c => c.file)
  const callerSync = await checkCallerSync(symbolsChanged, filesInChange, context?.codeIndexService, workspaceDir)
  const testSync = checkTestSync(changes, workspaceDir)

  const hasStaleTests = testSync?.tests_possibly_stale?.length > 0
  const hasCallerIssues = Array.isArray(callerSync) && callerSync.some(c => c.not_updated?.length > 0)
  let nextStep
  if (hasStaleTests) {
    nextStep = `Run affected tests: test_bridge(action='run', scope='${testSync.tests_possibly_stale.join(', ')}')`
  } else if (hasCallerIssues) {
    nextStep = 'Review affected callers with impact_analysis.'
  } else {
    nextStep = 'No sync issues. Changes are self-contained.'
  }

  return {
    since,
    txn_id: txn.txnId,
    files_changed: filesChanged,
    symbols_changed: symbolsChanged,
    caller_sync: callerSync,
    test_sync: testSync,
    next_step: nextStep,
    ...(truncated ? { truncated: true } : {}),
    ...(warnings.length ? { warnings } : {}),
  }
}
