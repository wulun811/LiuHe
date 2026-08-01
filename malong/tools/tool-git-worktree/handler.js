import { execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

function guardPath(root, userPath) {
  // r23-fix3: LLM 可能传非字符串路径（数字/对象）→ resolve() 会抛 TypeError 崩溃
  if (typeof root !== 'string' || typeof userPath !== 'string' || userPath === '') return null
  const rootResolved = resolve(root)
  const resolved = resolve(rootResolved, userPath)
  return resolved === rootResolved || resolved.startsWith(rootResolved + sep) ? resolved : null
}

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
  // r23-fix: includes('..') 会误拒合法文件名（foo..bar.txt）；改为 resolve 后校验是否逃逸仓库根
  // r23-fix3: 类型守卫——new_content 必须 string，否则 writeFileSync 会把对象转 '[object Object]' 静默写入并提交
  for (const c of changes) {
    if (!c || typeof c.path !== 'string' || !guardPath(repoDir, c.path)) {
      return { error: 'invalid_parameter', message: `Each change needs a path inside workspace_dir (no '..'): ${JSON.stringify(c)}` }
    }
    if (c.new_content !== undefined && typeof c.new_content !== 'string') {
      return { error: 'invalid_parameter', message: `new_content must be a string (got ${typeof c.new_content}): ${c.path}` }
    }
    if (c.delete !== undefined && typeof c.delete !== 'boolean') {
      return { error: 'invalid_parameter', message: `delete must be a boolean (got ${typeof c.delete}): ${c.path}` }
    }
    // r23-fix5: new_content+delete 同传是冲突参数——原版静默忽略 delete 写入 new_content，改为明确报错
    if (c.new_content !== undefined && c.delete !== undefined) {
      return { error: 'invalid_parameter', message: `new_content and delete are mutually exclusive: ${c.path}` }
    }
  }
  const timeout = Math.min(Math.max(parseInt(args?.timeout) || 30000, 1000), 120000)

  if (!existsSync(join(repoDir, '.git'))) {
    return { error: 'not_a_git_repo', message: 'workspace_dir is not a git repository', path: repoDir }
  }

  // r23-fix: dirty 工作区下 checkout 系列可能冲突/带脏移动，事务前提是干净基座
  const status = await git(['status', '--porcelain'], repoDir, timeout)
  if (status) {
    return {
      error: 'dirty_workspace',
      message: 'Workspace has uncommitted changes; worktree transaction requires a clean base',
      files: status.split('\n').slice(0, 10),
      suggestion: 'git stash (or commit) first, then retry',
    }
  }

  // r23-fix2: 去掉 Date.now()（见性成佛铁律：系统时间算非确定性外部调用）——uuid v4 本身含时间+随机，12 hex 足够唯一
  const branchName = `tongtian-multi-${randomUUID().replace(/-/g, '').slice(0, 12)}`
  const worktreePath = mkdtempSync(join(tmpdir(), 'tongtian-wt-'))

  let originalBranch
  try {
    originalBranch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir, timeout)
  } catch (e) {
    return { error: 'git_failed', message: e.message }
  }
  // r23-fix: detached HEAD 时 --abbrev-ref 返回 'HEAD'，merge --ff-only 目标歧义 → 拒绝并提示
  if (originalBranch === 'HEAD') {
    return { error: 'detached_head', message: 'Workspace is in detached HEAD state', suggestion: 'git checkout -b <branch> first, then retry' }
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
      // r23-fix2: LLM 误提交后需要明确撤销路径
      next_step: `Committed on the base branch. Undo with: git revert ${commit.slice(0, 12)} (keeps history) or git reset --hard HEAD~1 (removes commit). Review before pushing.`,
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
