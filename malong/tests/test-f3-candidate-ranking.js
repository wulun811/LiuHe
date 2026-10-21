// test-f3-candidate-ranking.js — F3（0.5.14 Windows 复核）/ P2：排序与低置信要接到真实入口
// 专家现场：005 原句（重复请求/进程崩溃/找测试）在 code_task 首位推荐 `malong-parse/tests/fixtures/pattern_matching.rs::Command`，
// after 的局部变量入前几项；035 code_query(search) 也把 Command 排首位（0.9）。原 test-h01-search-ranking 13/0
// 只测了 code-search 纯函数，没接真实 code_task.findCandidates 与查询路径。
// 本测试锁定：① 描述词/虚词不再当锚点（多词过滤、≤2 词原样、反引号标识符保留）；
// ② 生产实现候选排在测试/夹具/噪声之前（旧实现只挪噪声）；③ 测试候选仍可见（不隐藏）；
// ④ 显式测试文件目标仍直达（不把测试整体隐藏）；⑤ 低置信明确声明且不把夹具推成「下一步」；⑥ code-search fuse 同口径。
import { join, dirname } from 'node:path'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  FAIL: ' + msg) } }
const brief = (v) => JSON.stringify(v ?? null).slice(0, 260)
const imp = (p) => import(pathToFileURL(p).href)

const TMP = join(os.tmpdir(), 'opencode', 'f3-candidate-ranking')
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
mkdirSync(join(TMP, 'tools'), { recursive: true })
process.env.MALONG_STATE_DIR = join(TMP, 'state')
const WS = TMP

const shared = await imp(join(__dirname, '..', 'tools', 'entry-shared.js'))
const taskMod = await imp(join(__dirname, '..', 'tools', 'tool-code-task', 'handler.js'))
const searchMod = await imp(join(__dirname, '..', 'code-search.js'))

const GOAL_005 = 'Explain how repeated command requests avoid executing twice after a process crashes, and locate the tests.'
const FIXTURE = 'malong-parse/tests/fixtures/pattern_matching.rs'
const PROD = 'tools/outlet-ledger.js'
const TESTFILE = 'tests/test-invoke-outlet-crash.js'

// ── ① extractTokens：虚词过滤语义（多词才过滤 / ≤2 词原样 / 反引号保留）──
{
  const t1 = shared.extractTokens(GOAL_005)
  assert(!t1.includes('after') && !t1.includes('how') && !t1.includes('and') && !t1.includes('locate'), '① 多词目标：虚词不进 token（得 ' + JSON.stringify(t1) + '）')
  assert(t1.includes('command') && t1.includes('repeated') && t1.includes('requests'), '① 有意义词仍保留（得 ' + JSON.stringify(t1) + '）')
  const t2 = shared.extractTokens('after how')
  assert(t2.length === 2 && t2.includes('after'), '① ≤2 词目标原样保留（得 ' + JSON.stringify(t2) + '）')
  const t3 = shared.extractTokens('please explain `outletClaim` behaviour before editing')
  assert(t3.includes('outletClaim'), '① 反引号标识符始终保留（得 ' + JSON.stringify(t3) + '）')
  assert(!t3.includes('explain') && !t3.includes('before'), '① 反引号目标的虚词也过滤（得 ' + JSON.stringify(t3) + '）')
}

// ── mock 索引：夹具里的 Command + 生产实现 + 真实测试文件 ──
const SYMS = {
  [FIXTURE]: [{ name: 'Command', type: 'class', start_line: 3, end_line: 9, stable_id: 'rs:pm::Command#class' }],
  [PROD]: [
    { name: 'crashWindow', type: 'function', start_line: 3, end_line: 9, stable_id: 'js:ledger::crashWindow#function' },
    { name: 'outletClaim', type: 'function', start_line: 94, end_line: 119, stable_id: 'js:ledger::outletClaim#function' },
  ],
  [TESTFILE]: [{ name: 'repeatedRequestsProbe', type: 'function', start_line: 1, end_line: 9, stable_id: 'js:crash::repeat#function' }],
}
const FILES = Object.keys(SYMS)
function defsFor(tok) {
  const low = String(tok).toLowerCase()
  const out = []
  for (const [path, syms] of Object.entries(SYMS)) {
    for (const s of syms) {
      const n = s.name.toLowerCase()
      if (n === low || (low.length >= 4 && n.includes(low))) out.push({ name: s.name, file: path, path, type: s.type, start_line: s.start_line, end_line: s.end_line })
    }
  }
  // 模拟真实索引的词干/前缀检索：crashes → crashWindow
  if ((low === 'crashes' || low === 'crash') && !out.some(x => x.name === 'crashWindow')) out.push({ name: 'crashWindow', file: PROD, path: PROD, type: 'function', start_line: 3, end_line: 9 })
  return out
}
function mockIndex() {
  return {
    async initWorkspace() {},
    async indexBatch() { return [] },
    markIndexDirty() {},
    async findDefinitions(tok) { return defsFor(tok) },
    async searchSymbols(tok) { return defsFor(tok) },
    findSymbolsInFile(file, name) { return (SYMS[file] || []).filter(s => s.name === name) },
    async getFileOutline(file) { return { outline: (SYMS[file] || []).map(s => ({ name: s.name, type: s.type, line: s.start_line, end_line: s.end_line })) } },
    async getSymbolsAtLine() { return [] },
    getSymbolByStableId() { return null },
    getFileByPath(f) { return { path: f, index_state: 'fresh' } },
  }
}
const svc = mockIndex()

