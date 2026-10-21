// test-ac27-crash-window.js — 14-C AC27：写后提交前真崩溃（真双进程 + 真 SIGKILL）
// 验收单：准备记录与 backup 可核对；实际改文件后、成功事件写入前真实杀服务；重启重复同 request_id。
// 必须：先核对现实/意图/身份链；不报未执行；不做第二次未经核对写；不覆盖外部修改；依据不足 indeterminate。
// 故障注入：MALONG_TEST_KILL_AFTER_WRITE=1（仅测试 env；隔离临时工作区），SIGKILL 真终止服务进程。
import { spawn } from 'node:child_process'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) { if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) } }

const WS = join(os.tmpdir(), 'opencode', 'ac27-ws')
const STATE = join(os.tmpdir(), 'opencode', 'ac27-state')
try { rmSync(WS, { recursive: true, force: true }) } catch {}
try { rmSync(STATE, { recursive: true, force: true }) } catch {}
mkdirSync(join(WS, 'src'), { recursive: true })
process.env.MALONG_STATE_DIR = STATE

const FILE = 'src/t.js'
const ABS = join(WS, FILE)
const NL = String.fromCharCode(10)
writeFileSync(ABS, 'export function one() { return 1 }' + NL)
function expected(v) { return 'export function one() { return ' + v + ' }' + NL }
function content() { return readFileSync(ABS, 'utf-8') }

function server(killAfterWrite = false) {
  const env = { ...process.env, MALONG_INTERFACE: 'graph', MALONG_ENTRY_STATE: '1' }
  if (killAfterWrite) env.MALONG_TEST_KILL_AFTER_WRITE = '1'
  const proc = spawn(process.execPath, [join(__dirname, '..', 'mcp-server.js'), '--workspace', WS], {
    cwd: WS, env, stdio: ['pipe', 'pipe', 'pipe'],
  })
  let buf = ''
  let exited = false
  const pending = new Map()
  const timers = new Set()
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
      if (m.id != null && pending.has(m.id)) { const f = pending.get(m.id); pending.delete(m.id); f.resolve(m) }
    }
  })
  proc.stderr.on('data', () => {})
  proc.on('exit', () => {
    exited = true
    for (const f of pending.values()) f.reject(new Error('server_exited'))
    pending.clear()
    for (const t of timers) clearTimeout(t)
    timers.clear()
  })
  function rpc(method, params, t = 20000) {
    const id = ++seq
    return new Promise((resolve, reject) => {
      if (exited) return reject(new Error('server_exited'))
      const to = setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout ' + method)) } }, t)
      timers.add(to)
      pending.set(id, { resolve: (m) => { clearTimeout(to); timers.delete(to); resolve(m) }, reject })
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + NL)
    })
  }
  async function call(name, args) {
    // 启动装载期（-32000 'still loading modules'）瞬态错误：等就绪后重试
    for (let attempt = 0; ; attempt++) {
      try {
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
      } catch (e) {
        if (exited || attempt >= 20 || /server_exited/.test(String(e && e.message))) throw e
        await new Promise((res) => setTimeout(res, 500))
      }
    }
  }
  async function init() {
    await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'ac27', version: '0' } })
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + NL)
  }
  return {
    proc, call, init,
    exited: () => exited,
    waitExit: () => new Promise((r) => { if (exited) r(); else proc.once('exit', r) }),
    kill: () => { try { proc.kill('SIGKILL') } catch {} },
  }
}

function journalTxns() {
  const root = join(WS, '.malong', 'journal')
  const dirs = []
  try {
    for (const d of readdirSync(root)) {
      try {
        const s = JSON.parse(readFileSync(join(root, d, 'state.json'), 'utf-8'))
        if (s.state !== 'committed' && s.state !== 'committed_recovered') continue
        const m = JSON.parse(readFileSync(join(root, d, 'manifest.json'), 'utf-8'))
        if (m.file === FILE) dirs.push(join(root, d))
      } catch {}
    }
  } catch {}
  return dirs
}
function patch(from, to) { return { old_string: 'return ' + from, new_string: 'return ' + to } }

const { getTask } = await import(pathToFileURL(join(__dirname, '..', 'tools', 'entry-store.js')).href)
function opsFor(taskId, rid) { return (getTask(WS, taskId).operations || []).filter((o) => o.request_id === rid) }

// 起任务 + 首读
const A = server(true)
await A.init()
const t = await A.call('code_task', { workspace_dir: WS, goal: 'change one() return value', target: { file: FILE } })
assert(t.ok === true && t.task && typeof t.task.task_id === 'string', '建任务（得 ' + (t.error || 'ok') + '）')
const taskId = t.task.task_id
const rd1 = await A.call('code_read', { workspace_dir: WS, task_id: taskId, locator: { file_path: FILE } })
assert(rd1.ok === true && typeof rd1.read_ref === 'string', '读文件得 read_ref')

