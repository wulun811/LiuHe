// test-ac21-write-conflict.js — 14-C AC21：写入冲突（真双进程 MCP）
// 验收单：两进程同文件同 base 不同目标 → 至多一个基于当前版本的合法写；另一方拒绝或需重读；锁归属正确。
// 阻塞条件：静默最后写覆盖。真实路径：spawn 两个 mcp-server.js（共享 MALONG_STATE_DIR 与工作区）。
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) { if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) } }

const WS = join(os.tmpdir(), 'opencode', 'ac21-ws')
const STATE = join(os.tmpdir(), 'opencode', 'ac21-state')
try { rmSync(WS, { recursive: true, force: true }) } catch {}
try { rmSync(STATE, { recursive: true, force: true }) } catch {}
mkdirSync(join(WS, 'src'), { recursive: true })
process.env.MALONG_STATE_DIR = STATE

const FILE = 'src/conf.js'
const ABS = join(WS, FILE)
const NL = String.fromCharCode(10)
writeFileSync(ABS, 'export function pick() { return 1 }' + NL)
function expected(v) { return 'export function pick() { return ' + v + ' }' + NL }
function content() { return readFileSync(ABS, 'utf-8') }

function server() {
  const proc = spawn(process.execPath, [join(__dirname, '..', 'mcp-server.js'), '--workspace', WS], {
    cwd: WS,
    env: { ...process.env, MALONG_INTERFACE: 'graph', MALONG_ENTRY_STATE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let buf = ''
  const pending = new Map()
  let seq = 0
  proc.stdout.setEncoding('utf-8')
  proc.stdout.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf(NL)) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      let m
      try { m = JSON.parse(line) } catch { continue }
      if (m.id != null && pending.has(m.id)) { const f = pending.get(m.id); pending.delete(m.id); f(m) }
    }
  })
  proc.stderr.on('data', () => {})
  function rpc(method, params, t = 20000) {
    const id = ++seq
    return new Promise((res, rej) => {
      const to = setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)) } }, t)
      pending.set(id, (m) => { clearTimeout(to); res(m) })
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + NL)
    })
  }
  async function call(name, args) {
    // 启动装载期（-32000 'still loading modules'）瞬态错误：等就绪后重试
    for (let attempt = 0; ; attempt++) {
      const r = await rpc('tools/call', { name, arguments: args })
      if (r.error) {
        if (r.error.code === -32000 && /still loading/i.test(String(r.error.message)) && attempt < 20) {
          await new Promise((res) => setTimeout(res, 500))
          continue
        }
        return { ok: false, error: r.error.code, message: r.error.message }
      }
      const text = r.result && r.result.content && r.result.content[0] ? r.result.content[0].text : null
      try { return JSON.parse(text) } catch { return { ok: false, error: 'bad_response' } }
    }
  }
  async function init() {
    await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'ac21', version: '0' } })
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + NL)
  }
  return { call, init, kill: () => { try { proc.kill('SIGKILL') } catch {} } }
}

function committedTxns() {
  const root = join(WS, '.malong', 'journal')
  let n = 0
  try {
    for (const d of readdirSync(root)) {
      try {
        const s = JSON.parse(readFileSync(join(root, d, 'state.json'), 'utf-8'))
        if (s.state !== 'committed' && s.state !== 'committed_recovered') continue
        const m = JSON.parse(readFileSync(join(root, d, 'manifest.json'), 'utf-8'))
        if (m.file === FILE) n++
      } catch {}
    }
  } catch {}
  return n
}
function isActualWrite(r) {
  return !!(r && r.ok === true && r.observation && r.observation.effect === 'workspace_write' && r.observation.committed === true && !r.observation.deduplicated && !r.observation.recovered && !(r.observation.operation && r.observation.operation.already_applied === true))
}
function patch(from, to) { return { old_string: 'return ' + from, new_string: 'return ' + to } }
function currentValue() {
  const parts = content().split('return ')
  return parts.length > 1 ? parts[1].split(' ')[0] : '?'
}
const ALLOWED_LOSER = ['revision_conflict', 'version_conflict', 'VERSION_CONFLICT', 'file_locked', 'FILE_LOCKED', 'state_commit_pending']

