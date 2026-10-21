// workflow/effective-state.js — WP01 共享有效状态纯投影（计划 §15/WP01）
// 事实采集（哈希读盘 / job 扫描）集中在一次调用内完成并复用；投影为纯函数：不落盘、不改任务、
// 不增长 revision、不跨调用缓存（同毫秒重写 mtime 不变会假新鲜，每次调用重采事实）。
// 所有出口（code_status / code_read / code_control status+resume / code_check followup / next_action）
// 只消费本模块的投影结果——一个事实一个答案（验收：同快照各出口有效性一致）。
// 分层契约（AC28）：receipt = 历史 Operation 回执（不可变事实，不改写）≠ effective = 实时投影（随现实变）。
import { effectiveState, currentEvidence, hasApplicableAuditEvidence } from './evidence.js'
import { listJobs } from './jobs.js'
import { scopeOfAttempt, stoppedAttemptResolutions, resolvedStoppedCheckOperationIds } from './check-attempts.js'

// 旧缺字段兼容 adapter：读时兜默认值，unknown 默认不增强（不把字段缺失猜成 validated/passed）。
// 兼容点收拢（历史口径出处）：goal_revision/validated_goal_revision 缺失按 1（evidence.js:133,149、
// entry-shared.js:466）；终态别名 done/abandoned/completed（entry-store.js:234-235 同口径）；
// 集合字段缺失给空数组。返回浅拷贝，不改入参。
export function normalizeTaskRecord(task) {
  if (!task || typeof task !== 'object') return task
  const rawLifecycle = task.lifecycle
  const terminal = ['cancelled', 'completed', 'done', 'abandoned'].includes(String(rawLifecycle || ''))
  return {
    ...task,
    goal_revision: task.goal_revision ?? 1,
    validated_goal_revision: task.validated_goal_revision ?? null,
    result_kind: task.result_kind ?? null,
    lifecycle: rawLifecycle == null ? 'active' : rawLifecycle,
    terminal,
    materials: Array.isArray(task.materials) ? task.materials : [],
    evidence: Array.isArray(task.evidence) ? task.evidence : [],
    operations: Array.isArray(task.operations) ? task.operations : [],
  }
}

// 在途事实（收拢 entry-shared.inflightOf 与 control.pendingOf/liveJobs 的口径为唯一实现）：
// live job（running/cancelling）优先于在途 op（prepared/running）；indeterminate op 无 live writer
// 单独成类（不确定 ≠ 运行中，AC31：确认停止前不得提示 done/重新检查）。
export function inflightFacts(workspaceDir, task) {
  let job = null
  try {
    const jobs = listJobs(workspaceDir, { task_id: task?.task_id, limit: 0 })
      .filter(j => ['running', 'cancelling'].includes(j.state))
    if (jobs.length) job = jobs[0]
  } catch {}
  const ops = Array.isArray(task?.operations) ? task.operations : []
  // S2（2026-10-19 专家 Windows 复核三）：带 request_id 的检查尝试（indeterminate operation）若已被
  // 更新、同范围的确定重验收口，就不再算作在途不确定——否则本函数优先于覆盖 resolver，
  // 同范围成功重验也会永远卡在 indeterminate（无 request_id 的路径却能收口，两条身份路径不一致）。
  // 只收口 check 类；写操作（patch/batch/…）的 indeterminate 永不被检查覆盖。
  let settledCheckOpIds = new Set()
  try { settledCheckOpIds = resolvedStoppedCheckOperationIds(task, { workspaceDir }) } catch {}
  const indeterminate = ops.filter(o => o?.state === 'indeterminate' &&
    !(o?.kind === 'check' && o?.operation_id && settledCheckOpIds.has(o.operation_id)))
  const activeOps = ops.filter(o => ['prepared', 'running'].includes(o?.state))
  const indetIds = indeterminate.map(o => o?.operation_id ?? null)
  if (job) {
    return { count: 1 + activeOps.length + indeterminate.length, kind: 'job', state: job.state, job_id: job.job_id ?? null, operation_id: null, indeterminate_ops: indetIds, what: `job ${job.job_id} (${job.kind || 'job'})` }
  }
  if (activeOps.length) {
    const o = activeOps[0]
    return { count: activeOps.length + indeterminate.length, kind: 'op', state: o.state, job_id: null, operation_id: o.operation_id ?? null, indeterminate_ops: indetIds, what: `operation ${o.operation_id} (${o.kind || 'op'})` }
  }
  if (indeterminate.length) {
    return { count: indeterminate.length, kind: 'indeterminate', state: 'indeterminate', job_id: null, operation_id: indeterminate[0]?.operation_id ?? null, indeterminate_ops: indetIds, what: `operation ${indeterminate[0]?.operation_id} (indeterminate)` }
  }
  return null
}

