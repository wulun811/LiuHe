// code_patch — S2 typed write: preview/apply ONE edit under a task, anchored to a read_ref version.
// Delegates to write_symbol (journaled atomic write, base_version conflict, dry-run).
// Records an operation (prepared → succeeded/failed/indeterminate). A retry with the same request_id
// reconciles against the intended post-write hash, so a write-then-crash is not blindly re-applied.
import { existsSync, writeFileSync } from 'node:fs'
import {
  makeError, envelope, getTask, updateTaskCas, findOperation, payloadHash, newOperationId,
  traceId, fileHash, operationEvent, ensureTaskVersion, assertTaskWritable, taskHeader, unknownTaskError, addWriteBasesToTask, writeBasesForOperation,
} from '../entry-shared.js'
import { handle as writeSymbolHandle } from '../tool-write-symbol/handler.js'
import { serializeReceipt, opGuarantee } from '../../workflow/receipt.js'

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
  // §7.6-3：CAS 前置校验（显式锚定 revision 时不接受漂移）
  if (args?.expected_state_revision != null && args.expected_state_revision !== task.revision) {
    return makeError('revision_conflict', `expected_state_revision=${args.expected_state_revision}, current=${task.revision}`, 'Re-read code_status and retry with the current revision.')
  }

  // 目标锚点：read_ref 供 locator+base_version（不让模型拼哈希，N02）；也允许显式 locator/base_version
  const read_ref = args?.read_ref
  let material = null
  if (typeof read_ref === 'string' && read_ref) {
    material = [...(task.materials || []), ...(task.write_bases || [])].find(m => m.read_ref === read_ref) || null
    if (!material) {
      return makeError('read_ref_not_found', `Unknown read_ref: ${read_ref}`, 'Use a read_ref from code_read, or a wbase_* from a successful write.')
    }
  }
  let locator = (args?.locator && typeof args.locator === 'object') ? { ...args.locator } : null
  if (!locator && material) locator = { ...material.locator }
  if (locator && !locator.file_path && material?.canonical_path) locator.file_path = material.canonical_path
  if (!locator || !locator.file_path) {
    return makeError('missing_parameter', 'read_ref or locator.file_path is required', 'code_read a symbol or the FILE first, then pass read_ref. Apply shape: {workspace_dir, task_id, read_ref: "read_1", patch: {old_string: "...", new_string: "..."}}')
  }

  const edit_mode = args?.edit_mode || (args?.patch ? 'patch' : 'replace_symbol')
  if (!['patch', 'replace_symbol'].includes(edit_mode)) {
    return makeError('invalid_input', `edit_mode must be patch or replace_symbol (got ${edit_mode})`)
  }
  const dry_run = args?.dry_run !== false // 默认预览（显式 dry_run:false 才落盘）
  // WP08R-3 A3：批量劝导——同 task 同文件已成功的逐处 code_patch 计数（rb1 实拍 53 次逐处化）
  const priorPatchOps = (task.operations || []).filter(o => o.kind === 'patch' && o.file === locator.file_path && o.state === 'succeeded').length
  const batchNudge = priorPatchOps >= 2
    ? 'STOP single-edit mode: this is code_patch #' + (priorPatchOps + 1) + ' on ' + locator.file_path + ' in this task. Read the FILE once (if not already), then submit ALL remaining edits in ONE code_batch (dry_run first, then reuse the same writes with dry_run:false). One code_batch replaces any number of code_patch calls.'
    : priorPatchOps === 1
      ? 'Note: this is the 2nd code_patch on ' + locator.file_path + ' in this task. If more edits are coming, read the FILE once and submit them ALL in ONE code_batch instead of one-by-one (writes: [{read_ref, patch: {old_string, new_string}}, ...]).'
      : null
  const writeArgs = {
    workspace_dir: workspaceDir, locator, edit_mode,
    patch: args?.patch, content: args?.content, boundary: args?.boundary, safety: args?.safety,
    create: args?.create === true,
    ...(args?.preserve_decorators === false ? { preserve_decorators: false } : {}),
    ...(args?.allow_unsafe_no_base === true ? { allow_unsafe_no_base: true } : {}),
  }

  const payload_hash = payloadHash({
    task_id, file: locator.file_path, edit_mode,
    patch: args?.patch || null, content: args?.content ?? null, boundary: args?.boundary || null,
    ...(args?.create === true ? { create: true } : {}),
  })

  // 去重先于 CAS（§7.6）：同 request_id 同载荷 → 幂等；不同载荷 → 拒绝
  let op = findOperation(task, args?.request_id)
  if (op) {
    if (op.payload_hash !== payload_hash) {
      return makeError('request_conflict', `request_id ${args.request_id} was used with a different payload`, 'Use a fresh request_id for a different edit.')
    }
    if (op.state === 'succeeded') {
      // P3 补齐（0.5.18）：重放也带回首次登记的 wbase_*（不新建、不推 revision）
      const dedupRefs = writeBasesForOperation(task, op.operation_id)
      return envelope({
        task: { task_id: task.task_id, revision: task.revision, route: task.route, node: task.node, lifecycle: task.lifecycle },
        observation: {
          summary: `Deduplicated: edit already applied (${op.operation_id}).`,
          deduplicated: true, effect: 'workspace_write', result_kind: task.result_kind || 'partial',
          target: { canonical_path: op.file, result_file_hash: op.result_file_hash },
          operation: op,
          ...(Object.keys(dedupRefs).length ? { write_read_refs: dedupRefs } : {}),
        },
        allowed_actions: ['code_read', 'code_patch', 'code_status'],
        extra: { request_id: args.request_id, result_kind: task.result_kind || 'partial' },
      })
    }
  }

  // LH-001：终态守卫——cancelled 任务拒绝新副作用操作（上面的 succeeded dedup 复读已放行）
  const guard = assertTaskWritable(task)
  if (guard) return guard

  const base_version = op?.base_version
    || (material ? { file: material.file_version, symbol: material.symbol_version || null } : null)
    || args?.base_version
    || null

  // ── 预览：不落盘、不记操作 ──
  if (dry_run) {
    const r = await writeSymbolHandle({ ...writeArgs, base_version, dry_run: true }, context)
    if (r?.error) return { ...mapWriteError(r, null, { workspace_dir: workspaceDir, task_id }), ...(batchNudge ? { batch_hint: batchNudge } : {}) }
    const v = r.validation || null
    const vHardFail = !!v && (v.syntax?.status === 'fail' || v.bracket?.status === 'fail')
    const vSkip = !!v && v.syntax?.status === 'skip'
    // WP08R-3 A2：预览免 base——预览结果可用，但 apply 需要 file 级 read（下一步直接给 code_read）
    // 狗粮r2 修复：create:true 新建文件本无 base——不得走 noBasePreview（否则误导去 read 不存在的文件）
    const isCreate = args?.create === true
    const noBasePreview = !base_version && !isCreate
    return envelope({
      task: taskHeader(task),
      observation: {
        summary: vHardFail
          ? `Preview has validation errors for ${locator.file_path} (edit_mode=${isCreate ? 'create' : edit_mode}); apply will be blocked unless safety.block_on_validation_error=false. No file changed.`
          : `Preview OK for ${locator.file_path} (edit_mode=${isCreate ? 'create' : edit_mode})${vSkip ? ' [syntax unverified: skip]' : ''}. No file changed.`,
        effect: 'preview', dry_run: true,
        target: { canonical_path: locator.file_path, locator, read_ref: read_ref || null },
        new_version: r.new_version || null,
        diff: r.diff || null, validation: v,
        ...((vHardFail || noBasePreview) ? { warning: [vHardFail ? 'syntax/bracket validation failed — apply will be blocked unless safety.block_on_validation_error=false' : null, noBasePreview ? 'no base_version: applying requires a file-level read first — code_read the FILE (whole file; a symbol read does not establish a file base), then re-issue with that read_ref.' : null].filter(Boolean).join(' ') } : {}),
        ...(noBasePreview ? { preview_without_base: true } : {}),
      },
      allowed_actions: ['code_patch', 'code_read', 'code_status'],
      extra: {
        request_id: args?.request_id,
        ...(batchNudge ? { batch_hint: batchNudge } : {}),
        next_action: noBasePreview
          ? { tool: 'code_read', args: { workspace_dir: workspaceDir, task_id, locator: { file_path: locator.file_path } }, note: 'Preview OK (no file changed) but no base_version is available: read the FILE first, then re-issue code_patch with that read_ref and dry_run:false to apply.' }
          : (() => {
            // 协议压缩（2026-10-12 狗粮）：大载荷不回显（对齐 code_batch WP08R-2 阈值 2KB）——调用方手里就有原载荷，
            // 回显纯重复；超限改「复用指示」防截断误导。
            const echoBytes = Buffer.byteLength(JSON.stringify({ patch: args?.patch ?? null, content: args?.content ?? null }), 'utf8')
            const echoPayload = echoBytes <= 2048
            return {
              tool: 'code_patch',
              args: {
                workspace_dir: workspaceDir,
                task_id,
                ...(read_ref ? { read_ref } : { locator }),
                ...(isCreate ? {} : { edit_mode }),
                ...(echoPayload && args?.patch ? { patch: args.patch } : {}),
                ...(echoPayload && args?.content !== undefined ? { content: args.content } : {}),
                ...(args?.boundary ? { boundary: args.boundary } : {}),
                ...(args?.create === true ? { create: true } : {}),
                ...(args?.preserve_decorators === false ? { preserve_decorators: false } : {}),
                ...(args?.allow_unsafe_no_base === true ? { allow_unsafe_no_base: true } : {}),
                ...(args?.safety ? { safety: args.safety } : {}),
                dry_run: false,
                ...(args?.request_id ? { request_id: args.request_id } : {}),
              },
              note: vHardFail
                ? 'Not executable yet: fix the validation errors and preview again.'
                : (echoPayload
                  ? 'Preview only (no file changed). Call code_patch with these args to apply; the edit payload is already included.'
                  : 'Preview only (no file changed). Payload ' + echoBytes + 'B too large to echo — reuse the exact patch/content from your previous call, with dry_run:false.'),
            }
          })(),
        next_step: noBasePreview ? 'Preview only (no file changed; no base_version). Read the FILE first with code_read, then re-issue code_patch with that read_ref and dry_run:false to apply.' : 'Preview only. To apply, call code_patch with next_action.args (dry_run=false); large payloads are reused from your previous call, not echoed.',
      },
    })
  }

  // ── 恢复：对已存在的 prepared/failed/indeterminate 操作做核对，不盲目重放（W1/W3）──
  if (op) {
    const rec = reconcileOperation(workspaceDir, task_id, task.revision, op, task.route, task.lifecycle)
    if (rec) return rec
    // 否则（prepared/failed 且文件仍为写前状态）落到下方重试
  }

  // ── 应用 ──
  let currentRev = task.revision
  if (args?.request_id && !op) {
    // 16-A 测试闸门（仅 env）：把预校验冻结在并发写者提交之前，确定性复现「任务快照早于双胞胎提交」窗口。
    // 到达闸门先落 .reached 信号，再等闸门文件（≤10s）；未设 env 零开销。
    if (process.env.MALONG_TEST_PREVALIDATE_GATE) {
      const gate = process.env.MALONG_TEST_PREVALIDATE_GATE
      try { writeFileSync(gate + '.reached', '') } catch {}
      const deadline = Date.now() + 10000
      while (!existsSync(gate) && Date.now() < deadline) await new Promise(r => setTimeout(r, 25))
    }
    // 先 dry_run 求 intended 哈希（预校验 + 崩溃后识别“已写”），不落盘
    const pv = await writeSymbolHandle({ ...writeArgs, base_version, dry_run: true }, context)
    if (pv?.error) {
      // 15-D/16-A（专家复验 §4）：并发输家可能在这里首次看到「文件已变」——同请求必须归因，
      // 不能误报 FILE_CHANGED 引导换 read_ref。
      if (writeErrorCode(pv) === 'VERSION_CONFLICT') {
        const rec = sameRequestEnvelope(workspaceDir, task_id, task, {
          request_id: args.request_id, payload_hash, ownOp: op || null, expectedRev: task.revision,
        })
        if (rec) return rec
      }
      return { ...mapWriteError(pv, null, { workspace_dir: workspaceDir, task_id }), ...(batchNudge ? { batch_hint: batchNudge } : {}) }
    }
    const prepared = {
      operation_id: newOperationId(),
      request_id: args.request_id,
      payload_hash, state: 'prepared', kind: 'patch',
      file: locator.file_path, read_ref: read_ref || null, base_version,
      pre_file_hash: fileHash(workspaceDir, locator.file_path),
      intended_file_hash: pv.new_version?.file?.hash || null,
      created: new Date().toISOString(),
    }
    const cas = updateTaskCas(workspaceDir, task_id, task.revision, (t) => operationEvent(t, prepared, { node: 'edit' }))
    if (!cas.ok) {
      return makeError(
        cas.code === 'REVISION_CONFLICT' ? 'revision_conflict' : 'task_not_found',
        cas.code === 'REVISION_CONFLICT'
          ? `task revision changed: expected=${task.revision}, current=${cas.current}`
          : `Unknown task_id: ${task_id}`,
      )
    }
    currentRev = cas.task.revision
    op = prepared
  }

  const r = await writeSymbolHandle({ ...writeArgs, base_version, dry_run: false }, context)

  const now = new Date().toISOString()
  if (r?.error) {
    // 15-D（专家 621f6f8 §4.4）：同请求并发收口——锁内版本不符时先按「同 request_id / 同意图」核对，
    // 不把同请求成功造成的内容变化误指为「外部变化」引导换 read_ref：
    // 双胞胎已完成 → 同身份 dedup；文件已是本请求意图态 → intended 核对收口；双胞胎在途 → 原样重试口径。
    if (op?.request_id && writeErrorCode(r) === 'VERSION_CONFLICT') {
      const rec = sameRequestEnvelope(workspaceDir, task_id, task, {
        request_id: op.request_id, payload_hash: op.payload_hash, ownOp: op, expectedRev: currentRev,
      })
      if (rec) return rec
    }
    // WP04：READBACK_MISMATCH = 文件已写但内容不可信 → indeterminate（非 failed）；重试同 request_id 按 intended hash reconcile 终态收口
    if (op) finalizeOperation(workspaceDir, task_id, currentRev, op, { state: writeErrorCode(r) === 'READBACK_MISMATCH' ? 'indeterminate' : 'failed', error_code: writeErrorCode(r), updated: now })
    return { ...mapWriteError(r, op, { workspace_dir: workspaceDir, task_id }), ...(batchNudge ? { batch_hint: batchNudge } : {}) }
  }

  // 14-C AC27 受控故障注入（仅测试 env；故障注入只在临时隔离工作区）：
  // 真实文件已写、成功事件（finalOp）未落盘时终止进程——验证重启同 request_id 的核对恢复
  if (process.env.MALONG_TEST_KILL_AFTER_WRITE === '1') process.kill(process.pid, 'SIGKILL')

  const finalOp = {
    ...(op || { operation_id: newOperationId(), request_id: null, payload_hash, kind: 'patch', file: locator.file_path, read_ref: read_ref || null, base_version, created: now }),
    state: 'succeeded', updated: now,
    result_file_hash: r.new_version?.file?.hash || null,
    result_kind: 'partial',
    txn_id: r.txn_id || null,
    ...(r.status === 'already_applied' ? { already_applied: true } : {}),
  }
  let writeBases = {}
  const cas2 = updateTaskCas(workspaceDir, task_id, currentRev, (t) => {
    const ev = operationEvent(t, finalOp, { node: 'edit', result_kind: 'partial' })
    writeBases = addWriteBasesToTask(t, workspaceDir,
      [{ file: locator.file_path, hash: r.new_version?.file?.hash }],
      { operation_id: finalOp.operation_id })
    return ev
  })
  if (!cas2.ok) {
    // 文件已写但任务状态提交竞态：保留 succeeded 语义，重试同 request_id 可终态收口
    return envelope({
      task: taskHeader({ ...task, revision: currentRev, node: 'edit' }),
      observation: {
        summary: `Edit applied to ${locator.file_path}, but task state commit raced (${cas2.code}); retry with the same request_id to finalize.`,
        effect: 'workspace_write', committed: false, result_kind: 'partial',
        target: { canonical_path: locator.file_path }, diff: r.diff || null, operation: finalOp,
        receipt: serializeReceipt({
          kind: 'patch', operation_id: finalOp.operation_id, request_id: args.request_id || null,
          ...opGuarantee('patch', args.create === true),
          files: [{ file: locator.file_path, status: 'written', pre_file_hash: finalOp.pre_file_hash || null, intended_file_hash: finalOp.intended_file_hash || null, result_file_hash: finalOp.result_file_hash || null }],
          committed: false, result_kind: 'partial', index_sync: r.reindex || null, undo: r.undo || null,
        }),
      },
      allowed_actions: ['code_patch', 'code_read', 'code_status'],
      extra: { request_id: args.request_id, result_kind: 'partial', warning: 'state_commit_pending' },
    })
  }

  // P3（0.5.17）：write_bases 已在记录成功操作的同一 CAS 里登记（不额外推 revision）
  return envelope({
    task: taskHeader(cas2.task),
    observation: {
      summary: `Applied edit to ${locator.file_path} (${r.status === 'already_applied' ? 'already present' : 'written'}). result_kind=partial (no checks run).`,
      effect: 'workspace_write', committed: true, result_kind: 'partial',
      target: { canonical_path: locator.file_path, locator, read_ref: read_ref || null, file_version: r.new_version?.file || null },
      diff: r.diff || null, validation: r.validation || null, reindex: r.reindex || null,
      operation: finalOp,
      ...(Object.keys(writeBases).length ? { write_read_refs: writeBases } : {}),
      receipt: serializeReceipt({
        kind: 'patch', operation_id: finalOp.operation_id, request_id: args?.request_id || null,
        ...opGuarantee('patch', args?.create === true),
        files: [{ file: locator.file_path, status: r.status === 'already_applied' ? 'already_applied' : 'written', pre_file_hash: finalOp.pre_file_hash || null, intended_file_hash: finalOp.intended_file_hash || null, result_file_hash: finalOp.result_file_hash || null }],
        committed: true, result_kind: 'partial', index_sync: r.reindex || null, undo: r.undo || null, readback: 'enforced',
      }),
    },
    allowed_actions: ['code_read', 'code_patch', 'code_status'],
    extra: {
      request_id: args?.request_id, result_kind: 'partial', undo: r.undo || null,
      ...(batchNudge ? { batch_hint: batchNudge } : {}),
      // 13-C（专家 c2a83e4 P3-a）：应用成功补结构化检查边（旧只有文字建议，需再查 status 才出现）
      next_action: { tool: 'code_check', args: { workspace_dir: workspaceDir, task_id, checks: ['test'], run: true }, note: 'Edit applied (result_kind=partial): run checks to validate (run=true executes).' },
      next_step: (batchNudge && priorPatchOps >= 2) ? 'STOP single-edit mode — put ALL remaining edits in ONE code_batch (read FILE once → dry_run → reuse writes with dry_run:false). For the current edit: re-read or run code_check to confirm.' : 'Run code_check to validate, or reuse write_read_refs (wbase_*) as the base for the next edit — no re-read needed.',
    },
  })
}

