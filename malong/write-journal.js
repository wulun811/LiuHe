// write-journal.js — undo journal + 审计 + crash recovery（附录 D）
// 从 write-runtime.js 拆分（P4 批量后运行时已近千行）
// r9：与 write-runtime 的循环 import 仅运行期使用 acquireLock（ESM live binding，模块求值期不互相访问）
import { join, basename, resolve, sep, isAbsolute, relative } from 'node:path'
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, appendFileSync, rmSync, statSync, realpathSync, openSync, closeSync, unlinkSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { sha256 } from './hash-utils.js'
import { guardRealPath, atomicWrite, isSafeTxnId } from './path-guard.js'
import { acquireLock } from './write-runtime.js'

export const JOURNAL_ROOT = '.malong'
const AUDIT_LOG = 'audit.log'

// journal 自动清理（附录 D：终态事务超 TTL 节流清扫；在途/待审永不删）
const PRUNE_MARKER = '.last_prune'
const PRUNE_INTERVAL_MS = 60 * 60 * 1000          // 节流：每 workspace 最多 1 小时实扫一次（多进程共享同一 marker）
const DEFAULT_MAX_AGE_HOURS = 24                  // 默认保留 1 天（journal 很小，undo 能力值钱，偏保守）
export const JOURNAL_RETENTION_HOURS = DEFAULT_MAX_AGE_HOURS // Q1：用户级 undo 保留窗口（与 prune TTL 同源，勿分叉）
const PRUNE_PROTECTED_STATES = ['created', 'staged', 'needs_review']  // 在途/崩溃恢复候选/待人工核对，永不自动删

export function createJournal(workspaceDir, filePath, absPath, originalContent, state) {
  // Encode ownership before mkdir publishes the directory to other processes.
  const txnId = `txn_${Date.now()}_${randomBytes(4).toString('hex')}_p${process.pid}`
  const dir = join(workspaceDir, JOURNAL_ROOT, 'journal', txnId)
  mkdirSync(join(dir, 'backup'), { recursive: true })
  // 14-C AC20/AC21（真双进程实测）：先落 pid 证据再写任何事务文件——他进程恢复凭此判活，
  // 不把在途 createJournal（manifest/state 未写完窗口）当孤儿删（旧实现 rmSync 整目录 →
  // 写者 manifest rename ENOENT 假故障 write_failed）
  try { writeFileSync(join(dir, 'pid'), String(process.pid)) } catch {}
  // r10(D)：backup 是恢复资产——原子写 + fsync（半截 backup 会让哈希三方判定恢复出错误内容）
  atomicWrite(join(dir, 'backup', basename(filePath)), originalContent, { fsync: true })
  // r9(F6)：manifest/state 原子写——直写崩溃会留不可解析 JSON，recoverJournals 对解析失败静默 continue → 事务被跳过
  // W3（2026-10-05 live）：manifest.file 统一存 workspace-relative——edit_batch 协议侧会传绝对路径，
  // 而 undo/recover 全部按 join(workspaceDir, manifest.file) + guardRealPath(workspaceDir, …) 消费，
  // 绝对路径会让「写后可 undo」在 undo_commit 时报 PATH_BLOCKED（live 实测）。
  const relFile = isAbsolute(filePath) ? relative(workspaceDir, filePath) : filePath
  atomicWrite(join(dir, 'manifest.json'), JSON.stringify({
    txn_id: txnId, file: relFile, edit_mode: state.editMode, created_at: new Date().toISOString(),
  }, null, 2), { fsync: true })
  atomicWrite(join(dir, 'state.json'), JSON.stringify({ txn_id: txnId, state: 'created', ...state }, null, 2), { fsync: true })
  return { txnId, dir }
}

// 14-C：事务目录写者存活判定（恢复安全性）——pid 存活 → 在途事务，恢复不得处理
// （含 Windows：ESRCH=已死；EPERM=存活但无权限；新目录在 pid 文件尚未写好时用目录名判活，旧格式不变）
function journalWriterAlive(dir) {
  let pid
  try { pid = Number(readFileSync(join(dir, 'pid'), 'utf-8').trim()) } catch {}
  if (!Number.isInteger(pid) || pid <= 0) {
    pid = Number(/^txn_\d+_[a-f0-9]{8}_p(\d+)$/.exec(basename(dir))?.[1])
  }
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (e) { return e?.code === 'EPERM' }
}

export function updateJournalState(dir, state) {
  try {
    const cur = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf-8'))
    // r9(F6)：原子写
    atomicWrite(join(dir, 'state.json'), JSON.stringify({ ...cur, ...state }, null, 2), { fsync: true })
  } catch {}
}

export function auditLog(workspaceDir, entry) {
  try {
    appendFileSync(join(workspaceDir, JOURNAL_ROOT, AUDIT_LOG), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n')
  } catch {}
}

// ── r8(F10)：批次标记（write_symbols 多文件批崩溃恢复）——r9(F4)：记录 all_or_nothing 模式，
// best_effort 批崩溃后已提交文件是「用户确认的成功结果」，不得回滚 ──

function _batchesDir(workspaceDir) {
  return join(workspaceDir, JOURNAL_ROOT, 'batches')
}

function _batchPath(workspaceDir, batchId) {
  return join(_batchesDir(workspaceDir), `${batchId}.json`)
}

function _batchLockPath(workspaceDir) {
  return join(_batchesDir(workspaceDir), '.batch-lock')
}

// R22-⑯：批次级锁——createBatchMarker 创建 O_EXCL 锁文件，finishBatchMarker 删除；
// recoverBatches 见锁存在 + PID 存活 → 跳过恢复（批次在运行中，非崩溃残留，防并发踩踏）
function _acquireBatchLock(workspaceDir) {
  const dir = _batchesDir(workspaceDir)
  mkdirSync(dir, { recursive: true })
  const lockPath = _batchLockPath(workspaceDir)
  let fd = null
  try {
    fd = openSync(lockPath, 'wx')
  } catch (e) {
    // 第二轮审查修复（P0）：EEXIST = 他人持锁——绝不删活锁（旧实现无条件 rmSync 窃锁，
    // 后续任意写入的 recoverBatches 会回滚持锁批次的已写文件）。仅当持有者已死/锁陈旧
    // （_isBatchLockAlive 判定并清理）才重试一次。
    if (e && e.code === 'EEXIST' && !_isBatchLockAlive(workspaceDir)) {
      try { fd = openSync(lockPath, 'wx') } catch { return false }
    } else {
      return false
    }
  }
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }))
    return true
  } catch {
    // open 成功但写入失败：只清自己刚建的锁
    try { closeSync(fd) } catch {}
    fd = null
    try { rmSync(lockPath, { force: true }) } catch {}
    return false
  } finally {
    if (fd !== null) { try { closeSync(fd) } catch {} }
  }
}

