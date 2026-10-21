// workflow/capability-catalog.js — G1 能力目录（发现出口）：原 classic 44 的枚举与描述
// ADR-018：单一来源 = 磁盘 tools/*/manifest.json（classic interface）+ contracts/classic-44.positions.json（位置/接线状态）。
// 安全边界：白名单仅由精确名查表得出（磁盘扫描，不接受模型给的路径/模块名）；本模块不执行任何工具。
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

export const CATALOG_CONTRACT_VERSION = 1

// 策展 effects（未列 = 只读）。依据各 handler 真实副作用面；改动必须同步测试。
const EFFECTS_OVERRIDES = {
  write_symbol: ['workspace_write'],
  write_symbols: ['workspace_write'],
  edit_batch: ['workspace_write'],
  edit_transaction: ['workspace_write'],
  rename_symbol: ['workspace_write'],
  edit_collision_guard: ['state_write'],
  fix_imports: ['workspace_write'],
  style_sniffer: ['workspace_write'],
  reindex: ['index'],
  health: ['service_state', 'cleanup'],
  gc: ['cleanup'],
  feedback: ['feedback'],
  debug_runner: ['command'],
  test_bridge: ['command'],
  verify_pipeline: ['command'],
  tsc_check: ['command'],
  sandbox_validate: ['command'],
  git_worktree: ['git', 'workspace_write'],
}

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf-8'))
}

export function loadPositions(root = ROOT) {
  const p = join(root, 'contracts', 'classic-44.positions.json')
  if (!existsSync(p)) return { byName: new Map(), raw: null }
  const data = readJson(p)
  return { byName: new Map((data.positions || []).map((x) => [x.name, x])), raw: data }
}

// 冻结白名单：classic（interface 非 graph/diagnostic）——仅以精确名查表
let _wlCache = null
export function capabilityWhitelist(root = ROOT) {
  if (_wlCache && _wlCache.root === root) return _wlCache.map
  const toolsDir = join(root, 'tools')
  const map = new Map()
  if (!existsSync(toolsDir)) return map
  for (const d of readdirSync(toolsDir).sort()) {
    const mp = join(toolsDir, d, 'manifest.json')
    if (!existsSync(mp)) continue
    let m
    try { m = readJson(mp) } catch { continue }
    if (!m.name || m.interface === 'graph' || m.interface === 'diagnostic') continue
    map.set(m.name, { name: m.name, dir: d, handler: m.handler || 'handler.js', manifest: m })
  }
  _wlCache = { root, map }
  return map
}

function firstSentence(desc) {
  const s = String(desc || '').trim()
  const cut = s.split(/[。；;]|(?<=\.)\s/)[0] || s
  return cut.length > 160 ? cut.slice(0, 157) + '...' : cut
}

export function effectsOf(name) {
  return EFFECTS_OVERRIDES[name] ? [...EFFECTS_OVERRIDES[name]] : ['read']
}

// ── H07（0.5.14 复审修复）：情境能力提示（≤2 条、有条件；名称/副作用取自同一目录；只建议不执行）──
// 无快捷位的承载状态统一译为「无快捷位，完整出口可用」，不让 not_carried/no_landing 看起来像不可用。
const NO_SHORTCUT = new Set(['not_carried', 'no_landing'])
const INTENT_HINTS = [
  // F4（0.5.14 Windows 复核）：中英匹配分开——中文备选不能包在 ASCII 单词边界 \b...\b 里
  //（JS 的 \b 按 [A-Za-z0-9_] 判定，中文两侧都是「非词」→ 永远不匹配；专家 024/026/028/030/032 五组中文零提示）。
  { name: 'inspect', en: /\b(inspect|composition|combined structure)\b/i, zh: /(结构检查|整体结构|组合检查|结构梳理|组合结构)/, why: 'combined structure/composition inspection' },
  { name: 'dep_graph', en: /\b(dep[-_ ]?graph|dependency graph|module graph|import graph)\b/i, zh: /(依赖图|模块依赖|依赖关系|依赖分析|导入关系)/, why: 'dependency question' },
  { name: 'diff_facts', en: /\b(diff_facts|diff facts|what changed|facts after|change facts)\b/i, zh: /(变更事实|改动事实|改动核对|变更核对|改动清单)/, why: 'fact check after modifications' },
  { name: 'rename_symbol', en: /\b(rename|renaming)\b/i, zh: /(重命名|改名)/, why: 'rename intent' },
  { name: 'spec_gen', en: /\b(spec_gen|spec gen|specification|api doc|interface doc)\b/i, zh: /(规格书|接口文档|生成文档|规格说明|接口说明)/, why: 'spec/API documentation intent' },
]