// 重试核对：intended 命中 → 判为已写并收口；文件被外部改成第三种态 → indeterminate（拒绝盲目重放）
// 15-D/16-A（专家 621f6f8 §4.4 + 复验 §4）：同请求并发归因共用出口——双胞胎已完成 → 同身份 dedup；
// 自身 op 意图态命中 → 核对收口；双胞胎在途 → 原样重试口径。无同请求证据 → null（走通用错误映射）。
function sameRequestEnvelope(workspaceDir, task_id, task, { request_id, payload_hash, ownOp = null, expectedRev }) {
  const fresh = getTask(workspaceDir, task_id)
  const twins = ((fresh?.operations) || []).filter(o => o.request_id === request_id && o.payload_hash === payload_hash && (!ownOp || o.operation_id !== ownOp.operation_id))
  const twinDone = twins.find(o => o.state === 'succeeded')
  const now = new Date().toISOString()
  if (twinDone) {
    if (ownOp) finalizeOperation(workspaceDir, task_id, fresh?.revision ?? expectedRev, ownOp, { state: 'failed', error_code: 'superseded_same_request', updated: now })
    return envelope({
      task: taskHeader(fresh || task),
      observation: {
        summary: 'Deduplicated: the identical request was already applied by a concurrent process (' + twinDone.operation_id + ').',
        deduplicated: true, effect: 'workspace_write', committed: true, result_kind: fresh?.result_kind || 'partial',
        target: { canonical_path: twinDone.file, result_file_hash: twinDone.result_file_hash },
        operation: twinDone,
      },
      allowed_actions: ['code_read', 'code_patch', 'code_status'],
      extra: { request_id, result_kind: fresh?.result_kind || 'partial' },
    })
  }
  if (ownOp) {
    const cur = fileHash(workspaceDir, ownOp.file)
    if (ownOp.intended_file_hash && cur === ownOp.intended_file_hash) {
      const rec = reconcileOperation(workspaceDir, task_id, expectedRev, ownOp, task.route, task.lifecycle)
      if (rec) return rec
    }
  }
  const twinFlight = twins.find(o => ['prepared', 'running'].includes(o.state))
  if (twinFlight) {
    if (ownOp) finalizeOperation(workspaceDir, task_id, fresh?.revision ?? expectedRev, ownOp, { state: 'failed', error_code: 'superseded_same_request', updated: now })
    return envelope({
      task: taskHeader(fresh || task),
      observation: {
        summary: 'The identical request is in flight in another process (' + twinFlight.operation_id + '); retry the same request_id to settle (do not change read_ref or payload).',
        same_request_in_flight: true, retry_same_request: true, operation_id: twinFlight.operation_id,
      },
      allowed_actions: ['code_control', 'code_patch', 'code_status'],
      extra: { request_id, retry_same_request: true },
    })
  }
  return null
}

