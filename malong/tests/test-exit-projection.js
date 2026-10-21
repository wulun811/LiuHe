// test-exit-projection.js — 15-C：四出口结构化投影统一（专家 621f6f8 §4.3）
// 覆盖：resume/control-status 显式 next_action（含 null）/ done 合同同源 / stale 结构化 code_check /
//       read 显式 result_stale+stale_reason / 在途结构化 waiting 查询
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP = join(os.tmpdir(), 'opencode', 'exit-projection-test')
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
const WS = join(TMP, 'ws')
mkdirSync(join(WS, 'src'), { recursive: true })
process.env.MALONG_STATE_DIR = join(TMP, 'state')
process.env.MALONG_ENTRY_STATE = '1'

let pass = 0, fail = 0
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  FAIL:', msg) } }
const imp = (p) => import(pathToFileURL(p).href)
const shared = await imp(join(__dirname, '..', 'tools', 'entry-shared.js'))
const control = await imp(join(__dirname, '..', 'tools', 'tool-code-control', 'handler.js'))
const readMod = await imp(join(__dirname, '..', 'tools', 'tool-code-read', 'handler.js'))

const ctx = { codeIndexService: null, langParserService: null }
const NL = String.fromCharCode(10)
const F = 'src/a.txt'
const CONTENT = ['alpha', 'beta', 'gamma', ''].join(NL)
writeFileSync(join(WS, F), CONTENT)
const h = (s) => 'sha256:' + shared.sha256Hex(s)
const material = { read_ref: 'read_1', locator: { file_path: F }, canonical_path: F, file_version: { hash: h(CONTENT) }, symbol_version: null }
const patchOp = { operation_id: 'op1', kind: 'patch', request_id: null, state: 'succeeded', file: F, result_kind: 'partial' }
const cleanEv = { evidence_id: 'e1', kind: 'test', result: 'passed', operation_id: 'op1', actual: { ran: true, exit_code: 0 }, depends_on: [{ file: F, hash: h(CONTENT) }] }
function mkTask(id, extra = {}) {
  const t = { task_id: id, revision: 1, route: 'change', goal: 'change alpha', node: 'check', lifecycle: 'active', materials: [material], operations: [patchOp], evidence: [cleanEv], candidates: [], workspace_dir: WS, ...extra }
  shared.putTask(WS, t, { type: 'task_created', task: t })
  return t
}

// ① done：resume/status 显式 next_action=null + 合同字段；read 显式 result_stale=false
{
  mkTask('t_done', { result_kind: 'validated', validated_goal_revision: 1, goal_revision: 1 })
  const r = await control.handle({ workspace_dir: WS, task_id: 't_done', action: 'resume' }, ctx)
  assert(r.ok === true, '① resume ok（得 ' + JSON.stringify(r.error || r.ok) + '）')
  assert('next_action' in r && r.next_action === null, '① resume 显式 next_action:null（得 has=' + ('next_action' in r) + ', v=' + JSON.stringify(r.next_action) + '）')
  assert(r.progress === 'done' && r.mechanical_requirements_met === true && r.goal_judgment === 'host_required', '① resume done 合同字段齐全（得 ' + JSON.stringify({ p: r.progress, m: r.mechanical_requirements_met, j: r.goal_judgment }) + '）')
  const s = await control.handle({ workspace_dir: WS, task_id: 't_done', action: 'status' }, ctx)
  assert('next_action' in s && s.next_action === null, '① control status 显式 next_action:null（得 ' + JSON.stringify(s.next_action) + '）')
  const rd = await readMod.handle({ workspace_dir: WS, task_id: 't_done', locator: { file_path: F } }, ctx)
  assert(rd.ok === true && rd.observation.result_stale === false, '① read result_stale=false（得 ' + JSON.stringify(rd.observation?.result_stale) + '）')
  assert('next_action' in rd && rd.next_action === null, '① read next_action=null（得 ' + JSON.stringify(rd.next_action) + '）')
}

