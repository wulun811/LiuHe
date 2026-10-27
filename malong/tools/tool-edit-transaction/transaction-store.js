import { join, dirname, sep, resolve, basename, extname } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, statSync, readdirSync, renameSync, realpathSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { ErrorCodes, makeError, validateFilePath, findClosestMatch } from '../../error-codes.js'
import { registerWriter } from '../../writer-registry.js'
import { acquireLock, renameRetry, validateSyntax, reconcileBracketWithSyntax, shouldBlockValidation } from '../../write-runtime.js'
import { checkBracketBalance as sharedBracketCheck } from '../../write-edit.js'
import { langOf } from '../../symbol-anchors.js'
import { spawnSync } from 'node:child_process'
import { guardRealPath, isSafeTxnId, atomicWrite } from '../../path-guard.js'
import { sha256 } from '../../hash-utils.js'
import { restoreJournal } from '../../write-journal.js'
import { ensureGitExclude, isGitRepo } from '../../git-exclude.js'

// r9：统一走共享 path-guard（realpath 越界守卫 / txnId 消毒 / 原子写）
const _guardWritePath = guardRealPath
const _isSafeTxnId = isSafeTxnId
const _atomicWrite = atomicWrite

// r8(E4)：manifest 更新串行化（backupFile 的无锁 read-modify-write 在并行调用下会丢条目）
const _manifestLocks = new Map()
// R5：链尾执行完清理条目——防 _manifestLocks 无限增长（无界 Map 泄漏）
// 审核修复：R5 重构曾删掉 set——只 get 不 set 导致链恒为 Promise.resolve()，串行化失效（r8(E4) 回归）；恢复 set + 链尾判同删除
async function _withManifestLock(txnId, fn) {
  const prev = _manifestLocks.get(txnId) || Promise.resolve()
  const run = prev.then(fn, fn)
  _manifestLocks.set(txnId, run)
  try {
    return await run
  } finally {
    if (_manifestLocks.get(txnId) === run) _manifestLocks.delete(txnId)
  }
}

// 原子写：tmp+rename（崩溃不留半截文件；随机后缀防植入 .tmp symlink 穿透）——统一走 path-guard.atomicWrite

const LARGE_FILE_BYTES = 100 * 1024 * 1024

// R4a：清扫保护清单（显式列出防未来误删）——staged（崩溃恢复未处理）/ needs_review（外部修改待审）永不自动删
const PRUNE_PROTECTED_TXN_STATES = new Set(['staged', 'needs_review'])

// R22-④（审核修复）：按字节安全截断——slice(0,80) 按 UTF-16 code unit，80 个 CJK = 240B，
// tmp 路径追加 `.tmp-8hex` 后 262B > NAME_MAX(255) → ENAMETOOLONG 崩溃（实测 '汉'×80 复现）。
// 正则已把 emoji/扩展 B（代理对）转 '_'，slice 不会切出 lone surrogate。
function truncateBytes(s, maxBytes) {
  let out = s
  while (Buffer.byteLength(out) > maxBytes) out = out.slice(0, -1)
  return out
}

// R22-④（审核修复）：backupName symlink 读穿守卫——词法 resolve 拦不住 backup 内 symlink 指向外部文件
// （recoverTransactions/rollback/undoCommit 会把外部文件内容读回/写回 workspace，内容注入面）。
// realpath 解析后必须落在 backupDir 内；不存在/解析失败 → null（保守跳过）。
function safeBackupPath(backupDir, backupName) {
  // 批12-A：空/空白 backupName 拒绝——join(dir,'') 解析为目录本身，readFileSync 读目录 → EISDIR
  if (!backupName || !String(backupName).trim()) return null
  const resolvedBackup = resolve(join(backupDir, backupName))
  if (resolvedBackup !== backupDir && !resolvedBackup.startsWith(backupDir + sep)) return null
  if (!existsSync(resolvedBackup)) return null
  try {
    const real = realpathSync(resolvedBackup)
    const realRoot = realpathSync(backupDir)
    if (real !== realRoot && !real.startsWith(realRoot + sep)) return null
  } catch { return null }
  return resolvedBackup
}

export class TransactionStore {
  constructor(projectRoot, opts = {}) {
    this.projectRoot = projectRoot
    this.langParser = opts.langParser || null
    this.safety = opts.safety || null
    this.txnRoot = join(projectRoot, '.ai-transactions')
    if (!existsSync(this.txnRoot)) {
      mkdirSync(this.txnRoot, { recursive: true })
    }
    // R5：构造副作用的清扫默认开启；collision-guard 等只「读」的实例传 { sweep: false } 避免写副作用
    if (opts.sweep !== false) this._sweepStaleTxnDirs()
  }

  // r9(H11)：崩溃残留的未提交事务目录（txnRoot/<id>，不在 recent/）永不回收 → .ai-transactions 无限增长。
  // 仅清理超龄（>7 天）目录——任何合法事务不会存活超过一周，mtime 新鲜的在用事务不受影响
  // R4a：只允许删终态目录（committed/committed_recovered/rolled_back/abandoned）——staged/needs_review 保护
  _sweepStaleTxnDirs(maxAgeMs = 7 * 24 * 3600 * 1000) {
    try {
      const now = Date.now()
      for (const d of readdirSync(this.txnRoot, { withFileTypes: true })) {
        if (!d.isDirectory() || d.name === 'recent') continue
        try {
          if (now - statSync(join(this.txnRoot, d.name)).mtimeMs > maxAgeMs) {
            let state = 'unknown'
            try {
              const m = JSON.parse(readFileSync(join(this.txnRoot, d.name, 'manifest.json'), 'utf-8'))
              state = m.state || 'unknown'
            } catch {}
            if (PRUNE_PROTECTED_TXN_STATES.has(state)) continue
            rmSync(join(this.txnRoot, d.name), { recursive: true, force: true })
          }
        } catch {}
      }
    } catch {}
  }

