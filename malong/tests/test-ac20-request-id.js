// test-ac20-request-id.js — 14-C AC20：同请求并发（真双进程 MCP）
// 验收单：两进程同ID同载荷 → 同载荷只一副作用、重复得到同身份事实；同ID异载荷 → conflict。
// 真实路径：spawn 两个 mcp-server.js（共享 MALONG_STATE_DIR 与工作区），换行分隔 JSON-RPC over stdio。
// 副作数口径：写链每次落盘一个 committed journal 事务（manifest.file 命中）+ 文件内容双计数。
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) { if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) } }

const WS = join(os.tmpdir(), 'opencode', 'ac20-ws')
const STATE = join(os.tmpdir(), 'opencode', 'ac20-state')
try { rmSync(WS, { recursive: true, force: true }) } catch {}
try { rmSync(STATE, { recursive: true, force: true }) } catch {}
mkdirSync(join(WS, 'src'), { recursive: true })
process.env.MALONG_STATE_DIR = STATE

const FILE = 'src/app.js'
const ABS = join(WS, FILE)
const NL = String.fromCharCode(10)
writeFileSync(ABS, 'export function alpha(a) { return a }' + NL + 'export function beta() { return 2 }' + NL)
function expected(v) { return 'export function alpha(a) { return a }' + NL + 'export function beta() { return ' + v + ' }' + NL }
function content() { return readFileSync(ABS, 'utf-8') }

function server(extraEnv = {}) {
  const proc = spawn(process.execPath, [join(__dirname, '..', 'mcp-server.js'), '--workspace', WS], {
    cwd: WS,
    env: { ...process.env, MALONG_INTERFACE: 'graph', MALONG_ENTRY_STATE: '1', ...extraEnv },
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
    await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'ac20', version: '0' } })
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
const ALLOWED_LOSER = ['revision_conflict', 'version_conflict', 'VERSION_CONFLICT', 'file_locked', 'FILE_LOCKED', 'state_commit_pending']
// 15-D（专家 621f6f8 §4.4）：同请求并发输家不得被误指「外部变化」引导换 read_ref；
// 允许 dedup/recovered/同请求在途可重试/可归因拒绝；禁止 VERSION_CONFLICT+FILE_CHANGED 且无同请求归因。
const misleadingLoser = (r) => !!(r && r.error === 'VERSION_CONFLICT' && r.conflict_type === 'FILE_CHANGED' && !r.recovered && !r.deduplicated && !r.same_request_in_flight)

const { getTask } = await import(pathToFileURL(join(__dirname, '..', 'tools', 'entry-store.js')).href)
const A = server()
const B = server()
await A.init()
await B.init()

const t = await A.call('code_task', { workspace_dir: WS, goal: 'ac20 cross-process request idempotency', target: { file: FILE } })
assert(t.ok === true && t.task && typeof t.task.task_id === 'string', '建任务（得 ' + (t.error || 'ok') + '）')
const taskId = t.task.task_id
const rd1 = await A.call('code_read', { workspace_dir: WS, task_id: taskId, locator: { file_path: FILE } })
assert(rd1.ok === true && typeof rd1.read_ref === 'string', '读文件得 read_ref')

// ① 跨进程同 id 同载荷（B 先写，A 后重复）
const R1 = { workspace_dir: WS, task_id: taskId, read_ref: rd1.read_ref, edit_mode: 'patch', patch: patch(2, 3), dry_run: false, request_id: 'ac20-R1' }
const w1 = await B.call('code_patch', R1)
assert(isActualWrite(w1), '① B 首写=唯一副作用（得 ' + JSON.stringify(w1.error || (w1.observation && w1.observation.committed)) + '）')
const op1 = w1.observation && w1.observation.operation ? w1.observation.operation.operation_id : null
assert(content() === expected(3), '① 文件内容 ' + JSON.stringify(expected(3)))
assert(committedTxns() === 1, '① 恰好 1 个 committed 事务（得 ' + committedTxns() + '）')
const d1 = await A.call('code_patch', R1)
assert(d1.ok === true && d1.observation && d1.observation.deduplicated === true, '① A 跨进程重复 → dedup（得 ' + JSON.stringify(d1.error || (d1.observation && d1.observation.summary)) + '）')
assert(d1.observation.operation && d1.observation.operation.operation_id === op1, '① 重复得到同身份 operation_id')
assert(content() === expected(3) && committedTxns() === 1, '① 重复无第二次副作用')

