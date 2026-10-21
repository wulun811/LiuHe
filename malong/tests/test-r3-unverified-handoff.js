// test-r3-unverified-handoff.js — R3/H06（0.5.14）检查交还与恢复一致性
// R3 现场：无检查目标的子目录检查（skipped/partial）后，code_check 说可以未验证交还，
// 但 resume 又无条件建议重跑 code_check 且不带 workdir（静默回工作区根）——两出口对同一状态给不同建议。
// 本测试锁定：① 重跑建议复用 checks/workdir/timeout/verifier；② 环境性未验证允许 partial/unverified 交还（optional）；
// ③ check/status/resume 三出口同口径；④ 补齐检查目标后显式重跑可推进到 validated；⑤ indeterminate 操作给核对清单。
import { join, dirname } from 'node:path'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP = join(os.tmpdir(), 'opencode', 'r3-unverified')
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
process.env.MALONG_STATE_DIR = join(TMP, 'state')
process.env.MALONG_ENTRY_STATE = '1'

let pass = 0, fail = 0
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  FAIL:', msg) } }
const imp = (p) => import(pathToFileURL(p).href)

const shared = await imp(join(__dirname, '..', 'tools', 'entry-shared.js'))
const control = await imp(join(__dirname, '..', 'tools', 'tool-code-control', 'handler.js'))
const check = await imp(join(__dirname, '..', 'tools', 'tool-code-check', 'handler.js'))

const WS = join(TMP, 'ws')
mkdirSync(join(WS, 'sub'), { recursive: true })
writeFileSync(join(WS, 'package.json'), JSON.stringify({ name: 'r3-ws' }))
writeFileSync(join(WS, 'sub', 'package.json'), JSON.stringify({ name: 'r3-sub' })) // 子目录无 test 脚本
writeFileSync(join(WS, 'a.js'), 'export const a = 1\n')

const t0 = new Date().toISOString()
const task = {
  task_id: 'task_r3', revision: 1, schema_version: 1, route: 'change', goal: 'r3', lifecycle: 'active', node: 'edit',
  workspace_dir: WS, goal_revision: 1, materials: [], candidates: [],
  operations: [
    { operation_id: 'op_w1', request_id: null, kind: 'patch', state: 'succeeded', file: 'a.js', result_kind: 'partial', updated: t0 },
    { operation_id: 'op_c1', request_id: 'rid-c1', kind: 'check', state: 'succeeded', checks: ['test'], workdir: 'sub', timeout: 30000, verifier: 'protocol', updated: t0 },
  ],
  evidence: [
    { evidence_id: 'ev1', kind: 'test', result: 'skipped', operation_id: 'op_c1', scope: 'sub', source: 'verify_pipeline', actual: { ran: false, notice: 'No test script in package.json; nothing to run.' }, created: t0 },
  ],
  result_kind: 'partial',
}
shared.putTask(WS, task, { type: 'task_created', task })
const ctx = {}

// ── ① 重跑建议复用上次 check 参数（workdir 不再丢失）──
{
  const na = shared.buildTaskNextAction({ workspaceDir: WS, task_id: 'task_r3', task: shared.getTask(WS, 'task_r3') })
  assert(na?.tool === 'code_check', '① partial 任务下一步指向 code_check（得 ' + JSON.stringify(na?.tool) + '）')
  assert(na?.args?.workdir === 'sub', '① 重跑建议带 workdir=sub（得 ' + JSON.stringify(na?.args) + '）')
  assert(Array.isArray(na?.args?.checks) && na.args.checks[0] === 'test', '① 复用 checks=[test]')
  assert(na?.args?.timeout === 30000 && na?.args?.verifier === 'protocol', '① 复用 timeout/verifier（得 ' + JSON.stringify({ t: na?.args?.timeout, v: na?.args?.verifier }) + '）')
  const reuse = shared.checkReuseArgs(shared.getTask(WS, 'task_r3'))
  assert(reuse.workdir === 'sub' && reuse.timeout === 30000, '① checkReuseArgs 直接复用（得 ' + JSON.stringify(reuse) + '）')
}

// ── ② 环境性未验证 → optional + unverified（允许 partial/unverified 交还，不循环重跑）──
{
  const na = shared.buildTaskNextAction({ workspaceDir: WS, task_id: 'task_r3', task: shared.getTask(WS, 'task_r3') })
  assert(na?.optional === true, '② 环境性未验证建议标 optional（得 ' + JSON.stringify(na?.optional) + '）')
  assert(na?.unverified?.reason === 'environment_limited' && na?.unverified?.kinds?.includes('test'), '② unverified 原因与范围（得 ' + JSON.stringify(na?.unverified) + '）')
  assert(String(na?.note || '').includes('Unverified') && /environment limitation/i.test(na.note), '② note 说明环境限制非代码缺陷（得 ' + na?.note + '）')
  const uv = shared.envUnverified(shared.getTask(WS, 'task_r3'))
  assert(uv && uv.operation_id === 'op_c1' && uv.detail.join('').includes('test:skipped'), '② envUnverified 取最近一组检查证据（得 ' + JSON.stringify(uv) + '）')
  // 若最近一组里出现真实失败 → 不再是环境性未验证
  const t2 = JSON.parse(JSON.stringify(shared.getTask(WS, 'task_r3')))
  t2.evidence.push({ evidence_id: 'ev2', kind: 'test', result: 'failed', operation_id: 'op_c1', scope: 'sub', created: t0 })
  assert(shared.envUnverified(t2) === null, '② 最近一组含真实失败 → 不归环境性未验证')
}

