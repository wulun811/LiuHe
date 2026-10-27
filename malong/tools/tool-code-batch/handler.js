// code_batch — S3 typed multi-file write: preview/apply N edits under a task, anchored per read_ref.
// Delegates to writeSymbols (grouped per file, sorted lock order, per-file atomic write, batch marker,
// compensation rollback). Records ONE operation per batch (prepared → succeeded/failed/indeterminate).
// Retry with the same request_id reconciles per-file pre/intended hashes, so a write-then-crash is not
// blindly re-applied (W1/W3); a mixed/external state is indeterminate and refused.
import { existsSync } from 'node:fs'
import {
  makeError, envelope, getTask, updateTaskCas, findOperation, payloadHash, newOperationId,
  traceId, fileHash, operationEvent, ensureTaskVersion, assertTaskWritable, taskHeader, unknownTaskError, addWriteBasesToTask, writeBasesForOperation,
  forwardWriteErrorDetail,
} from '../entry-shared.js'
import { writeSymbols } from '../../write-runtime.js'
import { serializeReceipt, opGuarantee } from '../../workflow/receipt.js'

const EDIT_MODES = ['patch', 'replace_symbol', 'insert_after_symbol']

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
  if (args?.expected_state_revision != null && args.expected_state_revision !== task.revision) {
    return makeError('revision_conflict', `expected_state_revision=${args.expected_state_revision}, current=${task.revision}`, 'Re-read code_status and retry with the current revision.')
  }

  const writesIn = args?.writes
  if (!Array.isArray(writesIn) || writesIn.length === 0) {
    return makeError('missing_parameter', 'writes is required (non-empty array)', 'Pass at least one edit.')
  }

  // ── 归一化每条写项：read_ref → locator + base_version（N02，不让模型拼哈希）──
  const materials = [...(task.materials || []), ...(task.write_bases || [])]
  // WP08R-4（c1b 实拍）：顶层 read_ref 作为缺省 base（code_patch 习惯带入），仅继承给同文件写项
  const normPath = (p) => String(p || '').replace(/\\/g, '/').replace(/^\.\//, '')
  const topRef = (typeof args?.read_ref === 'string' && args.read_ref) ? args.read_ref : null
  let topMaterial = null
  if (topRef) {
    topMaterial = materials.find(m => m.read_ref === topRef) || null
    if (!topMaterial) return makeError('read_ref_not_found', `read_ref: unknown read_ref ${topRef}`, 'Use a read_ref from code_read, or a wbase_* from a successful write.')
  }
  const normalized = []
  for (let i = 0; i < writesIn.length; i++) {
    const w = writesIn[i]
    if (!w || typeof w !== 'object') return makeError('invalid_input', `writes[${i}] must be an object`)
    const rr = (typeof w.read_ref === 'string' && w.read_ref) ? w.read_ref : null
    let material = null
    if (rr) {
      material = materials.find(m => m.read_ref === rr) || null
      if (!material) return makeError('read_ref_not_found', `writes[${i}]: unknown read_ref ${rr}`, 'Use a read_ref from code_read, or a wbase_* from a successful write.')
    } else if (topMaterial) {
      const itemFile = (w.locator && typeof w.locator === 'object' && w.locator.file_path) || null
      if (!itemFile || normPath(itemFile) === normPath(topMaterial.canonical_path)) material = topMaterial
    }
    let locator = (w.locator && typeof w.locator === 'object') ? { ...w.locator } : null
    if (!locator && material) locator = { ...material.locator }
    if (locator && !locator.file_path && material?.canonical_path) locator.file_path = material.canonical_path
    if (!locator || !locator.file_path) {
      return makeError('missing_parameter', 'writes[' + i + '] requires read_ref or locator.file_path', 'code_read a symbol or the FILE first, then pass read_ref. Item shape: {read_ref: "read_1", patch: {old_string: "...", new_string: "..."}}, or {locator: {file_path}} on the first write after a FILE read.')
    }
    const edit_mode = w.edit_mode || (w.patch ? 'patch' : 'replace_symbol')
    if (!EDIT_MODES.includes(edit_mode)) {
      return makeError('invalid_input', `writes[${i}]: edit_mode must be one of ${EDIT_MODES.join('/')} (got ${edit_mode})`)
    }
    const base_version = w.base_version
      || (material ? { file: material.file_version, symbol: material.symbol_version || null } : null)
      || null
    normalized.push({
      file_path: locator.file_path, locator, edit_mode,
      patch: w.patch, content: w.content, boundary: w.boundary,
      base_version, read_ref: rr, create: w.create === true,
      ...(w.preserve_decorators === false ? { preserve_decorators: false } : {}),
    })
  }
  const files = [...new Set(normalized.map(n => n.file_path))]
  const allOrNothing = args?.policy?.all_or_nothing !== false
  const dry_run = args?.dry_run !== false

  const payload_hash = payloadHash({
    task_id,
    writes: normalized.map(n => ({
      file: n.file_path, edit_mode: n.edit_mode,
      patch: n.patch || null, content: n.content ?? null, boundary: n.boundary || null,
      base: n.base_version?.file?.hash || null, ...(n.create === true ? { create: true } : {}),
    })),
  })

  // ── 去重先于 CAS（§7.6）：同 request_id 同载荷 → 幂等；不同载荷 → 拒绝 ──
  let op = findOperation(task, args?.request_id)
  if (op) {
    if (op.payload_hash !== payload_hash) {
      return makeError('request_conflict', `request_id ${args.request_id} was used with a different payload`, 'Use a fresh request_id for a different batch.')
    }
    if (op.state === 'succeeded') {
      // P3 补齐（0.5.18）：重放也带回首次登记的 wbase_*（不新建、不推 revision）
      const dedupRefs = writeBasesForOperation(task, op.operation_id)
      return envelope({
        task: { task_id: task.task_id, revision: task.revision, route: task.route, node: task.node, lifecycle: task.lifecycle },
        observation: {
          summary: `Deduplicated: batch already applied (${op.operation_id}).`,
          deduplicated: true, effect: 'workspace_write', result_kind: task.result_kind || 'partial',
          files: op.files, operation: op,
          ...(Object.keys(dedupRefs).length ? { write_read_refs: dedupRefs } : {}),
        },
        allowed_actions: ['code_read', 'code_batch', 'code_status'],
        extra: { request_id: args.request_id, result_kind: task.result_kind || 'partial' },
      })
    }
  }

  // LH-001：终态守卫——cancelled 任务拒绝新副作用操作（上面的 succeeded dedup 复读已放行）
  const guard = assertTaskWritable(task)
  if (guard) return guard

  const writeArgs = {
    workspace_dir: workspaceDir,
    writes: normalized.map(n => ({
      file_path: n.file_path, locator: n.locator, edit_mode: n.edit_mode,
      patch: n.patch, content: n.content, boundary: n.boundary, base_version: n.base_version,
      create: n.create === true,
      ...(n.preserve_decorators === false ? { preserve_decorators: false } : {}),
    })),
    policy: { all_or_nothing: allOrNothing },
    ...(args?.safety ? { safety: args.safety } : {}),
    ...(args?.allow_unsafe_no_base === true ? { allow_unsafe_no_base: true } : {}),
  }

  // ── 预览：不落盘、不记操作 ──
  if (dry_run) {
    const r = await runBatch(writeArgs, true, context)
    if (!r.success) return mapBatchError(r, null, { workspace_dir: workspaceDir, task_id })
    const vmap = r.validation || {}
    const previewErrorFiles = Object.entries(vmap).filter(([, v]) => v?.syntax?.status === 'fail' || v?.bracket?.status === 'fail').map(([f]) => f)
    const previewHasErrors = previewErrorFiles.length > 0
    // WP08R-3 A2：预览免 base——无 base 的 write（非 create）不影响预览；apply 前需 file 级 read
    const missingBaseFiles = normalized.filter(n => !n.base_version && n.create !== true).map(n => n.file_path)
    const noBasePreview = missingBaseFiles.length > 0
    // WP08R-2 G4（D2 决策）：预览回显 ≤2KB 抄写友好；超限改「复用」指示（R5 实测：预览+apply 双回显占工具字符 40%）
    const writesEchoBytes = Buffer.byteLength(JSON.stringify(args?.writes || []), 'utf8')
    const applyArgs = { workspace_dir: workspaceDir, task_id, dry_run: false, ...(args?.policy ? { policy: args.policy } : {}), ...(args?.safety ? { safety: args.safety } : {}), ...(args?.allow_unsafe_no_base === true ? { allow_unsafe_no_base: true } : {}), ...(args?.request_id ? { request_id: args.request_id } : {}) }
    const applyNote = previewHasErrors
      ? 'Not executable yet: fix the validation errors and preview again.'
      : (writesEchoBytes <= 2048
        ? 'Preview only (no file changed). Call code_batch with these args to apply.'
        : 'Preview only (no file changed). Payload ' + writesEchoBytes + 'B too large to echo — reuse the exact writes from your previous call, with dry_run:false.')
    const applyNextAction = noBasePreview
      ? { tool: 'code_read', args: { workspace_dir: workspaceDir, task_id, locator: { file_path: missingBaseFiles[0] } }, note: 'Preview OK (no file changed) but no base_version for: ' + missingBaseFiles.join(', ') + '. Read each FILE first (code_read whole file), then resubmit the same writes with read_refs and dry_run:false.' }
      : (writesEchoBytes <= 2048
        ? { tool: 'code_batch', args: { ...applyArgs, writes: args?.writes }, note: applyNote }
        : { tool: 'code_batch', args: applyArgs, note: applyNote })
    return envelope({
      task: taskHeader(task),
      observation: {
        summary: previewHasErrors
          ? `Preview has validation errors for ${previewErrorFiles.length} file(s) (${previewErrorFiles.join(', ')}); apply will be blocked unless safety.block_on_validation_error=false. No file changed.`
          : `Preview OK for ${normalized.length} edit(s) across ${files.length} file(s), mode=${allOrNothing ? 'all_or_nothing' : 'best_effort'}. No file changed.`,
        effect: 'preview', dry_run: true, files,
        ...((previewHasErrors || noBasePreview) ? { warning: [previewHasErrors ? 'syntax/bracket validation failed — apply will be blocked unless safety.block_on_validation_error=false' : null, noBasePreview ? 'no base_version for: ' + missingBaseFiles.join(', ') + ' — applying requires file-level reads first (a symbol read does not establish a file base)' : null].filter(Boolean).join(' ') } : {}),
        ...(noBasePreview ? { preview_without_base: true } : {}),
        intended_files: r.intended_files || null, diff: r.diff || null, validation: r.validation || null,
        ...(r.partial_failures ? { partial_failures: r.partial_failures } : {}),
      },
      allowed_actions: ['code_batch', 'code_read', 'code_status'],
      extra: {
        request_id: args?.request_id,
        next_action: applyNextAction,
        next_step: noBasePreview ? 'Preview only (no file changed; no base_version). Read the FILE(s) first with code_read, then resubmit the same writes with read_refs and dry_run:false.' : (writesEchoBytes <= 2048 ? 'Preview only. To apply, call code_batch with next_action.args (dry_run=false).' : 'Preview only. To apply, reuse your previous writes with dry_run=false (payload too large to echo).'),
      },
    })
  }

  // ── 恢复：对已存在的 prepared/failed/indeterminate 操作做核对，不盲目重放（W1/W3）──
  if (op) {
    const rec = reconcileBatch(workspaceDir, task_id, task.revision, op, task.route, task.lifecycle)
    if (rec) return rec
    // 否则（prepared/failed 且所有文件仍为写前态）落到下方重试
  }

  // ── 应用 ──
  let currentRev = task.revision
  if (args?.request_id && !op) {
    // 先 dry_run 取每文件 intended 哈希（预校验 + 崩溃后识别“已写”），不落盘
    // all_or_nothing：预演失败即拒；best_effort：允许逐文件失败，仅对预演通过的文件记 intended
    const pv = await runBatch(writeArgs, true, context)
    if (!pv.success && allOrNothing) return mapBatchError(pv, null, { workspace_dir: workspaceDir, task_id })
    const plannedFiles = pv.intended_files ? Object.keys(pv.intended_files) : files
    const pre_hashes = {}
    for (const f of plannedFiles) if (!(f in pre_hashes)) pre_hashes[f] = fileHash(workspaceDir, f)
    const prepared = {
      operation_id: newOperationId(),
      request_id: args.request_id,
      payload_hash, state: 'prepared', kind: 'batch',
      files: plannedFiles, mode: allOrNothing ? 'all_or_nothing' : 'best_effort',
      base_versions: normalized.map(n => ({ file: n.file_path, base: n.base_version?.file?.hash || null })),
      pre_hashes,
      intended_hashes: pv.intended_files || null,
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

  const r = await runBatch(writeArgs, false, context)
  const now = new Date().toISOString()

  if (!r.success) {
    // WP04：READBACK_MISMATCH → indeterminate（文件已写但内容不可信）；重试按 intended hash reconcile
    if (op) finalizeOperation(workspaceDir, task_id, currentRev, op, { state: writeErrorCode(r) === 'READBACK_MISMATCH' ? 'indeterminate' : 'failed', error_code: writeErrorCode(r), updated: now })
    return mapBatchError(r, op, { workspace_dir: workspaceDir, task_id })
  }

  const finalOp = {
    ...(op || {
      operation_id: newOperationId(), request_id: null, payload_hash, kind: 'batch',
      files, mode: allOrNothing ? 'all_or_nothing' : 'best_effort', base_versions: normalized.map(n => ({ file: n.file_path, base: n.base_version?.file?.hash || null })),
      created: now,
    }),
    state: 'succeeded', updated: now,
    result_hashes: r.intended_files || null,
    result_kind: 'partial',
    txn_id: r.txn_id || null,
    ...(r.rolled_back ? { rolled_back: r.rolled_back } : {}),
    ...(r.partial_failures ? { partial_failures: r.partial_failures } : {}),
  }
  let writeBases = {}
  const cas2 = updateTaskCas(workspaceDir, task_id, currentRev, (t) => {
    const ev = operationEvent(t, finalOp, { node: 'edit', result_kind: 'partial' })
    writeBases = addWriteBasesToTask(t, workspaceDir,
      Object.entries(r.intended_files || {}).map(([file, hash]) => ({ file, hash })),
      { operation_id: finalOp.operation_id })
    return ev
  })
  if (!cas2.ok) {
    return envelope({
      task: taskHeader({ ...task, revision: currentRev, node: 'edit' }),
      observation: {
        summary: `Batch applied to ${files.length} file(s), but task state commit raced (${cas2.code}); retry with the same request_id to finalize.`,
        effect: 'workspace_write', committed: false, result_kind: 'partial', files, diff: r.diff || null, operation: finalOp,
        receipt: serializeReceipt({
          kind: 'batch', operation_id: finalOp.operation_id, request_id: args.request_id || null,
          ...opGuarantee('batch'),
          files: files.map(f => ({ file: f, status: 'written', pre_file_hash: (finalOp.base_versions || []).find(b => b.file === f)?.base || null, intended_file_hash: finalOp.result_hashes?.[f] || null, result_file_hash: finalOp.result_hashes?.[f] || null })),
          committed: false, result_kind: 'partial', index_sync: r.reindex || null,
          ...(r.partial_failures ? { partial_failures: r.partial_failures } : {}),
          ...(r.rolled_back ? { rolled_back: r.rolled_back } : {}),
          txn_id: r.txn_id || null,
        }),
      },
      allowed_actions: ['code_read', 'code_batch', 'code_status'],
      extra: { request_id: args.request_id, result_kind: 'partial', warning: 'state_commit_pending' },
    })
  }

  // P3（0.5.17）：write_bases 已在记录成功操作的同一 CAS 里登记（不额外推 revision）
  const partial = r.partial_failures ? ` (${r.partial_failures.length} file(s) failed in best_effort mode)` : ''
  return envelope({
    task: taskHeader(cas2.task),
    observation: {
      summary: `Applied batch to ${files.length} file(s)${partial}. result_kind=partial (no checks run).`,
      effect: 'workspace_write', committed: true, result_kind: 'partial', mode: r.mode,
      files, diff: r.diff || null, reindex: r.reindex || null, operation: finalOp,
      ...(Object.keys(writeBases).length ? { write_read_refs: writeBases } : {}),
      ...(r.partial_failures ? { partial_failures: r.partial_failures } : {}),
      ...(r.rolled_back ? { rolled_back: r.rolled_back } : {}),
      receipt: serializeReceipt({
        kind: 'batch', operation_id: finalOp.operation_id, request_id: args?.request_id || null,
        ...opGuarantee('batch'),
        files: files.map(f => ({ file: f, status: 'written', pre_file_hash: (finalOp.base_versions || []).find(b => b.file === f)?.base || null, intended_file_hash: finalOp.result_hashes?.[f] || null, result_file_hash: finalOp.result_hashes?.[f] || null })),
        committed: true, result_kind: 'partial', index_sync: r.reindex || null, readback: 'enforced',
        ...(r.partial_failures ? { partial_failures: r.partial_failures } : {}),
        ...(r.rolled_back ? { rolled_back: r.rolled_back } : {}),
        txn_id: r.txn_id || null,
      }),
    },
    allowed_actions: ['code_read', 'code_batch', 'code_check', 'code_status'],
    extra: {
      request_id: args?.request_id, result_kind: 'partial', undo: r.undo || null,
      next_step: 'Run code_check (run=true) to validate, or preview another batch with code_batch (dry_run defaults true). write_read_refs (wbase_*) are valid bases for the next edit — no re-read needed.',
    },
  })
}

// 委托 writeSymbols；context 缺 codeIndexService 时仅影响索引而非写盘。
async function runBatch(writeArgs, dryRun, context) {
  const codeIndexService = context?.codeIndexService
  if (codeIndexService && typeof codeIndexService.initWorkspace === 'function') {
    try { await codeIndexService.initWorkspace(writeArgs.workspace_dir) } catch {}
  }
  try {
    return await writeSymbols({ ...writeArgs, dry_run: dryRun }, context || {})
  } catch (e) {
    return { success: false, error: { code: 'INTERNAL', message: e?.message || String(e) } }
  }
}

// 重试核对（逐文件）：全 intended → 已写收口；全 pre → 可安全重放；混合/外部 → indeterminate
export function reconcileBatch(workspaceDir, task_id, expectedRev, op, route, lifecycle = 'active') {
  const files = op.files || []
  const pre = op.pre_hashes || {}
  const intended = op.intended_hashes || {}
  const cur = {}
  for (const f of files) cur[f] = fileHash(workspaceDir, f)
  const now = new Date().toISOString()

  const allIntended = files.length > 0 && files.every(f => intended[f] && cur[f] === intended[f])
  if (allIntended) {
    const fin = { ...op, state: 'succeeded', updated: now, result_hashes: intended, result_kind: 'partial' }
    const cas = updateTaskCas(workspaceDir, task_id, expectedRev, (t) => operationEvent(t, fin, { node: 'edit', result_kind: 'partial' }))
    if (!cas.ok) {
      // 第二轮审查：CAS 失败不得宣称 committed——文件已是 intended 态但 op 未收口，如实报待重试
      return makeError('state_commit_pending', `recovered batch detected but state commit raced (${cas.code}); retry with the same request_id`, 'Retry with the same request_id to finalize.')
    }
    const revision = cas.task.revision
    return envelope({
      task: { task_id, revision, route, node: 'edit', lifecycle },
      observation: {
        summary: `Recovered: batch had already been written before the interruption (${op.operation_id}); finalized without re-applying.`,
        deduplicated: true, recovered: true, effect: 'workspace_write', committed: true, result_kind: 'partial',
        files, operation: fin,
      },
      allowed_actions: ['code_read', 'code_batch', 'code_status'],
      extra: { request_id: op.request_id, result_kind: 'partial' },
    })
  }

  // Q2：新建文件 pre 哈希为 null，pre/cur 同为 null 也视为写前态（否则重试误判 indeterminate）
  const allPre = files.length > 0 && files.every(f => cur[f] === pre[f])
  if (allPre) return null // 写前态，安全重放

  const fin = { ...op, state: 'indeterminate', updated: now, current_hashes: cur }
  try {
    updateTaskCas(workspaceDir, task_id, expectedRev, (t) => operationEvent(t, fin))
  } catch {}
  return makeError('indeterminate', `batch operation ${op.operation_id} is indeterminate: files are in a mixed/external state (neither all pre-write nor all intended).`, 'Re-read the files with code_read and start a new request_id; do not blind-retry.')
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

function mapBatchError(r, op, ctx) {
  const e = (r?.error && typeof r.error === 'object') ? r.error : {}
  const code = writeErrorCode(r)
  return {
    ok: false,
    error: code,
    code,
    message: toS2ReadTool(e.message || r?.message) || 'batch write failed',
    // 0.5.29：判据详情随结论一起透出（validation/assembled_excerpt/hint/txn_id）
    ...forwardWriteErrorDetail(r),
    ...(e.conflict_type ? { conflict_type: e.conflict_type } : {}),
    ...(e.file ? { file: e.file } : {}),
    ...(e.itemIndex != null ? { item_index: e.itemIndex } : {}),
    ...(e.suggestion || r?.suggestion ? { suggestion: toS2ReadTool(e.suggestion || r.suggestion) } : {}),
    ...(e.next_action ? { next_action: toExecutableNextAction(e.next_action, ctx) } : {}),
    ...(r?.partial_failures ? { partial_failures: r.partial_failures } : {}),
    ...(op ? { operation: { operation_id: op.operation_id, state: op.state } } : {}),
    trace_id: traceId(),
  }
}