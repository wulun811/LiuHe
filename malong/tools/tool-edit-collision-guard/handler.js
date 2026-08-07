import { join } from 'node:path'
import { existsSync, readFileSync, statSync, openSync, readSync, closeSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { ErrorCodes, makeError, validateFilePath } from '../../error-codes.js'
import { TransactionStore } from '../tool-edit-transaction/transaction-store.js'
import { sha256 } from '../../hash-utils.js'
import { getRegisteredWriter } from '../../writer-registry.js'
import { getStateDir } from '../../host-config.js'

const MAX_SNAPSHOTS = 500
const LARGE_FILE_BYTES = 1024 * 1024
const CHUNK_SIZE = 4096

const snapshots = new Map()
let logicalClock = 0
let loaded = false

// Y001-S1: djb2 32 位弱哈希 → sha256（复用 hash-utils.js，防碰撞误判 modified/up_to_date）
function contentHash(content) {
  return sha256(content)
}

function contentHashFast(filePath) {
  const stat = statSync(filePath)
  if (stat.size <= LARGE_FILE_BYTES) {
    return contentHash(readFileSync(filePath, 'utf-8'))
  }
  const fd = openSync(filePath, 'r')
  try {
    const chunks = []
    const buf = Buffer.alloc(CHUNK_SIZE)
    readSync(fd, buf, 0, CHUNK_SIZE, 0)
    chunks.push(buf.toString('utf-8'))
    readSync(fd, buf, 0, CHUNK_SIZE, Math.floor(stat.size / 2))
    chunks.push(buf.toString('utf-8'))
    readSync(fd, buf, 0, CHUNK_SIZE, Math.max(0, stat.size - CHUNK_SIZE))
    chunks.push(buf.toString('utf-8'))
    return sha256(chunks.join('') + stat.size)
  } finally {
    closeSync(fd)
  }
}

function evictIfNeeded() {
  if (snapshots.size <= MAX_SNAPSHOTS) return
  const excess = snapshots.size - MAX_SNAPSHOTS
  const keys = snapshots.keys()
  for (let i = 0; i < excess; i++) {
    snapshots.delete(keys.next().value)
  }
}

// Y002-S1：快照持久化——内存 Map → stateDir 落盘（进程重启保留）。
// 写盘用 tmp+rename 原子；JSON 结构 { clock, snapshots: [[key, snap], ...] }。
// 注：快照含绝对路径（workspace 维度隔离依赖 key），落盘在用户 stateDir，与 usage 同级。
function persistSnapshots() {
  try {
    const dir = getStateDir()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const tmp = join(dir, 'collision-guard-snapshots.json.tmp')
    writeFileSync(tmp, JSON.stringify({ clock: logicalClock, snapshots: [...snapshots.entries()] }))
    renameSync(tmp, join(dir, 'collision-guard-snapshots.json'))
  } catch {}
}

function loadSnapshots() {
  if (loaded) return
  loaded = true
  try {
    const p = join(getStateDir(), 'collision-guard-snapshots.json')
    if (!existsSync(p)) return
    const data = JSON.parse(readFileSync(p, 'utf-8'))
    if (data.clock) logicalClock = Math.max(logicalClock, data.clock)
    for (const [k, v] of data.snapshots || []) snapshots.set(k, v)
  } catch {}
}

// Y002-S1：classify 四态——registry 写者识别（write_runtime/transaction/batch_edit）
// 优先于 TransactionStore 备份比对（this_txn），最后才是 external。
// 顺序依据：registry 是精确的"当前磁盘内容 == 写者写后状态"匹配；
// 备份比对是间接推断（读时快照 == 某事务备份 → 该事务改过它）。
function classifyModification(workspaceDir, file, readHash, currentHash) {
  const registered = getRegisteredWriter(workspaceDir, file, currentHash)
  if (registered) return registered
  try {
    const store = new TransactionStore(workspaceDir, { sweep: false })
    for (const txn of store.listTransactions()) {
      const meta = txn.files?.[file]
      if (!meta || meta.skipped) continue
      const backupName = meta.backupName || file.replace(/[/\\]/g, '__')
      const backupPath = join(workspaceDir, '.ai-transactions', txn.txnId, 'backup', backupName)
      if (!existsSync(backupPath)) continue
      if (contentHashFast(backupPath) === readHash) return 'this_txn'
    }
  } catch {}
  return 'external'
}

export async function handle(args, context) {
  loadSnapshots()
  const workspaceDir = args?.workspace_dir
  if (!workspaceDir) {
    return makeError(ErrorCodes.INVALID_INPUT, 'workspace_dir is required')
  }

  const file = args?.file
  if (!file) {
    return makeError(ErrorCodes.INVALID_INPUT, 'file is required')
  }

  const pathCheck = validateFilePath(file)
  if (pathCheck.blocked) {
    return makeError(ErrorCodes.PATH_BLOCKED, pathCheck.detail, { file, reason: pathCheck.reason })
  }

  const action = args?.action
  if (!action || !['record_read', 'check'].includes(action)) {
    return makeError(ErrorCodes.INVALID_ACTION, `action must be "record_read" or "check", got: ${action}`)
  }

  const session = args?.session_id || 'default'
  const absPath = join(workspaceDir, file)
  // Y001-S1: key 加入 workspace_dir，防两 workspace 同相对路径串读
  const key = `${workspaceDir}:${session}:${file}`

  if (action === 'record_read') {
    if (!existsSync(absPath)) {
      return { status: 'file_not_found', file }
    }
    const stat = statSync(absPath)
    let hash, lines = null
    if (stat.size <= LARGE_FILE_BYTES) {
      const content = readFileSync(absPath, 'utf-8')
      hash = contentHash(content)
      lines = content.split('\n').length
    } else {
      hash = contentHashFast(absPath)
    }
    snapshots.delete(key)
    snapshots.set(key, { hash, lines, seq: ++logicalClock, size: stat.size })
    evictIfNeeded()
    persistSnapshots()
    return { status: 'recorded', file, hash, next_step: 'Snapshot saved. Remember to check before editing.' }
  }

  if (!existsSync(absPath)) {
    return { status: 'file_not_found', file }
  }

  const snap = snapshots.get(key)
  if (!snap) {
    return { status: 'never_read', file, recommendation: 'call edit_collision_guard(action=record_read) after reading, then check before editing' }
  }
  snapshots.delete(key)
  snapshots.set(key, snap)

  const currentHash = contentHashFast(absPath)
  if (currentHash === snap.hash) {
    return { status: 'up_to_date', file, recommendation: 'safe to edit', next_step: 'Safe to edit. Use edit_transaction or edit_batch.' }
  }

  const modifiedBy = classifyModification(workspaceDir, file, snap.hash, currentHash)
  return {
    status: 'modified',
    file,
    read_hash: snap.hash,
    current_hash: currentHash,
    read_seq: snap.seq,
    modified_by: modifiedBy,
    recommendation: 're-read file before editing',
    next_step: 'File changed externally. Re-read file, then record_read again.',
    warning: modifiedBy === 'external'
      ? 'file modified externally since last read, old_string may be based on stale version'
      : 'file modified within this transaction, usually safe (self-modified)'
  }
}
