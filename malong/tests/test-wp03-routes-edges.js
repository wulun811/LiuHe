#!/usr/bin/env node
// test-wp03-routes-edges.js — WP03 结构化图边与八路线对齐（AC03-06/11/19 机械可验子集）
// 覆盖：八路线 open 态显式出口（12.5 语义）、done 空动作 + host_required 合同、
// 有模板不假装可直接调用（template+required_args）、机械跟随非模板建议不空转、
// switch_route 换路线仍可用、audit awaiting_decision 列出问题与 optional_actions、
// 预览参数可直接应用 + 应用后补检查建议。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP = join(os.tmpdir(), 'opencode', 'wp03-routes-edges')
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
process.env.MALONG_STATE_DIR = join(TMP, 'state')
process.env.MALONG_ENTRY_STATE = '1'

let pass = 0
let fail = 0
function assert(cond, msg) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`) } else { fail++; console.log(`  ✗ ${msg}`) }
}
const imp = (p) => import(pathToFileURL(p).href)

const shared = await imp(join(__dirname, '..', 'tools', 'entry-shared.js'))
const status = await imp(join(__dirname, '..', 'tools', 'tool-code-status', 'handler.js'))
const audit = await imp(join(__dirname, '..', 'tools', 'tool-code-audit', 'handler.js'))
const control = await imp(join(__dirname, '..', 'tools', 'tool-code-control', 'handler.js'))
const read = await imp(join(__dirname, '..', 'tools', 'tool-code-read', 'handler.js'))
const patch = await imp(join(__dirname, '..', 'tools', 'tool-code-patch', 'handler.js'))
const ctx = {}

const WS = join(TMP, 'routes')
mkdirSync(WS, { recursive: true })
writeFileSync(join(WS, 'package.json'), JSON.stringify({ name: 'routes', scripts: {} }))
writeFileSync(join(WS, 'edit_me.js'), 'const a = 1\nexport function use_a() { return a }\n')
writeFileSync(join(WS, 'foo_bar.js'), 'export function do_thing(a) { return a }\nexport function unused_fn() { return 1 }\n')

function mkTask(ws, id, route, extra = {}) {
  const t = { task_id: id, revision: 1, route, lifecycle: 'active', node: 'orient', goal: 'g', materials: [], operations: [], evidence: [], candidates: [], workspace_dir: ws, ...extra }
  shared.putTask(ws, t, { type: 'task_created', task: t })
  return t
}
const ROUTES = ['understand', 'change', 'diagnose', 'review', 'maintain', 'document', 'isolate', 'system']
for (const route of ROUTES) mkTask(WS, `task_${route}`, route)

console.log('== 八路线 open 态显式出口（12.5 语义）==')
const exits = {}
for (const route of ROUTES) {
  const r = await status.handle({ workspace_dir: WS, task_id: `task_${route}` }, ctx)
  assert(r.ok === true && r.next_action?.tool, `route=${route} 有结构化 next_action（${r.next_action?.tool}）`)
  exits[route] = r.next_action
}
assert(exits.change.tool === 'code_patch' && exits.change.template === true && exits.change.required_args?.includes('edit_mode'), 'change → code_patch 模板（template + required_args 明确）')
assert(exits.review.tool === 'code_audit' && exits.maintain.tool === 'code_maintain' && exits.maintain.args.action === 'plan', 'review → audit、maintain → 只读 plan')
const readonlyRoutes = ['understand', 'diagnose', 'document', 'isolate', 'system']
for (const route of readonlyRoutes) {
  assert(exits[route].tool === 'code_status' && /Route=/.test(exits[route].note || ''), `${route} → 只读出口 + 路线特定说明（不假装可直接调用写/隔离工具）`)
}

console.log('== 机械跟随非模板建议不空转 ==')
for (const route of readonlyRoutes) {
  const r = await status.handle({ ...exits[route].args }, ctx)
  assert(r.ok === true, `跟随 ${route} 出口建议（code_status）可直接调用不空转`)
}
{
  const r = await audit.handle({ ...exits.review.args }, ctx)
  assert(r.ok === true && Array.isArray(r.observation?.findings), '跟随 review 出口建议（code_audit）可直接执行有覆盖说明')
}

console.log('== done 空动作 + host_required 合同（AC03）==')
{
  mkTask(WS, 'task_done', 'change', {
    result_kind: 'validated',
    validated_goal_revision: 1,
    goal_revision: 1,
    operations: [{ operation_id: 'op_d1', request_id: null, kind: 'patch', state: 'succeeded', file: 'edit_me.js' }],
  })
  const r = await status.handle({ workspace_dir: WS, task_id: 'task_done' }, ctx)
  assert(r.next_action === undefined || r.next_action === null, 'done → 空动作（不再机械推荐下一步）')
  assert(r.progress === 'done' && r.mechanical_requirements_met === true && r.goal_judgment === 'host_required', '合同字段：progress=done + mechanical_requirements_met + goal_judgment=host_required')
  const proj = shared.completionProjection({ workspaceDir: WS, task: { task_id: 'task_done', route: 'change', lifecycle: 'active', result_kind: 'validated', validated_goal_revision: 1 } })
  assert(proj !== null && /does not certify/.test(proj.note), 'completion 说明不冒充业务目标完成')
  const na = shared.buildTaskNextAction({ workspaceDir: WS, task_id: 'task_done', task: { task_id: 'task_done', route: 'change', lifecycle: 'active', result_kind: 'validated', validated_goal_revision: 1 } })
  assert(na === null, 'buildTaskNextAction：done → null（空动作）')
}

console.log('== 换路线仍可用（AC19）==')
{
  mkTask(WS, 'task_sw', 'diagnose')
  const sw = await control.handle({ workspace_dir: WS, task_id: 'task_sw', action: 'switch_route', route: 'review' }, ctx)
  assert(sw.ok === true && sw.observation?.goal_revision === 2, 'switch_route：goal_revision bump + 材料保留')
  const r = await status.handle({ workspace_dir: WS, task_id: 'task_sw' }, ctx)
  assert(r.next_action?.tool === 'code_audit', '换 review 路线后出口随之对齐（改走合法路线不空转）')
}

console.log('== audit awaiting_decision：列出问题 + optional_actions（AC04/AC11）==')
{
  mkTask(WS, 'task_aw', 'review', {
    materials: [{ read_ref: 'read_1', canonical_path: 'foo_bar.js', locator: { file_path: 'foo_bar.js' } }],
    index_scope: { files_scanned: 3, files_indexed: 3, truncated: true },
  })
  const r = await audit.handle({ workspace_dir: WS, task_id: 'task_aw', checks: ['code_review', 'dead_code'] }, ctx)
  assert(r.ok === true && (r.observation?.counts?.active || 0) >= 1, `分析执行且指定域有覆盖说明（active=${r.observation?.counts?.active}）`)
  assert(r.awaiting_decision === true, '有 active finding → awaiting_decision')
  assert((r.observation?.findings?.length || 0) > 0, '问题已列出（findings）')
  const oa = r.optional_actions
  assert(Array.isArray(oa) && oa.length >= 3, `optional_actions 列出可选动作（${oa?.length} 项）`)
  const expand = oa.find(a => a.tool === 'code_control')
  const fix = oa.find(a => a.tool === 'code_patch')
  assert(expand?.args?.action === 'expand' && fix?.template === true && (fix?.required_args?.length || 0) > 0, 'expand 可直接调、fix 为模板（不假装可直接调用）')
}

console.log('== 预览参数可直接应用 + 应用补检查建议（AC11）==')
{
  const rd = await read.handle({ workspace_dir: WS, task_id: 'task_change', locator: { file_path: 'edit_me.js' } }, ctx)
  assert(rd.ok === true && typeof rd.read_ref === 'string', 'code_read 拿 read_ref（结构化身份）')
  const na = rd.next_action
  assert(na?.tool === 'code_patch' && na.template === true && na.args?.read_ref === rd.read_ref && na.args?.dry_run === true, 'read 出口的编辑建议引用当前 read 身份且标为模板')
  const applied = await patch.handle({
    workspace_dir: WS, task_id: 'task_change', read_ref: rd.read_ref,
    edit_mode: 'patch', patch: { old_string: 'const a = 1', new_string: 'const a = 2' }, dry_run: false,
  }, ctx)
  assert(applied.ok === true, '按模板补载荷后 dry_run=false 直接应用成功（预览参数可直接应用）')
  assert(readFileSync(join(WS, 'edit_me.js'), 'utf-8').includes('const a = 2'), '文件真实变更')
  assert(applied.next_action?.tool === 'code_check' && applied.next_action?.args?.run === true, '应用后补检查建议（result_kind=partial → code_check run=true）')
}

console.log(`\n=== test-wp03-routes-edges: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
