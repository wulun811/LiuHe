// test-no-git-exclude.js — LH-WO-005A regression (real git worktree, MCP stdio).
//
// Requirement: MALONG_NO_GIT_EXCLUDE=1 must not write .git/info/exclude (worktree
// git_dir or common_dir), must not create .malong/ or .ai-transactions/ in the
// business tree, and must keep index/task/journal/backup under MALONG_STATE_DIR.
// The default (env unset) behavior must remain the historical one: code_task writes
// .git/info/exclude with the two artifact lines.
import { spawn, execFileSync } from 'node:child_process'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, lstatSync } from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MALONG = join(__dirname, '..')
const TMP = join(os.tmpdir(), 'opencode', 'no-git-exclude')
let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++; console.log('  ok ' + msg) }
  else { fail++; console.error('  FAIL: ' + msg) }
}

function runGit(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function walk(root, skipNames = null) {
  const out = {}
  const visit = (dir, rel) => {
    for (const name of readdirSync(dir).sort()) {
      if (skipNames && skipNames.has(name)) continue
      const full = join(dir, name)
      const r = rel ? rel + '/' + name : name
      const st = lstatSync(full)
      if (st.isDirectory()) visit(full, r)
      else if (st.isFile() || st.isSymbolicLink()) {
        try { out[r] = createHash('sha256').update(readFileSync(full)).digest('hex') }
        catch { out[r] = 'unreadable' }
      }
    }
  }
  visit(root, '')
  return out
}

function norm(map) {
  return Object.keys(map).sort().map(k => k + '=' + map[k]).join('\n')
}

function gitDirs(ws) {
  const gitDir = resolve(ws, runGit(ws, 'rev-parse', '--absolute-git-dir'))
  const common = resolve(ws, runGit(ws, 'rev-parse', '--git-common-dir'))
  return { gitDir, common }
}

function startServer(ws, stateDir, extraEnv = {}) {
  const env = { ...process.env, MALONG_STATE_DIR: stateDir, MALONG_INTERFACE: 'graph', MALONG_ENTRY_STATE: '1' }
  delete env.MALONG_NO_GIT_EXCLUDE
  delete env.MALONG_READONLY
  Object.assign(env, extraEnv)
  const child = spawn(process.execPath, [join(MALONG, 'mcp-server.js'), '--workspace', ws], {
    stdio: ['pipe', 'pipe', 'pipe'],
    // 中立 cwd：若本机没有预启动守护进程，mcp-server 会拉起 malong-parse，
    // 守护进程继承 cwd；Windows 上它会让测试结束后的 rmSync(ws) 恒 EBUSY。
    cwd: os.tmpdir(),
    env,
  })
  let buf = '', seq = 0, exited = false
  const pending = new Map()
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buf += chunk
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      if (!line.trim()) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      const p = msg.id && pending.get(msg.id)
      if (p) {
        clearTimeout(p.timer)
        pending.delete(msg.id)
        p.resolve(msg)
      }
    }
  })
  child.stderr.on('data', () => {})
  child.on('exit', () => {
    exited = true
    for (const p of pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error('server exited'))
    }
    pending.clear()
  })
  function rpc(method, params, timeoutMs = 60000) {
    if (exited) return Promise.reject(new Error('server exited'))
    const id = ++seq
    return new Promise((resolveP, rejectP) => {
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id)
          rejectP(new Error('timeout waiting for ' + method))
        }
      }, timeoutMs)
      pending.set(id, { resolve: resolveP, reject: rejectP, timer })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }
  async function rpcRetry(method, params, timeoutMs = 60000) {
    for (let i = 0; ; i++) {
      const r = await rpc(method, params, timeoutMs).catch((e) => ({ error: { code: -1, message: String(e.message || e) } }))
      if (r.error && r.error.code === -32000 && /still loading/i.test(String(r.error.message)) && i < 60) {
        await new Promise((r2) => setTimeout(r2, 500))
        continue
      }
      return r
    }
  }
  async function call(name, args, timeoutMs = 60000) {
    const r = await rpcRetry('tools/call', { name, arguments: args }, timeoutMs)
    if (r.error) return { _rpcError: r.error }
    const c = r.result && r.result.content && r.result.content[0]
    if (!c || c.type !== 'text') return { _rpcError: { code: 'content_not_text' } }
    try { return JSON.parse(c.text) } catch { return { _rpcError: { code: 'text_not_json', raw: c.text } } }
  }
  async function ready() {
    await rpcRetry('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'wo-005a', version: '0' } }, 15000)
    for (let i = 0; i < 60; i++) {
      const r = await rpc('tools/list', {}, 15000).catch(() => null)
      if (r && !r.error && r.result && Array.isArray(r.result.tools)) return r.result.tools
      await new Promise((r2) => setTimeout(r2, 250))
    }
    throw new Error('server-not-ready')
  }
  async function close() {
    try { await rpc('shutdown', {}, 3000) } catch {}
    if (child.exitCode === null) {
      await new Promise((r) => {
        const t = setTimeout(() => { try { child.kill('SIGKILL') } catch {}; r() }, 3000)
        child.once('exit', () => { clearTimeout(t); r() })
      })
    }
  }
  return { call, ready, close }
}

