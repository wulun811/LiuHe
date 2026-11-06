#!/usr/bin/env node
// acceptance-crash-boundary.mjs — 崩溃/强杀边界实测（专家 R16q §5.4）
//
// 只测真实进程与真实磁盘，不用模拟：
//   A. 索引进行中 kill -9 → 重启后：库可用、能重建、文件未被改
//   B. 写入进行中 kill -9 → 重启后：文件要么是旧内容、要么是新内容，绝不撕裂
//
// 明确不宣称的：
//   - 不宣称掉电（power loss）安全：这里没有 fsync 级验证，只做进程级 SIGKILL
//   - 不宣称多进程并发写安全：本测试是单进程
//
// 每个用例都标注它实际杀在哪个窗口，不把「SIGKILL 通过」当成覆盖所有窗口：
//   ── before_request   杀在请求发出之前（只验证重启可用）
//   ── during_request   请求已写入 stdin、响应未回（锚点确定，不靠 sleep 赌时序）
//   ── during_write     写入事务已落盘、成功事件未提交（MALONG_TEST_KILL_AFTER_WRITE 屏障）
//   ── after_response   成功响应已收到（事后窗口）
//
// 明确不宣称的：
//   - 不宣称掉电（power loss）安全：这里没有 fsync 级验证，只做进程级 SIGKILL
//   - 不宣称多进程并发写安全：本测试是单进程
//   - 不宣称覆盖所有崩溃窗口：窗口清单见上，未列出的即未测
//
// 用法：node scripts/acceptance-crash-boundary.mjs --server <mcp-server.js> [--parse-bin <bin>] [--workdir <尚不存在的目录>] [--json]
// 退出码：0 全通过 / 1 有失败 / 2 环境问题或 --workdir 被拒
//
// --workdir 语义（R20-F01）：只能指向【事先不存在】的路径；脚本会删除自己的测试根目录，
// 因此永不接管、永不删除既有目录。

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { prepareWorkdirOrExit } from './acceptance-workdir.mjs'

const argv = process.argv.slice(2)
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }
const SERVER = arg('--server')
const PARSE_BIN = arg('--parse-bin')
const AS_JSON = argv.includes('--json')
if (!SERVER || !existsSync(SERVER)) { console.error('缺少 --server'); process.exit(2) }

// R20-F01：拒绝接管既有目录
const prepared = prepareWorkdirOrExit(arg('--workdir'), 'crash-')
if (!prepared.ok) process.exit(prepared.code)
const ROOT = prepared.root
const WS = join(ROOT, 'workspace')
const STATE = join(ROOT, 'state')
mkdirSync(join(WS, 'src'), { recursive: true })
mkdirSync(STATE, { recursive: true })

// 造 40 个文件，让索引不是瞬间完成（才有「进行中」可杀）
for (let i = 0; i < 40; i++) {
  writeFileSync(join(WS, 'src', `mod${i}.js`), [
    `export function fn${i}(a) { return a + ${i} }`,
    `export const c${i} = ${i}`,
    `try { const t${i} = ${i} } catch (e) {}`,
    '',
  ].join('\n'))
}
const target = join(WS, 'src', 'mod0.js')
const before0 = readFileSync(target, 'utf-8')

const steps = []
const record = (name, ok, detail, extra = {}) => {
  steps.push({ step: name, ok: !!ok, detail, ...extra })
  if (!AS_JSON) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}
// R20-F02/C：观察项不参与通过/失败汇总，也不能写成安全 PASS
const observe = (name, detail) => {
  steps.push({ step: name, ok: null, observation: true, detail })
  if (!AS_JSON) console.log(`OBS   ${name}${detail ? '  — ' + detail : ''}`)
}