// ② 跨进程同 id 异载荷 → request_conflict
const c2 = await A.call('code_patch', { workspace_dir: WS, task_id: taskId, read_ref: rd1.read_ref, edit_mode: 'patch', patch: patch(3, 4), dry_run: false, request_id: 'ac20-R1' })
assert(c2.ok !== true && c2.error === 'request_conflict', '② 同 id 异载荷 → request_conflict（得 ' + c2.error + '）')
assert(content() === expected(3) && !content().includes('return 4'), '② 冲突载荷未落盘')

// ③ 错峰并发同 id 同载荷（B 延迟 150ms）：输家可归因拒绝，重试收敛同身份
const rd3 = await B.call('code_read', { workspace_dir: WS, task_id: taskId, locator: { file_path: FILE } })
const R3 = { workspace_dir: WS, task_id: taskId, read_ref: rd3.read_ref, edit_mode: 'patch', patch: patch(3, 5), dry_run: false, request_id: 'ac20-R3' }
const [wA, wB] = await Promise.all([
  A.call('code_patch', R3),
  new Promise((r) => setTimeout(r, 150)).then(() => B.call('code_patch', R3)),
])
const writes3 = [wA, wB].filter(isActualWrite).length
assert(writes3 <= 1, '③ 错峰并发至多一次实际写（得 ' + writes3 + '）')
assert(wA.ok === true || ALLOWED_LOSER.includes(wA.error), '③ A 可归因（得 ' + (wA.error || 'ok') + '）')
assert(wB.ok === true || ALLOWED_LOSER.includes(wB.error), '③ B 可归因（得 ' + (wB.error || 'ok') + '）')
assert(content() === expected(5), '③ 文件内容=唯一成功写')
assert(committedTxns() === 2, '③ 累计 2 个 committed 事务（得 ' + committedTxns() + '）')
const r3 = await B.call('code_patch', R3)
assert(r3.ok === true && (r3.observation.deduplicated === true || r3.observation.recovered === true), '③ 重试收敛（得 ' + JSON.stringify(r3.error || (r3.observation && r3.observation.summary)) + '）')
assert(content() === expected(5) && committedTxns() === 2, '③ 重试不产生新副作用')
const t3 = getTask(WS, taskId)
const ops3 = (t3.operations || []).filter((o) => o.request_id === 'ac20-R3')
const succ3 = ops3.filter((o) => o.state === 'succeeded')
assert(succ3.length === 1, '③ 事件账 R3 恰好 1 个 succeeded（得 ' + JSON.stringify(ops3.map((o) => o.state)) + '）')
assert(r3.observation.operation && r3.observation.operation.operation_id === succ3[0].operation_id, '③ 收敛身份=事件账 succeeded 身份')
assert(!misleadingLoser(wA) && !misleadingLoser(wB), '③ 15-D 无「外部变化」误导（得 A=' + JSON.stringify({ e: wA.error, c: wA.conflict_type, in: wA.same_request_in_flight }) + ' B=' + JSON.stringify({ e: wB.error, c: wB.conflict_type }) + '）')

// ④ 同时并发同 id 同载荷 ×2 轮：安全不变量（≤1 写/轮 + 重试收敛）
const pairs = [[5, 6, 'ac20-R4'], [6, 7, 'ac20-R5']]
for (const [from, to, rid] of pairs) {
  const rd = await A.call('code_read', { workspace_dir: WS, task_id: taskId, locator: { file_path: FILE } })
  const args = { workspace_dir: WS, task_id: taskId, read_ref: rd.read_ref, edit_mode: 'patch', patch: patch(from, to), dry_run: false, request_id: rid }
  const before = committedTxns()
  const [x, y] = await Promise.all([A.call('code_patch', args), B.call('code_patch', args)])
  const n = [x, y].filter(isActualWrite).length
  assert(n <= 1, '④ ' + rid + ' 至多一次实际写（得 ' + n + '）')
  assert([x, y].every((r) => r.ok === true || ALLOWED_LOSER.includes(r.error)), '④ ' + rid + ' 输家可归因（得 ' + JSON.stringify([x.error || 'ok', y.error || 'ok']) + '）')
  assert(!misleadingLoser(x) && !misleadingLoser(y), '④ ' + rid + ' 15-D 无「外部变化」误导（得 ' + JSON.stringify([{ e: x.error, c: x.conflict_type }, { e: y.error, c: y.conflict_type }]) + '）')
  assert(content() === expected(to), '④ ' + rid + ' 文件内容=唯一成功写')
  assert(committedTxns() === before + 1, '④ ' + rid + ' 恰 +1 committed 事务（得 +' + (committedTxns() - before) + '）')
  const rt = await A.call('code_patch', args)
  assert(rt.ok === true && (rt.observation.deduplicated === true || rt.observation.recovered === true), '④ ' + rid + ' 重试收敛（得 ' + JSON.stringify(rt.error || (rt.observation && rt.observation.summary)) + '）')
  assert(committedTxns() === before + 1, '④ ' + rid + ' 重试无新副作用')
}

