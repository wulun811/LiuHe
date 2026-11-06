// code_check — S2.1b validation: run requested checks (test/typecheck/lint) for a task.
// Explicit run (default false = preview, nothing executed). Delegates each kind to verify_pipeline
// (uniform per-stage {ran,passed,skipped}); records Evidence and only flips result_kind to validated
// when every requested check actually ran and passed AND a patch had been applied (§7.4: skipped/empty != pass).
import { existsSync } from 'node:fs'
import {
  makeError, envelope, getTask, updateTaskCas, findOperation, payloadHash, newOperationId,
  newEvidenceId, ensureTaskVersion, assertTaskWritable, taskHeader, buildTaskNextAction, completionProjection, unknownTaskError,
} from '../entry-shared.js'
import { handle as verifyPipelineHandle, previewStagePlan } from '../tool-verify-pipeline/handler.js'
import { join } from 'node:path'
import { startJob, listJobs } from '../../workflow/jobs.js'
import { currentDependencies } from '../../workflow/evidence.js'

const KINDS = ['test', 'typecheck', 'lint']

// 第二轮审查修复（P1）：本进程正在执行的 sync check op（无 job_id、可运行 >60s）——
// I3b 的 prepared 收口器必须跳过它们，否则并发 code_check（含纯预览）会把运行中的 op 判 failed
const runningSyncOps = new Map()
export const _runningSyncOps = runningSyncOps

