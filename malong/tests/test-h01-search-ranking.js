// test-h01-search-ranking.js — H01（0.5.14）轻量搜索排序改进
// 005 现场：英文自然语言描述（重复请求/进程崩溃/找测试）入口，首位是 Rust 测试夹具 Command——
// 仅因 after/Command 这类通用词命中夹具，目标实现未入首屏。
// 本测试锁定：① 多词查询过滤停用词（after/how/the 不再当强锚点）；② 无测试意图时测试/夹具路径降权
// （同分下生产路径在前）；③ 用户明确找测试时不降权；④ 无强匹配明确低置信 + 建议补锚点（不强造答案）。
// 有限改进（确定性规则），不宣传为通用语义检索。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  FAIL:', msg) } }

const calls = []
const fakeIndex = {
  getStats() { return { files: 42 } },
  async searchSymbols(tok) {
    calls.push(tok)
    if (tok === 'after') return [{ name: 'Command', type: 'struct', file: 'vendor/rust/tests/fixture_after.rs', start_line: 1 }]
    if (tok === 'process') return [{ name: 'Command', type: 'struct', file: 'vendor/rust/tests/fixture_command.rs', start_line: 1 }]
    if (tok === 'repeated' || tok === 'requests') return [{ name: 'repeatedRequests', type: 'function', file: 'tests/test-invoke-outlet-crash.js', start_line: 1 }]
    if (tok === 'crash') return [{ name: 'crashWindow', type: 'function', file: 'tools/outlet-ledger.js', start_line: 3 }]
    if (tok === 'guard') return [{ name: 'guard', type: 'function', file: 'tools/guard.js', start_line: 1 }, { name: 'guard', type: 'function', file: 'tests/guard.test.js', start_line: 1 }]
    return []
  },
}
const core = { services: { codeIndex: fakeIndex }, log() {}, registerService(name, api) { this.services[name] = api } }
const mod = await import(pathToFileURL(join(__dirname, '..', 'code-search.js')).href)
await mod.init(core)
const svc = core.services.codeSearch

// ── ① 停用词过滤：多词查询里的 after/how/the/find 不再被检索 ──
{
  calls.length = 0
  const r = await svc.search('find the tests for repeated requests after how process crash')
  assert(!calls.includes('after') && !calls.includes('how') && !calls.includes('the') && !calls.includes('find'), '① 停用词不进入检索（得 ' + JSON.stringify(calls) + '）')
  assert(calls.includes('repeated') || calls.includes('requests'), '① 有意义 token 仍检索（得 ' + JSON.stringify(calls) + '）')
  assert(!!r.confidence, '① 带 confidence 声明（得 ' + r.confidence + '）')
}

// ── ② 005 重放：夹具 Command 不在首位；after-only 命中的夹具不再混入 ──
{
  const r = await svc.search('find tests for repeated requests after process crashes')
  const first = r.results[0]
  assert(!!first && first.file === 'tests/test-invoke-outlet-crash.js', '005: 首位是目标实现/测试（得 ' + JSON.stringify(first) + '）')
  assert(!r.results.some(x => x.file === 'vendor/rust/tests/fixture_after.rs'), '005: after 被停用词过滤后不再靠通用词命中夹具')
  assert(!r.results[0] || r.results[0].name !== 'Command', '005: 夹具 Command 不再占首位')
}

// ── ③ 无测试意图 → 测试路径降权（同分下生产在前，且带 rank_reason）──
{
  const r = await svc.search('repeated requests guard')
  const tools = r.results.find(x => x.file === 'tools/guard.js')
  const tests = r.results.find(x => x.file === 'tests/guard.test.js')
  assert(!!tools && !!tests, '③ 两处同分命中都在结果里（得 ' + JSON.stringify(r.results) + '）')
  assert(tools && tests && r.results.indexOf(tools) < r.results.indexOf(tests), '③ 无测试意图时测试路径降权（生产在前）')
  assert(tests && tests.rank_reason && /downranked/.test(tests.rank_reason), '③ 降权带 rank_reason（得 ' + JSON.stringify(tests?.rank_reason) + '）')
}

// ── ④ F3（0.5.14 Windows 复核）：明确测试意图不再「整体豁免」降权——测试候选仍可见，但排在生产之后 ──
// （与 test-f3-candidate-ranking 同语义：一个 tests 词不得把无关夹具抬到实现之前；测试仍不被隐藏）
{
  const r = await svc.search('find tests for guard')
  const t = r.results.find(x => x.file === 'tests/guard.test.js')
  assert(!!t, '④ 明确找测试时测试文件仍在结果里（得 ' + JSON.stringify(r.results) + '）')
  assert(t && /explicit test intent/.test(String(t.rank_reason || '')), '④ 测试候选保留并标原因（不再整体豁免降权）（得 ' + JSON.stringify(t?.rank_reason) + '）')
  const prod = r.results.find(x => x.file === 'tools/guard.js')
  assert(!!prod && r.results.indexOf(prod) < r.results.indexOf(t), '④ 生产候选仍排在测试候选之前（F3：不因 tests 词把夹具抬前）')
}

// ── ⑤ 无强匹配 → 低置信 + 建议补锚点；弱命中不伪造强结论 ──
{
  const r = await svc.search('mysterious zzzz yyyy')
  assert(r.confidence === 'none' && /Low-confidence/.test(r.note || ''), '⑤ 无候选 → none + 说明（得 ' + JSON.stringify({ c: r.confidence, n: r.note }) + '）')
  const r2 = await svc.search('process it')
  assert(r2.confidence === 'low' && /exact identifier|anchors/.test(r2.note || ''), '⑤ 弱命中 → low + 建议补锚点（得 ' + JSON.stringify({ c: r2.confidence, n: r2.note }) + '）')
}

console.log('\n=== test-h01-search-ranking: ' + pass + ' passed, ' + fail + ' failed ===')
process.exit(fail > 0 ? 1 : 0)