// 完整投影（计划 §12 派生 + WP01 合同）：
//   progress 判定优先级（取消/在途/不确定优先于完成）：cancelled > terminal > in_flight > indeterminate
//   > stale > partial > done > open；
//   freshness 来自 evidence.effectiveState（13-B 统一口径：goal_change > file_change > pending_work）；
//   applicability.audit_applicable 给审查证据的 scope/revision 适用性（AC30，review 完成由 audit 驱动）；
//   receipts 保留历史回执原文（AC28：外部改文件后旧回执不改写，现实变化只在 freshness 侧）。
// M3（2026-10-19 专家 Windows 复核）：最新一次检查尝试被停止（cancel 无法确认/已停）且之后没有确定结果时，
// progress=indeterminate——旧的「A 成功证据 + B 已取消」仍投影 done（next_action=null + mechanical_requirements_met）
// 与 effect_unknown=true 自相矛盾，LLM 会据此提前交还。历史证据保留，只在 completion 出口拦住。
export function projectEffectiveState(workspaceDir, taskInput) {
  const task = normalizeTaskRecord(taskInput)
  let eff = { result_stale: false, stale_reason: null, stale_evidence: [] }
  try { eff = effectiveState(workspaceDir, task) } catch {}
  const flight = inflightFacts(workspaceDir, task)
  const evidenceCurrent = currentEvidence(task)
  let auditApplicable = null
  try { auditApplicable = hasApplicableAuditEvidence(workspaceDir, task) } catch {}
  // S1/S2：停止尝试的收口事实只有一处来源（check-attempts）——每条停止尝试各自找同范围后继。
  let resolutions = []
  try { resolutions = stoppedAttemptResolutions(task, { workspaceDir }) } catch { resolutions = [] }
  const unresolvedList = resolutions.filter(r => !r.resolved_by).map(r => r.attempt)
  const resolvedStops = resolutions.filter(r => r.resolved_by)
  const unresolved = unresolvedList[0] || null
  const unresolvedScope = unresolved ? scopeOfAttempt(unresolved) : null
  // S2：pending_work 只由**未被同范围确定重验收口**的不确定操作支撑（写操作永远计入）。
  if (eff.result_stale && eff.stale_reason === 'pending_work') {
    let settledIds = new Set()
    try { settledIds = resolvedStoppedCheckOperationIds(task, { workspaceDir }) } catch {}
    const liveIndet = task.operations.filter(o => o?.state === 'indeterminate' &&
      !(o?.kind === 'check' && o?.operation_id && settledIds.has(o.operation_id)))
    if (!liveIndet.length) eff = { result_stale: false, stale_reason: null, stale_evidence: [] }
  }
  const lastSucceeded = [...task.operations].reverse().find(o => o?.state === 'succeeded') || null
  let progress
  if (task.lifecycle === 'cancelled') progress = 'cancelled'
  else if (task.terminal) progress = 'terminal'
  else if (flight && flight.kind !== 'indeterminate') progress = 'in_flight'
  else if (flight) progress = 'indeterminate'
  else if (unresolved) progress = 'indeterminate'
  else if (eff.result_stale) progress = 'stale'
  else if (task.result_kind === 'partial') progress = 'partial'
  else if (task.result_kind === 'validated') progress = 'done'
  else progress = 'open'
  return {
    projection: 'effective_state',
    computed_at: new Date().toISOString(),
    lifecycle: task.lifecycle,
    terminal: task.terminal,
    route: task.route ?? null,
    goal_revision: task.goal_revision,
    validated_goal_revision: task.validated_goal_revision,
    result_kind: task.result_kind,
    progress,
    freshness: {
      result_stale: eff.result_stale,
      stale_reason: eff.stale_reason,
      stale_evidence: eff.stale_evidence,
      // P2 修复（2026-10-12 狗粮）：stale 语义显式化——result_stale 指「任务证据链 vs 当前文件」，
      // 不是「本次调用返回的内容过期」（LLM 实测两度误读：刚 validated 的 read 也带 true 而内容是新拉的）。
      ...(eff.result_stale ? { stale_scope: 'task_evidence', stale_note: 'Stale refers to the task evidence chain vs current files — not to this call returned content; see stale_evidence[] for which entries.' } : {}),
    },
    in_flight: flight,
    // M3：当前未决的检查尝试（已停止/无法确认，且之后没有确定结果）——带范围，供恢复建议复用同一 scope。
    ...(unresolved ? {
      unresolved_check: {
        attempt_id: unresolved.attempt_id ?? null,
        state: unresolved.state ?? null,
        job_id: unresolved.job_id ?? null,
        operation_id: unresolved.operation_id ?? null,
        ...(unresolvedScope ? { scope: unresolvedScope } : {}),
      },
      // S1：全部未收口的停止尝试（每条各自找同范围后继）；unresolved_check 保留为最新一条（兼容）。
      unresolved_checks: unresolvedList.slice(0, 10).map(a => {
        const sc = scopeOfAttempt(a)
        return {
          attempt_id: a.attempt_id ?? null,
          state: a.state ?? null,
          job_id: a.job_id ?? null,
          operation_id: a.operation_id ?? null,
          ...(sc ? { scope: sc } : {}),
        }
      }),
    } : {}),
    // S2：已由更新、同范围的确定重验收口的停止尝试——「当前同范围验证已建立」与
    // 「当时那次运行的外部副作用是否已核对」分开表达（后者仍属宿主判断）。
    ...(resolvedStops.length ? {
      resolved_checks: resolvedStops.slice(0, 10).map(r => ({
        attempt_id: r.attempt.attempt_id ?? null,
        state: r.attempt.state ?? null,
        job_id: r.attempt.job_id ?? null,
        operation_id: r.attempt.operation_id ?? null,
        resolved_by: {
          attempt_id: r.resolved_by.attempt_id ?? null,
          state: r.resolved_by.state ?? null,
          time: r.resolved_by.time || null,
        },
      })),
    } : {}),
    applicability: {
      audit_applicable: auditApplicable,
      evidence_current: evidenceCurrent.map(ev => ({
        evidence_id: ev?.evidence_id ?? null,
        kind: ev?.kind || 'unknown',
        result: ev?.result ?? null,
        goal_revision: ev?.goal_revision ?? 1,
      })),
    },
    receipts: {
      operations_total: task.operations.length,
      last_succeeded: lastSucceeded ? {
        operation_id: lastSucceeded.operation_id ?? null,
        kind: lastSucceeded.kind ?? null,
        file: lastSucceeded.file ?? null,
        result_file_hash: lastSucceeded.result_file_hash ?? null,
        result_hashes: lastSucceeded.result_hashes ?? null,
        updated: lastSucceeded.updated ?? lastSucceeded.created ?? null,
      } : null,
    },
    // WP05：候选→阅读→支持结论链路指标（纯投影）——候选被读过多少（按文件对账）、
    // 证据多少；不判定“读了对否”（支持结论归模型），只给可观测出口
    pipeline: (() => {
      const normP = (f) => String(f || '').replace(/\\/g, '/').replace(/^\.\//, '')
      const candFiles = new Set((Array.isArray(task.candidates) ? task.candidates : []).map(c => normP(c?.file_path || c?.locator?.file_path || '')).filter(Boolean))
      const readFiles = new Set((task.materials || []).map(m => normP(m?.canonical_path || m?.locator?.file_path || '')).filter(Boolean))
      let candidatesRead = 0
      for (const f of candFiles) if (readFiles.has(f)) candidatesRead++
      return { candidates: candFiles.size, candidates_read: candidatesRead, reads: readFiles.size, evidence: (task.evidence || []).length }
    })(),
  }
}
