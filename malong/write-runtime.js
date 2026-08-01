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
import { countOccurrences, makeSimpleDiff, applyReplace, applyBodyEdit, applyInsertAfter, checkBracketBalance } from './write-edit.js'
import { createJournal, updateJournalState, auditLog, recoverJournals, JOURNAL_ROOT } from './write-journal.js'

const LOCK_TIMEOUT_MS = 2000
const STALE_LOCK_MS = 30000 // 7：10s 太短——锁内 await validateSyntax 异步解析可能 >10s，第二进程盗锁 → 双写覆盖
const MAX_LIVE_READ = 1024 * 1024

export function traceId() {
  return `trc_${Date.now()}_${randomBytes(3).toString('hex')}`
}

// ---------- 锁（附录 D：OS advisory 优先，fallback lockfile + pid；2s 超时） ----------

export async function acquireLock(absPath, timeoutMs = LOCK_TIMEOUT_MS) {
  const lockPath = `${absPath}.mlock`
  const start = Date.now()
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx')
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }))
      } finally {
        closeSync(fd) // 9（F3）：writeSync 抛错（ENOSPC）时旧实现跳过 closeSync → fd 泄漏 + 空锁文件残留
      }
      let released = false
      return {
        release() {
          if (released) return
          released = true
          // 7：锁归属校验——锁文件写了 pid 却从不校验，陈旧重建后 release 会删掉新所有者的锁
          // → 三方并发 rename，后写胜出，静默覆盖。release 只删「自己还持有」的锁
          try {
            const st = statSync(lockPath)
            if (Date.now() - st.mtimeMs > STALE_LOCK_MS) return // 已被判陈旧重建，锁已属于他人
            const content = readFileSync(lockPath, 'utf-8')
            const holderPid = JSON.parse(content).pid
            if (holderPid !== process.pid) return // 他人持有，不删
            unlinkSync(lockPath)
          } catch {
            try { unlinkSync(lockPath) } catch {}
          }
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
      await new Promise(r => setTimeout(r, 50))
    }
  }
}

// ---------- crash recovery（附录 D：启动扫 journal，未完成 txn 按 state 回滚） ----------


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
  // 附录 C/E：patch/file 模式无符号锚，文件变了必须重读（§16.3：>1MB 中间被改必报 VERSION_CONFLICT）
  FILE_CHANGED: 'reject',
  SYMBOL_CHANGED: 'reject',
  SYMBOL_SIGNATURE_CHANGED: 'reject',
  SYMBOL_DELETED: 'reject',
  AMBIGUOUS_SYMBOL: 'reject',
  NO_BASE: 'reject',
}

// ---------- 编辑应用 ----------


// ---------- journal（附录 D） ----------


