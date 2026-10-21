// test-s1-entry.js — S1 只读入口（code_task/code_read/code_status）失败路径 + graph env 门
// 覆盖：参数校验、未知 task/read_ref、revision 冲突、错误码透传、read_ref 复用、
//       默认 env = 六和线 13（0.5.24 起）/ MALONG_INTERFACE=classic 加载 44。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import os from 'node:os'
import ToolRegistry from '../tool-registry.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  FAIL:', msg) } }

const TMP = join(os.tmpdir(), 'opencode', 's1-entry-test')
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
mkdirSync(join(TMP, 'src'), { recursive: true })
process.env.MALONG_STATE_DIR = join(TMP, 'state')
writeFileSync(join(TMP, 'src', 'admin.js'), [
  'export function login(pass) {',
  "  if (!pass) return { error: 'ADMIN_EMPTY' }",
  '  return { user: pass }',
  '}',
].join('\n'))
writeFileSync(join(TMP, 'src', 'auth.js'), "export function login(c, u) { if (!c) return { error: 'EMPTY_CREDENTIAL' }; return {} }\n")
mkdirSync(join(TMP, 'proj'), { recursive: true })
mkdirSync(join(TMP, 'other'), { recursive: true })
writeFileSync(join(TMP, 'proj', 'mcp-server.js'), 'export function handle() {}\n')
writeFileSync(join(TMP, 'proj', 'public-catalog.js'), [
  'export function gateReason(m, env) {',
  '  // MALONG_INTERFACE visibility gate',
  '  return null',
  '}',
].join('\n'))
writeFileSync(join(TMP, 'other', 'graph_cache.py'), 'GRAPH_CACHE = 1\n')
// 模拟真实工作区：.malongignore 排除 proj/——显式 target 必须覆盖忽略规则（用户指名即授权）
writeFileSync(join(TMP, '.malongignore'), 'proj/\n')
// 测试路径不进内容候选（dogfood ① 回归：tests/ 洪泛吃掉 per-token 上限）
mkdirSync(join(TMP, 'proj', 'tests'), { recursive: true })
writeFileSync(join(TMP, 'proj', 'tests', 'noise.test.js'), '// MALONG_INTERFACE should not surface\nexport function noiseTest() {}\n')

const imp = (p) => import(pathToFileURL(p).href)

function mockIndex() {
  const symbols = {
    'src/admin.js': [{ name: 'login', type: 'function', start_line: 1, end_line: 4, stable_id: 'js:src/admin.js::login#function', signature: 'function login(pass)', body_hash: 'h_admin', signature_hash: 's_admin' }],
    'src/auth.js': [{ name: 'login', type: 'function', start_line: 1, end_line: 1, stable_id: 'js:src/auth.js::login#function', signature: 'function login(c, u)', body_hash: 'h_auth', signature_hash: 's_auth' }],
    'src/a.js': [{ name: 'jointFn', type: 'function', start_line: 1, end_line: 2, stable_id: 'js:src/a.js::jointFn#function', signature: 'function jointFn()', body_hash: 'h_ja', signature_hash: 's_ja' }],
    'src/z.js': [{ name: 'otherZ', type: 'function', start_line: 1, end_line: 1, stable_id: 'js:src/z.js::otherZ#function', signature: 'function otherZ()', body_hash: 'h_oz', signature_hash: 's_oz' }, { name: 'jointFn', type: 'function', start_line: 2, end_line: 3, stable_id: 'js:src/z.js::jointFn#function', signature: 'function jointFn()', body_hash: 'h_jz', signature_hash: 's_jz' }],
    'proj/mcp-server.js': [{ name: 'handle', type: 'function', start_line: 1, end_line: 3, stable_id: 'js:proj/mcp-server.js::handle#function', signature: 'function handle()', body_hash: 'h_mcp', signature_hash: 's_mcp' }],
    'proj/public-catalog.js': [{ name: 'gateReason', type: 'function', start_line: 1, end_line: 3, stable_id: 'js:proj/public-catalog.js::gateReason#function', signature: 'function gateReason()', body_hash: 'h_gate', signature_hash: 's_gate' }],
    'other/graph_cache.py': [{ name: 'GRAPH_CACHE', type: 'variable', start_line: 1, end_line: 1, stable_id: 'py:other/graph_cache.py::GRAPH_CACHE#variable', signature: 'GRAPH_CACHE = 1', body_hash: 'h_gc', signature_hash: 's_gc' }],
    'src/service.js': [{ name: 'renderWidget', type: 'method', start_line: 1, end_line: 3, parent_id: 9, stable_id: 'js:src/service.js::renderWidget#method', signature: 'renderWidget(cfg) {', body_hash: 'h_rw', signature_hash: 's_rw' }],
  }
  return {
    async initWorkspace() {},
    async indexBatch() { return ['src/admin.js', 'src/auth.js'] },
    async findDefinitions(name, opts = {}) {
      const out = []
      for (const [file, arr] of Object.entries(symbols)) for (const s of arr) {
        if (s.name !== name) continue
        if (s.parent_id != null && !opts?.includeMethods) continue
        out.push({ name, type: s.type, start_line: s.start_line, end_line: s.end_line, path: file })
      }
      return out
    },
    async searchSymbols(name) {
      if (name === 'ghostAnchor') return [{ name: 'ghostAnchor', type: 'variable', start_line: 1, end_line: 1, file: 'src/admin.js' }]
      if (name === 'bulkWidget') return Array.from({ length: 12 }, (_, i) => ({ name: 'bulkWidget', type: 'function', start_line: 1, end_line: 2, file: 'src/bulk' + (i + 1) + '.js' }))
      return []
    },
    findSymbolsInFile(file, name, kind) { return (symbols[file] || []).filter(s => s.name === name && (!kind || s.type === kind)) },
    async getFileOutline(file) { return { outline: (symbols[file] || []).map(s => ({ name: s.name, type: s.type, line: s.start_line, end_line: s.end_line })) } },
    async getSymbolsAtLine(file, line) { return (symbols[file] || []).filter(s => s.start_line <= line && line <= s.end_line) },
    getSymbolByStableId(id) { for (const [file, arr] of Object.entries(symbols)) for (const s of arr) if (s.stable_id === id) return { ...s, file_path: file }; return null },
    getFileByPath(file) { return { path: file, index_state: 'fresh' } },
  }
}
const ctx = { codeIndexService: mockIndex(), getWorkspaceDir: (w) => w }
const shared = await imp(join(__dirname, '..', 'tools', 'entry-shared.js'))

