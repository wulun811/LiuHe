import { join, dirname, sep, resolve, basename } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, statSync, readdirSync, renameSync, realpathSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { ErrorCodes, makeError, validateFilePath, findClosestMatch } from '../../error-codes.js'
import { registerWriter } from '../../writer-registry.js'
import { acquireLock, renameRetry } from '../../write-runtime.js'
import { guardRealPath, isSafeTxnId, atomicWrite } from '../../path-guard.js'
import { sha256 } from '../../hash-utils.js'

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
  const resolvedBackup = resolve(join(backupDir, backupName || ''))
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
    renameSync(tmpPath, txnPath)
    this._ensureGitignore()
    return txnId
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
      let result = content
      let applied = 0
      const failedEdits = []

      for (let i = 0; i < edits.length; i++) {
        const edit = edits[i]
        const oldStr = edit.old_string
        const newStr = edit.new_string ?? ''
        if (!oldStr) {
          // R3：空 old_string 不再静默跳过——记入 failed，防 edits_applied 谎报成功
          failedEdits.push({ index: i, old_string: '', reason: 'empty_old_string', error_code: ErrorCodes.INVALID_INPUT })
          continue
        }

        if (edit.replace_all) {
          // R3：函数替换器防 $& 作弊——replaceAll 第二参字符串里的 $& 被当捕获引用替换（r12.2 同类）
          const replaced = result.replaceAll(oldStr, () => newStr)
          if (replaced !== result) {
            applied++
            result = replaced
          } else {
            const failed = { index: i, old_string: oldStr, reason: 'not_found', error_code: ErrorCodes.OLD_STRING_NOT_FOUND }
            const closest = findClosestMatch(result, oldStr)
            if (closest) failed.closest_match = closest
            failedEdits.push(failed)
          }
        } else {
          const idx = result.indexOf(oldStr)
          if (idx === -1) {
            const failed = { index: i, old_string: oldStr, reason: 'not_found', error_code: ErrorCodes.OLD_STRING_NOT_FOUND }
            const closest = findClosestMatch(result, oldStr)
            if (closest) failed.closest_match = closest
            failedEdits.push(failed)
            continue
          }
          result = result.slice(0, idx) + newStr + result.slice(idx + oldStr.length)
          applied++
        }
      }

      const hasNotEmptyFailure = failedEdits.some(f => f.reason !== 'empty_old_string')
      if (applied === 0 && hasNotEmptyFailure) {
        return makeError(ErrorCodes.NO_MATCH, 'No edits matched in file', { file: fileRel, failed_edits: failedEdits })
      }
      // R3：全空 old_string → 不写盘，返回 staged + warning（拒绝谎报成功）
      if (applied === 0 && failedEdits.length > 0) {
        return { status: 'staged', file: fileRel, edits_applied: 0, warning: 'no edits applied (all old_string values were empty)' }
      }

      const validationWarnings = checkBracketBalance(result)

      _atomicWrite(absPath, result, { fsync: true })
      // Y002-S1：事务写落盘后登记写者（collision_guard classify 识别 transaction）
      registerWriter(this.projectRoot, fileRel, 'transaction')
      // R4a：记录 new_hash——崩溃恢复三方判定的「已落盘」依据（对齐 recoverJournals 模式）
      await _withManifestLock(txnId, () => {
        const m = this._readManifest(txnId)
        m.files[fileRel] = { ...(m.files[fileRel] || {}), new_hash: sha256(Buffer.from(result, 'utf-8')) }
        this._writeManifest(txnId, m)
      })
      const res = { status: 'staged', file: fileRel, edits_applied: applied }
      if (failedEdits.length > 0) {
        res.failed_edits = failedEdits
        res.warning = `${failedEdits.length} edit(s) did not match`
      }
      if (validationWarnings.length > 0) {
        res.validation_warnings = validationWarnings
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
      return { error: 'commit_failed', code: 'commit_failed', message: `Commit rename failed: ${e.message}`, retryable: true, txn_id: txnId }
    }
    this._cleanRecent(3)
    return { status: 'committed', files_changed: filesChanged.length, files: filesChanged }
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
      return makeError(ErrorCodes.TXN_NOT_FOUND, `Recent transaction not found: ${txnId}`, { txnId, suggestion: 'Only the last 3 committed transactions can be undone' })
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
      const backupPath = join(backupDir, meta.backupName || '')
      // r9(P6)：manifest 的 backupName 不可信——join(backupDir, 绝对路径) 会返回绝对路径（前缀丢弃）→ 读穿任意文件；resolve 后必须落在 backupDir 内
      // R22-④：补 realpath 守卫（词法 resolve 拦不住 backup 内 symlink 指向外部文件）
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
        _atomicWrite(destPath, readFileSync(resolvedBackup, 'utf-8'), { fsync: true })
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
      const backupPath = join(backupDir, meta.backupName || '')
      // r9(P6)：backupName 不可信——resolve 后必须落在 backupDir 内
      // R22-④：补 realpath 守卫（词法 resolve 拦不住 backup 内 symlink 指向外部文件）
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
        _atomicWrite(destPath, readFileSync(resolvedBackup, 'utf-8'), { fsync: true })
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

function checkBracketBalance(content) {
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
    if (ch === '#') { inLineComment = true; continue }

    if (opens.has(ch)) {
      stack.push({ char: ch, line: content.slice(0, i).split('\n').length })
    } else if (pairs[ch]) {
      if (stack.length === 0) {
        warnings.push({ type: 'bracket_imbalance', bracket: ch, detail: `extra closing "${ch}"` })
      } else {
        const top = stack.pop()
        if (top.char !== pairs[ch]) {
          warnings.push({ type: 'bracket_mismatch', detail: `"${top.char}" at line ${top.line} closed by "${ch}"` })
        }
      }
    }
  }

  for (const unclosed of stack) {
    warnings.push({ type: 'bracket_imbalance', bracket: unclosed.char, detail: `unclosed "${unclosed.char}" opened at line ${unclosed.line}` })
  }

  return warnings
}