// ── ③ check/status/resume 三出口同口径（承认未验证、范围一致、不生成无条件同一检查循环）──
{
  const st = await control.handle({ workspace_dir: WS, task_id: 'task_r3', action: 'status' }, ctx)
  const rs = await control.handle({ workspace_dir: WS, task_id: 'task_r3', action: 'resume' }, ctx)
  assert(st.next_action?.args?.workdir === 'sub' && rs.next_action?.args?.workdir === 'sub', '③ status/resume next_action 均带 workdir=sub（得 ' + JSON.stringify({ s: st.next_action?.args, r: rs.next_action?.args }) + '）')
  assert(st.next_action?.optional === true && rs.next_action?.optional === true, '③ 两出口均标 optional（不承诺重跑必成）')
  assert(String(st.next_step || '').includes('Unverified') && String(rs.observation?.next_step || '').includes('Unverified'), '③ 两出口 next_step 同口径说明未验证（得 ' + String(rs.observation?.next_step).slice(0, 120) + '）')
  assert(!/run code_check\(run=true\)\.?$/i.test(String(rs.observation?.next_step || '')), '③ resume 不再给无条件「重跑 code_check」循环文案')
}

// ── ④ 显式重跑（复用同一 workdir）：仍是 skipped → 交还；补齐目标后重跑 → validated ──
{
  const r1 = await check.handle({ workspace_dir: WS, task_id: 'task_r3', checks: ['test'], workdir: 'sub', run: true, request_id: 'rid-c3' }, ctx)
  const ev1 = r1.observation?.evidence?.[0]
  assert(ev1?.result === 'skipped', '④ 子目录无目标 → skipped（得 ' + JSON.stringify(ev1?.result) + '）')
  assert(r1.next_action === null, '④ 环境性未验证 → check 不自指重跑（next_action=null）（得 ' + JSON.stringify(r1.next_action) + '）')
  assert(/unverified|environment/i.test(String(r1.next_step || '')), '④ check next_step 允许未验证交还（得 ' + String(r1.next_step).slice(0, 120) + '）')
  // 补齐检查目标（子目录加 test 脚本）→ 显式重跑推进
  writeFileSync(join(WS, 'sub', 't.test.cjs'), "console.log('1 passing')\n")
  writeFileSync(join(WS, 'sub', 'package.json'), JSON.stringify({ name: 'r3-sub', scripts: { test: 'node t.test.cjs' } }))
  const r2 = await check.handle({ workspace_dir: WS, task_id: 'task_r3', checks: ['test'], workdir: 'sub', run: true, request_id: 'rid-c2' }, ctx)
  const ev2 = r2.observation?.evidence?.[0]
  assert(ev2?.result === 'passed', '④ 补齐目标后重跑 → passed（得 ' + JSON.stringify(ev2?.result) + '）')
  assert(r2.observation?.result_kind === 'validated', '④ 有 patch + 全过 → validated（得 ' + r2.observation?.result_kind + '）')
  const na2 = shared.buildTaskNextAction({ workspaceDir: WS, task_id: 'task_r3', task: shared.getTask(WS, 'task_r3') })
  assert(na2 === null, '④ validated 且未陈旧 → done 空动作（得 ' + JSON.stringify(na2) + '）')
}