export async function handle(args, context) {
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
  let task = getTask(workspaceDir, task_id)
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

  // live 审查 I3b：崩溃/提交竞态遗留的 prepared check op 无收口路径（cancel 永久 blocked_by）——
  // 无 live job 对应时收口为 failed（检查从未完成，如实标注；不像 indeterminate 会阻塞 cancel）
  {
    const stale = (task.operations || []).filter(o => o.kind === 'check' && o.state === 'prepared' && !runningSyncOps.has(o.operation_id))
    if (stale.length) {
      const liveOpIds = new Set(listJobs(workspaceDir, { task_id, limit: 0 }).filter(j => ['running', 'cancelling'].includes(j.state)).map(j => j.operation_id).filter(Boolean))
      let rev = task.revision
      for (const o of stale) {
        if (o.job_id && liveOpIds.has(o.operation_id)) continue
        const age = Date.now() - Date.parse(o.created || 0)
        if (!o.job_id && Number.isFinite(age) && age < 60000) continue // job 链接窗口内不误判
        const cas = updateTaskCas(workspaceDir, task_id, rev, (t) => opEvent(t, { ...o, state: 'failed', updated: new Date().toISOString(), error: 'ABANDONED_PREPARED', reason: 'prepared check op without live job (lost after restart or commit race)' }, { node: 'check' }))
        if (cas.ok) rev = cas.task.revision
      }
      task = getTask(workspaceDir, task_id) || task
    }
  }

  // checks：字符串或 {kind}；去重、校验闭集
  let raw = args?.checks
  if (raw == null) raw = ['test']
  if (!Array.isArray(raw) || raw.length === 0) {
    return makeError('missing_parameter', 'checks must be a non-empty array', 'e.g. checks=["test"] or checks=[{"kind":"typecheck"}].')
  }
  const kinds = []
  for (const c of raw) {
    const kind = typeof c === 'string' ? c : c?.kind
    if (!KINDS.includes(kind)) {
      return makeError('invalid_input', `unknown check kind: ${kind}`, `Valid kinds: ${KINDS.join(', ')}.`)
    }
    if (!kinds.includes(kind)) kinds.push(kind)
  }
  const run = args?.run === true // 显式执行；默认只预览
  const asyncRun = args?.async === true // 长检查后台 job（T12）
  // WP02/AC08：判定规则显式选择——protocol（默认，测试协议解析；exit0+无协议 → skipped/unknown 不伪绿）
  // 或 exit（调用方显式声明进程退出码即判据，自定义断言脚本无协议也能给确定结论）
  if (args?.verifier != null && !['exit', 'protocol'].includes(args.verifier)) {
    return makeError('invalid_input', `verifier must be 'protocol' or 'exit' (got ${args.verifier})`, 'Omit for protocol parsing, or pass exit to declare the exit code as the verdict.')
  }
  // P2 修复（2026-10-12 狗粮）：verifier 记忆——同任务同类检查上此前的显式 exit 声明自动复用，
  // 免「每轮重查都要重申 verifier:exit」的重复往返（实测无协议 npm test 项目每轮双跳）；
  // 显式传参永远优先（protocol 可覆盖）。复用会在证据/回执里以 verifier_reused 显式标注。
  let verifierReused = false
  let verifier
  if (args?.verifier != null) {
    verifier = args.verifier === 'exit' ? 'exit' : 'protocol'
  } else {
    const remembered = [...(task.evidence || [])].reverse().find(e => kinds.includes(e.kind) && e.provenance?.verifier === 'exit')
    if (remembered) { verifier = 'exit'; verifierReused = true } else { verifier = 'protocol' }
  }
  const tagVerifierReuse = (evs) => { if (verifierReused && Array.isArray(evs)) for (const e of evs) e.actual = { ...e.actual, verifier_reused: true } }

  const payload_hash = payloadHash({
    task_id, checks: kinds, workdir: args?.workdir || null, timeout: args?.timeout ?? null, async: asyncRun, verifier,
  })
  let op = findOperation(task, args?.request_id)
  if (op) {
    if (op.payload_hash !== payload_hash) {
      return makeError('request_conflict', `request_id ${args.request_id} was used with a different payload`, 'Use a fresh request_id for a different check set.')
    }
    if (op.state === 'succeeded') {
      return envelope({
        task: { task_id: task.task_id, revision: task.revision, route: task.route, node: task.node, lifecycle: task.lifecycle },
        observation: {
          summary: `Deduplicated: checks already ran (${op.operation_id}); result_kind=${task.result_kind || 'partial'}.`,
          deduplicated: true, effect: 'run',
          evidence: (task.evidence || []).filter(e => e.operation_id === op.operation_id),
        },
        allowed_actions: ['code_check', 'code_patch', 'code_read', 'code_status'],
        extra: {
          request_id: args.request_id,
          result_kind: task.result_kind || 'partial',
          ...buildCheckFollowup({
            workspaceDir, task_id, task,
            result_kind: task.result_kind || 'partial',
            evidence: (task.evidence || []).filter(e => e.operation_id === op.operation_id),
            failed: (task.evidence || []).filter(e => e.operation_id === op.operation_id && e.result !== 'passed').map(e => `${e.kind}:${e.result}`),
            allPassed: (task.evidence || []).filter(e => e.operation_id === op.operation_id).length > 0 && (task.evidence || []).filter(e => e.operation_id === op.operation_id).every(e => e.result === 'passed'),
            checkKinds: kinds, timeout: args?.timeout ?? null, verifier,
          }),
        },
      })
    }
    // 异步 job 在途：同 request_id 返回运行中（§7.6-2，不重复起 job）
    if (op.job_id) {
      const live = listJobs(workspaceDir, { task_id, limit: 0 }).find(j => j.job_id === op.job_id)
      if (live && ['running', 'cancelling'].includes(live.state)) {
        return envelope({
          task: { task_id, revision: task.revision, route: task.route, node: 'check', lifecycle: task.lifecycle },
          observation: { summary: `Check job ${op.job_id} is still ${live.state}.`, effect: 'run', accepted: true, job_id: op.job_id, status: live.state, checks: op.checks || kinds },
          allowed_actions: ['code_control', 'code_check', 'code_read', 'code_status'],
          extra: {
            request_id: args.request_id,
            job_id: op.job_id,
            next_action: { tool: 'code_control', args: { workspace_dir: workspaceDir, task_id, action: 'job', job_id: op.job_id }, note: `Check job is still ${live.state}; poll job status, then code_status for the final result_kind.` },
          },
        })
      }
    }
  }

  // LH-001：终态守卫——cancelled 任务拒绝新副作用操作（上面的 succeeded/job dedup 复读已放行）
  const guard = assertTaskWritable(task)
  if (guard) return guard

  // ── 预览：不执行、不记证据 ──
  if (!run) {
    // F1（2026-10-29 自用试用修正）：预览必须给出**真实命令行**。
    // 旧预览只说「1 check(s) [test]」，调用方无法判断会跑单文件还是整条全链；
    // 本仓要求全链进内存围栏，守纪律的 LLM 因此不敢 run=true。
    const planDir = args?.workdir ? join(workspaceDir, args.workdir) : workspaceDir
    let wouldRun = []
    try { wouldRun = previewStagePlan(planDir, workspaceDir, kinds) } catch { wouldRun = [] }
    const cmdSummary = wouldRun.filter(p => p.will_run).map(p => p.command).join(' ; ')
    const notRunnable = wouldRun.filter(p => !p.will_run)
    return envelope({
      task: taskHeader(task),
      observation: {
        summary: cmdSummary
          ? `Preview (nothing executed): would run [${cmdSummary}]${notRunnable.length ? `; not runnable: ${notRunnable.map(p => p.kind + ':' + p.reason).join(', ')}` : ''}`
          : `Preview (nothing executed): no runnable check among [${kinds.join(', ')}]`,
        effect: 'preview', dry_run: true,
        // F1：真实命令 + 会不会跑；will_run=false 时必须给原因（不得静默跳过）
        would_run: wouldRun,
        // dogfood ②b：async 但未显式 run → 明确提示被忽略，不静默降级
        ...(asyncRun ? { note: 'async=true ignored because run=false: nothing executed. Pass run=true to launch the background job.' } : {}),
        checks: wouldRun.map(p => ({
          kind: p.kind,
          availability: p.will_run ? 'runnable' : 'unavailable',
          command: p.command || null,
          cwd: p.cwd || null,
          ...(p.reason ? { reason: p.reason } : {}),
          ...(p.notice ? { notice: p.notice } : {}),
          note: p.will_run ? 'preview only — not executed (pass run=true to execute)' : 'not runnable in this workspace; running it would produce no evidence',
        })),
      },
      allowed_actions: ['code_check', 'code_patch', 'code_read', 'code_status'],
      extra: buildPreviewExtra({
        workspaceDir, task_id, kinds, args, asyncRun, wouldRun, notRunnable,
      }),
    })
  }

  // ── 异步：后台 job 执行长检查（T12），立即 accepted；完成后提交证据/终态 ──
  if (asyncRun) {
    if (args?.request_id && !op) {
      const prepared = {
        operation_id: newOperationId(), request_id: args.request_id, payload_hash,
        state: 'prepared', kind: 'check', checks: kinds, async: true, created: new Date().toISOString(),
        // WP02：检查事实入账（inputs）——跑了什么/在哪跑/超时/判定规则
        workdir: args?.workdir ?? null, timeout: args?.timeout ?? null, verifier,
      }
      const cas = updateTaskCas(workspaceDir, task_id, task.revision, (t) => opEvent(t, prepared, { node: 'check' }))
      if (!cas.ok) {
        return makeError(
          cas.code === 'REVISION_CONFLICT' ? 'revision_conflict' : 'task_not_found',
          cas.code === 'REVISION_CONFLICT' ? `task revision changed: expected=${task.revision}, current=${cas.current}` : `Unknown task_id: ${task_id}`,
        )
      }
      op = prepared
    }
    const runFn = async ({ signal }) => {
      const startTask = getTask(workspaceDir, task_id) || {}
      const deps = currentDependencies(workspaceDir, startTask)
      // WP02：goal_revision 采集时点 = 检查启动时（证据记当时目标；switch_route 后旧证据按 revision 失效）
      const goalRevision = startTask.goal_revision || 1
      // dogfood ②c：background 上下文透传给 verify_pipeline——不占 MCP 请求槽，stage 上限放宽 600s
      const evidence = await executeChecks(kinds, { workspace_dir: workspaceDir, workdir: args?.workdir, timeout: args?.timeout }, { ...(context || {}), background: true }, signal, op, deps, startTask.index_scope, goalRevision, verifier)
      tagVerifierReuse(evidence)
      if (signal.aborted) {
        markCheckIndeterminate(workspaceDir, task_id, op, 'cancelled')
        return { ok: false, cancelled: true }
      }
      // live 审查 I5：任务已被 cancel（无 request_id 的 async check 不会被 doCancel 拦）→ 不得事后写 validated
      const curTask = getTask(workspaceDir, task_id)
      if (curTask && curTask.lifecycle === 'cancelled') {
        markCheckIndeterminate(workspaceDir, task_id, op, 'task cancelled during check')
        return { ok: false, cancelled: true, reason: 'task_cancelled' }
      }
      let res = commitCheck(workspaceDir, task_id, op, kinds, evidence)
      for (let i = 0; i < 3 && !res.ok && res.code === 'REVISION_CONFLICT'; i++) res = commitCheck(workspaceDir, task_id, op, kinds, evidence)
      // dogfood ②a：job 成败必须反映检查结果，而非仅状态提交成功（此前失败检查也报 succeeded/ok=true）
      const allPassed = evidence.length > 0 && evidence.every(e => e.result === 'passed')
      return {
        ok: res.ok === true && allPassed,
        commit_ok: res.ok === true,
        all_passed: allPassed,
        result_kind: res.result_kind || null,
        failed: evidence.filter(e => e.result !== 'passed').map(e => `${e.kind}:${e.result}`),
      }
    }
    const job = startJob({
      workspaceDir, task_id, operation_id: op?.operation_id || null, kind: 'check', run: runFn,
      // N2（0.5.14 Windows 复核）：启动前持久化请求范围（与公开 request_id 解耦）——
      // 无 request_id 的 async 检查被取消后，status/resume/cancel_job 仍能给出同一 checks/workdir/timeout/verifier。
      params: {
        checks: [...kinds],
        workdir: args?.workdir ?? null,
        timeout: args?.timeout ?? null,
        verifier,
        scope: args?.workdir ?? null,
        request_id: args?.request_id ?? null,
        async: true,
      },
    })
    if (op) {
      // live 审查 I3a：CAS 返回值必须接住——失败时 op 无 job_id，在途去重失效（同 request_id 会再起 job）
      let linked = false
      for (let i = 0; i < 3 && !linked; i++) {
        const cur = getTask(workspaceDir, task_id)
        if (!cur) break
        const lc = updateTaskCas(workspaceDir, task_id, cur.revision, (t) => opEvent(t, { ...op, job_id: job.job_id }))
        linked = lc.ok === true
      }
      // 第二轮审查修复：job_id 必须回写内存 op——否则 commitCheck 的 finOp 覆盖链接记录后 job_id 丢失
      if (linked) op = { ...op, job_id: job.job_id }
    }
    return envelope({
      task: { task_id, revision: getTask(workspaceDir, task_id)?.revision ?? task.revision, route: task.route, node: 'check', lifecycle: task.lifecycle },
      observation: { summary: `Accepted: ${kinds.length} check(s) [${kinds.join(', ')}] running in background (job ${job.job_id}). Query with code_control(action="job").`, effect: 'run', accepted: true, status: 'running', job_id: job.job_id, checks: kinds },
      allowed_actions: ['code_control', 'code_check', 'code_read', 'code_status'],
      extra: {
        request_id: args?.request_id,
        job_id: job.job_id,
        next_action: { tool: 'code_control', args: { workspace_dir: workspaceDir, task_id, action: 'job', job_id: job.job_id }, note: 'Background check accepted; poll job status, then code_status for the final result_kind.' },
      },
    })
  }

  // ── 执行：prepared op → 逐项 run → 证据/终态 ──
  let currentRev = task.revision
  if (args?.request_id && !op) {
    const prepared = {
      operation_id: newOperationId(), request_id: args.request_id, payload_hash,
      state: 'prepared', kind: 'check', checks: kinds, created: new Date().toISOString(),
      workdir: args?.workdir ?? null, timeout: args?.timeout ?? null, verifier,
    }
    const cas = updateTaskCas(workspaceDir, task_id, task.revision, (t) => opEvent(t, prepared, { node: 'check' }))
    if (!cas.ok) {
      return makeError(
        cas.code === 'REVISION_CONFLICT' ? 'revision_conflict' : 'task_not_found',
        cas.code === 'REVISION_CONFLICT' ? `task revision changed: expected=${task.revision}, current=${cas.current}` : `Unknown task_id: ${task_id}`,
      )
    }
    currentRev = cas.task.revision
    op = prepared
  }

  const deps = currentDependencies(workspaceDir, task)
  let evidence
  if (op) runningSyncOps.set(op.operation_id, (runningSyncOps.get(op.operation_id) || 0) + 1)
  try {
    evidence = await executeChecks(kinds, { workspace_dir: workspaceDir, workdir: args?.workdir, timeout: args?.timeout }, context, context?.signal, op, deps, task.index_scope, task.goal_revision || 1, verifier)
    tagVerifierReuse(evidence)
  } finally {
    if (op) {
      const n = runningSyncOps.get(op.operation_id) || 0
      if (n <= 1) runningSyncOps.delete(op.operation_id)
      else runningSyncOps.set(op.operation_id, n - 1)
    }
  }

  const allPassed = evidence.length > 0 && evidence.every(e => e.result === 'passed')
  const hasPatch = (task.operations || []).some(o => (o.kind === 'patch' || o.kind === 'batch') && o.state === 'succeeded')
  const result_kind = allPassed && hasPatch ? 'validated' : (hasPatch ? 'partial' : (task.result_kind || 'analysis_only'))

  const finOp = {
    ...(op || { operation_id: newOperationId(), request_id: null, payload_hash, kind: 'check', created: new Date().toISOString(), workdir: args?.workdir ?? null, timeout: args?.timeout ?? null, verifier }),
    state: 'succeeded', updated: new Date().toISOString(), checks: kinds, result_kind,
    ...(verifierReused ? { verifier_reused: true } : {}),
  }
  const applyCheck = (t) => {
    const arr = [...(t.operations || [])]
    const i = arr.findIndex(o => o.operation_id === finOp.operation_id)
    if (i >= 0) arr[i] = finOp; else arr.push(finOp)
    t.operations = arr
    t.evidence = [...(t.evidence || []), ...evidence]
    t.node = 'check'
    t.result_kind = result_kind
    // 第二轮审查/13-B：记录验证时的 goal_revision——switch_route 后旧 validated 失效（effectiveState）
    if (result_kind === 'validated') t.validated_goal_revision = t.goal_revision || 1
    return { type: 'evidence', data: { evidences: evidence, operation: finOp, node: 'check', result_kind } }
  }
  // R22-F25（2026-11-05 极限风暴）：同步检查跑完后才提交 CAS；检查期间另一个工具
  // （实测 audit + check 并行）会推高 revision，旧实现一次 CAS 失败就把已经跑完的检查丢掉，
  // 还让调用方「用同一个 request_id 重试」——但无 request_id 时根本没得重试。
  // 检查是追加式证据，重取 revision 后合并是安全的；最多重试 3 次。
  let cas = null
  let casRev = currentRev
  for (let attempt = 0; attempt < 3; attempt++) {
    cas = updateTaskCas(workspaceDir, task_id, casRev, applyCheck)
    if (cas.ok || cas.code !== 'REVISION_CONFLICT') break
    const fresh = getTask(workspaceDir, task_id)
    if (!fresh || fresh.lifecycle === 'cancelled') break
    casRev = fresh.revision
  }
  if (!cas || !cas.ok) {
    const code = cas?.code || 'unknown'
    return makeError('state_commit_pending',
      args?.request_id
        ? 'checks ran but task state commit raced (' + code + '); retry with the same request_id'
        : 'checks ran but task state commit raced (' + code + '); no request_id was supplied — re-run code_check to record the result.',
      args?.request_id
        ? 'Retry with the same request_id to finalize.'
        : 'Re-run code_check; the previous attempt\'s result was not recorded.')
  }

  const failed = evidence.filter(e => e.result !== 'passed').map(e => `${e.kind}:${e.result}`)
  const summary = allPassed
    ? `All ${evidence.length} check(s) passed${hasPatch ? '; result_kind=validated' : '; no patch applied → result_kind=' + result_kind}.`
    : `Checks: ${failed.join(', ') || 'none passed'}; result_kind=${result_kind}.`

  return envelope({
    task: taskHeader(cas.task),
    observation: { summary, effect: 'run', result_kind, evidence, ...(verifierReused ? { verifier_reused: true, verifier_note: 'Reusing verifier=exit declared earlier for the same check kind(s); pass verifier explicitly to override.' } : {}) },
    allowed_actions: ['code_check', 'code_read', 'code_patch', 'code_status'],
    extra: {
      request_id: args?.request_id,
      result_kind,
      ...buildCheckFollowup({ workspaceDir, task_id, task: cas.task, result_kind, failed, allPassed, evidence, checkKinds: kinds, timeout: args?.timeout ?? null, verifier }),
    },
  })
}