function _releaseBatchLock(workspaceDir) {
  try { rmSync(_batchLockPath(workspaceDir), { force: true }) } catch {}
}

function _isBatchLockAlive(workspaceDir) {
  const lockPath = _batchLockPath(workspaceDir)
  if (!existsSync(lockPath)) return false
  // live 审查修复：优先按 pid 判活（长批次无心跳也不会被误杀）；mtime 仅作 pid 不可读时的保守兜底
  try {
    const info = JSON.parse(readFileSync(lockPath, 'utf-8'))
    if (info && Number.isInteger(info.pid) && info.pid > 0) {
      if (info.pid === process.pid) return true
      try { process.kill(info.pid, 0); return true }
      catch (e) { if (e && e.code === 'EPERM') return true /* 进程存在但无权限 → 视为存活 */ }
      _releaseBatchLock(workspaceDir)
      return false
    }
  } catch {}
  try {
    // R22-⑯：锁文件 mtime > 30s → 崩溃残留（pid 不可读时兜底），清理后允许恢复
    if (Date.now() - statSync(lockPath).mtimeMs > 30000) {
      _releaseBatchLock(workspaceDir)
      return false
    }
    return true
  } catch { _releaseBatchLock(workspaceDir); return false }
}

// 测试用：手动释放批次锁（模拟崩溃后恢复）
export function releaseBatchLock(workspaceDir) { _releaseBatchLock(workspaceDir) }

export function createBatchMarker(workspaceDir, files, mode = 'strict') {
  const batchId = `batch_${Date.now()}_${randomBytes(3).toString('hex')}`
  const dir = _batchesDir(workspaceDir)
  mkdirSync(dir, { recursive: true })
  // R22-⑯：批次级锁——O_EXCL 防并发多个 writeSymbols 同时建批次；recoverBatches 见锁存活跳过恢复
  if (!_acquireBatchLock(workspaceDir)) {
    throw Object.assign(new Error('batch lock busy'), { code: 'BATCH_LOCK_BUSY' })
  }
  const marker = { batch_id: batchId, files, txnIds: [], state: 'pending', mode, created_at: new Date().toISOString() }
  // r10(D)：批次标记也走共享原子写（随机后缀，替换原固定 .tmp）+ fsync——批次恢复依赖它完整落盘
  atomicWrite(_batchPath(workspaceDir, batchId), JSON.stringify(marker, null, 2), { fsync: true })
  return { batchId }
}

export function updateBatchMarker(workspaceDir, batchId, patch) {
  try {
    const path = _batchPath(workspaceDir, batchId)
    const cur = JSON.parse(readFileSync(path, 'utf-8'))
    atomicWrite(path, JSON.stringify({ ...cur, ...patch }, null, 2), { fsync: true })
    // live 审查修复：批次进行中续租锁（pid 判活是主防线，mtime 心跳作兜底）
    try {
      const lockPath = _batchLockPath(workspaceDir)
      if (existsSync(lockPath)) writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() }))
    } catch {}
  } catch (e) {
    // r9(F7)：静默吞失败 = 崩溃后该批次部分提交不被回滚（marker 缺 txnId）——记审计不静默
    try { auditLog(workspaceDir, { event: 'batch_marker_update_failed', batch_id: batchId, reason: e.message }) } catch {}
  }
}

export function finishBatchMarker(workspaceDir, batchId) {
  try { rmSync(_batchPath(workspaceDir, batchId), { force: true }) } catch {}
  _releaseBatchLock(workspaceDir)
}

