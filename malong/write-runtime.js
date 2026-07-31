// 码龙 — write 运行时（原语化 P3）
// 附录 C 冲突状态机 + 附录 D write pipeline（锁/journal/原子写/写后同步重抽）
// 单符号 replace_symbol / 亚符号 patch / 非代码降级（附录 E）

import { join, basename, extname } from 'node:path'
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, renameSync,
  openSync, closeSync, writeSync, unlinkSync, statSync, readdirSync, appendFileSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { sha256 } from './hash-utils.js'
import { validateFilePath } from './error-codes.js'
import { extractSignatureLine, langOf } from './symbol-anchors.js'
import { checkFileStaleness } from './staleness.js'

const LOCK_TIMEOUT_MS = 2000
const STALE_LOCK_MS = 10000
const MAX_LIVE_READ = 1024 * 1024
const JOURNAL_ROOT = '.malong'
const AUDIT_LOG = 'audit.log'

export function traceId() {
  return `trc_${Date.now()}_${randomBytes(3).toString('hex')}`
}

// ---------- 锁（附录 D：OS advisory 优先，fallback lockfile + pid；2s 超时） ----------

export function acquireLock(absPath, timeoutMs = LOCK_TIMEOUT_MS) {
  const lockPath = `${absPath}.mlock`
  const start = Date.now()
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx')
      writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }))
      closeSync(fd)
      let released = false
      return {
        release() {
          if (released) return
          released = true
          try { unlinkSync(lockPath) } catch {}
        },
      }
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      try {
        const st = statSync(lockPath)
        if (Date.now() - st.mtimeMs > STALE_LOCK_MS) {
          try { unlinkSync(lockPath) } catch {}
          continue
        }
      } catch { continue }
      if (Date.now() - start > timeoutMs) return { locked: true }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
    }
  }
}

// ---------- crash recovery（附录 D：启动扫 journal，未完成 txn 按 state 回滚） ----------

export function recoverJournals(workspaceDir) {
  const root = join(workspaceDir, JOURNAL_ROOT, 'journal')
  if (!existsSync(root)) return []
  const recovered = []
  for (const txnDir of readdirSync(root)) {
    const dir = join(root, txnDir)
    let state = null
    try { state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf-8')) } catch { continue }
    if (state.state === 'committed' || state.state === 'rolled_back') continue
    // created/staged → 回滚（未 rename 则删除，已 rename 则恢复 backup）
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf-8'))
      const absPath = join(workspaceDir, manifest.file)
      const backup = join(dir, 'backup', basename(manifest.file))
      if (state.state === 'staged' && existsSync(backup) && existsSync(absPath)) {
        renameSync(backup, absPath)
      }
      writeFileSync(join(dir, 'state.json'), JSON.stringify({ ...state, state: 'rolled_back', rolled_back_at: new Date().toISOString() }))
      recovered.push({ txn_id: txnDir, file: manifest.file, action: 'rolled_back' })
    } catch (e) {
      writeFileSync(join(dir, 'state.json'), JSON.stringify({ ...state, state: 'failed', reason: e.message }))
      recovered.push({ txn_id: txnDir, file: null, action: 'rollback_failed', reason: e.message })
    }
  }
  return recovered
}

// ---------- 冲突状态机（附录 C） ----------