// 8-补（2026-10-07 专家体验报告）：code_check envelope 一致性——下一步结构化（与 code_status/code_read 同源）。
// validated → 路由生成器（change→code_patch 模板）；未通过/未验证 → 指回 code_patch 修复（不指回 code_check 自环）。
// F1-b（2026-10-30 自用试用）：预览的 next_action 必须和「真能跑」一致。
// 旧实现无条件给 code_check(run:true)；但预览已经知道 would_run 里没有任何可运行目标时，
// 照做只会空跑一轮拿到 skipped，白白多一次往返，也让调用方误以为「再试一次就能验」。
// 无可跑目标 → next_action=null + 如实说明（环境限制，不是代码缺陷）。
function buildPreviewExtra({ workspaceDir, task_id, kinds, args, asyncRun, wouldRun, notRunnable }) {
  const runnable = (wouldRun || []).filter(p => p.will_run)
  if (runnable.length === 0) {
    const why = (notRunnable || []).map(p => p.kind + ':' + p.reason).join(', ') || 'no check target'
    return {
      next_action: null,
      next_step: 'Nothing is runnable here: ' + why + '. Running again would produce no evidence — this is an environment limitation, not a code defect. Add a runnable target (e.g. package.json "test"), or finish and report the change as unverified (result_kind=partial).',
    }
  }
  return {
    next_action: {
      tool: 'code_check',
      args: {
        workspace_dir: workspaceDir,
        task_id,
        checks: kinds,
        run: true,
        ...(args?.workdir ? { workdir: args.workdir } : {}),
        ...(args?.timeout != null ? { timeout: args.timeout } : {}),
        ...(asyncRun ? { async: true } : {}),
        ...(args?.request_id ? { request_id: args.request_id } : {}),
      },
      note: 'Preview only (nothing executed). Call code_check with these args to run the checks.',
    },
    next_step: 'Preview only. To execute, call code_check with next_action.args (run=true).',
  }
}