export async function recoverJournals(workspaceDir, options = {}) {
  const root = join(workspaceDir, JOURNAL_ROOT, 'journal')
  if (!existsSync(root)) return []
  const recovered = []
  for (const d of readdirSync(root, { withFileTypes: true })) {
    // 审查修复（M7）：.last_prune 等非目录条目跳过——旧实现 readdirSync 无过滤，
    // 把 .last_prune 文件当 txnDir 读 state.json → ENOTDIR → 孤儿清理分支误删 prune 节流 marker
    if (!d.isDirectory()) continue
    const txnDir = d.name
    const dir = join(root, txnDir)
    let state = null
    const statePath = join(dir, 'state.json')
    try { state = JSON.parse(readFileSync(statePath, 'utf-8')) } catch {
      // r10(C)：孤儿事务清理——state.json 缺失 = createJournal 未完成（edit 从未执行）。
      // 旧实现静默 continue：孤儿目录永不回收（prune 读 state 失败同样 continue）→ .malong 无限增长。
      // 删前复核：若目标文件已存在且内容 ≠ backup，说明 edit 可能已发生 → 保守保留 + 审计（不丢回滚能力）。
      if (!existsSync(statePath)) {
        // 14-C：写者存活 → 在途事务（createJournal 未完成不代表从未执行——可能是别的进程正在写）
        if (journalWriterAlive(dir)) {
          recovered.push({ txn_id: txnDir, file: null, action: 'in_flight_kept', reason: 'writer process alive' })
          try { auditLog(workspaceDir, { event: 'in_flight_txn_kept', txn_id: txnDir }) } catch {}
          continue
        }
        let safe = true
        try {
          const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf-8'))
          const backup = join(dir, 'backup', basename(manifest.file))
          const absPath = join(workspaceDir, manifest.file)
          if (existsSync(backup) && existsSync(absPath) && sha256(readFileSync(absPath)) !== sha256(readFileSync(backup))) safe = false
        } catch {}
        if (safe) {
          try {
            rmSync(dir, { recursive: true, force: true })
            recovered.push({ txn_id: txnDir, file: null, action: 'orphan_removed' })
            try { auditLog(workspaceDir, { event: 'orphan_txn_removed', txn_id: txnDir }) } catch {}
          } catch {}
          continue
        }
      }
      // state 存在但不可解析（老版本直写半写）或孤儿复核不通过 → 保留待人工审，不静默
      recovered.push({ txn_id: txnDir, file: null, action: 'unparseable_state_kept', reason: 'state.json missing/unparseable; manual review required' })
      try { auditLog(workspaceDir, { event: 'unparseable_txn_state', txn_id: txnDir }) } catch {}
      continue
    }
    if (state.state === 'committed' || state.state === 'rolled_back' || state.state === 'abandoned' || state.state === 'needs_review' || state.state === 'failed') {
      // R18：索引补抽——写后重抽失败点已记 index_pending（journal 持久化），启动恢复时立即补抽，
      // 不依赖下次显式 reindex（markIndexDirty 后 mtime 未变，读侧 ensureFreshFile 不会触发）。
      // 成功 → 清标记；失败 → 保留 index_pending（下次恢复再试）+ recovered 记录。
      if (state.index_pending === true && options.codeIndexService) {
        try {
          const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf-8'))
          const absPath = join(workspaceDir, manifest.file)
          await options.codeIndexService.indexFile(absPath, workspaceDir)
          updateJournalState(dir, { index_pending: false })
          recovered.push({ txn_id: txnDir, file: manifest.file, action: 'index_repaired' })
        } catch (e) {
          recovered.push({ txn_id: txnDir, file: null, action: 'index_repair_failed', reason: e.message })
        }
      }
      continue
    }
    // created/staged → 回滚（未 rename 则删除，已 rename 则恢复 backup）
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf-8'))
      const absPath = join(workspaceDir, manifest.file)
      const backup = join(dir, 'backup', basename(manifest.file))
      // 14-C：写者仍存活 → 在途事务（created/staged 由写者自行推进；恢复不得替它标 abandoned/committed）
      if (journalWriterAlive(dir)) {
        recovered.push({ txn_id: txnDir, file: manifest.file, action: 'in_flight_kept', reason: 'writer process alive' })
        continue
      }
      if ((state.state === 'staged' || state.state === 'created') && existsSync(backup) && existsSync(absPath)) {
        // 哈希三方判定（防覆盖后来的合法写入）：
        // 当前 == 写前 → 事务从未落地（dryRun 残留/崩溃在 rename 前）→ 不覆盖，标 abandoned
        // 当前 == 写后(new_hash) → rename 已成功、崩溃在 committed 前 → 补标 committed
        // 两者都不是 → 外部修改过 → 绝不覆盖，标 needs_review
        const curHash = sha256(readFileSync(absPath))
        const oldHash = sha256(readFileSync(backup))
        if (curHash === oldHash) {
          // 审查修复（M3）：created/staged + 文件==写前 → 事务从未落地 → abandoned
          // （旧实现只对 staged 判 abandoned，created 落入无条件 rolled_back 谎报）
          atomicWrite(join(dir, 'state.json'), JSON.stringify({ ...state, state: 'abandoned', abandoned_at: new Date().toISOString() }), { fsync: true })
          recovered.push({ txn_id: txnDir, file: manifest.file, action: 'abandoned' })
          continue
        }
        if (state.new_hash && curHash === state.new_hash) {
          atomicWrite(join(dir, 'state.json'), JSON.stringify({ ...state, state: 'committed', committed_at: new Date().toISOString() }), { fsync: true })
          recovered.push({ txn_id: txnDir, file: manifest.file, action: 'committed' })
          continue
        }
        atomicWrite(join(dir, 'state.json'), JSON.stringify({ ...state, state: 'needs_review', reason: 'file content differs from both backup and new_hash', needs_review_at: new Date().toISOString() }), { fsync: true })
        recovered.push({ txn_id: txnDir, file: manifest.file, action: 'kept_external_change' })
        continue
      }
      // 审查修复（M3）：created 且 backup/目标缺失 → 事务从未执行 → abandoned（无资产可恢复，非谎报回滚）；
      // staged 缺失 → needs_review 待审（可能已执行但资产丢失，保守保留）
      // Q2：created:true 的写链事务从未执行（目标文件缺失）→ abandoned；staged 缺失 → needs_review 待审
      const neverExecuted = state.state === 'created' || state.created === true
      const m3State = neverExecuted ? 'abandoned' : 'needs_review'
      const m3Reason = neverExecuted ? 'created txn never executed (backup/target missing)' : 'staged txn without recoverable backup/target'
      atomicWrite(join(dir, 'state.json'), JSON.stringify({ ...state, state: m3State, reason: m3Reason, needs_review_at: new Date().toISOString() }), { fsync: true })
      recovered.push({ txn_id: txnDir, file: manifest.file, action: m3State, reason: m3Reason })
    } catch (e) {
      // 第二轮审查修复（G2 副作用）：回滚失败 = 内容状态未知、备份仍可能是唯一回滚依据——
      // 必须进 needs_review（受 prune 保护、待人工核对），不能写 failed（终态白名单 → 24h 后被清、毁掉备份）
      atomicWrite(join(dir, 'state.json'), JSON.stringify({ ...state, state: 'needs_review', reason: e.message, needs_review_at: new Date().toISOString() }), { fsync: true })
      recovered.push({ txn_id: txnDir, file: null, action: 'rollback_failed_needs_review', reason: e.message })
    }
  }
  await recoverBatches(workspaceDir, recovered)
  return recovered
}