export function classifyConflict(base, cur, isSymbolMode) {
  if (!base?.file?.hash) return { type: 'NO_BASE' }
  if (isSymbolMode && !cur.symbol) return { type: 'SYMBOL_DELETED' }
  const fileSame = base.file.hash === cur.file.hash
  if (fileSame) {
    if (!isSymbolMode) return { type: 'CLEAN' }
    if (base.symbol?.body_hash && cur.symbol?.body_hash && base.symbol.body_hash === cur.symbol.body_hash) return { type: 'CLEAN' }
    if (!base.symbol?.body_hash) return { type: 'CLEAN', warning: 'no_base_body_hash' }
    return { type: 'SYMBOL_CHANGED' }
  }
  // 文件变了：符号级还要看符号自身
  if (!isSymbolMode) return { type: 'FILE_CHANGED' }
  const bodySame = base.symbol?.body_hash && cur.symbol?.body_hash && base.symbol.body_hash === cur.symbol.body_hash
  if (bodySame) return { type: 'FILE_CHANGED_SYMBOL_STABLE' }
  if (base.symbol?.signature_hash && cur.symbol?.signature_hash && base.symbol.signature_hash !== cur.symbol.signature_hash) {
    return { type: 'SYMBOL_SIGNATURE_CHANGED' }
  }
  return { type: 'SYMBOL_CHANGED' }
}

const CONFLICT_POLICY = {
  CLEAN: 'allow',
  FILE_CHANGED_SYMBOL_STABLE: 'allow_warn',
  FILE_CHANGED: 'allow_warn',
  SYMBOL_CHANGED: 'reject',
  SYMBOL_SIGNATURE_CHANGED: 'reject',
  SYMBOL_DELETED: 'reject',
  AMBIGUOUS_SYMBOL: 'reject',
  NO_BASE: 'reject',
}

// ---------- 编辑应用 ----------

function countOccurrences(haystack, needle) {
  let n = 0
  let idx = 0
  for (;;) {
    idx = haystack.indexOf(needle, idx)
    if (idx === -1) break
    n++
    idx += needle.length
  }
  return n
}

function makeSimpleDiff(oldLines, newLines) {
  // 最长公共前后缀 → 变更区间 + 统一 diff 头
  let prefix = 0
  const maxP = Math.min(oldLines.length, newLines.length)
  while (prefix < maxP && oldLines[prefix] === newLines[prefix]) prefix++
  let suffix = 0
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) suffix++
  const oldChanged = oldLines.slice(prefix, oldLines.length - suffix)
  const newChanged = newLines.slice(prefix, newLines.length - suffix)
  const hunk = []
  for (const l of oldChanged) hunk.push(`-${l}`)
  for (const l of newChanged) hunk.push(`+${l}`)
  const oldStart = prefix + 1
  const newStart = prefix + 1
  return {
    patch: `@@ -${oldStart},${oldChanged.length} +${newStart},${newChanged.length} @@\n${hunk.join('\n')}`,
    lines_changed: Math.max(oldChanged.length, newChanged.length),
  }
}

function applyReplace(lines, range, newContent) {
  const [a, b] = range
  const before = lines.slice(0, a - 1)
  const after = lines.slice(b)
  const newLines = newContent.split('\n')
  return { lines: [...before, ...newLines, ...after], diff: makeSimpleDiff(lines, [...before, ...newLines, ...after]) }
}

function applyBodyEdit(lines, range, newContent, preserveSignature) {
  const [a, b] = range
  if (b === a) {
    return { error: { code: 'SINGLE_LINE_SYMBOL', message: 'Single-line symbol: use boundary=full or patch mode.' } }
  }
  const before = lines.slice(0, a)
  const after = lines.slice(b)
  const newLines = newContent.split('\n')
  return { lines: [...before, ...newLines, ...after], diff: makeSimpleDiff(lines, [...before, ...newLines, ...after]) }
}

function applyInsertAfter(lines, range, newContent) {
  const [, b] = range
  const before = lines.slice(0, b)
  const after = lines.slice(b)
  return { lines: [...before, ...newContent.split('\n'), ...after], diff: makeSimpleDiff(lines, [...before, ...newContent.split('\n'), ...after]) }
}

// ---------- journal（附录 D） ----------

function createJournal(workspaceDir, filePath, absPath, originalContent, state) {
  const txnId = `txn_${Date.now()}_${randomBytes(4).toString('hex')}`
  const dir = join(workspaceDir, JOURNAL_ROOT, 'journal', txnId)
  mkdirSync(join(dir, 'backup'), { recursive: true })
  writeFileSync(join(dir, 'backup', basename(filePath)), originalContent)
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    txn_id: txnId, file: filePath, edit_mode: state.editMode, created_at: new Date().toISOString(),
  }, null, 2))
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ txn_id: txnId, state: 'created', ...state }, null, 2))
  return { txnId, dir }
}

