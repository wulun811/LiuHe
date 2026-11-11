// test-readonly-mode.js — LH-WO-005B regression (MCP stdio, direct calls bypassing any host guard).
//
// MALONG_READONLY=1 must reject workspace/git/command effects BEFORE a handler can
// create a backup, journal, task operation, or write a business file. Read paths and
// state-only/cleanup actions stay available. This test calls tools/call directly.
import { spawn, execFileSync } from 'node:child_process'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, lstatSync } from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MALONG = join(__dirname, '..')
const TMP = join(os.tmpdir(), 'opencode', 'readonly-mode')
const WS = join(TMP, 'ws')
const STATE = join(TMP, 'state')
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
function norm(map) { return Object.keys(map).sort().map(k => k + '=' + map[k]).join('\n') }
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
    // 中立 cwd：防止懒启动的 malong-parse 守护进程继承工作区，Windows 上锁住 rmSync(ws)。
    stdio: ['pipe', 'pipe', 'pipe'], cwd: os.tmpdir(), env,
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
      if (p) { clearTimeout(p.timer); pending.delete(msg.id); p.resolve(msg) }
    }
  })
  child.stderr.on('data', () => {})
  child.on('exit', () => {
    exited = true
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('server exited')) }
    pending.clear()
  })
  function rpc(method, params, timeoutMs = 60000) {
    if (exited) return Promise.reject(new Error('server exited'))
    const id = ++seq
    return new Promise((resolveP, rejectP) => {
      const timer = setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); rejectP(new Error('timeout waiting for ' + method)) }
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
    await rpcRetry('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'wo-005b', version: '0' } }, 15000)
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
function readonly(r, tool, action) {
  const base = !!r && !r._rpcError && r.ok === false && r.code === 'readonly_mode' && r.error === 'readonly_mode' && r.readonly_mode === true && r.tool === tool
  if (!base) return false
  return action == null ? true : r.action === action
}
function rejected(label, r, tool, action) {
  assert(readonly(r, tool, action), label + ' → readonly_mode' + (readonly(r, tool, action) ? '' : '（实际 ' + JSON.stringify(r).slice(0, 260) + '）'))
}
function findTaskFile(taskId) {
  const root = join(STATE, 'entry-tasks')
  if (!existsSync(root)) return null
  for (const d of readdirSync(root)) {
    const p = join(root, d, taskId + '.json')
    if (existsSync(p)) return p
  }
  return null
}

// ── fixture: real git repo (so a missing gate would show up in .git/info/exclude) ──
rmSync(TMP, { recursive: true, force: true })
mkdirSync(join(WS, 'src'), { recursive: true })
writeFileSync(join(WS, 'src', 'app.js'), 'export function alpha(x) {\n  return x + 1\n}\n')
writeFileSync(join(WS, 'package.json'), JSON.stringify({ name: 'wo-005b-fixture', private: true, type: 'module' }, null, 2) + '\n')
runGit(WS, 'init', '-q')
runGit(WS, 'config', 'user.email', 'wo@local')
runGit(WS, 'config', 'user.name', 'wo')
runGit(WS, 'add', '-A')
runGit(WS, 'commit', '-qm', 'init')
const dirs = gitDirs(WS)
const beforeBiz = walk(WS, new Set(['.git', '.malong', '.ai-transactions']))
const beforeGit = walk(dirs.gitDir)
const beforeCommon = walk(dirs.common)
const excludeFile = join(dirs.gitDir, 'info', 'exclude')
const excludeBefore = existsSync(excludeFile) ? readFileSync(excludeFile, 'hex') : null
assert(excludeBefore !== null, '前置：git init 的 info/exclude 已存在（后续只比对字节）')

const s = startServer(WS, STATE, { MALONG_READONLY: '1' })
await s.ready()

// ── read paths and state-only previews stay available ──
const t = await s.call('code_task', { workspace_dir: WS, goal: 'understand alpha', target: { file: 'src/app.js' }, route: 'understand' })
assert(ok(t), 'readonly: code_task 可用')
const taskId = t && (t.task?.task_id || t.task_id)
assert(typeof taskId === 'string' && taskId.startsWith('task_'), 'readonly: code_task 返回 task_id（' + taskId + '）')
const q = await s.call('code_query', { workspace_dir: WS, task_id: taskId, mode: 'symbols', query: 'alpha' })
assert(ok(q), 'readonly: code_query(symbols) 可用')
const rd = await s.call('code_read', { workspace_dir: WS, task_id: taskId, locator: { file_path: 'src/app.js' } })
assert(ok(rd) && typeof rd.read_ref === 'string', 'readonly: code_read 可用并返回 read_ref（' + (rd && rd.read_ref) + '）')
const st = await s.call('code_status', { workspace_dir: WS, task_id: taskId })
assert(ok(st), 'readonly: code_status 可用')
const ctrlStatus = await s.call('code_control', { workspace_dir: WS, task_id: taskId, action: 'status' })
assert(ok(ctrlStatus), 'readonly: code_control(status) 可用')
const checkPreview = await s.call('code_check', { workspace_dir: WS, task_id: taskId, run: false, checks: ['test'] })
assert(ok(checkPreview) && checkPreview.observation?.dry_run === true, 'readonly: code_check(run=false) 预览可用')
const maintPlan = await s.call('code_maintain', { workspace_dir: WS, task_id: taskId, action: 'plan' })
assert(ok(maintPlan), 'readonly: code_maintain(plan) 可用')
const wtPreview = await s.call('code_worktree', {
  workspace_dir: WS, task_id: taskId, action: 'preview',
  changes: [{ path: 'src/app.js', new_content: 'export function alpha(x) { return x + 9 }\n' }],
})
assert(ok(wtPreview), 'readonly: code_worktree(preview) 可用')
const health = await s.call('invoke_capability', { workspace_dir: WS, name: 'health', args: { action: 'check' } })
assert(ok(health) && health.delegated === true, 'readonly: invoke_capability(health/check) 仅 state 写可用')

// Snapshot task operations after all allowed previews. Rejected writes must not add one.
const taskFile = findTaskFile(taskId)
const opsBefore = taskFile ? (JSON.parse(readFileSync(taskFile, 'utf-8')).operations || []).length : -1
assert(taskFile && opsBefore >= 0, 'readonly: 任务账本可读取（operations=' + opsBefore + '）')

// ── all direct write entry points reject atomically ──
const patch = await s.call('code_patch', {
  workspace_dir: WS, task_id: taskId, read_ref: rd.read_ref,
  patch: { old_string: 'return x + 1', new_string: 'return x + 99' }, dry_run: false,
})
rejected('code_patch(dry_run=false)', patch, 'code_patch', 'apply')

const batch = await s.call('code_batch', {
  workspace_dir: WS, task_id: taskId,
  writes: [{ read_ref: rd.read_ref, patch: { old_string: 'return x + 1', new_string: 'return x + 99' } }],
  dry_run: false,
})
rejected('code_batch(dry_run=false)', batch, 'code_batch', 'apply')

const maintain = await s.call('code_maintain', { workspace_dir: WS, task_id: taskId, action: 'apply', dry_run: false })
rejected('code_maintain(apply)', maintain, 'code_maintain', 'apply')

const wtApply = await s.call('code_worktree', {
  workspace_dir: WS, task_id: taskId, action: 'apply', dry_run: false,
  changes: [{ path: 'src/app.js', new_content: 'export function alpha(x) { return x + 9 }\n' }],
})
rejected('code_worktree(apply)', wtApply, 'code_worktree', 'apply')

const txn = await s.call('edit_transaction', { workspace_dir: WS, action: 'commit', txn_id: 'txn_999999999999_deadbeef_p0' })
rejected('edit_transaction(commit)', txn, 'edit_transaction', 'commit')

const checkRun = await s.call('code_check', { workspace_dir: WS, task_id: taskId, run: true, checks: ['test'] })
rejected('code_check(run=true)', checkRun, 'code_check', 'run')

const resume = await s.call('code_control', { workspace_dir: WS, task_id: taskId, action: 'resume' })
rejected('code_control(resume)', resume, 'code_control', 'resume')
const reopen = await s.call('code_control', { workspace_dir: WS, task_id: taskId, action: 'reopen' })
rejected('code_control(reopen)', reopen, 'code_control', 'reopen')
const expand = await s.call('code_control', { workspace_dir: WS, task_id: taskId, action: 'expand', ref: 'candidates' })
rejected('code_control(expand)', expand, 'code_control', 'expand')

const capWrite = await s.call('invoke_capability', {
  workspace_dir: WS, name: 'write_symbol',
  args: { workspace_dir: WS, locator: { file_path: 'src/app.js' }, content: 'export function alpha() { return 0 }\n', create: false },
})
rejected('invoke_capability(write_symbol)', capWrite, 'write_symbol', null)
const capBatch = await s.call('invoke_capability', {
  workspace_dir: WS, name: 'edit_batch',
  args: { workspace_dir: WS, edits: [{ file: 'src/app.js', old_string: 'return x + 1', new_string: 'return x + 99' }] },
})
rejected('invoke_capability(edit_batch)', capBatch, 'edit_batch', null)
const capGit = await s.call('invoke_capability', { workspace_dir: WS, name: 'git_worktree', args: { workspace_dir: WS, action: 'list' } })
rejected('invoke_capability(git_worktree)', capGit, 'git_worktree', null)
const validate = await s.call('code_query', { workspace_dir: WS, task_id: taskId, mode: 'validate', file: 'src/app.js', new_content: 'export function alpha() { return 0 }\n' })
rejected('code_query(validate)', validate, 'code_query', 'validate')

// ── cancel is state-only and must still work ──
const cancelled = await s.call('code_control', { workspace_dir: WS, task_id: taskId, action: 'cancel', reason: '005B acceptance cleanup' })
assert(ok(cancelled) && cancelled.observation?.cancelled === true, 'readonly: code_control(cancel) 仍可用（仅 state）')

const taskAfter = findTaskFile(taskId)
const opsAfter = taskAfter ? (JSON.parse(readFileSync(taskAfter, 'utf-8')).operations || []).length : -1
assert(opsAfter === opsBefore, 'readonly: 被拒写入没有新增 task operation（before=' + opsBefore + ', after=' + opsAfter + '）')
assert(!existsSync(join(WS, '.malong')) && !existsSync(join(WS, '.ai-transactions')), 'readonly: 工作区无 .malong/.ai-transactions')
assert(norm(walk(WS, new Set(['.git', '.malong', '.ai-transactions']))) === norm(beforeBiz), 'readonly: 业务文件哈希不变')
assert(norm(walk(dirs.gitDir)) === norm(beforeGit), 'readonly: worktree git_dir 不变')
assert(norm(walk(dirs.common)) === norm(beforeCommon), 'readonly: common_dir 不变')
const excludeAfter = existsSync(excludeFile) ? readFileSync(excludeFile, 'hex') : null
assert(excludeAfter === excludeBefore, 'readonly: info/exclude 字节不变（没有追加 .malong/.ai-transactions）')
{
  const files = Object.keys(walk(STATE))
  assert(files.some(f => f.endsWith('code-index.db')), 'readonly: 索引落外置 MALONG_STATE_DIR')
  assert(files.some(f => f.includes('entry-tasks/')), 'readonly: 任务落外置 MALONG_STATE_DIR')
}
await s.close()
rmSync(TMP, { recursive: true, force: true })
console.log('')
console.log('== test-readonly-mode: ' + pass + ' passed, ' + fail + ' failed ==')
process.exit(fail > 0 ? 1 : 0)