// R4a：TransactionStore（.ai-transactions）崩溃恢复——复用 recoverJournals 哈希三方判定模式。
// 幂等：只处理 manifest.state === 'staged' 的事务；终态目录（committed/committed_recovered/
// rolled_back/abandoned/needs_review）直接跳过，重复调用零副作用。
// 每文件判定：当前==backup → 未落盘；当前==new_hash → 已落盘（applyEdits 后写入）；
// 都不等 → 外部修改。全未落盘 → abandoned（删目录+审计）；任一已落盘 → committed_recovered
// （保留目录供 undo，不移动 recent）；任一外部修改 → needs_review（保留，永不覆盖）。
export async function recoverTransactions(workspaceDir, options = {}) {
  const txnRoot = join(workspaceDir, '.ai-transactions')
  if (!existsSync(txnRoot)) return []
  const recovered = []
  // R22-④（审核修复）：commit 会把事务 rename 到 recent/——R4b 的 index_pending 补抽必须扫 recent/。
  // 旧实现：handler 写顶层 manifest（rename 后不存在 → 静默失败）+ 此处跳过 recent → 补抽链生产不可达。
  // recent/ 下均为已提交终态事务（供 undo），只做补抽不做恢复判定。
  if (options.codeIndexService) {
    const recentDir = join(txnRoot, 'recent')
    if (existsSync(recentDir)) {
      for (const d of readdirSync(recentDir, { withFileTypes: true })) {
        if (!d.isDirectory()) continue
        const dir = join(recentDir, d.name)
        let manifest
        try {
          manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf-8'))
        } catch { continue }
        if (manifest.index_pending !== true) continue
        const pendingFiles = Array.isArray(manifest.index_pending_files) ? manifest.index_pending_files : []
        let repairedAll = true
        for (const fileRel of pendingFiles) {
          try {
            await options.codeIndexService.indexFile(join(workspaceDir, fileRel), workspaceDir)
          } catch {
            repairedAll = false
          }
        }
        if (repairedAll) {
          delete manifest.index_pending
          delete manifest.index_pending_files
        }
        try {
          atomicWrite(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), { fsync: true })
          recovered.push({ txn_id: d.name, action: repairedAll ? 'index_repaired' : 'index_repair_failed', files: pendingFiles.length })
        } catch {}
      }
    }
  }
  for (const d of readdirSync(txnRoot, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name === 'recent') continue
    const dir = join(txnRoot, d.name)
    let manifest
    try {
      manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf-8'))
    } catch { continue }
    if (manifest.state !== 'staged') {
      // 审核补：R18 索引恢复模型对齐——终态事务（committed/committed_recovered/rolled_back）的
      // index_pending（edit-transaction commit 后重抽失败所记）在此补抽；成功清字段，失败保留再试
      if (manifest.index_pending === true && options.codeIndexService) {
        const pendingFiles = Array.isArray(manifest.index_pending_files) ? manifest.index_pending_files : []
        let repairedAll = true
        for (const fileRel of pendingFiles) {
          try {
            await options.codeIndexService.indexFile(join(workspaceDir, fileRel), workspaceDir)
          } catch {
            repairedAll = false
          }
        }
        if (repairedAll) {
          delete manifest.index_pending
          delete manifest.index_pending_files
        }
        try {
          atomicWrite(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), { fsync: true })
          recovered.push({ txn_id: d.name, action: repairedAll ? 'index_repaired' : 'index_repair_failed', files: pendingFiles.length })
        } catch {}
      }
      continue
    }
    const entries = Object.entries(manifest.files || {})
    if (entries.length === 0) {
      // R22-⑳（冻结期工作流实测 P1）：孤儿判定加活跃保护——连续 begin 时，第二个 begin 的自愈
      // 会把第一个「刚 begin 未 edit」的活跃事务当孤儿删掉（实测：b1 begin 成功 → b2 begin →
      // e1 edit 报 TXN_NOT_FOUND）。begin 后 <60s 的空事务视为活跃跳过；真崩溃残留（无数据）
      // 60s 后再清无损失。
      const createdMs = typeof manifest.created === 'number' ? manifest.created : 0
      if (createdMs && Date.now() - createdMs < 60_000) continue
      // begin 后崩溃、无任何备份 → 孤儿事务，删除 + 审计
      try {
        rmSync(dir, { recursive: true, force: true })
        recovered.push({ txn_id: d.name, action: 'orphan_removed' })
      } catch {}
      continue
    }
    let anyLanded = false
    let anyExternal = false
    let knownCount = 0
    // 审核补：backup 目录在 txn 内（.ai-transactions/<txn>/backup/）——守卫前缀须按 txn 计算
    const backupRoot = resolve(join(dir, 'backup'))
    for (const [fileRel, meta] of entries) {
      const absPath = join(workspaceDir, fileRel)
      // 审核补：backupName 读侧守卫——恶意/损坏 manifest 的 backupName 带足够 ../ 可越界读（r9(P6) 同型）
      // 只读哈希比对无写面，但需防外部文件内容泄露（哈希值差异可作 oracle）；越界项跳过、不计 knownCount
      const backupPathRaw = resolve(dir, 'backup', meta.backupName || '')
      if (!backupPathRaw.startsWith(backupRoot + sep)) continue
      const backupPath = backupPathRaw
      if (!existsSync(absPath) || !existsSync(backupPath)) continue
      // R22-④（审核修复）：backup 内 symlink 指向外部文件时，词法 resolve 守卫拦不住——
      // 外部文件内容会被读进来当哈希比对 oracle（内容泄露）。realpath 后必须仍在 backup 内。
      try {
        const realB = realpathSync(backupPath)
        const realRoot = realpathSync(backupRoot)
        if (realB !== realRoot && !realB.startsWith(realRoot + sep)) continue
      } catch { continue }
      // R22-④（审核修复）：backupName 指向目录（损坏 manifest）→ sha256(readFileSync) 抛 EISDIR，
      // 旧实现异常穿出 recoverTransactions → write-runtime 两处调用点无保护 → 每次写操作都崩、
      // 损坏项不清理无法自愈。逐项吞掉按判定资料不全处理（不计 knownCount，保守不删不覆盖）。
      let curHash, oldHash
      try {
        curHash = sha256(readFileSync(absPath))
        oldHash = sha256(readFileSync(backupPath))
      } catch { continue }
      knownCount++
      if (curHash === oldHash) continue // 未落盘
      if (meta.new_hash && curHash === meta.new_hash) anyLanded = true
      else anyExternal = true
    }
    if (knownCount === 0) {
      // 判定资料不全（backup/文件缺失）→ 保守 needs_review，不删不覆盖
      manifest.state = 'needs_review'
      manifest.recovered_at = new Date().toISOString()
      try {
        atomicWrite(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), { fsync: true })
        recovered.push({ txn_id: d.name, action: 'needs_review', reason: 'insufficient recovery data' })
      } catch {}
      continue
    }
    if (anyExternal) {
      manifest.state = 'needs_review'
      manifest.recovered_at = new Date().toISOString()
      try {
        atomicWrite(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), { fsync: true })
        recovered.push({ txn_id: d.name, action: 'needs_review', reason: 'external change detected' })
      } catch {}
      continue
    }
    if (!anyLanded) {
      // 所有文件都 == backup → 事务从未落地 → abandoned（删目录 + 审计）
      try {
        rmSync(dir, { recursive: true, force: true })
        recovered.push({ txn_id: d.name, action: 'abandoned' })
      } catch {}
      continue
    }
    // 任一文件已落盘（==new_hash）且无外部修改 → committed_recovered（保留目录供 undo）
    manifest.state = 'committed_recovered'
    manifest.recovered_at = new Date().toISOString()
    try {
      atomicWrite(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), { fsync: true })
      recovered.push({ txn_id: d.name, action: 'committed_recovered', files: entries.length })
      try { auditLog(workspaceDir, { event: 'txn_recovered', txn_id: d.name, action: 'committed_recovered' }) } catch {}
    } catch {}
  }
  return recovered
}

