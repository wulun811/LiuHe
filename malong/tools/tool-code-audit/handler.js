// code_audit — S4 review/maintain entry: run read-only analyzers under a task, record evidence
// with rule versions, and manage a false-positive ledger (G4: zero findings != safe; dead code never
// auto-removed; accepted false positives keep a reason). No file is modified by this tool.
import { existsSync } from 'node:fs'
import {
  makeError, envelope, getTask, updateTaskCas, newEvidenceId, ensureTaskVersion, unknownTaskError,
} from '../entry-shared.js'
import { resourceVersions, writeFilesOf, workspaceScopeSignature } from '../../workflow/evidence.js'
import { pickOptions } from '../../entry-options.js'
import {
  RULESET_VERSION, normalizeFinding, findingFingerprint, acceptedFingerprints, appendLedger, readLedger, evidenceResult,
} from '../../workflow/review.js'
import { handle as codeReviewH } from '../tool-code-review/handler.js'
import { handle as securityH } from '../tool-security-review/handler.js'
import { handle as exceptionH } from '../tool-exception-guard/handler.js'
import { handle as guardH } from '../tool-guard-patterns/handler.js'
import { handle as gatekeeperH } from '../tool-dependency-gatekeeper/handler.js'
import { handle as configDriftH } from '../tool-config-drift/handler.js'
import { handle as deadCodeH } from '../tool-dead-code-sweeper/handler.js'
import { handle as qualityH } from '../tool-code-quality/handler.js'