// ── ⑤ H06：indeterminate 操作的核对清单（已停止 ≠ 副作用已核对）──
{
  const t = JSON.parse(JSON.stringify(shared.getTask(WS, 'task_r3')))
  t.operations.push({
    operation_id: 'op_ind1', request_id: 'rid-ind', kind: 'patch', state: 'indeterminate', file: 'a.js',
    pre_file_hash: 'sha256:pre', intended_file_hash: 'sha256:intended', result_file_hash: null, reason: 'cancel could not be confirmed', updated: t0,
  })
  const t2 = { ...t, result_kind: 'partial' }
  shared.putTask(WS, t2, { type: 'operation', data: { operation: t2.operations[t2.operations.length - 1] } })
  const review = shared.indeterminateReview(shared.getTask(WS, 'task_r3'))
  assert(Array.isArray(review) && review.length === 1, '⑤ 核对清单包含 indeterminate 操作（得 ' + JSON.stringify(review) + '）')
  assert(review[0].operation_id === 'op_ind1' && review[0].file === 'a.js', '⑤ 核对清单给受影响文件与 operation_id')
  assert(review[0].pre_hashes?.['a.js'] === 'sha256:pre' && review[0].intended_hashes?.['a.js'] === 'sha256:intended', '⑤ 核对清单给 pre/intended 哈希')
  assert(/do not force-complete|do not blindly replay/i.test(review[0].check), '⑤ 核对指引不提供强制完成捷径')
  // N2（0.5.14 Windows 复核）：核对清单只用已知事实 + 明确未知范围 + 交还宿主判断；不再要求比对空哈希
  assert(review[0].effect_judgment === 'host_required', 'N2 ⑤ 核对清单声明 effect_judgment=host_required（得 ' + JSON.stringify(review[0].effect_judgment) + '）')
  assert(Array.isArray(review[0].known?.files) && review[0].known.files.includes('a.js') && /cancel could not be confirmed/.test(String(review[0].known?.reason)), 'N2 ⑤ known 复用已知文件与原因（得 ' + JSON.stringify(review[0].known) + '）')
  assert(Array.isArray(review[0].unknown) && review[0].unknown.some(u => /post-operation file hashes/.test(u)), 'N2 ⑤ unknown 明确未记录的哈希（得 ' + JSON.stringify(review[0].unknown) + '）')
  assert(Array.isArray(review[0].do_not) && review[0].do_not.length >= 3, 'N2 ⑤ 给出 do_not（停止≠回滚/不盲重放/不强制完成）（得 ' + JSON.stringify(review[0].do_not) + '）')
  assert(/Re-read\/re-hash a\.js/.test(String(review[0].host_check)), 'N2 ⑤ host_check 指向真实可查目标（得 ' + review[0].host_check + '）')
  const st = await control.handle({ workspace_dir: WS, task_id: 'task_r3', action: 'status' }, ctx)
  const rs = await control.handle({ workspace_dir: WS, task_id: 'task_r3', action: 'resume' }, ctx)
  assert(st.observation?.effect_unknown === true && Array.isArray(st.observation?.effect_review), '⑤ status 透出 effect_unknown + effect_review（得 ' + JSON.stringify({ u: st.observation?.effect_unknown }) + '）')
  assert(rs.observation?.effect_unknown === true && Array.isArray(rs.observation?.effect_review), '⑤ resume 透出 effect_unknown + effect_review')
  // N2：主 next_action 不再回 status/waiting 自指——按已知文件给具体核查动作
  assert(st.next_action?.tool === 'code_read' && st.next_action?.args?.locator?.file_path === 'a.js', 'N2 ⑤ status next_action=读受影响文件（不再 status/waiting）（得 ' + JSON.stringify({ t: st.next_action?.tool, a: st.next_action?.args }) + '）')
  assert(st.next_action?.progress === 'indeterminate' && st.next_action?.effect_judgment === 'host_required', 'N2 ⑤ 动作标 indeterminate + host_required')
  assert(!(st.next_action?.tool === 'code_control' && st.next_action?.progress === 'waiting'), 'N2 ⑤ 不得再给 status/waiting 自指')
  assert(/stopped ≠ rolled back|UNCONFIRMED/i.test(String(st.next_action?.note || '')), 'N2 ⑤ note 明确「已停止≠已回滚」（得 ' + st.next_action?.note + '）')
}

// ── ⑥ N2：无任何自动可查目标时不编造，明确交还宿主判断（tool=null + host_required）──
{
  const t = JSON.parse(JSON.stringify(shared.getTask(WS, 'task_r3')))
  t.operations = [{ operation_id: 'op_ind_nofile', kind: 'check', state: 'indeterminate', reason: 'killed' }]
  t.result_kind = 'partial'
  t.evidence = []
  shared.putTask(WS, { ...t, task_id: 'task_nofile' }, { type: 'task_updated' })
  const review = shared.indeterminateReview(shared.getTask(WS, 'task_nofile'))
  assert(review && review[0].unknown.some(u => /affected files/.test(u)), 'N2 ⑥ 未知范围显式列出（得 ' + JSON.stringify(review?.[0]?.unknown) + '）')
  assert(review && /Do not invent hashes/.test(String(review[0].host_check)), 'N2 ⑥ 无目标时不要求编造哈希（得 ' + review?.[0]?.host_check + '）')
  const st = await control.handle({ workspace_dir: WS, task_id: 'task_nofile', action: 'status' }, ctx)
  assert(st.next_action && st.next_action.tool === null && st.next_action.host_required === true, 'N2 ⑥ 无自动目标 → tool=null + host_required（得 ' + JSON.stringify(st.next_action) + '）')
  assert(/Host judgment required/.test(String(st.next_action?.note || '')), 'N2 ⑥ note 明确交还宿主判断')
  assert(/Stopped ≠ rolled back/.test(String(st.next_action?.note || '')), 'N2 ⑥ note 不把停止当回滚')
  assert(st.progress !== 'done', 'N2 ⑥ 不因未核清而强制置 done（得 ' + st.progress + '）')
}

console.log('\n=== test-r3-unverified-handoff: ' + pass + ' passed, ' + fail + ' failed ===')
process.exit(fail > 0 ? 1 : 0)