function buildCheckFollowup({ workspaceDir, task_id, task, result_kind, failed = [], allPassed = false, evidence = [], checkKinds = [], timeout = null, verifier = null }) {
  if (result_kind === 'validated') {
    const na = buildTaskNextAction({ workspaceDir, task_id, task })
    // 14-B AC03：机械要求满足 → done 空动作 + host_required（工具侧完成，不冒充业务完成）
    if (na === null) {
      const c = completionProjection({ workspaceDir, task })
      return {
        next_action: null,
        progress: c?.progress, mechanical_requirements_met: c?.mechanical_requirements_met, goal_judgment: c?.goal_judgment,
        next_step: 'Checks passed (result_kind=validated). ' + (c?.note || ''),
      }
    }
    return { next_action: { ...na, note: (na.note ? na.note + ' ' : '') + 'Checks passed (result_kind=validated).' } }
  }
  // WP08R-3 A1：环境性未验证分流——skipped/unavailable 是环境限制（无 test 入口），不是代码缺陷；
  // 旧版统一指回 code_patch「Fix or adjust the patch」误导模型去改没问题的代码（A1 长尾归因）
  const results = evidence.map(e => e.result)
  const envOnly = evidence.length > 0 && results.every(r => r === 'skipped' || r === 'unavailable')
  // WP08R-3 W4-C F1（C4 首跑实拍）：命令真跑了且 exit0，但输出无测试协议 → skipped；不应说“无可运行检查”，应教 verifier:'exit'
  const exit0Ran = evidence.filter(e => (e.result === 'skipped' || e.result === 'unavailable') && e.actual?.ran === true && e.actual?.exit_code === 0)
  if (envOnly && exit0Ran.length) {
    const kinds = exit0Ran.map(e => e.kind)
    return {
      next_action: { tool: 'code_check', args: { workspace_dir: workspaceDir, task_id, checks: kinds, run: true, verifier: 'exit' }, note: 'The check command ran and exited 0, but its output is not a recognized test protocol. Re-run with verifier:exit to declare the exit code as the verdict (checks unchanged).' },
      next_step: 'Check(s) ' + kinds.join(', ') + ' ran and exited 0 but were not recognized as a test protocol (skipped). This is a protocol/declaration gap, not a code defect — do not edit code to fix it. Call code_check with next_action.args (verifier:exit) to turn exit 0 into a verdict, or finish with result_kind=' + result_kind + ' if you accept the unverified state.',
    }
  }
  if (envOnly) {
    return {
      next_action: null,
      next_step: 'Nothing was verified: no runnable check target in this workspace (' + evidence.map(e => e.kind + ':' + e.result).join(', ') + '). This is an environment limitation, not a code defect — do not edit code to fix it. Add a runnable target (e.g. package.json "test") and re-run code_check, or finish and report the change as unverified (result_kind=' + result_kind + ').',
    }
  }
  const envPartial = evidence.length > 0 && !results.some(r => r === 'failed' || r === 'unknown') && results.some(r => r === 'skipped' || r === 'unavailable')
  if (envPartial) {
    const passedList = evidence.filter(e => e.result === 'passed').map(e => e.kind)
    const skipList = evidence.filter(e => e.result === 'skipped' || e.result === 'unavailable').map(e => e.kind + ':' + e.result)
    return {
      next_action: null,
      next_step: 'Partially verified: ' + (passedList.join(', ') || 'none') + ' passed; ' + skipList.join(', ') + ' had no runnable target (environment limitation, not a failure). Add the missing target to fully verify; otherwise result_kind stays ' + result_kind + '.',
    }
  }
  // 0.5.26：超时 = 请求预算截断，不是代码缺陷——旧版一律指回 code_patch「Fix or adjust the patch」，
  // 诱导模型去改本来正确的代码（本文件已对 skipped/unavailable 做过同口径防护，timeout 漏了）
  const timedOut = evidence.some(e => e.result === 'failed' && e.actual?.timed_out === true)
  if (timedOut) {
    // 重试必须给够预算：沿用调用方那个「已经不够用」的 timeout，后台再跑一遍照样超时（实测踩过）
    const cause = `a timeout budget (configured ${timeout ?? 30000}ms, foreground stage cap 110s)`
    return {
      next_action: {
        tool: 'code_check',
        args: {
          workspace_dir: workspaceDir, task_id, checks: checkKinds, run: true, async: true,
          timeout: 600000,
          ...(verifier ? { verifier } : {}),
        },
        note: `The check was cut off by ${cause} — not a code defect; do not edit code. Re-run it as a background job with code_check(async=true, timeout=600000) (background cap 600s).`,
      },
      next_step: `The check was cut off by ${cause} — not a code defect; do not edit code to fix it. Re-run with code_check(async=true, run=true, timeout=600000).`,
    }
  }
  const why = failed.length
    ? `Checks did not pass (${failed.join(', ')}).`
    : (allPassed ? 'Checks passed, but no patch was applied (analysis_only) — nothing to validate yet.' : 'Nothing was verified (skipped/unavailable is not a pass).')
  return {
    next_action: {
      tool: 'code_patch',
      args: { workspace_dir: workspaceDir, task_id, dry_run: true },
      template: true,
      required_args: ['read_ref or locator', 'edit_mode', 'content (replace_symbol) or patch.old_string/new_string (patch)'],
      note: why + ' Fix or adjust the patch, then re-run code_check.',
    },
  }
}