// r8(F10)：批次级崩溃恢复——write_symbols 中途崩溃：部分文件 committed 但批次未完成 → 回滚已提交的（哈希三方判定）
// r9(F5/F4)：恢复写原子化 + 取锁；best_effort 批次不回滚 → async
async function recoverBatches(workspaceDir, recovered) {
  const dir = _batchesDir(workspaceDir)
  if (!existsSync(dir)) return
  // R22-⑯：批次锁存活 → 有批次在运行中，跳过恢复（非崩溃残留，防并发踩踏）
  if (_isBatchLockAlive(workspaceDir)) return
  const journalRoot = join(workspaceDir, JOURNAL_ROOT, 'journal')
  for (const bf of readdirSync(dir)) {
    if (!bf.endsWith('.json')) continue
    try {
      const marker = JSON.parse(readFileSync(join(dir, bf), 'utf-8'))
      if (marker.state !== 'pending') { rmSync(join(dir, bf), { force: true }); continue }
      const txnIds = Array.isArray(marker.txnIds) ? marker.txnIds : []
      // R22-⑦（P1 决策）：批次完整性判定用 marker.files 全集而非 txnIds——txnIds 是逐文件追加的，
      // 崩溃于 f1 committed 后、f2 createJournal 前时 txnIds=[t1] < files=[f1,f2]，旧判定 1<1 false 判"批次完整"→ f1 残留不回滚（半批假象）
      const totalFiles = Array.isArray(marker.files) && marker.files.length > 0 ? marker.files.length : txnIds.length
      const committedIds = []
      for (const txnId of txnIds) {
        try {
          const s = JSON.parse(readFileSync(join(journalRoot, txnId, 'state.json'), 'utf-8'))
          if (s.state === 'committed') committedIds.push(txnId)
        } catch {}
      }
      if (committedIds.length > 0 && committedIds.length < totalFiles) {
        // r9(F4)：best_effort 批次不回滚——部分提交即用户可见的成功结果，回滚会静默撤销已确认数据
        if (marker.mode === 'best_effort') {
          recovered.push({ txn_id: null, file: null, action: 'batch_best_effort_partial_kept' })
          rmSync(join(dir, bf), { force: true })
          continue
        }
        // 部分提交 → 回滚已提交的（仅当当前内容 == new_hash，防覆盖崩溃后的外部修改）
        for (const txnId of committedIds) {
          try {
            const txnDir = join(journalRoot, txnId)
            const manifest = JSON.parse(readFileSync(join(txnDir, 'manifest.json'), 'utf-8'))
            // r9(P5)：manifest 内容不可信——file 可被植入为越界路径，写前过 realpath 守卫
            const guard = guardRealPath(workspaceDir, manifest.file)
            if (guard.blocked) {
              recovered.push({ txn_id: txnId, file: manifest.file, action: 'batch_partial_rollback_skipped', reason: guard.reason })
              updateJournalState(txnDir, { state: 'needs_review', reason: `rollback skipped: ${guard.reason}` })
              continue
            }
            const backup = join(txnDir, 'backup', basename(manifest.file))
            const absPath = join(workspaceDir, manifest.file)
            const state = JSON.parse(readFileSync(join(txnDir, 'state.json'), 'utf-8'))
            let didRollback = false
            if (state.created === true && existsSync(absPath) && state.new_hash && sha256(readFileSync(absPath)) === state.new_hash) {
              // Q2：新建文件的部分批回滚 = 删除（backup 是空串，写回会留垃圾文件）
              const rl = await acquireLock(absPath, 30000)
              if (!rl.locked) {
                try {
                  if (sha256(readFileSync(absPath)) === state.new_hash) { unlinkSync(absPath); didRollback = true }
                } finally {
                  rl.release()
                }
              }
            } else if (existsSync(backup) && existsSync(absPath) && state.new_hash && sha256(readFileSync(absPath)) === state.new_hash) {
              // r9(F5)：恢复写原子化 + 取 .mlock（防恢复与并发写者交错覆盖 / 恢复期间再崩溃留半截）
              const rl = await acquireLock(absPath, 30000)
              if (!rl.locked) {
                try {
                  if (sha256(readFileSync(absPath)) === state.new_hash) {
                    atomicWrite(absPath, readFileSync(backup), { fsync: true, preservePermissions: true })
                    recovered.push({ txn_id: txnId, file: manifest.file, action: 'batch_partial_rollback' })
                    didRollback = true
                  }
                } finally {
                  rl.release()
                }
              } else {
                recovered.push({ txn_id: txnId, file: manifest.file, action: 'batch_partial_rollback_skipped', reason: 'lock busy' })
              }
            }
            // 审查修复（H2）：只有实际恢复成功才标终态 rolled_back；
            // 旧实现无条件标 → backup 缺失/哈希不匹配/锁忙时谎报已回滚，终态永不再审
            updateJournalState(txnDir, didRollback
              ? { state: 'rolled_back', rolled_back_at: new Date().toISOString(), reason: 'batch_partial' }
              : { state: 'needs_review', reason: 'batch_partial rollback not executed (backup missing / hash mismatch / lock busy)' })
          } catch {}
        }
      }
      rmSync(join(dir, bf), { force: true })
    } catch { continue }
  }
}