const taskMod = await imp(join(__dirname, '..', 'tools', 'tool-code-task', 'handler.js'))
const readMod = await imp(join(__dirname, '..', 'tools', 'tool-code-read', 'handler.js'))
const statusMod = await imp(join(__dirname, '..', 'tools', 'tool-code-status', 'handler.js'))

// ── code_task 失败路径 ──
let r = await taskMod.handle({}, ctx)
assert(r.error === 'missing_parameter', 'code_task 缺 workspace_dir → missing_parameter')
r = await taskMod.handle({ workspace_dir: join(TMP, 'nope'), goal: 'x' }, ctx)
assert(r.error === 'invalid_input', 'code_task 目录不存在 → invalid_input')
r = await taskMod.handle({ workspace_dir: TMP }, ctx)
assert(r.error === 'missing_parameter', 'code_task 缺 goal → missing_parameter')
r = await taskMod.handle({ workspace_dir: TMP, goal: 'x', route: 'bogus' }, ctx)
assert(r.error === 'invalid_input', 'code_task 非法 route → invalid_input')
r = await taskMod.handle({ workspace_dir: TMP, goal: 'find login' }, { codeIndexService: null })
assert(r.error === 'service_unavailable', 'code_task 无 service → service_unavailable')

// ── code_task 成功：候选含 stable_id ──
const t = await taskMod.handle({ workspace_dir: TMP, goal: 'which admin login handles empty password', target: { symbol: 'login' } }, ctx)
assert(t.ok === true && !!t.task?.task_id, 'code_task 成功返回 task_id')
assert(Array.isArray(t.allowed_actions) && t.allowed_actions.includes('code_read'), 'code_task allowed_actions 含 code_read')
assert(/NOT (a )?permissions?/i.test(t.actions_note || ''), `code_task actions_note 澄清 allowed_actions 非权限清单（得 ${t.actions_note}）`)
assert(t.observation.candidates.length >= 1 && t.observation.candidates.some(c => c.symbol_id), 'code_task 候选含 symbol_id')
assert(t.next_action && t.next_action.tool === 'code_read' && t.next_action.args?.locator && (t.next_action.args.locator.symbol_id || t.next_action.args.locator.file_path), '13-C code_task 候选 → next_action=code_read（得 ' + JSON.stringify(t.next_action || null) + '）')
assert(/code_batch/.test(t.next_action.note || '') && /ONE code_batch/.test(t.next_action.note || ''), 'WP08R-2 G1 code_task note 教批量（得 ' + (t.next_action.note || '') + '）')
assert(t.observation.file_groups && t.observation.file_groups.reduce((s, g) => s + g.count, 0) === t.observation.candidates.length, '13-D file_groups 按文件聚合且总数一致（得 ' + JSON.stringify(t.observation.file_groups || null) + '）')
assert(t.observation.unique_candidate_files === new Set(t.observation.candidates.map(c => c.file_path)).size, '14-A AC32 唯一文件数显式可见且与候选一致（得 ' + JSON.stringify(t.observation.unique_candidate_files) + '）')
assert(t.observation.file_groups.every(g => g.truncated === (g.count > 3)) && t.observation.file_groups.every(g => Array.isArray(g.symbols) && g.symbols.length <= 3), '14-A AC32 分组截断标记可见（count>3 → truncated，symbols≤3）')

// ── R2：无 target + .malongignore → scan_scope_note 显式提示（防镜像/空候选误导）──
const noTarget = await taskMod.handle({ workspace_dir: TMP, goal: 'admin login empty password' }, ctx)
assert(noTarget.ok === true && typeof noTarget.observation?.scan_scope_note === 'string' && /malongignore/.test(noTarget.observation.scan_scope_note), `R2 无 target 提示 scan_scope_note（得 ${noTarget.observation?.scan_scope_note}）`)
const withTarget = await taskMod.handle({ workspace_dir: TMP, goal: 'admin login empty password', target: { file: 'src/admin.js' } }, ctx)
assert(withTarget.observation?.scan_scope_note == null, 'R2 有 target 时不加 scope note')
const store = await imp(join(__dirname, '..', 'tools', 'entry-store.js'))
assert(t.observation.index && 'truncated' in t.observation.index, 'T18 code_task 首屏 index 含 truncated')
assert(store.getTask(TMP, t.task.task_id)?.index_scope?.truncated === false, 'T18 code_task 持久化 index_scope（truncated=false）')
const taskId = t.task.task_id