// ── A 写后提交前杀服务 → 重启同 request_id 核对恢复 ──
const R1 = { workspace_dir: WS, task_id: taskId, read_ref: rd1.read_ref, edit_mode: 'patch', patch: patch(1, 2), dry_run: false, request_id: 'ac27-R1' }
A.call('code_patch', R1).catch(() => {})
await A.waitExit()
assert(A.exited() === true, 'A 服务进程被 SIGKILL 终止（真终止，非抛异常模拟）')
assert(content() === expected(2), 'A 崩溃后文件已是写后内容（写确实发生）')
assert(journalTxns().length === 1, 'A 崩溃后恰 1 个 committed 事务（准备记录+backup 可核对）')
const prepared1 = opsFor(taskId, 'ac27-R1')
assert(prepared1.length === 1 && prepared1[0].state === 'prepared' && prepared1[0].intended_file_hash, '任务事件账：prepared + intended 意图可见（成功事件未落盘）')

const B = server(false)
await B.init()
const r1 = await B.call('code_patch', R1)
assert(r1.ok === true && r1.observation && r1.observation.recovered === true && r1.observation.deduplicated === true, '重启同 request_id → recovered（不报未执行，得 ' + JSON.stringify(r1.error || (r1.observation && r1.observation.summary)) + '）')
assert(r1.observation.operation && r1.observation.operation.operation_id === prepared1[0].operation_id, '身份链：恢复收口同一 operation_id')
assert(r1.observation.operation && r1.observation.operation.state === 'succeeded', '恢复后 op=succeeded')
assert(content() === expected(2), '恢复不做第二次写（内容不变）')
assert(journalTxns().length === 1, '恢复不新增事务（无未经核对的重写）')
const r1b = await B.call('code_patch', R1)
assert(r1b.ok === true && r1b.observation && r1b.observation.deduplicated === true, '收口后重复 → 纯 dedup')
const r1c = await B.call('code_patch', { ...R1, patch: patch(2, 44) })
assert(r1c.ok !== true && r1c.error === 'request_conflict', '同 request_id 异载荷即使崩溃后也拒绝（得 ' + r1c.error + '）')

// ── B 崩溃期间外部改文件 → indeterminate，不覆盖 ──
const A2 = server(true)
await A2.init()
const rd2 = await A2.call('code_read', { workspace_dir: WS, task_id: taskId, locator: { file_path: FILE } })
const R2 = { workspace_dir: WS, task_id: taskId, read_ref: rd2.read_ref, edit_mode: 'patch', patch: patch(2, 3), dry_run: false, request_id: 'ac27-R2' }
A2.call('code_patch', R2).catch(() => {})
await A2.waitExit()
assert(content() === expected(3), '第二轮：崩溃后文件=写后内容')
const txnsB = journalTxns().length
writeFileSync(ABS, expected(999))
const r2 = await B.call('code_patch', R2)
assert(r2.ok !== true && r2.error === 'indeterminate', '外部改文件 → indeterminate（得 ' + r2.error + '）')
assert(content() === expected(999), '外部修改未被覆盖')
assert(journalTxns().length === txnsB, 'indeterminate 无副作用')
const rd2b = await B.call('code_read', { workspace_dir: WS, task_id: taskId, locator: { file_path: FILE } })
const r2b = await B.call('code_patch', { workspace_dir: WS, task_id: taskId, read_ref: rd2b.read_ref, edit_mode: 'patch', patch: patch(999, 4), dry_run: false, request_id: 'ac27-R2b' })
assert(r2b.ok === true && r2b.observation && r2b.observation.committed === true, '重读后新 request_id 合法写成功（得 ' + JSON.stringify(r2b.error || (r2b.observation && r2b.observation.summary)) + '）')
assert(content() === expected(4), '重读后内容正确')

// ── C 崩溃 + 恢复资产缺失（backup 删除）→ 意图+现实匹配可收口，不假称 undo ──
const beforeC = journalTxns().length
const A3 = server(true)
await A3.init()
const rd3 = await A3.call('code_read', { workspace_dir: WS, task_id: taskId, locator: { file_path: FILE } })
const R3 = { workspace_dir: WS, task_id: taskId, read_ref: rd3.read_ref, edit_mode: 'patch', patch: patch(4, 5), dry_run: false, request_id: 'ac27-R3' }
A3.call('code_patch', R3).catch(() => {})
await A3.waitExit()
assert(content() === expected(5), '第三轮：崩溃后文件=写后内容')
const txnsC = journalTxns()
assert(txnsC.length === beforeC + 1, '第三轮后事务数 +1（得 +' + (txnsC.length - beforeC) + '）')
const lastTxn = txnsC.sort().slice(-1)[0]
const backupPath = join(lastTxn, 'backup', basename(FILE))
assert(existsSync(backupPath), 'backup 资产就位（可核对）')
try { rmSync(backupPath, { force: true }) } catch {}
const r3 = await B.call('code_patch', R3)
assert(r3.ok === true && r3.observation && r3.observation.recovered === true, '资产缺失但意图+现实可核对 → 仍恢复收口（得 ' + JSON.stringify(r3.error || (r3.observation && r3.observation.summary)) + '）')
assert(content() === expected(5), '资产缺失恢复不做第二次写')
assert(journalTxns().length === beforeC + 1, '资产缺失恢复不新增事务')
assert(!(r3.extra && r3.extra.undo), '不假称 undo 可用（响应无 undo 令牌）')

A.kill()
B.kill()
console.log('== test-ac27-crash-window: ' + pass + ' passed, ' + fail + ' failed ==')
if (fail > 0) process.exit(1)