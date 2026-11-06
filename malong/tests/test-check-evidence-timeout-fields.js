// test-check-evidence-timeout-fields.js — evidence.actual 必须能区分「超时被杀」与「自己退出 1」（B7）
//
// 背景：DSH 最初那条 failed 证据是 duration_ms=105860、exit_code=1、
// 而 actual 里**没有 timed_out**。旧实现只在 stage.timed_out 为真时才写 timed_out，
// 其它路径一律不写——调用方看到一条失败的 evidence，无法判断是「超时被杀」还是
// 「进程自己退出 1」，只能猜。DSH 因此在实录里写了「它自己那句 notice 说清了原因，
// 但 result 字段仍然写 failed，下游会当成真失败去修」。
//
// 这条测试直接盯 code_check 的 evidence 层（不是 verify_pipeline 的 stage 层），
// 因为真正给调用方看的是前者。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP = join(os.tmpdir(), 'opencode', 'cc-evidence-to')
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
process.env.MALONG_STATE_DIR = join(TMP, 'state')
process.env.MALONG_ENTRY_STATE = '1'

let pass = 0, fail = 0
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  FAIL:', msg) } }
const imp = (p) => import(pathToFileURL(join(__dirname, '..', p)).href)

const store = await imp('tools/entry-store.js')
const check = await imp('tools/tool-code-check/handler.js')

function mkTask(ws, id) {
  const t = { task_id: id, revision: 1, lifecycle: 'active', route: 'change', node: 'check', workspace_dir: ws, materials: [], operations: [], evidence: [] }
  store.putTask(ws, t, { type: 'task_created', task: t })
  return t
}

function mkWs(name, scripts) {
  const ws = join(TMP, name)
  mkdirSync(ws, { recursive: true })
  writeFileSync(join(ws, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', scripts }))
  return ws
}

const ctx = {}

// ── ① 真失败（自己退出 1）→ actual 必须带 killed:false 或明确不含 timed_out，且 exit_code=1 ──
{
  const ws = mkWs('fail', { lint: 'node -e "process.exit(1)"' })
  mkTask(ws, 'tk_fail')
  const r = await check.handle({ workspace_dir: ws, task_id: 'tk_fail', checks: ['lint'], run: true, timeout: 30000 }, ctx)
  const ev = r?.observation?.evidence?.[0]
  assert(ev, '① 应产出 evidence')
  assert(ev.result === 'failed', `① 自己退出 1 应判 failed（得 ${ev?.result}）`)
  assert(ev.actual?.exit_code === 1, `① exit_code 应为 1（得 ${ev?.actual?.exit_code}）`)
  assert(ev.actual?.timed_out === undefined, `① 真失败不得标 timed_out（得 ${JSON.stringify(ev?.actual?.timed_out)}）`)
  // 关键：必须能分辨"不是超时"——killed 显式为 false 或不出现，但不能是 true
  assert(ev.actual?.killed !== true, `① 真失败不得标 killed（得 ${JSON.stringify(ev?.actual?.killed)}）`)
}

// ── ② 真超时 → actual 必须同时带 killed:true 与 timed_out:true ──
{
  const ws = mkWs('to', { lint: 'node -e "setTimeout(()=>{}, 60000)"' })
  mkTask(ws, 'tk_to')
  const r = await check.handle({ workspace_dir: ws, task_id: 'tk_to', checks: ['lint'], run: true, timeout: 1500 }, ctx)
  const ev = r?.observation?.evidence?.[0]
  assert(ev, '② 应产出 evidence')
  assert(ev.result === 'failed', `② 超时应判 failed（得 ${ev?.result}）`)
  assert(ev.actual?.killed === true, `② 超时必须标 killed:true（得 ${JSON.stringify(ev?.actual?.killed)}）`)
  assert(ev.actual?.timed_out === true, `② 超时必须标 timed_out:true（得 ${JSON.stringify(ev?.actual?.timed_out)}）`)
  assert(ev.actual?.timed_out_ms === 1500, `② 应带真实 timeout_ms（得 ${JSON.stringify(ev?.actual?.timed_out_ms)}）`)
  assert(Array.isArray(ev.limitations) && ev.limitations.some(l => /NOT a code defect/.test(l)),
    '② 必须带"不是代码缺陷"的 limitation')
  // 超时路径的 next_action 必须指 async 重试，不是 code_patch
  assert(r.next_action?.tool === 'code_check' && r.next_action?.args?.async === true,
    `② next_action 应指 code_check(async=true)（得 ${JSON.stringify(r.next_action?.tool)}）`)
}

// ── ③ 成功路径 → 不得出现任何超时/被杀标记 ──
{
  const ws = mkWs('ok', { lint: 'node -e "process.exit(0)"' })
  mkTask(ws, 'tk_ok')
  const r = await check.handle({ workspace_dir: ws, task_id: 'tk_ok', checks: ['lint'], run: true, timeout: 30000 }, ctx)
  const ev = r?.observation?.evidence?.[0]
  assert(ev.result === 'passed', `③ 应判 passed（得 ${ev?.result}）`)
  assert(ev.actual?.killed === undefined, `③ 成功不得标 killed（得 ${JSON.stringify(ev?.actual?.killed)}）`)
  assert(ev.actual?.timed_out === undefined, `③ 成功不得标 timed_out（得 ${JSON.stringify(ev?.actual?.timed_out)}）`)
}

// ── ④ failed 且 stderr 为空 → 必须显式写空串，不能"什么都不写"（B8）──
//    与 DSH 那条 failed 同形：exit_code=1、有 stdout_tail、**看不到 stderr_tail**。
//    读者无法区分"stderr 本来就是空的"与"stderr 压根没采集"。
//    诊断证据里，"确认没有"和"不知道有没有"必须是两种可区分的状态。
{
  const ws = mkWs('noerr', { lint: 'node -e "console.log(123);process.exit(1)"' })
  mkTask(ws, 'tk_noerr')
  const r = await check.handle({ workspace_dir: ws, task_id: 'tk_noerr', checks: ['lint'], run: true, timeout: 30000 }, ctx)
  const ev = r?.observation?.evidence?.[0]
  assert(ev?.result === 'failed', `④ 应判 failed（得 ${ev?.result}）`)
  assert(ev?.actual?.stdout_tail, '④ 应有 stdout_tail（脚本确实有输出）')
  // 关键：stderr 字段必须存在（值可以是空串），而不是缺失
  assert('stderr_tail' in (ev?.actual || {}),
    `④ failed 时必须写出 stderr_tail（哪怕是空串）——得 keys=${Object.keys(ev?.actual || {}).join(',')}`)
  assert(ev?.actual?.stderr_tail === '', `④ stderr 确实为空时应是空串（得 ${JSON.stringify(ev?.actual?.stderr_tail)}）`)
}

// ── ⑤ 成功路径不应被这个改动影响（无谓地多写 stderr_tail）──
{
  const ws = mkWs('ok2', { lint: 'node -e "process.exit(0)"' })
  mkTask(ws, 'tk_ok2')
  const r = await check.handle({ workspace_dir: ws, task_id: 'tk_ok2', checks: ['lint'], run: true, timeout: 30000 }, ctx)
  const ev = r?.observation?.evidence?.[0]
  assert(ev?.result === 'passed', `⑤ 应判 passed（得 ${ev?.result}）`)
  assert(!('stderr_tail' in (ev?.actual || {})),
    `⑤ 成功且无 stderr 时不必写（得 ${JSON.stringify(ev?.actual?.stderr_tail)}）`)
}

rmSync(TMP, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
