// test-rank-evidence.js — R16（真机试用 F2）：候选排序的「证据层」+ 零命中兜底取样
// 覆盖三个实测缺陷（都是真机跑出来的，不是猜的）：
//  1) 零证据的模糊召回（score=0）靠路径档位压过有路径证据的候选
//     实测：goal「把 DSH 的启动流程理顺」把 malong-parse/src/server.rs 的握手测试排到 dsh-bridge 前面
//  2) 3 字符 token（DSH/API/CSV）拿不到路径证据（matchScore 的 >=4 门槛）
//  3) 零命中兜底的候选池是字母序前 20 个文件（本仓 13/20 属 integration/liuhe-lite）
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  FAIL:', msg) } }
const imp = (p) => import(pathToFileURL(p).href)

const TMP = join(os.tmpdir(), 'opencode', 'rank-evidence')
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
process.env.MALONG_STATE_DIR = join(TMP, 'state')

const files = {
  'malong/package.json': JSON.stringify({ name: 'malong', bin: { malong: 'mcp-server.js' } }, null, 2),
  'malong/mcp-server.js': 'export function handleRequest(req) { return req }\n',
  'malong/dsh/dsh-bridge.mjs': 'export function bridgeVersion() { return 1 }\n',
  'malong/dsh/bundle/dsh-bridge.mjs': 'export function bridgeVersion() { return 1 }\n',
  'malong-parse/src/server.rs': 'pub async fn hello() {}\n',
  'benchmarks/dsh-bench.js': 'export function benchRun() {}\n',
  'integration/liuhe-lite/cell-adapter.mjs': 'export function cellHandling() {}\n',
  'docs/guide.md': '# guide\n',
  'tests/noise.test.js': 'export function noiseTest() {}\n',
  'src/csv/export.js': 'export function buildReport(rows) { return rows.length }\n',
}
for (const [rel, body] of Object.entries(files)) {
  mkdirSync(dirname(join(TMP, rel)), { recursive: true })
  writeFileSync(join(TMP, rel), body)
}

const symbols = {
  'malong/mcp-server.js': [{ name: 'handleRequest', type: 'function', start_line: 1, end_line: 1 }],
  'malong/dsh/dsh-bridge.mjs': [{ name: 'bridgeVersion', type: 'function', start_line: 1, end_line: 1 }],
  'malong/dsh/bundle/dsh-bridge.mjs': [{ name: 'bridgeVersion', type: 'function', start_line: 1, end_line: 1 }],
  'malong-parse/src/server.rs': [
    { name: 'hello_handshake_accepts_correct_token_then_serves', type: 'function', start_line: 1267, end_line: 1286 },
    { name: 'hello_handshake_rejects_bad_token', type: 'function', start_line: 1251, end_line: 1264 },
  ],
  'benchmarks/dsh-bench.js': [{ name: 'benchRun', type: 'function', start_line: 1, end_line: 1 }],
  'integration/liuhe-lite/cell-adapter.mjs': [{ name: 'cellHandling', type: 'function', start_line: 1, end_line: 1 }],
  'src/csv/export.js': [{ name: 'buildReport', type: 'function', start_line: 1, end_line: 1 }],
  'tests/noise.test.js': [{ name: 'noiseTest', type: 'function', start_line: 1, end_line: 1 }],
}
const mockIndex = () => ({
  async initWorkspace() {},
  async indexBatch(list) { return (Array.isArray(list) && list.length ? list : Object.keys(files)) },
  async findDefinitions() { return [] },
  // 模拟真实索引的模糊召回：无论查什么，都把两个与 DSH 无关的 Rust 测试函数捞回来（对 DSH 的 matchScore=0）
  async searchSymbols() { return symbols['malong-parse/src/server.rs'].map(s => ({ ...s, file: 'malong-parse/src/server.rs' })) },
  findSymbolsInFile(file, name) { return (symbols[file] || []).filter(s => s.name === name) },
  async getFileOutline(file) { return { outline: (symbols[file] || []).map(s => ({ name: s.name, type: s.type, line: s.start_line, end_line: s.end_line })) } },
  async getSymbolsAtLine(file, line) { return (symbols[file] || []).filter(s => s.start_line <= line && line <= s.end_line) },
  getSymbolByStableId() { return null },
  getFileByPath(file) { return { path: file, index_state: 'fresh' } },
})
const ctx = { codeIndexService: mockIndex(), getWorkspaceDir: (w) => w }
const shared = await imp(join(__dirname, '..', 'tools', 'entry-shared.js'))
const taskMod = await imp(join(__dirname, '..', 'tools', 'tool-code-task', 'handler.js'))
const orient = await imp(join(__dirname, '..', 'workflow', 'orient.js'))