function startServer(extraEnv = {}) {
  const env = {
    ...process.env,
    MALONG_STATE_DIR: STATE,
    MALONG_TRACE: '',
    MALONG_SEARCH_LOG: '',
    MALONG_DEV_COLLECT: '',
    ...extraEnv,
  }
  if (PARSE_BIN) env.MALONG_PARSE_BIN = PARSE_BIN
  const child = spawn(process.execPath, [SERVER], { cwd: WS, env, stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (d) => { stderr += d.toString() })
  const rl = createInterface({ input: child.stdout })
  let id = 1
  const pend = new Map()
  let childExit = null
  rl.on('line', (l) => {
    const s = l.trim(); if (!s) return
    let m; try { m = JSON.parse(s) } catch { return }
    if (m.id != null && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); p.onLine(m) }
  })
  // R20-F02：退出/错误时必须立即结算在途 RPC。
  // 旧实现只靠 120s 定时器，强杀后调用方会挂满整个超时窗口（审查人实测无输出）。
  const settle = (reason) => {
    for (const [, p] of pend) p.onFail(new Error(reason))
    pend.clear()
  }
  child.on('exit', (code, signal) => {
    childExit = { code, signal }
    settle(`server exited (code=${code}, signal=${signal})`)
  })
  child.on('error', (e) => {
    childExit = { code: null, signal: null, error: e.message }
    settle('server spawn error: ' + e.message)
  })

  const rpc = (method, params, ms = 120000) => new Promise((res, rej) => {
    const i = id++
    const t = setTimeout(() => { pend.delete(i); rej(new Error('timeout ' + method)) }, ms)
    pend.set(i, {
      onLine: (m) => { clearTimeout(t); res(m) },
      onFail: (e) => { clearTimeout(t); rej(e) },
    })
    if (childExit) {
      pend.delete(i); clearTimeout(t)
      rej(new Error('server already exited: ' + JSON.stringify(childExit)))
      return
    }
    try {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n')
    } catch (e) {
      pend.delete(i); clearTimeout(t)
      rej(e)
    }
  })
  const call = async (name, args) => {
    const r = await rpc('tools/call', { name, arguments: args })
    const t = (r.result?.content || []).find((c) => c.type === 'text')
    let p; try { p = JSON.parse(t?.text || '') } catch { p = { raw: t?.text } }
    return p
  }
  return { child, rpc, call, stderr: () => stderr, exited: () => childExit }
}

async function boot(extraEnv = {}) {
  const s = startServer(extraEnv)
  await s.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'crash', version: '1' } })
  s.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n')
  await s.rpc('tools/list', {})
  return s
}

// 等子进程真的退出（不靠固定 sleep）。已退出时必须回填真实的 code/signal，
// 否则调用方会把「早就退出了」误读成「没触发」。
function waitExit(child, ms = 10000) {
  if (child.exitCode != null || child.signalCode != null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode, already: true })
  }
  return new Promise((res) => {
    const t = setTimeout(() => res({ timeout: true }), ms)
    child.once('exit', (code, signal) => { clearTimeout(t); res({ code, signal }) })
  })
}

