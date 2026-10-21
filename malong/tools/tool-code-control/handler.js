// code_control — S2 control surface: a CLOSED set of actions over an existing task.
// Actions: status | resume | cancel | switch_route | expand. No arbitrary tool_name / next_state (plan §6.1/§6.6).
// Read-only actions (status/resume/expand) never mutate; cancel/switch_route go through CAS and emit events.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeError, envelope, getTask, updateTaskCas, sha256Hex, ensureTaskVersion, taskHeader, inflightNote, completionProjection, buildTaskNextAction, indeterminateReview, lastCheckParams, checkScopeForJob, unknownTaskError } from '../entry-shared.js'
import { listJobs, getJob, cancelJob } from '../../workflow/jobs.js'
import { projectEffectiveState } from '../../workflow/effective-state.js'
import { windowed } from '../../workflow/output-budget.js'

export const ACTIONS = ['status', 'resume', 'cancel', 'switch_route', 'expand', 'reopen', 'job', 'cancel_job']
const ROUTE_ENUM = new Set(['understand', 'change', 'diagnose', 'review', 'maintain', 'document', 'isolate', 'system'])

export async function handle(args) {
  const workspaceDir = args?.workspace_dir
  if (typeof workspaceDir !== 'string' || !workspaceDir) {
    return makeError('missing_parameter', 'workspace_dir is required', 'Pass the absolute project root path.')
  }
  if (!existsSync(workspaceDir)) {
    return makeError('invalid_input', `workspace_dir not found: ${workspaceDir}`)
  }
  const task_id = args?.task_id
  if (typeof task_id !== 'string' || !task_id) {
    return makeError('missing_parameter', 'task_id is required', 'Call code_task first to obtain a task_id.')
  }
  const action = args?.action
  if (!ACTIONS.includes(action)) {
    return makeError('invalid_input', `action must be one of ${ACTIONS.join(', ')} (got ${action})`, 'Pick a control action.')
  }
  const task = getTask(workspaceDir, task_id)
  if (!task) {
    return unknownTaskError(workspaceDir, task_id)
  }
  if (task.workspace_dir !== workspaceDir) {
    return makeError('task_workspace_mismatch', `task ${task_id} belongs to a different workspace_dir`)
  }
  const ver = ensureTaskVersion(task)
  if (!ver.ok) {
    return makeError('task_version_unsupported', `task ${task_id} ${ver.message}`, 'Upgrade the server or start a new task with code_task.')
  }
  if (args?.expected_state_revision != null && args.expected_state_revision !== task.revision) {
    return makeError('revision_conflict', `expected_state_revision=${args.expected_state_revision}, current=${task.revision}`, 'Re-read code_control status and retry with the current revision.')
  }

  // WP01：有效状态统一取共享投影（status/resume 同一投影；不再各算口径）
  const p = projectEffectiveState(workspaceDir, task)
  switch (action) {
    case 'status': return doStatus(workspaceDir, task, p)
    case 'resume': return doResume(workspaceDir, task, p)
    case 'expand': return doExpand(task, args?.ref)
    case 'cancel': return doCancel(workspaceDir, task, args)
    case 'switch_route': return doSwitchRoute(workspaceDir, task, args)
    case 'reopen': return doReopen(workspaceDir, task, args)
    case 'job': return doJob(workspaceDir, task, args)
    case 'cancel_job': return await doCancelJob(workspaceDir, task, args)
    default: return makeError('invalid_input', `unhandled action: ${action}`)
  }
}

function opSummary(o) {
  return { operation_id: o.operation_id, kind: o.kind, state: o.state, file: o.file || null, request_id: o.request_id || null, result_kind: o.result_kind || null, updated: o.updated || o.created || null }
}
function evSummary(e) {
  return { evidence_id: e.evidence_id, kind: e.kind, result: e.result, operation_id: e.operation_id || null, duration_ms: e.actual?.duration_ms ?? null }
}
const pendingOf = (task) => (task.operations || []).filter(o => ['prepared', 'running', 'indeterminate'].includes(o.state))
const jobSummary = (j) => ({ job_id: j.job_id, kind: j.kind, state: j.state, operation_id: j.operation_id || null, started: j.started || null, finished: j.finished || null, heartbeat: j.heartbeat || null })
const liveJobs = (workspaceDir, task_id) => listJobs(workspaceDir, { task_id, limit: 0 }).filter(j => ['running', 'cancelling'].includes(j.state)).map(jobSummary)

