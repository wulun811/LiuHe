// 码龙 — 多文件变更工具 (v2 P2.3)
// 基于 Git Worktree 的事务性多文件变更 + 回滚
// 详见：通天计划 §六 码龙

import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

export const name = 'tool-git-worktree'
export const version = '0.2.0'

let _core

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', timeout: 30000 }).trim()
}

export async function init(core) {
  _core = core
  core.registerService('gitWorktree', {
    async applyChanges(repoDir, changes, opts = {}) {
      if (!existsSync(join(repoDir, '.git'))) {
        return { success: false, error: 'not_a_git_repo', path: repoDir }
      }
      if (!Array.isArray(changes) || changes.length === 0) {
        return { success: false, error: 'no_changes' }
      }

      const branchName = `tongtian-multi-${Date.now()}-${randomUUID().slice(0, 8)}`
      const worktreePath = mkdtempSync(join(tmpdir(), 'tongtian-wt-'))
      const verify = opts.verify || (() => ({ ok: true }))
      const originalBranch = git(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir)

      try {
        git(['checkout', '-b', branchName], repoDir)
        git(['checkout', originalBranch], repoDir)  // 切回原分支以便 worktree add 不会检测到冲突
        git(['worktree', 'add', '--checkout', worktreePath, branchName], repoDir)

        for (const change of changes) {
          const fullPath = join(worktreePath, change.path)
          if (change.newContent !== undefined) {
            const dir = join(fullPath, '..')
            if (!existsSync(dir)) { mkdirSync(dir, { recursive: true }) }
            writeFileSync(fullPath, change.newContent, 'utf-8')
          } else if (change.delete) {
            if (existsSync(fullPath)) rmSync(fullPath)
          }
        }

        const verResult = verify(worktreePath)
        if (!verResult.ok) {
          throw new Error(`verification failed: ${verResult.error || 'unknown'}`)
        }

        git(['add', '-A'], worktreePath)
        git(['commit', '-m', opts.message || `tongtian: multi-file change (${changes.length} files)`], worktreePath)
        git(['worktree', 'remove', '--force', worktreePath], repoDir)
        rmSync(worktreePath, { recursive: true, force: true })
        git(['checkout', originalBranch], repoDir)
        git(['merge', '--ff-only', branchName], repoDir)
        git(['branch', '-D', branchName], repoDir)

        return { success: true, branch: branchName, files: changes.length, commit: git(['rev-parse', 'HEAD'], repoDir) }
      } catch (e) {
        try { git(['worktree', 'remove', '--force', worktreePath], repoDir) } catch {}
        try { rmSync(worktreePath, { recursive: true, force: true }) } catch {}
        try { git(['branch', '-D', branchName], repoDir) } catch {}
        try { git(['checkout', originalBranch], repoDir) } catch {}
        return { success: false, error: e.message, branch: branchName }
      }
    },

    async createBranch(repoDir, branchName) {
      git(['checkout', '-b', branchName], repoDir)
      return { branch: branchName }
    },

    async mergeBranch(repoDir, branchName) {
      git(['checkout', branchName], repoDir)
      git(['merge', '--ff-only', branchName], repoDir)
      return { merged: true }
    },

    async deleteBranch(repoDir, branchName) {
      git(['branch', '-D', branchName], repoDir)
      return { deleted: true }
    },

    async status(repoDir) {
      const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir)
      const hash = git(['rev-parse', 'HEAD'], repoDir)
      const dirty = git(['status', '--porcelain'], repoDir).length > 0
      return { branch, hash, dirty, repo: repoDir }
    },
  })
  _core.log('info', '[tool-git-worktree] registered')
}

export async function start() {}
export async function stop() {}
