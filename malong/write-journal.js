// write-journal.js — undo journal + 审计 + crash recovery（附录 D）
// 从 write-runtime.js 拆分（P4 批量后运行时已近千行）
// r9：与 write-runtime 的循环 import 仅运行期使用 acquireLock（ESM live binding，模块求值期不互相访问）
import { join, basename, resolve, sep } from 'node:path'
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, appendFileSync, rmSync, statSync, realpathSync, openSync, closeSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { sha256 } from './hash-utils.js'
import { guardRealPath, atomicWrite } from './path-guard.js'
import { acquireLock } from './write-runtime.js'

export const JOURNAL_ROOT = '.malong'
const AUDIT_LOG = 'audit.log'

// journal 自动清理（附录 D：终态事务超 TTL 节流清扫；在途/待审永不删）
const PRUNE_MARKER = '.last_prune'
const PRUNE_INTERVAL_MS = 60 * 60 * 1000          // 节流：每 workspace 最多 1 小时实扫一次（多进程共享同一 marker）
const DEFAULT_MAX_AGE_HOURS = 24                  // 默认保留 1 天（journal 很小，undo 能力值钱，偏保守）
const PRUNE_PROTECTED_STATES = ['created', 'staged', 'needs_review']  // 在途/崩溃恢复候选/待人工核对，永不自动删

export function createJournal(workspaceDir, filePath, absPath, originalContent, state) {
  const txnId = `txn_${Date.now()}_${randomBytes(4).toString('hex')}`
  const dir = join(workspaceDir, JOURNAL_ROOT, 'journal', txnId)
  mkdirSync(join(dir, 'backup'), { recursive: true })
  // r10(D)：backup 是恢复资产——原子写 + fsync（半截 backup 会让哈希三方判定恢复出错误内容）
  atomicWrite(join(dir, 'backup', basename(filePath)), originalContent, { fsync: true })
  // r9(F6)：manifest/state 原子写——直写崩溃会留不可解析 JSON，recoverJournals 对解析失败静默 continue → 事务被跳过
  atomicWrite(join(dir, 'manifest.json'), JSON.stringify({
    txn_id: txnId, file: filePath, edit_mode: state.editMode, created_at: new Date().toISOString(),
  }, null, 2), { fsync: true })
  atomicWrite(join(dir, 'state.json'), JSON.stringify({ txn_id: txnId, state: 'created', ...state }, null, 2), { fsync: true })
  return { txnId, dir }
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
  try {
    const fd = openSync(lockPath, 'wx')
    writeFileSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }))
    closeSync(fd)
    return true
  } catch { return false }
}

function _releaseBatchLock(workspaceDir) {
  try { rmSync(_batchLockPath(workspaceDir), { force: true }) } catch {}
}

function _isBatchLockAlive(workspaceDir) {
  const lockPath = _batchLockPath(workspaceDir)
  if (!existsSync(lockPath)) return false
  try {
    // R22-⑯：锁文件 mtime > 30s → 崩溃残留（同一进程内批量写不会超 30s），清理后允许恢复
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
  for (const txnDir of readdirSync(root)) {
    const dir = join(root, txnDir)
    let state = null
    const statePath = join(dir, 'state.json')
    try { state = JSON.parse(readFileSync(statePath, 'utf-8')) } catch {
      // r10(C)：孤儿事务清理——state.json 缺失 = createJournal 未完成（edit 从未执行）。
      // 旧实现静默 continue：孤儿目录永不回收（prune 读 state 失败同样 continue）→ .malong 无限增长。
      // 删前复核：若目标文件已存在且内容 ≠ backup，说明 edit 可能已发生 → 保守保留 + 审计（不丢回滚能力）。
      if (!existsSync(statePath)) {
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
    if (state.state === 'committed' || state.state === 'rolled_back' || state.state === 'abandoned' || state.state === 'needs_review') {
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
      if (state.state === 'staged' && existsSync(backup) && existsSync(absPath)) {
        // 哈希三方判定（防覆盖后来的合法写入）：
        // 当前 == 写前 → 事务从未落地（dryRun 残留/崩溃在 rename 前）→ 不覆盖，标 abandoned
        // 当前 == 写后(new_hash) → rename 已成功、崩溃在 committed 前 → 补标 committed
        // 两者都不是 → 外部修改过 → 绝不覆盖，标 needs_review
        const curHash = sha256(readFileSync(absPath))
        const oldHash = sha256(readFileSync(backup))
        if (curHash === oldHash) {
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
      atomicWrite(join(dir, 'state.json'), JSON.stringify({ ...state, state: 'rolled_back', rolled_back_at: new Date().toISOString() }), { fsync: true })
      recovered.push({ txn_id: txnDir, file: manifest.file, action: 'rolled_back' })
    } catch (e) {
      atomicWrite(join(dir, 'state.json'), JSON.stringify({ ...state, state: 'failed', reason: e.message }), { fsync: true })
      recovered.push({ txn_id: txnDir, file: null, action: 'rollback_failed', reason: e.message })
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
            if (existsSync(backup) && existsSync(absPath) && state.new_hash && sha256(readFileSync(absPath)) === state.new_hash) {
              // r9(F5)：恢复写原子化 + 取 .mlock（防恢复与并发写者交错覆盖 / 恢复期间再崩溃留半截）
              const rl = await acquireLock(absPath, 30000)
              if (!rl.locked) {
                try {
                  if (sha256(readFileSync(absPath)) === state.new_hash) {
                    atomicWrite(absPath, readFileSync(backup), { fsync: true })
                    recovered.push({ txn_id: txnId, file: manifest.file, action: 'batch_partial_rollback' })
                  }
                } finally {
                  rl.release()
                }
              } else {
                recovered.push({ txn_id: txnId, file: manifest.file, action: 'batch_partial_rollback_skipped', reason: 'lock busy' })
              }
            }
            updateJournalState(txnDir, { state: 'rolled_back', rolled_back_at: new Date().toISOString(), reason: 'batch_partial' })
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
