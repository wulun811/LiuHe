// action-map.js — 建议动作可达性映射（R05，0.5.10 审核修复；自 tools/tool-code-query/handler.js 抽出共享）。
// 背景：graph 面隐藏 classic-only 工具；建议字段（next_step/suggestion）若裸点名隐藏工具，模型照做会撞「工具不存在」。
// 策略：① 语义映射（有真分支走真分支：impact_analysis → code_query(mode='impact', ...)）；
//       ② 通用兜底（其余 classic-only 名的 call 形式 / 带下划线裸名 → invoke_capability 保底出口形式）。
// 只改建议字段（ADVISORY_KEYS），不改结果正文（context 代码片段可能含同名子串）。
import { loadPositions, capabilityWhitelist } from './capability-catalog.js'
import { GRAPH_READ, GRAPH_WRITE, GRAPH_EXTRA } from './public-catalog.js'

const FACE = new Set([...GRAPH_READ, ...GRAPH_WRITE, ...GRAPH_EXTRA])

// ── N03（0.5.11 复审修复）：建议动作的类型化参数面 ──
// 旧实现把括号内 key=value 一律存为字符串（dry_run="false"）→ 出口 schema 校验拒字符串布尔，建议不可回放。
// 新契约：① 能按 JSON 解析的值保持真实类型（boolean/number/null/数组/对象）；② 带引号串去引号；
//   ③ 无法确定（省略号/被截断/未知参数）→ 不伪造完整 args：保留已确定项并标 args_complete=false
//      + required_args/missing_args，供模型补齐后再调。
function splitTopLevel(s, sep) {
  const out = []
  let cur = '', depth = 0, quote = null
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (quote) {
      cur += ch
      if (ch === '\\') { if (i + 1 < s.length) cur += s[++i]; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === '\'' || ch === '`') { quote = ch; cur += ch; continue }
    if (ch === '[' || ch === '{' || ch === '(') { depth++; cur += ch; continue }
    if (ch === ']' || ch === '}' || ch === ')') { depth--; cur += ch; continue }
    if (ch === sep && depth === 0) { out.push(cur); cur = ''; continue }
    cur += ch
  }
  out.push(cur)
  return out
}

function splitKeyValue(s) {
  let depth = 0, quote = null
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (quote) { if (ch === '\\') { i++; continue } if (ch === quote) quote = null; continue }
    if (ch === '"' || ch === '\'' || ch === '`') { quote = ch; continue }
    if (ch === '[' || ch === '{' || ch === '(') { depth++; continue }
    if (ch === ']' || ch === '}' || ch === ')') { depth--; continue }
    if (ch === '=' && depth === 0) return { key: s.slice(0, i).trim(), raw: s.slice(i + 1).trim() }
  }
  return null
}