  begin(name) {
    // r54(P0-2): name 直接拼进目录名——消毒防路径穿越。rename-symbol 用未校验的 symbol 拼 name
    // （`rename_${symbol}_to_${newName}`），symbol="/../../etc/x" 可逃出 .ai-transactions。白名单替换。
    // R22-②：与 handler 层 sanitize 统一——保留 CJK 可读性，`/` 与 `.`（含 `..`）仍转 `_`
    const safeName = truncateBytes(String(name).replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '_').replace(/_{2,}/g, '_'), 220) || 'txn'
    const txnId = `${safeName}-${randomUUID().split('-')[0]}`
    const txnPath = this._txnPath(txnId)
    // r9(P13)：唯一 tmp 名——固定 `txnPath + '.tmp'` 可被预置同名目录使 rename EEXIST（DoS）
    const tmpPath = `${txnPath}.tmp-${randomUUID().slice(0, 8)}`
    mkdirSync(join(tmpPath, 'backup'), { recursive: true })
    writeFileSync(join(tmpPath, 'manifest.json'), JSON.stringify({
      name,
      txnId,
      created: Date.now(),
      state: 'staged', // R4a：崩溃恢复判定依据——commit 写 committed，终态不参与恢复
      files: {}
    }, null, 2))
    // 审查修复（L4）：begin renameSync 无重试——Windows EPERM 裸抛（handler 无 catch）。
    // begin 保持同步（测试/调用方直接取 txnId），内联同步重试（对齐 renameRetry 语义）
    for (let i = 0; ; i++) {
      try { renameSync(tmpPath, txnPath); break } catch (e) {
        if (i >= 3 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150)
      }
    }
    this._ensureGitignore()
    return txnId
  }

  // 批10-1：committed 事务上继续编辑 → 自动续接新事务（替代 TXN_NOT_FOUND 打断）
  ensureActive(txnId) {
    if (!_isSafeTxnId(txnId)) {
      return { error: makeError(ErrorCodes.TXN_NOT_FOUND, `Transaction not found: ${txnId}`, { txnId }) }
    }
    if (existsSync(this._txnPath(txnId))) return { txnId }
    const recentPath = join(this.txnRoot, 'recent', txnId)
    if (existsSync(recentPath)) {
      let manifest = null
      try { manifest = JSON.parse(readFileSync(join(recentPath, 'manifest.json'), 'utf-8')) } catch {}
      if (manifest && manifest.state === 'committed') {
        const newId = this.begin(String(manifest.name || 'txn') + '_r2')
        const m = this._readManifest(newId)
        m.continued_from = txnId
        this._writeManifest(newId, m)
        return { txnId: newId, continued_from: txnId }
      }
    }
    return { error: makeError(ErrorCodes.TXN_NOT_FOUND, `Transaction not found: ${txnId}`, { txnId, suggestion: 'Transaction may have been rolled back. Use action=begin for a new transaction.' }) }
  }

  async backupFile(txnId, fileRel) {
    const pathCheck = validateFilePath(fileRel)
    if (pathCheck.blocked) {
      return makeError(ErrorCodes.PATH_BLOCKED, pathCheck.detail, { file: fileRel, reason: pathCheck.reason })
    }

    if (!existsSync(this._txnPath(txnId))) {
      return makeError(ErrorCodes.TXN_NOT_FOUND, `Transaction not found: ${txnId}`, {
        txnId,
        suggestion: 'Transaction may have been rolled back or committed. Use edit_transaction(action=begin) to create a new one.'
      })
    }

    const manifest = this._readManifest(txnId)
    if (manifest.files[fileRel]) return
    // r8(B1)：写备份前 realpath 越界守卫（workspace 内 symlink 指向外部）
    const guardB = _guardWritePath(this.projectRoot, fileRel)
    if (guardB.blocked) {
      return makeError(ErrorCodes.PATH_BLOCKED, guardB.detail, { file: fileRel, reason: guardB.reason })
    }

    const srcPath = join(this.projectRoot, fileRel)
    if (!existsSync(srcPath)) {
      return makeError(ErrorCodes.FILE_NOT_FOUND, `File does not exist: ${fileRel}`, { file: fileRel })
    }

    const stat = statSync(srcPath)
    if (stat.size > LARGE_FILE_BYTES) {
      // 拒绝而非静默 skipped：skipped 无备份 → rollback/undoCommit 无法还原，
      // 且 files_restored 计数虚假（递归进化第 5 轮 P0#9）
      return makeError(ErrorCodes.FILE_TOO_LARGE, `File exceeds ${Math.round(LARGE_FILE_BYTES / 1048576)}MB: ${fileRel}`, { file: fileRel, size: stat.size })
    }

    // R5：backupName 冲突修复——fileRel.replace(/[/\\]/g,'__') 让 a/b.js 与 a__b.js 撞名；
    // 改 sha256(fileRel) 前缀 + basename（旧事务 manifest 仍记 backupName 字段，恢复路径统一从字段读，兼容）
    const backupName = `${sha256(fileRel).slice(0, 16)}-${basename(fileRel)}`
    const backupPath = join(this._txnPath(txnId), 'backup', backupName)
    copyFileSync(srcPath, backupPath)
    // r8(E4)：manifest read-modify-write 串行化——并行 edit 同一事务不再丢备份条目
    await _withManifestLock(txnId, () => {
      const m = this._readManifest(txnId)
      m.files[fileRel] = { backupName, size: stat.size }
      this._writeManifest(txnId, m)
    })
    return { backedUp: true }
  }

  async applyEdits(txnId, fileRel, edits) {
    if (!_isSafeTxnId(txnId)) {
      return makeError(ErrorCodes.TXN_NOT_FOUND, `Transaction not found: ${txnId}`, { txnId })
    }
    const pathCheck = validateFilePath(fileRel)
    if (pathCheck.blocked) {
      return makeError(ErrorCodes.PATH_BLOCKED, pathCheck.detail, { file: fileRel, reason: pathCheck.reason })
    }
    const guard = _guardWritePath(this.projectRoot, fileRel)
    if (guard.blocked) {
      return makeError(ErrorCodes.PATH_BLOCKED, guard.detail, { file: fileRel, reason: guard.reason })
    }

    // r8(B1)：与 write_symbol/batch_edit 共用 .mlock——此前完全绕锁，并行写会静默互相覆盖
    const absPath = join(this.projectRoot, fileRel)
    const lock = await acquireLock(absPath, 30000)
    // r9(P1)：30s 争用超时返回 {locked:true}（无 release 方法）——旧代码直接 finally 调 release → TypeError
    if (lock.locked) {
      return makeError(ErrorCodes.TIMEOUT, `File is locked by another writer (30s): ${fileRel}`, { file: fileRel })
    }
    try {
      if (!existsSync(absPath)) {
        return makeError(ErrorCodes.FILE_NOT_FOUND, `File does not exist: ${fileRel}`, { file: fileRel })
      }

      const content = readFileSync(absPath, 'utf-8')
      // 13-A：匹配引擎抽为纯函数（simulateEdits）——dry-run 预览与真实编辑共用同一语义
      const { result, applied, failedEdits, ambiguousEdits, matches } = simulateEdits(content, edits)

      const hasNotEmptyFailure = failedEdits.some(f => f.reason !== 'empty_old_string')
      if (applied === 0 && hasNotEmptyFailure) {
        // 批10-2：单个失败且带专属错误码（STALE_CONTENT/INVALID_INPUT）时透传，便于定向重试
        const first = failedEdits.find(f => f.reason !== 'empty_old_string')
        const onlyOne = failedEdits.filter(f => f.reason !== 'empty_old_string').length === 1
        const code = (onlyOne && first?.error_code) ? first.error_code : ErrorCodes.NO_MATCH
        const message = (onlyOne && first?.detail) ? first.detail : 'No edits matched in file'
        return makeError(code, message, { file: fileRel, failed_edits: failedEdits })
      }
      // R3：全空 old_string → 不写盘，返回 staged + warning（拒绝谎报成功）
      if (applied === 0 && failedEdits.length > 0) {
        return { status: 'staged', file: fileRel, edits_applied: 0, warning: 'no edits applied (all old_string values were empty)' }
      }

      const res = await this._commitStagedContent(txnId, fileRel, content, result, applied, failedEdits)
      if (res && res.status === 'staged') {
        const anchors = matches.filter(m => m.anchor_checked).map(m => m.line)
        if (anchors.length) res.anchor_checked_lines = anchors
      }
      if (res && res.status === 'staged' && ambiguousEdits.length > 0) {
        res.ambiguous_edits = ambiguousEdits
        res.warning = (res.warning ? res.warning + '; ' : '') + `${ambiguousEdits.length} edit(s) matched multiple occurrences; first occurrence replaced (pass replace_all:true to replace all)`
      }
      return res
    } finally {
      lock.release()
    }
  }

  // 13-A：dry-run 预览——只验证可匹配性与校验结果，不落盘/不写 manifest/不建备份（用户提：一次不匹配全回滚代价大）
  async previewEdits(fileRel, edits, opts = {}) {
    const pathCheck = validateFilePath(fileRel)
    if (pathCheck.blocked) {
      return makeError(ErrorCodes.PATH_BLOCKED, pathCheck.detail, { file: fileRel, reason: pathCheck.reason })
    }
    if (opts.txnId && !_isSafeTxnId(opts.txnId)) {
      return makeError(ErrorCodes.TXN_NOT_FOUND, `Transaction not found: ${opts.txnId}`, { txnId: opts.txnId })
    }
    const guard = _guardWritePath(this.projectRoot, fileRel)
    if (guard.blocked) {
      return makeError(ErrorCodes.PATH_BLOCKED, guard.detail, { file: fileRel, reason: guard.reason })
    }
    const absPath = join(this.projectRoot, fileRel)
    if (!existsSync(absPath)) {
      return makeError(ErrorCodes.FILE_NOT_FOUND, `File does not exist: ${fileRel}`, { file: fileRel })
    }
    const content = readFileSync(absPath, 'utf-8')
    const sim = simulateEdits(content, edits)
    const res = {
      status: 'preview',
      dry_run: true,
      file: fileRel,
      edits_total: edits.length,
      would_apply: sim.applied,
      matches: sim.matches,
    }
    if (opts.txnId) res.txn_id = opts.txnId
    if (sim.failedEdits.length) res.failed_edits = sim.failedEdits
    if (sim.ambiguousEdits.length) {
      res.ambiguous_edits = sim.ambiguousEdits
      res.warning = sim.ambiguousEdits.length + ' edit(s) match multiple occurrences; first occurrence would be replaced (pass replace_all:true to replace all)'
    }
    if (sim.applied > 0) {
      const validation = await this._validateContent(fileRel, sim.result)
      res.validation = validation
      if (shouldBlockValidation(this.safety, validation)) {
        res.would_block = true
        res.diagnostics = validation.diagnostics || []
        res.suggestion = 'Resulting content fails validation; fix the marked region before applying.'
      }
    }
    return res
  }

  // 13-A：事务内新建文件（用户提：支持 create 才能真正一个工具打天下）——落盘即 staged，rollback/undo_commit 删除
  async createFile(txnId, fileRel, content) {
    if (!_isSafeTxnId(txnId)) {
      return makeError(ErrorCodes.TXN_NOT_FOUND, `Transaction not found: ${txnId}`, { txnId })
    }
    const pathCheck = validateFilePath(fileRel)
    if (pathCheck.blocked) {
      return makeError(ErrorCodes.PATH_BLOCKED, pathCheck.detail, { file: fileRel, reason: pathCheck.reason })
    }
    if (!existsSync(this._txnPath(txnId))) {
      return makeError(ErrorCodes.TXN_NOT_FOUND, `Transaction not found: ${txnId}`, { txnId })
    }
    if (typeof content !== 'string') {
      return makeError(ErrorCodes.INVALID_INPUT, 'content (string) is required when create=true', { file: fileRel })
    }
    const guard = _guardWritePath(this.projectRoot, fileRel)
    if (guard.blocked) {
      return makeError(ErrorCodes.PATH_BLOCKED, guard.detail, { file: fileRel, reason: guard.reason })
    }
    const absPath = join(this.projectRoot, fileRel)
    // acquireLock 在父目录不存在时 ENOENT 裸抛——先建目录再取锁（竞争 create 同一路径时锁串行化）
    try { mkdirSync(dirname(absPath), { recursive: true }) } catch {}
    const lock = await acquireLock(absPath, 30000)
    if (lock.locked) {
      return makeError(ErrorCodes.TIMEOUT, `File is locked by another writer (30s): ${fileRel}`, { file: fileRel })
    }
    try {
      if (existsSync(absPath)) {
        return makeError(ErrorCodes.INVALID_INPUT, `File already exists: ${fileRel} (use action=edit instead of create)`, { file: fileRel })
      }
      const validation = await this._validateContent(fileRel, content)
      if (shouldBlockValidation(this.safety, validation)) {
        return {
          error_code: 'VALIDATION_FAILED',
          message: 'validation failed: syntax/bracket errors detected; refusing write. Pass safety.block_on_validation_error=false to override.',
          file: fileRel,
          validation,
          diagnostics: validation.diagnostics || [],
          suggestion: 'Fix the marked region and retry (only the changed region needs re-sending).',
        }
      }
      _atomicWrite(absPath, content, { fsync: true, preservePermissions: true })
      registerWriter(this.projectRoot, fileRel, 'transaction')
      await _withManifestLock(txnId, () => {
        const m = this._readManifest(txnId)
        m.files[fileRel] = { ...(m.files[fileRel] || {}), created: true, new_hash: sha256(Buffer.from(content, 'utf-8')) }
        this._writeManifest(txnId, m)
      })
      const res = { status: 'staged', file: fileRel, created: true, validation }
      const validationWarnings = (validation.diagnostics || []).map(d => ({ type: d.source, bracket: d.bracket, line: d.line, detail: d.message }))
      if (validationWarnings.length > 0) res.validation_warnings = validationWarnings
      return res
    } finally {
      lock.release()
    }
  }

  // 13-A：created 文件回退——仅当内容仍为事务写入字节时删除（外部改动 → skip，防误删）
  async _removeCreatedFile(fileRel, meta) {
    const destPath = join(this.projectRoot, fileRel)
    if (!existsSync(destPath)) return { restored: true }
    const lock = await acquireLock(destPath, 30000)
    if (lock.locked) return { skipped: 'file_locked' }
    try {
      const curHash = sha256(readFileSync(destPath))
      if (meta.new_hash && curHash !== meta.new_hash) return { skipped: 'external_change' }
      rmSync(destPath, { force: true })
      return { restored: true }
    } finally {
      lock.release()
    }
  }

  // 批10-3：写盘收尾共用（applyEdits / assemble）——校验拦截 → 备份刷新 → 原子写 → manifest
  async _commitStagedContent(txnId, fileRel, content, result, applied, failedEdits) {
    const absPath = join(this.projectRoot, fileRel)
    // 批10-1：写盘前语法/bracket 校验（与 write-runtime 同套护栏）；失败不写盘、不改 manifest
    const validation = await this._validateContent(fileRel, result)
    if (shouldBlockValidation(this.safety, validation)) {
      return {
        error_code: 'VALIDATION_FAILED',
        message: 'validation failed: syntax/bracket errors detected; refusing write. Pass safety.block_on_validation_error=false to override.',
        file: fileRel,
        validation,
        diagnostics: validation.diagnostics || [],
        suggestion: 'Fix the marked region and retry this edit (only the changed region needs re-sending).',
      }
    }
    const validationWarnings = (validation.diagnostics || []).map(d => ({ type: d.source, bracket: d.bracket, line: d.line, detail: d.message }))

    // 审查修复（H3）：锁内用刚读到的 content 刷新备份——backupFile 在锁外复制（backup=X），
    // 若外部修改 Y 发生在其后，旧 backup=X 比事务读到的 Y 旧；rollback 恢复 X 会覆盖 Y 的外部修改。
    // 锁内覆盖 backup == 事务读到的内容（含外部修改），回滚只撤事务自己的改动，不丢外部修改。
    try {
      const m = this._readManifest(txnId)
      const bname = m.files[fileRel]?.backupName
      if (bname) writeFileSync(join(this._txnPath(txnId), 'backup', bname), content, 'utf-8')
    } catch {}

    _atomicWrite(absPath, result, { fsync: true, preservePermissions: true })
    // Y002-S1：事务写落盘后登记写者（collision_guard classify 识别 transaction）
    registerWriter(this.projectRoot, fileRel, 'transaction')
    // R4a：记录 new_hash——崩溃恢复三方判定的「已落盘」依据（对齐 recoverJournals 模式）
    // WP04：new_hash 同步透出——响应级「应用后实际写入内容 hash」（manifest 与 receipt 共用同源）
    const newHash = sha256(Buffer.from(result, 'utf-8'))
    await _withManifestLock(txnId, () => {
      const m = this._readManifest(txnId)
      m.files[fileRel] = { ...(m.files[fileRel] || {}), new_hash: newHash }
      this._writeManifest(txnId, m)
    })
    const res = { status: 'staged', file: fileRel, edits_applied: applied, validation, new_hash: newHash }
    if (failedEdits.length > 0) {
      res.failed_edits = failedEdits
      res.warning = `${failedEdits.length} edit(s) did not match`
    }
    if (validationWarnings.length > 0) {
      res.validation_warnings = validationWarnings
    }
    return res
  }

  // 批10-3：分块累积——大文件重写拆小块，每块独立传输，坏块只重发该块
  _stagingDir(txnId) {
    return join(this._txnPath(txnId), 'staging')
  }

  async writeChunk(txnId, fileRel, seq, lines, total) {
    if (!_isSafeTxnId(txnId)) {
      return makeError(ErrorCodes.TXN_NOT_FOUND, `Transaction not found: ${txnId}`, { txnId })
    }
    const pathCheck = validateFilePath(fileRel)
    if (pathCheck.blocked) {
      return makeError(ErrorCodes.PATH_BLOCKED, pathCheck.detail, { file: fileRel, reason: pathCheck.reason })
    }
    if (!existsSync(this._txnPath(txnId))) {
      return makeError(ErrorCodes.TXN_NOT_FOUND, `Transaction not found: ${txnId}`, { txnId })
    }
    if (!existsSync(join(this.projectRoot, fileRel))) {
      return makeError(ErrorCodes.FILE_NOT_FOUND, `File does not exist: ${fileRel} (edit_chunk/assemble rewrites existing files; create new files via code_patch create:true)`, { file: fileRel })
    }
    if (!Number.isInteger(seq) || seq < 1) {
      return makeError(ErrorCodes.INVALID_INPUT, 'seq must be an integer >= 1', { file: fileRel })
    }
    if (!Array.isArray(lines) || !lines.every(l => typeof l === 'string')) {
      return makeError(ErrorCodes.INVALID_INPUT, 'lines must be an array of strings', { file: fileRel })
    }
    if (total !== undefined && total !== null && (!Number.isInteger(total) || total < 1)) {
      return makeError(ErrorCodes.INVALID_INPUT, 'total must be an integer >= 1', { file: fileRel })
    }
    if (Number.isInteger(total) && seq > total) {
      return makeError(ErrorCodes.INVALID_INPUT, 'seq exceeds total', { file: fileRel, seq, total })
    }
    const prefix = sha256(fileRel).slice(0, 16)
    const dir = this._stagingDir(txnId)
    mkdirSync(dir, { recursive: true })
    let existing = []
    try { existing = readdirSync(dir).filter(n => n.startsWith(prefix + '.part-')) } catch {}
    const seqs = existing.map(n => Number(n.split('.part-')[1])).filter(Number.isInteger)
    const maxSeq = seqs.length ? Math.max(...seqs) : 0
    const isResend = seqs.includes(seq)
    if (!isResend && seq !== maxSeq + 1) {
      return makeError(ErrorCodes.CHUNK_SEQ_GAP, `chunk seq gap: expected ${maxSeq + 1}, got ${seq}`, { file: fileRel, expected_seq: maxSeq + 1, received: seqs.length })
    }
    _atomicWrite(join(dir, `${prefix}.part-${seq}`), lines.join('\n'), { fsync: true })
    const received = new Set(seqs)
    received.add(seq)
    if (Number.isInteger(total)) {
      await _withManifestLock(txnId, () => {
        const m = this._readManifest(txnId)
        m.staging = m.staging || {}
        m.staging[fileRel] = { prefix, total }
        this._writeManifest(txnId, m)
      })
    }
    const out = { status: 'chunk_received', file: fileRel, seq, received: received.size }
    if (Number.isInteger(total)) {
      out.total = total
      out.ready_to_assemble = received.size >= total && Math.max(...received) <= total
    }
    return out
  }

  async assemble(txnId, fileRel, opts = {}) {
    if (!_isSafeTxnId(txnId)) {
      return makeError(ErrorCodes.TXN_NOT_FOUND, `Transaction not found: ${txnId}`, { txnId })
    }
    const pathCheck = validateFilePath(fileRel)
    if (pathCheck.blocked) {
      return makeError(ErrorCodes.PATH_BLOCKED, pathCheck.detail, { file: fileRel, reason: pathCheck.reason })
    }
    if (!existsSync(this._txnPath(txnId))) {
      return makeError(ErrorCodes.TXN_NOT_FOUND, `Transaction not found: ${txnId}`, { txnId })
    }
    const absPath = join(this.projectRoot, fileRel)
    if (!existsSync(absPath)) {
      return makeError(ErrorCodes.FILE_NOT_FOUND, `File does not exist: ${fileRel}`, { file: fileRel })
    }
    const guard = _guardWritePath(this.projectRoot, fileRel)
    if (guard.blocked) {
      return makeError(ErrorCodes.PATH_BLOCKED, guard.detail, { file: fileRel, reason: guard.reason })
    }
    const prefix = sha256(fileRel).slice(0, 16)
    const dir = this._stagingDir(txnId)
    let names = []
    try { names = readdirSync(dir).filter(n => n.startsWith(prefix + '.part-')) } catch {}
    if (names.length === 0) {
      return makeError(ErrorCodes.CHUNK_INCOMPLETE, 'no chunks received for this file', { file: fileRel })
    }
    const seqs = names.map(n => Number(n.split('.part-')[1])).filter(Number.isInteger).sort((a, b) => a - b)
    const maxSeq = seqs[seqs.length - 1]
    const missing = []
    for (let i = 1; i <= maxSeq; i++) if (!seqs.includes(i)) missing.push(i)
    let total = null
    try { total = this._readManifest(txnId)?.staging?.[fileRel]?.total ?? null } catch {}
    if (Number.isInteger(total)) {
      for (let i = 1; i <= total; i++) if (!seqs.includes(i) && !missing.includes(i)) missing.push(i)
    }
    if (missing.length > 0) {
      return makeError(ErrorCodes.CHUNK_INCOMPLETE, 'missing chunk seq: ' + missing.join(','), { file: fileRel, missing, received: seqs.length, total })
    }
    const allLines = []
    for (const s of seqs) allLines.push(...readFileSync(join(dir, `${prefix}.part-${s}`), 'utf-8').split('\n'))
    const result = allLines.join('\n')
    const lock = await acquireLock(absPath, 30000)
    if (lock.locked) {
      return makeError(ErrorCodes.TIMEOUT, `File is locked by another writer (30s): ${fileRel}`, { file: fileRel })
    }
    try {
      const content = readFileSync(absPath, 'utf-8')
      if (opts.expect_sha) {
        const want = String(opts.expect_sha).replace(/^sha256:/, '')
        if (sha256(Buffer.from(content, 'utf-8')) !== want) {
          return makeError(ErrorCodes.STALE_CONTENT, 'expect_sha mismatch: file changed since read; re-read then re-send chunks if needed', { file: fileRel })
        }
      }
      // 批12-A：首次落盘前登记备份（写锁内）——assemble 此前不登记 backupName，
      // rollback/undoCommit 拿到空 backupName → 读 backup 目录 EISDIR，原文件无法恢复。
      // 备份失败必须中止写入（不落盘、无 new_hash）。
      let bres
      try {
        bres = await this.backupFile(txnId, fileRel)
      } catch (e) {
        return makeError(ErrorCodes.BACKUP_FAILED, `backup failed; refusing to write ${fileRel}: ${e.message}`, { file: fileRel })
      }
      if (bres && bres.error_code) return bres
      const res = await this._commitStagedContent(txnId, fileRel, content, result, seqs.length, [])
      if (res && !res.error_code) {
        for (const s of seqs) { try { rmSync(join(dir, `${prefix}.part-${s}`), { force: true }) } catch {} }
        try {
          await _withManifestLock(txnId, () => {
            const m = this._readManifest(txnId)
            if (m.staging && m.staging[fileRel]) { delete m.staging[fileRel]; this._writeManifest(txnId, m) }
          })
        } catch {}
        res.assembled_chunks = seqs.length
      }
      return res
    } finally {
      lock.release()
    }
  }

  async commit(txnId) {
    if (!_isSafeTxnId(txnId)) {
      return makeError(ErrorCodes.TXN_NOT_FOUND, `Transaction not found: ${txnId}`, { txnId })
    }
    const txnPath = this._txnPath(txnId)
    if (!existsSync(txnPath)) {
      return makeError(ErrorCodes.TXN_NOT_FOUND, `Transaction not found: ${txnId}`, { txnId })
    }
    const manifest = this._readManifest(txnId)
    const filesChanged = Object.keys(manifest.files)
    // 批10-1：commit 复检——staged 后外部改动（hash 不符）或坏语法内容不得入档
    for (const [fileRel, meta] of Object.entries(manifest.files || {})) {
      if (meta.skipped || !meta.new_hash) continue
      const guard = _guardWritePath(this.projectRoot, fileRel)
      if (guard.blocked) {
        return { error: 'commit_conflict', code: 'PATH_BLOCKED', file: fileRel, message: guard.detail, txn_id: txnId }
      }
      const abs = join(this.projectRoot, fileRel)
      if (!existsSync(abs)) {
        return { error: 'commit_conflict', code: 'FILE_NOT_FOUND', file: fileRel, message: 'staged file missing at commit time', txn_id: txnId }
      }
      const curBuf = readFileSync(abs)
      if (sha256(curBuf) !== meta.new_hash) {
        return { error: 'commit_conflict', code: 'EXTERNAL_CHANGE', file: fileRel, message: 'file changed after staging (external writer); commit refused', txn_id: txnId, suggestion: 'rollback or re-edit the file, then commit again' }
      }
      const validation = await this._validateContent(fileRel, curBuf.toString('utf-8'))
      if (shouldBlockValidation(this.safety, validation)) {
        return { error: 'commit_blocked', code: 'VALIDATION_FAILED', file: fileRel, validation, diagnostics: validation.diagnostics || [], txn_id: txnId, suggestion: 'fix the marked region with a small edit, then commit again' }
      }
    }
    // r8(D4)：淘汰键 = commit 时间——目录 mtime 是 begin 时间，交错事务下“最晚提交”会被误删
    manifest.committed_at = new Date().toISOString()
    manifest.state = 'committed' // R4a：终态标记，崩溃恢复跳过
    this._writeManifest(txnId, manifest)
    const recentDir = join(this.txnRoot, 'recent')
    if (!existsSync(recentDir)) {
      mkdirSync(recentDir, { recursive: true })
    }
    const recentPath = join(recentDir, txnId)
    // R22-⑰（第四轮审核 P1）：renameSync 改 renameRetry（EPERM/EBUSY/EACCES 重试）——
    // Windows 杀软/索引服务短暂占用事务目录时旧实现裸抛 EPERM，事务 staged 但用户拿裸异常。
    // 失败返回结构化错误（retryable），不抛——handler 层 await 无 try/catch，抛了会崩 MCP。
    try {
      await renameRetry(txnPath, recentPath)
    } catch (e) {
      // 审查修复（L5）：rename 失败回写 staged——旧实现状态已标 committed 但目录卡顶层，
      // undoCommit 只查 recent/ + committed_recovered → 该事务无法撤销且状态矛盾（可 rollback 但无人告知）
      try {
        const m = this._readManifest(txnId)
        m.state = 'staged'
        this._writeManifest(txnId, m)
      } catch {}
      return { error: 'commit_failed', code: 'commit_failed', message: `Commit rename failed: ${e.message}`, retryable: true, txn_id: txnId }
    }
    this._cleanRecent(3)
    // 批10-1：回执带每文件行数变化（+/- 真值走 git no-index，缺 git 时退行数差）
    const stats = []
    for (const fileRel of filesChanged) {
      const meta = manifest.files[fileRel] || {}
      if (!meta.new_hash) continue
      try {
        const curText = readFileSync(join(this.projectRoot, fileRel), 'utf-8')
        const bp = safeBackupPath(join(recentPath, 'backup'), meta.backupName || '')
        stats.push(_diffStats(fileRel, bp ? readFileSync(bp, 'utf-8') : '', curText, bp, join(this.projectRoot, fileRel)))
      } catch {}
    }
    return { status: 'committed', files_changed: filesChanged.length, files: filesChanged, stats }
  }

  async undoCommit(txnId) {
    if (!_isSafeTxnId(txnId)) {
      return makeError(ErrorCodes.TXN_NOT_FOUND, `Transaction not found: ${txnId}`, { txnId })
    }
    const recentPath = join(this.txnRoot, 'recent', txnId)
    // R22-⑳（冻结期工作流实测 P1）：崩溃恢复标记 committed_recovered 的事务在 txnRoot 顶层
    // （recoverTransactions 注释意图是「保留目录供 undo」），旧实现 undoCommit 只查 recent/ →
    // 崩溃残留永远无法撤销（TXN_NOT_FOUND）。回退查顶层 committed_recovered 目录。
    let txnPath = null
    if (existsSync(recentPath)) {
      txnPath = recentPath
    } else {
      const directPath = join(this.txnRoot, txnId)
      if (existsSync(directPath)) {
        try {
          const m = JSON.parse(readFileSync(join(directPath, 'manifest.json'), 'utf-8'))
          if (m.state === 'committed_recovered') txnPath = directPath
        } catch {}
      }
    }
    if (!txnPath) {
      // Q1：双命名空间——write_symbol / write_symbols / edit_batch / code_patch 的写链 journal
      // 在 <ws>/.malong/journal（保留 24h）；经典 .ai-transactions 未命中时委托 restoreJournal。
      const jr = await restoreJournal(this.projectRoot, txnId)
      if (jr.ok) {
        return {
          status: jr.status === 'already_undone' ? 'already_undone' : (jr.status === 'undone_partial' ? 'undone_partial' : 'undone'),
          files_restored: jr.files_restored,
          files: jr.files,
          ...(jr.deleted ? { deleted: true } : {}),
          ...(jr.note ? { note: jr.note } : {}),
          // 16-B：批量 undo 归因（batch_id/成员统计）与部分失败重试口径透传
          ...(jr.batch ? { batch: jr.batch } : {}),
          ...(jr.failures ? { failures: jr.failures } : {}),
          ...(jr.retryable ? { retryable: true } : {}),
          via: 'write-journal',
        }
      }
      if (jr.code === 'TXN_NOT_FOUND' || jr.code === 'JOURNAL_NOT_FOUND') {
        return makeError(ErrorCodes.TXN_NOT_FOUND, jr.message, { txnId, suggestion: jr.suggestion || 'Only the last 3 committed transactions can be undone; write journals are retained 24h.' })
      }
      const code = (jr.code === 'EXTERNAL_CHANGE' || jr.code === 'BATCH_BLOCKED') ? 'undo_conflict' : (jr.code === 'FILE_LOCKED' ? 'file_locked' : 'undo_failed')
      return makeError(code, jr.message, { txnId, suggestion: jr.suggestion, ...(jr.batch ? { batch: jr.batch } : {}) })
    }
    const manifest = JSON.parse(readFileSync(join(txnPath, 'manifest.json'), 'utf-8'))
    const backupDir = join(txnPath, 'backup')
    let filesRestored = 0
    const skipped = []
    for (const [fileRel, meta] of Object.entries(manifest.files || {})) {
      if (meta.skipped) continue
      // r8(B2)：manifest 内容不可信——每个 fileRel 过路径守卫，防植入 manifest 越界写
      const guard = _guardWritePath(this.projectRoot, fileRel)
      if (guard.blocked) { skipped.push({ file: fileRel, reason: guard.reason }); continue }
      // 13-A：created 文件回退 = 删除（仅内容仍为事务字节；外部改动 → skip）
      if (meta.created) {
        const rc = await this._removeCreatedFile(fileRel, meta)
        if (rc.restored) filesRestored++
        else skipped.push({ file: fileRel, reason: rc.skipped })
        continue
      }
      const backupPath = join(backupDir, meta.backupName || '')
      // r9(P6)：manifest 的 backupName 不可信——join(backupDir, 绝对路径) 会返回绝对路径（前缀丢弃）→ 读穿任意文件；resolve 后必须落在 backupDir 内
      // R22-④：补 realpath 守卫（词法 resolve 拦不住 backup 内 symlink 指向外部文件）
      // 批12-A：无备份登记 → 明确诊断，不得读目录（EISDIR）
      if (!meta.backupName) {
        skipped.push({ file: fileRel, reason: 'backup_missing', detail: 'no backup registered for this file; cannot restore; file left unchanged' })
        continue
      }
      const resolvedBackup = safeBackupPath(backupDir, meta.backupName || '')
      if (!resolvedBackup) { skipped.push({ file: fileRel, reason: 'backup_escape' }); continue }
      const destPath = join(this.projectRoot, fileRel)
      if (!existsSync(resolvedBackup) || !existsSync(destPath)) { skipped.push({ file: fileRel, reason: 'missing_backup_or_target' }); continue }
      // R5：还原前取锁 + 哈希比对——当前==new_hash（事务改的）或 ==backup（未改）才还原；否则外部修改 → skip
      const lock = await acquireLock(destPath, 30000)
      if (lock.locked) { skipped.push({ file: fileRel, reason: 'file_locked' }); continue }
      try {
        const curHash = sha256(readFileSync(destPath))
        const backupHash = sha256(readFileSync(resolvedBackup))
        if (meta.new_hash && curHash !== backupHash && curHash !== meta.new_hash) {
          skipped.push({ file: fileRel, reason: 'external_change' })
          continue
        }
        _atomicWrite(destPath, readFileSync(resolvedBackup, 'utf-8'), { fsync: true, preservePermissions: true })
        filesRestored++
      } finally {
        lock.release()
      }
    }
    // R22-⑯：skipped 文件不删目录——undo 能力保留供重试（file_locked 是瞬时失败，external_change 可人工核对后再试）
    if (skipped.length > 0) {
      return { status: 'undone_partial', retryable: true, files_restored: filesRestored, files: Object.keys(manifest.files || {}), skipped }
    }
    rmSync(txnPath, { recursive: true, force: true })
    const res = { status: 'undone', files_restored: filesRestored, files: Object.keys(manifest.files || {}) }
    return res
  }

  _cleanRecent(maxKeep) {
    const recentDir = join(this.txnRoot, 'recent')
    if (!existsSync(recentDir)) return
    const entries = readdirSync(recentDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => {
        // r8(D4)：按 manifest.committed_at 排序（fallback 目录 mtime）——commit 时才写 committed_at
        let ts = 0
        try {
          const m = JSON.parse(readFileSync(join(recentDir, d.name, 'manifest.json'), 'utf-8'))
          const t = m?.committed_at ? Date.parse(m.committed_at) : NaN
          ts = Number.isFinite(t) ? t : 0
        } catch {}
        if (!ts) { try { ts = statSync(join(recentDir, d.name)).mtimeMs } catch {} }
        return { name: d.name, mtime: ts }
      })
      .sort((a, b) => b.mtime - a.mtime)
    for (let i = maxKeep; i < entries.length; i++) {
      rmSync(join(recentDir, entries[i].name), { recursive: true, force: true })
    }
  }

  async rollback(txnId) {
    if (!_isSafeTxnId(txnId)) {
      return makeError(ErrorCodes.TXN_NOT_FOUND, `Transaction not found: ${txnId}`, { txnId })
    }
    const txnPath = this._txnPath(txnId)
    if (!existsSync(txnPath)) {
      return makeError(ErrorCodes.TXN_NOT_FOUND, `Transaction not found: ${txnId}`, { txnId })
    }
    const manifest = this._readManifest(txnId)
    const backupDir = join(txnPath, 'backup')
    let filesRestored = 0
    const skipped = []

    for (const [fileRel, meta] of Object.entries(manifest.files || {})) {
      if (meta.skipped) continue
      // r8(B2)：manifest 内容不可信——每个 fileRel 过路径守卫
      const guard = _guardWritePath(this.projectRoot, fileRel)
      if (guard.blocked) {
        skipped.push({ file: fileRel, reason: guard.reason })
        continue
      }
      // 13-A：created 文件回退 = 删除（仅内容仍为事务字节；外部改动 → skip）
      if (meta.created) {
        const rc = await this._removeCreatedFile(fileRel, meta)
        if (rc.restored) filesRestored++
        else skipped.push({ file: fileRel, reason: rc.skipped })
        continue
      }
      const backupPath = join(backupDir, meta.backupName || '')
      // r9(P6)：backupName 不可信——resolve 后必须落在 backupDir 内
      // R22-④：补 realpath 守卫（词法 resolve 拦不住 backup 内 symlink 指向外部文件）
      // 批12-A：无备份登记（如旧版 assemble 只记 new_hash）→ 明确诊断，不得读目录（EISDIR）
      if (!meta.backupName) {
        skipped.push({ file: fileRel, reason: 'backup_missing', detail: 'no backup registered for this file; cannot restore; file left unchanged' })
        continue
      }
      const resolvedBackup = safeBackupPath(backupDir, meta.backupName || '')
      if (!resolvedBackup) {
        skipped.push({ file: fileRel, reason: 'backup_escape' })
        continue
      }
      const destPath = join(this.projectRoot, fileRel)
      if (!existsSync(resolvedBackup) || !existsSync(destPath)) {
        skipped.push({ file: fileRel, reason: 'missing_backup_or_target' })
        continue
      }
      // R5：还原前取锁 + 哈希比对——防覆盖后来的合法写入（对齐 r8-E2）
      const lock = await acquireLock(destPath, 30000)
      if (lock.locked) { skipped.push({ file: fileRel, reason: 'file_locked' }); continue }
      try {
        const curHash = sha256(readFileSync(destPath))
        const backupHash = sha256(readFileSync(resolvedBackup))
        if (meta.new_hash && curHash !== backupHash && curHash !== meta.new_hash) {
          skipped.push({ file: fileRel, reason: 'external_change' })
          continue
        }
        _atomicWrite(destPath, readFileSync(resolvedBackup, 'utf-8'), { fsync: true, preservePermissions: true })
        filesRestored++
      } finally {
        lock.release()
      }
    }

    // R22-⑯：skipped 文件不删目录——rollback 能力保留供重试
    if (skipped.length > 0) {
      return { status: 'rolled_back_partial', retryable: true, files_restored: filesRestored, skipped }
    }

    rmSync(txnPath, { recursive: true, force: true })
    const res = { status: 'rolled_back', files_restored: filesRestored }
    return res
  }

  getInfo(txnId) {
    if (!_isSafeTxnId(txnId)) return null
    try {
      return this._readManifest(txnId)
    } catch {
      return null
    }
  }

  listTransactions() {
    if (!existsSync(this.txnRoot)) return []
    return readdirSync(this.txnRoot, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => {
        try {
          return this._readManifest(d.name)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  }

  _txnPath(txnId) {
    return join(this.txnRoot, txnId)
  }

  _readManifest(txnId) {
    const path = join(this._txnPath(txnId), 'manifest.json')
    return JSON.parse(readFileSync(path, 'utf-8'))
  }

  _writeManifest(txnId, data) {
    _atomicWrite(join(this._txnPath(txnId), 'manifest.json'), JSON.stringify(data, null, 2), { fsync: true })
  }

  _ensureGitignore() {
    // dogfood-050 修复：git 仓内优先写 .git/info/exclude——旧实现恒写 .gitignore，
    // git 仓里反而制造未跟踪 .gitignore 噪声（与 ensureGitExclude 双机制不同步）
    if (isGitRepo(this.projectRoot)) {
      ensureGitExclude(this.projectRoot)
      return
    }
    const entry = '.ai-transactions/'
    // 任一父目录 .gitignore 已含该条目时跳过（子项目嵌入大仓时避免创建冗余 .gitignore）
    let dir = this.projectRoot
    while (dir && dir !== dirname(dir)) {
      const parentGi = join(dir, '.gitignore')
      if (existsSync(parentGi) && readFileSync(parentGi, 'utf-8').split(/\r?\n/).map(l => l.trim()).includes(entry)) return
      dir = dirname(dir)
    }
    const gitignorePath = join(this.projectRoot, '.gitignore')
    if (existsSync(gitignorePath)) {
      const content = readFileSync(gitignorePath, 'utf-8')
      if (content.includes(entry)) return
      writeFileSync(gitignorePath, content + (content.endsWith('\n') ? '' : '\n') + entry + '\n')
    } else {
      writeFileSync(gitignorePath, entry + '\n')
    }
  }

  // 批10-1：写盘/commit 共用的内容校验（语法 + bracket，与 write-runtime 同套仲裁）
  async _validateContent(fileRel, content) {
    const validation = {}
    if (langOf(fileRel)) {
      validation.syntax = await validateSyntax(this.langParser, content, extname(fileRel), fileRel)
      const b = sharedBracketCheck(content, langOf(fileRel))
      validation.bracket = b.ok ? (b.not_applicable ? { status: 'skip', reason: b.reason } : { status: 'pass' }) : { status: 'fail', errors: [b.detail] }
    } else {
      validation.syntax = { status: 'skip', reason: 'non-code file' }
      validation.bracket = { status: 'skip', reason: 'non-code file' }
    }
    reconcileBracketWithSyntax(validation)
    if (validation.syntax?.status === 'fail' || validation.bracket?.status === 'fail') {
      const diag = []
      if (validation.syntax?.status === 'fail') {
        for (const e of validation.syntax.errors || ['syntax errors detected']) diag.push({ source: 'syntax', message: e })
      }
      if (validation.bracket?.status === 'fail') {
        // bash 修复（2026-10-27）：行号提示同样按语言分派——旧实现无条件把 # 当注释，
        // 会把 JS #private 行的 { 抹到行尾，报出指向未改动处的假行号（与主校验同根因）。
        const hints = bracketWarnings(content, langOf(fileRel))
        if (hints.length === 0) {
          for (const e of validation.bracket.errors || ['unbalanced brackets']) diag.push({ source: 'bracket', message: e })
        } else {
          for (const w of hints) diag.push({ source: 'bracket', bracket: w.bracket, line: w.line, message: w.detail })
        }
      }
      validation.diagnostics = diag
    }
    return validation
  }

  _fastHash(filePath) {
    const content = readFileSync(filePath, 'utf-8')
    let hash = 0
    for (let i = 0; i < content.length; i++) {
      hash = ((hash << 5) - hash) + content.charCodeAt(i)
      hash |= 0
    }
    return hash
  }
}

// 13-A：编辑匹配引擎（纯函数）——applyEdits（真实写盘）与 previewEdits（dry-run）共用。
// 返回演化后的 result + 逐编辑匹配回执（line 为 1-based 首个命中行号）与失败/歧义列表。
function simulateEdits(content, edits) {
  let result = content
  let applied = 0
  const failedEdits = []
  const ambiguousEdits = []
  const matches = []
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i]
    // 批10-2：line_span 锚定编辑（行级，防漂移 expect_sha）
    if (edit && edit.line_span) {
      const spanRes = applyLineSpan(result, content, edit)
      if (spanRes.error) {
        failedEdits.push({ index: i, reason: spanRes.reason, error_code: spanRes.error_code, detail: spanRes.detail })
        continue
      }
      matches.push({ index: i, mode: 'line_span', line: edit.line_span.start_line, ...(spanRes.anchor_checked ? { anchor_checked: true } : {}) })
      result = spanRes.result
      applied++
      continue
    }
    const oldStr = edit.old_string
    // 批10-2：new_lines 数组形式（消换行转义）
    const newStr = edit.new_string ?? (Array.isArray(edit.new_lines) ? edit.new_lines.map(String).join('\n') : '')
    if (!oldStr) {
      // R3：空 old_string 不再静默跳过——记入 failed，防 edits_applied 谎报成功
      failedEdits.push({ index: i, old_string: '', reason: 'empty_old_string', error_code: ErrorCodes.INVALID_INPUT })
      continue
    }
    if (edit.replace_all) {
      // R3：函数替换器防 $& 作弊——replaceAll 第二参字符串里的 $& 被当捕获引用替换（r12.2 同类）
      const occurrences = result.split(oldStr).length - 1
      const replaced = result.replaceAll(oldStr, () => newStr)
      if (replaced !== result) {
        applied++
        matches.push({ index: i, mode: 'replace_all', occurrences })
        result = replaced
      } else {
        const failed = { index: i, old_string: oldStr, reason: 'not_found', error_code: ErrorCodes.OLD_STRING_NOT_FOUND }
        const closest = findClosestMatch(result, oldStr)
        if (closest) failed.closest_match = closest
        addLongLineHint(failed, oldStr)
        failedEdits.push(failed)
      }
    } else {
      const idx = result.indexOf(oldStr)
      if (idx === -1) {
        const failed = { index: i, old_string: oldStr, reason: 'not_found', error_code: ErrorCodes.OLD_STRING_NOT_FOUND }
        const closest = findClosestMatch(result, oldStr)
        if (closest) failed.closest_match = closest
        addLongLineHint(failed, oldStr)
        failedEdits.push(failed)
        continue
      }
      const occurrences = result.split(oldStr).length - 1
      if (occurrences > 1) ambiguousEdits.push({ index: i, occurrences })
      const line = result.slice(0, idx).split('\n').length
      matches.push({ index: i, mode: 'first', line, occurrences })
      result = result.slice(0, idx) + newStr + result.slice(idx + oldStr.length)
      applied++
    }
  }
  return { result, applied, failedEdits, ambiguousEdits, matches }
}