function doStatus(workspaceDir, task, p) {
  const ops = task.operations || []
  const ev = task.evidence || []
  // H06（0.5.14）：不确定操作的核对清单（已停止 ≠ 副作用已核对）
  const effectReview = indeterminateReview(task, { workspaceDir })
  const nextAction = buildTaskNextAction({ workspaceDir, task_id: task.task_id, task, p })
  const opsWin = windowed(ops, 20)
  const evsWin = windowed(ev, 20)
  const opWin = opsWin.items.map(opSummary)
  const evWin = evsWin.items.map(evSummary)
  // 14-B AC03：机械要求满足 → done 合同（与 code_status/read/check 同源；WP01 取共享投影）
  const completion = completionProjection({ workspaceDir, task, p })
  return envelope({
    task: taskHeader(task),
    observation: {
      summary: `Task ${task.task_id} route=${task.route} node=${task.node} lifecycle=${task.lifecycle} result_kind=${task.result_kind || '-'}${p.freshness.result_stale ? ' (result_stale: ' + p.freshness.stale_reason + ')' : ''}. ops=${ops.length} evidence=${ev.length} materials=${(task.materials || []).length}.${effectReview ? ' ' + effectReview.length + ' indeterminate operation(s): effects unconfirmed — see effect_review.' : ''}`,
      goal: task.goal, route: task.route, node: task.node, lifecycle: task.lifecycle,
      result_kind: task.result_kind || null, result_stale: p.freshness.result_stale, stale_reason: p.freshness.stale_reason, goal_revision: p.goal_revision, progress: p.progress,
      cancel_reason: task.cancel_reason || null,
      index_scope: task.index_scope || null,
      stale_evidence: p.freshness.stale_evidence,
      counts: { materials: (task.materials || []).length, operations: ops.length, evidence: ev.length },
      ...(effectReview ? { effect_unknown: true, effect_review: effectReview } : {}),
      pending_operations: pendingOf(task).map(opSummary),
      pending_jobs: liveJobs(workspaceDir, task.task_id),
      operations: opWin, operations_truncated: opsWin.truncated, operations_omitted: opsWin.omitted,
      evidence: evWin, evidence_truncated: evsWin.truncated, evidence_omitted: evsWin.omitted,
    },
    allowed_actions: ['code_control', 'code_read', 'code_status'],
    extra: {
      next_action: nextAction,
      ...(completion ? { progress: completion.progress, mechanical_requirements_met: completion.mechanical_requirements_met, goal_judgment: completion.goal_judgment } : {}),
      next_step: completion ? completion.note : (nextAction && nextAction.note ? nextAction.note : 'code_control(action=resume) for a self-contained resume brief, or action=expand with a ref (full operation/evidence beyond the window).'),
    },
  })
}