const { getTask } = await import(pathToFileURL(join(__dirname, '..', 'tools', 'entry-store.js')).href)
const { acquireLock } = await import(pathToFileURL(join(__dirname, '..', 'write-runtime.js')).href)
const A = server()
const B = server()
await A.init()
await B.init()

const t = await A.call('code_task', { workspace_dir: WS, goal: 'ac21 cross-process write conflict', target: { file: FILE } })
assert(t.ok === true && t.task && typeof t.task.task_id === 'string', '建任务（得 ' + (t.error || 'ok') + '）')
const taskId = t.task.task_id

// ① 同 base 不同目标并发：至多一个合法写，另一个拒绝/需重读
const rd1 = await A.call('code_read', { workspace_dir: WS, task_id: taskId, locator: { file_path: FILE } })
assert(rd1.ok === true && typeof rd1.read_ref === 'string', '读文件得 read_ref')
const baseline = committedTxns()
const ED1 = { workspace_dir: WS, task_id: taskId, read_ref: rd1.read_ref, edit_mode: 'patch', patch: patch(1, 101), dry_run: false, request_id: 'ac21-A' }
const ED2 = { workspace_dir: WS, task_id: taskId, read_ref: rd1.read_ref, edit_mode: 'patch', patch: patch(1, 202), dry_run: false, request_id: 'ac21-B' }
const [x1, y1] = await Promise.all([A.call('code_patch', ED1), B.call('code_patch', ED2)])
const writes1 = [x1, y1].filter(isActualWrite).length
assert(writes1 <= 1, '① 至多一次实际写（得 ' + writes1 + '）')
assert([x1, y1].every((r) => r.ok === true || ALLOWED_LOSER.includes(r.error)), '① 输家可归因（得 ' + JSON.stringify([x1.error || 'ok', y1.error || 'ok']) + '）')
const v1 = currentValue()
assert(v1 === '101' || v1 === '202', '① 文件=某一方的完整目标（得 return ' + v1 + '）')
assert(content() === expected(v1), '① 无叠加/损坏（旧值未残留）')
assert(committedTxns() === baseline + 1, '① 恰 +1 committed 事务（得 +' + (committedTxns() - baseline) + '）')
// 输家按指引重读后合法写（基于当前版本，不覆盖赢家）
const rd2 = await A.call('code_read', { workspace_dir: WS, task_id: taskId, locator: { file_path: FILE } })
const target2 = v1 === '101' ? '202' : '101'
const redo = await (v1 === '101' ? B : A).call('code_patch', { workspace_dir: WS, task_id: taskId, read_ref: rd2.read_ref, edit_mode: 'patch', patch: patch(v1, target2), dry_run: false, request_id: 'ac21-redo' })
assert(redo.ok === true && redo.observation && redo.observation.committed === true, '① 重读后写成功（得 ' + JSON.stringify(redo.error || (redo.observation && redo.observation.summary)) + '）')
assert(content() === expected(target2), '① 重读后内容=新目标')
assert(committedTxns() === baseline + 2, '① 重读写恰 +1 事务（累计 +' + (committedTxns() - baseline) + '）')