// ── ② findCandidates：生产实现首位，夹具不在首位（旧实现夹具 360 分压过生产 20 分）──
{
  const meta = {}
  const c = await shared.findCandidates(svc, WS, GOAL_005, null, { files: FILES, scan_meta: meta })
  assert(c.length > 0, '② 有候选（得 ' + c.length + '）')
  assert(c[0].file_path === PROD, '② 首位是生产实现（旧：夹具 Command 首位；得 ' + brief(c[0]) + '）')
  const fxIdx = c.findIndex(x => x.file_path === FIXTURE)
  assert(fxIdx === -1 || fxIdx > 0, '② 夹具不在首位（idx=' + fxIdx + '）')
  assert(c.some(x => x.file_path === TESTFILE), '② 相关测试候选仍可见（不隐藏）')
  assert(meta.confidence && meta.confidence.best_production && meta.confidence.best_production.file === PROD, '② 置信度给出最佳生产候选（得 ' + brief(meta.confidence) + '）')
  assert(meta.confidence.test_intent === true, '② 目标含测试意图被识别（得 ' + brief(meta.confidence?.test_intent) + '）')
  assert(!meta.tokens.includes('after') && !meta.tokens.includes('how'), '② 真实入口 token 已过滤虚词（得 ' + JSON.stringify(meta.tokens) + '）')
}

// ── ③ 明确测试夹具目标：测试候选仍直达（不把测试整体隐藏）──
{
  const c = await shared.findCandidates(svc, WS, GOAL_005, { file: TESTFILE }, { files: FILES })
  assert(c[0] && c[0].file_path === TESTFILE, '③ 显式测试文件目标直达（得 ' + brief(c[0]) + '）')
  const c2 = await shared.findCandidates(svc, WS, 'rename Command struct', { file: FIXTURE }, { files: FILES })
  assert(c2[0] && c2[0].file_path === FIXTURE, '③ 显式夹具文件目标直达（得 ' + brief(c2[0]) + '）')
}

// ── ④ 低置信：只有夹具/噪声命中 → 明确声明（不把夹具当可信目标）──
{
  const meta = {}
  const c = await shared.findCandidates(svc, WS, 'mysterious qq command', null, { files: FILES, scan_meta: meta })
  assert(c[0] && c[0].file_path === FIXTURE, '④ 只有夹具命中时它仍在候选里（可见，得 ' + brief(c[0]) + '）')
  assert(meta.confidence?.level === 'low', '④ 低置信显式声明（得 ' + brief(meta.confidence) + '）')
  assert(/Low confidence/i.test(String(meta.confidence?.note || '')), '④ 低置信带说明（得 ' + brief(meta.confidence?.note) + '）')
  assert(meta.confidence?.best_production === null || meta.confidence?.best_production?.score < 100, '④ 无强生产候选时 best_production 不冒充强匹配')
}

// ── ⑤ code_task 出口：低置信不把夹具推成下一步，且测试候选仍列出 ──
{
  const r = await taskMod.handle({ workspace_dir: WS, goal: GOAL_005 }, { codeIndexService: svc })
  assert(r.ok === true, '⑤ code_task 成功（得 ' + brief(r.error) + '）')
  const obs = r.observation || {}
  assert(!!obs.candidates_confidence, '⑤ 出口透出 candidates_confidence（得 ' + brief(obs.candidates_confidence) + '）')
  assert(Array.isArray(obs.test_path_candidates) && obs.test_path_candidates.some(x => /tests\/|fixtures\//.test(x.file_path)), '⑤ 测试/夹具候选显式列出（得 ' + brief(obs.test_path_candidates) + '）')
  const na = r.next_action
  assert(!!na, '⑤ 有下一步（得 ' + brief(na) + '）')
  const naFile = na?.args?.locator?.file_path || na?.args?.file || null
  assert(naFile !== FIXTURE, '⑤ 下一步不得指向无关夹具（得 ' + brief(na) + '）')
  if (obs.candidates_confidence === 'low') assert(/LOW-CONFIDENCE/.test(String(obs.candidates_note || '')) || na.tool === 'code_query', '⑤ 低置信时给明确说明或退化为检索（得 ' + brief({ n: obs.candidates_note, t: na?.tool }) + '）')
}

// ── ⑥ code-search fuse：测试意图下夹具分数更高也排在生产之后（tier），且仍可见 ──
{
  const fake = {
    getStats() { return { files: 9 } },
    async searchSymbols(tok) {
      if (tok === 'Command') return [{ name: 'Command', type: 'struct', file: 'pkg/tests/fixtures/x.rs', start_line: 1 }]
      if (tok === 'ledger') return [{ name: 'outletLedger', type: 'function', file: 'tools/outlet-ledger.js', start_line: 94 }]
      return []
    },
    async getCallers() { return [] },
    async getCallees() { return [] },
  }
  const core = { services: { codeIndex: fake }, log() {}, registerService(name, api) { this.services[name] = api } }
  await searchMod.init(core)
  const svcSearch = core.services.codeSearch
  // 测试意图：夹具精确名命中（0.9×0.8=0.72）> 生产弱命中（0.65）——不做 tier 时夹具会排首位
  const r = await svcSearch.search('find tests for `Command` ledger')
  assert(r.results.some(x => /pattern|x\.rs/.test(x.file || '')), '⑥ 夹具命中仍在结果里（可见，得 ' + brief(r.results) + '）')
  assert(r.results[0] && r.results[0].file === 'tools/outlet-ledger.js', '⑥ 测试意图下生产候选仍排首位（tier；得 ' + brief(r.results[0]) + '）')
  const fixture = r.results.find(x => /x\.rs/.test(x.file || ''))
  assert(fixture && /explicit test intent/.test(String(fixture.rank_reason || '')), '⑥ 夹具候选保留并标原因（得 ' + brief(fixture) + '）')
}

console.log('\n=== test-f3-candidate-ranking: ' + pass + ' passed, ' + fail + ' failed ===')
process.exit(fail > 0 ? 1 : 0)
