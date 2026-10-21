// invoke_capability — G1-b 保底调用出口（ADR-018）：按精确名委派冻结白名单中的原实现。
// 安全边界：
//   1. 名字仅允许精确标识符（拒路径/模块名/URL）；白名单仅由磁盘扫描得出；
//   2. handler 路径步出 tools/ 即拒绝（纵深防御）；
//   3. 顶层 workspace_dir/task_id 为边界，嵌套 args 不得覆盖；
//   4. 只委派一次（不重试、不叠加效果）；原结果原样保留。
import { existsSync } from 'node:fs'
import { join, resolve, sep, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { capabilityWhitelist, loadPositions, effectsOf } from '../../workflow/capability-catalog.js'
import {
  getTask, makeError, assertTaskWritable, findOperation, payloadHash,
  newOperationId, operationEvent, updateTaskCas, sha256Hex,
} from '../entry-shared.js'
import { ledgerClaim, ledgerLookup, ledgerRecord, ledgerRelease } from '../outlet-ledger.js'
import { sanitizeAdvisory, collectAdvisoryFields, extractInvokeActions } from '../../workflow/action-map.js'
import { validateArgsConservative } from '../outlet-schema.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TOOLS_ROOT = resolve(join(__dirname, '..'))
const NAME_RE = /^[a-z][a-z0-9_]{1,40}$/

function safeJson(v) { try { return JSON.stringify(v) ?? '' } catch { return String(v) } }

function resultExcerpt(result) {
  const s = safeJson(result)
  return s.length > 500 ? s.slice(0, 500) + '…' : s
}

function operationBrief(op) {
  return {
    operation_id: op.operation_id, request_id: op.request_id || null, state: op.state || null,
    tool: op.tool || null, updated: op.updated || null,
    ...(op.result_excerpt ? { result_excerpt: op.result_excerpt } : {}),
  }
}

// R06（0.5.10 审核修复）：三态分类——成功标记 / 失败标记 / 无标记（indeterminate）。
// indeterminate 的操作不盲目重放（同 request_id 再调 → request_unresolved），响应 operation_succeeded=null。
// N02（0.5.11 复审修复）：执行类工具的「退出事实」也是合同字段——debug_runner/test_bridge 顶层 exit_code
// 必须解码（旧实现只认 success/ok/status，正常完成的命令被归 indeterminate → 无 task 账本不落终态 → 可重放双执行）。
//   退出码与业务判定分开：exit 0 但 no_totals_parsed（跑通却没解析到用例）仍归 indeterminate，不冒充通过。
export function classifyDelegatedOutcome(result) {
  if (!result || typeof result !== 'object') return { state: 'indeterminate', error_code: null }
  if (result.error != null || result.ok === false || result.success === false || result.status === 'fail' || result.status === 'failed' || result.status === 'error') {
    return { state: 'failed', error_code: String(result.error || result.status || 'operation_failed').slice(0, 120) }
  }
  if (typeof result.exit_code === 'number') {
    if (result.exit_code !== 0) return { state: 'failed', error_code: 'exit_code:' + result.exit_code }
    if (result.no_totals_parsed === true) return { state: 'indeterminate', error_code: 'no_totals_parsed' }
    return { state: 'succeeded', error_code: null }
  }
  if (result.success === true || result.ok === true || (typeof result.status === 'string' && !/^(fail|failed|error)$/i.test(result.status))) {
    return { state: 'succeeded', error_code: null }
  }
  return { state: 'indeterminate', error_code: null }
}

// R2（0.5.14 复审修复）：验证类结果的独立合同——「调用成功」与「检查通过」分开表达（禁止由调用成功推导 goal 完成）。
// verify_pipeline 等带 verification 块的返回，原样透出为 verification_result，供模型直接读到 not_run/partial/fail 与执行计数。
function verificationOf(result) {
  const v = result && typeof result === 'object' ? result.verification : null
  return (v && typeof v === 'object' && typeof v.status === 'string') ? v : null
}

// 0.5.10 的账本条目只记「成功」（无 state 字段）——ok:true 视为 succeeded（向后兼容，不误拒历史请求）
function outletLedgerState(hit) {
  if (!hit || typeof hit !== 'object') return 'indeterminate'
  if (typeof hit.state === 'string' && hit.state) return hit.state
  return hit.ok === true ? 'succeeded' : 'indeterminate'
}

function replayOutlet(hit, { workspaceDir, name, reqId, payload_hash, effects }) {
  if (!hit) return null
  if (hit.payload_hash !== payload_hash) {
    return makeError('request_conflict', 'request_id ' + reqId + ' was already used with a different payload for ' + name + '.', 'Use a fresh request_id for a different call.')
  }
  const priorState = outletLedgerState(hit)
  if (priorState === 'succeeded') {
    return {
      ok: true, capability: name, delegated: false, delegated_once: true, deduplicated: true,
      workspace_dir: workspaceDir, effects, request_id: reqId, operation_succeeded: true, ledger: hit,
      execution: { note: 'Deduplicated (outlet ledger): this request_id already completed with the same payload — the original side effect was NOT re-executed. success != verified.' },
    }
  }
  return makeError('request_unresolved', 'request_id ' + reqId + ' has an unresolved outlet operation (' + priorState + '); refusing to blindly replay.', 'Inspect the workspace state left by that call (it may have partially applied); to force a fresh attempt use a NEW request_id — same-id replay stays closed.')
}

function recordInvokeOp(workspaceDir, taskId, expectedRevision, base, outcome) {
  const now = new Date().toISOString()
  const finalOp = {
    ...base, state: outcome.state, updated: now,
    ...(outcome.error_code ? { error_code: outcome.error_code } : {}),
    ...(outcome.result !== undefined ? { result_digest: 'sha256:' + sha256Hex(safeJson(outcome.result)), result_excerpt: resultExcerpt(outcome.result) } : {}),
  }
  const opts = (base?.effects || []).includes('workspace_write')
    ? { node: 'edit', ...(outcome.state === 'succeeded' ? { result_kind: 'partial' } : {}) }
    : {}
  return updateTaskCas(workspaceDir, taskId, expectedRevision, (t) => operationEvent(t, finalOp, opts))
}

export async function handle(args, context) {
  const workspaceDir = args?.workspace_dir
  if (typeof workspaceDir !== 'string' || !workspaceDir) {
    return makeError('missing_parameter', 'workspace_dir is required', 'Pass the absolute project root path.')
  }
  if (!existsSync(workspaceDir)) {
    return makeError('invalid_input', 'workspace_dir not found: ' + workspaceDir)
  }
  const name = args?.name
  if (typeof name !== 'string' || !name) {
    return makeError('missing_parameter', 'name is required', 'Enumerate names with code_query(mode="capabilities").')
  }
  if (!NAME_RE.test(name)) {
    return makeError('invalid_input', 'name must be an exact tool name (no paths/module specifiers)', 'Enumerate valid names with code_query(mode="capabilities").')
  }
  const t = capabilityWhitelist().get(name)
  if (!t) {
    return makeError('unknown_capability', 'Unknown capability: ' + name, 'Enumerate valid names with code_query(mode="capabilities").')
  }
  const rawArgs = args?.args == null ? {} : args.args
  if (typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
    return makeError('invalid_input', 'args must be an object (the original tool arguments)')
  }
  // 0.5.25：工作区冲突显式化。顶层 workspace_dir 是任务/工作区边界（嵌套不得覆盖，安全属性不变），
  // 但旧实现「静默丢弃」嵌套的 args.workspace_dir —— 模型以为传了却没生效（实测：传
  // args.workspace_dir=…/llmsc，结果里 workspace_dir 变成会话工作区 …/0llmsc），
  // 随后 task_id 在错工作区里查 → unknown_task，且看不出原因。
  // 现在：① 成功路径回 warnings 明说「嵌套的被忽略、生效的是哪个」；
  //      ② unknown_task 时若该 task 就在嵌套工作区里 → 给精确的 task_workspace_mismatch。
  const nestedWs = typeof rawArgs?.workspace_dir === 'string' && rawArgs.workspace_dir ? rawArgs.workspace_dir : null
  const wsConflict = !!(nestedWs && resolve(nestedWs) !== resolve(workspaceDir))
  const workspaceWarnings = wsConflict
    ? [{ code: 'workspace_dir_ignored', message: 'args.workspace_dir (' + nestedWs + ') was ignored; the top-level workspace_dir (' + workspaceDir + ') is authoritative.', effective_workspace_dir: workspaceDir }]
    : []
  const taskId = typeof args?.task_id === 'string' && args.task_id ? args.task_id : null
  const task = taskId ? getTask(workspaceDir, taskId) : null
  if (taskId && !task) {
    if (wsConflict && getTask(nestedWs, taskId)) {
      return makeError(
        'task_workspace_mismatch',
        'Task ' + taskId + ' exists in workspace ' + nestedWs + ' (your args.workspace_dir), not in ' + workspaceDir + ' (the top-level workspace_dir).',
        'Pass workspace_dir="' + nestedWs + '" at the TOP level of invoke_capability — the top-level value is the task/workspace boundary; the nested args.workspace_dir is ignored.'
      )
    }
    return makeError(
      'unknown_task',
      'Task ' + taskId + ' not found in workspace_dir ' + workspaceDir + (wsConflict ? ' (your args.workspace_dir ' + nestedWs + ' is ignored — the top-level workspace_dir is authoritative)' : ''),
      'Task and workspace must match; start a code_task here or drop task_id.'
    )
  }
  // ── R01/R02（0.5.10）/ N01+N02（0.5.11 复审）：副作用委派安全收口 ──
  // 顺序契约（N01：确定性前置校验必须先于占位）：
  //   ① 只读放行 ② 请求去重/异载荷冲突（只读查账） ③ 终态守卫 ④ schema 校验 + 处理器加载（无副作用）
  //   ⑤ 占位（task: prepared op；无 task: claim + prepared） ⑥ 委派 ⑦ 全终态落账。
  //   → 参数/加载类失败绝不留下「执行中」，纠错不被 prepared 锁死。
  const effects = effectsOf(name)
  const sideEffect = !(effects.length === 1 && effects[0] === 'read')
  const reqId = typeof args?.request_id === 'string' && args.request_id ? args.request_id : null
  const { workspace_dir: _ignWs, task_id: _ignTask, request_id: _ignReq, ...payloadArgs } = rawArgs
  const payload_hash = payloadHash({ capability: name, args: payloadArgs })
  const opSeed = () => ({ operation_id: newOperationId(), request_id: null, payload_hash, kind: 'invoke', tool: name, effects, created: new Date().toISOString() })
  let taskOp = null
  let taskRevision = task ? task.revision : null
  let outletClaimed = false
  let ledgerWarningPre = null
  if (taskId && sideEffect) {
    if (reqId) {
      const prior = findOperation(task, reqId)
      if (prior) {
        if (prior.payload_hash !== payload_hash) {
          return makeError('request_conflict', 'request_id ' + reqId + ' was already used with a different payload for ' + name + '.', 'Use a fresh request_id for a different call.')
        }
        if (prior.state === 'succeeded') {
          return {
            ok: true, capability: name, delegated: false, delegated_once: true, deduplicated: true,
            workspace_dir: workspaceDir, task_id: taskId, effects, request_id: reqId, operation_succeeded: true,
            ...(workspaceWarnings.length ? { warnings: workspaceWarnings } : {}),
            operation: operationBrief(prior),
            execution: { note: 'Deduplicated: this request_id already completed with the same payload — the original side effect was NOT re-executed. Reuse the earlier observation; success != verified.' },
          }
        }
        return makeError('request_unresolved', 'request_id ' + reqId + ' has an unresolved operation (' + prior.state + '); refusing to blindly replay.', 'Inspect the workspace state; to force a fresh attempt, retry with a NEW request_id.')
      }
    }
    const guard = assertTaskWritable(task)
    if (guard) return guard
  } else if (!taskId && sideEffect && reqId) {
    const replay = replayOutlet(ledgerLookup(workspaceDir, reqId), { workspaceDir, name, reqId, payload_hash, effects })
    if (replay) return replay
  }

  // R06（0.5.10 审核修复）：出口保守子集 schema 校验——只查「确定性问题」（声明 type 的类型不符 / enum 不符），
  // 未知关键字一概忽略，宁漏勿错（44 项语料零误报为硬门槛）；required 语义不前置（如 write_symbol create 路径不需要 base_version），交下层 handler。
  {
    const schema = t.manifest.inputSchema || {}
    const argProblems = validateArgsConservative(schema, { ...rawArgs, workspace_dir: workspaceDir })
    if (argProblems) {
      const schemaRequired = [...(schema.required || [])].sort()
      return {
        ...makeError('invalid_input', 'args for ' + name + ' violate its declared schema: ' + argProblems.map((p) => p.kind === 'enum_mismatch' ? (p.arg + ' must be one of: ' + p.allowed.join(' | ')) : (p.arg + ' must be ' + p.expected + ' (got ' + p.got + ')')).join('; '), 'Fix the flagged args and retry (an unused request_id may be reused).'),
        required_args: schemaRequired,
        invalid_args: argProblems,
        next_actions: [{ action: 'call_with_valid_args', name, invalid_args: argProblems, required_args: schemaRequired, form: "invoke_capability(name='" + name + "', args={...})" }],
      }
    }
  }

  // 顶层边界：workspace_dir/task_id/request_id 以顶层为准，嵌套不得覆盖
  const delegatedArgs = {
    ...rawArgs,
    workspace_dir: workspaceDir,
    ...(taskId ? { task_id: taskId } : {}),
    ...(typeof args?.request_id === 'string' && args.request_id ? { request_id: args.request_id } : {}),
  }
  // 纵深防御：handler 路径必须落在 tools/ 内
  const handlerPath = resolve(join(TOOLS_ROOT, t.dir, t.handler))
  if (!(handlerPath === TOOLS_ROOT || handlerPath.startsWith(TOOLS_ROOT + sep))) {
    return makeError('invalid_input', 'refusing handler path outside tools/')
  }
  let mod
  try {
    mod = await import(pathToFileURL(handlerPath).href)
  } catch (e) {
    return makeError('delegate_unavailable', 'Cannot load ' + name + ': ' + (e?.message || String(e)), 'Report via feedback.')
  }
  if (typeof mod.handle !== 'function') {
    return makeError('delegate_unavailable', name + ' handler does not export handle()', 'Report via feedback.')
  }

  // ── ⑤ 占位（在所有确定性校验与加载之后：参数/加载失败绝不留「执行中」——N01）──
  if (taskId && sideEffect) {
    if (reqId) {
      const prepared = { ...opSeed(), request_id: reqId, state: 'prepared' }
      const cas = updateTaskCas(workspaceDir, taskId, taskRevision, (t) => operationEvent(t, prepared, effects.includes('workspace_write') ? { node: 'edit' } : {}))
      if (!cas.ok) {
        return makeError(cas.code === 'REVISION_CONFLICT' ? 'revision_conflict' : 'task_not_found', 'prepared-op commit failed: ' + cas.code, 'Re-read code_status and retry with the current revision.')
      }
      taskOp = prepared
      taskRevision = cas.task.revision
    }
  } else if (!taskId && sideEffect && reqId) {
    // N02：无 task 也要在执行前留痕（claim 独占 + prepared 条目），否则崩溃/并发/失败态都无法与「从未执行」区分
    const claim = ledgerClaim(workspaceDir, reqId)
    if (!claim.ok) {
      if (claim.reason === 'in_flight') {
        return makeError('request_unresolved', 'request_id ' + reqId + ' is already in flight (pid ' + claim.pid + ', since ' + claim.since + '); refusing concurrent replay.', 'Wait for the in-flight call to finish, then re-check code_status/workspace state; use a NEW request_id only if the earlier attempt is known to be abandoned.')
      }
      // claim 不可用（权限/丢盘）时仍可下调——但必须显式告知：本请求不具备跨进程互斥
      ledgerWarningPre = 'outlet claim unavailable (' + (claim.error || claim.reason) + '): this request has NO cross-process mutual exclusion for request_id ' + reqId + '.'
    } else {
      outletClaimed = true
      // The initial lookup precedes async handler loading. Another process may
      // finish in that interval, so only a fresh lookup under the claim is authoritative.
      const replay = replayOutlet(ledgerLookup(workspaceDir, reqId), { workspaceDir, name, reqId, payload_hash, effects })
      if (replay) {
        ledgerRelease(workspaceDir, reqId)
        return replay
      }
    }
    ledgerRecord(workspaceDir, {
      request_id: reqId, tool: name, payload_hash, effects, state: 'prepared',
      ok: null, created: new Date().toISOString(),
    })
  }

  let result
  try {
    result = await mod.handle(delegatedArgs, context || {})
  } catch (e) {
    const crash = { state: 'failed', error_code: 'delegate_failed' }
    if (taskId && sideEffect) recordInvokeOp(workspaceDir, taskId, taskRevision, taskOp || opSeed(), crash)
    else if (!taskId && sideEffect && reqId) {
      ledgerRecord(workspaceDir, { request_id: reqId, tool: name, payload_hash, effects, state: 'failed', ok: false, error_code: 'delegate_failed' })
      if (outletClaimed) ledgerRelease(workspaceDir, reqId)
    }
    return makeError('delegate_failed', name + ' threw: ' + (e?.message || String(e)), 'The original tool crashed; adjust inputs or report via feedback.')
  }
  const outcome = classifyDelegatedOutcome(result)
  const verification = verificationOf(result)
  let ledgerHit = null
  let ledgerWarning = ledgerWarningPre
  if (taskId && sideEffect) {
    const fin = recordInvokeOp(workspaceDir, taskId, taskRevision, taskOp || opSeed(), { ...outcome, result })
    if (!fin.ok) ledgerWarning = 'post-delegation task-state commit failed (' + fin.code + '): retry the same request_id to reconcile.'
  } else if (!taskId && sideEffect && reqId) {
    // N02：成功 / 失败 / 不确定一律落终态（旧实现只在 succeeded 落账 → 其余状态可被重放，实测双执行）
    ledgerHit = ledgerRecord(workspaceDir, {
      request_id: reqId, tool: name, payload_hash, effects,
      state: outcome.state, ok: outcome.state === 'succeeded',
      ...(outcome.error_code ? { error_code: outcome.error_code } : {}),
      result_digest: 'sha256:' + sha256Hex(safeJson(result)), result_excerpt: resultExcerpt(result),
      created: new Date().toISOString(),
    })
    if (outletClaimed) ledgerRelease(workspaceDir, reqId)
  }
  const pos = loadPositions().byName.get(name) || {}
  // R05（0.5.10）/ N03（0.5.11）：保留原 result 不动；把建议字段指向的隐藏工具引用改写为 graph 可达形式（next_actions），
  // 并抽出结构化可回放动作（name/args 保持真实类型 + 缺参显式）；结果错误带缺参语义时用 schema required 补齐 required_args。
  const nextActions = []
  for (const a of collectAdvisoryFields(result)) {
    if (nextActions.length >= 8) break
    const sanitizedText = sanitizeAdvisory(a.text)
    if (sanitizedText !== a.text) {
      const calls = extractInvokeActions(a.text, 3)
      nextActions.push({ path: a.path, text: sanitizedText, ...(calls.length ? { calls } : {}) })
    }
  }
  let requiredArgs = null
  if (outcome.state === 'failed' && result && typeof result.error === 'string' && /missing|required/i.test(result.error)) {
    requiredArgs = [...(t.manifest.inputSchema?.required || [])].sort()
    nextActions.push({ action: 'call_with_required_args', name, required_args: requiredArgs, form: "invoke_capability(name='" + name + "', args={...})" })
  }

  return {
    ok: true,
    capability: name,
    delegated: true,
    delegated_once: true,
    workspace_dir: workspaceDir,
    ...(taskId ? { task_id: taskId } : {}),
    ...(reqId ? { request_id: reqId } : {}),
    ...(workspaceWarnings.length ? { warnings: workspaceWarnings } : {}),
    ...(taskOp ? { operation: operationBrief({ ...taskOp, state: outcome.state, updated: new Date().toISOString() }) } : {}),
    ...(ledgerHit ? { ledger: ledgerHit } : {}),
    ...(ledgerWarning ? { ledger_warning: ledgerWarning } : {}),
    ...(requiredArgs ? { required_args: requiredArgs } : {}),
    ...(nextActions.length ? { next_actions: nextActions } : {}),
    ...(verification ? { verification_result: verification } : {}),
    operation_succeeded: outcome.state === 'succeeded' ? true : outcome.state === 'failed' ? false : null,
    wiring_status: pos.status || 'unknown',
    effects,
    result,
    execution: {
      note: 'Delegated exactly once to the original implementation; its result is preserved verbatim. Task-linked side effects pass the terminal guard and are recorded in the task ledger; request_id is consumed here (same id + same payload → idempotent replay; different payload → request_conflict). Success != verified; cancel != undo.' + (verification ? ' See verification_result: what actually ran/was verified — a successful call is NOT a verification pass.' : ''),
      ...(pos.note ? { limitation: pos.note } : {}),
    },
  }
}