// ---------- 校验（附录：sandbox + 语法，尽力而为） ----------


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
  if (editMode !== 'patch' && typeof args.content !== 'string') {
    // 7（F8）：content 缺失旧实现 TypeError 逃逸（undefined.split），调用方收到 throw 而非结构化错误
    return { success: false, error: { code: 'missing_parameter', message: `content is required for edit_mode=${editMode}` }, trace_id }
  }

  const t0 = Date.now()

  // 0) staleness 检查先行（附录 D：外部改动先重索引，否则 range 漂移会误报冲突）
  if (codeIndexService) {
    const staleness = await checkFileStaleness(codeIndexService, workspaceDir, filePath)
    pipelineStep(pipeline, 'index_status_check', staleness?.auto_indexed ? 'ok' : staleness ? 'warn' : 'ok', {
      detail: staleness?.auto_indexed ? 'auto_reindexed' : staleness?.warning || 'fresh',
    })
  }

  // 1) 锁（附录 D：锁内 resolve + live read + conflict 一体，防 TOCTOU 静默覆盖）
  const lock = await acquireLock(absPath)
  if (lock.locked) {
    return { success: false, error: { code: 'FILE_LOCKED', message: `File is locked by another writer: ${filePath}`, suggestion: 'Retry after a moment.' }, trace_id }
  }
  pipelineStep(pipeline, 'lock', 'ok')

  const baseVersion = args?.base_version
  if (!baseVersion && !force) {
    lock.release()
    return {
      success: false,
      error: {
        code: 'VERSION_CONFLICT',
        conflict_type: 'NO_BASE',
        message: 'base_version is required (read_symbol first). Use allow_unsafe_no_base only when you intentionally bypass.',
        next_action: { tool: 'read_symbol', params: { locator: { file_path: filePath } } },
      },
      trace_id,
    }
  }
  const base = force && !baseVersion ? null : baseVersion

  let symbol = null
  let symbolRows = []
  let content = ''
  let lines = []
  let range = null
  let curBodyHash = null
  let curSigHash = null
  let current = null
  let conflict = null
  let newContent = null
  let reindex = null
  let newVersion = null
  let diff = null
  let validation = null
  let journal = null
  let newBodyLineCount = null
  let successResult = null
  try {
    // 2) 锁内 resolve locator → 符号 / 降级模式
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
        // 15（P3）：insert_after_symbol 需要已存在的锚点符号；新符号用 patch 模式创建，
        // 旧文案会让 LLM 以为符号真不存在（其实只是模式选错）
        const hint = editMode === 'insert_after_symbol'
          ? ' (insert_after_symbol needs an existing anchor symbol; use edit_mode="patch" to create a new symbol)'
          : ''
        return { success: false, error: { code: 'SYMBOL_NOT_FOUND', message: `No symbol named "${locator.name}" in ${filePath}${hint}` }, trace_id }
      }
    }
    pipelineStep(pipeline, 'resolve_locator', symbol ? 'ok' : 'ok', { via: symbol ? 'symbol' : 'degraded_patch' })

    // 3) 锁内 live 读当前文件 → current version
    try { content = readFileSync(absPath, 'utf-8') } catch (e) {
      return { success: false, error: { code: 'READ_FAILED', message: e.message }, trace_id }
    }
    const curFileHash = sha256(content)
    lines = content.split('\n')
    range = symbol ? [symbol.start_line, Math.max(symbol.start_line, symbol.end_line)] : null
    if (symbol && range) {
      const body = lines.slice(range[0] - 1, range[1]).join('\n')
      curBodyHash = sha256(body)
      const sigLine = extractSignatureLine(lines, symbol)
      curSigHash = sha256(sigLine || '')
    }
    current = {
      file: { hash: `sha256:${curFileHash}`, size: content.length },
      symbol: symbol ? { body_hash: `sha256:${curBodyHash}`, signature_hash: `sha256:${curSigHash}` } : null,
    }

    // 4) 锁内冲突判定（附录 C 状态机）
    if (base) {
      // 跨符号链式写（读 A 写 A 后拿 new_version 直接写 B）：base.symbol 是 A 的 hash，
      // 对 B 无符号级意义 → 降级为 file-level 比较（附录 C：符号级冲突只对目标符号判定）
      const baseForCheck = { ...base }
      if (symbol && base.symbol?.symbol_id && base.symbol.symbol_id !== symbol.stable_id) {
        baseForCheck.symbol = null
        pipelineStep(pipeline, 'version_check', 'ok', { note: 'cross_symbol_chain: file-level check' })
      }
      conflict = classifyConflict(
        { file: { hash: baseForCheck.file?.hash }, symbol: baseForCheck.symbol || null },
        current,
        !!symbol
      )
      pipelineStep(pipeline, 'version_check', conflict.type === 'CLEAN' ? 'ok' : 'warn', { conflict: conflict.type })
      const policy = CONFLICT_POLICY[conflict.type] || 'reject'
      if (policy === 'reject') {
        const suggestion = conflict.type === 'SYMBOL_CHANGED' || conflict.type === 'SYMBOL_SIGNATURE_CHANGED'
          ? 'Re-read the symbol and regenerate content.'
          : conflict.type === 'SYMBOL_DELETED' ? 'Symbol was deleted; re-read the file.'
          : conflict.type === 'FILE_CHANGED'
            ? 'File changed externally; re-read (read_symbol) and retry with the fresh version.'
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

    // 5) 应用编辑
    let newLines = null
    let alreadyApplied = false
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

    newContent = newLines.join('\n')

    // 6) 校验（sandbox 基础 + 语法，dry_run 也校验）
    const bracket = checkBracketBalance(newContent)
    validation = {
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

    // 7) journal（写前建，staged；dryRun 已在上面返回，不产生 staged 残留——
    //    残留 staged 会被下次 recoverJournals 当崩溃事务回滚，覆盖后来的合法写入）
    journal = createJournal(workspaceDir, filePath, absPath, content, {
      editMode, boundary, state: 'staged', base_file_hash: base?.file?.hash || null,
    })
    updateJournalState(journal.dir, { state: 'staged', new_hash: sha256(newContent) })

    // 8) 原子写：temp + rename（附录 D）
    const tmpPath = `${absPath}.tmp`
    try {
      // 7（F7）：旧 writeFileSync 在 try 外——磁盘满/权限错误裸异常逃逸，tmp 半写残留，错误契约破坏
      writeFileSync(tmpPath, newContent)
      renameSync(tmpPath, absPath)
    } catch (e) {
      try { unlinkSync(tmpPath) } catch {}
      updateJournalState(journal.dir, { state: 'failed', reason: e.message })
      lock.release()
      return { success: false, error: { code: 'ATOMIC_WRITE_FAILED', message: e.message, txn_id: journal.txnId }, trace_id }
    }
    pipelineStep(pipeline, 'atomic_write', 'ok')
    updateJournalState(journal.dir, { state: 'committed', committed_at: new Date().toISOString() })

    // 组装 new_version（锁内，行号用 apply 后的真实值）
    newVersion = {
      file: { hash: `sha256:${sha256(newContent)}`, size: newContent.length },
      symbol: null,
    }
    if (symbol && range && newBodyLineCount != null) {
      const newLinesArr = newContent.split('\n')
      // 9（F2）：body_hash/range 遵循索引约定（symbol-anchors：slice(start_line-1,end_line) 含签名行的全符号）。
      // 旧实现 boundary=body 时 symStart=range[0]+1 → body_hash 只算 body（不含签名），与 read_symbol /
      // 预写 curBodyHash 的 full 约定不一致 → 同符号链式写（拿 new_version 当下一轮 base）误判 SYMBOL_CHANGED。
      const isBodyOnly = editMode === 'replace_symbol' && boundary === 'body'
      const fullEnd = isBodyOnly ? range[0] + newBodyLineCount : range[0] + Math.max(0, newBodyLineCount - 1)
      const newRange = [range[0], fullEnd]
      newVersion.symbol = {
        symbol_id: symbol.stable_id || null,
        range: newRange,
        body_hash: `sha256:${sha256(newLinesArr.slice(range[0] - 1, fullEnd).join('\n'))}`,
      }
    }

    // 10) force 写审计（附录 E）
    if (force) {
      auditLog(workspaceDir, { event: 'force_write', file: filePath, trace_id })
    }
    successResult = {
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
      pipeline,
      trace_id,
      duration_ms: Date.now() - t0,
    }
  } finally {
    lock.release()
  }
  if (!successResult) {
    return { success: false, error: { code: 'INTERNAL', message: 'writeSymbol completed without result', trace_id } }
  }
  // 9) 写后同步重抽（附录 D：写完立刻可读；锁外执行，缩短临界区）
  if (codeIndexService && langOf(filePath)) {
    try {
      const r = await codeIndexService.indexFile(absPath, workspaceDir)
      reindex = { status: 'ok', symbols: r?.symbols ?? 0, refs: r?.refs ?? 0 }
      pipelineStep(pipeline, 'reindex', 'ok')
      // 9（F2）：用重抽后的索引值校正 new_version.symbol——索引 body_hash/range 是 read_symbol 的权威来源。
      // 锁内算术推算（newBodyLineCount）会因 content 尾随换行与 parser end_line 对不上 →
      // 同符号链式写（拿 new_version 当下一轮 base）body_hash 不一致被误判 SYMBOL_CHANGED。
      const nvSym = successResult.new_version?.symbol
      if (nvSym?.symbol_id) {
        const fresh = codeIndexService.getSymbolByStableId(nvSym.symbol_id)
        if (fresh && fresh.body_hash) {
          nvSym.body_hash = `sha256:${fresh.body_hash}`
          nvSym.range = [fresh.start_line, fresh.end_line]
        }
      }
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
  if (reindex) successResult.reindex = reindex
  return successResult
}

function pipelineStep(pipeline, step, status, extra = {}) {
  pipeline.push({ step, status, ...extra })
}

// ---------- P4：write_symbols 批量（§6.4 隐式 all_or_nothing 事务 + §16.4 锁序 + 附录 D） ----------
// 应用层补偿事务（非 FS 级原子）：stage 全量 → 全验证 → 逐个文件原子写 → 任一失败回滚已写文件。
// 按文件聚合：同文件多符号合并为一次锁 + 一次原子写 + 一次重抽（§16.1）；
// 组内符号用行偏移（delta）修正定位，写后重抽再重新 resolve（跨调用路径）。
// 多文件锁按 workspace-relative path 字典序加锁防死锁（§16.4）。

function resolveBatchSymbol(codeIndexService, filePath, locator) {
  if (locator.symbol_id && codeIndexService) {
    const sym = codeIndexService.getSymbolByStableId(locator.symbol_id)
    if (sym && sym.file_path === filePath) return sym
    if (!sym) return { error: { code: 'SYMBOL_NOT_FOUND', message: `No symbol with stable_id ${locator.symbol_id} in ${filePath}` } }
    return { error: { code: 'SYMBOL_NOT_FOUND', message: `stable_id ${locator.symbol_id} belongs to ${sym.file_path}, not ${filePath}` } }
  }
  if (locator.name && codeIndexService) {
    const rows = codeIndexService.findSymbolsInFile(filePath, locator.name, locator.kind)
    if (rows.length > 1) {
      return { error: { code: 'AMBIGUOUS_SYMBOL', message: `${rows.length} candidates for "${locator.name}" in ${filePath}`, candidates: rows.map(r => ({ symbol_id: r.stable_id, name: r.name, kind: r.type, range: [r.start_line, r.end_line], signature: r.signature })) } }
    }
    if (rows.length === 0) return { error: { code: 'SYMBOL_NOT_FOUND', message: `No symbol named "${locator.name}" in ${filePath}` } }
    return rows[0]
  }
  return { error: { code: 'missing_parameter', message: 'each write requires locator.symbol_id or locator.name (patch mode: locator may be file-only)' } }
}

export async function writeSymbols(args, context) {
  const { codeIndexService, getWorkspaceDir, langParserService } = context
  const langParser = langParserService
  const workspaceDir = args?.workspace_dir
  const pipeline = []
  const trace_id = traceId()

  if (!workspaceDir) {
    return { success: false, error: { code: 'missing_parameter', message: 'workspace_dir is required' }, trace_id }
  }
  const writes = args?.writes
  if (!Array.isArray(writes) || writes.length === 0) {
    return { success: false, error: { code: 'missing_parameter', message: 'writes is required (non-empty array)' }, trace_id }
  }
  const policy = args?.policy || {}
  const allOrNothing = policy.all_or_nothing !== false
  const dryRun = !!policy.dry_run || !!args?.dry_run
  const safety = args?.safety || {}
  const force = !!args?.allow_unsafe_no_base || !!safety.allow_unsafe_no_base

  const t0 = Date.now()
  const recovered = recoverJournals(workspaceDir)
  if (recovered.length > 0) pipelineStep(pipeline, 'crash_recovery', 'warn', { recovered: recovered.length })

  // 按 file_path 分组（保输入序），组按 workspace-relative 路径字典序排序（§16.4 锁序防死锁）
  const groups = new Map()
  for (const w of writes) {
    // 11#3：兼容 schema 文档的 locator.file_path——旧实现只认根级 file_path，
    // 按 schema 传 locator.file_path 会误报 missing_parameter
    const fp = w?.file_path || w?.locator?.file_path
    if (!fp) {
      return { success: false, error: { code: 'missing_parameter', message: 'each write requires file_path (root-level or locator.file_path)' }, trace_id }
    }
    const pathCheck = validateFilePath(fp)
    if (!pathCheck.ok) {
      return { success: false, error: { code: 'PATH_BLOCKED', message: pathCheck.detail }, trace_id }
    }
    if (!groups.has(fp)) groups.set(fp, [])
    groups.get(fp).push(w)
  }
  const groupFiles = [...groups.keys()].sort()
  const absPathOf = (fp) => join(workspaceDir, fp)

  const items = []
  const written = []   // 已写文件：{ absPath, filePath, backup, journalDir }
  let failed = null
  let allDiffs = []

  // ── 逐组（文件）执行：锁 → 组内逐项 resolve+判定+apply（共享 lines）→ 一次原子写 ──
  for (const fp of groupFiles) {
    if (failed && allOrNothing) break
    const absPath = absPathOf(fp)
    if (!existsSync(absPath)) {
      failed = { file: fp, error: { code: 'FILE_NOT_FOUND', message: `File not found: ${fp}` } }
      break
    }
    // staleness 预热（锁外；批量内 resolve 需要新 range）
    if (codeIndexService) {
      try { await checkFileStaleness(codeIndexService, workspaceDir, fp) } catch {}
    }

    const lock = await acquireLock(absPath)
    if (lock.locked) {
      failed = { file: fp, error: { code: 'FILE_LOCKED', message: `File is locked by another writer: ${fp}`, suggestion: 'Retry after a moment.' } }
      break
    }
    try {
      let content = ''
      try { content = readFileSync(absPath, 'utf-8') } catch (e) {
        failed = { file: fp, error: { code: 'READ_FAILED', message: e.message } }
        break
      }
      let lines = content.split('\n')
      const appliedEdits = [] // {endLine(原文件坐标), delta}——偏移只对位于先前编辑点之后的符号生效
      let firstReal = true
      const groupItems = groups.get(fp)
      const groupResults = []

      for (let idx = 0; idx < groupItems.length; idx++) {
        const w = groupItems[idx]
        const editMode = w?.edit_mode || (w?.patch ? 'patch' : 'replace_symbol')
        const boundary = w?.boundary || 'full'
        const preserveDecorators = w?.preserve_decorators !== false

        // resolve（索引 range + 组内行偏移修正，§16.1：不复用入参 range）
        let symbol = null
        if (editMode === 'patch') {
          // patch 模式：可无符号（文件级 patch 或符号内 patch）
          if (w?.locator?.symbol_id || w?.locator?.name) {
            const rs = resolveBatchSymbol(codeIndexService, fp, w.locator)
            if (rs.error) { failed = { file: fp, itemIndex: idx, error: rs.error }; break }
            symbol = rs
          }
        } else {
          if (!w?.locator) { failed = { file: fp, itemIndex: idx, error: { code: 'missing_parameter', message: 'replace_symbol requires locator' } }; break }
          const rs = resolveBatchSymbol(codeIndexService, fp, w.locator)
          if (rs.error) { failed = { file: fp, itemIndex: idx, error: rs.error }; break }
          symbol = rs
        }
        // 7（F1）：旧实现全局 offset 累加——批内后项目标在先前编辑点之前时位置错移 → 负 range 静默丢行/重复。
        // 偏移只累计「编辑结束于本目标之前」的项；无符号的文件级 patch 位置未知，按旧行为全量偏移
        let offset = 0
        if (symbol) {
          for (const ae of appliedEdits) {
            if (ae.endLine != null && ae.endLine < symbol.start_line) offset += ae.delta
            else if (ae.endLine == null) offset += ae.delta
          }
        } else {
          for (const ae of appliedEdits) offset += ae.delta
        }
        const range = symbol ? [symbol.start_line + offset, Math.max(symbol.start_line + offset, symbol.end_line + offset)] : null

        // live hashes（内存 lines）
        const curBodyHash = symbol && range ? `sha256:${sha256(lines.slice(range[0] - 1, range[1]).join('\n'))}` : null
        const curSigHash = symbol && range ? `sha256:${sha256(extractSignatureLine(lines, { ...symbol, start_line: symbol.start_line + offset }) || '')}` : null
        const current = {
          file: { hash: `sha256:${sha256(lines.join('\n'))}`, size: lines.join('\n').length },
          symbol: symbol ? { body_hash: curBodyHash, signature_hash: curSigHash } : null,
        }

        // §16.7 幂等预检：目标已是意图内容 → already_applied，跳过冲突判定与 apply
        // （重试整批时 base_version 已过期，冲突判定会误拒——预检必须在冲突之前）
        if (w?.content && symbol && range) {
          const scopeText = boundary === 'body' ? lines.slice(range[0], range[1]).join('\n') : lines.slice(range[0] - 1, range[1]).join('\n')
          if (scopeText.trim() === w.content.trim()) {
            groupResults.push({ file_path: fp, symbol_id: symbol.stable_id || null, edit_mode: editMode, status: 'already_applied', content: w.content })
            pipelineStep(pipeline, 'idempotency', 'ok', { status: 'already_applied', file: fp })
            continue
          }
        } else if (editMode === 'patch' && w?.patch?.old_string) {
          const patchScope = symbol && range ? lines.slice(range[0] - 1, range[1]).join('\n') : lines.join('\n')
          if (countOccurrences(patchScope, w.patch.old_string) === 0 && w.patch.new_string && countOccurrences(patchScope, w.patch.new_string) > 0) {
            groupResults.push({ file_path: fp, symbol_id: symbol?.stable_id || null, edit_mode: editMode, status: 'already_applied' })
            pipelineStep(pipeline, 'idempotency', 'ok', { status: 'already_applied', file: fp })
            continue
          }
        }

        // 冲突判定：组内首个真实写项做 file-level（文件基线）；后续项仅符号级（文件已在批内变更）
        const itemBase = w?.base_version
        if (firstReal && !itemBase && !force) {
          failed = { file: fp, itemIndex: idx, error: { code: 'VERSION_CONFLICT', conflict_type: 'NO_BASE', message: 'base_version is required for the first write of each file (read_symbol first). Use allow_unsafe_no_base only when you intentionally bypass.', next_action: { tool: 'read_symbol', params: { locator: { file_path: fp } } } } }
          break
        }
        if (firstReal && itemBase) {
          const conflict = classifyConflict({ file: { hash: itemBase.file?.hash }, symbol: itemBase.symbol || null }, current, !!symbol)
          pipelineStep(pipeline, 'version_check', conflict.type === 'CLEAN' ? 'ok' : 'warn', { conflict: conflict.type, file: fp })
          const policy_ = CONFLICT_POLICY[conflict.type] || 'reject'
          if (policy_ === 'reject') {
            failed = { file: fp, itemIndex: idx, error: { code: 'VERSION_CONFLICT', conflict_type: conflict.type, message: `base_version mismatch: ${conflict.type}`, suggestion: 'Re-read the file and regenerate the batch.', next_action: { tool: 'read_symbol', params: { locator: { file_path: fp } } } } }
            break
          }
        } else if (!firstReal && itemBase?.symbol) {
          // 后续项：符号级判定（file hash 已在批内变化，无比较意义）
          const baseSymId = itemBase.symbol.symbol_id
          if (baseSymId && symbol && baseSymId === symbol.stable_id && curBodyHash && itemBase.symbol.body_hash !== curBodyHash) {
            failed = { file: fp, itemIndex: idx, error: { code: 'VERSION_CONFLICT', conflict_type: 'SYMBOL_CHANGED', message: `base_version mismatch: SYMBOL_CHANGED for ${symbol.stable_id}`, suggestion: 'Re-read the symbol and regenerate content.' } }
            break
          }
        }

        // apply
        const itemResult = applyBatchItem(lines, range, w, symbol, editMode, boundary, preserveDecorators)
        if (itemResult.error) { failed = { file: fp, itemIndex: idx, error: itemResult.error }; break }
        firstReal = false
        lines = itemResult.lines
        if (itemResult.delta) appliedEdits.push({ endLine: symbol ? symbol.end_line : null, delta: itemResult.delta })
        if (itemResult.diff) allDiffs.push({ file: fp, diff: itemResult.diff })
        groupResults.push({ file_path: fp, symbol_id: symbol?.stable_id || null, edit_mode: editMode, status: itemResult.status, content: w.content })
      }
      if (failed) break

      // 全组验证（一次）
      const newContent = lines.join('\n')
      const bracket = checkBracketBalance(newContent)
      const validation = { bracket: bracket.ok ? { status: 'pass' } : { status: 'fail', errors: [bracket.detail] } }
      if (langOf(fp)) {
        validation.syntax = await validateSyntax(langParser, newContent, extname(fp))
      } else {
        validation.syntax = { status: 'skip', reason: 'non-code file' }
      }
      pipelineStep(pipeline, 'validate', validation.syntax.status === 'pass' && validation.bracket.status === 'pass' ? 'ok' : 'warn', { syntax: validation.syntax.status, bracket: validation.bracket.status, file: fp })
      if (safety.block_on_validation_error && (validation.syntax.status === 'fail' || validation.syntax.status === 'skip' || validation.bracket.status === 'fail')) {
        failed = { file: fp, error: { code: 'VALIDATION_FAILED', message: `validation failed for ${fp}`, validation }, groupResults }
        break
      }

      if (dryRun) continue

      // journal + 一次原子写（组 = 文件）
      const journal = createJournal(workspaceDir, fp, absPath, content, { editMode: 'write_symbols', state: 'staged', base_file_hash: groupItems[0]?.base_version?.file?.hash || null })
      updateJournalState(journal.dir, { state: 'staged', new_hash: sha256(newContent) })
      const tmpPath = `${absPath}.tmp`
      try {
        // 7（F7）：writeFileSync 在 try 外——异常逃逸跳过 failed 分支与回滚
        writeFileSync(tmpPath, newContent)
        renameSync(tmpPath, absPath)
      } catch (e) {
        try { unlinkSync(tmpPath) } catch {}
        updateJournalState(journal.dir, { state: 'failed', reason: e.message })
        failed = { file: fp, error: { code: 'ATOMIC_WRITE_FAILED', message: e.message, txn_id: journal.txnId } }
        break
      }
      updateJournalState(journal.dir, { state: 'committed', committed_at: new Date().toISOString() })
      written.push({ absPath, filePath: fp, journalDir: journal.dir, txnId: journal.txnId, groupResults })
      pipelineStep(pipeline, 'atomic_write', 'ok', { file: fp })
      items.push(...groupResults.map(r => ({ ...r, txn_id: journal.txnId })))
    } finally {
      lock.release()
    }
  }

  // ── 回滚（补偿事务，§16.4：非 FS 级原子，兜底靠 journal） ──
  let rolledBack = []
  if (failed && allOrNothing && written.length > 0) {
    pipelineStep(pipeline, 'rollback', 'warn', { files: written.length })
    for (const wf of written) {
      try {
        const backup = join(wf.journalDir, 'backup', basename(wf.filePath))
        if (existsSync(backup)) {
          writeFileSync(`${wf.absPath}.rollback-tmp`, readFileSync(backup))
          renameSync(`${wf.absPath}.rollback-tmp`, wf.absPath)
          updateJournalState(wf.journalDir, { state: 'rolled_back', rolled_back_at: new Date().toISOString() })
          rolledBack.push(wf.filePath)
          auditLog(workspaceDir, { event: 'batch_rollback', file: wf.filePath, reason: failed.error?.code })
          // 恢复索引（文件已还原）
          if (codeIndexService) {
            try { await codeIndexService.indexFile(wf.absPath, workspaceDir) } catch { codeIndexService.markIndexDirty(wf.filePath, 'rollback_pending_reindex') }
          }
        }
      } catch (e) {
        pipelineStep(pipeline, 'rollback', 'error', { reason: `ROLLBACK_FAILED: ${e.message}`, file: wf.filePath })
        auditLog(workspaceDir, { event: 'rollback_failed', file: wf.filePath, reason: e.message })
      }
    }
  }

  // ── 写后同步重抽（锁外，附录 D；不回滚时每文件一次） ──
  let reindex = null
  if (!failed && !dryRun) {
    const perFile = {}
    for (const wf of written) {
      if (langOf(wf.filePath) && codeIndexService) {
        try {
          const r = await codeIndexService.indexFile(wf.absPath, workspaceDir)
          perFile[wf.filePath] = { status: 'ok', symbols: r?.symbols ?? 0 }
        } catch (e) {
          perFile[wf.filePath] = { status: 'failed', reason: e.message }
          codeIndexService.markIndexDirty(wf.filePath, 'write_pending_reindex')
        }
      } else if (codeIndexService) {
        const row = codeIndexService.getFileByPath(wf.filePath)
        if (row) {
          codeIndexService._db.prepare("UPDATE files SET content_hash = ?, index_state = 'fresh' WHERE path = ?").run(sha256(readFileSync(wf.absPath, 'utf-8')), wf.filePath)
          perFile[wf.filePath] = { status: 'ok', note: 'non-code' }
        }
      }
    }
    reindex = perFile
    pipelineStep(pipeline, 'reindex', 'ok', { files: Object.keys(perFile).length })
  }

  const success = !failed
  const undo = written.length > 0 ? {
    token: written[0].txnId,
    txn_id: written[0].txnId,
    expires_at: null,
    reverse: written.map(wf => ({ file: wf.filePath, backup: `${JOURNAL_ROOT}/journal/${wf.txnId}/backup/${basename(wf.filePath)}` })),
  } : null

  return {
    success,
    txn_id: written[0]?.txnId || null,
    mode: allOrNothing ? 'all_or_nothing' : 'best_effort',
    dry_run: dryRun || undefined,
    rolled_back: rolledBack.length > 0 ? rolledBack : undefined,
    items,
    diff: allDiffs,
    undo,
    reindex,
    pipeline,
    trace_id,
    duration_ms: Date.now() - t0,
    error: failed ? { ...failed.error, file: failed.file, itemIndex: failed.itemIndex } : undefined,
  }
}

function applyBatchItem(lines, range, w, symbol, editMode, boundary, preserveDecorators) {
  if (editMode !== 'patch' && typeof w?.content !== 'string') {
    // 7（F8）：content 缺失时 TypeError 逃逸——批量场景组循环无 catch，回滚段不可达，
    // 已写文件 journal 保持 committed，all_or_nothing 契约被静默破坏
    return { error: { code: 'missing_parameter', message: `content is required for edit_mode=${editMode}` } }
  }
  const scopeContent = symbol && range ? lines.slice(range[0] - 1, range[1]).join('\n') : lines.join('\n')
  if (editMode === 'patch') {
    const oldString = w?.patch?.old_string
    const newString = w?.patch?.new_string ?? ''
    if (typeof oldString !== 'string' || oldString === '') {
      return { error: { code: 'missing_parameter', message: 'patch.old_string is required' } }
    }
    const occurrences = countOccurrences(scopeContent, oldString)
    if (occurrences === 0) {
      if (newString && countOccurrences(scopeContent, newString) > 0) {
        return { lines, status: 'already_applied' }
      }
      return { error: { code: 'PATCH_OLD_STRING_NOT_FOUND', message: `old_string not found in ${symbol ? 'symbol body' : 'file'}` } }
    }
    if (occurrences > 1) {
      return { error: { code: 'PATCH_OLD_STRING_AMBIGUOUS', message: `old_string matches ${occurrences} times`, suggestion: 'Include more surrounding context in old_string.' } }
    }
    const before = lines.slice(0, range ? range[0] - 1 : 0)
    if (symbol && range) {
      const body = scopeContent.replace(oldString, newString)
      const after = lines.slice(range[1])
      const newLines = [...before, ...body.split('\n'), ...after]
      return { lines: newLines, delta: body.split('\n').length - (range[1] - range[0] + 1), diff: makeSimpleDiff(lines, newLines), status: 'ok' }
    }
    const patched = lines.join('\n').replace(oldString, newString)
    const newLines = patched.split('\n')
    // 9（F1）：文件级 patch 也要回 delta——旧实现无 delta → 不入 appliedEdits → 批内后续符号项
    // offset 计算（line ~674 的 endLine==null 全量偏移分支）拿不到这笔 → range 错位静默改错行。
    return { lines: newLines, delta: newLines.length - lines.length, diff: makeSimpleDiff(lines, newLines), status: 'ok' }
  }
  if (editMode === 'replace_symbol') {
    if (!symbol || !range) return { error: { code: 'missing_parameter', message: 'replace_symbol requires a resolved symbol' } }
    if (boundary === 'body') {
      // 已 applied 幂等（§16.7）
      const curBody = lines.slice(range[0], range[1]).join('\n')
      if (curBody.trim() === (w.content || '').trim()) return { lines, status: 'already_applied' }
      const r = applyBodyEdit(lines, [range[0] + 1, range[1]], w.content, preserveDecorators)
      if (r.error) return { error: r.error }
      return { lines: r.lines, delta: r.lines.length - lines.length, diff: r.diff, status: 'ok' }
    }
    const curFull = lines.slice(range[0] - 1, range[1]).join('\n')
    if (curFull.trim() === (w.content || '').trim()) return { lines, status: 'already_applied' }
    const r = applyReplace(lines, range, w.content)
    return { lines: r.lines, delta: r.lines.length - lines.length, diff: r.diff, status: 'ok' }
  }
  if (editMode === 'insert_after_symbol') {
    if (!symbol || !range) return { error: { code: 'missing_parameter', message: 'insert_after_symbol requires a resolved symbol' } }
    const r = applyInsertAfter(lines, range, w.content)
    return { lines: r.lines, delta: r.lines.length - lines.length, diff: r.diff, status: 'ok' }
  }
  return { error: { code: 'INVALID_INPUT', message: `unknown edit_mode: ${editMode}` } }
}