// ② goal_change：resume/read 都给出结构化 code_check（run=true）
{
  mkTask('t_goal', { result_kind: 'validated', validated_goal_revision: 1, goal_revision: 2 })
  const r = await control.handle({ workspace_dir: WS, task_id: 't_goal', action: 'resume' }, ctx)
  assert(r.next_action?.tool === 'code_check' && r.next_action.args?.run === true && r.next_action.args?.task_id === 't_goal', '② resume stale → 结构化 code_check（得 ' + JSON.stringify(r.next_action || null) + '）')
  assert(r.progress !== 'done', '② stale 不报 done（得 ' + r.progress + '）')
  const rd = await readMod.handle({ workspace_dir: WS, task_id: 't_goal', locator: { file_path: F } }, ctx)
  assert(rd.observation.result_stale === true && rd.observation.stale_reason === 'goal_change', '② read 显式 stale+原因（得 ' + JSON.stringify({ s: rd.observation?.result_stale, r: rd.observation?.stale_reason }) + '）')
  assert(rd.next_action?.tool === 'code_check', '② read next_action 结构化（得 ' + JSON.stringify(rd.next_action || null) + '）')
}

// ③ file_change：依赖文件漂移 → resume/read 同口径 stale
{
  const driftEv = { ...cleanEv, depends_on: [{ file: F, hash: 'sha256:deadbeef' }] }
  mkTask('t_file', { result_kind: 'validated', validated_goal_revision: 1, goal_revision: 1, evidence: [driftEv] })
  const r = await control.handle({ workspace_dir: WS, task_id: 't_file', action: 'resume' }, ctx)
  assert(r.next_action?.tool === 'code_check' && r.next_action.args?.run === true, '③ resume 文件漂移 → code_check（得 ' + JSON.stringify(r.next_action || null) + '）')
  const rd = await readMod.handle({ workspace_dir: WS, task_id: 't_file', locator: { file_path: F } }, ctx)
  assert(rd.observation.result_stale === true && rd.observation.stale_reason === 'file_change', '③ read 文件漂移 stale（得 ' + JSON.stringify({ s: rd.observation?.result_stale, r: rd.observation?.stale_reason }) + '）')
}

// ③b P3（2026-10-12 狗粮）：file_change 且过期证据全为 audit 类 → 指 code_audit（跑 test 不刷新 audit）
{
  const auditEv = { evidence_id: 'e_aud', kind: 'audit:code_review', result: 'failed', depends_on: [{ file: F, hash: 'sha256:deadbeef' }] }
  mkTask('t_audit', { result_kind: 'validated', validated_goal_revision: 1, goal_revision: 1, evidence: [auditEv] })
  const r = await control.handle({ workspace_dir: WS, task_id: 't_audit', action: 'resume' }, ctx)
  assert(r.next_action?.tool === 'code_audit', '③b audit-only 过期 → next_action 指 code_audit（得 ' + JSON.stringify(r.next_action || null) + '）')
  assert(/audit/i.test(r.next_action?.note || ''), '③b note 说明 audit 证据过期（得 ' + (r.next_action?.note || '') + '）')
}

// ③c 狗粮r2：partial 且最近检查证据 failed → note 指「先修再重跑」；无检查证据 → 保留 unvalidated 文案
{
  const failedEv = { evidence_id: 'e_fail', kind: 'test', result: 'failed', operation_id: 'op1', actual: { ran: true, exit_code: 1 } }
  mkTask('t_failed', { result_kind: 'partial', evidence: [failedEv] })
  const r = await control.handle({ workspace_dir: WS, task_id: 't_failed', action: 'resume' }, ctx)
  assert(r.next_action?.tool === 'code_check' && /FAILED/.test(r.next_action?.note || ''), '③c 上次检查 FAILED → note 指先修再重跑（得 ' + JSON.stringify(r.next_action || null) + '）')
  const pendingEv = { evidence_id: 'e_pending', kind: 'patch', result: 'succeeded' }
  mkTask('t_pending', { result_kind: 'partial', evidence: [pendingEv] })
  const r2 = await control.handle({ workspace_dir: WS, task_id: 't_pending', action: 'resume' }, ctx)
  assert(r2.next_action?.tool === 'code_check' && /unvalidated/.test(r2.next_action?.note || ''), '③c 尚无检查证据 → 保留 unvalidated 文案（得 ' + JSON.stringify(r2.next_action || null) + '）')
}

// ④ 在途：resume 给结构化 waiting 查询动作，不报 done
{
  mkTask('t_flight', { result_kind: 'partial', operations: [{ operation_id: 'op_run', kind: 'check', state: 'running' }] })
  const r = await control.handle({ workspace_dir: WS, task_id: 't_flight', action: 'resume' }, ctx)
  assert(r.next_action?.tool === 'code_control' && r.next_action?.progress === 'waiting', '④ resume 在途 → 结构化 waiting（得 ' + JSON.stringify(r.next_action || null) + '）')
  assert(r.progress !== 'done', '④ 在途不报 done（得 ' + r.progress + '）')
}

console.log('test-exit-projection: ' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)