function doResume(workspaceDir, task, p) {
  const ops = task.operations || []
  const ev = task.evidence || []
  const matWin = windowed(task.materials || [], 50)
  const evWin = windowed(ev, 20)
  const lastOp = ops.length ? ops[ops.length - 1] : null
  const allowed = allowedAfter(task, p.freshness.result_stale)
  // 13-B（专家 c2a83e4 P3-c）：失效原因分别说清——goal 变更 ≠ 文件变更（旧文案把换目标误写成 Target changed）
  // 14-A AC31：在途优先——resume 与 status/read 同口径，运行中不得提示「已完成/重新检查」（WP01 取共享投影）
  const flight = p.in_flight // WP01：在途取共享投影（原 inflightOf 独立扫描已收拢）
  // 14-B AC03：机械要求满足（validated 且未陈旧、非 review、无在途）→ done 空动作交还宿主
  const completion = completionProjection({ workspaceDir, task, p })
  const na = buildTaskNextAction({ workspaceDir, task_id: task.task_id, task, p })
  // H06（0.5.14）：不确定操作核对清单（与 status 同源）
  const effectReview = indeterminateReview(task, { workspaceDir })
  let next = flight
    ? inflightNote(flight)
    : (p.freshness.result_stale
    ? (p.freshness.stale_reason === 'goal_change'
      ? 'Goal/route changed after validation (goal_revision ' + (task.validated_goal_revision || 1) + '→' + (task.goal_revision || 1) + '): previous checks do not cover the new goal — re-run code_check(run=true), or code_audit on route=review.'
      : p.freshness.stale_reason === 'pending_work'
        ? 'Background result indeterminate: re-run code_check(run=true) before trusting the prior validation.'
        : 'Files changed after validation: re-run code_check(run=true) to refresh evidence.')
    : (task.lifecycle === 'cancelled' ? 'Task is cancelled (terminal): code_control(action=reopen) to continue this task, or start a new code_task.'
      : task.result_kind === 'validated' ? 'Selected checks passed; re-read (code_read) if you need details, or patch the next change.'
        : (task.result_kind === 'partial' ? (na && na.note ? na.note : 'Edit applied but not validated: run code_check(run=true).') : 'Locate/read candidates (code_read), then preview a change with code_patch.')))
  if (!flight && completion) next = completion.note // 14-B AC03：done 空动作口径覆盖
  // M3：检查尝试已停止、效果未核时，resume 的 next_step 必须与 next_action 同口径（不得再写「Selected checks passed」）。
  if (!flight && !completion && p.progress === 'indeterminate' && na && na.note) next = na.note
  return envelope({
    task: taskHeader(task),
    observation: {
      summary: `Resume brief for ${task.task_id} (route=${task.route}, node=${task.node}, lifecycle=${task.lifecycle}, result_kind=${task.result_kind || '-'}${p.freshness.result_stale ? ', result_stale: ' + p.freshness.stale_reason : ''}).`,
      goal: task.goal, route: task.route, node: task.node, lifecycle: task.lifecycle,
      result_kind: task.result_kind || null, result_stale: p.freshness.result_stale, stale_reason: p.freshness.stale_reason, goal_revision: p.goal_revision, progress: p.progress,
      cancel_reason: task.cancel_reason || null,
      index_scope: task.index_scope || null,
      stale_evidence: p.freshness.stale_evidence,
      materials: matWin.items.map(m => ({ read_ref: m.read_ref, canonical_path: m.canonical_path || null, locator: m.locator || null, symbol: m.symbol || null })),
      materials_truncated: matWin.truncated,
      materials_omitted: matWin.omitted,
      latest_operation: lastOp ? opSummary(lastOp) : null,
      pending_operations: pendingOf(task).map(opSummary),
      pending_jobs: liveJobs(workspaceDir, task.task_id),
      ...(effectReview ? { effect_unknown: true, effect_review: effectReview } : {}),
      evidence: evWin.items.map(evSummary),
      evidence_truncated: evWin.truncated,
      evidence_omitted: evWin.omitted,
      next_step: next,
    },
    allowed_actions: allowed,
    extra: {
      result_kind: task.result_kind || null, resume: true,
      next_action: na,
      ...(completion ? { progress: completion.progress, mechanical_requirements_met: completion.mechanical_requirements_met, goal_judgment: completion.goal_judgment } : {}),
    },
  })
}

function doExpand(task, ref) {
  if (typeof ref !== 'string' || !ref) {
    return makeError('missing_parameter', 'ref is required for action=expand', 'Pass an evidence_id, operation_id, read_ref, or "candidates".')
  }
  const ev = (task.evidence || []).find(e => e.evidence_id === ref)
  if (ev) return envelope({ task: taskHeader(task), observation: { summary: `Evidence ${ref} (${ev.kind}=${ev.result}).`, kind: 'evidence', item: ev }, allowed_actions: ['code_control', 'code_read', 'code_status'] })
  const op = (task.operations || []).find(o => o.operation_id === ref)
  if (op) return envelope({ task: taskHeader(task), observation: { summary: `Operation ${ref} (${op.kind}, state=${op.state}).`, kind: 'operation', item: op }, allowed_actions: ['code_control', 'code_read', 'code_status'] })
  const mat = (task.materials || []).find(m => m.read_ref === ref)
  if (mat) return envelope({ task: taskHeader(task), observation: { summary: `Material ${ref} (${mat.canonical_path || 'unknown'}).`, kind: 'material', item: mat }, allowed_actions: ['code_control', 'code_read', 'code_status'] })
  if (ref === 'candidates') return envelope({ task: taskHeader(task), observation: { summary: `${(task.candidates || []).length} candidate(s).`, kind: 'candidates', items: task.candidates || [] }, allowed_actions: ['code_control', 'code_read'] })
  return makeError('unknown_ref', `No evidence/operation/material/candidates match ref: ${ref}`, 'Use an id returned by code_control status.')
}

