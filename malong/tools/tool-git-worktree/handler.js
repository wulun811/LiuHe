import { execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

function git(args, cwd, timeout) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf-8', timeout }, (err, stdout) => {
      if (err) return reject(new Error(`git ${args[0]}: ${(err.stderr || err.message || '').toString().slice(0, 300)}`))
      resolve((stdout || '').trim())
    })
  })
}

function runShell(cmd, cwd, timeout) {
  return new Promise((resolve) => {
    execFile('bash', ['-c', cmd], { cwd, timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ exitCode: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: (stdout || '').toString().slice(0, 4000), stderr: (stderr || '').toString().slice(0, 4000) })
    })
  })
}

export async function handle(args, context) {
  const repoDir = args?.workspace_dir
  if (!repoDir) {
    return { error: 'missing_parameter', message: 'workspace_dir is required' }
  }
  const changes = args?.changes
  if (!Array.isArray(changes) || changes.length === 0) {
    return { error: 'missing_parameter', message: 'changes is required: [{path, new_content|delete}]' }
  }
  for (const c of changes) {
    if (!c || typeof c.path !== 'string' || c.path.includes('..')) {
      return { error: 'invalid_parameter', message: `Each change needs a path relative to workspace_dir (no '..'): ${JSON.stringify(c)}` }
    }
  }
  const timeout = Math.min(parseInt(args?.timeout) || 30000, 120000)

  if (!existsSync(join(repoDir, '.git'))) {
    return { error: 'not_a_git_repo', message: 'workspace_dir is not a git repository', path: repoDir }
  }

  const branchName = `tongtian-multi-${Date.now()}-${randomUUID().slice(0, 8)}`
  const worktreePath = mkdtempSync(join(tmpdir(), 'tongtian-wt-'))

  let originalBranch
  try {
    originalBranch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir, timeout)
  } catch (e) {
    return { error: 'git_failed', message: e.message }
  }

  try {
    await git(['checkout', '-b', branchName], repoDir, timeout)
    await git(['checkout', originalBranch], repoDir, timeout)
    await git(['worktree', 'add', '--checkout', worktreePath, branchName], repoDir, timeout)

    for (const change of changes) {
      const fullPath = join(worktreePath, change.path)
      if (change.new_content !== undefined) {
        const dir = join(fullPath, '..')
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
        writeFileSync(fullPath, change.new_content, 'utf-8')
      } else if (change.delete) {
        if (existsSync(fullPath)) rmSync(fullPath)
      } else {
        throw new Error(`change for ${change.path} needs new_content or delete`)
      }
    }

    if (args?.verify_cmd) {
      const verResult = await runShell(args.verify_cmd, worktreePath, timeout)
      if (verResult.exitCode !== 0) {
        throw new Error(`verification failed (exit ${verResult.exitCode}): ${verResult.stderr || verResult.stdout}`)
      }
    }

    await git(['add', '-A'], worktreePath, timeout)
    await git(['commit', '-m', args?.message || `tongtian: multi-file change (${changes.length} files)`], worktreePath, timeout)
    const commit = await git(['rev-parse', 'HEAD'], worktreePath, timeout)
    await git(['worktree', 'remove', '--force', worktreePath], repoDir, timeout)
    rmSync(worktreePath, { recursive: true, force: true })
    await git(['checkout', originalBranch], repoDir, timeout)
    await git(['merge', '--ff-only', branchName], repoDir, timeout)
    await git(['branch', '-D', branchName], repoDir, timeout)

    return {
      success: true,
      branch: branchName,
      files: changes.length,
      commit,
      next_step: 'Changes committed on the base branch. Review the commit before pushing.',
    }
  } catch (e) {
    try { await git(['worktree', 'remove', '--force', worktreePath], repoDir, timeout) } catch {}
    try { rmSync(worktreePath, { recursive: true, force: true }) } catch {}
    try { await git(['branch', '-D', branchName], repoDir, timeout) } catch {}
    try { await git(['checkout', originalBranch], repoDir, timeout) } catch {}
    return {
      success: false,
      error: 'transaction_rolled_back',
      message: e.message,
      detail: 'Worktree cleaned up, branch deleted, checked out back to original branch. No changes remain.',
    }
  }
}
