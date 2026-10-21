// test-git-exclude.js — dogfood-050 P3：工具产物目录自动进 .git/info/exclude（不污染 git status）
// 覆盖：① git 目录 → 写入两行 + 幂等 ② worktree（.git 是文件）→ 解析 gitdir ③ 非 git 目录 → 跳过不崩
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
const assert = (c, m) => { if (c) pass++; else { fail++; console.error('  FAIL:', m) } }
const { ensureGitExclude, isGitRepo } = await import(pathToFileURL(join(__dirname, '..', 'git-exclude.js')).href)

const TMP = join(os.tmpdir(), 'opencode', 'git-exclude-test')
try { rmSync(TMP, { recursive: true, force: true }) } catch {}

// ① git 目录
{
  const repo = join(TMP, 'repo1')
  mkdirSync(join(repo, '.git', 'info'), { recursive: true })
  const changed = ensureGitExclude(repo)
  const ex = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf-8')
  assert(changed === true, '① 首次写入返回 true')
  assert(ex.includes('.malong/') && ex.includes('.ai-transactions/'), '① exclude 含两行产物目录')
  assert(ensureGitExclude(repo) === false, '① 幂等：二次调用不重写（进程内缓存）')
  const ex2 = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf-8')
  assert(ex2 === ex, '① 幂等：文件内容不变')
}

// ② worktree（.git 是文件，gitdir 指向别处）
{
  const wt = join(TMP, 'wt')
  const gitdir = join(TMP, 'main', '.git', 'worktrees', 'wt')
  mkdirSync(wt, { recursive: true })
  mkdirSync(gitdir, { recursive: true })
  writeFileSync(join(wt, '.git'), `gitdir: ${gitdir}\n`)
  const changed = ensureGitExclude(wt)
  assert(changed === true, '② worktree 写入返回 true')
  const ex = readFileSync(join(gitdir, 'info', 'exclude'), 'utf-8')
  assert(ex.includes('.malong/'), '② 写到 gitdir 的 info/exclude')
}

// ③ 非 git 目录
{
  const plain = join(TMP, 'plain')
  mkdirSync(plain, { recursive: true })
  assert(ensureGitExclude(plain) === false, '③ 非 git 目录跳过')
  assert(ensureGitExclude(join(TMP, 'ghost')) === false, '③ 不存在的目录不崩')
}

// ④ dogfood-050：isGitRepo 判定（transaction-store 复用；修复后 git 仓不写 .gitignore）
{
  assert(isGitRepo(join(TMP, 'repo1')) === true, '④ git 目录 → isGitRepo true')
  assert(isGitRepo(join(TMP, 'wt')) === true, '④ worktree → isGitRepo true')
  assert(isGitRepo(join(TMP, 'plain')) === false, '④ 非 git 目录 → false')
  assert(isGitRepo(join(TMP, 'ghost')) === false, '④ 不存在目录 → false')
}

console.log(`== test-git-exclude: ${pass} passed, ${fail} failed ==`)
process.exit(fail ? 1 : 0)