// ── S2 去重幂等：同 request_id + 同载荷（target 键序不同）→ 必须 dedup，而非 request_conflict ──
const order1 = await taskMod.handle({ workspace_dir: TMP, goal: 'which admin login handles empty password', target: { symbol: 'login', file: 'src/admin.js' }, request_id: 'req_order_diff' }, ctx)
assert(order1.ok === true && order1.observation?.deduplicated !== true, '去重前置：首次建任务')
const order2 = await taskMod.handle({ workspace_dir: TMP, goal: 'which admin login handles empty password', target: { file: 'src/admin.js', symbol: 'login' }, request_id: 'req_order_diff' }, ctx)
assert(order2.ok === true && order2.observation?.deduplicated === true, `同载荷键序不同 → 幂等去重（得 error=${order2.error}）`)

// ── 第二轮审查：去重必须计入显式 route（旧只比 goal/target，异 route 被静默丢弃）──
const rr1 = await taskMod.handle({ workspace_dir: TMP, goal: 'route dedup check', route: 'understand', request_id: 'rq_route' }, ctx)
assert(rr1.ok === true && rr1.observation?.deduplicated !== true, 'route 去重前置：首次建任务')
const rr2 = await taskMod.handle({ workspace_dir: TMP, goal: 'route dedup check', route: 'change', request_id: 'rq_route' }, ctx)
assert(rr2.error === 'request_conflict', `同 id 异显式 route → request_conflict（得 ${rr2.error}）`)
const rr3 = await taskMod.handle({ workspace_dir: TMP, goal: 'route dedup check', request_id: 'rq_route' }, ctx)
assert(rr3.ok === true && rr3.observation?.deduplicated === true, '同 id 省略 route → 仍幂等去重')