export function reconcileOperation(workspaceDir, task_id, expectedRev, op, route, lifecycle = 'active') {
  const cur = fileHash(workspaceDir, op.file)
  if (op.intended_file_hash && cur === op.intended_file_hash) {
    const now = new Date().toISOString()
    const fin = { ...op, state: 'succeeded', updated: now, result_file_hash: cur, result_kind: 'partial' }
    const cas = updateTaskCas(workspaceDir, task_id, expectedRev, (t) => operationEvent(t, fin, { node: 'edit', result_kind: 'partial' }))
    if (!cas.ok) {
      // 第二轮审查：CAS 失败不得宣称 committed——文件已是 intended 态但 op 未收口，如实报待重试
      return makeError('state_commit_pending', `recovered write detected but state commit raced (${cas.code}); retry with the same request_id`, 'Retry with the same request_id to finalize.')
    }
    const revision = cas.task.revision
    return envelope({
      task: { task_id, revision, route, node: 'edit', lifecycle },
      observation: {
        summary: `Recovered: edit had already been written before the interruption (${op.operation_id}); finalized without re-applying.`,
        deduplicated: true, recovered: true, effect: 'workspace_write', committed: true, result_kind: 'partial',
        target: { canonical_path: op.file, result_file_hash: cur }, operation: fin,
      },
      allowed_actions: ['code_read', 'code_patch', 'code_status'],
      extra: { request_id: op.request_id, result_kind: 'partial' },
    })
  }
  if (op.state === 'indeterminate' || (op.pre_file_hash && cur && cur !== op.pre_file_hash)) {
    const now = new Date().toISOString()
    const fin = { ...op, state: 'indeterminate', updated: now, current_file_hash: cur }
    try {
      updateTaskCas(workspaceDir, task_id, expectedRev, (t) => operationEvent(t, fin))
    } catch {}
    return makeError('indeterminate', `operation ${op.operation_id} is indeterminate: file is neither the pre-write nor the intended state (external change or partial write).`, 'Re-read the file with code_read and start a new request_id; do not blind-retry.')
  }
  return null
}