function doCancel(workspaceDir, task, args) {
  if (task.lifecycle === 'cancelled') {
    return envelope({ task: taskHeader(task), observation: { summary: `Task ${task.task_id} is already cancelled.`, cancelled: true, idempotent: true }, allowed_actions: ['code_control'] })
  }
  // §7.2：有在途写入（prepared/running）时 Task 不提前显示取消完成
  // live 审查 I4：无 request_id 的 async check 不产生 op，但 job 仍在跑——必须把 live job 也算在途，
  // 否则 cancel 宣称成功、job 完成后仍会把 validated 写进已取消任务
  // 第二轮审查：indeterminate 无活 writer（否则早已被收口/重试核对）——cancel 时收口为 abandoned 并放行，
  // 否则待办 op 永久阻塞 cancel、task 永不 terminal、prune 永不回收
  const pending = pendingOf(task)
  const blocking = pending.filter(o => o.state !== 'indeterminate')
  const indeterminate = pending.filter(o => o.state === 'indeterminate')
  const running = liveJobs(workspaceDir, task.task_id)
  if (blocking.length || running.length) {
    return envelope({
      task: taskHeader(task),
      observation: {
        summary: `Cannot confirm cancel: ${blocking.length} operation(s) in-flight${running.length ? ` and ${running.length} live job(s)` : ''} (cancel ≠ rollback). Resolve them first, or cancel the job via code_control(action="cancel_job").`,
        cancelled: false, ambiguous: true, blocked_by: blocking.map(opSummary), pending_jobs: running,
      },
      allowed_actions: ['code_control', 'code_check', 'code_status'],
    })
  }
  const now = new Date().toISOString()
  const abandonedIds = indeterminate.map(o => o.operation_id)
  const prevNode = task.node || null
  const cas = updateTaskCas(workspaceDir, task.task_id, task.revision, (t) => {
    t.lifecycle = 'cancelled'
    if (prevNode) t.cancelled_from_node = prevNode
    t.node = 'cancelled'
    if (args?.reason) t.cancel_reason = args.reason
    if (abandonedIds.length) {
      const ids = new Set(abandonedIds)
      t.operations = (t.operations || []).map(o => ids.has(o.operation_id)
        ? { ...o, state: 'abandoned', updated: now, reason: 'cancel: outcome indeterminate, abandoned (cancel ≠ rollback)' }
        : o)
    }
    return { type: 'lifecycle', data: { lifecycle: 'cancelled', node: 'cancelled', prev_node: prevNode, reopen_hint: 'code_control(action="reopen")', reason: args?.reason || null, abandoned_operations: abandonedIds } }
  })
  if (!cas.ok) return makeError(cas.code === 'REVISION_CONFLICT' ? 'revision_conflict' : 'task_not_found', `cancel failed: ${cas.code}`, 'Retry with the current revision.')
  return envelope({
    task: taskHeader(cas.task),
    observation: {
      summary: `Task ${task.task_id} cancelled${args?.reason ? ` (${args.reason})` : ''}${abandonedIds.length ? `; ${abandonedIds.length} indeterminate operation(s) abandoned` : ''}. No in-flight writes; cancel ≠ rollback (code_control(action="reopen") to continue).`,
      cancelled: true, reason: args?.reason || null, cancel_reason: args?.reason || null, abandoned_operations: abandonedIds,
    },
    allowed_actions: ['code_control'],
  })
}

