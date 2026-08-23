import { execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync, realpathSync, lstatSync } from 'node:fs'
import { join, dirname, resolve, sep, relative, isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

// r8(F8)：同仓库 git 事务串行化门闩（每 repo 一条 promise 链）
const _repoLocks = new Map()

function guardPath(root, userPath) {
  // r23-fix3: LLM 可能传非字符串路径（数字/对象）→ resolve() 会抛 TypeError 崩溃
  if (typeof root !== 'string' || typeof userPath !== 'string' || userPath === '') return null
  const rootResolved = resolve(root)
  const resolved = resolve(rootResolved, userPath)
  return resolved === rootResolved || resolved.startsWith(rootResolved + sep) ? resolved : null
}

function assertInsideWorktree(realWorktree, fullPath) {
  // 审查修复（二轮）：r8(B4) 旧守卫只 realpath 目标+父目录——中间层 symlink 且深层路径不存在时
  // 两个 realpathSync 都 ENOENT → 守卫整体跳过 → mkdirSync(recursive) 跟随 symlink 写穿仓库外。
  // 逐层下降：每层 lstat 查 symlink，命中则 realpath 解析并校验仍在 worktree 内
  // 审查修复（五轮）：macOS /var→/private/var 等平台差异——调用方基于未 realpath 的根 join 出 fullPath 时，
  // relative(realWorktree, fullPath) 前缀错位误判越界（放行场景被拒）。先把 fullPath 已存在最长前缀
  // realpath 归一（深层不存在逐级上溯），与 realWorktree 同前缀体系后再比较
  let prefix = fullPath
  for (;;) {
    let realPrefix = null
    try { realPrefix = realpathSync(prefix) } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e
      const parent = dirname(prefix)
      if (parent === prefix) break
      prefix = parent
      continue
    }
    if (realPrefix !== realWorktree && !realPrefix.startsWith(realWorktree + sep)) {
      throw new Error(`refusing to write outside worktree: ${fullPath}`)
    }
    const suffix = fullPath.slice(prefix.length)
    fullPath = suffix ? realPrefix + suffix : realPrefix
    break
  }
  const rel = relative(realWorktree, fullPath)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`refusing to write outside worktree: ${fullPath}`)
  }
  let cur = realWorktree
  for (const part of rel.split(sep)) {
    if (!part) continue
    cur = join(cur, part)
    let st = null
    try { st = lstatSync(cur) } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') break // 路径不存在 → 后续层必不存在，安全
      throw e
    }
    if (st.isSymbolicLink()) {
      let targetReal
      try { targetReal = realpathSync(cur) } catch {
        // 审查修复（三轮）：断链 symlink（目标不存在）裸 ENOENT 抛 → 事务回滚消息不友好。视为拒绝（安全侧）
        throw new Error(`refusing to write through broken symlink: ${cur}`)
      }
      if (targetReal !== realWorktree && !targetReal.startsWith(realWorktree + sep)) {
        throw new Error(`refusing to write through symlink: ${cur} resolves outside worktree (${targetReal})`)
      }
      cur = targetReal
    }
  }
}

export function _assertInsideWorktreeForTest(realWorktree, fullPath) {
  assertInsideWorktree(realWorktree, fullPath)
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
  // r8(F8)：同仓库 git 操作串行化——并行调用 checkout/commit/merge 交错会毁分支状态
  // r9(P11)：锁 key 用 realpath——`/repo`、`/repo/`、`/repo/.`、symlink 别名指向同一仓库时
  // 旧实现各建一条链，r8 想防的 checkout/merge 交错仍在不同拼写间存在
  let lockKey = repoDir
  try { lockKey = realpathSync(repoDir) } catch {}
  const prev = _repoLocks.get(lockKey) || Promise.resolve()
  let release
  const myLock = new Promise(r => { release = r })
  const myLink = prev.catch(() => {}).then(() => myLock)
  _repoLocks.set(lockKey, myLink)
  await prev.catch(() => {})
  try {
    return await _runTransaction(repoDir, changes, args)
  } finally {
    release()
    // r9(P11)：链尾时清理 Map 条目（防跨大量 workspace 的微内存泄漏）——
    // 存的是 myLink（包装链）而非 myLock，身份比较要用 myLink
    if (_repoLocks.get(lockKey) === myLink) _repoLocks.delete(lockKey)
  }
}

async function _runTransaction(repoDir, changes, args) {
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

  let commit = null // r54(P0-10): 提升到 try 外——catch 需知道提交是否已创建，决定是否保留分支
  try {
    await git(['checkout', '-b', branchName], repoDir, timeout)
    await git(['checkout', originalBranch], repoDir, timeout)
    await git(['worktree', 'add', '--checkout', worktreePath, branchName], repoDir, timeout)

    for (const change of changes) {
      const fullPath = join(worktreePath, change.path)
      const realWorktree = realpathSync(worktreePath)
      // 审查修复（二轮）：逐层 symlink 守卫（覆盖中间层 symlink + 深层不存在场景）
      assertInsideWorktree(realWorktree, fullPath)
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

    // r54(P1): 只 add 声明的 change 路径——git add -A 会把 verify_cmd 产物(node_modules/build/coverage)一并提交
    await git(['add', '--', ...changes.map(c => c.path)], worktreePath, timeout)
    await git(['commit', '-m', args?.message || `tongtian: multi-file change (${changes.length} files)`], worktreePath, timeout)
    commit = await git(['rev-parse', 'HEAD'], worktreePath, timeout)
    await git(['worktree', 'remove', '--force', worktreePath], repoDir, timeout)
    rmSync(worktreePath, { recursive: true, force: true })
    await git(['checkout', originalBranch], repoDir, timeout)
    await git(['merge', '--ff-only', branchName], repoDir, timeout)
    await git(['branch', '-D', branchName], repoDir, timeout)
    // R18：merge 后工作区文件全变——索引整体失效，标 dirty 让后续读取/增量重抽自动刷新
    try { context?.codeIndexService?.markAllDirty() } catch {}

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
    // r54(P0-10): 提交已创建但 merge/后续失败——branchName 是该提交唯一 ref，删掉即悬挂丢失。保留分支供人工合并。
    if (commit) {
      try { await git(['checkout', originalBranch], repoDir, timeout) } catch {}
      return {
        success: false,
        error: 'merge_failed_commit_preserved',
        message: e.message,
        branch: branchName,
        commit,
        detail: `Commit ${commit.slice(0, 12)} was created but a later step failed. Branch "${branchName}" preserved (do NOT delete it). Recover with: git merge ${branchName}  (or git cherry-pick ${commit.slice(0, 12)}).`,
      }
    }
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