function ok(r) { return !!r && !r._rpcError && r.error == null && r.ok !== false }
function sameMap(a, b, label) {
  assert(norm(a) === norm(b), label + ' (files=' + Object.keys(a).length + ')')
}

// ── fixture: real git main + linked worktree ──
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })
const MAIN = join(TMP, 'main')
const WT = join(TMP, 'wt')
mkdirSync(join(MAIN, 'src'), { recursive: true })
writeFileSync(join(MAIN, 'src', 'app.js'), 'export function alpha(x) {\n  return x + 1\n}\n')
writeFileSync(join(MAIN, 'src', 'txn.js'), 'export function txn() {\n  return 1\n}\n')
writeFileSync(join(MAIN, 'package.json'), JSON.stringify({ name: 'wo-005a-fixture', private: true, type: 'module' }, null, 2) + '\n')
runGit(MAIN, 'init', '-q')
runGit(MAIN, 'config', 'user.email', 'wo@local')
runGit(MAIN, 'config', 'user.name', 'wo')
runGit(MAIN, 'add', '-A')
runGit(MAIN, 'commit', '-qm', 'init')
runGit(MAIN, 'worktree', 'add', '-q', '-b', 'attempt', WT, 'HEAD')
assert(existsSync(join(WT, '.git')), '前置：真实 linked worktree 已创建')

const STATE_READ = join(TMP, 'state-read')
const STATE_CTRL = join(TMP, 'state-control')
const STATE_WRITE = join(TMP, 'state-write')
const SKIP = new Set(['.git', '.malong', '.ai-transactions'])
const dirs = gitDirs(WT)
const beforeBiz = walk(WT, SKIP)
const beforeGit = walk(dirs.gitDir)
const beforeCommon = walk(dirs.common)
assert(!existsSync(join(dirs.gitDir, 'info', 'exclude')), '前置：worktree info/exclude 不存在')

// ── ① 005A read path: code_task/query/read/status ──
{
  const s = startServer(WT, STATE_READ, { MALONG_NO_GIT_EXCLUDE: '1' })
  await s.ready()
  const t = await s.call('code_task', { workspace_dir: WT, goal: 'understand alpha', target: { file: 'src/app.js' }, route: 'understand' })
  assert(ok(t), '005A code_task 成功（' + JSON.stringify(t && (t.code || t.error || t.message || 'ok')).slice(0, 120) + '）')
  const taskId = t && (t.task?.task_id || t.task_id)
  assert(typeof taskId === 'string' && taskId.startsWith('task_'), '005A code_task 返回 task_id（' + taskId + '）')
  const q = await s.call('code_query', { workspace_dir: WT, task_id: taskId, mode: 'symbols', query: 'alpha' })
  assert(ok(q), '005A code_query(symbols) 成功')
  const rd = await s.call('code_read', { workspace_dir: WT, task_id: taskId, locator: { file_path: 'src/app.js' } })
  assert(ok(rd) && typeof rd.read_ref === 'string', '005A code_read 成功并返回 read_ref（' + (rd && rd.read_ref) + '）')
  const st = await s.call('code_status', { workspace_dir: WT, task_id: taskId })
  assert(ok(st), '005A code_status 成功')
  await s.close()
}
sameMap(walk(WT, SKIP), beforeBiz, '005A 业务文件哈希不变')
sameMap(walk(dirs.gitDir), beforeGit, '005A worktree git_dir 文件集合/哈希不变')
sameMap(walk(dirs.common), beforeCommon, '005A common_dir 文件集合/哈希不变')
assert(!existsSync(join(dirs.gitDir, 'info', 'exclude')), '005A worktree info/exclude 前后都不存在')
assert(!existsSync(join(WT, '.malong')) && !existsSync(join(WT, '.ai-transactions')), '005A 工作区没有 .malong/.ai-transactions')
{
  const files = Object.keys(walk(STATE_READ))
  assert(files.some(f => f.endsWith('code-index.db')), '005A 索引确实落外置 MALONG_STATE_DIR（code-index.db）')
  assert(files.some(f => f.includes('entry-tasks/')), '005A 任务确实落外置 MALONG_STATE_DIR（entry-tasks/）')
}

