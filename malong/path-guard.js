// r9：统一路径守卫——从 transaction-store / read-symbol 提取共享，供全部读写路径复用
// 原则：字符串校验挡不住 symlink，realpath 解析后比对前缀；敏感名单对真目标重验（链接名可绕过）
import { join, dirname, sep } from 'node:path'
import { realpathSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync, existsSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { validateFilePath } from './error-codes.js'

// r8(B1)：realpath 越界守卫——{ blocked:false } 或 { blocked:true, detail, reason }
// 目标路径不存在时回退校验 dirname（新建文件场景）；workspace 根为 symlink 时两侧都 resolve，不误拒
export function guardRealPath(projectRoot, fileRel) {
  const pathCheck = validateFilePath(fileRel)
  if (pathCheck.blocked) return pathCheck
  let realRoot = null
  try {
    realRoot = realpathSync(projectRoot)
  } catch {
    return { blocked: true, detail: `cannot resolve workspace root: ${projectRoot}`, reason: 'path_unresolvable' }
  }
  const absPath = join(projectRoot, fileRel)
  let real = null
  // r9：目标不存在时逐级向上回溯到第一个可解析的祖先（新建文件/多级新目录场景）——
  // 旧实现只回退 dirname(absPath) 一次，父目录也不存在时误报 path_unresolvable
  let probe = absPath
  for (;;) {
    try {
      real = realpathSync(probe)
      break
    } catch {}
    const parent = dirname(probe)
    if (parent === probe) {
      return { blocked: true, detail: `cannot resolve path: ${fileRel}`, reason: 'path_unresolvable' }
    }
    probe = parent
  }
  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    return { blocked: true, detail: `symlink escape: ${fileRel} resolves outside workspace`, reason: 'symlink_escape' }
  }
  return { blocked: false }
}

// r8(B3)：读侧守卫——越界拒 + 禁名单对 realpath 真目标重验（链接名绕过防护）
export function guardReadPath(projectRoot, fileRel) {
  const pathCheck = validateFilePath(fileRel)
  if (pathCheck.blocked) return pathCheck
  let realRoot = null
  try {
    realRoot = realpathSync(projectRoot)
  } catch {
    return { blocked: true, detail: `cannot resolve workspace root: ${projectRoot}`, reason: 'path_unresolvable' }
  }
  const absPath = join(projectRoot, fileRel)
  let real = null
  try {
    real = realpathSync(absPath)
  } catch {
    // r11：文件不存在时放行——下游（outline/read_symbol 等）报 file_not_found 更准确，
    // 旧实现一律 path_unresolvable（PATH_BLOCKED），对「用户笔误文件名」是误导性错误
    if (!existsSync(absPath)) return { blocked: false, not_found: true }
    return { blocked: true, detail: `cannot resolve path: ${fileRel}`, reason: 'path_unresolvable' }
  }
  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    return { blocked: true, detail: `symlink escape: ${fileRel} resolves outside workspace`, reason: 'symlink_escape' }
  }
  const realCheck = validateFilePath(real.slice(realRoot.length).replace(/^[\\/]/, ''))
  if (realCheck.blocked) {
    return { blocked: true, detail: `${realCheck.detail} (via symlink ${fileRel})`, reason: realCheck.reason }
  }
  return { blocked: false }
}

// r8(B2)：txnId 拼进目录路径——拒绝穿越（../、绝对路径、分隔符）
export function isSafeTxnId(txnId) {
  return typeof txnId === 'string' && txnId.length > 0 && txnId.length <= 100 &&
    !txnId.includes('/') && !txnId.includes('\\') && txnId !== '..' && !txnId.startsWith('.')
}

// r8(B5)：原子写 tmp+rename——崩溃不留半截文件；随机后缀防植入 .tmp symlink 穿透
export function atomicWrite(absPath, content, opts = {}) {
  const tmp = `${absPath}.txn-${Date.now()}-${randomUUID().slice(0, 8)}`
  // R17-6：权限位保留——目标已有文件时继承其 mode，防重建后权限被重置为默认
  let mode = null
  try { mode = statSync(absPath).mode } catch {}
  writeFileSync(tmp, content, mode != null ? { mode: mode & 0o777 } : undefined)
  // r10(D)：崩溃恢复资产（journal/事务路径）先 fsync 再 rename——tmp+rename 只保证原子性，
  // 掉电时未落盘的页可能在 rename 后丢失；fsync 后 rename 保证要么旧要么新且可恢复。
  // 普通编辑路径不传 fsync（每次多一次磁盘同步，高频写入感知明显）。
  if (opts.fsync === true) {
    // Windows：fsync 需要句柄带写访问（FlushFileBuffers 要求 GENERIC_WRITE），只读 'r' 必 EPERM
    const fd = openSync(tmp, 'r+')
    try { fsyncSync(fd) } finally { closeSync(fd) }
  }
  renameSync(tmp, absPath)
}