function updateJournalState(dir, state) {
  try {
    const cur = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf-8'))
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ ...cur, ...state }, null, 2))
  } catch {}
}

function auditLog(workspaceDir, entry) {
  try {
    appendFileSync(join(workspaceDir, JOURNAL_ROOT, AUDIT_LOG), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n')
  } catch {}
}

// ---------- 校验（附录：sandbox + 语法，尽力而为） ----------

function checkBracketBalance(text) {
  const pairs = { '(': ')', '[': ']', '{': '}' }
  const stack = []
  for (const ch of text) {
    if (pairs[ch]) stack.push(ch)
    else if (Object.values(pairs).includes(ch)) {
      const open = stack.pop()
      if (pairs[open] !== ch) return { ok: false, detail: `unbalanced: expected ${pairs[open] || 'nothing'} but got ${ch}` }
    }
  }
  return stack.length === 0 ? { ok: true } : { ok: false, detail: `unclosed: ${stack.join('')}` }
}

async function validateSyntax(langParser, source, ext) {
  if (!langParser?.hasErrorsAsync) return { status: 'skip', reason: 'langParser unavailable' }
  try {
    // 注意：不传 filePath —— 校验的是内存中的 newContent，不是磁盘文件
    const hasErr = await langParser.hasErrorsAsync(source, ext, null)
    return hasErr ? { status: 'fail', errors: ['syntax errors detected by parser'] } : { status: 'pass' }
  } catch (e) {
    return { status: 'skip', reason: `parse unavailable: ${e.message}` }
  }
}

// ---------- 主编排 ----------

export async function writeSymbol(args, context) {
  const { codeIndexService, getWorkspaceDir, langParserService } = context
  const langParser = langParserService
  const workspaceDir = args?.workspace_dir
  const pipeline = []
  const trace_id = traceId()

  if (!workspaceDir) {
    return { success: false, error: { code: 'missing_parameter', message: 'workspace_dir is required' }, trace_id }
  }
  const locator = args?.locator || {}
  let filePath = locator?.file_path
  if (!filePath && locator?.symbol_id && codeIndexService) {
    const byId = codeIndexService.getSymbolByStableId(locator.symbol_id)
    if (byId) filePath = byId.file_path
  }
  if (!filePath) {
    return { success: false, error: { code: 'missing_parameter', message: 'locator.file_path is required (or provide a resolvable symbol_id)' }, trace_id }
  }
  const pathCheck = validateFilePath(filePath)
  if (!pathCheck.ok) {
    return { success: false, error: { code: 'PATH_BLOCKED', message: pathCheck.detail }, trace_id }
  }

  const absPath = join(workspaceDir, filePath)
  if (!existsSync(absPath)) {
    return { success: false, error: { code: 'FILE_NOT_FOUND', message: `File not found: ${filePath}`, suggestion: 'write_symbol only edits existing files; use create capability for new files.' }, trace_id }
  }

  // crash recovery 先行
  const recovered = recoverJournals(workspaceDir)
  if (recovered.length > 0) pipelineStep(pipeline, 'crash_recovery', 'warn', { recovered: recovered.length })

  const editMode = args?.edit_mode || (args?.patch ? 'patch' : 'replace_symbol')
  const boundary = args?.boundary || 'full'
  const preserveDecorators = args?.preserve_decorators !== false
  const dryRun = !!args?.dry_run
  const safety = args?.safety || {}
  const profile = safety.profile || 'standard'
  const force = !!args?.allow_unsafe_no_base || !!safety.allow_unsafe_no_base

  if (editMode !== 'patch' && !locator?.name && !locator?.symbol_id) {
    return { success: false, error: { code: 'missing_parameter', message: 'replace_symbol requires locator.name or locator.symbol_id; for non-code files use edit_mode=patch.' }, trace_id }
  }

  const t0 = Date.now()

  // 0) staleness 检查先行（附录 D：外部改动先重索引，否则 range 漂移会误报冲突）
  if (codeIndexService) {
    const staleness = await checkFileStaleness(codeIndexService, workspaceDir, filePath)
    pipelineStep(pipeline, 'index_status_check', staleness?.auto_indexed ? 'ok' : staleness ? 'warn' : 'ok', {
      detail: staleness?.auto_indexed ? 'auto_reindexed' : staleness?.warning || 'fresh',
    })
  }

  // 1) resolve locator → 符号 / 降级模式
  let symbol = null
  let symbolRows = []
  if (locator.symbol_id && codeIndexService) {
    symbol = codeIndexService.getSymbolByStableId(locator.symbol_id)
    if (symbol && symbol.file_path !== filePath) symbol = null
    if (!symbol) {
      return { success: false, error: { code: 'SYMBOL_NOT_FOUND', message: `No symbol with stable_id ${locator.symbol_id} in ${filePath}` }, trace_id }
    }
  } else if (locator.name && codeIndexService) {
    symbolRows = codeIndexService.findSymbolsInFile(filePath, locator.name, locator.kind)
    if (symbolRows.length > 1) {
      return {
        success: false,
        error: {
          code: 'AMBIGUOUS_SYMBOL',
          message: `${symbolRows.length} candidates for "${locator.name}" in ${filePath}`,
          candidates: symbolRows.map(r => ({ symbol_id: r.stable_id, name: r.name, kind: r.type, range: [r.start_line, r.end_line], signature: r.signature })),
        },
        trace_id,
      }
    }
    symbol = symbolRows[0] || null
    if (!symbol) {
      return { success: false, error: { code: 'SYMBOL_NOT_FOUND', message: `No symbol named "${locator.name}" in ${filePath}` }, trace_id }
    }
  }
  pipelineStep(pipeline, 'resolve_locator', symbol ? 'ok' : 'ok', { via: symbol ? 'symbol' : 'degraded_patch' })

  // 2) live 读当前文件 → current version
  let content = ''
  try { content = readFileSync(absPath, 'utf-8') } catch (e) {
    return { success: false, error: { code: 'READ_FAILED', message: e.message }, trace_id }
  }
  const curFileHash = sha256(content)
  const lines = content.split('\n')
  const range = symbol ? [symbol.start_line, Math.max(symbol.start_line, symbol.end_line)] : null
  let curBodyHash = null
  let curSigHash = null
  if (symbol && range) {
    const body = lines.slice(range[0] - 1, range[1]).join('\n')
    curBodyHash = sha256(body)
    const sigLine = extractSignatureLine(lines, symbol)
    curSigHash = sha256(sigLine || '')
  }
  const current = {
    file: { hash: `sha256:${curFileHash}`, size: content.length },
    symbol: symbol ? { body_hash: `sha256:${curBodyHash}`, signature_hash: `sha256:${curSigHash}` } : null,
  }

  // 3) 冲突判定（附录 C 状态机）
  const baseVersion = args?.base_version
  if (!baseVersion && !force) {
    return {
      success: false,
      error: {
        code: 'VERSION_CONFLICT',
        conflict_type: 'NO_BASE',
        message: 'base_version is required (read_symbol first). Use allow_unsafe_no_base only when you intentionally bypass.',
      },
      trace_id,
    }
  }
  const base = force && !baseVersion ? null : baseVersion
  let conflict = null
  if (base) {
    conflict = classifyConflict(
      { file: { hash: base.file?.hash }, symbol: base.symbol || null },
      current,
      !!symbol
    )
    pipelineStep(pipeline, 'version_check', conflict.type === 'CLEAN' ? 'ok' : 'warn', { conflict: conflict.type })
    const policy = CONFLICT_POLICY[conflict.type] || 'reject'
    if (policy === 'reject') {
      const suggestion = conflict.type === 'SYMBOL_CHANGED' || conflict.type === 'SYMBOL_SIGNATURE_CHANGED'
        ? 'Re-read the symbol and regenerate content.'
        : conflict.type === 'SYMBOL_DELETED' ? 'Symbol was deleted; re-read the file.'
        : 'Resolve ambiguity via symbol_id.'
      return {
        success: false,
        error: {
          code: 'VERSION_CONFLICT',
          conflict_type: conflict.type,
          message: `base_version mismatch: ${conflict.type}`,
          suggestion,
          next_action: { tool: 'read_symbol', params: { locator: { file_path: filePath, symbol_id: symbol?.stable_id || undefined, name: symbol?.name }, mode: 'core' } },
        },
        trace_id,
        current_version: current,
      }
    }
  }

  // 4) 锁（附录 D）
  const lock = acquireLock(absPath)
  if (lock.locked) {
    return { success: false, error: { code: 'FILE_LOCKED', message: `File is locked by another writer: ${filePath}`, suggestion: 'Retry after a moment.' }, trace_id }
  }
  pipelineStep(pipeline, 'lock', 'ok')
  try {
    // 5) 应用编辑
    let newLines = null
    let diff = null
    let alreadyApplied = false
    let newBodyLineCount = null
    const scopeContent = symbol && range ? lines.slice(range[0] - 1, range[1]).join('\n') : content

    if (editMode === 'patch') {
      const patch = args.patch || {}
      const oldString = patch.old_string
      const newString = patch.new_string ?? ''
      if (typeof oldString !== 'string' || oldString === '') {
        return { success: false, error: { code: 'missing_parameter', message: 'patch.old_string is required' }, trace_id }
      }
      const occurrences = countOccurrences(scopeContent, oldString)
      if (occurrences === 0) {
        if (newString && countOccurrences(scopeContent, newString) > 0) {
          alreadyApplied = true
          newLines = lines
          pipelineStep(pipeline, 'patch_match', 'ok', { status: 'already_applied' })
        } else {
          pipelineStep(pipeline, 'patch_match', 'error', { reason: 'old_string_not_found' })
          return {
            success: false,
            error: { code: 'PATCH_OLD_STRING_NOT_FOUND', message: `old_string not found in ${symbol ? 'symbol body' : 'file'}` },
            suggestion: 'Re-read the file (file changed?) and regenerate the patch.',
            trace_id,
          }
        }
      } else if (occurrences > 1) {
        return {
          success: false,
          error: { code: 'PATCH_OLD_STRING_AMBIGUOUS', message: `old_string matches ${occurrences} times`, suggestion: 'Include more surrounding context in old_string.' },
          trace_id,
        }
      } else {
        if (symbol && range) {
          const body = lines.slice(range[0] - 1, range[1]).join('\n')
          const patchedBody = body.replace(oldString, newString)
          newLines = [...lines.slice(0, range[0] - 1), ...patchedBody.split('\n'), ...lines.slice(range[1])]
          newBodyLineCount = patchedBody.split('\n').length
          diff = makeSimpleDiff(lines, newLines)
        } else {
          const patched = content.replace(oldString, newString)
          newLines = patched.split('\n')
          diff = makeSimpleDiff(lines, newLines)
        }
        pipelineStep(pipeline, 'patch_match', 'ok')
      }
    } else if (editMode === 'replace_symbol') {
      if (!symbol || !range) {
        return { success: false, error: { code: 'missing_parameter', message: 'replace_symbol requires a resolved symbol; use edit_mode=patch for non-code files.' }, trace_id }
      }
      // 附录 B：full = 整符号替换；body = 保留签名行
      if (boundary === 'body') {
        const r = applyBodyEdit(lines, [range[0] + 1, range[1]], args.content, preserveDecorators)
        if (r.error) return { success: false, error: r.error, trace_id }
        newLines = r.lines
        diff = r.diff
        newBodyLineCount = args.content.split('\n').length
      } else {
        const r = applyReplace(lines, range, args.content)
        newLines = r.lines
        diff = r.diff
        newBodyLineCount = args.content.split('\n').length
        const newSig = extractSignatureLine(args.content.split('\n'), { start_line: 1 })
        const newSigHash = sha256(newSig || '')
        if (newSigHash !== curSigHash) {
          pipelineStep(pipeline, 'signature_check', 'warn', { reason: 'SIGNATURE_WILL_CHANGE' })
        }
      }
      // 附录 B 护栏：装饰器检测（warn 不 block，strict block）
      if (preserveDecorators) {
        const above = (lines[range[0] - 2] || '').trim()
        if (above.startsWith('@') && !(args.content || '').trim().startsWith('@')) {
          pipelineStep(pipeline, 'decorator_guard', 'warn', { reason: 'decorator_may_be_lost', suggestion: 'Set preserve_decorators=false if intentional, or include decorator in content.' })
        }
      }
    } else if (editMode === 'insert_after_symbol') {
      if (!symbol || !range) {
        return { success: false, error: { code: 'missing_parameter', message: 'insert_after_symbol requires a resolved symbol.' }, trace_id }
      }
      const r = applyInsertAfter(lines, range, args.content)
      newLines = r.lines
      diff = r.diff
      newBodyLineCount = args.content.split('\n').length
    } else {
      return { success: false, error: { code: 'INVALID_INPUT', message: `unknown edit_mode: ${editMode}` }, trace_id }
    }

    if (alreadyApplied) {
      return {
        success: true,
        status: 'already_applied',
        message: 'The intended change is already present; treating as success (idempotent).',
        new_version: { file: { hash: `sha256:${curFileHash}` }, symbol: symbol ? { body_hash: `sha256:${curBodyHash}`, signature_hash: `sha256:${curSigHash}` } : null },
        trace_id,
      }
    }

    const newContent = newLines.join('\n')

    // 6) 校验（sandbox 基础 + 语法，dry_run 也校验）
    const bracket = checkBracketBalance(newContent)
    const validation = {
      bracket: bracket.ok ? { status: 'pass' } : { status: 'fail', errors: [bracket.detail] },
    }
    if (langOf(filePath)) {
      const syn = await validateSyntax(langParser, newContent, extname(filePath))
      validation.syntax = syn
    } else {
      validation.syntax = { status: 'skip', reason: 'non-code file' }
    }
    pipelineStep(pipeline, 'validate', validation.syntax.status === 'pass' && validation.bracket.status === 'pass' ? 'ok' : 'warn', { syntax: validation.syntax.status, bracket: validation.bracket.status })
    if (safety.block_on_validation_error && (validation.syntax.status === 'fail' || validation.syntax.status === 'skip' || validation.bracket.status === 'fail')) {
      return { success: false, error: { code: 'VALIDATION_FAILED', message: 'validation failed and block_on_validation_error is set', validation }, trace_id }
    }

    // 7) journal（写前建，staged）
    const journal = createJournal(workspaceDir, filePath, absPath, content, {
      editMode, boundary, state: 'staged', base_file_hash: base?.file?.hash || null,
    })
    updateJournalState(journal.dir, { state: 'staged', new_hash: sha256(newContent) })

    if (dryRun) {
      lock.release()
      return {
        success: true,
        dry_run: true,
        diff,
        validation,
        new_version: { file: { hash: `sha256:${sha256(newContent)}` } },
        safety_report: {
          collision: conflict ? { status: conflict.type === 'CLEAN' ? 'clean' : conflict.type } : { status: 'no_base' },
          validation,
        },
        pipeline,
        trace_id,
        duration_ms: Date.now() - t0,
      }
    }

    // 8) 原子写：temp + rename（附录 D）
    const tmpPath = `${absPath}.tmp`
    writeFileSync(tmpPath, newContent)
    try {
      renameSync(tmpPath, absPath)
    } catch (e) {
      try { unlinkSync(tmpPath) } catch {}
      updateJournalState(journal.dir, { state: 'failed', reason: e.message })
      lock.release()
      return { success: false, error: { code: 'ATOMIC_WRITE_FAILED', message: e.message, txn_id: journal.txnId }, trace_id }
    }
    pipelineStep(pipeline, 'atomic_write', 'ok')
    updateJournalState(journal.dir, { state: 'committed', committed_at: new Date().toISOString() })

    // 9) 写后同步重抽（附录 D：写完立刻可读）
    let reindex = null
    if (codeIndexService && langOf(filePath)) {
      try {
        const r = await codeIndexService.indexFile(absPath, workspaceDir)
        reindex = { status: 'ok', symbols: r?.symbols ?? 0, refs: r?.refs ?? 0 }
        pipelineStep(pipeline, 'reindex', 'ok')
      } catch (e) {
        reindex = { status: 'failed', reason: e.message }
        codeIndexService.markIndexDirty(filePath, 'write_pending_reindex')
        pipelineStep(pipeline, 'reindex', 'warn', { reason: e.message })
      }
    } else if (codeIndexService) {
      // 非代码文件：只更新 content_hash（附录 E）
      try {
        const row = codeIndexService.getFileByPath(filePath)
        if (row) {
          codeIndexService._db.prepare("UPDATE files SET content_hash = ?, index_state = 'fresh' WHERE path = ?").run(sha256(newContent), filePath)
          reindex = { status: 'ok', note: 'non-code: content_hash updated' }
        } else {
          reindex = { status: 'ok', note: 'non-code: not_indexed' }
        }
      } catch (e) { reindex = { status: 'failed', reason: e.message } }
      pipelineStep(pipeline, 'reindex', reindex.status === 'ok' ? 'ok' : 'warn', { note: reindex.note || reindex.reason })
    }

    // 10) force 写审计（附录 E）
    if (force) {
      auditLog(workspaceDir, { event: 'force_write', file: filePath, trace_id })
    }

    lock.release()
    const newVersion = {
      file: { hash: `sha256:${sha256(newContent)}`, size: newContent.length },
      symbol: null,
    }
    if (symbol && range && newBodyLineCount != null) {
      const newLinesArr = newContent.split('\n')
      const symStart = (editMode === 'replace_symbol' && boundary === 'body') ? range[0] + 1 : range[0]
      const newRange = [symStart, symStart + Math.max(0, newBodyLineCount - 1)]
      newVersion.symbol = {
        symbol_id: symbol.stable_id || null,
        range: newRange,
        body_hash: `sha256:${sha256(newLinesArr.slice(Math.max(0, newRange[0] - 1), Math.max(newRange[0] - 1, newRange[1])).join('\n'))}`,
      }
    }

    return {
      success: true,
      symbol_id: symbol?.stable_id || null,
      txn_id: journal.txnId,
      new_version: newVersion,
      diff,
      safety_report: {
        collision: conflict ? { status: conflict.type === 'CLEAN' ? 'clean' : conflict.type } : { status: 'no_base' },
        validation,
        warnings: pipeline.filter(p => p.status === 'warn').map(p => ({ step: p.step, detail: p.detail || p.reason })),
      },
      undo: {
        token: journal.txnId,
        txn_id: journal.txnId,
        expires_at: null,
        reverse: { file: filePath, backup: `${JOURNAL_ROOT}/journal/${journal.txnId}/backup/${basename(filePath)}` },
      },
      reindex,
      pipeline,
      trace_id,
      duration_ms: Date.now() - t0,
    }
  } finally {
    lock.release()
  }
}

function pipelineStep(pipeline, step, status, extra = {}) {
  pipeline.push({ step, status, ...extra })
}