// 13-A：长行匹配脆性提示（用户实测：超长 CJK/Markdown 行字节级漂移是唯一失误来源）
const LONG_LINE_HINT_THRESHOLD = 120
function addLongLineHint(failed, oldStr) {
  try {
    const longest = String(oldStr).split('\n').reduce((m, l) => Math.max(m, l.length), 0)
    if (longest > LONG_LINE_HINT_THRESHOLD) {
      failed.hint = 'old_string has a very long line (' + longest + ' chars); long CJK/Markdown lines drift easily — prefer line_span + expect_sha anchoring'
    }
  } catch {}
}

// 批10-2：line_span 编辑——1-based 行号；end_line 缺省=纯插入（在 start_line 前）；null=替换到 EOF
function applyLineSpan(content, baseContent, edit) {
  const ls = edit.line_span || {}
  const start = ls.start_line
  if (!Number.isInteger(start) || start < 1) {
    return { error: true, reason: 'invalid_line_span', error_code: ErrorCodes.INVALID_INPUT, detail: 'line_span.start_line must be an integer >= 1' }
  }
  // 14-A AC29：公开 schema 把 expect_sha 定义在 line_span 内，旧实现只读 edit.expect_sha（兄弟位）——
  // 按 schema 传参被静默忽略、锚点守卫失效。两位置都接受；同一锚点等价，异值拒绝（防中途换锚）。
  const normSha = (v) => String(v).replace(/^sha256:/, '')
  const outerSha = edit.expect_sha
  const innerSha = ls.expect_sha
  if (outerSha != null && innerSha != null && normSha(outerSha) !== normSha(innerSha)) {
    return { error: true, reason: 'conflicting_expect_sha', error_code: ErrorCodes.INVALID_INPUT, detail: 'expect_sha given both as edit.expect_sha and edit.line_span.expect_sha with different values; pass a single anchor (or identical values)' }
  }
  const expectSha = innerSha != null ? innerSha : outerSha
  if (expectSha) {
    const want = normSha(expectSha)
    if (sha256(Buffer.from(baseContent, 'utf-8')) !== want) {
      return { error: true, reason: 'stale_content', error_code: ErrorCodes.STALE_CONTENT, detail: 'expect_sha mismatch: file changed since read; re-read then edit only the marked region' }
    }
  }
  const hadTrailing = content.endsWith('\n')
  const lines = content.split('\n')
  if (hadTrailing) lines.pop()
  if (start > lines.length + 1) {
    return { error: true, reason: 'line_span_out_of_range', error_code: ErrorCodes.INVALID_INPUT, detail: 'start_line ' + start + ' beyond EOF (' + lines.length + ' lines)' }
  }
  let newLines
  if (Array.isArray(edit.new_lines)) newLines = edit.new_lines.map(String)
  else if (typeof edit.new_string === 'string') newLines = edit.new_string === '' ? [] : edit.new_string.split('\n')
  else return { error: true, reason: 'missing_new_content', error_code: ErrorCodes.INVALID_INPUT, detail: 'line_span edit needs new_lines or new_string' }
  // 15-B（专家 621f6f8 Windows 验收 §4.2）：行尾继承——新行默认沿用锚点行的真实行尾（CRLF→CRLF），
  // 不静默产生混合行尾；未触碰行保持原字节（不做全局行尾转换）。new_lines/new_string 元素先归一。
  const eol = (() => {
    for (const l of [lines[start - 1], lines[start - 2]]) {
      if (typeof l === 'string' && l.length > 0) return l.endsWith('\r') ? '\r\n' : '\n'
    }
    return content.includes('\r\n') ? '\r\n' : '\n'
  })()
  newLines = newLines.map(l => {
    const s = String(l)
    if (eol === '\r\n') return s.endsWith('\r') ? s : s + '\r'
    return s.endsWith('\r') ? s.slice(0, -1) : s
  })
  const endRaw = ls.end_line
  const tail = hadTrailing ? '\n' : ''
  if (endRaw === undefined) {
    return { result: lines.slice(0, start - 1).concat(newLines, lines.slice(start - 1)).join('\n') + tail, anchor_checked: !!expectSha }
  }
  if (endRaw !== null) {
    if (!Number.isInteger(endRaw) || endRaw < start) {
      return { error: true, reason: 'invalid_line_span', error_code: ErrorCodes.INVALID_INPUT, detail: 'line_span.end_line must be an integer >= start_line (or null for EOF)' }
    }
    if (endRaw > lines.length) {
      return { error: true, reason: 'line_span_out_of_range', error_code: ErrorCodes.INVALID_INPUT, detail: 'end_line ' + endRaw + ' beyond EOF (' + lines.length + ' lines)' }
    }
    return { result: lines.slice(0, start - 1).concat(newLines, lines.slice(endRaw)).join('\n') + tail, anchor_checked: !!expectSha }
  }
  return { result: lines.slice(0, start - 1).concat(newLines).join('\n') + tail, anchor_checked: !!expectSha }
}

