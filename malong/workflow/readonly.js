// workflow/readonly.js — LH-WO-005B: server-enforced read-only policy.
//
// MALONG_READONLY=1 is an application-level guarantee (not an OS sandbox): the
// dispatcher rejects known workspace/git/command effects before a handler can
// create a backup, journal, task operation, or write a business file. Default
// off, so existing hosts see no behavior change.
//
// The guard is intentionally conservative for graph write tools: previews that
// would create a lock/journal are rejected too. Read-only previews that do not
// touch the workspace (code_check run:false, code_maintain plan, code_worktree
// preview) remain available.
import { effectsOf } from './capability-catalog.js'
import { readonlyMode } from '../host-config.js'

// Effects that only touch MALONG_STATE_DIR (or are pure reads). Everything
// else — workspace_write / git / command — is a workspace side effect.
const STATE_ONLY_EFFECTS = new Set(['read', 'state_write', 'index', 'service_state', 'cleanup', 'feedback'])

// A capability can be classified as state_write yet still construct a workspace
// TransactionStore while inspecting history. Keep this explicit deny list.
const UNSAFE_STATE_CAPABILITIES = new Set(['edit_collision_guard'])

function violation(tool, action, message) {
  return { tool, action: action == null ? null : String(action), message }
}

// Action-aware guard for graph tools (and the few classic tools with actions).
// Returns null = allowed, or {tool, action, message}.
export function readonlyViolation(name, args = {}) {
  if (!readonlyMode()) return null
  const action = typeof args?.action === 'string' ? args.action : null
  switch (name) {
    case 'code_patch':
      return violation(name, 'apply', 'code_patch is a workspace write; the server is read-only')
    case 'code_batch':
      return violation(name, 'apply', 'code_batch is a workspace write; the server is read-only')
    case 'edit_transaction':
      return violation(name, action, 'edit_transaction can stage/commit workspace files; the server is read-only')
    case 'code_maintain':
      // plan/default is a read-only proposal; only an actual apply is refused.
      return action === 'apply' && args?.dry_run === false
        ? violation(name, action, 'code_maintain(action=apply) writes workspace files')
        : null
    case 'code_worktree':
      return action === 'apply' && args?.dry_run === false
        ? violation(name, action, 'code_worktree(action=apply) changes files and git history')
        : null
    case 'code_check':
      return args?.run === true
        ? violation(name, 'run', 'code_check(run=true) executes commands; use run=false for a preview')
        : null
    case 'code_control':
      // status/job are reads; cancel/cancel_job are cleanup of task/job state only.
      if (action === 'status' || action === 'job' || action === 'cancel' || action === 'cancel_job') return null
      return violation(name, action, 'code_control action=' + String(action) + ' changes task lifecycle/route state')
    case 'code_query':
      // sandbox validation executes a command; the other query modes are reads.
      return args?.mode === 'validate'
        ? violation(name, 'validate', 'code_query(mode=validate) delegates to sandbox_validate (command execution)')
        : null
    case 'health':
      return args?.action === 'restart'
        ? violation(name, 'restart', 'health(action=restart) restarts the server; only check/cleanup are allowed in read-only mode')
        : null
    default:
      return null
  }
}

// Capability-outlet guard (invoke_capability). Uses the single effects catalog;
// any workspace_write / git / command effect is refused before the outlet
// creates a task operation or ledger entry.
export function readonlyCapabilityViolation(name, effects, args = {}) {
  if (!readonlyMode()) return null
  const actionViolation = readonlyViolation(name, args)
  if (actionViolation) return actionViolation
  const denied = (effects || []).filter((e) => !STATE_ONLY_EFFECTS.has(e))
  if (denied.length > 0) {
    return violation(name, null, 'capability has non-state effects [' + denied.join(', ') + ']; the server is read-only')
  }
  if (UNSAFE_STATE_CAPABILITIES.has(name)) {
    return violation(name, null, 'capability may create workspace transaction artifacts; the server is read-only')
  }
  return null
}

export function readonlyError(v) {
  const tool = v?.tool || null
  const action = v?.action ?? null
  const message = v?.message || 'workspace write refused'
  return {
    ok: false,
    error: 'readonly_mode',
    code: 'readonly_mode',
    error_code: 'readonly_mode',
    tool,
    action,
    message,
    suggestion: 'Unset MALONG_READONLY=1 on the malong server to allow writes; read-only tools remain available.',
    readonly_mode: true,
  }
}

// Convenience for callers that only have a name (classic direct tools).
export function readonlyViolationForTool(name, args = {}) {
  const direct = readonlyViolation(name, args)
  if (direct) return direct
  return readonlyCapabilityViolation(name, effectsOf(name), args)
}
