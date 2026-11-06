// test-check-suggestion-timing.js — 检查建议不得被说成「进一步编辑前必须先跑」
//
// 轨迹实测（2026-11-05，两池 872 次调用）：
//   · code_check 建议：A 池 64 次 / 执行 0（0%）；B 池 180 次 / 执行 9（5%）
//   · 两次检查之间平均连写 29.4 次（p90=125，max=168）
//   · 一次检查 p50 58.9s——调用方显然是在「告一段落时」才检查，不是每次写后
//
// 旧文案：'A prior edit is unvalidated (result_kind=partial): run checks before further edits.'
// 但实现根本不拦后续编辑（同一 read_ref/wbase_* 可继续写）。
// 把可选动作说成前置条件 = 训练调用方忽略 next_action，比不给建议更糟。
//
// 判据：
//   ① 结构化建议仍必须可执行（tool/args/task_id 齐全，照做能成）
//   ② 未验证状态必须 optional=true
//   ③ 文案不得再出现「before further edits」这类假前置条件
//   ④ 文案必须说清真实时机（完成时跑一次）
//   ⑤ 失败路径：上次检查 FAILED 不是可选项，不得被 optional 吞掉
//   ⑥ code_status 的 next_step 同样不得把检查说成强制项

import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP = join(os.tmpdir(), 'opencode', 'check-suggestion-test')
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
const WS = join(TMP, 'ws')
mkdirSync(join(WS, 'src'), { recursive: true })
process.env.MALONG_STATE_DIR = join(TMP, 'state')
process.env.MALONG_ENTRY_STATE = '1'

let pass = 0, fail = 0
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  FAIL:', msg) } }

const imp = (p) => import(pathToFileURL(p).href)
const shared = await imp(join(__dirname, '..', 'tools', 'entry-shared.js'))
const store = await imp(join(__dirname, '..', 'tools', 'entry-store.js'))
const patch = await imp(join(__dirname, '..', 'tools', 'tool-code-patch', 'handler.js'))
const statusMod = await imp(join(__dirname, '..', 'tools', 'tool-code-status', 'handler.js'))

const ctx = { codeIndexService: null, langParserService: null }
const F = 'src/a.txt'
const ORIG = 'alpha\nbeta\n'
writeFileSync(join(WS, F), ORIG)
const h = (s) => 'sha256:' + shared.sha256Hex(s)
const material = { read_ref: 'read_1', locator: { file_path: F }, canonical_path: F, file_version: { hash: h(ORIG) }, symbol_version: null }

function mkTask(id, extra) {
  const t = { task_id: id, revision: 1, route: 'change', lifecycle: 'active', node: 'read', materials: [material], operations: [], evidence: [], workspace_dir: WS, ...(extra || {}) }
  shared.putTask(WS, t, { type: 'task_created', task: t })
  return t
}

// ── ① per-write 建议：仍可执行，但标明可选与真实时机 ──
mkTask('t_patch')
const r = await patch.handle({ workspace_dir: WS, task_id: 't_patch', read_ref: 'read_1', edit_mode: 'patch', patch: { old_string: 'beta', new_string: 'BETA' }, dry_run: false }, ctx)
assert(r.ok === true, '① 前置：patch 应用成功（得 ' + (r.error || r.observation?.summary) + '）')
const na = r.next_action || {}
assert(na.tool === 'code_check' && na.args?.run === true && na.args?.task_id === 't_patch',
  '① 结构化检查建议仍可执行（tool/args/task_id 齐全）（得 ' + JSON.stringify(na) + '）')
assert(na.optional === true, '② per-write 建议必须 optional=true（得 ' + JSON.stringify(na.optional) + '）')
const note = String(na.note || '')
assert(!/before further edits/i.test(note), '③ 不得再声称「进一步编辑前」必须先检查（得 ' + JSON.stringify(note) + '）')
assert(/optional/i.test(note), '④ 文案必须明说可选（得 ' + JSON.stringify(note) + '）')
// R22-F18b（重启后真机复验）：建议面必须自洽——next_action 推 code_check，
// allowed_actions 却不含它；文本 next_step 还以「Run code_check」开头（两者都实测到过）。
assert(Array.isArray(r.allowed_actions) && r.allowed_actions.includes('code_check'),
  '④ allowed_actions 必须包含自己推荐的 code_check（得 ' + JSON.stringify(r.allowed_actions) + '）')
assert(!/^Run code_check/i.test(String(r.next_step || '')),
  '④ next_step 不得以「Run code_check」开头（应先把下一步编辑放前面）（得 ' + JSON.stringify(r.next_step) + '）')
assert(/write_read_refs/i.test(String(r.next_step || '')),
  '④ next_step 应指出 wbase_* 可直接复用（得 ' + JSON.stringify(r.next_step) + '）')
assert(/(end|finish|done)/i.test(note), '④ 文案必须说清真实时机：完成时跑一次（得 ' + JSON.stringify(note) + '）')

// ── ② 任务状态侧：未验证 → optional；上次失败 → 不可选 ──
mkTask('t_unvalidated', { result_kind: 'partial' })
{
  const a = shared.buildTaskNextAction({ workspaceDir: WS, task_id: 't_unvalidated', task: store.getTask(WS, 't_unvalidated') })
  assert(a.tool === 'code_check' && a.optional === true, '⑤ 未验证状态：code_check 且 optional（得 ' + JSON.stringify(a.optional) + '）')
  assert(!/before further edits/i.test(String(a.note || '')), '⑤ 文案不得说成前置条件（得 ' + JSON.stringify(a.note) + '）')
}
mkTask('t_failed', { result_kind: 'partial', evidence: [{ evidence_id: 'ev_x', kind: 'test', result: 'failed' }] })
{
  const b = shared.buildTaskNextAction({ workspaceDir: WS, task_id: 't_failed', task: store.getTask(WS, 't_failed') })
  assert(b.tool === 'code_check', '⑥ 失败后下一步仍是 code_check（得 ' + JSON.stringify(b.tool) + '）')
  assert(b.optional !== true, '⑥ 上次检查 FAILED 时不得标 optional（得 ' + JSON.stringify(b.optional) + '）')
  assert(/FAILED/.test(String(b.note || '')), '⑥ 失败分支必须要求先修再重跑（得 ' + JSON.stringify(b.note) + '）')
}

// ── ③ code_status：next_step 不得把检查写成强制 ──
{
  const r2 = await statusMod.handle({ workspace_dir: WS, task_id: 't_unvalidated' }, ctx)
  assert(r2.ok === true, '⑦ 前置：status 成功（得 ' + (r2.error || '') + '）')
  const ns = String(r2.next_step || '')
  assert(!/follow next_action \(code_check\)/i.test(ns), '⑦ next_step 不得把 code_check 写成「照做」强制项（得 ' + JSON.stringify(ns) + '）')
  assert(/optional/i.test(ns), '⑦ next_step 应说明检查可延后（得 ' + JSON.stringify(ns) + '）')
}

try { rmSync(TMP, { recursive: true, force: true }) } catch {}
console.log(`\n=== test-check-suggestion-timing: ${pass} passed, ${fail} failed ===`)
process.exit(fail > 0 ? 1 : 0)
