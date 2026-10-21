// code_status — S1 只读入口：任务/材料摘要（不持久化）。
import { makeError, envelope, getTask, listTasks, ensureTaskVersion, ACTIONS_NOTE, buildTaskNextAction, completionProjection, unknownTaskError } from '../entry-shared.js'
import { capped } from '../../workflow/output-budget.js'
import { currentEvidence } from '../../workflow/evidence.js'
import { projectEffectiveState } from '../../workflow/effective-state.js'

export async function handle(args) {
  const workspaceDir = args?.workspace_dir
  if (typeof workspaceDir !== 'string' || !workspaceDir) {
    return makeError('missing_parameter', 'workspace_dir is required')
  }

  const task_id = args?.task_id
  if (typeof task_id === 'string' && task_id) {
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
    const mats = capped((task.materials || []).map(m => ({ read_ref: m.read_ref, locator: m.locator, symbol: m.symbol, canonical_path: m.canonical_path })), 50)
    // dogfood-050 P3：状态简报补 node/evidence/operations 摘要（旧只有材料列表，醒来后看不到任务态势）
    const evidence = Array.isArray(task.evidence) ? task.evidence : []
    // 14-B AC18：同 kind 按 scope 取代后投影（异 scope 证据独立可见，不再被同 kind 最新吞并）
    const evLatest = currentEvidence(task).map(ev => ({
      kind: ev?.kind || 'unknown',
      result: ev?.result ?? null,
      evidence_id: ev?.evidence_id ?? null,
      files: [...new Set((ev?.depends_on || []).filter(d => d?.file).map(d => d.file))].sort(),
    }))
    // WP01：有效状态取共享投影（与 read/control/check 同一实现）；observation 增 goal_revision/progress
    const p = projectEffectiveState(workspaceDir, task)
    const staleEvidence = p.freshness.stale_evidence
    const ops = Array.isArray(task.operations) ? task.operations : []
    const inFlight = p.in_flight ? p.in_flight.count : 0
    // 8-B：下一步按真实状态生成（lifecycle/result_kind/route），不再固定「S1 只读」
    const nextAction = buildTaskNextAction({ workspaceDir, task_id, task, p })
    // 14-B AC03：null = done 空动作；合同字段与说明由同一判定透出（与 read/check/control 同源）
    const completion = nextAction === null ? completionProjection({ workspaceDir, task, p }) : null
    const nextStep = completion
      ? completion.note
      : (task.lifecycle === 'cancelled'
        ? 'Task is cancelled (terminal); code_control(action=reopen) to continue, or start a new code_task.'
        : (task.result_kind === 'partial'
          ? 'Unvalidated edit pending (result_kind=partial): follow next_action (code_check), or code_read another candidate.'
          : 'Follow next_action (structured args), or code_read another candidate.'))
    return envelope({
      task: { task_id: task.task_id, revision: task.revision, route: task.route, node: task.node, lifecycle: task.lifecycle },
      observation: {
        summary: `Task ${task.task_id} (route=${task.route}, node=${task.node || 'n/a'}) holds ${task.materials.length} read material(s); evidence ${evidence.length} (stale ${staleEvidence.length}); operations ${ops.length}${inFlight ? ` (${inFlight} in-flight)` : ''}${mats.truncated ? ` (showing ${mats.items.length}, ${mats.omitted} more — expand by read_ref)` : ''}.`,
        node: task.node || null,
        result_stale: p.freshness.result_stale, stale_reason: p.freshness.stale_reason,
        goal_revision: p.goal_revision, progress: p.progress,
        // WP05：候选→阅读→支持结论链路指标（纯投影透出）
        pipeline: p.pipeline,
        evidence: { total: evidence.length, latest: evLatest, stale_ids: staleEvidence },
        operations: { total: ops.length, in_flight: inFlight },
        goal: task.goal,
        materials: mats.items,
        materials_truncated: mats.truncated,
        read_refs: (task.materials || []).map(m => m.read_ref),
      },
      allowed_actions: [...new Set(['code_read', 'code_status', nextAction?.tool].filter(Boolean))],
      extra: {
        next_action: nextAction,
        ...(completion ? { progress: completion.progress, mechanical_requirements_met: completion.mechanical_requirements_met, goal_judgment: completion.goal_judgment } : {}),
        next_step: nextStep, actions_note: ACTIONS_NOTE,
      },
    })
  }

  const list = listTasks(workspaceDir)
  // 累计列表：按 created 倒序（最新在前，缺 created 时稳定回落 task_id）后取前 20
  const sorted = [...list].sort((a, b) => String(b.created || b.task_id).localeCompare(String(a.created || a.task_id)))
  const tasks = capped(sorted, 20)
  // 第二轮审查："active" 计数必须排除 cancelled（旧把已取消任务也算活跃）
  const activeCount = list.filter(t => t.lifecycle !== 'cancelled').length
  return envelope({
    task: null,
    observation: {
      summary: `${list.length} task(s) in this workspace (${activeCount} active)${tasks.truncated ? ` (showing latest ${tasks.items.length})` : ''}.`,
      tasks: tasks.items.map(t => ({ task_id: t.task_id, route: t.route, node: t.node || null, goal: t.goal, materials: (t.materials || []).length, evidence: (t.evidence || []).length, revision: t.revision })),
      tasks_truncated: tasks.truncated,
      active_count: activeCount,
    },
    allowed_actions: ['code_read'],
    extra: { next_step: list.length ? 'Pass task_id to inspect a specific task.' : 'Call code_task to start a task.', actions_note: ACTIONS_NOTE },
  })
}