const CHECKS = ['code_review', 'security_review', 'exception_guard', 'guard_patterns', 'dependency_gatekeeper', 'config_drift', 'dead_code', 'code_quality']
const FILE_HANDLERS = { code_review: codeReviewH, exception_guard: exceptionH, guard_patterns: guardH, dependency_gatekeeper: gatekeeperH, code_quality: qualityH }
const ARRAY_KEY = { code_review: 'issues', exception_guard: 'issues', guard_patterns: 'violations', dependency_gatekeeper: 'issues' }
// T21 外部结果溯源：check 名 → 实际产生结果的 classic 工具
const SOURCE_TOOL = { dead_code: 'sweep_dead_code' }
const WS_CHECKS = new Set(['security_review', 'config_drift', 'dead_code'])

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

  const action = args?.action || 'run'
  if (!['run', 'accept', 'ledger'].includes(action)) {
    return makeError('invalid_input', `action must be run/accept/ledger (got ${action})`)
  }
  if (action === 'ledger') {
    const entries = readLedger(workspaceDir)
    return envelope({ task: taskHeader(task), observation: { summary: `${entries.length} accepted finding(s) in the false-positive ledger.`, ledger: entries }, allowed_actions: ['code_audit', 'code_control', 'code_status'], extra: { count: entries.length } })
  }
  if (action === 'accept') {
    const fp = args?.fingerprint
    const reason = args?.reason
    if (typeof fp !== 'string' || !fp) return makeError('missing_parameter', 'fingerprint is required for action=accept', 'Run code_audit first and pass a finding.fingerprint.')
    if (typeof reason !== 'string' || !reason.trim()) return makeError('missing_parameter', 'reason is required for action=accept', 'Record why this finding is accepted/known-wrong (G4).')
    appendLedger(workspaceDir, { fingerprint: fp, reason, check: args?.check || null, task_id })
    return envelope({ task: taskHeader(task), observation: { summary: `Accepted finding ${fp} (reason recorded).`, accepted: true, fingerprint: fp }, allowed_actions: ['code_audit', 'code_control', 'code_status'] })
  }

  // ── action=run ──
  // G2-C（ADR-019 D2）：options 透传到原分析器（source/diff/max_issues/ruleset/include_files）
  const picked = pickOptions(['source', 'diff', 'max_issues', 'ruleset', 'include_files'], args?.options, 'code_audit')
  if (!picked.ok) return makeError(picked.error, picked.message, picked.suggestion)
  const aOpts = picked.opts
  let raw = args?.checks
  if (raw == null) raw = ['code_review', 'security_review']
  if (!Array.isArray(raw) || raw.length === 0) return makeError('missing_parameter', 'checks must be a non-empty array', `Valid: ${CHECKS.join(', ')}.`)
  const checks = []
  for (const c of raw) {
    const name = typeof c === 'string' ? c : c?.kind
    if (!CHECKS.includes(name)) return makeError('invalid_input', `unknown check: ${name}`, `Valid: ${CHECKS.join(', ')}.`)
    if (!checks.includes(name)) checks.push(name)
  }
  const maxFindings = Math.min(Math.max(parseInt(args?.max_findings) || 50, 1), 200)
  const files = targetFiles(task, args)
  const scope = typeof args?.scope === 'string' ? args.scope : null
  const ledgerSet = acceptedFingerprints(workspaceDir)
  const reasons = new Map(readLedger(workspaceDir).map(e => [e.fingerprint, e.reason]))
  const fileDeps = resourceVersions(workspaceDir, [...new Set([...files, ...writeFilesOf(task)])])

  const allFindings = []
  const evidences = []
  const metrics = {}
  for (const check of checks) {
    const { ran, raws, error, metrics: m, warnings, errored } = await invoke(check, { workspaceDir, files, scope, maxFindings, context, opts: aOpts })
    for (const [f, v] of Object.entries(m || {})) { metrics[check] = metrics[check] || {}; metrics[check][f] = v }
    const findings = raws.map(({ raw: r, file }) => {
      const nf = normalizeFinding(check, r, file, { deadCode: check === 'dead_code' })
      nf.fingerprint = findingFingerprint(check, nf)
      nf.accepted = ledgerSet.has(nf.fingerprint)
      if (nf.accepted) nf.accepted_reason = reasons.get(nf.fingerprint) || null
      return nf
    })
    const active = findings.filter(f => !f.accepted)
    allFindings.push(...findings)
    // LH-009：逐分析器定依赖——工作区型（dead_code/config_drift/security scope 分支）的结果
    // 覆盖全工作区（或 scope），依赖=扫描范围指纹；文件型依赖=files∪writes
    let wsScope = null
    if (check === 'dead_code') wsScope = scope || ''
    else if (check === 'config_drift') wsScope = ''
    else if (check === 'security_review' && !files.length) wsScope = scope || ''
    const scopeSig = wsScope !== null ? workspaceScopeSignature(workspaceDir, wsScope) : null
    const deps = scopeSig
      ? [{ scope: wsScope, hash: scopeSig.hash, files: scopeSig.files }]
      : fileDeps
    evidences.push({
      evidence_id: newEvidenceId(), kind: `audit:${check}`, result: evidenceResult(ran, active.length),
      // 14-A AC30：证据绑定审查时的 goal_revision——switch_route 后旧 audit 不再自动适用
      goal_revision: task.goal_revision || 1,
      operation_id: null, scope: scope || null,
      source: SOURCE_TOOL[check] || check,
      provenance: { via: 'delegate', tool: SOURCE_TOOL[check] || check },
      depends_on: deps,
      rule_version: RULESET_VERSION[check] || null,
      actual: {
        ran, findings: findings.length, accepted: findings.length - active.length,
        scope: scopeSig
          ? { kind: 'workspace', scope: wsScope || null, files: scopeSig.files, ...(scopeSig.truncated ? { truncated: true } : {}) }
          : { kind: 'files', files: files.length },
        ...(task.index_scope?.truncated ? { scope_truncated: true } : {}), ...(error ? { error: String(error).slice(0, 200) } : {}), ...(warnings?.length ? { warnings } : {}), ...(errored?.length ? { errored_files: errored.slice(0, 10) } : {}),
      },
      limitations: [
        ...(ran && active.length === 0 ? ['zero findings does not prove absence (G4)'] : []),
        ...(check === 'dead_code' ? ['dynamic/reflection wiring NOT covered; auto-remove disabled'] : []),
        ...(check === 'code_quality' ? ['shape metrics only; correctness/security NOT implied'] : []),
        ...(!ran ? ['analyzer did not run (no scope / unavailable)'] : []),
        ...(task.index_scope?.truncated ? ['workspace scan truncated — audit covers a partial tree (T18)'] : []),
        ...(errored?.length ? [`${errored.length} file(s) NOT scanned due to errors — result does NOT cover them`] : []),
      ],
      created: new Date().toISOString(),
    })
  }

  const cas = updateTaskCas(workspaceDir, task_id, task.revision, (t) => {
    t.evidence = [...(t.evidence || []), ...evidences]
    t.node = 'review'
    return { type: 'evidence', data: { evidences, node: 'review' } }
  })
  if (!cas.ok) return makeError('state_commit_pending', `audit ran but task state commit raced (${cas.code}); retry`, 'Retry code_audit.')

  const activeCount = allFindings.filter(f => !f.accepted).length
  const acceptedCount = allFindings.length - activeCount
  const bySeverity = allFindings.reduce((a, f) => { if (!f.accepted) a[f.severity] = (a[f.severity] || 0) + 1; return a }, {})
  return envelope({
    task: { task_id, revision: cas.task.revision, route: task.route, node: 'review', lifecycle: task.lifecycle },
    observation: {
      summary: `Audit ${checks.join(', ')}: ${activeCount} active finding(s), ${acceptedCount} accepted (ledger). Zero findings is NOT proof of safety.`,
      checks, findings: allFindings.slice(0, 200), counts: { active: activeCount, accepted: acceptedCount, by_severity: bySeverity },
      ...(Object.keys(metrics).length ? { metrics } : {}),
      safe_to_remove: false,
      evidence: evidences,
    },
    allowed_actions: ['code_audit', 'code_control', 'code_read', 'code_status'],
    extra: {
      result_kind: task.result_kind || null, accepted_count: acceptedCount,
      // 13-C（专家 c2a83e4 P3-b）：findings 先交还判断——不机械推荐重复 audit
      awaiting_decision: activeCount > 0,
      next_action: activeCount > 0
        ? { tool: 'code_control', args: { workspace_dir: workspaceDir, task_id, action: 'status' }, note: 'Findings are for you to judge (zero findings is NOT proof of safety): expand details, fix via code_patch, or finish.' }
        : { tool: 'code_status', args: { workspace_dir: workspaceDir, task_id }, awaiting_decision: true, note: 'No active findings — not proof of safety; decide whether to run more checks or finish.' },
      // WP03：awaiting_decision 列出可选动作——fix 需编辑载荷（占位符 + template 标注），不假装可直接调用
      ...(activeCount > 0 ? {
        optional_actions: [
          { tool: 'code_control', args: { workspace_dir: workspaceDir, task_id, action: 'expand', ref: '<evidence_id|operation_id|read_ref|candidates>' }, purpose: 'expand one finding to full details', template: true, required_args: ['ref (evidence_id, operation_id, read_ref, or "candidates")'] },
          { tool: 'code_patch', args: { workspace_dir: workspaceDir, task_id, read_ref: '<read_ref>', dry_run: true }, purpose: 'fix a finding via preview-then-apply', template: true, required_args: ['read_ref or locator', 'edit_mode', 'content (replace_symbol) or patch.old_string/new_string (patch)'] },
          { tool: 'code_status', args: { workspace_dir: workspaceDir, task_id }, purpose: 'inspect task state, then decide to finish (host decision)' },
        ],
      } : {}),
    },
  })
}

