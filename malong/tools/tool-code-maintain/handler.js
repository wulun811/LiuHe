// code_maintain — S4.3 maintain entry: propose import fixes (read-only, from fix_imports' syntax-guarded
// transaction_ready) and apply them through the UNIFIED write path (writeSymbols: per-file locks, journal,
// one operation with request_id dedup + pre/intended hash reconciliation on retry). Conservative: G4 —
// never removes dead code, only applies patches fix_imports already syntax-checked, Rust is report-only.
import { existsSync } from 'node:fs'
import {
  makeError, envelope, getTask, updateTaskCas, findOperation, payloadHash, newOperationId,
  newEvidenceId, traceId, fileHash, operationEvent, ensureTaskVersion, assertTaskWritable, taskHeader, unknownTaskError, normalizeReadToolText, executableNextAction,
} from '../entry-shared.js'
import { writeSymbols } from '../../write-runtime.js'
import { serializeReceipt, opGuarantee } from '../../workflow/receipt.js'
import { resourceVersions, writeFilesOf } from '../../workflow/evidence.js'
import { proposeImportFixes, selectProposals, MAINTAIN_RULES_VERSION } from '../../workflow/maintain.js'

const ACTIONS = ['plan', 'apply']

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

  const action = args?.action || 'plan'
  if (!ACTIONS.includes(action)) return makeError('invalid_input', `action must be plan/apply (got ${action})`)

  // 提案清单：固定 scope（task 材料 + 成功写文件，或显式 files）。
  const allFiles = targetFiles(task, args)
  if (allFiles.length === 0) {
    return makeError('invalid_input', 'no target files: pass files[], or code_read/ code_patch first so the task has scope.')
  }
  const maxPerFile = Math.min(Math.max(parseInt(args?.max_per_file) || 20, 1), 100)
  // G2-E（ADR-019 D2）：max_candidates 透传到 fix_imports 分析器（默认 10，1–100）
  const maxCandidates = Math.min(Math.max(parseInt(args?.max_candidates) || 10, 1), 100)
  const analysis = await proposeImportFixes({ workspaceDir, files: allFiles, context, analyze: context?.maintainAnalyze, maxCandidates, maxPerFile })
  const selected = selectProposals(analysis.proposals, args?.proposals)
  const limitations = [
    'import analysis is heuristic; false positives/negatives possible — validate with code_check after applying',
    'Rust imports are report-only (trait/re-export not statically decidable); never auto-applied',
    'dead code is NEVER auto-removed (G4)',
  ]

  // ── action=plan（默认预览，不落盘、不记操作）──
  const dryRun = action === 'plan' || args?.dry_run !== false
  if (dryRun) {
    // LH-001：终态守卫——cancelled 任务拒绝新副作用操作（含 plan 预览）
    const guard = assertTaskWritable(task)
    if (guard) return guard
    return envelope({
      task: taskHeader(task),
      observation: {
        summary: `Maintain plan: ${selected.length} safe import-fix proposal(s) across ${new Set(selected.map(p => p.file)).size} file(s); ${analysis.skipped.length} file(s) skipped. No file changed.`,
        effect: 'preview', dry_run: true, action: 'plan',
        proposals: selected, skipped: analysis.skipped, issues_by_file: analysis.issuesByFile,
        rule_version: MAINTAIN_RULES_VERSION.import_fix, limitations,
      },
      allowed_actions: ['code_maintain', 'code_read', 'code_status'],
      extra: {
        next_action: selected.length
          ? {
              tool: 'code_maintain',
              args: {
                workspace_dir: workspaceDir,
                task_id,
                action: 'apply',
                dry_run: false,
                files: allFiles,
                ...(args?.proposals ? { proposals: args.proposals } : {}),
                ...(args?.max_per_file ? { max_per_file: args.max_per_file } : {}),
                ...(args?.max_candidates ? { max_candidates: args.max_candidates } : {}),
                ...(args?.request_id ? { request_id: args.request_id } : {}),
              },
              note: 'Plan only (no file changed). Call code_maintain with these args to apply.',
            }
          : null,
        next_step: selected.length
          ? 'Plan only. To apply, call code_maintain with next_action.args (action=apply, dry_run=false).'
          : 'Nothing safe to apply; inspect skipped[] and issues_by_file.',
      },
    })
  }

  // ── action=apply（统一写路径）──
  const normalized = selected.map(p => ({
    file_path: p.file, locator: { file_path: p.file }, edit_mode: 'patch',
    patch: { old_string: p.old_string, new_string: p.new_string },
    base_version: { file: { hash: fileHash(workspaceDir, p.file) }, symbol: null },
    fingerprint: p.fingerprint,
  }))
  const files = [...new Set(normalized.map(n => n.file_path))]
  const payload_hash = payloadHash({
    task_id, kind: 'maintain',
    proposals: normalized.map(n => ({ file: n.file_path, fp: n.fingerprint })),
  })

  // 去重先于 CAS（§7.6）：同 request_id 同载荷 → 幂等；异载荷 → 拒绝
  let op = findOperation(task, args?.request_id)
  if (op && op.payload_hash !== payload_hash) {
    return makeError('request_conflict', `request_id ${args.request_id} was used with a different payload`, 'Use a fresh request_id for a different maintain set.')
  }
  if (op && op.state === 'succeeded') {
    return envelope({
      task: taskHeader(task),
      observation: {
        summary: `Deduplicated: maintain already applied (${op.operation_id}).`,
        deduplicated: true, effect: 'workspace_write', result_kind: task.result_kind || 'partial', files, operation: op,
      },
      allowed_actions: ['code_read', 'code_check', 'code_status'],
      extra: { request_id: args.request_id, result_kind: task.result_kind || 'partial' },
    })
  }

  // LH-001：终态守卫——cancelled 任务拒绝新副作用操作（上面的 succeeded dedup 复读已放行）
  const guard = assertTaskWritable(task)
  if (guard) return guard

  if (selected.length === 0) {
    return makeError('invalid_input', 'no applicable proposals (all files clean/skipped/unsupported)', 'Run action=plan and inspect skipped[].')
  }

  const writeArgs = {
    workspace_dir: workspaceDir,
    writes: normalized.map(n => ({
      file_path: n.file_path, locator: n.locator, edit_mode: n.edit_mode,
      patch: n.patch, base_version: n.base_version,
    })),
    policy: { all_or_nothing: true },
  }

  // 重试恢复：对已存在 prepared/failed/indeterminate 操作核对，不盲目重放（W1/W3）
  if (op) {
    const rec = reconcileMaintain(workspaceDir, task_id, task.revision, op, task.route, task.lifecycle)
    if (rec) return rec
  }

  // 预演取每文件 intended 哈希（崩溃后识别“已写”）
  const pv = await runWrite(writeArgs, true, context)
  if (!pv.success) return mapWriteError(pv, op, { workspace_dir: workspaceDir, task_id })
  const plannedFiles = pv.intended_files ? Object.keys(pv.intended_files) : files
  const pre_hashes = {}
  for (const f of plannedFiles) if (!(f in pre_hashes)) pre_hashes[f] = fileHash(workspaceDir, f)

  let currentRev = task.revision
  let prepared = op
  if (args?.request_id && !op) {
    prepared = {
      operation_id: newOperationId(), request_id: args.request_id, payload_hash,
      state: 'prepared', kind: 'maintain', files: plannedFiles, mode: 'all_or_nothing',
      base_versions: normalized.map(n => ({ file: n.file_path, base: n.base_version?.file?.hash || null })),
      pre_hashes, intended_hashes: pv.intended_files || null, created: new Date().toISOString(),
    }
    const cas = updateTaskCas(workspaceDir, task_id, task.revision, (t) => operationEvent(t, prepared, { node: 'maintain' }))
    if (!cas.ok) {
      return makeError(
        cas.code === 'REVISION_CONFLICT' ? 'revision_conflict' : 'task_not_found',
        cas.code === 'REVISION_CONFLICT' ? `task revision changed: expected=${task.revision}, current=${cas.current}` : `Unknown task_id: ${task_id}`,
      )
    }
    currentRev = cas.task.revision
  }

  const r = await runWrite(writeArgs, false, context)
  const now = new Date().toISOString()
  if (!r.success) {
    if (prepared) finalizeOp(workspaceDir, task_id, currentRev, prepared, { state: 'failed', error_code: writeErrorCode(r), updated: now })
    return mapWriteError(r, prepared, { workspace_dir: workspaceDir, task_id })
  }

  const finalOp = {
    ...(prepared || {
      operation_id: newOperationId(), request_id: null, payload_hash, kind: 'maintain', files, mode: 'all_or_nothing',
      base_versions: normalized.map(n => ({ file: n.file_path, base: n.base_version?.file?.hash || null })), created: now,
    }),
    state: 'succeeded', updated: now,
    result_hashes: r.intended_files || null,
    result_kind: 'partial',
    txn_id: r.txn_id || null,
  }
  const cas2 = updateTaskCas(workspaceDir, task_id, currentRev, (t) => operationEvent(t, finalOp, { node: 'maintain', result_kind: 'partial' }))
  if (!cas2.ok) {
    return envelope({
      task: taskHeader({ ...task, revision: currentRev, node: 'maintain' }),
      observation: {
        summary: `Maintain applied to ${files.length} file(s), but task state commit raced (${cas2.code}); retry with the same request_id to finalize.`,
        effect: 'workspace_write', committed: false, result_kind: 'partial', files, diff: r.diff || null, operation: finalOp,
        receipt: serializeReceipt({
          kind: 'maintain', operation_id: finalOp.operation_id, request_id: args?.request_id || null,
          ...opGuarantee('maintain'),
          files: files.map(f => ({ file: f, status: 'written', pre_file_hash: (finalOp.base_versions || []).find(b => b.file === f)?.base || null, intended_file_hash: finalOp.result_hashes?.[f] || null, result_file_hash: finalOp.result_hashes?.[f] || null })),
          committed: false, result_kind: 'partial', index_sync: r.reindex || null,
          txn_id: r.txn_id || null,
        }),
      },
      allowed_actions: ['code_read', 'code_maintain', 'code_status'],
      extra: { request_id: args.request_id, result_kind: 'partial', warning: 'state_commit_pending' },
    })
  }

  // 证据：记录本次维护（依赖写后版本，写后文件再变则失效）；best-effort，CAS 竞态不阻断已提交结果
  const ev = {
    evidence_id: newEvidenceId(), kind: 'maintain:import_fix', result: 'passed', operation_id: finalOp.operation_id,
    source: 'fix_imports',
    provenance: { via: 'delegate', tool: 'fix_imports' },
    depends_on: resourceVersions(workspaceDir, plannedFiles),
    rule_version: MAINTAIN_RULES_VERSION.import_fix,
    actual: { applied: normalized.length, files: plannedFiles, skipped: analysis.skipped.length },
    limitations,
    created: now,
  }
  const cas3 = updateTaskCas(workspaceDir, task_id, cas2.task.revision, (t) => {
    t.evidence = [...(t.evidence || []), ev]
    return { type: 'evidence', data: { evidences: [ev], node: 'maintain' } }
  })

  return envelope({
    task: taskHeader({ ...task, revision: cas3.ok ? cas3.task.revision : cas2.task.revision, node: 'maintain' }),
    observation: {
      summary: `Applied ${normalized.length} import fix(es) across ${files.length} file(s) via unified write. result_kind=partial (run code_check to validate).`,
      effect: 'workspace_write', committed: true, result_kind: 'partial',
      files, diff: r.diff || null, reindex: r.reindex || null, operation: finalOp, evidence: ev,
      skipped: analysis.skipped, limitations,
      receipt: serializeReceipt({
        kind: 'maintain', operation_id: finalOp.operation_id, request_id: args?.request_id || null,
        ...opGuarantee('maintain'),
        files: files.map(f => ({ file: f, status: 'written', pre_file_hash: (finalOp.base_versions || []).find(b => b.file === f)?.base || null, intended_file_hash: finalOp.result_hashes?.[f] || null, result_file_hash: finalOp.result_hashes?.[f] || null })),
        committed: true, result_kind: 'partial', index_sync: r.reindex || null,
        readback: 'enforced',
        limitations: limitations.map(l => (typeof l === 'string' ? l : l?.message || String(l))),
        txn_id: r.txn_id || null,
      }),
    },
    allowed_actions: ['code_read', 'code_check', 'code_audit', 'code_status'],
    extra: {
      request_id: args?.request_id, result_kind: 'partial', undo: r.undo || null,
      ...(cas3.ok ? {} : { warning: 'evidence_commit_pending' }),
      next_step: 'Run code_check (run=true) to validate, or code_audit for a broader review.',
    },
  })
}

