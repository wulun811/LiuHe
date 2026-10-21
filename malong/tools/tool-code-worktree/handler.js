// code_worktree — S5.4a typed git_worktree stages (preview / apply / status).
// Delegates the actual git transaction to classic git_worktree, but persists ONE operation
// (kind 'worktree') with request_id dedup, so a merge-failed-but-commit-preserved outcome is
// recoverable across sessions (classic returns it ephemerally only) and reviewed via evidence.
import { existsSync } from 'node:fs'
import {
  makeError, envelope, getTask, updateTaskCas, findOperation, payloadHash, newOperationId,
  newEvidenceId, operationEvent, ensureTaskVersion, fileHash, sha256Hex, assertTaskWritable, taskHeader, unknownTaskError,
} from '../entry-shared.js'
import { handle as gitWorktreeHandle } from '../tool-git-worktree/handler.js'
import { normalizeChanges, previewChanges, classifyWorktreeResult, WORKTREE_RULES_VERSION } from '../../workflow/worktree.js'

const ACTIONS = ['preview', 'apply', 'status']

export async function handle(args, context) {
  const workspaceDir = args?.workspace_dir
  if (typeof workspaceDir !== 'string' || !workspaceDir) {
    return makeError('missing_parameter', 'workspace_dir is required', 'Pass the absolute project root path.')
  }
  if (!existsSync(workspaceDir)) return makeError('invalid_input', `workspace_dir not found: ${workspaceDir}`)
  const task_id = args?.task_id
  if (typeof task_id !== 'string' || !task_id) {
    return makeError('missing_parameter', 'task_id is required', 'Call code_task first to obtain a task_id.')
  }
  const task = getTask(workspaceDir, task_id)
  if (!task) return unknownTaskError(workspaceDir, task_id)
  if (task.workspace_dir !== workspaceDir) return makeError('task_workspace_mismatch', `task ${task_id} belongs to a different workspace_dir`)
  const ver = ensureTaskVersion(task)
  if (!ver.ok) return makeError('task_version_unsupported', `task ${task_id} ${ver.message}`, 'Upgrade the server or start a new task with code_task.')
  if (args?.expected_state_revision != null && args.expected_state_revision !== task.revision) {
    return makeError('revision_conflict', `expected_state_revision=${args.expected_state_revision}, current=${task.revision}`, 'Re-read code_control status and retry with the current revision.')
  }

  const action = args?.action || 'preview'
  if (!ACTIONS.includes(action)) return makeError('invalid_input', `action must be preview/apply/status (got ${action})`)

  if (action === 'status') {
    // LH-001：终态守卫——cancelled 任务的状态查询也拒绝（走 code_control status）
    const g = assertTaskWritable(task)
    if (g) return g
    return doStatus(workspaceDir, task)
  }

  const norm = normalizeChanges(args?.changes)
  if (!norm.ok) return makeError(norm.error, norm.message, 'Each change: {path, new_content} or {path, delete:true}.')
  const changes = norm.changes

  // ── preview（默认，不触 git、不写盘）──
  const dryRun = action === 'preview' || args?.dry_run !== false
  if (dryRun) {
    // LH-001：终态守卫——cancelled 任务拒绝新副作用操作（含 preview）
    const guard = assertTaskWritable(task)
    if (guard) return guard
    const items = previewChanges(workspaceDir, changes)
    // 狗粮r2 修复：显式 action=apply 但未带 dry_run:false → 仍是预览（安全默认不变），
    // 但必须显式告知「未应用」，避免误以为已提交（旧实现静默只回 action=preview）。
    const applyRequested = action === 'apply' && args?.dry_run !== false
    const effective = items.filter(i => i.changed || i.action === 'delete').length
    return envelope({
      task: taskHeader(task),
      observation: {
        summary: applyRequested
          ? `Worktree PREVIEW only — action=「apply」 was ignored because dry_run was not set to false; nothing applied (${changes.length} change(s), ${effective} effective). Re-issue with dry_run:false to run the transaction.`
          : `Worktree preview: ${changes.length} change(s) (${effective} effective). No file changed, no git action.`,
        effect: 'preview', dry_run: true, action: 'preview', changes: items,
        ...(applyRequested ? { applied: false, warning: 'action=「apply」 requires dry_run:false — this call was a PREVIEW; no file/git change. Use next_action.args (dry_run:false) to apply.' } : {}),
        verify_cmd: args?.verify_cmd || null,
        // R5（0.5.14 复审修复）：应用前说清副作用——apply 会提交并更新当前基分支（不是仅返回隔离目录）
        base: { ref: 'HEAD', branch: 'current', note: 'apply starts from the current HEAD of the checked-out branch' },
        apply_plan: {
          commits_to_base_branch: true,
          steps: [
            'create a temporary git worktree from the current HEAD',
            'write the listed changes',
            ...(args?.verify_cmd ? ['run verify_cmd — non-zero aborts and rolls back'] : []),
            'git commit',
            'fast-forward merge into the CURRENT branch (HEAD moves)',
          ],
          failure_behavior: 'verify failure → rollback (base branch unchanged); merge failure → commit preserved on a branch (see apply result, merge manually)',
          touches_files: changes.map(c => c.path),
        },
      },
      allowed_actions: ['code_worktree', 'code_read', 'code_status'],
      extra: {
        next_action: {
          tool: 'code_worktree',
          args: {
            workspace_dir: workspaceDir,
            task_id,
            action: 'apply',
            dry_run: false,
            changes: args?.changes,
            ...(args?.message ? { message: args.message } : {}),
            ...(args?.verify_cmd ? { verify_cmd: args.verify_cmd } : {}),
            ...(args?.request_id ? { request_id: args.request_id } : {}),
          },
          note: applyRequested
            ? 'Nothing was applied (dry_run was not false). Call code_worktree with these args (dry_run:false) to actually run the transaction.'
            : 'Preview only (no file changed, no git action). Call code_worktree with these args to run the transaction.',
        },
        next_step: 'Preview only. To run, call code_worktree with next_action.args (action=apply, dry_run=false).',
      },
    })
  }

  // ── apply（委派 classic git_worktree，持久化单操作 + 证据）──
  const payload_hash = payloadHash({
    task_id, kind: 'worktree', message: args?.message || null, verify_cmd: args?.verify_cmd || null,
    // live 审查 J1：含 new_content 正文——旧实现只记 len，同长度不同内容被静默幂等去重（新内容从未落盘）
    changes: changes.map(c => ({ path: c.path, exists: c.new_content !== undefined ? 'content' : 'delete', content: typeof c.new_content === 'string' ? c.new_content : null })),
  })
  let op = findOperation(task, args?.request_id)
  if (op && op.payload_hash !== payload_hash) {
    return makeError('request_conflict', `request_id ${args.request_id} was used with a different payload`, 'Use a fresh request_id for a different worktree transaction.')
  }
  if (op && op.state === 'succeeded') {
    return envelope({
      task: taskHeader(task),
      observation: {
        summary: `Deduplicated: worktree transaction already committed (${op.operation_id}).`,
        deduplicated: true, effect: 'git_commit', result_kind: task.result_kind || 'partial',
        branch: op.branch || null, commit: op.commit || null, operation: op,
      },
      allowed_actions: ['code_worktree', 'code_read', 'code_status'],
      extra: { request_id: args.request_id, result_kind: task.result_kind || 'partial' },
    })
  }

  // 第二轮审查（worktree W1/W3）：同 request_id 重试不得盲目重跑 git 事务
  // indeterminate（含保留分支）→ 幂等返回现状，需重试请换新 request_id
  if (op && op.state === 'indeterminate') {
    return envelope({
      task: taskHeader(task),
      observation: {
        summary: `Worktree transaction already attempted and left indeterminate (${op.operation_id})${op.branch ? `; branch "${op.branch}" preserved — merge manually` : ''}. Use a new request_id to retry.`,
        deduplicated: true, recovered: true, committed: false, effect: op.preserved ? 'git_commit' : 'none', preserved: !!op.preserved,
        branch: op.branch || null, commit: op.commit || null, operation: op,
      },
      allowed_actions: ['code_worktree', 'code_read', 'code_control', 'code_status'],
      extra: { request_id: args.request_id, ...(op.preserved ? { warning: 'commit_preserved_branch' } : {}) },
    })
  }
  // LH-001：终态守卫——cancelled 任务拒绝新副作用操作（上面的 succeeded/indeterminate dedup 复读已放行）
  const guard = assertTaskWritable(task)
  if (guard) return guard

  // prepared 重试：先核对文件状态（全 intended → 已应用收口；全 pre → 安全重放；混合 → indeterminate）
  if (op && op.state === 'prepared' && op.pre_hashes) {
    const files = op.files || []
    const pre = op.pre_hashes || {}
    const intended = op.intended_hashes || {}
    const cur = {}
    for (const f of files) cur[f] = fileHash(workspaceDir, f)
    const allIntended = files.length > 0 && files.every(f => intended[f] !== undefined && cur[f] === intended[f])
    const allPre = files.length > 0 && files.every(f => pre[f] !== undefined && cur[f] === pre[f])
    if (allIntended) {
      const nowIso = new Date().toISOString()
      const fin = { ...op, state: 'succeeded', updated: nowIso, result_kind: 'partial', recovered: true, current_hashes: cur }
      let casR = null
      for (let i = 0; i < 3; i++) {
        const curT = getTask(workspaceDir, task_id)
        if (!curT) break
        casR = updateTaskCas(workspaceDir, task_id, curT.revision, (t) => operationEvent(t, fin, { node: 'worktree', result_kind: 'partial' }))
        if (casR.ok) break
      }
      if (!casR || !casR.ok) return makeError('state_commit_pending', `recovered worktree detected but state commit raced (${casR?.code || 'task_gone'}); retry with the same request_id`, 'Retry with the same request_id to finalize.')
      return envelope({
        task: taskHeader(casR.task),
        observation: {
          summary: `Recovered: worktree changes were already applied before the interruption (${op.operation_id}); finalized without re-running git.`,
          deduplicated: true, recovered: true, committed: true, effect: 'git_commit', result_kind: 'partial',
          branch: op.branch || null, commit: op.commit || null, files, operation: fin,
        },
        allowed_actions: ['code_read', 'code_check', 'code_control', 'code_status'],
        extra: { request_id: args.request_id, result_kind: 'partial' },
      })
    }
    if (!allPre) {
      const nowIso = new Date().toISOString()
      const fin = { ...op, state: 'indeterminate', updated: nowIso, current_hashes: cur }
      try { updateTaskCas(workspaceDir, task_id, task.revision, (t) => operationEvent(t, fin, { node: 'worktree' })) } catch {}
      return makeError('indeterminate', `worktree operation ${op.operation_id} is indeterminate: files are in a mixed/external state (neither all pre-write nor all intended).`, 'Re-read and use a new request_id; do not blind-retry.')
    }
    // allPre → 安全重放
  }

  const runner = context?.worktreeRunner || gitWorktreeHandle
  let currentRev = task.revision
  let prepared = op
  if (args?.request_id && !op) {
    prepared = {
      operation_id: newOperationId(), request_id: args.request_id, payload_hash,
      state: 'prepared', kind: 'worktree', files: changes.map(c => c.path),
      pre_hashes: Object.fromEntries(changes.map(c => [c.path, fileHash(workspaceDir, c.path)])),
      intended_hashes: Object.fromEntries(changes.map(c => [c.path, typeof c.new_content === 'string' ? `sha256:${sha256Hex(c.new_content)}` : null])),
      message: args?.message || null, verify_cmd: args?.verify_cmd || null, created: new Date().toISOString(),
    }
    const cas = updateTaskCas(workspaceDir, task_id, task.revision, (t) => operationEvent(t, prepared, { node: 'worktree' }))
    if (!cas.ok) {
      return makeError(
        cas.code === 'REVISION_CONFLICT' ? 'revision_conflict' : 'task_not_found',
        cas.code === 'REVISION_CONFLICT' ? `task revision changed: expected=${task.revision}, current=${cas.current}` : `Unknown task_id: ${task_id}`,
      )
    }
    currentRev = cas.task.revision
  }

  let r = null
  try {
    r = await runner({ workspace_dir: workspaceDir, changes, message: args?.message, verify_cmd: args?.verify_cmd, timeout: args?.timeout }, { codeIndexService: context?.codeIndexService })
  } catch (e) {
    r = { success: false, error: 'runner_threw', message: e?.message || String(e) }
  }
  const cls = classifyWorktreeResult(r)
  // 狗粮r3（P2）：失败回滚的事务未产生任何副作用——不再让 effect 谎称 git_commit、也不再继承
  // 旧 task.result_kind（可能为 'validated'）冒充本次结果；仅成功/保留分支才声明。
  const rolledBack = cls.opState === 'failed' && !cls.preserved
  const gitEffect = (cls.opState === 'succeeded' || cls.preserved) ? 'git_commit' : 'none'
  const now = new Date().toISOString()
  const finalOp = {
    ...(prepared || {
      operation_id: newOperationId(), request_id: null, payload_hash, kind: 'worktree',
      files: changes.map(c => c.path), message: args?.message || null, verify_cmd: args?.verify_cmd || null, created: now,
    }),
    state: cls.opState, updated: now,
    ...(r?.commit ? { commit: r.commit } : {}),
    ...(r?.branch ? { branch: r.branch } : {}),
    ...(r?.error ? { error: r.error } : {}),
    ...(r?.error && r?.message ? { error_detail: String(r.message).slice(0, 4000) } : {}),
    ...(cls.preserved ? { preserved: true, recovery: r?.detail || null } : {}),
  }
  // live 审查 J2：CAS 冲突有界重试（每次读最新 revision）；旧实现单次失败即丢 operation 记录
  // （去重失效、提示同 id 重试会重跑 git 事务），且 committed:false 与 summary 自相矛盾
  let cas2 = null
  for (let i = 0; i < 3; i++) {
    const cur = getTask(workspaceDir, task_id)
    if (!cur) break
    cas2 = updateTaskCas(workspaceDir, task_id, cur.revision, (t) => operationEvent(t, finalOp, { node: 'worktree', ...(rolledBack ? {} : { result_kind: 'partial' }) }))
    if (cas2.ok) break
  }
  if (!cas2 || !cas2.ok) {
    return envelope({
      task: { task_id, revision: getTask(workspaceDir, task_id)?.revision ?? currentRev, route: task.route, node: 'worktree', lifecycle: task.lifecycle },
      observation: {
        summary: `Worktree transaction ${cls.opState}, but task state commit failed (${cas2?.code || 'task_gone'}) — operation record NOT persisted; retry will re-run the git transaction.`,
        effect: gitEffect, committed: cls.opState === 'succeeded', ...(rolledBack ? {} : { result_kind: 'partial' }), operation: finalOp,
      },
      allowed_actions: ['code_worktree', 'code_read', 'code_status'],
      extra: { request_id: args?.request_id, warning: 'state_commit_pending' },
    })
  }

  const ev = {
    evidence_id: newEvidenceId(), kind: 'worktree:apply', result: cls.result, operation_id: finalOp.operation_id,
    source: 'git_worktree', provenance: { via: 'delegate', tool: 'git_worktree' },
    rule_version: WORKTREE_RULES_VERSION, depends_on: [],
    actual: { files: changes.length, ...(r?.commit ? { commit: r.commit } : {}), ...(r?.branch ? { branch: r.branch } : {}), ...(r?.error ? { error: r.error, ...(r?.message ? { message: String(r.message).slice(0, 1000) } : {}) } : {}) },
    limitations: [
      ...(cls.preserved ? ['commit created but ff-merge failed; branch preserved — merge manually, do NOT delete it'] : []),
      ...(cls.opState === 'failed' ? ['transaction rolled back; no changes remain'] : []),
    ],
    created: now,
  }
  const cas3 = updateTaskCas(workspaceDir, task_id, cas2.task.revision, (t) => {
    t.evidence = [...(t.evidence || []), ev]
    return { type: 'evidence', data: { evidences: [ev], node: 'worktree' } }
  })

  const summary = cls.opState === 'succeeded'
    ? `Committed ${changes.length} file(s) on the base branch (commit ${String(r?.commit || '').slice(0, 12)}). result_kind=partial (run code_check to validate).`
    : cls.preserved
      ? `Transaction failed but commit preserved on branch "${r?.branch}"; recover manually (git merge/cherry-pick). Not rolled back.`
      : 'Transaction rolled back (' + (r?.error || 'failed') + '); no changes remain.' + (r?.message ? ' Reason: ' + String(r.message).split('\n')[0].slice(0, 200) : '')

  return envelope({
    task: taskHeader({ ...task, revision: cas3.ok ? cas3.task.revision : cas2.task.revision, node: 'worktree' }),
    observation: {
      summary, effect: gitEffect, committed: cls.opState === 'succeeded',
      ...(rolledBack ? {} : { result_kind: cls.opState === 'succeeded' ? 'partial' : (task.result_kind || 'analysis_only') }),
      branch: finalOp.branch || null, commit: finalOp.commit || null, files: changes.map(c => c.path),
      ...(r?.verify ? { verify: r.verify } : {}),
      operation: finalOp, evidence: ev,
    },
    allowed_actions: ['code_read', 'code_check', 'code_control', 'code_status'],
    extra: {
      request_id: args?.request_id, ...(rolledBack ? {} : { result_kind: 'partial' }),
      ...(cls.preserved ? { preserved: true, recovery: r?.detail || null, warning: 'commit_preserved_branch' } : {}),
      ...(r?.verify ? { verify: r.verify } : {}),
      ...(!cls.preserved && r?.error && r?.message ? { error_message: String(r.message).slice(0, 2000) } : {}),
      ...(cas3.ok ? {} : { warning2: 'evidence_commit_pending' }),
    },
  })
}

function doStatus(workspaceDir, task) {
  const ops = (task.operations || []).filter(o => o.kind === 'worktree')
  const preserved = ops.filter(o => o.state === 'indeterminate' && o.branch)
  return envelope({
    task: taskHeader(task),
    observation: {
      summary: `${ops.length} worktree transaction(s); ${preserved.length} with a preserved branch needing manual recovery.`,
      rule_version: WORKTREE_RULES_VERSION,
      transactions: ops.map(o => ({ operation_id: o.operation_id, state: o.state, files: o.files, branch: o.branch || null, commit: o.commit || null, preserved: !!o.preserved })),
      preserved: preserved.map(o => ({ branch: o.branch, commit: o.commit, recovery: o.recovery || null })),
    },
    allowed_actions: ['code_worktree', 'code_read', 'code_status'],
    extra: {},
  })
}