const BARE_NUM = /^-?\d+(?:\.\d+)?$/
function parseTypedValue(raw) {
  if (raw === 'true') return { ok: true, value: true }
  if (raw === 'false') return { ok: true, value: false }
  if (raw === 'null') return { ok: true, value: null }
  if (BARE_NUM.test(raw)) return { ok: true, value: Number(raw) }
  if (/^["'`]/.test(raw)) {
    const q = raw[0]
    if (raw.length >= 2 && raw[raw.length - 1] === q) return { ok: true, value: raw.slice(1, -1).replace(/\\(.)/g, '$1') }
    return { ok: false }
  }
  if (/^[[{]/.test(raw)) {
    try { return { ok: true, value: JSON.parse(raw) } } catch { return { ok: false } }
  }
  if (!raw) return { ok: false }
  return { ok: true, value: raw }
}

// 解析括号内实参（kwargs）：返回真实类型值与「无法确定」的 token 列表
export function parseTypedArgs(inner) {
  const args = {}, unresolved = []
  for (const token of splitTopLevel(String(inner == null ? '' : inner), ',')) {
    const t = token.trim()
    if (!t) continue
    const kv = splitKeyValue(t)
    if (!kv || !kv.key) { unresolved.push(t); continue }
    const v = parseTypedValue(kv.raw)
    if (!v.ok) { unresolved.push(t); continue }
    args[kv.key] = v.value
  }
  return { args, unresolved }
}

let _schemas = null
function schemaOf(tool) {
  if (!_schemas) { try { _schemas = capabilityWhitelist() } catch { _schemas = new Map() } }
  const t = _schemas.get(tool)
  return (t && t.manifest && t.manifest.inputSchema) || null
}

// N03：schema 已知类型时修复「字符串化」伪影（建议文本全是字符串，boolean/number 会被写成 "false"/"3"）
function coerceToSchema(value, prop) {
  if (!prop || typeof prop !== 'object') return { value, unresolved: false }
  const t = prop.type
  if (t === 'boolean' && typeof value === 'string') {
    if (value === 'true') return { value: true, unresolved: false }
    if (value === 'false') return { value: false, unresolved: false }
    return { value, unresolved: true }
  }
  if ((t === 'number' || t === 'integer') && typeof value === 'string') {
    const n = Number(value)
    if (!Number.isFinite(n) || !BARE_NUM.test(value.trim())) return { value, unresolved: true }
    return { value: t === 'integer' ? Math.trunc(n) : n, unresolved: false }
  }
  if (t === 'string' && typeof value !== 'string') return { value, unresolved: true }
  if (t === 'array' && !Array.isArray(value)) return { value, unresolved: true }
  if (t === 'object' && (typeof value !== 'object' || value === null || Array.isArray(value))) return { value, unresolved: true }
  return { value, unresolved: false }
}

// 构造可回放动作合同：只保留 schema 认识的参数；缺参/无法解析显式标注，不伪造
// （出口会注入 workspace_dir/task_id，比较缺参时视为已提供）
export function buildInvokeAction(tool, inner) {
  const schema = schemaOf(tool)
  const props = schema && schema.properties && typeof schema.properties === 'object' ? schema.properties : null
  const required = Array.isArray(schema && schema.required) ? [...schema.required].sort() : []
  const parsed = parseTypedArgs(inner)
  const unresolved = [...parsed.unresolved]
  const args = {}
  for (const [k, v] of Object.entries(parsed.args)) {
    if (!props) { args[k] = v; continue }
    if (!props[k]) continue // 不认识的关键字不进 args（记 unknown_args）
    const c = coerceToSchema(v, props[k])
    if (c.unresolved) { unresolved.push(k + '=' + JSON.stringify(v)); continue }
    args[k] = c.value
  }
  const unknown_args = props ? Object.keys(parsed.args).filter((k) => !props[k]) : []
  const provided = new Set([...Object.keys(args), 'workspace_dir', 'task_id'])
  const missing_args = required.filter((r) => !provided.has(r))
  return {
    name: tool, args,
    ...(unknown_args.length ? { unknown_args } : {}),
    ...(unresolved.length ? { unresolved_tokens: unresolved } : {}),
    required_args: required,
    missing_args,
    args_complete: unresolved.length === 0 && unknown_args.length === 0 && missing_args.length === 0,
  }
}

export function renderInvokeAction(a) {
  let s = "invoke_capability(name='" + a.name + "', args=" + JSON.stringify(a.args) + ')'
  if (!a.args_complete) s += ' // incomplete: fill ' + (a.missing_args.length ? a.missing_args.join(', ') : 'omitted args') + ' before running'
  return s
}

function invokeForm(tool, inner) {
  return renderInvokeAction(buildInvokeAction(tool, inner))
}

// G2-A（ADR-019 D1）：能 1:1 映射的走真实分支；无真分支者指向 ADR-018 保底出口（原名仅允许出现在 name= 位置）。
const ACTION_MAP = [
  [/\bimpact_analysis\s*\(/g, `code_query(mode='impact', `],
  [/\bcall_chain\s*\(/g, `code_query(mode='callers', `],
  [/\bcode_search\s*\(/g, `code_query(mode='search', `],
  [/\bread_symbol\s*\(/g, `code_read(`],
  [/\bsandbox_validate\s*\(/g, `code_query(mode='validate', `],
  [/\breferences\s*\(/g, `code_query(mode='references', `],
  [/\bfind_tests\s*\(/g, `code_query(mode='tests', `],
  [/\btest_bridge\s*\(([^)]*)\)/g, (_m, inner) => invokeForm('test_bridge', inner)],
  [/\bdebug_runner\s*\(([^)]*)\)/g, (_m, inner) => invokeForm('debug_runner', inner)],
  [/\breindex\s*\(([^)]*)\)/g, (_m, inner) => invokeForm('reindex', inner)],
  [/\bcode_search\b/g, `code_query(mode='search')`],
  [/\bcall_chain\b/g, `code_query(mode='callers')`],
  [/(?<!name=')\btest_bridge\b/g, `invoke_capability(name='test_bridge')`],
  [/(?<!name=')\bdebug_runner\b/g, `invoke_capability(name='debug_runner')`],
  [/(?<!name=')\breindex\b/g, `invoke_capability(name='reindex')`],
]

// R05 通用兜底：其余 classic-only 名（防手列遗漏 rename_symbol/mock_sync 等）。
//   call 形式与「带下划线裸名」→ invoke 形式；单字名不做裸名改写（防误伤英文散文：health/feedback/gc）。
let _generic = null
let _hidden = null
function hiddenCapabilityNames() {
  if (_hidden) return _hidden
  try { _hidden = [...loadPositions().byName.keys()].filter((n) => !FACE.has(n)).sort() } catch { _hidden = [] }
  return _hidden
}
function genericRules() {
  if (_generic) return _generic
  const hidden = hiddenCapabilityNames()
  const rules = []
  for (const n of hidden) rules.push([new RegExp('\\b' + n + '\\s*\\(([^)]*)\\)', 'g'), (_m, inner) => invokeForm(n, inner)])
  for (const n of hidden) if (n.includes('_')) rules.push([new RegExp("(?<!name=')(?<![A-Za-z0-9_])" + n + "\\b(?![A-Za-z0-9_])(?!\\s*\\()", 'g'), (_m) => "invoke_capability(name='" + n + "')"])
  _generic = rules
  return rules
}

export function sanitizeAdvisory(s) {
  let out = s
  for (const [re, rep] of ACTION_MAP) out = out.replace(re, rep)
  for (const [re, rep] of genericRules()) out = out.replace(re, rep)
  return out
}

// N03：从建议文本抽出「隐藏工具的 call 形式」→ 可回放动作合同（结构化 next_actions 用）。
// 与 sanitizeAdvisory 的文本改写同源，但保留 name/args 类型面，避免模型只能看到不可执行的散文。
export function extractInvokeActions(text, limit = 8) {
  const acts = []
  const s = String(text == null ? '' : text)
  for (const n of hiddenCapabilityNames()) {
    const re = new RegExp('\\b' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\(([^)]*)\\)', 'g')
    let m
    while ((m = re.exec(s)) !== null) {
      const a = buildInvokeAction(n, m[1])
      acts.push({
        action: 'invoke_capability', name: a.name, args: a.args,
        required_args: a.required_args, missing_args: a.missing_args, args_complete: a.args_complete,
        ...(a.unknown_args ? { unknown_args: a.unknown_args } : {}),
        form: renderInvokeAction(a),
      })
      if (acts.length >= limit) return acts
    }
  }
  return acts
}

const ADVISORY_KEYS = new Set(['next_step', 'suggestion'])
export function sanitizeGraphActions(v) {
  if (Array.isArray(v)) return v.map(sanitizeGraphActions)
  if (v && typeof v === 'object') {
    const o = {}
    for (const [k, val] of Object.entries(v)) {
      o[k] = ADVISORY_KEYS.has(k) && typeof val === 'string' ? sanitizeAdvisory(val) : sanitizeGraphActions(val)
    }
    return o
  }
  return v
}

// R05：结构化收集建议字段（供 invoke 出口生成 next_actions；保留字段路径便于溯源）
export function collectAdvisoryFields(v, path = '', out = []) {
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) collectAdvisoryFields(v[i], path + '[' + i + ']', out)
  } else if (v && typeof v === 'object') {
    for (const [k, val] of Object.entries(v)) {
      const p = path ? path + '.' + k : k
      if (ADVISORY_KEYS.has(k) && typeof val === 'string') out.push({ path: p, text: val })
      else collectAdvisoryFields(val, p, out)
    }
  }
  return out
}
