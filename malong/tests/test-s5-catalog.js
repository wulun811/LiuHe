// test-s5-catalog.js — S5.4b 目录合同（workflow/public-catalog.js）
// LH-007（2026-10-07）：真白名单——classic 44 全量不变（golden 快照）；ADR-018（2026-10-12）增 invoke_capability
// graph=读4(含 code_query)+写8(需 state)+edit_transaction=13；diagnostic=graph+5 分析器=18；不在白名单的工具在 graph/diagnostic 一律隐藏。
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
let pass = 0, fail = 0
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  FAIL:', msg) } }

const imp = (p) => import(pathToFileURL(p).href)
const cat = await imp(join(ROOT, 'workflow', 'public-catalog.js'))
const ToolRegistry = (await imp(join(ROOT, 'tool-registry.js'))).default

// 契约白名单（与实现独立声明，防实现自述漂移）
const GRAPH_READ = ['code_task', 'code_read', 'code_status', 'code_query']
const GRAPH_WRITE = ['code_audit', 'code_batch', 'code_check', 'code_control', 'code_maintain', 'code_patch', 'code_worktree', 'invoke_capability']
const GRAPH_EXTRA = ['edit_transaction']
const DIAG_EXTRA = ['config_drift', 'sweep_dead_code', 'dependency_gatekeeper', 'repo_map', 'security_review']

// ── 1. gateReason / isPublic（新白名单语义）──
const CLASSIC = { name: 'edit_batch' }
const GRAPH = { name: 'code_task', interface: 'graph' }
const GRAPH_STATE = { name: 'code_patch', interface: 'graph', requires_state: true }
assert(cat.gateReason(CLASSIC, { MALONG_INTERFACE: 'classic' }) === null, 'classic 工具在 classic → 可见')
assert(cat.gateReason(GRAPH, { MALONG_INTERFACE: 'classic' }) === cat.GATE.GRAPH, 'graph 入口在 classic → GRAPH')
// 0.5.24（breaking）：默认 env = 六和线（graph）——graph 入口默认可见、classic 工具默认隐藏
assert(cat.gateReason(GRAPH, {}) === null, '默认 env（六和线）→ graph 入口可见')
assert(cat.gateReason(CLASSIC, {}) === cat.GATE.MODE, '默认 env（六和线）→ classic 工具隐藏（MODE）')
assert(cat.gateReason(GRAPH, { MALONG_INTERFACE: 'graph' }) === null, 'code_task 在 graph → 可见')
assert(cat.gateReason(GRAPH_STATE, { MALONG_INTERFACE: 'graph', MALONG_ENTRY_STATE: '0' }) === cat.GATE.STATE, 'code_patch 无 state（显式 state=0）→ STATE')
assert(cat.gateReason(GRAPH_STATE, { MALONG_INTERFACE: 'graph', MALONG_ENTRY_STATE: '1' }) === null, 'code_patch + state → 可见')
assert(cat.gateReason(CLASSIC, { MALONG_INTERFACE: 'graph' }) === cat.GATE.MODE, 'edit_batch 在 graph 白名单外 → MODE')
assert(cat.gateReason({ name: 'security_review' }, { MALONG_INTERFACE: 'graph' }) === cat.GATE.MODE, '分析器在 graph 白名单外 → MODE')
assert(cat.gateReason({ name: 'security_review' }, { MALONG_INTERFACE: 'diagnostic' }) === null, '分析器在 diagnostic → 可见')
assert(cat.gateReason({ name: 'edit_transaction' }, { MALONG_INTERFACE: 'graph' }) === null, '恢复入口 edit_transaction 在 graph 可见')
assert(cat.gateReason({ name: 'edit_batch' }, { MALONG_INTERFACE: 'diagnostic' }) === cat.GATE.MODE, 'edit_batch 在 diagnostic 仍隐藏')
assert(cat.gateReason({ name: 'code_task', interface: 'graph' }, { MALONG_INTERFACE: 'diagnostic' }) === null, 'code_task 在 diagnostic 可见')
assert(cat.gateReason({ name: 'x', interface: 'diagnostic' }, { MALONG_INTERFACE: 'classic' }) === cat.GATE.DIAGNOSTIC, 'diagnostic-only 工具在 classic 隐藏')
assert(cat.gateReason({ name: 'x', interface: 'diagnostic' }, {}) === cat.GATE.MODE, 'diagnostic-only 工具在默认（六和线）隐藏（MODE）')
assert(cat.gateReason({ name: 'read_symbol' }, { MALONG_INTERFACE: 'graph' }) === cat.GATE.MODE, 'read_symbol 在 graph 隐藏（白名单外）')
assert(cat.isPublic(CLASSIC, { MALONG_INTERFACE: 'classic' }) && !cat.isPublic(GRAPH, { MALONG_INTERFACE: 'classic' }), 'isPublic 与 gateReason 一致（classic 档）')
assert(cat.isPublic(GRAPH, {}) && !cat.isPublic(CLASSIC, {}), 'isPublic 默认档 = 六和线（graph 可见、classic 隐藏）')

