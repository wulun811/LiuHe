// writer-registry.js — 写路径契约统一（Y002-S1/B1）
// 三条写路径（write_runtime / TransactionStore / batch_edit）完成原子写后登记写者，
// collision_guard classify 借此识别"是谁改的"，不再一律判 external。
// 登记只影响分类信息，不影响写路径自身行为；内存态（重启丢失 → 安全降级 external，
// 因为 check 时 currentHash 与登记 hash 不匹配时仍走 backup 比对 / external）。
// 与 collision_guard contentHashFast 同口径（大文件采样 sha256），保证登记 hash
// 与 check 时的 currentHash 可比对。

import { join } from 'node:path'
import { readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { sha256 } from './hash-utils.js'

const LARGE_FILE_BYTES = 1024 * 1024
const CHUNK_SIZE = 4096
const MAX_ENTRIES = 2000

const writers = new Map()

function contentHashFast(filePath) {
  const stat = statSync(filePath)
  if (stat.size <= LARGE_FILE_BYTES) return sha256(readFileSync(filePath, 'utf-8'))
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

export function registerWriter(workspaceDir, file, writer) {
  try {
    const hash = contentHashFast(join(workspaceDir, file))
    writers.set(`${workspaceDir}:${file}`, { writer, hash })
    if (writers.size > MAX_ENTRIES) {
      writers.delete(writers.keys().next().value)
    }
    return true
  } catch {
    return false
  }
}

export function getRegisteredWriter(workspaceDir, file, currentHash) {
  const entry = writers.get(`${workspaceDir}:${file}`)
  if (entry && entry.hash === currentHash) return entry.writer
  return null
}
