// state-migrate.js — LH-002：状态目录迁移的**隔离执行体**（在子进程中运行，见 state-migrate-cli.js）。
// 旧实现（host-config 内联 rename→cpSync→rm）在 Windows 跨盘 cpSync 硬崩（Node 22 0xC0000409，
// JS 不可 catch）时把宿主启动一起带走；且复制未校验就删源——中断即丢数据。
// 本模块纪律：① rename 快路径；② 复制落到 staging → 逐路径/大小/文件数校验 → 才就位 → 才删源；
// ③ 任何一步失败：源不动、staging 清理、逐条报告（fail-soft，由父进程决定告警/继续）。
import { existsSync, mkdirSync, renameSync, copyFileSync, rmSync, readdirSync, statSync, lstatSync, openSync, readSync, closeSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname, relative } from 'node:path'

function fileDigest(path) {
  const fd = openSync(path, 'r'), hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024)
  try {
    let n
    while ((n = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, n))
    return hash.digest('hex')
  } finally { closeSync(fd) }
}

// 树指纹：相对路径集（目录以 / 结尾）+ 字节数 + 内容摘要；支持单文件状态条目。
export function treeFingerprint(root) {
  const files = new Map()
  const hashes = new Map()
  let totalBytes = 0
  const addFile = (abs, rel) => {
    const size = statSync(abs).size
    files.set(rel, size)
    hashes.set(rel, fileDigest(abs))
    totalBytes += size
  }
  const walk = (dir, rel) => {
    let list = []
    try { list = readdirSync(dir, { withFileTypes: true }) } catch { return { error: 'unreadable' } }
    list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const e of list) {
      const abs = join(dir, e.name)
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        files.set(r + '/', 0)
        const sub = walk(abs, r)
        if (sub.error) return sub
      } else if (e.isFile()) {
        try { addFile(abs, r) } catch { return { error: 'unreadable' } }
      } else return { error: 'unsupported entry' }
    }
    return {}
  }
  let st
  try { st = lstatSync(root) } catch { return { error: 'unreadable' } }
  if (st.isFile()) {
    try { addFile(root, '') } catch { return { error: 'unreadable' } }
    return { files, hashes, totalBytes, count: files.size }
  }
  if (!st.isDirectory()) return { error: 'unsupported entry' }
  const err = walk(root, '')
  if (err.error) return { error: err.error }
  return { files, hashes, totalBytes, count: files.size }
}

// 复制完整性校验：路径集合、文件大小与内容一致（目录大小不参与）。
export function verifyTrees(src, dst) {
  const a = treeFingerprint(src), b = treeFingerprint(dst)
  if (a.error || b.error) return false
  if (a.files.size !== b.files.size) return false
  for (const [p, size] of a.files) {
    if (!b.files.has(p)) return false
    if (p.endsWith('/')) continue
    if (b.files.get(p) !== size) return false
    if (a.hashes.get(p) !== b.hashes.get(p)) return false
  }
  return true
}

// Avoid fs.cpSync: this host's Node 22 can abort on Windows cross-volume trees.
// Reject links/special files rather than silently omitting them before deleting source.
function copyTree(src, dst) {
  const st = lstatSync(src)
  if (st.isFile()) { copyFileSync(src, dst); return }
  if (!st.isDirectory()) throw new Error(`unsupported migration entry (source kept): ${src}`)
  mkdirSync(dst)
  for (const entry of readdirSync(src)) copyTree(join(src, entry), join(dst, entry))
}

// 单条目迁移：moved / skipped / failed；failed 时保证源完整（除非 rename 已成功）
export function migrateEntry(src, dst, opts = {}) {
  const log = opts.log || (() => {})
  const verify = opts.verify || verifyTrees
  const staging = `${dst}.malong-migrating-${process.pid}`
  try {
    if (!opts.forceCopy) {
      try {
        renameSync(src, dst)
        return { status: 'moved', mode: 'rename' }
      } catch { /* EXDEV/EPERM 等 → 复制路径 */ }
    }
    try { rmSync(staging, { recursive: true, force: true }) } catch {}
    mkdirSync(dirname(staging), { recursive: true })
    copyTree(src, staging)
    if (!verify(src, staging)) {
      try { rmSync(staging, { recursive: true, force: true }) } catch {}
      return { status: 'failed', error: 'copy verification failed (source kept)' }
    }
    if (existsSync(dst)) {
      // 竞态：目标已被其他进程落下 → 保留目标，清 staging，源保留（下次按条目合并）
      try { rmSync(staging, { recursive: true, force: true }) } catch {}
      return { status: 'skipped', reason: 'destination appeared during copy' }
    }
    renameSync(staging, dst)
    try {
      rmSync(src, { recursive: true, force: true })
      return { status: 'moved', mode: 'copy-verify-delete' }
    } catch (e) {
      log('warn', `state migration: copied+verified ${src} but source cleanup failed: ${e.message} (duplicate kept)`)
      return { status: 'moved', mode: 'copy-verify-delete', residue: true }
    }
  } catch (e) {
    try { rmSync(staging, { recursive: true, force: true }) } catch {}
    return { status: 'failed', error: e?.message || String(e) }
  }
}

const ENTRIES = ['workspaces', 'schema-version', 'last-crash-dump.json', 'crash.log', 'restart.log']

// 整目录迁移：逐条目；workspaces 目标已存在时按子条目合并（同名保留目标）。
export function runMigration(legacyDir, nextDir, opts = {}) {
  const log = opts.log || (() => {})
  const moved = [], skipped = [], failed = []
  if (!legacyDir || !nextDir || legacyDir === nextDir || !existsSync(legacyDir)) return { moved, skipped, failed }
  mkdirSync(nextDir, { recursive: true })
  for (const name of ENTRIES) {
    const src = join(legacyDir, name)
    if (!existsSync(src)) continue
    const dst = join(nextDir, name)
    if (!existsSync(dst)) {
      const r = migrateEntry(src, dst, opts)
      if (r.status === 'moved') { moved.push(name); if (r.residue) failed.push({ entry: name, error: 'source cleanup residue' }) }
      else if (r.status === 'skipped') skipped.push(name)
      else failed.push({ entry: name, error: r.error })
      continue
    }
    let srcIsDir = false, dstIsDir = false
    try { srcIsDir = statSync(src).isDirectory() } catch {}
    try { dstIsDir = statSync(dst).isDirectory() } catch {}
    if (name === 'workspaces' && srcIsDir && dstIsDir) {
      for (const entry of readdirSync(src)) {
        const cSrc = join(src, entry), cDst = join(dst, entry)
        if (existsSync(cDst)) { skipped.push(`workspaces/${entry}`); continue }
        const r = migrateEntry(cSrc, cDst, opts)
        if (r.status === 'moved') moved.push(`workspaces/${entry}`)
        else if (r.status === 'skipped') skipped.push(`workspaces/${entry}`)
        else failed.push({ entry: `workspaces/${entry}`, error: r.error })
      }
      try { if (readdirSync(src).length === 0) rmSync(src, { recursive: true, force: true }) } catch {}
      continue
    }
    skipped.push(name)
  }
  return { moved, skipped, failed }
}

// 相对路径工具（供父进程日志/校验）
export function relOf(root, p) { return relative(root, p) }
