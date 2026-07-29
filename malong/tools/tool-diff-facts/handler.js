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

function extractSymbols(content, ext, langParser) {
  if (!langParser) return null
  try {
    const tree = langParser.parse(content, ext)
    if (!tree) return null
    return langParser.extractSymbols(tree, content)
  } catch { return null }
}

function extractChanges(change, langParser) {
  const ext = extname(change.file)
  const beforeSyms = extractSymbols(change.before, ext, langParser)
  const afterSyms = extractSymbols(change.after, ext, langParser)
  if (!beforeSyms || !afterSyms) return []

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
  if (!codeIndexService) return 'skipped'
  const result = []
  for (const sym of symbolsChanged.filter(s => s.change === 'signature_changed')) {
    try {
      codeIndexService.initWorkspace(workspaceDir)
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

function checkTestSync(changes) {
  const sourceChanged = changes.filter(c => !c.isTest).map(c => c.file)
  const testChanged = changes.filter(c => c.isTest).map(c => c.file)
  const testsPossiblyStale = []

  for (const src of sourceChanged) {
    const base = src.replace(/\.[^.]+$/, '').replace(/^src\//, '')
    const expectedTests = [
      `test_${base.split('/').pop()}.py`,
      `${base.split('/').pop()}_test.py`,
      `tests/test_${base.split('/').pop()}.py`,
    ]
    for (const t of expectedTests) {
      if (!testChanged.some(tc => tc.includes(t)) && !testsPossiblyStale.includes(t)) {
        testsPossiblyStale.push(t)
      }
    }
  }
  return { source_changed: sourceChanged, test_changed: testChanged, tests_possibly_stale: testsPossiblyStale }
}

export async function handle(args, context) {
  const workspaceDir = args?.workspace_dir
  if (!workspaceDir) return makeError(ErrorCodes.INVALID_INPUT, 'workspace_dir is required')

  const since = args?.since || 'last_txn'
  const txnRoot = join(workspaceDir, '.ai-transactions')

  const txn = findTxn(txnRoot, since)
  if (!txn) {
    if (!existsSync(txnRoot)) {
      return makeError(ErrorCodes.NO_MATCH, 'no .ai-transactions/ found; run edit_transaction first')
    }
    return makeError(ErrorCodes.TXN_NOT_FOUND, `transaction not found: ${since}`)
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
  const testSync = checkTestSync(changes)

  return {
    since,
    txn_id: txn.txnId,
    files_changed: filesChanged,
    symbols_changed: symbolsChanged,
    caller_sync: callerSync,
    test_sync: testSync,
    ...(truncated ? { truncated: true } : {}),
    ...(warnings.length ? { warnings } : {}),
  }
}
