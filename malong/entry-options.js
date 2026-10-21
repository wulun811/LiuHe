// entry-options.js — G2（ADR-019 D2）：graph 快捷入口的 options 校验透传共享实现。
// 语义：只为「快捷未显式化的原工具参数」开口；受保护边界键禁止经 options 覆盖；
// 未知键 typed 拒绝（不静默丢弃）。调用方负责用自身错误码包装返回。
export const OPTION_DENY = new Set([
  'workspace_dir', 'task_id', 'request_id', 'expected_state_revision', 'read_ref', 'confirm', 'dry_run', 'allow_unsafe_no_base',
])

// allow: string[]（该入口允许透传的键）；options: 原始输入；label: 用于报错定位（如 'mode=outline'）
export function pickOptions(allow, options, label = '') {
  if (options == null) return { ok: true, opts: {} }
  if (typeof options !== 'object' || Array.isArray(options)) {
    return { ok: false, error: 'invalid_input', message: 'options must be an object' }
  }
  const allowList = Array.isArray(allow) ? allow : []
  const denied = [], unknown = [], opts = {}
  for (const [k, v] of Object.entries(options)) {
    if (OPTION_DENY.has(k)) denied.push(k)
    else if (!allowList.includes(k)) unknown.push(k)
    else opts[k] = v
  }
  if (denied.length) {
    return {
      ok: false, error: 'invalid_input',
      message: 'options cannot override protected key(s): ' + denied.join(', '),
      suggestion: 'Pass boundary params at the top level only.',
    }
  }
  if (unknown.length) {
    return {
      ok: false, error: 'invalid_input',
      message: 'unknown options' + (label ? ' for ' + label : '') + ': ' + unknown.join(', '),
      suggestion: allowList.length
        ? 'Allowed: ' + allowList.join(', ')
        : 'This entry takes no options (full schema via code_query mode=capability).',
    }
  }
  return { ok: true, opts }
}
