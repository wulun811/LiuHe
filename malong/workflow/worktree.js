// workflow/worktree.js — S5.4a git_worktree 阶段化（preview/apply/status）。
// 纯本地：变更归一化 + 预览 diff（不触 git、不写盘）；实际事务由 classic git_worktree 委派执行。
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const WORKTREE_RULES_VERSION = 'git-worktree-v1'

// 归一化 + 校验（与 classic git_worktree 的参数契约一致，禁止 new_content+delete 同传）
export function normalizeChanges(changes) {
  if (!Array.isArray(changes) || changes.length === 0) {
    return { ok: false, error: 'missing_parameter', message: 'changes must be a non-empty array' }
  }
  const out = []
  for (let i = 0; i < changes.length; i++) {
    const c = changes[i]
    if (!c || typeof c.path !== 'string' || !c.path) {
      return { ok: false, error: 'invalid_parameter', message: `changes[${i}].path is required` }
    }
    if (c.new_content !== undefined && typeof c.new_content !== 'string') {
      return { ok: false, error: 'invalid_parameter', message: `changes[${i}].new_content must be a string` }
    }
    if (c.delete !== undefined && typeof c.delete !== 'boolean') {
      return { ok: false, error: 'invalid_parameter', message: `changes[${i}].delete must be a boolean` }
    }
    if (c.new_content !== undefined && c.delete !== undefined) {
      return { ok: false, error: 'invalid_parameter', message: `changes[${i}]: new_content and delete are mutually exclusive` }
    }
    out.push({ path: c.path, ...(c.new_content !== undefined ? { new_content: c.new_content } : {}), ...(c.delete !== undefined ? { delete: c.delete } : {}) })
  }
  return { ok: true, changes: out }
}

function lineStats(a, b) {
  const la = a ? a.split('\n').length : 0
  const lb = b ? b.split('\n').length : 0
  return { lines_before: la, lines_after: lb }
}

// 预览：逐项判定 add/modify/noop/delete（不触 git、不写盘）
export function previewChanges(workspaceDir, changes) {
  const items = []
  for (const c of changes) {
    const abs = join(workspaceDir, c.path)
    const existed = existsSync(abs)
    if (c.delete) {
      items.push({ path: c.path, action: existed ? 'delete' : 'noop', ...(existed ? {} : { reason: 'missing' }) })
      continue
    }
    let before = null
    try { before = existed ? readFileSync(abs, 'utf-8') : null } catch { before = undefined }
    if (before === undefined) {
      items.push({ path: c.path, action: 'modify_unreadable', changed: true })
    } else if (before === null) {
      items.push({ path: c.path, action: 'add', changed: true, ...lineStats('', c.new_content) })
    } else if (before === c.new_content) {
      items.push({ path: c.path, action: 'noop', changed: false, reason: 'identical' })
    } else {
      items.push({ path: c.path, action: 'modify', changed: true, ...lineStats(before, c.new_content) })
    }
  }
  return items
}

// classic git_worktree 结果 → 操作/证据状态判定
export function classifyWorktreeResult(r) {
  if (!r || r.success) return { opState: 'succeeded', result: 'passed', preserved: false }
  if (r.error === 'merge_failed_commit_preserved') return { opState: 'indeterminate', result: 'unknown', preserved: true }
  return { opState: 'failed', result: 'failed', preserved: false }
}