// verify_pipeline 单阶段 → 证据结果；空运行/跳过不作为通过（§7.4）。
// WP02/AC08：verifier='exit' 时调用方显式声明「进程退出码即判据」——ran 且 exit0 → passed、
// 非零 → failed，不经协议解析（自定义断言脚本的显式选择）；无协议解析的 exit0 在默认
// protocol 规则下仍是 skipped/unknown（不伪绿），两条路径分开。
function classifyStage(stage, r, verifier = 'protocol') {
  if (r?.error) return 'unavailable'
  if (!stage) return 'unknown'
  if (stage.error) return 'unavailable'
  // 残留②：超时 = 未通过（非「未知」）——闸门语义下不得把未跑完当模棱两可放行
  if (stage.killed === true || stage.timed_out) return 'failed'
  if (verifier === 'exit') {
    // 显式退出码判据：真跑过（ran）即以退出码为准——协议层的 0-tests/skipped 不覆盖用户声明
    if (stage.ran === true) return stage.exitCode === 0 ? 'passed' : 'failed'
    return 'skipped'
  }
  if (stage.skipped === true) return 'skipped'
  if (stage.passed === true) return 'passed'
  if (stage.passed === false) return 'failed'
  return 'unknown'
}

// S3 审查修复：成功写入含单文件 patch 与多文件 batch（§7.4 检查→validated 需实际写入）
function opEvent(t, op, { node } = {}) {
  const arr = [...(t.operations || [])]
  const i = arr.findIndex(o => o.operation_id === op.operation_id)
  if (i >= 0) arr[i] = op; else arr.push(op)
  t.operations = arr
  if (node) t.node = node
  return { type: 'operation', data: { operation: op, ...(node ? { node } : {}) } }
}