// ── T1：零证据的模糊召回不得压过有路径证据的候选 ──
{
  const r = await taskMod.handle({ workspace_dir: TMP, goal: '把 DSH 的启动流程理顺' }, ctx)
  const cs = r.observation?.candidates || []
  assert(cs.length >= 2, 'T1 候选非空（得 ' + cs.length + '）')
  assert(/\/dsh\//.test(cs[0]?.file_path || ''), 'T1 首位必须是有路径证据的 dsh 候选（得 ' + JSON.stringify({ f: cs[0]?.file_path, why: cs[0]?.rank_reason }) + '）')
  const rust = cs.filter(c => c.file_path === 'malong-parse/src/server.rs')
  assert(rust.length >= 1, 'T1 模糊召回的 Rust 行仍要列出（零证据不等于隐藏；得 ' + JSON.stringify(cs.map(c => c.file_path)) + '）')
  assert(rust.every(c => c.rank_reason === 'no_token_match'), 'T1 零证据行必须自报 no_token_match，不许借 fuzzy（得 ' + JSON.stringify(rust.map(c => c.rank_reason)) + '）')
  const idxEvidence = cs.findIndex(c => c.rank_reason !== 'no_token_match')
  const idxNoMatch = cs.findIndex(c => c.rank_reason === 'no_token_match')
  assert(idxEvidence >= 0 && (idxNoMatch === -1 || idxEvidence < idxNoMatch), 'T1 有证据行必须排在零证据行之前（得 evidence=' + idxEvidence + ', no_match=' + idxNoMatch + '）')
  assert(r.next_action?.args?.locator?.file_path !== 'malong-parse/src/server.rs', 'T1 next_action 不得指向零证据的 Rust 行（得 ' + JSON.stringify(r.next_action?.args?.locator) + '）')
  const bundle = cs.find(c => c.file_path === 'malong/dsh/bundle/dsh-bridge.mjs')
  assert(bundle && /generated_bundle/.test(bundle.rank_reason || ''), 'T1 构建副本目录标 generated_bundle，不谎报 benchmark（得 ' + JSON.stringify(bundle?.rank_reason) + '）')
  assert(!cs.some(c => /benchmark_path/.test(c.rank_reason || '') && /\/bundle\//.test(c.file_path || '')), 'T1 bundle 路径不得被标成 benchmark_path')
  const bench = cs.find(c => c.file_path === 'benchmarks/dsh-bench.js')
  assert(bench && /benchmark_path/.test(bench.rank_reason || ''), 'T1 真基准目录仍标 benchmark_path（得 ' + JSON.stringify(bench?.rank_reason) + '）')
}

// ── T2：3 字符 token 也必须拿到命中证据（旧实现 matchScore 的 >=4 门槛把它丢了）──
{
  const r = await taskMod.handle({ workspace_dir: TMP, goal: 'CSV 导出编码修好' }, ctx)
  const csv = (r.observation?.candidates || []).find(c => c.file_path === 'src/csv/export.js')
  assert(!!csv, 'T2 短 token 必须能命中（得 ' + JSON.stringify((r.observation?.candidates || []).map(c => c.file_path)) + '）')
  assert(csv && csv.rank_reason === 'path_hit', 'T2 只靠路径命中的短 token 必须标 path_hit（得 ' + JSON.stringify(csv?.rank_reason) + '）')
  assert((csv?.matched_terms || []).includes('CSV'), 'T2 matched_terms 要写清命中了哪个 token（得 ' + JSON.stringify(csv?.matched_terms) + '）')
}

// ── T3：零命中兜底不再拿字母序前 20 个文件充结构 ──
{
  const r = await taskMod.handle({ workspace_dir: TMP, goal: '看看这个文件里面都有什么' }, ctx)
  const sp = r.observation?.structure_sampling
  assert(sp && sp.strategy === 'breadth_by_top_dir', 'T3 零命中必须附取样元信息（得 ' + JSON.stringify(sp?.strategy) + '）')
  const structFiles = (r.observation?.structure || []).map(m => m.file)
  assert(structFiles.some(f => f.startsWith('malong/')), 'T3 结构样本必须覆盖主仓目录（得 ' + JSON.stringify(structFiles) + '）')
  const dirs = new Set(structFiles.map(f => f.split('/')[0]))
  assert(dirs.size >= 3, 'T3 结构样本必须跨 >=3 个顶层目录（得 ' + JSON.stringify([...dirs]) + '）')
  assert(sp.files_considered >= 8 && sp.sampled >= 3, 'T3 取样元信息要写清考虑多少/取多少（得 ' + JSON.stringify({ c: sp.files_considered, s: sp.sampled }) + '）')
}

// ── T3b：取样的边界（入口优先 / 上限 / 非主体目录先跳过并报出）──
{
  const all = Object.keys(files)
  const { files: picked, sampling } = shared.selectBrowseSample(all, { limit: 3, entryFiles: ['malong/mcp-server.js'] })
  assert(picked.length === 3, 'T3b 取样上限生效（得 ' + picked.length + '）')
  assert(picked[0] === 'malong/mcp-server.js', 'T3b 入口文件排第一（得 ' + JSON.stringify(picked) + '）')
  assert(sampling.modules[0]?.priority === 'entry_point' && sampling.modules[0]?.has_entry_point === true, 'T3b 入口组标 entry_point（得 ' + JSON.stringify(sampling.modules[0]) + '）')
  assert(!picked.some(f => f.startsWith('integration/')), 'T3b 主体铺满时非主体目录不进样（得 ' + JSON.stringify(picked) + '）')
  assert((sampling.skipped_dirs || []).some(d => d.dir === 'integration'), 'T3b 跳过了什么必须写出来（得 ' + JSON.stringify(sampling.skipped_dirs) + '）')
  // 主体不够铺满 → 回填非主体，并显式标注
  const small = shared.selectBrowseSample(['integration/a/x.js', 'examples/b/y.js'], { limit: 4 })
  assert(small.files.length === 2 && small.sampling.fell_back_to_non_primary === true, 'T3b 主体不够时回填非主体并标注（得 ' + JSON.stringify(small.sampling) + '）')
}

// ── T4：子包入口（根没有 package.json 时旧实现恒为空）──
{
  const ep = orient.detectEntryPoints(TMP)
  assert(ep.files.includes('malong/mcp-server.js'), 'T4 子包 bin 必须被识别为入口（得 ' + JSON.stringify(ep.files) + '）')
  assert((ep.from_subpackages || []).includes('malong/mcp-server.js'), 'T4 入口来源要写清 from_subpackages（得 ' + JSON.stringify(ep.from_subpackages) + '）')
  assert(ep.conventional.length === 0, 'T4 根无 package.json 时 conventional 仍为空（得 ' + JSON.stringify(ep.conventional) + '）')
}

// ── T5：全零证据时 next_action 改用 code_query 细化，不指无关文件 ──
{
  const r = await taskMod.handle({ workspace_dir: TMP, goal: '把 XYZQW 理顺' }, ctx)
  const cs = r.observation?.candidates || []
  assert(cs.length >= 1 && cs.every(c => c.rank_reason === 'no_token_match'), 'T5 前置：全部候选零证据（得 ' + JSON.stringify(cs.map(c => c.rank_reason)) + '）')
  assert(r.next_action?.tool === 'code_query', 'T5 全零证据 → next_action 用 code_query 细化（得 ' + JSON.stringify(r.next_action?.tool) + '）')
  assert(r.observation?.candidates_confidence === 'low', 'T5 置信度必须 low（得 ' + JSON.stringify(r.observation?.candidates_confidence) + '）')
  assert(r.observation?.structure_sampling == null, 'T5 有候选时不附取样元信息（避免噪声）')
}

console.log(`\n=== test-rank-evidence: ${pass} passed, ${fail} failed ===`)
process.exit(fail > 0 ? 1 : 0)
