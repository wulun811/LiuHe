// code_read — S1 只读入口：在已有 code_task 下读取符号/文件（复用 read_symbol 原语）。
import { handle as readSymbolHandle } from '../tool-read-symbol/handler.js'
import { makeError, envelope, getTask, updateTaskCas, traceId, ensureTaskVersion, taskHeader, buildTaskNextAction, completionProjection, unknownTaskError } from '../entry-shared.js'
import { projectEffectiveState } from '../../workflow/effective-state.js'
import { projectRichRead } from './rich-projection.js'

export async function handle(args, context) {
  const workspaceDir = args?.workspace_dir
  if (typeof workspaceDir !== 'string' || !workspaceDir) {
    return makeError('missing_parameter', 'workspace_dir is required')
  }
  const task_id = args?.task_id
  if (typeof task_id !== 'string' || !task_id) {
    return makeError('missing_parameter', 'task_id is required', 'Call code_task first to obtain a task_id.')
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
    return makeError('revision_conflict', `expected_state_revision=${args.expected_state_revision}, current=${task.revision}`, 'Re-read code_status and retry with the current revision.')
  }

  let locator = args?.locator
  if ((!locator || typeof locator !== 'object') && typeof args?.read_ref === 'string') {
    const m = task.materials.find(x => x.read_ref === args.read_ref)
    if (!m) {
      return makeError('read_ref_not_found', `Unknown read_ref: ${args.read_ref}`, 'Use a read_ref returned by a previous code_read in this task.')
    }
    locator = m.locator
  }
  if (!locator || typeof locator !== 'object') {
    return makeError('missing_parameter', 'locator or read_ref is required')
  }

  const readMode = args?.mode === 'rich' ? 'rich' : 'core'
  const r = await readSymbolHandle({
    workspace_dir: workspaceDir,
    locator,
    mode: readMode,
    budget_hint: args?.budget_hint,
    context_lines: args?.context_lines,
    source: 'live',
    on_ambiguous: 'fail',
  }, context)

  if (r?.error) {
    return {
      ok: false,
      error: r.error,
      code: r.code || r.error,
      message: r.message,
      ...(r.candidates ? { candidates: r.candidates } : {}),
      ...(r.suggestion ? { suggestion: r.suggestion } : {}),
      trace_id: r.trace_id || traceId(),
    }
  }

  const canonical = locator.file_path
    || (locator.symbol_id && context?.codeIndexService?.getSymbolByStableId?.(locator.symbol_id)?.file_path)
    || null

  // LH-001：cancelled 任务不落材料（终态 node 不被翻转），read_ref 不发放；仍允许读内容做核对
  const cancelled = task.lifecycle === 'cancelled'
  let read_ref = cancelled ? null : `read_${task.materials.length + 1}`
  const materialBase = {
    locator,
    canonical_path: canonical,
    symbol: r.symbol ? { name: r.symbol.name, kind: r.symbol.kind, symbol_id: r.symbol.symbol_id, range: r.symbol.range } : null,
    file_version: r.version?.file || null,
    symbol_version: r.version?.symbol || null,
  }
  let cas = { ok: true, task }
  if (!cancelled) {
    // P2 修复（2026-10-12 狗粮）：同任务并发读的 CAS 冲突有界重试——读是幂等追加材料，适合乐观重试；
    // 旧实现并行调用下直接 revision_conflict（LLM 天然并行 → 无谓失败；且报文里 expected_state_revision=undefined 不可理解）。
    // 写路径不做自动重试（并发写必须显式冲突，防覆盖）。
    for (let attempt = 0; ; attempt++) {
      const base = getTask(workspaceDir, task_id)
      if (!base) return unknownTaskError(workspaceDir, task_id)
      let usedRef = `read_${(base.materials || []).length + 1}`
      cas = updateTaskCas(workspaceDir, task_id, base.revision, (t) => {
        usedRef = `read_${(t.materials || []).length + 1}`
        const material = { read_ref: usedRef, ...materialBase }
        t.materials.push(material)
        t.node = 'read'
        return { type: 'material_added', data: { read_ref: usedRef, material, node: 'read' } }
      })
      if (cas.ok) { read_ref = usedRef; break }
      if (cas.code !== 'REVISION_CONFLICT' || attempt >= 9) {
        return makeError(
          cas.code === 'REVISION_CONFLICT' ? 'revision_conflict' : 'task_not_found',
          cas.code === 'REVISION_CONFLICT'
            ? `concurrent same-task update (base=${base.revision}, current=${cas.current}); auto-retried 10x — retry this call.`
            : `Unknown task_id: ${task_id}`,
        )
      }
    }
  }

  // 15-C（专家 621f6f8 §4.3）：read 显式透出 freshness 投影（WP01：取共享投影，与 status/control/check 同源）
  const p = projectEffectiveState(workspaceDir, cas.task || task)
  const rich = projectRichRead(readMode, r)
  const observation = {
    summary: r.symbol?.name
      ? `Read ${r.symbol.kind || 'symbol'} ${r.symbol.name} in ${canonical || 'file'}`
      : `Read ${canonical || 'file'}`,
    scope: canonical ? [`${canonical}${r.symbol?.name ? `::${r.symbol.name}` : ''}`] : [],
    target: {
      canonical_path: canonical,
      locator,
      file_version: materialBase.file_version,
      symbol_version: materialBase.symbol_version,
    },
    body_excerpt: r.symbol?.text || '',
    read_refs: read_ref ? [read_ref] : [],
    truncated: r.budget?.truncated || false,
    ...(r.budget?.truncated ? { warning: 'Body truncated at budget ' + String(r.budget?.effective ?? '') + ' chars (requested ' + String(r.budget?.requested ?? '') + '). Options: read a symbol or line_range, or budget_hint=0 for the whole body (can be large).' } : {}),
    result_stale: p.freshness.result_stale,
    stale_reason: p.freshness.stale_reason,
    ...(p.freshness.stale_scope ? { stale_scope: p.freshness.stale_scope, stale_note: p.freshness.stale_note } : {}),
    in_flight: p.in_flight ? p.in_flight.count : 0,
    progress: p.progress,
    index_status: r.index_status || null,
    budget: r.budget || null,
    ...rich,
    ...(cancelled ? { note: 'Task is cancelled (terminal): content read only — nothing was recorded. code_control(action=reopen) to continue, or start a new code_task.' } : {}),
  }

  const na = buildTaskNextAction({ workspaceDir, task_id, task, read_ref, locator, canonical, p })
  // 14-B AC03：null = done 空动作（工具侧完成，宿主判断业务目标）
  const completion = na === null ? completionProjection({ workspaceDir, task, p }) : null
  return envelope({
    task: taskHeader(cas.task),
    observation,
    allowed_actions: ['code_read', 'code_status'],
    extra: {
      ...(read_ref ? { read_ref } : {}),
      next_action: na,
      ...(completion ? { progress: completion.progress, mechanical_requirements_met: completion.mechanical_requirements_met, goal_judgment: completion.goal_judgment } : {}),
      next_step: cancelled
        ? 'Task is cancelled (terminal); code_control(action=reopen) to continue, or start a new code_task.'
        : (completion ? completion.note : 'Follow next_action (structured args), or code_read another candidate.'),
      ...(cancelled ? { warning: 'task_cancelled_read_not_recorded' } : {}),
    },
  })
}
