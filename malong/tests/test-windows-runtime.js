// Real subprocess/Git coverage; no Bash PATH override and no external services.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { migrateEntry, verifyTrees } from '../state-migrate.js'
import { handle } from '../tools/tool-git-worktree/handler.js'

const root = mkdtempSync(join(tmpdir(), 'malong-windows-runtime-'))
try {
  const src = join(root, 'src'), dst = join(root, 'dst')
  mkdirSync(join(src, 'nested'), { recursive: true })
  writeFileSync(join(src, 'nested', 'data.db'), 'state bytes')
  assert.equal(migrateEntry(src, dst, { forceCopy: true }).status, 'moved')
  assert.equal(readFileSync(join(dst, 'nested', 'data.db'), 'utf8'), 'state bytes')
  assert.equal(existsSync(src), false)
  const fsrc = join(root, 'schema-version'), fdst = join(root, 'schema-copy')
  writeFileSync(fsrc, 'v1')
  assert.equal(migrateEntry(fsrc, fdst, { forceCopy: true }).status, 'moved')
  assert.equal(readFileSync(fdst, 'utf8'), 'v1')
  writeFileSync(fsrc, 'v2') // Same size, different content must not pass verification.
  assert.equal(verifyTrees(fsrc, fdst), false)
  assert.equal(migrateEntry(fsrc, join(root, 'rejected'), { forceCopy: true, verify: () => false }).status, 'failed')
  assert.equal(readFileSync(fsrc, 'utf8'), 'v2')
  const links = join(root, 'links'), outside = join(root, 'outside')
  mkdirSync(links); mkdirSync(outside)
  writeFileSync(join(outside, 'keep.txt'), 'keep')
  symlinkSync(outside, join(links, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal(migrateEntry(links, join(root, 'links-copy'), { forceCopy: true }).status, 'failed')
  assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'keep')
  assert.equal(existsSync(links), true)

  const repo = join(root, 'repo with spaces')
  mkdirSync(repo)
  const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git(['init']); git(['config', 'user.name', 'Runtime Test']); git(['config', 'user.email', 'test@example.invalid'])
  writeFileSync(join(repo, 'value.txt'), '1')
  git(['add', '.']); git(['commit', '-m', 'fixture'])
  const before = git(['rev-parse', 'HEAD'])
  const saved = process.env.MALONG_INTERFACE
  process.env.MALONG_INTERFACE = 'graph'
  try {
    const success = await handle({ workspace_dir: repo, changes: [{ path: 'value.txt', new_content: '2' }], verify_cmd: 'node -e "if(process.env.MALONG_INTERFACE)process.exit(9);process.exit(0)"', message: 'valid' }, {})
    assert.equal(success.success, true, JSON.stringify(success))
    assert.notEqual(git(['rev-parse', 'HEAD']), before)
    const committed = git(['rev-parse', 'HEAD'])
    const fail = await handle({ workspace_dir: repo, changes: [{ path: 'value.txt', new_content: '3' }], verify_cmd: 'node -e "console.error(\'expected rejection\');process.exit(7)"', message: 'invalid' }, {})
    assert.equal(fail.error, 'transaction_rolled_back', JSON.stringify(fail))
    assert.match(fail.message, /exit 7/)
    assert.equal(git(['rev-parse', 'HEAD']), committed)
    assert.equal(readFileSync(join(repo, 'value.txt'), 'utf8'), '2')
    assert.equal(git(['status', '--short']), '')
    const quotedExe = await handle({ workspace_dir: repo, changes: [{ path: 'value.txt', new_content: '4' }], verify_cmd: `"${process.execPath}" -e "process.exit(0)"`, message: 'quoted executable' }, {})
    assert.equal(quotedExe.success, true, JSON.stringify(quotedExe))
    assert.equal(readFileSync(join(repo, 'value.txt'), 'utf8'), '4')
  } finally {
    if (saved === undefined) delete process.env.MALONG_INTERFACE
    else process.env.MALONG_INTERFACE = saved
  }
  console.log('test-windows-runtime: migration integrity and native-shell Git commit/rollback passed')
} finally { rmSync(root, { recursive: true, force: true }) }
