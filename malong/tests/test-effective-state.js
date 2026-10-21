#!/usr/bin/env node
// test-effective-state.js — WP01 共享有效状态纯投影（workflow/effective-state.js）
// 覆盖：AC01（文件过期/目标切换）、AC18（同 kind 异 scope 独立）、AC28（receipt 与投影分离）、
// AC30（audit 适用性）、AC31（在途/不确定优先）、兼容 adapter（旧缺字段 unknown 不增强）、
// 纯读不修改任务、不跨调用假新鲜。
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL, fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = mkdtempSync(join(tmpdir(), 'malong-effstate-'))
process.env.MALONG_STATE_DIR = join(ROOT, 'state')
const ws = join(ROOT, 'ws')
mkdirSync(ws, { recursive: true })

const { projectEffectiveState, normalizeTaskRecord, inflightFacts } = await import(
  pathToFileURL(join(__dirname, '..', 'workflow', 'effective-state.js')).href
)
const { startJob, cancelJob } = await import(pathToFileURL(join(__dirname, '..', 'workflow', 'jobs.js')).href)
const { inflightOf } = await import(pathToFileURL(join(__dirname, '..', 'tools', 'entry-shared.js')).href)

let passed = 0
let failed = 0
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`) } else { failed++; console.log(`  ✗ ${msg}`) }
}
const sha = (s) => `sha256:${createHash('sha256').update(s).digest('hex')}`
const baseTask = (over = {}) => ({
  task_id: 'task_eff0001', revision: 7, workspace_dir: ws, route: 'change', node: 'orient',
  lifecycle: 'active', goal: 'g', created: '2026-10-09T00:00:00.000Z',
  materials: [], evidence: [], operations: [], ...over,
})

console.log('== normalizeTaskRecord（兼容 adapter）==')
{
  const legacy = { task_id: 'task_legacy', revision: 2, goal: 'old' } // 无 goal_revision/result_kind/lifecycle/集合字段
  const snapshot = JSON.stringify(legacy)
  const n = normalizeTaskRecord(legacy)
  assert(n.goal_revision === 1 && n.validated_goal_revision === null && n.result_kind === null, '旧缺字段按 1/null 兜底，不增强为 validated')
  assert(n.lifecycle === 'active' && n.terminal === false, 'lifecycle 缺失按 active 非终态')
  assert(Array.isArray(n.materials) && Array.isArray(n.evidence) && Array.isArray(n.operations), '集合字段缺失给空数组')
  assert(JSON.stringify(legacy) === snapshot, 'adapter 不改入参（unknown 默认不增强、原对象不动）')
  assert(normalizeTaskRecord({ lifecycle: 'done' }).terminal === true, '旧终态别名 done → terminal')
  assert(normalizeTaskRecord({ lifecycle: 'abandoned' }).terminal === true, '旧终态别名 abandoned → terminal')
  assert(normalizeTaskRecord({ lifecycle: 'completed' }).terminal === true, '旧终态别名 completed → terminal')
}

console.log('== 纯读契约：不改任务、不涨 revision、不跨调用假新鲜 ==')
{
  const f = join(ws, 'pure.js')
  writeFileSync(f, 'v1')
  const task = baseTask({ result_kind: 'validated', validated_goal_revision: 1, goal_revision: 1, evidence: [{ evidence_id: 'ev_p1', kind: 'test', result: 'passed', goal_revision: 1, depends_on: [{ file: 'pure.js', hash: sha('v1') }] }] })
  const before = JSON.stringify(task)
  const p1 = projectEffectiveState(ws, task)
  assert(task.revision === 7 && JSON.stringify(task) === before, '纯投影不改任务、revision 不变（status 口径）')
  assert(p1.progress === 'done' && p1.freshness.result_stale === false, 'validated 且依赖未变 → done/新鲜')
  writeFileSync(f, 'v2')
  const p2 = projectEffectiveState(ws, task)
  assert(p2.freshness.result_stale === true && p2.freshness.stale_reason === 'file_change', '外部改文件后重投影立即翻转（不跨调用缓存）')
  assert(p2.freshness.stale_scope === 'task_evidence' && typeof p2.freshness.stale_note === 'string' && /evidence chain/.test(p2.freshness.stale_note), 'P2 stale 带 scope/note：明示 stale 指向证据链（非本次返回内容）')
  assert(p1.freshness.stale_scope === undefined && p1.freshness.stale_note === undefined, 'P2 新鲜时不带 scope/note（不增噪声）')
  assert(p1.computed_at != null && p1.projection === 'effective_state', '投影带 computed_at/projection 标识（AC28 实时投影可区分）')
}

console.log('== AC01：文件过期保留历史 + goal_change ==')
{
  writeFileSync(join(ws, 'a.js'), 'A1')
  const task = baseTask({
    result_kind: 'validated', validated_goal_revision: 1, goal_revision: 1,
    evidence: [{ evidence_id: 'ev_a1', kind: 'test', result: 'passed', goal_revision: 1, depends_on: [{ file: 'a.js', hash: sha('A1') }] }],
  })
  writeFileSync(join(ws, 'a.js'), 'A2')
  const p = projectEffectiveState(ws, task)
  assert(p.freshness.result_stale === true && p.freshness.stale_reason === 'file_change' && p.freshness.stale_evidence.includes('ev_a1'), '文件过期 → stale/file_change 且指向证据')
  assert(task.evidence.length === 1 && task.evidence[0].result === 'passed', '历史证据保留不被投影删改（AC01：保留历史 passed）')
  assert(p.progress === 'stale', 'validated 但现实已变 → progress=stale（不进 done）')
  const g = projectEffectiveState(ws, baseTask({ result_kind: 'validated', validated_goal_revision: 1, goal_revision: 2 }))
  assert(g.freshness.result_stale === true && g.freshness.stale_reason === 'goal_change', 'goal_revision 漂移 → goal_change（检查不跨目标自指）')
  const legacyRev = projectEffectiveState(ws, baseTask({ result_kind: 'validated' }))
  assert(legacyRev.freshness.result_stale === false && legacyRev.goal_revision === 1 && legacyRev.validated_goal_revision === null, '旧记录无 revision 按 1 兼容，1===1 不误报漂移')
}

console.log('== AC18：同 kind 异 scope 证据独立失效 ==')
{
  writeFileSync(join(ws, 'f1.js'), 'x1')
  writeFileSync(join(ws, 'f2.js'), 'y1')
  const task = baseTask({
    evidence: [
      { evidence_id: 'ev_f1', kind: 'test', result: 'passed', goal_revision: 1, depends_on: [{ file: 'f1.js', hash: sha('x1') }] },
      { evidence_id: 'ev_f2', kind: 'test', result: 'passed', goal_revision: 1, depends_on: [{ file: 'f2.js', hash: sha('y1') }] },
    ],
  })
  writeFileSync(join(ws, 'f1.js'), 'x2')
  const p = projectEffectiveState(ws, task)
  assert(p.freshness.stale_evidence.includes('ev_f1') && !p.freshness.stale_evidence.includes('ev_f2'), '只有依赖漂移的那份过期，另一份独立保留')
  assert(p.applicability.evidence_current.length === 2, '异 scope 两份均为 current（后查不吞先查的范围证明）')
}

console.log('== AC30：审查证据适用性（scope/check identity 规则）==')
{
  writeFileSync(join(ws, 'r.js'), 'R1')
  const ok = projectEffectiveState(ws, baseTask({ route: 'review', evidence: [{ evidence_id: 'ev_r1', kind: 'audit:security_review', result: 'passed', goal_revision: 1, depends_on: [{ file: 'r.js', hash: sha('R1') }] }] }))
  assert(ok.applicability.audit_applicable === true, 'revision 匹配 + 确有运行 + 依赖未漂移 → applicable')
  const stale = projectEffectiveState(ws, baseTask({ route: 'review', goal_revision: 2, evidence: [{ evidence_id: 'ev_r2', kind: 'audit:security_review', result: 'passed', goal_revision: 1, depends_on: [{ file: 'r.js', hash: sha('R1') }] }] }))
  assert(stale.applicability.audit_applicable === false, '旧目标 revision 的 audit 不适用于新目标（有历史 audit ≠ 可交还完成）')
  const skipped = projectEffectiveState(ws, baseTask({ route: 'review', evidence: [{ evidence_id: 'ev_r3', kind: 'audit:security_review', result: 'skipped', goal_revision: 1 }] }))
  assert(skipped.applicability.audit_applicable === false, 'skipped（分析器未运行）不算适用')
  // AC30 补充：runner 失败 / 部分文件未扫描 / 扫描截断 / A 外部变化——不完整的证据不得当「适用」交还完成
  const errEv = { evidence_id: 'ev_r4', kind: 'audit:security_review', result: 'passed', goal_revision: 1, actual: { error: 'check_failed', errored_files: [{ file: 'r.js', error: 'check_failed' }] } }
  assert(projectEffectiveState(ws, baseTask({ route: 'review', evidence: [errEv] })).applicability.audit_applicable === false, 'AC30 runner 失败（error+errored）不算适用')
  const errEv2 = { evidence_id: 'ev_r5', kind: 'audit:security_review', result: 'passed', goal_revision: 1, actual: { error: null, errored_files: [{ file: 'r.js', error: 'check_failed' }] } }
  assert(projectEffectiveState(ws, baseTask({ route: 'review', evidence: [errEv2] })).applicability.audit_applicable === false, 'AC30 部分文件未扫描（errored_files）不算适用')
  const truncEv = { evidence_id: 'ev_r6', kind: 'audit:dead_code', result: 'passed', goal_revision: 1, actual: { scope: { kind: 'workspace', truncated: true } } }
  assert(projectEffectiveState(ws, baseTask({ route: 'review', evidence: [truncEv] })).applicability.audit_applicable === false, 'AC30 扫描截断（partial tree）不算适用')
  writeFileSync(join(ws, 'ra.js'), 'RA1')
  const depEv = { evidence_id: 'ev_r7', kind: 'audit:security_review', result: 'passed', goal_revision: 1, depends_on: [{ file: 'ra.js', hash: sha('RA1') }] }
  assert(projectEffectiveState(ws, baseTask({ route: 'review', evidence: [depEv] })).applicability.audit_applicable === true, 'AC30 A 审查后依赖未变 → 适用')
  writeFileSync(join(ws, 'ra.js'), 'RA2')
  assert(projectEffectiveState(ws, baseTask({ route: 'review', evidence: [depEv] })).applicability.audit_applicable === false, 'AC30 A 外部变化 → 不再适用（重审而非交还完成）')
  const failEv = { evidence_id: 'ev_r8', kind: 'audit:security_review', result: 'failed', goal_revision: 1 }
  assert(projectEffectiveState(ws, baseTask({ route: 'review', evidence: [failEv] })).applicability.audit_applicable === true, 'AC30 result=failed（审出 findings）仍是有效审查证据 → 适用（交还决策）')
}

console.log('== AC31：在途/不确定优先（取消/在途优先于完成）==')
{
  const running = projectEffectiveState(ws, baseTask({ result_kind: 'validated', validated_goal_revision: 1, goal_revision: 1, operations: [{ operation_id: 'op_run', kind: 'patch', state: 'running' }] }))
  assert(running.progress === 'in_flight' && running.in_flight.kind === 'op' && running.in_flight.count === 1, 'op 运行中 → in_flight 优先（不得提示 done/重新检查）')
  const indet = projectEffectiveState(ws, baseTask({ result_kind: 'validated', validated_goal_revision: 1, goal_revision: 1, operations: [{ operation_id: 'op_ind', kind: 'patch', state: 'indeterminate' }] }))
  assert(indet.progress === 'indeterminate' && indet.in_flight.kind === 'indeterminate', 'indeterminate 无 live writer → 单独成类（不确定 ≠ 完成也 ≠ 运行中）')
  assert(indet.freshness.result_stale === true && indet.freshness.stale_reason === 'pending_work', 'validated + indeterminate → freshness 同时给 pending_work 原因')
  const legacy = inflightOf(ws, baseTask({ task_id: 'task_shell', operations: [{ operation_id: 'op_run', kind: 'patch', state: 'running' }] }))
  const facts = inflightFacts(ws, baseTask({ task_id: 'task_shell', operations: [{ operation_id: 'op_run', kind: 'patch', state: 'running' }] }))
  assert(legacy && facts && legacy.kind === facts.kind && legacy.operation_id === facts.operation_id && legacy.state === facts.state, 'entry-shared.inflightOf 委托壳与唯一实现同口径')
  // live job 优先（run 遵守契约：signal abort 后尽快 settle）
  const j = startJob({ workspaceDir: ws, task_id: 'task_job', kind: 'sleep', run: ({ signal }) => new Promise((resolve) => { signal.addEventListener('abort', () => resolve({ ok: false }), { once: true }) }) })
  const withJob = projectEffectiveState(ws, baseTask({ task_id: 'task_job', result_kind: 'validated', validated_goal_revision: 1, goal_revision: 1 }))
  assert(withJob.progress === 'in_flight' && withJob.in_flight.kind === 'job' && withJob.in_flight.job_id === j.job_id, 'live job → in_flight（kind=job，带 job_id）')
  const cancelled = await cancelJob(ws, j.job_id, { waitMs: 2000 })
  assert(cancelled.cancelled === true, '清理：job 确认停止')
  await j.done
  const after = projectEffectiveState(ws, baseTask({ task_id: 'task_job', result_kind: 'validated', validated_goal_revision: 1, goal_revision: 1 }))
  assert(after.progress === 'done' && after.in_flight === null, 'job 终态后恢复 done（在途窗口收口）')
}

console.log('== AC28：receipt（历史回执）与 effective（实时投影）分离 ==')
{
  writeFileSync(join(ws, 'w.js'), 'W1')
  const recHash = sha('W1')
  const task = baseTask({
    result_kind: 'validated', validated_goal_revision: 1, goal_revision: 1,
    operations: [{ operation_id: 'op_w1', kind: 'patch', state: 'succeeded', file: 'w.js', result_file_hash: recHash, created: '2026-10-09T00:00:00.000Z' }],
  })
  const before = projectEffectiveState(ws, task)
  assert(before.freshness.result_stale === false && before.receipts.last_succeeded.result_file_hash === recHash, '回执与现实现一致 → 新鲜')
  writeFileSync(join(ws, 'w.js'), 'W2')
  const after = projectEffectiveState(ws, task)
  assert(after.freshness.result_stale === true && after.freshness.stale_reason === 'file_change', '外部改文件 → 实时投影翻转')
  assert(after.receipts.last_succeeded.result_file_hash === recHash && after.receipts.last_succeeded.operation_id === 'op_w1', '旧回执原文不改写（历史观测保留；变化只体现在 freshness 侧）')
}

console.log('== 取消/终态优先（AC05 投影侧）==')
{
  writeFileSync(join(ws, 'c.js'), 'C1')
  const task = baseTask({
    lifecycle: 'cancelled', result_kind: 'validated', validated_goal_revision: 1, goal_revision: 1,
    evidence: [{ evidence_id: 'ev_c1', kind: 'test', result: 'passed', goal_revision: 1, depends_on: [{ file: 'c.js', hash: sha('C1') }] }],
  })
  writeFileSync(join(ws, 'c.js'), 'C2')
  const p = projectEffectiveState(ws, task)
  assert(p.progress === 'cancelled' && p.lifecycle === 'cancelled' && p.terminal === true, '取消终态优先于 stale/partial/done')
  assert(p.freshness.result_stale === true, '取消任务的 freshness 仍如实计算（历史事实不因终态消失）')
  assert(p.in_flight === null, '取消态无在途误报')
}

console.log('== WP01 出口一致性：同快照 status/read/resume 同一有效性 + 纯读不涨 revision ==')
{
  const shared = await import(pathToFileURL(join(__dirname, '..', 'tools', 'entry-shared.js')).href)
  const control = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-code-control', 'handler.js')).href)
  const statusMod = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-code-status', 'handler.js')).href)
  const readMod = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-code-read', 'handler.js')).href)
  writeFileSync(join(ws, 'x.txt'), 'X1')
  const t = {
    task_id: 'task_exit1', revision: 1, route: 'change', goal: 'g', node: 'check', lifecycle: 'active',
    result_kind: 'validated', validated_goal_revision: 1, goal_revision: 1,
    materials: [], evidence: [], candidates: [], workspace_dir: ws,
    operations: [{ operation_id: 'op_x1', kind: 'patch', state: 'succeeded', file: 'x.txt', result_file_hash: sha('X1'), result_kind: 'partial' }],
  }
  shared.putTask(ws, t, { type: 'task_created', task: t })
  const s1 = await statusMod.handle({ workspace_dir: ws, task_id: 'task_exit1' })
  const s2 = await statusMod.handle({ workspace_dir: ws, task_id: 'task_exit1' })
  assert(s1.ok && s2.ok, 'status 出口可用')
  assert(s1.task.revision === 1 && s2.task.revision === 1, '纯状态读取两次 revision 不变（status 不持久化、不推进任务态）')
  assert(s1.observation.result_stale === false && s1.observation.progress === 'done' && s1.observation.goal_revision === 1, 'status 投影字段：新鲜/done/goal_revision')
  writeFileSync(join(ws, 'x.txt'), 'X2')
  const st = await statusMod.handle({ workspace_dir: ws, task_id: 'task_exit1' })
  const rs = await control.handle({ workspace_dir: ws, task_id: 'task_exit1', action: 'resume' })
  const rd = await readMod.handle({ workspace_dir: ws, task_id: 'task_exit1', locator: { file_path: 'x.txt' } }, { codeIndexService: null })
  assert(st.observation.result_stale === true && rs.observation.result_stale === true && rd.observation.result_stale === true, '外部改文件 → status/resume/read 三出口同判 result_stale（一个事实一个答案）')
  assert(st.observation.stale_reason === 'file_change' && rs.observation.stale_reason === 'file_change' && rd.observation.stale_reason === 'file_change', '三出口 stale_reason 一致（同一投影实现）')
  assert(st.observation.progress === 'stale' && rs.observation.progress === 'stale' && rd.observation.progress === 'stale', '三出口 progress=stale 一致')
  assert(typeof rd.observation.in_flight === 'number' && rd.observation.in_flight === 0, 'read 透出 in_flight 计数（WP01 统一口径）')
  assert(st.observation.result_stale === true && st.task.revision === 1, '外部变化后 status 仍不改写任务（投影只读）')
}

console.log('== AC31 出口：长 job 在跑时 status/read/resume 一致 waiting + job 身份可见 + 历史 passed 保留 ==')
{
  const shared = await import(pathToFileURL(join(__dirname, '..', 'tools', 'entry-shared.js')).href)
  const control = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-code-control', 'handler.js')).href)
  const statusMod = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-code-status', 'handler.js')).href)
  const readMod = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-code-read', 'handler.js')).href)
  writeFileSync(join(ws, 'y.txt'), 'Y1')
  const t = {
    task_id: 'task_inf1', revision: 1, route: 'change', goal: 'g', node: 'check', lifecycle: 'active',
    result_kind: 'validated', validated_goal_revision: 1, goal_revision: 1,
    materials: [], candidates: [], workspace_dir: ws,
    evidence: [{ evidence_id: 'ev_y1', kind: 'test', result: 'passed', goal_revision: 1, depends_on: [{ file: 'y.txt', hash: sha('Y1') }] }],
    operations: [{ operation_id: 'op_y1', kind: 'patch', state: 'succeeded', file: 'y.txt', result_file_hash: sha('Y1') }],
  }
  shared.putTask(ws, t, { type: 'task_created', task: t })
  const j = startJob({ workspaceDir: ws, task_id: 'task_inf1', kind: 'sleep', run: ({ signal }) => new Promise((resolve) => { signal.addEventListener('abort', () => resolve({ ok: false }), { once: true }) }) })
  const st = await statusMod.handle({ workspace_dir: ws, task_id: 'task_inf1' })
  const rs = await control.handle({ workspace_dir: ws, task_id: 'task_inf1', action: 'resume' })
  const rd = await readMod.handle({ workspace_dir: ws, task_id: 'task_inf1', locator: { file_path: 'y.txt' } }, { codeIndexService: null })
  assert(st.next_action?.progress === 'waiting' && st.next_action.args?.job_id === j.job_id, 'AC31 status 在途 → next_action waiting + job_id 可见')
  assert(rs.next_action?.progress === 'waiting' && rs.next_action.args?.job_id === j.job_id, 'AC31 resume 在途 → waiting + job_id 可见')
  assert(rd.next_action?.progress === 'waiting' && rd.next_action.args?.job_id === j.job_id, 'AC31 read 在途 → waiting + job_id 可见')
  assert(rs.observation.progress === 'in_flight' && !/done|finish/i.test(rs.observation.next_step || ''), 'AC31 resume 在途不提示 done/finish')
  assert(st.observation.progress === 'in_flight' && st.observation.operations?.in_flight >= 1, 'AC31 status 在途计数可见')
  assert(rs.observation.result_kind === 'validated' && st.observation.evidence?.total === 1, 'AC31 历史 passed 保留（在途不改写历史）')
  await cancelJob(ws, j.job_id, { waitMs: 2000 })
  await j.done
}

console.log('== P1（0.5.17 狗粮）：写后哈希 fallback 不得永久闩锁 ==')
{
  const f = join(ws, 'p1.js')
  const mk = (ops, evidence) => baseTask({
    task_id: 'task_p1', result_kind: 'validated', validated_goal_revision: 1, goal_revision: 1,
    evidence, operations: ops,
  })
  const batchOp = [{ operation_id: 'op_p1', kind: 'batch', state: 'succeeded', files: ['p1.js'], result_hashes: { 'p1.js': sha('v1') } }]
  const freshEv = [{ evidence_id: 'ev_p1', kind: 'test', result: 'passed', goal_revision: 1, depends_on: [{ file: 'p1.js', hash: sha('v2') }] }]

  writeFileSync(f, 'v2')
  const a = projectEffectiveState(ws, mk(batchOp, freshEv))
  assert(a.progress === 'done' && a.freshness.result_stale === false, 'P1-a 写后外部改 + 已重验（证据依赖 v2）→ done/新鲜（旧实现永久 stale）')

  const b = projectEffectiveState(ws, mk(batchOp, []))
  assert(b.progress === 'stale' && b.freshness.stale_reason === 'file_change', 'P1-b 写后外部改且无当前证据 → 仍判 stale（fallback 本意保留）')

  const c = projectEffectiveState(ws, mk(batchOp, [{ ...freshEv[0], depends_on: [{ file: 'p1.js', hash: sha('v1') }] }]))
  assert(c.progress === 'stale' && c.freshness.stale_reason === 'file_change', 'P1-c 证据依赖旧版本 → stale（证据链仍生效）')

  // undo 场景：最后写结果 v2，撤销回 v1，证据覆盖 v1
  writeFileSync(f, 'v1')
  const dOp = [{ operation_id: 'op_p1u', kind: 'batch', state: 'succeeded', files: ['p1.js'], result_hashes: { 'p1.js': sha('v2') } }]
  const dEv = [{ evidence_id: 'ev_p1u', kind: 'test', result: 'passed', goal_revision: 1, depends_on: [{ file: 'p1.js', hash: sha('v1') }] }]
  const d = projectEffectiveState(ws, mk(dOp, dEv))
  assert(d.progress === 'done' && d.freshness.result_stale === false, 'P1-d undo 回旧内容 + 重验 → done/新鲜（旧实现永久 stale）')
}

console.log(`\n=== test-effective-state: ${passed} passed, ${failed} failed ===`)
process.exit(failed ? 1 : 0)