// 逐项执行检查（同步/异步共用）；signal 透传给 verify_pipeline（job 取消）。
// WP02：证据补 goal_revision（采集时目标）+ actual.command/runner（跑了什么/哪个 runner）。
async function executeChecks(kinds, args, context, signal, op, deps = [], indexScope = null, goalRevision = 1, verifier = 'protocol') {
  const evidence = []
  for (const kind of kinds) {
    let r = null
    try {
      r = await verifyPipelineHandle({ workspace_dir: args?.workspace_dir, stages: kind, workdir: args?.workdir, timeout: args?.timeout }, { ...(context || {}), signal })
    } catch (e) {
      r = { error: 'check_execution_failed', message: e.message }
    }
    const stage = r?.results?.[kind]
    const result = classifyStage(stage, r, verifier)
    // 0.5.26：verify_pipeline 顶层 mcp_note（如「MCP request has a 120s hard timeout … will definitely time out」）
    // 此前全仓无人消费——code_check 只透传 stage.notice，调用方永远不知道请求被预算截断，
    // 于是把环境性截断误归因为「代码有问题」（A1 长尾误归因：skipped/unavailable 已防，timeout 漏了）
    const mcpNote = typeof r?.mcp_note === 'string' && r.mcp_note ? r.mcp_note : null
    const stageNotice = typeof stage?.notice === 'string' && stage.notice ? stage.notice : null
    const noticeText = [stageNotice, mcpNote].filter(Boolean).join(' | ') || null
    const command = typeof stage?.command === 'string' && stage.command ? stage.command : null
    const runner = command ? command.trim().split(/\s+/)[0] : null
    evidence.push({
      evidence_id: newEvidenceId(),
      kind,
      result,
      operation_id: op?.operation_id || null,
      scope: args?.workdir || null,
      // WP02：检查事实——采集时的 goal_revision（与 audit 证据同口径；switch_route 后按 revision 失效）
      goal_revision: goalRevision,
      // T21 外部结果溯源：本证据由 verify_pipeline 委派产生，供复核“passed”来源
      source: 'verify_pipeline',
      provenance: { via: 'delegate', tool: 'verify_pipeline', stage: kind, ...(verifier === 'exit' ? { verifier: 'exit' } : {}) },
      // S4.1：显式依赖（成功写文件+采集时版本）；无写 → []，不因文件变化失效
      depends_on: Array.isArray(deps) ? deps : [],
      ...(deps && deps.truncated ? { depends_on_truncated: true } : {}),
      actual: {
        ran: stage?.ran ?? false,
        exit_code: stage?.exitCode ?? null,
        duration_ms: stage?.duration_ms ?? null,
        // WP02：检查事实——可执行回传（LH-010）与 runner 名（命令首 token）
        ...(command ? { command } : {}),
        ...(runner ? { runner } : {}),
        // B7：killed / timed_out 是两回事，必须分别透传。
        // 旧实现只写 timed_out——若某路径 killed=true 但 timed_out 未置位，证据里就**什么都看不到**，
        // 调用方无法区分「超时被杀」与「自己退出 1」，只能猜（DSH 实录正是这种困境）。
        ...(stage?.killed === true ? { killed: true } : {}),
        ...(stage?.timed_out ? { timed_out: true, timed_out_ms: stage.timed_out.timeout_ms ?? null } : {}),
        ...(verifier === 'exit' && result === 'passed' && stageNotice
          ? { notice: 'verdict declared by exit code (exit=0, verifier=exit); output did not match a test protocol' + (mcpNote ? ' | ' + mcpNote : ''), notice_protocol: stageNotice }
          : (noticeText ? { notice: noticeText } : {})),
        ...(typeof stage?.stdout === 'string' && stage.stdout ? { stdout_tail: stage.stdout.slice(-600) } : {}),
        // B8：失败且 stderr 为空时，旧实现什么都不写 → 读者分不清"没有 stderr"与
        // "stderr 没被采集"。DSH 最初那条 failed（exit_code=1、105860ms）就落在这种形态里，
        // 我这边连"stderr 是不是空"都无法确认，只能猜。显式写出空串。
        ...(result === 'failed' && typeof stage?.stderr === 'string'
          ? { stderr_tail: stage.stderr.slice(-600) }
          : (typeof stage?.stderr === 'string' && stage.stderr ? { stderr_tail: stage.stderr.slice(-600) } : {})),
        ...(stage?.error ? { error: String(stage.error).slice(0, 200) } : {}),
        ...(r?.error ? { error: r.error } : {}),
      },
      limitations: result === 'skipped'
        ? [`no ${kind} script/target — nothing was verified (not a pass)`]
        : result === 'unavailable'
          ? ['execution unavailable in this workspace']
          : result === 'failed' && stage?.timed_out
            ? ['run timed out before completion — counted as failed (not a pass); this is an MCP request-budget truncation (foreground 110s / background 600s), NOT a code defect — re-run with code_check(async=true)']
            : result === 'unknown'
              ? ['execution did not yield a definite pass/fail']
              : [],
      created: new Date().toISOString(),
    })
    // T18：扫描截断时标注——checks 只覆盖部分树，不得读作全量通过
    if (indexScope?.truncated) {
      const last = evidence[evidence.length - 1]
      last.limitations = [...(last.limitations || []), `workspace scan truncated at ${indexScope.files_scanned} file(s) — checks cover a partial tree (T18)`]
      // B8：字段名从 `truncated` 改为 `scan_truncated`。
      // `actual.truncated` 紧挨着 ran/exit_code/stdout_tail，任何读者都会理解成
      // "输出被截断"——DSH 那条 evidence 就是 `truncated: true` 配两行 stdout_tail，
      // 看起来像"结果不全所以不可信"。它真正的含义是**索引扫描**被截断。
      // 同名字段两种含义，比没有字段更误导；`truncated` 保留为别名以免旧调用方解析失败。
      last.actual = { ...last.actual, scan_truncated: true, truncated: true }
    }
  }
  return evidence
}