// ── ② control: env unset reproduces the historical exclude write ──
{
  const s = startServer(WT, STATE_CTRL, {})
  await s.ready()
  const t = await s.call('code_task', { workspace_dir: WT, goal: 'understand alpha', target: { file: 'src/app.js' }, route: 'understand' })
  assert(ok(t), '对照组 code_task 成功')
  await s.close()
}
{
  const exclude = join(dirs.gitDir, 'info', 'exclude')
  assert(existsSync(exclude), '对照组：env 未设时 info/exclude 被创建（证明开关有效）')
  const text = existsSync(exclude) ? readFileSync(exclude, 'utf-8') : ''
  assert(text.includes('.malong/') && text.includes('.ai-transactions/'), '对照组：exclude 含两条产物目录')
}

// ── ③ 005A write path: journal/backup and .ai-transactions move external ──
const beforeWriteGit = walk(dirs.gitDir)
const beforeWriteCommon = walk(dirs.common)
{
  const s = startServer(WT, STATE_WRITE, { MALONG_NO_GIT_EXCLUDE: '1' })
  await s.ready()
  const t = await s.call('code_task', { workspace_dir: WT, goal: 'edit alpha and txn', target: { file: 'src/app.js' }, route: 'change' })
  assert(ok(t), '005A 写路径 code_task 成功')
  const taskId = t && (t.task?.task_id || t.task_id)
  const rd = await s.call('code_read', { workspace_dir: WT, task_id: taskId, locator: { file_path: 'src/app.js' } })
  assert(ok(rd) && typeof rd.read_ref === 'string', '005A 写路径 code_read 返回 read_ref')
  const patch = await s.call('code_patch', {
    workspace_dir: WT, task_id: taskId, read_ref: rd.read_ref,
    patch: { old_string: 'return x + 1', new_string: 'return x + 2' }, dry_run: false,
  })
  assert(ok(patch), '005A code_patch 实际写入成功')
  assert(readFileSync(join(WT, 'src', 'app.js'), 'utf-8').includes('return x + 2'), '005A code_patch 已改业务文件')
  const reverse = patch && patch.undo && patch.undo.reverse && patch.undo.reverse.backup
  assert(typeof reverse === 'string' && reverse.includes('workspace-artifacts'), '005A undo 提示指向外置备份（' + reverse + '）')

  const b = await s.call('edit_transaction', { workspace_dir: WT, action: 'begin', name: 'wo-005a-external' })
  assert(ok(b) && typeof b.txnId === 'string', '005A edit_transaction begin 成功')
  const txnId = b.txnId
  const e = await s.call('edit_transaction', {
    workspace_dir: WT, action: 'edit', txn_id: txnId, file: 'src/txn.js',
    edits: [{ old_string: 'return 1', new_string: 'return 2' }],
  })
  assert(ok(e), '005A edit_transaction edit 成功')
  const c = await s.call('edit_transaction', { workspace_dir: WT, action: 'commit', txn_id: txnId })
  assert(ok(c), '005A edit_transaction commit 成功')
  assert(readFileSync(join(WT, 'src', 'txn.js'), 'utf-8').includes('return 2'), '005A edit_transaction 已改业务文件')
  const df = await s.call('invoke_capability', { workspace_dir: WT, name: 'diff_facts', args: { workspace_dir: WT, since: 'last_txn' } })
  assert(ok(df) && df.delegated === true, '005A diff_facts 能读取外置 .ai-transactions（' + JSON.stringify(df).slice(0, 160) + '）')
  await s.close()
}
assert(!existsSync(join(WT, '.malong')) && !existsSync(join(WT, '.ai-transactions')), '005A 写路径后工作区仍无 .malong/.ai-transactions')
sameMap(walk(dirs.gitDir), beforeWriteGit, '005A 写路径 worktree git_dir 不变')
sameMap(walk(dirs.common), beforeWriteCommon, '005A 写路径 common_dir 不变')
{
  const files = Object.keys(walk(STATE_WRITE))
  assert(files.some(f => f.includes('workspace-artifacts/') && f.includes('.malong/journal/')), '005A journal 落外置 workspace-artifacts/.malong/journal')
  assert(files.some(f => f.includes('workspace-artifacts/') && f.includes('.ai-transactions/')), '005A 事务状态落外置 workspace-artifacts/.ai-transactions')
}

rmSync(TMP, { recursive: true, force: true })
console.log('')
console.log('== test-no-git-exclude: ' + pass + ' passed, ' + fail + ' failed ==')
process.exit(fail > 0 ? 1 : 0)