// ── 2. publicCatalog 排序/隐藏原因 ──
const { public: pub, hidden } = cat.publicCatalog(
  [{ manifest: GRAPH_STATE, dirName: 'tool-code-patch' }, { manifest: CLASSIC, dirName: 'tool-batch-edit' }, { manifest: GRAPH, dirName: 'tool-code-task' }],
  {},
)
assert(pub.length === 2 && pub.some(x => x.manifest.name === 'code_task') && pub.some(x => x.manifest.name === 'code_patch'), 'publicCatalog 默认 env（六和线）留 graph+state 可见者')
assert(hidden.length === 1 && hidden[0].name === 'edit_batch', '默认 env 隐藏白名单外 classic 工具')
const withClassic = cat.publicCatalog(
  [{ manifest: GRAPH_STATE, dirName: 'tool-code-patch' }, { manifest: GRAPH, dirName: 'tool-code-task' }, { manifest: CLASSIC, dirName: 'tool-batch-edit' }],
  { MALONG_INTERFACE: 'classic' },
)
assert(withClassic.public.length === 1 && withClassic.public[0].manifest.name === 'edit_batch', 'classic env 下只留 classic 可见者')
const withGraph = cat.publicCatalog(
  [{ manifest: GRAPH_STATE, dirName: 'tool-code-patch' }, { manifest: GRAPH, dirName: 'tool-code-task' }, { manifest: CLASSIC, dirName: 'tool-batch-edit' }],
  { MALONG_INTERFACE: 'graph' },
)
assert(withGraph.public.length === 2 && withGraph.public.some(x => x.manifest.name === 'code_task') && withGraph.public.some(x => x.manifest.name === 'code_patch'), 'graph env（状态层默认开）code_task + code_patch 可见')
const withGraphNoState = cat.publicCatalog(
  [{ manifest: GRAPH_STATE, dirName: 'tool-code-patch' }, { manifest: GRAPH, dirName: 'tool-code-task' }, { manifest: CLASSIC, dirName: 'tool-batch-edit' }],
  { MALONG_INTERFACE: 'graph', MALONG_ENTRY_STATE: '0' },
)
assert(withGraphNoState.public.length === 1 && withGraphNoState.public[0].manifest.name === 'code_task', 'graph + MALONG_ENTRY_STATE=0 → 只读 5 工具档')
assert(withGraphNoState.hidden.some(h => h.name === 'code_patch' && h.reason === cat.GATE.STATE), 'graph + state=0：code_patch 卡 STATE')

// ── 3. 计数（真实 tools 目录 + registry 无漂移）──
const TOOLS_DIR = join(ROOT, 'tools')
function manifests() {
  return readdirSync(TOOLS_DIR).filter(d => existsSync(join(TOOLS_DIR, d, 'manifest.json')))
    .map(d => ({ manifest: JSON.parse(readFileSync(join(TOOLS_DIR, d, 'manifest.json'), 'utf-8')), dirName: d }))
}
async function registryFor(env) {
  const saved = { ...process.env }
  for (const k of ['MALONG_INTERFACE', 'MALONG_ENTRY_STATE', 'MALONG_ENTRY_EPHEMERAL']) delete process.env[k]
  Object.assign(process.env, env)
  const reg = new ToolRegistry()
  await reg.loadAll(TOOLS_DIR)
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
  Object.assign(process.env, saved)
  return reg
}
const CASES = [
  ['默认（六和线）', {}, GRAPH_READ.length + GRAPH_WRITE.length + GRAPH_EXTRA.length],
  ['classic', { MALONG_INTERFACE: 'classic' }, 44],
  ['graph（状态层默认开）', { MALONG_INTERFACE: 'graph' }, GRAPH_READ.length + GRAPH_WRITE.length + GRAPH_EXTRA.length],
  ['graph+state=0（只读）', { MALONG_INTERFACE: 'graph', MALONG_ENTRY_STATE: '0' }, GRAPH_READ.length + GRAPH_EXTRA.length],
  ['diagnostic（状态层默认开）', { MALONG_INTERFACE: 'diagnostic' }, GRAPH_READ.length + GRAPH_WRITE.length + GRAPH_EXTRA.length + DIAG_EXTRA.length],
  ['diagnostic+state=0', { MALONG_INTERFACE: 'diagnostic', MALONG_ENTRY_STATE: '0' }, GRAPH_READ.length + GRAPH_EXTRA.length + DIAG_EXTRA.length],
]
for (const [label, env, expected] of CASES) {
  const reg = await registryFor(env)
  assert(reg.getToolCount() === expected, label + '=' + expected + '（得 ' + reg.getToolCount() + '）')
  assert(cat.publicCatalog(manifests(), env).public.length === expected, 'publicCatalog 与 registry 计数一致（' + label + '）')
}
// graph hidden 原因透出 + 白名单外 classic 隐藏
{
  const reg = await registryFor({ MALONG_INTERFACE: 'graph', MALONG_ENTRY_STATE: '0' })
  assert(reg.hasTool('code_task') && reg.hasTool('edit_transaction'), 'graph 白名单可调集含 read 与恢复入口')
  assert(!reg.hasTool('edit_batch') && !reg.hasTool('read_symbol'), 'graph 不加载白名单外 classic 工具')
  assert(typeof reg.getHiddenReason === 'function' && reg.getHiddenReason('edit_batch') === cat.GATE.MODE, 'registry 透出隐藏原因（MODE）')
  assert(reg.getHiddenReason('code_patch') === cat.GATE.STATE, 'registry 透出隐藏原因（STATE）')
  assert(reg.getHiddenReason('no_such_tool') === null, '未知工具无隐藏原因')
}