// LH-001：显式恢复（cancel 的对称出口）——仅 cancelled 任务可 reopen；在途操作/活 job 拒绝。
function doReopen(workspaceDir, task, args) {
  if (task.lifecycle !== 'cancelled') {
    return makeError('not_cancelled', `task ${task.task_id} lifecycle=${task.lifecycle}; reopen only applies to a cancelled task.`, 'Only cancelled tasks can be reopened.')
  }
  const pending = pendingOf(task).filter(o => !['indeterminate', 'abandoned'].includes(o.state))
  const running = liveJobs(workspaceDir, task.task_id)
  if (pending.length || running.length) {
    return envelope({
      task: taskHeader(task),
      observation: {
        summary: `Cannot reopen: ${pending.length} operation(s) in-flight${running.length ? ` and ${running.length} live job(s)` : ''}. Resolve them first.`,
        reopened: false, blocked_by: pending.map(opSummary), pending_jobs: running,
      },
      allowed_actions: ['code_control', 'code_status'],
    })
  }
  const restoredNode = task.cancelled_from_node || 'read'
  const cas = updateTaskCas(workspaceDir, task.task_id, task.revision, (t) => {
    t.lifecycle = 'active'
    t.node = restoredNode
    return { type: 'lifecycle', data: { lifecycle: 'active', reopened: true, from: 'cancelled', node: restoredNode, reason: args?.reason || null } }
  })
  if (!cas.ok) return makeError(cas.code === 'REVISION_CONFLICT' ? 'revision_conflict' : 'task_not_found', `reopen failed: ${cas.code}`, 'Retry with the current revision.')
  return envelope({
    task: taskHeader(cas.task),
    observation: {
      summary: `Task ${task.task_id} reopened (lifecycle=active, node restored to ${restoredNode}). Writes are allowed again; cancel reason retained.`,
      reopened: true, from: 'cancelled', lifecycle: 'active', node: restoredNode, goal_revision: cas.task.goal_revision || 1,
      cancel_reason: cas.task.cancel_reason || null,
    },
    allowed_actions: ['code_read', 'code_status', 'code_patch', 'code_control'],
  })
}

function doSwitchRoute(workspaceDir, task, args) {
  const route = args?.route
  if (!ROUTE_ENUM.has(route)) {
    return makeError('invalid_input', `route must be one of ${[...ROUTE_ENUM].join(', ')}`, 'Provide a valid route.')
  }
  const nextGoalRev = (task.goal_revision || 1) + 1
  const newGoal = typeof args?.goal === 'string' && args.goal.trim() ? args.goal : task.goal
  const cas = updateTaskCas(workspaceDir, task.task_id, task.revision, (t) => {
    t.route = route
    t.goal = newGoal
    t.goal_revision = nextGoalRev
    return { type: 'route_changed', data: { route, goal: newGoal, goal_revision: nextGoalRev } }
  })
  if (!cas.ok) return makeError(cas.code === 'REVISION_CONFLICT' ? 'revision_conflict' : 'task_not_found', `switch_route failed: ${cas.code}`, 'Retry with the current revision.')
  return envelope({
    task: taskHeader(cas.task),
    observation: {
      summary: `Route switched to ${route} (goal_revision ${nextGoalRev}). Prior evidence/materials retained; re-validate if the goal changed.`,
      route, goal: newGoal, goal_revision: nextGoalRev, evidence_retained: (task.evidence || []).length,
    },
    allowed_actions: ['code_control', 'code_read', 'code_check', 'code_status'],
  })
}

// 查询 job（单个或本任务全部）；不修改状态
function doJob(workspaceDir, task, args) {
  const jobId = args?.job_id
  if (jobId) {
    const j = getJob(workspaceDir, jobId)
    if (!j || j.task_id !== task.task_id) return makeError('job_not_found', `No job ${jobId} for task ${task.task_id}`)
    return envelope({ task: taskHeader(task), observation: { summary: `Job ${jobId} kind=${j.kind} state=${j.state}.`, job: j }, allowed_actions: ['code_control', 'code_check', 'code_status'] })
  }
  const jobs = listJobs(workspaceDir, { task_id: task.task_id })
  return envelope({ task: taskHeader(task), observation: { summary: `${jobs.length} job(s) for ${task.task_id}.`, jobs: jobs.map(jobSummary) }, allowed_actions: ['code_control', 'code_check', 'code_status'] })
}