export function intentHints(text, { root = ROOT, workspace_dir = null } = {}) {
  const s = String(text || '')
  if (!s.trim()) return []
  const wl = capabilityWhitelist(root)
  const out = []
  for (const h of INTENT_HINTS) {
    if (out.length >= 2) break
    if (!(h.en.test(s) || h.zh.test(s))) continue
    if (!wl.has(h.name)) continue
    out.push({
      name: h.name,
      why: h.why,
      effects: effectsOf(h.name),
      // F4：描述动作补齐 workspace_dir（必填）——原样调用即可（033 现场：只有 mode/name → missing_parameter）
      describe: { tool: 'code_query', args: { ...(workspace_dir ? { workspace_dir } : {}), mode: 'capability', name: h.name } },
      call_via: 'invoke_capability (complete outlet; nothing is executed by this hint)',
    })
  }
  return out
}

export function listCapabilities({ root = ROOT, query = null, category = null, cursor = 0, limit = 50 } = {}) {
  const wl = capabilityWhitelist(root)
  const pos = loadPositions(root).byName
  let items = []
  for (const [name, t] of wl) {
    const p = pos.get(name) || {}
    const wiring = p.status || 'unknown'
    const noShortcut = NO_SHORTCUT.has(wiring)
    items.push({
      name,
      summary: firstSentence(t.manifest.description),
      category: p.entry || 'uncategorized',
      effects: effectsOf(name),
      wiring,
      availability: noShortcut ? 'no_shortcut_entry' : 'shortcut_entry',
      outlet: 'invoke_capability',
      ...(noShortcut ? { wiring_note: 'No graph shortcut entry — the capability is still FULLY available via invoke_capability (complete outlet). No-shortcut ≠ unavailable.' } : {}),
    })
  }
  if (typeof query === 'string' && query.trim()) {
    const q = query.trim().toLowerCase()
    items = items.filter((i) => i.name.toLowerCase().includes(q) || i.summary.toLowerCase().includes(q))
  }
  if (typeof category === 'string' && category.trim()) {
    items = items.filter((i) => i.category === category.trim())
  }
  const start = Number.isInteger(cursor) && cursor > 0 ? cursor : 0
  const size = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 50
  const page = items.slice(start, start + size)
  const next = start + page.length < items.length ? start + page.length : null
  const note = page.length === 0
    ? 'No capability matched. Drop query/category filters to enumerate all original classic tools.'
    : 'Catalog of original classic tools (discovery only; nothing is executed). Describe one with code_query(mode="capability", name=...). Wiring labels: carried/partial = a graph shortcut exists; not_carried/no_landing = NO shortcut entry — the capability remains fully available via invoke_capability (complete outlet; not unavailable).'
  return { items: page, total: items.length, cursor: start, next_cursor: next, note }
}

// 适配器状态：从 handler 源抽取 context 依赖（描述≠预检；真实可用性由调用暴露）
function contextServices(handlerSrc) {
  const out = new Set()
  for (const m of String(handlerSrc).matchAll(/context\.([a-zA-Z_][a-zA-Z0-9_]*)/g)) out.add(m[1])
  for (const m of String(handlerSrc).matchAll(/const\s*\{([^}]*)\}\s*=\s*context/g)) {
    for (const part of m[1].split(',')) {
      const k = part.trim().split(':')[0].trim()
      if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k)) out.add(k)
    }
  }
  return [...out].sort()
}

