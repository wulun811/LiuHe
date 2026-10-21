// 二轮审查修复测试：git-worktree 逐层 symlink 守卫（防中间层 symlink 写穿仓库外）
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert'
import { _assertInsideWorktreeForTest } from '../tools/tool-git-worktree/handler.js'

let passed = 0
function ok(cond, msg) {
  assert(cond, msg)
  passed++
  console.log(`  ok: ${msg}`)
}
function throws(fn, msg) {
  assert.throws(fn, msg)
  passed++
  console.log(`  ok: ${msg}`)
}

const root = mkdtempSync(join(tmpdir(), 'gwt-guard-'))
const repo = join(root, 'repo')
const outside = join(root, 'outside')
mkdirSync(repo, { recursive: true })
mkdirSync(outside, { recursive: true })
const realWorktree = realpathSync(repo)

// ── ① 中间层 symlink + 深层路径不存在 → 写穿（旧守卫绕过场景）──
console.log('\n── ① 中间层 symlink + 深层不存在 → 拒绝 ──')
{
  mkdirSync(join(repo, 'docs'))
  symlinkSync(outside, join(repo, 'docs', 'linkdir'), process.platform === 'win32' ? 'junction' : 'dir')
  const fullPath = join(repo, 'docs', 'linkdir', 'new', 'deep', 'file.txt')
  throws(() => _assertInsideWorktreeForTest(realWorktree, fullPath), '写穿路径被拒（旧守卫此处 ENOENT 全跳过）')
  assert(!rmSync ? true : true)
}

// ── ② symlink 指向 worktree 内部 → 放行 ──
console.log('\n── ② symlink 指向内部 → 放行 ──')
{
  mkdirSync(join(repo, 'inner'))
  symlinkSync(join(repo, 'inner'), join(repo, 'docs', 'inlink'), process.platform === 'win32' ? 'junction' : 'dir')
  _assertInsideWorktreeForTest(realWorktree, join(repo, 'docs', 'inlink', 'a.js'))
  ok(true, '内部 symlink 路径不拒绝')
}

// ── ③ 正常路径（无 symlink）→ 放行 ──
console.log('\n── ③ 正常路径 → 放行 ──')
{
  _assertInsideWorktreeForTest(realWorktree, join(repo, 'src', 'deep', 'x.js'))
  ok(true, '普通深层路径不拒绝')
}

// ── ④ 越出 worktree 的绝对路径 → 拒绝 ──
console.log('\n── ④ 越界路径 → 拒绝 ──')
{
  throws(() => _assertInsideWorktreeForTest(realWorktree, join(outside, 'evil.js')), 'worktree 外路径被拒')
}

// ── ⑤ 三轮→四轮：断链 symlink（目标不存在）→ 友好拒绝而非裸 ENOENT ──
console.log('\n── ⑤ 断链 symlink → 拒绝 ──')
{
  const broken = join(root, 'broken-target')
  const link = join(repo, 'docs', 'broken-link')
  symlinkSync(broken, link, process.platform === 'win32' ? 'junction' : 'dir')
  throws(() => _assertInsideWorktreeForTest(realWorktree, join(link, 'x.js')),
    /broken symlink|refusing to write through/,
    '断链 symlink 拒绝（旧实现 realpathSync 裸 ENOENT）')
}

// ── ⑥ R4：仓库无 commit → no_commits 结构化错误 + 引导 ──
console.log('\n── ⑥ 空仓库（unborn HEAD）→ no_commits ──')
{
  const { execSync } = await import('node:child_process')
  const { handle: gwtHandle } = await import('../tools/tool-git-worktree/handler.js')
  const emptyRepo = join(root, 'empty-repo')
  mkdirSync(emptyRepo, { recursive: true })
  execSync('git init -q', { cwd: emptyRepo })
  const r = await gwtHandle({ workspace_dir: emptyRepo, changes: [{ path: 'a.txt', new_content: 'x\n' }], message: 't' }, {})
  ok(r.error === 'no_commits', `空仓库 → no_commits（得 ${r.error}）`)
  ok(/initial commit/i.test(r.suggestion || ''), '引导含 initial commit')
}

rmSync(root, { recursive: true, force: true })
console.log(`\n== test-git-worktree-guard: ${passed} passed, 0 failed ==`)