// 终态 journal 超 TTL 自动节流清扫（附录 D）：committed/rolled_back/abandoned/failed 过龄删；
// created/staged（在途/崩溃恢复候选）与 needs_review（待人工核对）永不自动删——静默删待审=装对。
// 年龄锚终态时间戳（committed_at 等），无则目录 mtime，不用 created_at（长在途事务不会被误老死）。
// force 绕过节流；dryRun 只报不删且无副作用（不写 marker、不受节流）。
export function pruneJournals(workspaceDir, opts = {}) {
  const maxAgeHours = Number(opts.maxAgeHours) > 0 ? Number(opts.maxAgeHours) : DEFAULT_MAX_AGE_HOURS
  const dryRun = opts.dryRun === true
  const force = opts.force === true
  const root = join(workspaceDir, JOURNAL_ROOT, 'journal')
  if (!existsSync(root)) return { pruned: 0, kept: 0, skipped_throttle: false, dry_run: dryRun }

  const marker = join(root, PRUNE_MARKER)
  const now = Date.now()
  if (!force && !dryRun) {
    try {
      const last = Number(readFileSync(marker, 'utf-8'))
      if (Number.isFinite(last) && now - last < PRUNE_INTERVAL_MS) {
        return { pruned: 0, kept: 0, skipped_throttle: true, dry_run: dryRun }
      }
    } catch {}
  }
  if (!dryRun) { try { writeFileSync(marker, String(now)) } catch {} }

  const cutoff = now - maxAgeHours * 3600 * 1000
  let pruned = 0, kept = 0
  const deleted = []
  for (const txnDir of readdirSync(root)) {
    if (txnDir.startsWith('.')) continue          // 跳过 .last_prune 等隐藏项
    const dir = join(root, txnDir)
    let state = null
    try { state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf-8')) } catch { continue }
    if (PRUNE_PROTECTED_STATES.includes(state.state)) { kept++; continue }
    const ts = state.committed_at || state.rolled_back_at || state.abandoned_at || state.failed_at
    let tsMs = ts ? Date.parse(ts) : NaN
    if (!Number.isFinite(tsMs)) { try { tsMs = statSync(dir).mtimeMs } catch { continue } }
    if (tsMs > cutoff) { kept++; continue }        // 未到龄，保留
    if (!dryRun) {
      try { rmSync(dir, { recursive: true, force: true }) } catch { continue }  // force 忽略多进程 ENOENT 竞态
    }
    pruned++
    if (deleted.length < 20) deleted.push(txnDir)
  }
  return { pruned, kept, skipped_throttle: false, dry_run: dryRun, max_age_hours: maxAgeHours, deleted_sample: deleted }
}

// ── 16-B：批量 undo（专家复验 §5）——同批 journal 共享 batch_id ──
// restoreJournal 命中带 batch_id 的事务时扩展为整批：先对全部成员只读预检，
// 任一成员阻断（外部改动/非终态/备份缺失/路径守卫）→ 整批拒绝，不部分恢复；
// 通过后按写序逆序逐文件恢复（逐文件加锁）；已写前态/已撤销成员幂等跳标。
function _batchMemberJournals(workspaceDir, batchId) {
  const root = join(workspaceDir, JOURNAL_ROOT, 'journal')
  const members = []
  let entries = []
  try { entries = readdirSync(root, { withFileTypes: true }) } catch { return members }
  for (const d of entries) {
    if (!d.isDirectory()) continue
    const dir = join(root, d.name)
    let st = null, manifest = null
    try { st = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf-8')) } catch { continue }
    if (st.batch_id !== batchId) continue
    try { manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf-8')) } catch { continue }
    if (typeof manifest?.file === 'string' && isAbsolute(manifest.file)) manifest.file = relative(workspaceDir, manifest.file)
    members.push({ txnId: d.name, dir, state: st, manifest })
  }
  members.sort((a, b) => String(a.manifest.created_at || '').localeCompare(String(b.manifest.created_at || '')))
  return members
}

async function restoreBatchJournals(workspaceDir, txnId, selfState, selfManifest) {
  const batchId = selfState.batch_id
  const members = _batchMemberJournals(workspaceDir, batchId)
  if (!members.some(m => m.txnId === txnId)) {
    members.push({ txnId, dir: join(workspaceDir, JOURNAL_ROOT, 'journal', txnId), state: selfState, manifest: selfManifest })
    members.sort((a, b) => String(a.manifest.created_at || '').localeCompare(String(b.manifest.created_at || '')))
  }
  const blocked = []
  const plan = []
  for (const m of members) {
    const st = m.state
    if (st.state === 'undone') { plan.push({ ...m, action: 'already' }); continue }
    if (st.state !== 'committed' && st.state !== 'committed_recovered') { blocked.push({ txn_id: m.txnId, file: m.manifest.file, code: 'NOT_COMMITTED' }); continue }
    const guard = guardRealPath(workspaceDir, m.manifest.file)
    if (guard.blocked) { blocked.push({ txn_id: m.txnId, file: m.manifest.file, code: 'PATH_BLOCKED' }); continue }
    const absPath = join(workspaceDir, m.manifest.file)
    const backupPath = join(m.dir, 'backup', basename(m.manifest.file))
    if (!existsSync(backupPath)) { blocked.push({ txn_id: m.txnId, file: m.manifest.file, code: 'JOURNAL_NOT_FOUND' }); continue }
    if (st.created === true) {
      if (!existsSync(absPath)) { plan.push({ ...m, action: 'already' }); continue }
      const curHash = sha256(readFileSync(absPath))
      if (st.new_hash && curHash !== st.new_hash) { blocked.push({ txn_id: m.txnId, file: m.manifest.file, code: 'EXTERNAL_CHANGE' }); continue }
      plan.push({ ...m, action: 'delete', absPath })
    } else {
      if (!existsSync(absPath)) { blocked.push({ txn_id: m.txnId, file: m.manifest.file, code: 'TARGET_MISSING' }); continue }
      const curHash = sha256(readFileSync(absPath))
      const oldHash = sha256(readFileSync(backupPath))
      if (curHash === oldHash) { plan.push({ ...m, action: 'already' }); continue }
      if (st.new_hash && curHash !== st.new_hash) { blocked.push({ txn_id: m.txnId, file: m.manifest.file, code: 'EXTERNAL_CHANGE' }); continue }
      plan.push({ ...m, action: 'restore', absPath, backupPath })
    }
  }
  if (blocked.length > 0) {
    return {
      ok: false, code: 'BATCH_BLOCKED',
      message: 'Batch undo blocked: ' + blocked.length + ' of ' + members.length + ' file(s) cannot be safely restored; nothing was restored.',
      txn_id: txnId, batch: { batch_id: batchId, total: members.length, blocked },
      suggestion: 'Batch undo is all-or-nothing: resolve the listed files first (e.g. restore/redo them), then retry the same undo token. Individual member txn_id tokens also refuse while blocked - there is no partial-undo path.',
    }
  }
  const files = []
  const failures = []
  let restored = 0, deleted = 0, already = 0
  const markUndone = (m) => updateJournalState(m.dir, { state: 'undone', undone_at: new Date().toISOString() })
  for (const p of [...plan].reverse()) {
    if (p.action === 'already') { markUndone(p); already++; continue }
    const lock = await acquireLock(p.absPath, 30000)
    if (lock.locked) { failures.push({ txn_id: p.txnId, file: p.manifest.file, code: 'FILE_LOCKED' }); continue }
    try {
      if (p.action === 'delete') {
        rmSync(p.absPath, { force: true })
        markUndone(p)
        try { auditLog(workspaceDir, { event: 'journal_undo', txn_id: p.txnId, file: p.manifest.file, action: 'created_file_removed' }) } catch {}
        deleted++; files.push(p.manifest.file)
      } else {
        atomicWrite(p.absPath, readFileSync(p.backupPath), { fsync: true, preservePermissions: true })
        markUndone(p)
        try { auditLog(workspaceDir, { event: 'journal_undo', txn_id: p.txnId, file: p.manifest.file, action: 'restored' }) } catch {}
        restored++; files.push(p.manifest.file)
      }
    } catch (e) {
      failures.push({ txn_id: p.txnId, file: p.manifest.file, code: 'UNDO_FAILED', message: e?.message || String(e) })
    } finally {
      lock.release()
    }
  }
  const filesRestored = restored + deleted
  return {
    ok: true,
    status: failures.length > 0 ? 'undone_partial' : (filesRestored > 0 ? 'undone' : 'already_undone'),
    txn_id: txnId, files_restored: filesRestored, files,
    ...(deleted > 0 ? { deleted: true } : {}),
    batch: { batch_id: batchId, total: members.length, restored: filesRestored, already },
    ...(failures.length > 0 ? { retryable: true, failures } : {}),
  }
}

// ── Q1 用户级撤销：消费 write-journal 的 backup 恢复写前内容 ──
// 与 recoverJournals（崩溃恢复，自动回滚）不同：这是显式 undo，只接受已 committed/committed_recovered
// 的事务（含编辑型与创建型 created:true）；当前文件必须仍等于 new_hash（或已等于 backup，视为已恢复）；
// created:true 的撤销 = 删除新建文件（仅当内容仍为 new_hash，防误删外部修改）。
// 返回 { ok, status, files_restored, files } 或 { ok:false, code, message, suggestion }；不抛异常。
export async function restoreJournal(workspaceDir, txnId) {
  if (!isSafeTxnId(txnId)) {
    return { ok: false, code: 'TXN_NOT_FOUND', message: 'Transaction not found: ' + txnId, txn_id: txnId }
  }
  const dir = join(workspaceDir, JOURNAL_ROOT, 'journal', txnId)
  if (!existsSync(dir)) {
    return {
      ok: false, code: 'JOURNAL_NOT_FOUND', message: 'Undo journal not found: ' + txnId, txn_id: txnId,
      suggestion: 'Journals are retained ' + JOURNAL_RETENTION_HOURS + 'h after commit; if it expired or was already undone, recover via git/manual backup.',
    }
  }
  let state = null, manifest = null
  try {
    state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf-8'))
    manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf-8'))
  } catch (e) {
    return { ok: false, code: 'JOURNAL_UNREADABLE', message: 'Journal unreadable: ' + e.message, txn_id: txnId }
  }
  // W3：兼容修复前写入的绝对路径 manifest（24h 保留窗口内的旧 journal）——归一到 workspace-relative
  if (typeof manifest?.file === 'string' && isAbsolute(manifest.file)) {
    manifest.file = relative(workspaceDir, manifest.file)
  }
  // 16-B：同批共享 batch_id——任一成员 token 的显式 undo = 整批撤销（见 restoreBatchJournals）
  if (typeof state.batch_id === 'string' && state.batch_id) {
    return await restoreBatchJournals(workspaceDir, txnId, state, manifest)
  }
  if (state.state === 'undone') {
    return { ok: true, status: 'already_undone', txn_id: txnId, files_restored: 0, files: [] }
  }
  if (state.state !== 'committed' && state.state !== 'committed_recovered') {
    return { ok: false, code: 'NOT_COMMITTED', message: 'Cannot undo txn in state=' + state.state, txn_id: txnId, suggestion: 'Only committed write transactions can be undone.' }
  }
  const guard = guardRealPath(workspaceDir, manifest.file)
  if (guard.blocked) {
    return { ok: false, code: 'PATH_BLOCKED', message: guard.detail, txn_id: txnId }
  }
  const absPath = join(workspaceDir, manifest.file)
  const backupDir = resolve(join(dir, 'backup'))
  const backupPath = resolve(join(backupDir, basename(manifest.file)))
  if (backupPath !== backupDir && !backupPath.startsWith(backupDir + sep)) {
    return { ok: false, code: 'BACKUP_ESCAPE', message: 'Journal backup path escapes backup dir', txn_id: txnId }
  }
  try {
    const realB = realpathSync(backupPath)
    const realRoot = realpathSync(backupDir)
    if (realB !== realRoot && !realB.startsWith(realRoot + sep)) {
      return { ok: false, code: 'BACKUP_ESCAPE', message: 'Journal backup symlink escapes backup dir', txn_id: txnId }
    }
  } catch {
    return { ok: false, code: 'JOURNAL_NOT_FOUND', message: 'Journal backup missing: ' + txnId, txn_id: txnId }
  }
  const markUndone = () => updateJournalState(dir, { state: 'undone', undone_at: new Date().toISOString() })
  const lock = await acquireLock(absPath, 30000)
  if (lock.locked) {
    return { ok: false, code: 'FILE_LOCKED', message: 'File is locked by another writer: ' + manifest.file, txn_id: txnId, suggestion: 'Retry after a moment.' }
  }
  try {
    if (state.created === true) {
      if (!existsSync(absPath)) {
        markUndone()
        return { ok: true, status: 'undone', txn_id: txnId, files_restored: 0, files: [], note: 'created file already absent' }
      }
      const curHash = sha256(readFileSync(absPath))
      if (state.new_hash && curHash !== state.new_hash) {
        return { ok: false, code: 'EXTERNAL_CHANGE', message: 'File changed after creation; refusing to delete: ' + manifest.file, txn_id: txnId, suggestion: 'Resolve the external change manually.' }
      }
      rmSync(absPath, { force: true })
      markUndone()
      try { auditLog(workspaceDir, { event: 'journal_undo', txn_id: txnId, file: manifest.file, action: 'created_file_removed' }) } catch {}
      return { ok: true, status: 'undone', txn_id: txnId, files_restored: 1, files: [manifest.file], deleted: true }
    }
    if (!existsSync(absPath)) {
      return { ok: false, code: 'TARGET_MISSING', message: 'Target file missing: ' + manifest.file, txn_id: txnId }
    }
    const curHash = sha256(readFileSync(absPath))
    const oldHash = sha256(readFileSync(backupPath))
    if (curHash === oldHash) {
      markUndone()
      return { ok: true, status: 'already_restored', txn_id: txnId, files_restored: 0, files: [] }
    }
    if (state.new_hash && curHash !== state.new_hash) {
      return { ok: false, code: 'EXTERNAL_CHANGE', message: 'File modified after the write; refusing to overwrite: ' + manifest.file, txn_id: txnId, suggestion: 'Resolve the external change manually; backup retained under .malong/journal/' + txnId + '/backup.' }
    }
    atomicWrite(absPath, readFileSync(backupPath), { fsync: true, preservePermissions: true })
    markUndone()
    try { auditLog(workspaceDir, { event: 'journal_undo', txn_id: txnId, file: manifest.file, action: 'restored' }) } catch {}
    return { ok: true, status: 'undone', txn_id: txnId, files_restored: 1, files: [manifest.file] }
  } finally {
    lock.release()
  }
}
