#!/usr/bin/env node
// test-mcp-note-budget.js — 0.5.26：请求预算截断的可感知 + 不误归因
// 覆盖：① verify_pipeline 的 mcp_note（120s 硬上限预警）透传进 evidence.actual.notice；
//       ② 超时判 failed 时 next_action 指向 code_check(async=true)，不再指回 code_patch「改代码」；
//       ③ 真失败（非超时）仍指向 code_patch（回归防护：口径别改过头）；
//       ④ background(async) 路径不打 mcp_note（既有语义不变）。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP = join(os.tmpdir(), 'opencode', 'mcp-note-budget')
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
process.env.MALONG_STATE_DIR = join(TMP, 'state')
process.env.MALONG_ENTRY_STATE = '1'

let pass = 0, fail = 0
function assert(cond, msg) { if (cond) { pass++; console.log('  ✓ ' + msg) } else { fail++; console.error('  ✗ ' + msg) } }
const imp = (p) => import(pathToFileURL(p).href)

const shared = await imp(join(__dirname, '..', 'tools', 'entry-shared.js'))
const check = await imp(join(__dirname, '..', 'tools', 'tool-code-check', 'handler.js'))
const pipeline = await imp(join(__dirname, '..', 'tools', 'tool-verify-pipeline', 'handler.js'))
const ctx = {}

const BODY_PASS = `console.log('1 passed')`
const BODY_FAIL = `process.exit(1)`
const BODY_SLEEP = `setTimeout(function(){}, 10000)`

function mkWs(name, body) {
  const ws = join(TMP, name)
  mkdirSync(ws, { recursive: true })
  writeFileSync(join(ws, 'run.js'), body)
  writeFileSync(join(ws, 'package.json'), JSON.stringify({ name: name, scripts: { test: 'node run.js' } }))
  return ws
}
function mkTask(ws, id) {
  const t = { task_id: id, revision: 1, route: 'change', lifecycle: 'active', node: 'edit', materials: [], operations: [], evidence: [], candidates: [], workspace_dir: ws }
  shared.putTask(ws, t, { type: 'task_created', task: t })
  return t
}

console.log('== ① mcp_note 透传进 evidence.actual.notice ==')
{
  const ws = mkWs('note', BODY_PASS)
  mkTask(ws, 'task_note')
  // timeout=300000 → verify_pipeline 钳到 110000 → 1 阶段 × 110s > 100s → 生成 mcp_note
  const r = await check.handle({ workspace_dir: ws, task_id: 'task_note', checks: ['test'], run: true, timeout: 300000 }, ctx)
  const ev = r.observation && r.observation.evidence && r.observation.evidence[0]
  assert(ev && ev.result === 'passed', '检查通过（得 ' + (ev && ev.result) + '）')
  const notice = (ev && ev.actual && ev.actual.notice) || ''
  assert(/120s hard timeout/.test(notice), 'evidence.notice 带 mcp_note（得 ' + JSON.stringify(notice) + '）')
  assert(/will definitely time out/.test(notice), 'notice 含「必然超时」原文')
}

console.log('== ② 超时 → next_action 指向 code_check(async=true)，不是 code_patch ==')
{
  const ws = mkWs('timeout', BODY_SLEEP)
  mkTask(ws, 'task_timeout')
  const r = await check.handle({ workspace_dir: ws, task_id: 'task_timeout', checks: ['test'], run: true, timeout: 1000 }, ctx)
  const ev = r.observation && r.observation.evidence && r.observation.evidence[0]
  assert(ev && ev.result === 'failed', '超时判 failed（得 ' + (ev && ev.result) + '）')
  assert(ev && ev.actual && ev.actual.timed_out === true, 'actual.timed_out 标记')
  assert(ev && ev.limitations && ev.limitations.join(' ').indexOf('NOT a code defect') >= 0, 'limitations 说明不是代码缺陷')
  const na = r.next_action || (r.extra && r.extra.next_action)
  assert(na && na.tool === 'code_check', 'next_action 指回 code_check（得 ' + (na && na.tool) + '）')
  assert(na && na.args && na.args.async === true, 'next_action 带 async=true')
  assert(na && na.args && na.args.run === true, 'next_action 带 run=true')
  assert(na && na.args && na.args.timeout === 600000, '重试给够后台预算 timeout=600000（得 ' + (na && na.args && na.args.timeout) + '）')
  assert(!(na && na.args && na.args.timeout === 1000), '不把「已经不够用」的小 timeout 带进重试（否则后台照样超时）')
  assert(na && /do not edit code/.test(na.note || ''), 'next_action 明说不要改代码')
  assert(/not a code defect/.test(r.next_step || ''), 'next_step 明说不是代码缺陷')
}

console.log('== ③ 真失败（非超时）仍指向 code_patch ==')
{
  const ws = mkWs('fail', BODY_FAIL)
  mkTask(ws, 'task_fail')
  const r = await check.handle({ workspace_dir: ws, task_id: 'task_fail', checks: ['test'], run: true }, ctx)
  const ev = r.observation && r.observation.evidence && r.observation.evidence[0]
  assert(ev && ev.result === 'failed', '真失败判 failed（得 ' + (ev && ev.result) + '）')
  assert(!(ev && ev.actual && ev.actual.timed_out), '真失败不带 timed_out')
  const na = r.next_action || (r.extra && r.extra.next_action)
  assert(na && na.tool === 'code_patch', 'next_action 指 code_patch（得 ' + (na && na.tool) + '）')
}

console.log('== ④ background 路径不打 mcp_note（既有语义不变） ==')
{
  const ws = mkWs('bg', BODY_PASS)
  const bg = await pipeline.handle({ workspace_dir: ws, stages: 'test', timeout: 300000 }, Object.assign({}, ctx, { background: true }))
  assert(!bg || !bg.mcp_note, 'background 不打 mcp_note（得 ' + JSON.stringify(bg && bg.mcp_note) + '）')
  const fg = await pipeline.handle({ workspace_dir: ws, stages: 'test', timeout: 300000 }, ctx)
  assert(fg && typeof fg.mcp_note === 'string' && /120s/.test(fg.mcp_note), 'foreground 打 mcp_note（得 ' + JSON.stringify(fg && fg.mcp_note) + '）')
}

console.log('\n=== test-mcp-note-budget: ' + pass + ' passed, ' + fail + ' failed ===')
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
process.exit(fail > 0 ? 1 : 0)
