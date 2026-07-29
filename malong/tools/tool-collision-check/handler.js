import { join } from 'node:path'
import { existsSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { ErrorCodes, makeError, validateFilePath } from '../../error-codes.js'
import { TransactionStore } from '../tool-edit-transaction/transaction-store.js'

const MAX_SNAPSHOTS = 500
const LARGE_FILE_BYTES = 1024 * 1024
const CHUNK_SIZE = 4096

const snapshots = new Map()

function contentHash(content) {
  let hash = 0
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) - hash) + content.charCodeAt(i)
    hash |= 0
  }
  return hash.toString(16)
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
    return contentHash(chunks.join('') + stat.size)
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

function classifyModification(workspaceDir, file) {
  try {
    const store = new TransactionStore(workspaceDir)
    for (const txn of store.listTransactions()) {
      if (txn.files?.[file] && !txn.files[file].skipped) {
        return 'this_txn'
      }
    }
  } catch {}
  return 'external'
}

export async function handle(args, context) {
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
  const key = `${session}:${file}`

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
    snapshots.set(key, { hash, lines, readAt: Date.now(), size: stat.size })
    evictIfNeeded()
    return { status: 'recorded', file, hash }
  }

  if (!existsSync(absPath)) {
    return { status: 'file_not_found', file }
  }

  const snap = snapshots.get(key)
  if (!snap) {
    return { status: 'never_read', file, recommendation: 'read file before editing' }
  }
  snapshots.delete(key)
  snapshots.set(key, snap)

  const currentHash = contentHashFast(absPath)
  if (currentHash === snap.hash) {
    return { status: 'up_to_date', file, recommendation: 'safe to edit' }
  }

  const modifiedBy = classifyModification(workspaceDir, file)
  return {
    status: 'modified',
    file,
    read_hash: snap.hash,
    current_hash: currentHash,
    read_at: new Date(snap.readAt).toISOString(),
    modified_by: modifiedBy,
    recommendation: 're-read file before editing',
    warning: modifiedBy === 'external'
      ? `文件自读取后已被外部修改，old_string 可能基于过时版本`
      : `文件在本事务内已被修改，通常安全（自己改的）`
  }
}