function targetFiles(task, args) {
  const explicit = Array.isArray(args?.files) ? args.files.filter(f => typeof f === 'string' && f) : []
  if (explicit.length) return [...new Set(explicit)]
  const mats = (task.materials || []).map(m => m.canonical_path || m.locator?.file_path).filter(Boolean)
  return [...new Set([...mats, ...writeFilesOf(task)])]
}

async function runWrite(writeArgs, dryRun, context) {
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

// 重试核对（逐文件）：全 intended → 收口；全 pre → 可安全重放；混合/外部 → indeterminate
export function reconcileMaintain(workspaceDir, task_id, expectedRev, op, route, lifecycle = 'active') {
  const files = op.files || []
  const pre = op.pre_hashes || {}
  const intended = op.intended_hashes || {}
  const cur = {}
  for (const f of files) cur[f] = fileHash(workspaceDir, f)
  const now = new Date().toISOString()

  const allIntended = files.length > 0 && files.every(f => intended[f] && cur[f] === intended[f])
  if (allIntended) {
    const fin = { ...op, state: 'succeeded', updated: now, result_hashes: intended, result_kind: 'partial' }
    const cas = updateTaskCas(workspaceDir, task_id, expectedRev, (t) => operationEvent(t, fin, { node: 'maintain', result_kind: 'partial' }))
    if (!cas.ok) {
      // 第二轮审查：CAS 失败不得宣称 committed——文件已是 intended 态但 op 未收口，如实报待重试
      return makeError('state_commit_pending', `recovered maintain detected but state commit raced (${cas.code}); retry with the same request_id`, 'Retry with the same request_id to finalize.')
    }
    return envelope({
      task: { task_id, revision: cas.task.revision, route, node: 'maintain', lifecycle },
      observation: {
        summary: `Recovered: maintain had already been written before the interruption (${op.operation_id}); finalized without re-applying.`,
        deduplicated: true, recovered: true, effect: 'workspace_write', committed: true, result_kind: 'partial', files, operation: fin,
      },
      allowed_actions: ['code_read', 'code_check', 'code_status'],
      extra: { request_id: op.request_id, result_kind: 'partial' },
    })
  }

  const allPre = files.length > 0 && files.every(f => cur[f] && cur[f] === pre[f])
  if (allPre) return null // 写前态，安全重放

  const fin = { ...op, state: 'indeterminate', updated: now, current_hashes: cur }
  try { updateTaskCas(workspaceDir, task_id, expectedRev, (t) => operationEvent(t, fin, { node: 'maintain' })) } catch {}
  return makeError('indeterminate', `maintain operation ${op.operation_id} is indeterminate: files are in a mixed/external state (neither all pre-write nor all intended).`, 'Re-read the files and start a new request_id; do not blind-retry.')
}

function finalizeOp(workspaceDir, task_id, expectedRev, op, patch) {
  try { return updateTaskCas(workspaceDir, task_id, expectedRev, (t) => operationEvent(t, { ...op, ...patch }, { node: 'maintain' })) } catch { return null }
}

function writeErrorCode(r) {
  const e = r?.error
  if (e && typeof e === 'object') return e.code || 'write_failed'
  if (typeof e === 'string') return e
  return 'write_failed'
}

function mapWriteError(r, op, ctx) {
  const e = (r?.error && typeof r.error === 'object') ? r.error : {}
  const code = writeErrorCode(r)
  return {
    ok: false, error: code, code,
    message: normalizeReadToolText(e.message || r?.message) || 'maintain write failed',
    ...(e.conflict_type ? { conflict_type: e.conflict_type } : {}),
    ...(e.file ? { file: e.file } : {}),
    ...(e.itemIndex != null ? { item_index: e.itemIndex } : {}),
    ...(e.suggestion || r?.suggestion ? { suggestion: normalizeReadToolText(e.suggestion || r.suggestion) } : {}),
    ...(e.next_action ? { next_action: executableNextAction(e.next_action, ctx || {}) } : {}),
    ...(op ? { operation: { operation_id: op.operation_id, state: op.state } } : {}),
    trace_id: traceId(),
  }
}