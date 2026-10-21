// 16：file 参数共用守卫——LLM 传错 file（目录/绝对路径/不存在）时给出精确归因，
// 而不是静默返回空结果（第二轮 UX 报告事故：把 workspace 根目录传成 file）。
// 全项目唯一维护点：服务层（getImpactAnalysis/getModuleDependencies/getFileOutline）与
// handler 层（references/inspect/find-tests/rename-symbol）全部复用本函数。

import { join, isAbsolute } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { parseMalongignore, isIgnored } from './file-collector.js'
import { toWorkspaceRel } from './tools/entry-shared.js'

// LH-005：混合分隔符/盘符归一——旧实现 startsWith(workspaceDir) 在 win 反斜杠/大小写差异下
// 剥前缀失败（绝对路径残留 → DB miss）；统一走 toWorkspaceRel（POSIX 形式 + 相对化）。
export function normalizeFilePath(file, workspaceDir) {
  return toWorkspaceRel(file, workspaceDir) || ''
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
  const absRaw = workspaceDir ? (isAbsolute(raw) ? raw : join(workspaceDir, raw)) : raw
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
    // R2：被 .malongignore 排除的文件 reindex 也永远不会索引——旧建议（Call reindex）白费一轮；
    // 指明 target 显式指名可覆盖 ignore（findCandidates 的 target 目录递归即此设计）。
    let suggestion = `Call reindex(workspace_dir=...) to index it (query tools auto-index on demand via ensureFreshFile; this error means the file was excluded or indexing failed)`
    try {
      const rules = workspaceDir ? parseMalongignore(join(workspaceDir, '.malongignore')) : []
      if (rules.length && isIgnored(path, rules, false)) {
        suggestion = `File is excluded by .malongignore, so reindex will NOT index it. Pass an explicit target (e.g. code_task with target={file:"${path}"}) — target-directed scan covers ignored files — or adjust .malongignore.`
      }
    } catch {}
    return { ok: false, error: { code: 'FILE_NOT_INDEXED', message: `File exists but is not indexed yet: ${path}`, suggestion } }
  }
  return { ok: false, error: { code: 'FILE_NOT_FOUND', message: `No such file: ${path}`, suggestion: 'Check the path is relative to workspace_dir, or use glob to find the file' } }
}