let exitCode = 0
try {
  // ── A. 索引请求在途时 SIGKILL（窗口：during_request）──
  // 锚点：请求已写入 stdin（sync write 已知完成），响应未回即杀。不靠 sleep 赌时序，
  // 因为它不假设「60ms 后索引一定在做」——它只声称「请求提交后、响应前被杀」。
  {
    const s = await boot()
    const inflight = s.call('code_task', { workspace_dir: WS, goal: '建立索引', search_terms: ['fn1'] })
      .then(() => ({ responded: true }), (e) => ({ responded: false, error: e.message }))
    // 只等「请求已写出」这一个事件：stdin.write 返回后再做一次微宏任务让渡，
    // 然后立刻 SIGKILL —— 此时响应尚未到达（若已到达则如实标注为 after_response）
    await new Promise((r) => setImmediate(r))
    const respondedEarly = await Promise.race([
      inflight,
      new Promise((r) => setImmediate(() => r(null))),
    ])
    s.child.kill('SIGKILL')
    const exited = await waitExit(s.child)
    const outcome = await inflight
    const window = respondedEarly ? 'after_response' : 'during_request'
    record('A1 索引请求在途 SIGKILL', exited.code === undefined && !exited.timeout || exited.code === null || exited.signal === 'SIGKILL',
      `window=${window} exit=${JSON.stringify(exited)} rpc=${outcome.responded ? 'responded' : 'rejected:' + String(outcome.error).slice(0, 60)}`,
      { window, rpc_settled: !outcome.responded })

    const s2 = await boot()
    let alive = false, detail = ''
    try {
      const st = await s2.call('code_status', { workspace_dir: WS })
      alive = !!st
      detail = 'code_status ok=' + st?.ok
    } catch (e) { detail = '异常：' + e.message }
    record('A2 重启后库可用', alive, detail)

    // 恢复路径：崩溃后允许需要一次显式 reindex（reindex 是异步任务），
    // 但错误信息必须指得对，且按指引走完能真的恢复。
    const outlineOf = async () => (await s2.call('code_query', { workspace_dir: WS, mode: 'outline', file: 'src/mod0.js' }))
    let rebuilt = false, rdetail = '', recovery = 'none'
    let q = await outlineOf()
    let ns = (q?.result?.outline || []).map((n) => n.name)
    const err = q?.error || q?.code || '-'
    rdetail = `first err=${err} outline=[${ns.join(',')}]`
    if (ns.includes('fn0') && ns.includes('t0')) {
      rebuilt = true
      recovery = 'outline(无需干预)'
    } else if (String(err).includes('NOT_INDEXED')) {
      const ri = await s2.call('invoke_capability', { workspace_dir: WS, name: 'reindex', args: { workspace_dir: WS, blocking: true } })
      recovery = 'reindex(blocking)'
      rdetail += ` | reindex status=${ri?.result?.status || ri?.result?.done}`
      for (let i = 0; i < 20 && !rebuilt; i++) {
        await new Promise((r) => setTimeout(r, 300))
        q = await outlineOf()
        ns = (q?.result?.outline || []).map((n) => n.name)
        rebuilt = ns.includes('fn0') && ns.includes('t0')
      }
      rdetail += ` | after poll outline=[${ns.join(',')}]`
    }
    record('A3 崩溃后可恢复索引', rebuilt, `${rdetail} recovery=${recovery}`,
      { recovery_path: recovery })
    record('A4 文件未被改', readFileSync(target, 'utf-8') === before0, 'mod0.js byte-identical')
    s2.child.kill('SIGTERM')
  }

  // ── B. 写入事务在途时 SIGKILL（窗口：during_write，确定性屏障）──
  // 用 MALONG_TEST_KILL_AFTER_WRITE 注入：文件已 rename 落盘、成功事件未提交时
  // 进程自己 SIGKILL。这是确定性锚点，不是「30ms 后大概在写」。
  {
    const s = await boot({ MALONG_TEST_KILL_AFTER_WRITE: '1' })
    const task = await s.call('code_task', { workspace_dir: WS, goal: '准备写入' })
    const taskId = task?.task?.task_id
    const read = await s.call('code_read', { workspace_dir: WS, task_id: taskId, locator: { file_path: 'src/mod1.js' } })
    const readRef = read?.read_ref
    const outcome = await s.call('code_patch', {
      workspace_dir: WS, task_id: taskId, read_ref: readRef,
      patch: { old_string: 'export const c1 = 1', new_string: 'export const c1 = 999' },
      dry_run: false, allow_unsafe_no_base: true,
    }).then((r) => ({ responded: true, r }), (e) => ({ responded: false, error: e.message }))
    const exited = await waitExit(s.child)
    const failpointFired = exited.signal === 'SIGKILL'
    const after = readFileSync(join(WS, 'src', 'mod1.js'), 'utf-8')
    const newApplied = after.includes('c1 = 999')
    const oldIntact = after.includes('c1 = 1') && !newApplied
    const noTear = after.endsWith('\n') && after.split('\n').length === 4
    // 关键：failpoint 没触发 => 本用例什么都没验到，必须判 FAIL，不能空过。
    record('B1 写入中 SIGKILL 不撕裂', failpointFired && (newApplied || oldIntact) && noTear,
      `window=during_write(failpoint) failpoint_fired=${failpointFired} applied=${newApplied} ` +
      `old_intact=${oldIntact} lines=${after.split('\n').length} exit=${JSON.stringify(exited)} ` +
      `rpc=${outcome.responded ? 'responded' : 'rejected:' + String(outcome.error).slice(0, 50)}` +
      (failpointFired ? '' : ' ← failpoint 未触发，本用例无证据'),
      { window: 'during_write', failpoint: 'MALONG_TEST_KILL_AFTER_WRITE', failpoint_fired: failpointFired })

    const s2 = await boot()
    let ok = false, detail = ''
    try {
      const q = await s2.call('code_query', { workspace_dir: WS, mode: 'outline', file: 'src/mod1.js' })
      ok = !!(q?.result?.file)
      detail = 'outline after crash ok=' + ok
    } catch (e) { detail = '异常：' + e.message }
    record('B2 重启后仍可读', ok, detail)
    s2.child.kill('SIGTERM')
  }

  // ── C. 观察项：残留 WAL/SHM（不参与通过/失败，不写成安全 PASS）──
  const leftovers = readdirSync(STATE, { recursive: true }).filter((f) => /-(wal|shm)$/.test(String(f)))
  observe('C 残留 WAL/SHM（仅观察）', leftovers.length ? leftovers.map(String).slice(0, 4).join(',') : 'none')
} catch (e) {
  record('执行异常', false, (e.code ? e.code + ' ' : '') + e.message)
}

const failed = steps.filter((s) => s.ok === false)
const observed = steps.filter((s) => s.observation)
const checked = steps.length - observed.length
exitCode = failed.length ? 1 : 0
if (AS_JSON) {
  console.log(JSON.stringify({
    server: SERVER,
    parse_bin: PARSE_BIN || null,
    workdir: ROOT,
    steps,
    checked,
    observed: observed.length,
    failed: failed.length,
    exitCode,
  }, null, 2))
} else {
  console.log(`\n== crash-boundary: ${checked - failed.length}/${checked} passed` +
    (observed.length ? `, ${observed.length} observation(s)` : '') + ' ==')
}
process.exit(exitCode)