export function describeCapability(name, { root = ROOT } = {}) {
  if (name == null || name === '') {
    return { error: 'missing_parameter', message: 'name is required', suggestion: 'Pass the exact original tool name, e.g. name="find_tests". Enumerate names with code_query(mode="capabilities").' }
  }
  if (typeof name !== 'string' || !/^[a-z][a-z0-9_]{1,40}$/.test(name)) {
    return { error: 'invalid_input', message: 'name must be an exact tool name (lowercase identifier)', suggestion: 'Do not pass paths or module specifiers; enumerate valid names with code_query(mode="capabilities").' }
  }
  const wl = capabilityWhitelist(root)
  const t = wl.get(name)
  if (!t) {
    return { error: 'unknown_capability', message: 'Unknown capability: ' + name, suggestion: 'Enumerate valid names with code_query(mode="capabilities").', valid_count: wl.size }
  }
  const pos = loadPositions(root).byName.get(name) || {}
  const m = t.manifest
  const effects = effectsOf(name)
  return {
    name,
    version: m.version || null,
    summary: m.description,
    category: pos.entry || 'uncategorized',
    effects,
    safety: {
      // ── 原件直呼（classic 接口）可见的副作用面 ──
      writes_workspace: effects.includes('workspace_write'),
      writes_state: effects.includes('state_write'),
      runs_command: effects.includes('command'),
      touches_git: effects.includes('git'),
      service_state: effects.includes('service_state') || effects.includes('cleanup') || effects.includes('index'),
      readonly: effects.length === 1 && effects[0] === 'read',
      // ── 适配器前置条件（经 invoke_capability 保底出口调用时；R06 审核修复分列）──
      via_outlet: {
        state_gated: true,
        delegates_once: true,
        terminal_guard: (effects.length === 1 && effects[0] === 'read') ? null : 'task 关联且任务非 active 时拒绝副作用（cancelled/closed）；reopen 后放行',
        ledger: (effects.length === 1 && effects[0] === 'read') ? null : 'task 场景入任务操作账本（kind=invoke）；无 task + request_id 入出口账本',
        request_id: '同 id 同载荷 → 幂等复读（deduplicated）；同 id 异载荷 → request_conflict',
      },
    },
    limitations: pos.note ? [pos.note] : [],
    schema: m.inputSchema,
    params: {
      required: [...(m.inputSchema?.required || [])].sort(),
      properties: Object.keys(m.inputSchema?.properties || {}).sort(),
    },
    enums: (function walk(schema, prefix, out) {
      if (!schema || typeof schema !== 'object') return out
      if (Array.isArray(schema.enum)) out[prefix] = [...schema.enum]
      if (schema.properties) for (const k of Object.keys(schema.properties).sort()) walk(schema.properties[k], prefix ? prefix + '.' + k : k, out)
      if (schema.items) walk(schema.items, prefix + '[]', out)
      return out
    })(m.inputSchema, '', {}),
    call_template: {
      shortcut: pos.entry ? 'See category "' + pos.entry + '" shortcuts; in classic interface the original name is directly callable.' : 'In classic interface the original name is directly callable.',
      full_outlet: 'Available via invoke_capability(name, args, task_id?) — state-gated (ADR-018); delegates once to the original implementation and preserves its result.',
    },
    wiring_status: pos.status || 'unknown',
    adapter: {
      context_services: contextServices(existsSync(join(root, 'tools', t.dir, t.handler)) ? readFileSync(join(root, 'tools', t.dir, t.handler), 'utf-8') : ''),
      note: 'Context services required from the host (descriptive, not pre-checked); empty = self-contained.',
    },
    catalog_contract_version: CATALOG_CONTRACT_VERSION,
  }
}