// ⑤ 15-E 预校验错峰窗口（确定性）：闸门把 C 冻结在 dry-run 之前——其任务快照早于 A 的 prepared/succeeded，
// A 完成后放行：输家必须在预校验分支归因为 dedup（同身份），不得报 FILE_CHANGED 引导换 read_ref。
const GATE = join(os.tmpdir(), 'opencode', 'ac20-preval-gate-' + process.pid)
try { rmSync(GATE, { force: true }) } catch {}
try { rmSync(GATE + '.reached', { force: true }) } catch {}
const C = server({ MALONG_TEST_PREVALIDATE_GATE: GATE })
await C.init()
const rd6 = await A.call('code_read', { workspace_dir: WS, task_id: taskId, locator: { file_path: FILE } })
const R6 = { workspace_dir: WS, task_id: taskId, read_ref: rd6.read_ref, edit_mode: 'patch', patch: patch(7, 8), dry_run: false, request_id: 'ac20-R6' }
const before6 = committedTxns()
const cPromise = C.call('code_patch', R6)
let reached = false
for (let i = 0; i < 200; i++) {
  if (existsSync(GATE + '.reached')) { reached = true; break }
  await new Promise((r) => setTimeout(r, 25))
}
assert(reached, '⑤ C 到达预校验闸门（快照早于并发提交）')
const w6 = await A.call('code_patch', R6)
assert(isActualWrite(w6), '⑤ A 完整成功（得 ' + JSON.stringify(w6.error || (w6.observation && w6.observation.committed)) + '）')
writeFileSync(GATE, '')
const l6 = await cPromise
assert(l6.ok === true && l6.observation && l6.observation.deduplicated === true, '⑤ 预校验错峰输家 → dedup 归因（得 ' + JSON.stringify(l6.error || (l6.observation && l6.observation.summary)) + '）')
assert(!misleadingLoser(l6), '⑤ 15-E 无「外部变化」误导（得 ' + JSON.stringify({ e: l6.error, c: l6.conflict_type }) + '）')
assert(l6.observation.operation && w6.observation.operation && l6.observation.operation.operation_id === w6.observation.operation.operation_id, '⑤ 收敛身份=A 成功方 operation_id')
assert(content() === expected(8) && committedTxns() === before6 + 1, '⑤ 无第二次副作用（得 txn=' + committedTxns() + '）')
const t6 = getTask(WS, taskId)
const ops6 = (t6.operations || []).filter((o) => o.request_id === 'ac20-R6')
assert(ops6.length === 1 && ops6[0].state === 'succeeded', '⑤ 事件账 R6 恰 1 个 succeeded（得 ' + JSON.stringify(ops6.map((o) => o.state)) + '）')
C.kill()

// ⑥ 事件账终检：每个 request_id 恰好一个 succeeded 身份
const fin = getTask(WS, taskId)
for (const rid of ['ac20-R1', 'ac20-R4', 'ac20-R5', 'ac20-R6']) {
  const ops = (fin.operations || []).filter((o) => o.request_id === rid)
  assert(ops.filter((o) => o.state === 'succeeded').length === 1, '⑤ ' + rid + ' 恰好 1 个 succeeded（得 ' + JSON.stringify(ops.map((o) => o.state)) + '）')
}

A.kill()
B.kill()
console.log('== test-ac20-request-id: ' + pass + ' passed, ' + fail + ' failed ==')
if (fail > 0) process.exit(1)