// 提交检查证据 + 终态（异步 job 用，每次读最新 revision 防 CAS 漂移）
function commitCheck(workspaceDir, task_id, op, kinds, evidence) {
  const task = getTask(workspaceDir, task_id)
  if (!task) return { ok: false, code: 'task_not_found' }
  const allPassed = evidence.length > 0 && evidence.every(e => e.result === 'passed')
  const hasPatch = (task.operations || []).some(o => (o.kind === 'patch' || o.kind === 'batch') && o.state === 'succeeded')
  const result_kind = allPassed && hasPatch ? 'validated' : (hasPatch ? 'partial' : (task.result_kind || 'analysis_only'))
  const finOp = {
    ...(op || { operation_id: newOperationId(), request_id: null, kind: 'check', created: new Date().toISOString() }),
    state: 'succeeded', updated: new Date().toISOString(), checks: kinds, result_kind,
  }
  const cas = updateTaskCas(workspaceDir, task_id, task.revision, (t) => {
    const arr = [...(t.operations || [])]
    const i = arr.findIndex(o => o.operation_id === finOp.operation_id)
    if (i >= 0) arr[i] = finOp; else arr.push(finOp)
    t.operations = arr
    t.evidence = [...(t.evidence || []), ...evidence]
    t.node = 'check'
    t.result_kind = result_kind
    // 第二轮审查/13-B：记录验证时的 goal_revision——switch_route 后旧 validated 失效（effectiveState）
    if (result_kind === 'validated') t.validated_goal_revision = t.goal_revision || 1
    return { type: 'evidence', data: { evidences: evidence, operation: finOp, node: 'check', result_kind } }
  })
  return { ok: cas.ok, code: cas.code, revision: cas.task?.revision, result_kind, allPassed, hasPatch }
}

// 取消/无法确认：检查操作标 indeterminate（不假称 validated）
function markCheckIndeterminate(workspaceDir, task_id, op, reason) {
  if (!op) return
  try {
    const t = getTask(workspaceDir, task_id)
    if (!t) return
    updateTaskCas(workspaceDir, task_id, t.revision, (tt) => opEvent(tt, { ...op, state: 'indeterminate', updated: new Date().toISOString(), reason }))
  } catch {}
}