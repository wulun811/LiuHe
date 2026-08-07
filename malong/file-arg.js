// 16：file 参数共用守卫——LLM 传错 file（目录/绝对路径/不存在）时给出精确归因，
// 而不是静默返回空结果（第二轮 UX 报告事故：把 workspace 根目录传成 file）。
// 全项目唯一维护点：服务层（getImpactAnalysis/getModuleDependencies/getFileOutline）与
// handler 层（references/inspect/find-tests/rename-symbol）全部复用本函数。

import { join } from 'node:path'
import { existsSync, statSync } from 'node:fs'

// 归一化：剥 workspace 前缀 / 前导 ./ / 尾斜杠，绝对路径 → 相对（DB 存相对路径）
export function normalizeFilePath(file, workspaceDir) {
  let norm = String(file).trim()
  if (!norm) return ''
  if (workspaceDir && norm.startsWith(workspaceDir)) {
    norm = norm.slice(workspaceDir.length)
  }
  norm = norm.replace(/^[\\/]+/, '').replace(/^\.\//, '').replace(/[\\/]+$/, '')
  return norm
}

// 返回 { ok: true, path, fileId } 或 { ok: false, error: { code, message, suggestion } }
// 判定序：原始输入是目录（DIR_AS_FILE，含 workspace 根目录/尾斜杠）→ DB 命中 →
// 磁盘存在但未索引（FILE_NOT_INDEXED）→ 不存在（FILE_NOT_FOUND）
export function resolveFileArg({ db, workspaceDir, file }) {
  if (!file) {
    return { ok: false, error: { code: 'missing_parameter', message: 'file is required', suggestion: 'Provide a file path relative to workspace_dir' } }
  }
  const raw = String(file).trim()
  if (!raw) {
    return { ok: false, error: { code: 'invalid_input', message: `"${file}" is not a valid file path`, suggestion: 'Provide a file path relative to workspace_dir (e.g. "src/auth.py")' } }
  }
  // 目录判定优先（基于原始输入，不归一化）：绝对目录或工作区内相对目录都命中
  const absRaw = workspaceDir ? (raw.startsWith('/') ? raw : join(workspaceDir, raw)) : raw
  if (existsSync(absRaw)) {
    try {
      if (statSync(absRaw).isDirectory()) {
        return { ok: false, error: { code: 'DIR_AS_FILE', message: `"${file}" is a directory, not a file`, suggestion: 'Pass a file path relative to workspace_dir (e.g. "src/auth.py"), or omit the file parameter for project-wide search' } }
      }
    } catch {}
  }
  const path = normalizeFilePath(file, workspaceDir)
  if (!path) {
    return { ok: false, error: { code: 'invalid_input', message: `"${file}" is not a valid file path`, suggestion: 'Provide a file path relative to workspace_dir (e.g. "src/auth.py")' } }
  }
  if (db) {
    try {
      const f = db.prepare('SELECT id, path FROM files WHERE path = ?').get(path)
      if (f) return { ok: true, path: f.path, fileId: f.id }
    } catch {}
  }
  const abs = workspaceDir ? join(workspaceDir, path) : path
  if (existsSync(abs)) {
    return { ok: false, error: { code: 'FILE_NOT_INDEXED', message: `File exists but is not indexed yet: ${path}`, suggestion: `Call reindex(workspace_dir=...) to index it (query tools auto-index on demand via ensureFreshFile; this error means the file was excluded or indexing failed)` } }
  }
  return { ok: false, error: { code: 'FILE_NOT_FOUND', message: `No such file: ${path}`, suggestion: 'Check the path is relative to workspace_dir, or use glob to find the file' } }
}
