// workflow/public-catalog.js — 目录合同的**单一来源**（plan §8.5 / ADR-017）。
// router 与 registry 共用同一门控，避免两处逻辑漂移。
// LH-007（2026-10-07）真白名单（替代旧的叠加门控）：
//   classic    → 除 interface=graph/diagnostic 外全部可见（44，逐字节不变 + golden 锁定）
//   graph      → 仅 GRAPH_READ + GRAPH_WRITE(需 MALONG_ENTRY_STATE=1) + edit_transaction
//   diagnostic → graph 白名单 ∪ DIAGNOSTIC_EXTRA（5 个分析器）
// 0.5.24（breaking）：**默认档翻到「六合线」**——不设 env = graph（13 个工具的六和线，
// 状态层默认开）；要全量 44 请显式 MALONG_INTERFACE=classic，要分析器档 18 请显式
// MALONG_INTERFACE=diagnostic。历史默认是 classic（44），现为显式选项。
// 未来多宿主/独立包：宿主只需设置 env 组合，无需复制过滤逻辑。

export const GATE = {
  GRAPH: 'graph interface gated',
  STATE: 'state-gated',
  MODE: 'not in current interface whitelist',
  DIAGNOSTIC: 'diagnostic-only tool',
}

export const INTERFACES = ['classic', 'graph', 'diagnostic']

// 白名单（契约核心；与 test-s5-catalog 独立声明互锁）
export const GRAPH_READ = ['code_task', 'code_read', 'code_status', 'code_query']
// ADR-018（2026-10-12）：GRAPH_WRITE 增 invoke_capability（保底调用出口，state 门控）——graph+state 面 12→13。
export const GRAPH_WRITE = ['code_audit', 'code_batch', 'code_check', 'code_control', 'code_maintain', 'code_patch', 'code_worktree', 'invoke_capability']
export const GRAPH_EXTRA = ['edit_transaction']
export const DIAGNOSTIC_EXTRA = ['config_drift', 'sweep_dead_code', 'dependency_gatekeeper', 'repo_map', 'security_review']
const GRAPH_SET = new Set([...GRAPH_READ, ...GRAPH_WRITE, ...GRAPH_EXTRA])
const GRAPH_WRITE_SET = new Set(GRAPH_WRITE)
const DIAG_SET = new Set([...GRAPH_SET, ...DIAGNOSTIC_EXTRA])

export function currentInterface(env = process.env) {
  const v = env.MALONG_INTERFACE
  // 0.5.24（breaking）：默认 = graph（六和线）。classic 44 / diagnostic 18 仍可达，但需显式声明。
  return v === 'classic' || v === 'diagnostic' ? v : 'graph'
}

// 状态层（task/evidence 状态机）可见性开关：0.5.24 起默认开（graph 档 = 13 个工具），
// 显式 MALONG_ENTRY_STATE=0 可退回只读 5 工具（graph 不带 state）。
export function stateEnabled(env = process.env) {
  return env.MALONG_ENTRY_STATE !== '0'
}

// 返回 null 表示可见；否则返回门控原因字符串。
export function gateReason(manifest, env = process.env) {
  const mode = currentInterface(env)
  const name = manifest?.name
  if (mode === 'classic') {
    if (manifest?.interface === 'graph') return GATE.GRAPH
    if (manifest?.interface === 'diagnostic') return GATE.DIAGNOSTIC
    return null
  }
  if (mode === 'graph') {
    if (!GRAPH_SET.has(name)) return GATE.MODE
    if (GRAPH_WRITE_SET.has(name) && !stateEnabled(env)) return GATE.STATE
    return null
  }
  // diagnostic
  if (!DIAG_SET.has(name)) return GATE.MODE
  if (GRAPH_WRITE_SET.has(name) && !stateEnabled(env)) return GATE.STATE
  return null
}

export function isPublic(manifest, env = process.env) {
  return gateReason(manifest, env) === null
}

// 单一口径：给定 [{manifest, dirName}]，返回 { public(按名排序), hidden }。
export function publicCatalog(entries, env = process.env) {
  const pub = []
  const hidden = []
  for (const e of entries || []) {
    const reason = gateReason(e?.manifest, env)
    if (reason) hidden.push({ name: e?.manifest?.name ?? null, dir: e?.dirName ?? null, reason })
    else pub.push({ manifest: e.manifest, dir: e?.dirName ?? null })
  }
  pub.sort((a, b) => String(a.manifest?.name).localeCompare(String(b.manifest?.name)))
  return { public: pub, hidden }
}