// ── code_read 失败路径 ──
r = await readMod.handle({ workspace_dir: TMP }, ctx)
assert(r.error === 'missing_parameter', 'code_read 缺 task_id → missing_parameter')
r = await readMod.handle({ workspace_dir: TMP, task_id: 'task_ghost' }, ctx)
assert(r.error === 'task_not_found', 'code_read 未知 task_id → task_not_found')
assert(/Re-use an active task in this workspace \(task_/.test(r.suggestion || ''), `WP08R-5 P4：未知 task_id 附活跃任务候选（得 ${r.suggestion}）`)
r = await readMod.handle({ workspace_dir: TMP, task_id: taskId, expected_state_revision: 99, locator: { file_path: 'src/admin.js', name: 'login' } }, ctx)
assert(r.error === 'revision_conflict', 'code_read revision 冲突 → revision_conflict')
r = await readMod.handle({ workspace_dir: TMP, task_id: taskId }, ctx)
assert(r.error === 'missing_parameter', 'code_read 缺 locator/read_ref → missing_parameter')
r = await readMod.handle({ workspace_dir: TMP, task_id: taskId, read_ref: 'read_999' }, ctx)
assert(r.error === 'read_ref_not_found', 'code_read 未知 read_ref → read_ref_not_found')
r = await readMod.handle({ workspace_dir: TMP, task_id: taskId, locator: { file_path: 'src/admin.js', name: 'nope' } }, ctx)
assert(r.ok === false && (r.code === 'SYMBOL_NOT_FOUND' || r.error === 'SYMBOL_NOT_FOUND'), 'code_read 透传 read_symbol 错误码 SYMBOL_NOT_FOUND')
r = await readMod.handle({ workspace_dir: join(TMP, 'other'), task_id: taskId, locator: { file_path: 'src/admin.js', name: 'login' } }, ctx)
assert(r.error === 'task_not_found', 'code_read 跨 workspace → task_not_found（状态按 ws 命名空间隔离）')
assert(/do not invent a task_id/.test(r.suggestion || ''), `WP08R-5 P4：无活跃任务 → 明确禁止编造 + 引导 code_task（得 ${r.suggestion}）`)

// ── code_read 成功 + read_ref 复用 ──
r = await readMod.handle({ workspace_dir: TMP, task_id: taskId, locator: { file_path: 'src/admin.js', name: 'login' } }, ctx)
assert(r.ok === true && r.read_ref === 'read_1', 'code_read 成功返回 read_1')
assert(r.task?.revision === 2, `code_read 成功返回自增后 revision（旧实现返回 pre-CAS=1；得 ${r.task?.revision}）`)
assert(String(r.observation.body_excerpt).includes('ADMIN_EMPTY'), 'code_read body 含符号正文')
r = await readMod.handle({ workspace_dir: TMP, task_id: taskId, read_ref: 'read_1' }, ctx)
assert(r.ok === true && r.read_ref === 'read_2', 'code_read 以 read_ref 复用材料 → read_2')

// ── code_status ──
r = await statusMod.handle({ workspace_dir: TMP, task_id: 'task_ghost' }, ctx)
assert(r.error === 'task_not_found', 'code_status 未知 task_id → task_not_found')
r = await statusMod.handle({ workspace_dir: TMP, task_id: taskId }, ctx)
assert(r.ok === true && r.observation.materials.length === 2, 'code_status 返回 2 条材料')
assert(r.observation.node === 'read' && r.observation.evidence?.total === 0 && r.observation.operations?.total === 0, `code_status 简报含 node/evidence/operations（得 ${JSON.stringify({ node: r.observation.node, ev: r.observation.evidence, ops: r.observation.operations })}）`)
assert(/NOT (a )?permissions?/i.test(r.actions_note || ''), `code_status actions_note 澄清 allowed_actions 非权限清单（得 ${r.actions_note}）`)
r = await statusMod.handle({ workspace_dir: TMP }, ctx)
assert(r.ok === true && Array.isArray(r.observation.tasks) && r.observation.tasks.length >= 1, 'code_status 无 task_id 列活跃任务')
assert(r.observation.tasks.every(x => 'node' in x && 'evidence' in x), 'code_status 列表行含 node/evidence 计数')
r = await statusMod.handle({}, ctx)
assert(r.error === 'missing_parameter', 'code_status 缺 workspace_dir → missing_parameter')

// ── S2 去重：同 request_id 不新建，且保留首屏 candidates ──
const d1 = await taskMod.handle({ workspace_dir: TMP, goal: 'find login', request_id: 'req_dedup_1' }, ctx)
const d2 = await taskMod.handle({ workspace_dir: TMP, goal: 'find login', request_id: 'req_dedup_1' }, ctx)
assert(d2.observation?.deduplicated === true && d2.task.task_id === d1.task.task_id, 'code_task request_id 去重返回同一任务')
assert((d2.observation?.candidates || []).length >= 1, 'dedup 响应保留首屏 candidates（回归修复）')
const d3 = await taskMod.handle({ workspace_dir: TMP, goal: 'a totally different goal', request_id: 'req_dedup_1' }, ctx)
assert(d3.error === 'request_conflict', `code_task 同 request_id 不同 goal → request_conflict（得 ${d3.error}）`)

// ── dogfood ①：候选质量——target.file 锚定 + 真实正文内容命中 + 路径亲和 ──
// 复现场景：多仓工作区问「MALONG_INTERFACE 门控」，旧实现忽略 target.file、按符号名跨仓误命中
const tq = await taskMod.handle({ workspace_dir: TMP, goal: 'MALONG_INTERFACE gate implementation', target: { file: 'proj/mcp-server.js' }, request_id: 'req_quality_1' }, ctx)
const qc = tq.observation?.candidates || []
assert(qc[0]?.file_path?.startsWith('proj/'), `路径亲和：target 目录候选排第一（得 ${qc[0]?.file_path}）`)
const gi = qc.findIndex(c => c.file_path === 'proj/public-catalog.js' && c.name === 'gateReason')
const ni = qc.findIndex(c => c.name === 'GRAPH_CACHE')
assert(gi >= 0, '内容命中：token 正文命中（MALONG_INTERFACE）拉出 gateReason')
assert(ni < 0 || gi < ni, `无关仓命中不得压过 target 目录命中（gate=${gi}, noise=${ni}）`)
assert(!qc.some(c => c.file_path.includes('/tests/')), '测试路径不进内容候选（防 tests/ 洪泛吃满 per-token 上限）')

const ta = await taskMod.handle({ workspace_dir: TMP, goal: 'zzz qqq', target: { file: 'proj/mcp-server.js' }, request_id: 'req_quality_2' }, ctx)
assert((ta.observation?.candidates || []).some(c => c.file_path === 'proj/mcp-server.js'), 'target.file 顶层符号锚定（token 零命中也可回锚）')

// ── 残留①：内容扫描截断必须显式提示（防覆盖度不足被读成全量；先红后绿）──
process.env.MALONG_CONTENT_SCAN_MAX_FILES = '1'
const tT = await taskMod.handle({ workspace_dir: TMP, goal: 'MALONG_INTERFACE gate implementation', target: { file: 'proj/mcp-server.js' }, request_id: 'req_quality_trunc' }, ctx)
delete process.env.MALONG_CONTENT_SCAN_MAX_FILES
assert(tT.observation?.content_scan?.truncated === true, `扫描截断标记（得 ${JSON.stringify(tT.observation?.content_scan)}）`)
assert(tT.observation?.content_scan?.files_scanned === 1, `截断时只扫了 1 文件（得 ${tT.observation?.content_scan?.files_scanned}）`)
assert((tT.observation?.scan_warnings || []).some(w => /truncat/i.test(w)), `截断 warning 出现在首屏（得 ${JSON.stringify(tT.observation?.scan_warnings)}）`)

// ── live 审查 H3：绝对路径 target.file 归一化后仍能锚定（旧实现 join 双重拼接 → 锚定失效）──
const tAbs = await taskMod.handle({ workspace_dir: TMP, goal: 'zzz qqq absolute', target: { file: join(TMP, 'src', 'admin.js') }, request_id: 'req_abs_file' }, ctx)
const absCands = tAbs.observation?.candidates || []
assert(absCands.some(c => c.file_path === 'src/admin.js' && c.name === 'login'), `绝对路径 target.file 锚定（得 ${JSON.stringify(absCands.map(c => c.file_path + '::' + c.name))}）`)

// ── live 审查 H4：target.symbol 指向类方法（parent 非空）也要锚定（旧 findDefinitions 过滤掉）──
const tM = await taskMod.handle({ workspace_dir: TMP, goal: 'zzz qqq method', target: { symbol: 'renderWidget' }, request_id: 'req_method_sym' }, ctx)
assert((tM.observation?.candidates || []).some(c => c.name === 'renderWidget'), `类方法 target.symbol 锚定（得 ${JSON.stringify((tM.observation?.candidates || []).map(c => c.name))}）`)

// ── live 审查 H4b：target.symbol 兜底——findDefinitions 也找不到时 searchSymbols 补一轮 ──
const tFb = await taskMod.handle({ workspace_dir: TMP, goal: 'zzz qqq fallback', target: { symbol: 'ghostAnchor' }, request_id: 'req_fallback' }, ctx)
assert((tFb.observation?.candidates || []).some(c => c.name === 'ghostAnchor'), `target.symbol 兜底命中（得 ${JSON.stringify((tFb.observation?.candidates || []).map(c => c.name))}）`)

// ── live 审查 H5：contentMatches 先 stat 再读（大文件计入 skipped_large，行为回归锁）──
process.env.MALONG_CONTENT_SCAN_MAX_BYTES = '10'
const tL = await taskMod.handle({ workspace_dir: TMP, goal: 'MALONG_INTERFACE gate implementation', target: { file: 'proj/mcp-server.js' }, request_id: 'req_scan_big' }, ctx)
delete process.env.MALONG_CONTENT_SCAN_MAX_BYTES
assert((tL.observation?.content_scan?.files_skipped_large || 0) >= 1, `超大文件先 stat 后跳过（得 ${JSON.stringify(tL.observation?.content_scan)}）`)

// ── LH-004（2026-10-07）：联合锚点 target.file∩符号名置顶；目标文件无该符号 → 显式警告 ──
const tJ = await taskMod.handle({ workspace_dir: TMP, goal: 'change jointFn implementation', target: { file: 'src/z.js', symbol: 'jointFn' }, request_id: 'req_joint_1' }, ctx)
const jc = tJ.observation?.candidates || []
assert(jc[0]?.file_path === 'src/z.js' && jc[0]?.name === 'jointFn', 'LH-004 联合锚点：目标文件命中置顶（得 ' + JSON.stringify(jc.map(c => c.file_path + '::' + c.name)) + '）')
const tJ2 = await taskMod.handle({ workspace_dir: TMP, goal: 'change jointFn implementation', target: { file: 'src/a.js', symbol: 'jointFn' }, request_id: 'req_joint_2' }, ctx)
assert((tJ2.observation?.candidates || [])[0]?.file_path === 'src/a.js', 'LH-004 换目标文件后联合锚点跟随')
const tN = await taskMod.handle({ workspace_dir: TMP, goal: 'change surelyAbsent implementation', target: { file: 'src/z.js', symbol: 'surelyAbsent' }, request_id: 'req_joint_missing' }, ctx)
assert((tN.observation?.scan_warnings || []).some(w => /not found in target file/.test(w)), 'LH-004 目标文件无该符号 → 显式警告（得 ' + JSON.stringify(tN.observation?.scan_warnings) + '）')
assert(!(tN.observation?.candidates || []).some(c => c.name === 'surelyAbsent'), 'LH-004 无该符号时不伪造锚点候选')

// ── LH-005：win 反斜杠/盘符 target.file + files 归一 + file-arg 共用归一 ──
{
  const winMock = {
    getFileOutline: async (f) => ({ outline: f === 'src/z.js' ? [{ name: 'jointFn', type: 'function', line: 2 }] : [] }),
    findDefinitions: async (name) => name === 'jointFn'
      ? [{ name, type: 'function', path: 'other/deep.js', start_line: 1, end_line: 2 }, { name, type: 'function', path: 'src/z.js', start_line: 2, end_line: 3 }]
      : [],
    searchSymbols: async () => [],
    getSymbolsAtLine: async () => [],
    findSymbolsInFile: () => [],
  }
  const wc = await shared.findCandidates(winMock, 'C:/ws', 'jointFn implementation', { file: 'C:\\Ws\\src\\z.js' }, { files: ['C:\\ws\\src\\z.js'] })
  assert(wc[0]?.file_path === 'src/z.js', 'LH-005 win target.file 归一后联合锚点置顶（得 ' + JSON.stringify(wc.map(c => c.file_path + '::' + c.name)) + '）')
  assert(wc.every(c => !String(c.file_path).includes('\\')), 'LH-005 候选路径全为 POSIX')
  const fileArg = await imp(join(__dirname, '..', 'file-arg.js'))
  assert(fileArg.normalizeFilePath('C:\\Ws\\src\\a.js', 'c:/ws') === 'src/a.js', 'LH-005 file-arg win 路径归一（得 ' + fileArg.normalizeFilePath('C:\\Ws\\src\\a.js', 'c:/ws') + '）')
  assert(fileArg.normalizeFilePath('src\\a.js', null) === 'src/a.js', 'LH-005 file-arg 反斜杠转正（得 ' + fileArg.normalizeFilePath('src\\a.js', null) + '）')
  assert(fileArg.normalizeFilePath('src/a.js/', null) === 'src/a.js', 'LH-005 file-arg 尾斜杠剥离（得 ' + fileArg.normalizeFilePath('src/a.js/', null) + '）')
  // 7-A（2026-10-07 专家复测）：win 盘符 base 下相对路径直通（旧实现返回 null→''）
  const BS1 = String.fromCharCode(92)
  assert(fileArg.normalizeFilePath('z.js', 'C:/ws') === 'z.js', '7-A file-arg win base 相对路径直通（得 ' + JSON.stringify(fileArg.normalizeFilePath('z.js', 'C:/ws')) + '）')
  assert(fileArg.normalizeFilePath('..' + BS1 + 'z.js', 'C:/ws') === '', '7-A file-arg win base 越界拒绝（得 ' + JSON.stringify(fileArg.normalizeFilePath('..' + BS1 + 'z.js', 'C:/ws')) + '）')
  const wc2 = await shared.findCandidates(winMock, 'C:/ws', 'jointFn implementation', { file: 'src/z.js' }, { files: ['src/z.js'] })
  assert(wc2[0]?.file_path === 'src/z.js' && wc2[0]?.name === 'jointFn', '7-A win base 相对 target.file 联合锚点置顶（得 ' + JSON.stringify(wc2.map(c => c.file_path + '::' + c.name)) + '）')
}

// ── LH-005：非 ASCII goal 无 token → 显式归因（零命中不是不存在）──
const tNa = await taskMod.handle({ workspace_dir: TMP, goal: '修复登录空密码漏洞', request_id: 'req_non_ascii' }, ctx)
assert(tNa.observation?.content_scan?.skipped === 'non_ascii_goal', '非 ASCII goal 扫描归因（得 ' + JSON.stringify(tNa.observation?.content_scan) + '）')
assert((tNa.observation?.scan_warnings || []).some(w => /non-ASCII/i.test(w)), '非 ASCII goal 首屏提示（得 ' + JSON.stringify(tNa.observation?.scan_warnings) + '）')
assert(/target=/.test(tNa.observation?.content_scan?.hint || ''), '7-B non_ascii_goal 附可执行缩小目标 hint（得 ' + JSON.stringify(tNa.observation?.content_scan?.hint) + '）')
assert(/not proof of absence/.test(tNa.observation?.summary || ''), '零命中文案标注不代表不存在（得 ' + tNa.observation?.summary + '）')

// ── 8-A（2026-10-07 专家复测 §1）：零候选给可调用 next_action + 真实 next_candidates（不再只给 <path> 模板）──
{
  const zc = tNa.observation?.next_candidates || []
  assert(zc.length >= 1 && zc.every(c => c.file && c.file !== '<path>'), '8-A 零候选附真实 next_candidates（得 ' + JSON.stringify(zc) + '）')
  assert(zc.some(c => (c.symbols || []).length >= 1), '8-A next_candidates 带符号清单（复用结构概览）')
  assert(tNa.next_action && tNa.next_action.tool === 'code_read' && tNa.next_action.template !== true, '8-A 零候选 next_action 为可直接调用 code_read（得 ' + JSON.stringify(tNa.next_action) + '）')
  assert(tNa.next_action.args?.locator?.file_path && tNa.next_action.args.locator.file_path !== '<path>', '8-A next_action locator 指向真实文件（得 ' + JSON.stringify(tNa.next_action.args) + '）')
  assert(!/<path>/.test(tNa.next_step || ''), '8-A next_step 不含 <path> 占位（得 ' + tNa.next_step + '）')
  const zr = await readMod.handle({ ...tNa.next_action.args }, ctx)
  assert(zr.ok === true, '8-A 零候选 next_action.args 回放可读（得 ' + (zr.error || zr.message || zr.observation?.summary) + '）')
}
// 无结构模块时回退显式模板 + required_args（纯函数单测）
{
  const zg = shared.buildZeroHitGuidance([], { workspaceDir: TMP, task_id: 't_zero' })
  assert(zg && zg.next_candidates.length === 0 && zg.next_action?.template === true && (zg.next_action.required_args || []).length > 0, '8-A 无结构模块 → 显式模板 + required_args（得 ' + JSON.stringify(zg) + '）')
}

// ── 9-D（2026-10-07 专家 Lite 建议）：search_terms 角色分离——模型给概念词，六合做确定性检索 ──
{
  const tSt = await taskMod.handle({ workspace_dir: TMP, goal: '修复登录空密码漏洞', search_terms: ['EMPTY_CREDENTIAL'], request_id: 'req_search_terms' }, ctx)
  assert(tSt.ok === true && (tSt.observation?.candidates || []).some(c => c.file_path === 'src/auth.js'), '9-D search_terms 概念词驱动命中（得 ' + JSON.stringify((tSt.observation?.candidates || []).map(c => c.file_path + '::' + c.name)) + '）')
  assert((tSt.observation?.search_terms_used || []).includes('EMPTY_CREDENTIAL'), '9-D 回显 search_terms_used（得 ' + JSON.stringify(tSt.observation?.search_terms_used) + '）')
  const tStBad = await taskMod.handle({ workspace_dir: TMP, goal: 'x', search_terms: 'not-an-array', request_id: 'req_search_terms_bad' }, ctx)
  assert(tStBad.error === 'invalid_input', '9-D search_terms 非数组 → invalid_input（得 ' + tStBad.error + '）')
  const tStSan = await taskMod.handle({ workspace_dir: TMP, goal: 'x', search_terms: ['  ', 'ok_term', 42, 'ok_term'], request_id: 'req_search_terms_san' }, ctx)
  assert(tStSan.ok === true && (tStSan.observation?.search_terms_used || []).join(',') === 'ok_term', '9-D search_terms 去空/去重/丢非串（得 ' + JSON.stringify(tStSan.observation?.search_terms_used) + '）')
}

// ── 9-B（2026-10-07 专家报告）：人类提示必须与实际字段路径一致（next_action 为顶层字段，非 extra.next_action）──
{
  const toolsDir2 = join(__dirname, '..', 'tools')
  const offenders = []
  for (const d of readdirSync(toolsDir2)) {
    const p = join(toolsDir2, d, 'handler.js')
    if (!existsSync(p)) continue
    if (readFileSync(p, 'utf-8').includes('extra.next_action')) offenders.push(d)
  }
  assert(offenders.length === 0, '9-B handler 文案不再引用 extra.next_action（得 ' + JSON.stringify(offenders) + '）')
  assert(!(tNa.observation?.summary || '').includes('extra.next_action'), '9-B 零候选 summary 指向顶层 next_action（得 ' + tNa.observation?.summary + '）')
}

// ── 9-A（2026-10-07 专家 Lite 建议）：零候选导航——浏览入口排序 + 紧凑仓库地图 + 标注非命中 ──
{
  const modules9 = [
    { file: 'benchmarks/bench-extract.js', symbols: [{ name: '__dirname', kind: 'variable', line: 1 }, { name: 'runBench', kind: 'function', line: 2 }] },
    { file: 'tests/noise.test.js', symbols: [{ name: 'noiseTest', kind: 'function', line: 1 }] },
    { file: 'src/guard.js', symbols: [{ name: 'assertTaskWritable', kind: 'function', line: 3 }] },
    { file: 'docs/guide.md', symbols: [] },
    { file: 'index.js', symbols: [{ name: '__dirname', kind: 'variable', line: 1 }, { name: 'main', kind: 'function', line: 5 }] },
  ]
  const g9 = shared.buildZeroHitGuidance(modules9, { workspaceDir: TMP, task_id: 't9', entryFiles: ['index.js'] })
  assert(g9.next_candidates[0]?.file === 'index.js' && g9.next_candidates[0]?.kind === 'browse_entry' && /entry point/i.test(g9.next_candidates[0]?.why || ''), '9-A 入口点优先且标 browse_entry（得 ' + JSON.stringify(g9.next_candidates[0]) + '）')
  assert(g9.next_candidates[0]?.symbols?.[0]?.name === 'main', '9-A 首符号跳过 __dirname（得 ' + JSON.stringify(g9.next_candidates[0]?.symbols) + '）')
  assert(g9.next_candidates.some(c => c.file === 'src/guard.js'), '9-A 业务目录进入候选（得 ' + JSON.stringify(g9.next_candidates.map(c => c.file)) + '）')
  assert(!g9.next_candidates.some(c => /^(tests|benchmarks)\//.test(c.file)), '9-A 噪声目录不进前三（得 ' + JSON.stringify(g9.next_candidates.map(c => c.file)) + '）')
  assert(/search_terms/.test(g9.next_action.note || ''), '9-A note 指引 search_terms 缩小（得 ' + g9.next_action.note + '）')

  // 服务接线：stub 紧凑地图 → observation.navigation；异常/缺服务 → fail-soft
  const ctx9 = { ...ctx, repoMapService: { async generateCompact() { return { files: 5, tokens: 12, map: 'ws/\n  src/  (p1)\n\nsrc/\n  guard.js\n', skeleton: [{ name: 'src/', page: 1, detail: true }, { name: 'docs/', page: 1, detail: true }], truncated: false } } } }
  const t9h = await taskMod.handle({ workspace_dir: TMP, goal: '修复登录空密码漏洞', request_id: 'req_nav9' }, ctx9)
  assert(t9h.observation?.navigation?.kind === 'repo_map_compact' && /src\//.test(t9h.observation.navigation.map || ''), '9-A 零候选附紧凑仓库地图（得 ' + JSON.stringify(t9h.observation?.navigation) + '）')
  assert(/browse|NOT a query hit/i.test(t9h.observation?.navigation?.note || ''), '9-A 导航标注浏览入口非命中')
  assert((t9h.observation?.navigation?.map || '').length <= 8000, '9-A 地图受预算约束')
  const ctx9err = { ...ctx, repoMapService: { async generateCompact() { throw new Error('boom') } } }
  const t9err = await taskMod.handle({ workspace_dir: TMP, goal: '修复登录空密码漏洞', request_id: 'req_nav9_err' }, ctx9err)
  assert(t9err.ok === true && t9err.observation?.navigation == null, '9-A repoMap 异常 fail-soft 不阻断（得 ' + JSON.stringify(t9err.observation?.navigation) + '）')
  assert(tNa.observation?.navigation == null, '9-A 无服务时旧响应不变（fail-soft）')
}

// ── graph env 门 ──
const toolsDir = join(__dirname, '..', 'tools')
const prev = process.env.MALONG_INTERFACE
const prevState = process.env.MALONG_ENTRY_STATE
delete process.env.MALONG_INTERFACE
delete process.env.MALONG_ENTRY_STATE
// 0.5.24（breaking）：默认档 = 六和线（graph + 状态层）= 13 工具
const regDefault = new ToolRegistry(toolsDir, { log: () => {} })
const nDefault = await regDefault.loadAll()
assert(nDefault === 13, `默认 env 加载六和线 13 工具（实际 ${nDefault}）`)
assert(regDefault.hasTool('code_task') && regDefault.hasTool('code_read') && regDefault.hasTool('code_status') && regDefault.hasTool('code_query'), '默认 env 暴露四入口（六和线）')
assert(regDefault.hasTool('code_patch') && regDefault.hasTool('code_check'), '默认 env 暴露写/检工具（状态层默认开）')
assert(!regDefault.hasTool('edit_batch') && !regDefault.hasTool('read_symbol'), '默认 env 隐藏白名单外 classic 工具')

// 显式 classic → 44 全量（默认翻档后的回退路径必须可达）
process.env.MALONG_INTERFACE = 'classic'
const regClassic = new ToolRegistry(toolsDir, { log: () => {} })
const nClassic = await regClassic.loadAll()
assert(nClassic === 44, `MALONG_INTERFACE=classic 加载 44 常驻工具（实际 ${nClassic}）`)
assert(regClassic.hasTool('read_symbol') && regClassic.hasTool('edit_batch'), 'classic 档暴露 classic 直调工具')

process.env.MALONG_INTERFACE = 'graph'
process.env.MALONG_ENTRY_STATE = '0'
const regGraph = new ToolRegistry(toolsDir, { log: () => {} })
const nGraph = await regGraph.loadAll()
assert(nGraph === 5, `graph + MALONG_ENTRY_STATE=0 加载 5 工具（四入口 + edit_transaction；实际 ${nGraph}）`)
assert(regGraph.hasTool('code_task') && regGraph.hasTool('code_read') && regGraph.hasTool('code_status') && regGraph.hasTool('code_query'), 'graph 档加载四入口（含 code_query）')
assert(regGraph.hasTool('edit_transaction'), 'graph 恢复入口 edit_transaction 可见')
assert(!regGraph.hasTool('code_patch') && !regGraph.hasTool('code_check'), 'state=0 不暴露写工具')
assert(!regGraph.hasTool('edit_batch') && !regGraph.hasTool('read_symbol'), 'LH-007：白名单外 classic 工具在 graph 隐藏')
assert(typeof regGraph.getHiddenReason === 'function' && regGraph.getHiddenReason('edit_batch'), '隐藏工具带 gate 原因')
if (prev === undefined) delete process.env.MALONG_INTERFACE; else process.env.MALONG_INTERFACE = prev
if (prevState === undefined) delete process.env.MALONG_ENTRY_STATE; else process.env.MALONG_ENTRY_STATE = prevState

// —— 描述文案回归（S5 采纳实验发现）——
// 真阳性：旧文案结尾写「Read-only (S1): no edits, no checks.」。字面对 code_task 本身成立，
// 但 (S1) 是阶段标签，而 stateful 臂同一目录就摆着 code_patch(写)/code_check(检)，
// 且这句紧跟在旧版「MUST call first」之后 → 模型会把整条入口误读为「不负责写/检」。
// 14-B WP07：强制声明改中性入口语义（「任何代码问题必须先调」被实测判为过度强制，阴性对照被误用）。
// 断言：不得再出现陈旧阶段标签；必须指出自身只做解析与规划，并指明写/检的后继工具。
{
  const desc = JSON.parse(readFileSync(join(toolsDir, 'tool-code-task', 'manifest.json'), 'utf-8')).description || ''
  assert(!/\(S1\)|\(S2\)|只读入口/.test(desc), `code_task 描述不得含陈旧阶段标签（实际：${desc.slice(-60)}）`)
  assert(!/no edits, no checks/.test(desc), 'code_task 描述不得再用「no edits, no checks」（易被读成整条路径不写不检）')
  assert(/does not itself edit or check/i.test(desc), 'code_task 描述应明确「自身不写不检」而非含糊')
  assert(/code_patch/.test(desc) && /code_check/.test(desc), 'code_task 描述应指明写/检的后继工具（降摩擦）')
  assert(!/MUST call first/i.test(desc), '14-B WP07 描述不再强制 MUST call first（得 ' + desc.slice(0, 60) + '）')
  assert(/start here/i.test(desc) && /structure/.test(desc) && /impact/.test(desc), '14-B WP07 保留入口能力语义（structure/impact；得 ' + desc.slice(0, 80) + '）')
}

// ── WP08R-3 A4：候选截断透明（12 命中 → 首屏 8，但 total/truncated/summary 明示）──
{
  const tBulk = await taskMod.handle({ workspace_dir: TMP, goal: 'bulkWidget update', target: { symbol: 'bulkWidget' } }, ctx)
  assert(tBulk.ok === true && (tBulk.observation?.candidates || []).length === 8, `A4 首屏 8 条（得 ${(tBulk.observation?.candidates || []).length}）`)
  assert(tBulk.observation?.candidates_total >= 12 && tBulk.observation?.candidates_truncated === true, `A4 截断透明（得 total=${tBulk.observation?.candidates_total}, truncated=${tBulk.observation?.candidates_truncated}）`)
  assert(/Showing top 8 of \d+ candidate/.test(tBulk.observation?.summary || ''), `A4 summary 明示截断（得 ${tBulk.observation?.summary}）`)
  const tFew = await taskMod.handle({ workspace_dir: TMP, goal: 'which admin login handles empty password', target: { symbol: 'login' } }, ctx)
  assert(!tFew.observation?.candidates_truncated && tFew.observation?.candidates_total === undefined, 'A4 未截断时不加噪声字段（得 ' + JSON.stringify({ total: tFew.observation?.candidates_total, truncated: tFew.observation?.candidates_truncated }) + '）')
}

console.log(`\n=== test-s1-entry: ${pass} passed, ${fail} failed ===`)
process.exit(fail > 0 ? 1 : 0)