// ② 外部编辑穿插（TOCTOU）：stale base 拒绝、外部内容保留、重读后成功
const before2 = committedTxns()
const rd3 = await A.call('code_read', { workspace_dir: WS, task_id: taskId, locator: { file_path: FILE } })
const staleValue = currentValue()
writeFileSync(ABS, 'export function pick() { return 999 }' + NL)
const clash = await A.call('code_patch', { workspace_dir: WS, task_id: taskId, read_ref: rd3.read_ref, edit_mode: 'patch', patch: patch(staleValue, '7'), dry_run: false, request_id: 'ac21-stale' })
assert(clash.ok !== true && clash.error === 'VERSION_CONFLICT', '② stale base → VERSION_CONFLICT（得 ' + clash.error + '）')
assert(content() === expected(999), '② 外部内容保留（未被覆盖）')
assert(committedTxns() === before2, '② 拒绝无副作用（事务数不变）')
const rd4 = await A.call('code_read', { workspace_dir: WS, task_id: taskId, locator: { file_path: FILE } })
const after2 = await A.call('code_patch', { workspace_dir: WS, task_id: taskId, read_ref: rd4.read_ref, edit_mode: 'patch', patch: patch(999, '8'), dry_run: false, request_id: 'ac21-after-ext' })
assert(after2.ok === true && after2.observation && after2.observation.committed === true, '② 重读后合法写成功（得 ' + JSON.stringify(after2.error || (after2.observation && after2.observation.summary)) + '）')
assert(content() === expected(8), '② 内容=重读后的写')
assert(committedTxns() === before2 + 1, '② 重读写恰 +1 事务')

// ③ 锁归属：全部请求结束后无泄漏锁（立即获得）+ 任务事件账无脏终态
let lockOk = false
let lockErr = null
try {
  const lk = await acquireLock(ABS, 1500)
  lockOk = true
  if (lk && lk.release) lk.release()
} catch (e) { lockErr = e && e.code }
assert(lockOk, '③ 无泄漏写锁（acquireLock 立即成功；得 ' + (lockErr || 'ok') + '）')
const task = getTask(WS, taskId)
const ops = (task.operations || []).filter((o) => ['ac21-A', 'ac21-B'].includes(o.request_id))
assert(ops.length >= 1 && ops.length <= 2, '③ 事件账可核对（ops=' + JSON.stringify(ops.map((o) => o.state)) + '）')
assert(ops.every((o) => o.state !== 'succeeded' || o.result_file_hash), '③ succeeded 必带结果哈希')

// ④ H04（0.5.14 复审修复）：连续单文件编辑 → 合批提示可落地；过期锚点仍拒且指引重读（区分重读/合批）
const rd5 = await A.call('code_read', { workspace_dir: WS, task_id: taskId, locator: { file_path: FILE } })
const p4 = await A.call('code_patch', { workspace_dir: WS, task_id: taskId, read_ref: rd5.read_ref, edit_mode: 'patch', patch: patch(8, '9'), dry_run: true, request_id: 'ac21-h04' })
assert(p4.ok === true && typeof p4.batch_hint === 'string' && /ONE code_batch/.test(p4.batch_hint), '④ 连续单文件编辑给出合批提示（得 ' + JSON.stringify(p4.batch_hint || null) + '）')
assert(p4.observation?.dry_run === true && content() === expected(8), '④ 提示不改变预览语义、不落盘')
writeFileSync(ABS, 'export function pick() { return 42 }' + NL)
const stale2 = await A.call('code_patch', { workspace_dir: WS, task_id: taskId, read_ref: rd5.read_ref, edit_mode: 'patch', patch: patch(8, '9'), dry_run: false, request_id: 'ac21-h04-stale' })
assert(stale2.ok !== true && stale2.error === 'VERSION_CONFLICT', '④ 过期锚点仍拒绝（得 ' + stale2.error + '）')
assert(stale2.next_action?.tool === 'code_read', '④ 拒绝回执指引重读（得 ' + JSON.stringify(stale2.next_action?.tool || null) + '）')
assert(typeof stale2.batch_hint === 'string' || Array.isArray(stale2.next_actions), '④ 拒绝回执同时保留合批/结构化可用信息')

A.kill()
B.kill()
console.log('== test-ac21-write-conflict: ' + pass + ' passed, ' + fail + ' failed ==')
if (fail > 0) process.exit(1)