function taskHeader(task) {
  return { task_id: task.task_id, revision: task.revision, route: task.route, node: task.node, lifecycle: task.lifecycle }
}

function targetFiles(task, args) {
  const explicit = Array.isArray(args?.files) ? args.files.filter(f => typeof f === 'string' && f) : []
  if (explicit.length) return [...new Set(explicit)]
  const mats = (task.materials || []).map(m => m.canonical_path || m.locator?.file_path).filter(Boolean)
  return [...new Set([...mats, ...writeFilesOf(task)])]
}

async function invoke(check, { workspaceDir, files, scope, maxFindings, context, opts }) {
  const o = opts || {}
  const raws = []
  let ran = false, error = null
  const errored = [] // live 审查 J3：多文件循环里失败的条目（不能淹没在单个 error 字段里）
  const metrics = {}
  const warnings = []
  try {
    if (check === 'dead_code') {
      const r = await deadCodeH({ workspace_dir: workspaceDir, scope: scope || undefined, ...(typeof o.include_files === 'boolean' ? { include_files: o.include_files } : {}) }, context)
      if (r?.error) error = r.error; else { ran = true; for (const d of (r.dead_code || [])) raws.push({ raw: d, file: d.file || d.path || null }); for (const w of (r.warnings || [])) warnings.push(w) }
    } else if (check === 'security_review') {
      // G2-C：优先级 scope > source > files（classic 口径：scope wins over file/source）
      if (scope) {
        const r = await securityH({ workspace_dir: workspaceDir, scope, max_findings: maxFindings }, context)
        if (r?.error) error = r.error; else { ran = true; for (const res of (r.results || [])) for (const raw of (res.findings || [])) raws.push({ raw, file: res.file || null }) }
      } else if (typeof o.source === 'string' && o.source) {
        const r = await securityH({ workspace_dir: workspaceDir, source: o.source, max_findings: maxFindings }, context)
        if (r?.error) error = r.error; else { ran = true; for (const raw of (r.findings || [])) raws.push({ raw, file: null }) }
      } else if (files.length) {
        for (const f of files) {
          let r = null
          try { r = await securityH({ workspace_dir: workspaceDir, file: f, max_findings: maxFindings }, context) } catch (e) { r = { error: 'check_failed', message: e.message } }
          if (r?.error) { error = r.error; errored.push({ file: f, error: r.error }); continue }
          ran = true
          for (const raw of (r.findings || [])) raws.push({ raw, file: f })
        }
      } else {
        error = 'no_scope'
      }
    } else if (check === 'config_drift') {
      const r = await configDriftH({ workspace_dir: workspaceDir }, context)
      if (r?.error) error = r.error; else { ran = true; for (const d of (r.drifts || [])) raws.push({ raw: d, file: d.file || null }) }
    } else {
      const handler = FILE_HANDLERS[check]
      if (!handler) return { ran: false, raws, error: 'unsupported_check', metrics, warnings, errored }
      const extra = check === 'code_review'
        ? { ...(typeof o.source === 'string' && o.source ? { source: o.source } : {}), ...(typeof o.diff === 'string' && o.diff ? { diff: o.diff } : {}), ...(o.max_issues != null ? { max_issues: o.max_issues } : {}) }
        : check === 'guard_patterns'
          ? { ...(o.ruleset != null ? { ruleset: o.ruleset } : {}) }
          : {}
      if (check === 'code_review' && (extra.source || extra.diff)) {
        let r = null
        try { r = await handler({ workspace_dir: workspaceDir, ...extra }, context) } catch (e) { r = { error: 'check_failed', message: e.message } }
        if (r?.error) { error = r.error; errored.push({ file: '(inline source/diff)', error: r.error }) }
        else { ran = true; for (const raw of (r[ARRAY_KEY[check]] || [])) raws.push({ raw, file: null }) }
      } else {
        for (const f of files) {
          let r = null
          try { r = await handler({ workspace_dir: workspaceDir, file: f, ...extra }, context) } catch (e) { r = { error: 'check_failed', message: e.message } }
          if (r?.error) { error = r.error; errored.push({ file: f, error: r.error }); continue }
          ran = true
          if (check === 'code_quality') { metrics[f] = { overall: r.overall, dimensions: r.dimensions }; continue }
          for (const raw of (r[ARRAY_KEY[check]] || [])) raws.push({ raw, file: f })
        }
      }
    }
  } catch (e) { error = e.message }
  return { ran, raws, error, metrics, warnings, errored }
}