// 取消 job（T13）：确认停止 → cancelled；无法确认 → ambiguous（≠ 回滚）
async function doCancelJob(workspaceDir, task, args) {
  const jobId = args?.job_id
  if (typeof jobId !== 'string' || !jobId) {
    return makeError('missing_parameter', 'job_id is required for action=cancel_job', 'Query with action="job" first.')
  }
  const j = getJob(workspaceDir, jobId)
  if (!j || j.task_id !== task.task_id) return makeError('job_not_found', `No job ${jobId} for task ${task.task_id}`)
  const r = await cancelJob(workspaceDir, jobId, { waitMs: args?.wait_ms || 5000 })
  const effectUnknown = !!(r.cancelled || r.ambiguous)
  // N2（0.5.14 Windows 复核）：取消后的核对指引用「已知事实 + 未知范围 + 宿主判断」，不编造哈希、不把停止当回滚。
  // M2（2026-10-19 专家 Windows 复核）：范围必须以**被取消的这个 job** 为权威——旧实现用 lastCheckParams，
  // 同任务里更早的带 request_id 检查（operation）会抢占：取消 scope-B/120000 的 job 却报 scope-A/30000。
  // 现在只按该 job 的 operation_id 关联补全；无关联时用 job.params 快照，找不到就如实说未记录。
  const jp = (j && typeof j.params === 'object' && j.params) || {}
  const checkCtx = checkScopeForJob(task, j) || (Array.isArray(jp.checks) && jp.checks.length
    ? { checks: [...jp.checks], workdir: jp.workdir != null ? jp.workdir : null, timeout: jp.timeout != null ? jp.timeout : null, verifier: jp.verifier || null, source: 'job' }
    : null)
  return envelope({
    task: taskHeader(task),
    observation: {
      summary: r.cancelled
        ? `Job ${jobId} cancelled (process stopped). Side effects are NOT verified (cancel ≠ rollback; stopped ≠ effect checked) — review effect_review before retrying.`
        : `Job ${jobId} state=${r.state}${r.ambiguous ? '; stop not confirmed (cancel ≠ rollback)' : ''}.`,
      job_id: jobId, cancelled: !!r.cancelled, confirmed: !!r.confirmed, ambiguous: !!r.ambiguous, state: r.state,
      stopped: !!r.cancelled,
      effect_unknown: effectUnknown,
      ...(effectUnknown ? {
        effect_review: [{
          job_id: jobId,
          kind: j.kind || null,
          operation_id: j.operation_id || null,
          state: r.state || null,
          stopped: !!r.cancelled,
          known: {
            ...(j.kind ? { kind: j.kind } : {}),
            ...(j.operation_id ? { operation_id: j.operation_id } : {}),
            ...(checkCtx ? { checks: checkCtx.checks } : {}),
            ...(checkCtx && checkCtx.workdir != null ? { workdir: checkCtx.workdir } : {}),
            ...(checkCtx && checkCtx.timeout != null ? { timeout: checkCtx.timeout } : {}),
            ...(checkCtx && checkCtx.verifier ? { verifier: checkCtx.verifier } : {}),
            ...(checkCtx?.source ? { scope_source: checkCtx.source } : {}),
            job_state: r.state || null,
          },
          unknown: ['file hashes of any partially written files (jobs do not record them)', 'whether the interrupted process completed its last write'],
          effect_judgment: 'host_required',
          host_check: checkCtx
            ? 'Process stopped. Re-run the recorded check(s) (' + checkCtx.checks.join(',') + ') in the SAME scope (workdir=' + (checkCtx.workdir != null ? checkCtx.workdir : '<workspace root>') + (checkCtx.timeout != null ? ', timeout=' + checkCtx.timeout : '') + (checkCtx.verifier ? ', verifier=' + checkCtx.verifier : '') + ') to re-establish the current revision state — that does not prove a rollback; judge the effect yourself.'
            : 'Inspect the workspace for partial effects you can observe. No check scope was recorded for this job; do not invent hashes.',
          do_not: ['Treat the stop as a rollback (cancel ≠ rollback).', 'Blind-replay the same request_id.', 'Force-complete without checking the effect.'],
        }],
      } : {}),
    },
    allowed_actions: ['code_control', 'code_check', 'code_status'],
  })
}

// 13-B：陈旧判定统一走 workflow/evidence.effectiveState（三出口共用；原 computeStale 逻辑迁入）

function allowedAfter(task, stale) {
  if (task.lifecycle === 'cancelled') return ['code_control', 'code_read']
  const a = new Set(['code_control', 'code_status', 'code_read'])
  if (task.result_kind === 'validated' && !stale) a.add('code_read')
  else { a.add('code_patch'); a.add('code_check') }
  if (stale) a.add('code_check')
  return [...a]
}