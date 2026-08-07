import { join, extname } from 'node:path'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { ErrorCodes, makeError } from '../../error-codes.js'

const MAX_FILES = 50
const TEST_PATTERNS = [/^test_/, /_test\./, /\.test\./, /\.spec\./, /\/tests?\//, /\/__tests__\//]

function isTestFile(path) {
  return TEST_PATTERNS.some(p => p.test(path))
}

function _scanTxnDirs(txnRoot) {
  const results = []
  if (!existsSync(txnRoot)) return results
  const dirs = readdirSync(txnRoot, { withFileTypes: true }).filter(d => d.isDirectory())
  for (const d of dirs) {
    if (d.name === 'recent') {
      const recentDir = join(txnRoot, 'recent')
      const recentEntries = readdirSync(recentDir, { withFileTypes: true }).filter(e => e.isDirectory())
      for (const e of recentEntries) {
        results.push({ dirName: join('recent', e.name), absDir: join(recentDir, e.name) })
      }
    } else {
      results.push({ dirName: d.name, absDir: join(txnRoot, d.name) })
    }
  }
  return results
}

function findTxn(txnRoot, since) {
  const entries = _scanTxnDirs(txnRoot)
  if (!entries.length) return null

  if (since === 'last_txn' || !since) {
    let latest = null, latestTime = 0
    for (const { dirName, absDir } of entries) {
      try {
        const manifest = JSON.parse(readFileSync(join(absDir, 'manifest.json'), 'utf-8'))
        if (manifest.created > latestTime) { latestTime = manifest.created; latest = { ...manifest, dirName } }
      } catch {}
    }
    return latest
  }

  const txnId = since.startsWith('txn:') ? since.slice(4) : since
  for (const { dirName, absDir } of entries) {
    try {
      const manifest = JSON.parse(readFileSync(join(absDir, 'manifest.json'), 'utf-8'))
      if (manifest.txnId === txnId) return { ...manifest, dirName }
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
    // R22-⑪：fileRel/backupName 来自 manifest（磁盘内容可被外部改动）——`../` 段越界读守卫
    const relSegs = fileRel.split('/')
    if (relSegs.includes('..')) { warnings.push({ file: fileRel, reason: 'path_blocked' }); continue }
    const backupName = meta.backupName || fileRel.replace(/\//g, '__')
    if (backupName.split('/').includes('..') || backupName.split('\\').includes('..')) { warnings.push({ file: fileRel, reason: 'path_blocked' }); continue }
    const backupPath = join(txnRoot, txn.dirName, 'backup', backupName)
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
  // P2-B5：逐行对齐在插入一行后后续全部错位（added/removed 虚高）——
  // 改最长公共前后缀（同 write-edit 的 makeSimpleDiff 思路）
  const bLines = before.split('\n')
  const aLines = after.split('\n')
  let prefix = 0
  const maxP = Math.min(bLines.length, aLines.length)
  while (prefix < maxP && bLines[prefix] === aLines[prefix]) prefix++
  let suffix = 0
  while (
    suffix < bLines.length - prefix &&
    suffix < aLines.length - prefix &&
    bLines[bLines.length - 1 - suffix] === aLines[aLines.length - 1 - suffix]
  ) suffix++
  return {
    added: aLines.length - prefix - suffix,
    removed: bLines.length - prefix - suffix,
  }
}

const SYMBOL_PATTERNS = [
  { re: /^\s*(?:async\s+)?def\s+(\w+)\s*\(/, type: 'function' }, // P2-B5：async def 漏检
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

async function extractSymbols(content, ext, langParser) {
  if (langParser) {
    try {
      const result = await langParser.extractSymbolsAsync(content, ext)
      const syms = Array.isArray(result) ? result : (result?.symbols || [])
      if (syms.length) return syms
    } catch {}
  }
  return extractSymbolsRegex(content)
}

async function extractChanges(change, langParser) {
  const ext = extname(change.file)
  const beforeSyms = await extractSymbols(change.before, ext, langParser)
  const afterSyms = await extractSymbols(change.after, ext, langParser)
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
  try { await codeIndexService.initWorkspace(workspaceDir) } catch { return { status: 'skipped', reason: 'workspace not indexed' } }
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
    // Y002-S2：TXN_NOT_FOUND 给出可执行修复——列出当前可用事务（43% 错误率根因：
    // 传了其他工具的 txn_id / journal txnId，或事务已被 cleanup/recent 轮换）
    const available = _scanTxnDirs(txnRoot)
      .map(({ dirName, absDir }) => {
        try { return JSON.parse(readFileSync(join(absDir, 'manifest.json'), 'utf-8')).txnId } catch { return null }
      })
      .filter(Boolean)
      .slice(0, 5)
    return makeError(ErrorCodes.TXN_NOT_FOUND, `transaction not found: ${since}`, {
      suggestion: available.length
        ? `use an existing transaction id: ${available.join(', ')} (or since="last_txn" for the latest)`
        : 'no transactions available yet: use edit_transaction(action=begin) to create one, then edit_transaction(action=edit)',
      available_txns: available,
      workflow: 'edit_transaction(begin) → edit_transaction(edit) → edit_transaction(commit) → diff_facts → test_bridge → debug_runner',
    })
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
    symbolsChanged.push(...await extractChanges(c, langParser))
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
    nextStep = 'No AST-level sync issues detected — data-flow wiring still needs review.'
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