// op 终态收口（failed）；CAS 失败不抛（文件已定，重试可收口）
function finalizeOperation(workspaceDir, task_id, expectedRev, op, patch) {
  try {
    return updateTaskCas(workspaceDir, task_id, expectedRev, (t) => operationEvent(t, { ...op, ...patch }))
  } catch { return null }
}

function writeErrorCode(r) {
  const e = r?.error
  if (e && typeof e === 'object') return e.code || 'write_failed'
  if (typeof e === 'string') return e
  return 'write_failed'
}

// dogfood-050 P3：S2 的读工具是 code_read——底层 write-runtime 文案写死 read_symbol，透出前归一
function toS2ReadTool(text) {
  return typeof text === 'string' ? text.replace(/\bread_symbol\b/g, 'code_read') : text
}

// WP08R-2 G2：错误 next_action 可执行化——params 键归一 args + 补全 workspace_dir/task_id（取出即可直接调用）
function toExecutableNextAction(na, ctx) {
  const tool = na?.tool === 'read_symbol' ? 'code_read' : na?.tool
  const src = (na?.args && typeof na.args === 'object') ? na.args : ((na?.params && typeof na.params === 'object') ? na.params : {})
  const args = { ...src }
  if (ctx?.workspace_dir != null && args.workspace_dir == null) args.workspace_dir = ctx.workspace_dir
  if (ctx?.task_id != null && args.task_id == null) args.task_id = ctx.task_id
  return { tool, args, note: na?.note || ('Re-run ' + tool + ' with these args to fill the failed write precondition.') }
}

function mapWriteError(r, op, ctx) {
  const e = (r?.error && typeof r.error === 'object') ? r.error : {}
  const code = writeErrorCode(r)
  return {
    ok: false,
    error: code,
    code,
    message: toS2ReadTool(e.message || r?.message) || 'write failed',
    ...(e.conflict_type ? { conflict_type: e.conflict_type } : {}),
    ...(e.candidates ? { candidates: e.candidates } : {}),
    ...(r?.current_version ? { current_version: r.current_version } : {}),
    ...(e.suggestion || r?.suggestion ? { suggestion: toS2ReadTool(e.suggestion || r.suggestion) } : {}),
    ...(e.next_action ? { next_action: toExecutableNextAction(e.next_action, ctx) } : {}),
    ...(op ? { operation: { operation_id: op.operation_id, state: op.state } } : {}),
    trace_id: traceId(),
  }
}