// ── 4. classic 44 golden：名单 + manifest 逐字节聚合哈希 ──
const CLASSIC_GOLDEN_NAMES = ['active_todos','call_chain','code_quality','code_review','code_search','config_drift','debug_runner','dep_graph','dependency_gatekeeper','diff_facts','edit_batch','edit_collision_guard','edit_transaction','exception_guard','feedback','find_tests','fix_imports','gc','git_worktree','guard_patterns','health','impact_analysis','inspect','mock_sync','naming_consistency','patch_parser','read_outline','read_symbol','references','reindex','rename_symbol','repo_map','sandbox_validate','security_review','spec_gen','style_sniffer','sweep_dead_code','symbol_search','test_bridge','trace_symbol','tsc_check','verify_pipeline','write_symbol','write_symbols']
// 14-A 有意识变更：edit_transaction manifest 1.4.0→1.4.1（AC29 双位置 expect_sha 文档化）——golden 随之更新
// WP08R-2（2026-10-10）有意识变更：graph 目录展示层压缩波及 edit_transaction（classic 也可见）——
//   desc+inputSchema 21,242→10,211B（参数名/required 冻结，见 test-graph-catalog-budget）——golden 随之更新
// 狗粮修复（2026-10-13）有意识变更：code_search 描述口径诚实化（“确定性匹配，非语义”，避免 NL 期望误导）
// 狗粮r2（2026-10-13）有意识变更：dependency_gatekeeper/security_review 描述补「需 file/scope」约束——golden 随之更新
// F5（2026-10-18 Windows 复核）有意识变更：repo_map manifest 声明 page/page_size/prefix（handler 早已接受，
//   但 schema 未公开 → 「实现接受、模型看不见」）。参数只增不减，原有语义不变；golden 随之更新。
const CLASSIC_GOLDEN_HASH = 'sha256:378dc21544a3409b57f698f02623d70b1eb6b067a91c2f252f7f56f10ffa1586'
function classicManifests() {
  const rows = []
  for (const d of readdirSync(TOOLS_DIR)) {
    const p = join(TOOLS_DIR, d, 'manifest.json')
    if (!existsSync(p)) continue
    const m = JSON.parse(readFileSync(p, 'utf-8'))
    if (m.interface === 'graph' || m.interface === 'diagnostic') continue
    rows.push(m)
  }
  rows.sort((a, b) => a.name.localeCompare(b.name))
  return rows
}
const gold = classicManifests()
assert(JSON.stringify(gold.map(m => m.name)) === JSON.stringify(CLASSIC_GOLDEN_NAMES), 'classic 44 名单 golden 不变（得 ' + JSON.stringify(gold.map(m => m.name)) + '）')
const gh = createHash('sha256')
for (const m of gold) gh.update(m.name).update('\0').update(JSON.stringify(m)).update('\n')
const ghHex = gh.digest('hex')
assert('sha256:' + ghHex === CLASSIC_GOLDEN_HASH, 'classic 44 manifest 逐字节 golden 不变（得 sha256:' + ghHex + '）')

console.log('\n=== test-s5-catalog: ' + pass + ' passed, ' + fail + ' failed ===')
process.exit(fail > 0 ? 1 : 0)