function _countLines(t) {
  if (!t) return 0
  const s = t.endsWith('\n') ? t.slice(0, -1) : t
  return s.split('\n').length
}

function _diffStats(file, oldText, newText, backupPath, curPath) {
  const out = { file, lines_before: _countLines(oldText), lines_after: _countLines(newText) }
  out.delta = out.lines_after - out.lines_before
  if (backupPath && curPath) {
    try {
      const r = spawnSync('git', ['diff', '--no-index', '--numstat', '--', backupPath, curPath], { encoding: 'utf-8', timeout: 5000 })
      const line = (r.stdout || '').trim().split('\n')[0] || ''
      const m = line.match(/^(\d+|-)\t(\d+|-)\t/)
      if (m) {
        out.added = m[1] === '-' ? null : Number(m[1])
        out.removed = m[2] === '-' ? null : Number(m[2])
      }
    } catch {}
  }
  return out
}

function bracketWarnings(content, lang = null) {
  const hashIsComment = lang === 'py' || lang === 'rb'
  const warnings = []
  const pairs = { ')': '(', ']': '[', '}': '{' }
  const opens = new Set(['(', '[', '{'])
  const stack = []
  let inString = null
  let inLineComment = false
  let inBlockComment = false

  for (let i = 0; i < content.length; i++) {
    const ch = content[i]
    const next = content[i + 1]

    if (inLineComment) {
      if (ch === '\n') inLineComment = false
      continue
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') { inBlockComment = false; i++ }
      continue
    }
    if (inString) {
      if (ch === '\\') { i++; continue }
      if (ch === inString) inString = null
      continue
    }

    if (ch === '/' && next === '/') { inLineComment = true; continue }
    if (ch === '/' && next === '*') { inBlockComment = true; i++; continue }
    if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue }
    if (ch === '#' && hashIsComment) { inLineComment = true; continue }

    if (opens.has(ch)) {
      stack.push({ char: ch, line: content.slice(0, i).split('\n').length })
    } else if (pairs[ch]) {
      const line = content.slice(0, i).split('\n').length
      if (stack.length === 0) {
        warnings.push({ type: 'bracket_imbalance', bracket: ch, line, detail: `extra closing "${ch}"` })
      } else {
        const top = stack.pop()
        if (top.char !== pairs[ch]) {
          warnings.push({ type: 'bracket_mismatch', line: top.line, detail: `"${top.char}" at line ${top.line} closed by "${ch}"` })
        }
      }
    }
  }

  for (const unclosed of stack) {
    warnings.push({ type: 'bracket_imbalance', bracket: unclosed.char, line: unclosed.line, detail: `unclosed "${unclosed.char}" opened at line ${unclosed.line}` })
  }

  return warnings
}
