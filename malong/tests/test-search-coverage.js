// test-search-coverage.js — F2-L0：搜索结果必须暴露「命中了几个查询词」
//
// 来源：2026-10-29 我自己当用户试用时发现的缺陷（见 review/semantic-perception-v1/05-G2C-SELF-TRIAL.md §3.1）。
//
// 现象：查询「谁把多个文件的锁收进数组 locks.push 同时持有多把 .mlock」
//   → 返回 _repoLocks / _manifestLocks 等，score=0.65，但**没有 matched 字段**。
//   我无法知道它只命中 5 个查询词里的 1 个，于是把裸分当成「相似度不高」。
//
// 真实缺陷不是「没有语义能力」（纯中文查询它会老实返回 0 条），而是：
//   **部分命中被当作答案呈现，且不说命中了哪个词。**
//   0.5 分噪声能骗人，是因为它和真实命中同表、同字段名。
//
// 修法（L0，确定性、零依赖）：
//   ① 每条结果带 matched（命中了哪些查询词）+ coverage（命中/可检索词数）+ match_kind
//   ② coverage 低于阈值的不进 results 主表，放 partial_matches，并说明是部分命中
//   ③ 意图类结果（caller/callee/deadCode...）不是 token 命中，豁免降级
//   ④ mode=search 的 boundaries.note 不得与 matching_note 自相矛盾
//   ⑤ matching_note 必须写明 matched/coverage 的读法（否则 LLM 还是不知道怎么读）
//
// 先红后绿：实现前 ①-⑤ 全红。
import { join, dirname } from 'node:path'
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  FAIL:', msg) } }

const WS = join(os.tmpdir(), 'opencode', 'f2-l0-ws')
const SOCK = join(os.tmpdir(), 'opencode', 'f2-l0.sock')
try { rmSync(WS, { recursive: true, force: true }) } catch {}
mkdirSync(join(WS, 'src'), { recursive: true })
writeFileSync(join(WS, 'src/locks.js'), [
  '// 锁登记表：同时持有多把 .mlock 的写入者会在这里登记',
  'const _repoLocks = new Map()',
  'export function acquire() { return _repoLocks }',
].join('\n') + '\n')
writeFileSync(join(WS, 'src/hot.js'), [
  'export function hot() { return 1 }',
  'export function c1() { hot() }',
  'export function c2() { hot() }',
].join('\n') + '\n')

const pc = await import(pathToFileURL(join(__dirname, '..', 'parse-client.js')).href)
await pc.init({ log: () => {} })
try { await pc.connect() } catch {}
const { default: codeIndex } = await import(pathToFileURL(join(__dirname, '..', 'code-index.js')).href)
const langParser = {
  extractAllAsync: (s, e, f, ws) => pc.extractAll(s, e, f, ws),
  hasErrorsAsync: (s, e, f, ws) => pc.hasErrors(s, e, f, ws),
  batchExtractAsync: (f, ws) => pc.batchExtract(f, ws),
}
const services = { langParser }
const core = {
  services,
  getService: (n) => services[n],
  registerService: (n, svc) => { services[n] = svc },
  getWorkspaceDir: () => WS,
  log: () => {},
  emit: () => {},
  get: (k, def) => k === 'codeIndex.udsPath' ? SOCK : def,
}
await codeIndex.init(core)
const svc = services.codeIndex
await svc.initWorkspace(WS)
// ⑦⑧ 夹具：生成副本（与源码同名符号）+ 三类文档（单滑窗 / 多滑窗 / 整串）
mkdirSync(join(WS, 'dsh/bundle/server/src'), { recursive: true })
writeFileSync(join(WS, 'dsh/bundle/server/src/hot.js'), [
  'export function hot() { return 1 }',
  'export function c1() { hot() }',
  'export function c2() { hot() }',
].join('\n') + '\n')
mkdirSync(join(WS, 'docs'), { recursive: true })
writeFileSync(join(WS, 'docs/noise.md'), '# 噪声\n这里只有“文件被”这个片段\n')
writeFileSync(join(WS, 'docs/multi.md'), '# 多滑窗\n回滚时先看怎么判断\n')
writeFileSync(join(WS, 'docs/real.md'), '# 整串\n回滚时怎么判断文件被别人改过\n')
writeFileSync(join(WS, 'docs/weakonly.md'), '# 弱文档\n为什么重启之后行为会变\n')

await svc.indexBatch([join(WS, 'src/locks.js'), join(WS, 'src/hot.js'), join(WS, 'dsh/bundle/server/src/hot.js')], WS)

const codeSearchMod = await import(pathToFileURL(join(__dirname, '..', 'code-search.js')).href)
await codeSearchMod.init(core)
const codeSearchService = services.codeSearch

const { handle: searchHandle } = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-code-search', 'handler.js')).href)
const { handle: queryHandle } = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-code-query', 'handler.js')).href)
const ctx = { codeSearchService, codeIndexService: svc, getWorkspaceDir: () => WS }

// ── ① 混合查询：只命中 1/4 个词 → 必须进 partial_matches，不得进 results 主表 ──
{
  const r = await searchHandle({ workspace_dir: WS, query: 'locks push 文件 数组', limit: 10 }, ctx)
  assert(Array.isArray(r.partial_matches), `① 必须有 partial_matches 字段（得 ${JSON.stringify(Object.keys(r))}）`)
  const mainNames = (r.results || []).map(x => x.name || x.path)
  assert(!mainNames.some(n => String(n).includes('repoLocks')),
    `① 只命中 1/4 词的 _repoLocks 不得进 results 主表（得 ${mainNames.join(',') || '空'}）`)
  const pm = (r.partial_matches || []).find(x => String(x.name || x.path || '').includes('repoLocks'))
  assert(!!pm, `① _repoLocks 必须出现在 partial_matches（得 ${JSON.stringify((r.partial_matches || []).map(x => x.name || x.path))}）`)
  if (pm) {
    assert(Array.isArray(pm.matched) && pm.matched.includes('locks'),
      `① partial 项必须说清命中了哪个词（得 ${JSON.stringify(pm.matched)}）`)
    assert(typeof pm.coverage === 'number' && pm.coverage > 0 && pm.coverage < 0.5,
      `① partial 项 coverage 必须 <0.5（得 ${JSON.stringify(pm.coverage)}）`)
  }
  assert(typeof r.token_coverage === 'object' && r.token_coverage !== null,
    `① 必须给出整次查询的 token 覆盖摘要（得 ${JSON.stringify(r.token_coverage)}）`)
}

// ── ② 精确符号：match_kind=exact_symbol，coverage=1，必须留在主表 ──
{
  const r = await searchHandle({ workspace_dir: WS, query: '_repoLocks', limit: 10 }, ctx)
  const hit = (r.results || []).find(x => x.name === '_repoLocks')
  assert(!!hit, `② 精确符号必须在 results 主表（得 ${JSON.stringify((r.results || []).map(x => x.name))}）`)
  if (hit) {
    assert(hit.match_kind === 'exact_symbol', `② match_kind=exact_symbol（得 ${JSON.stringify(hit.match_kind)}）`)
    assert(hit.coverage === 1, `② coverage=1（得 ${JSON.stringify(hit.coverage)}）`)
    assert(Array.isArray(hit.matched) && hit.matched.length === 1, `② matched 只含 1 个词（得 ${JSON.stringify(hit.matched)}）`)
  }
}

// ── ③ 纯中文无命中：0 条 + 0 条 partial（不得为了「看起来有用」硬造候选）──
{
  const r = await searchHandle({ workspace_dir: WS, query: '谁把多个文件的锁收进数组', limit: 10 }, ctx)
  assert((r.results || []).length === 0, `③ 无命中时 results 必须为空（得 ${(r.results || []).length}）`)
  assert((r.partial_matches || []).length === 0, `③ 无命中时不得硬造 partial（得 ${(r.partial_matches || []).length}）`)
}

// ── ④ 意图类结果不得被 coverage 规则误降级 ──
{
  const r = await searchHandle({ workspace_dir: WS, query: 'where is hot used?', limit: 10 }, ctx)
  const callers = (r.results || []).filter(x => x.type === 'caller')
  assert(callers.length >= 1, `④ whereUsed 的 caller 必须在主表（得 ${callers.length}）`)
  if (callers[0]) {
    assert(callers[0].match_kind === 'intent', `④ 意图结果 match_kind=intent（得 ${JSON.stringify(callers[0].match_kind)}）`)
    assert(callers[0].coverage === 1, `④ 意图结果 coverage=1（不参与 token 覆盖判定，得 ${JSON.stringify(callers[0].coverage)}）`)
  }
}

// ── ⑤ 主表里每条结果都必须自带 matched + coverage（不能靠调用方猜）──
{
  const r = await searchHandle({ workspace_dir: WS, query: 'locks', limit: 10 }, ctx)
  const bad = (r.results || []).filter(x => !Array.isArray(x.matched) || typeof x.coverage !== 'number')
  assert(bad.length === 0, `⑤ 主表结果缺 matched/coverage：${JSON.stringify(bad.map(x => x.name || x.path))}`)
  const low = (r.results || []).filter(x => x.coverage < 0.5)
  assert(low.length === 0, `⑤ 主表不得含 coverage<0.5 的项（得 ${JSON.stringify(low.map(x => x.name || x.path))}）`)
}

// ── ⑥ boundaries.note 不得与 matching_note 自相矛盾 ──
{
  const r = await queryHandle({ workspace_dir: WS, mode: 'search', query: '_repoLocks' }, ctx)
  assert(r.ok === true, `⑥ mode=search 应成功（得 ${JSON.stringify(r.error || r.ok)}）`)
  const note = String(r.boundaries?.note || '')
  assert(!/not symbol-name matching/i.test(note),
    `⑥ boundaries.note 不得声明「不是按符号名匹配」（与 matching_note 矛盾）：${note}`)
  assert(/token|coverage|matched/i.test(note),
    `⑥ boundaries.note 必须说明是确定性 token 匹配及 coverage 读法：${note}`)
}

// ── ⑦ matching_note 必须写清 matched/coverage 怎么读 ──
{
  const r = await searchHandle({ workspace_dir: WS, query: 'locks', limit: 10 }, ctx)
  const note = String(r.matching_note || '')
  assert(/matched/.test(note) && /coverage/.test(note),
    `⑦ matching_note 必须写明 matched/coverage 的读法（得 ${note.slice(0, 120)}）`)
  assert(/not semantic/i.test(note), `⑦ matching_note 必须保留「非语义搜索」声明`)
}

// ── ⑧ 跨入口透传：code_search 出口的 comment_matches 必须带真实覆盖率证据 ──
// G2-CE18 要求：不是「模块里算对了」就行，而是 Handler 出口到达调用方时仍是诚实的那份。
{
  const r = await searchHandle({ workspace_dir: WS, query: '同时持有多把', limit: 5 }, ctx)
  assert(Array.isArray(r.comment_matches), `⑧ 必须提供 comment_matches（得 ${JSON.stringify(Object.keys(r))}）`)
  assert((r.comment_matches || []).length > 0, `⑧ 中文查询应命中注释（得 ${(r.comment_matches || []).length}）`)
  const h = (r.comment_matches || [])[0]
  if (h) {
    assert(typeof h.coverage === 'number' && h.coverage > 0 && h.coverage <= 1, `⑧ coverage 必须是 0-1 数值（得 ${JSON.stringify(h.coverage)}）`)
    assert(Array.isArray(h.matched) && h.matched.length > 0, `⑧ matched 必须列出命中词（得 ${JSON.stringify(h.matched)}）`)
    assert(Array.isArray(h.unmatched_query_tokens), `⑧ 必须带 unmatched_query_tokens（得 ${JSON.stringify(h.unmatched_query_tokens)}）`)
    assert(h.match_basis === 'comment_keyword', `⑧ match_basis 必须标明是关键词匹配（得 ${JSON.stringify(h.match_basis)}）`)
    assert(typeof h.corpus_coverage === 'number', `⑧ 双分母必须同时到达出口（得 ${JSON.stringify(h.corpus_coverage)}）`)
    assert(h.type !== 'symbol', `⑧ 注释命中不得被当成符号实现（得 ${JSON.stringify(h.type)}）`)
  }
  assert(typeof r.comment_coverage_definition === 'string' && /query_tokens/.test(r.comment_coverage_definition),
    `⑧ 分母定义必须随结果透传（得 ${JSON.stringify(r.comment_coverage_definition)}）`)
}

// ── ⑤ CN06（ROADMAP §6）：三词只中一词 → 覆盖率必须仍是 1/3，不得被语料缺失抬高 ──
{
  const r = await searchHandle({ workspace_dir: WS, query: 'locks zzzqqq wwwppp', limit: 10 }, ctx)
  const tc = r.token_coverage || {}
  assert(tc.searchable === 3, `⑤ 分母必须是原查询词数 3（得 ${JSON.stringify(tc.searchable)}）`)
  assert(tc.coverage === 0.33, `⑤ 只中 1/3 时 coverage=0.33（得 ${JSON.stringify(tc.coverage)}）`)
  assert(Array.isArray(tc.covered) && tc.covered.length === 1 && tc.covered[0] === 'locks',
    `⑤ covered 只含真正命中的词（得 ${JSON.stringify(tc.covered)}）`)
  const hit = [...(r.results || []), ...(r.partial_matches || [])].find(x => String(x.name || x.path || '').includes('repoLocks'))
  assert(!!hit && hit.coverage === 0.33, `⑤ 命中项 coverage 同样是 0.33（得 ${JSON.stringify(hit && hit.coverage)}）`)
}

// ── ⑥ CN06 补充：四词只中一词 → 0.25，且必须落 partial_matches（不得进主表）──
{
  const r = await searchHandle({ workspace_dir: WS, query: 'locks zzzqqq wwwppp yyyeee', limit: 10 }, ctx)
  const tc = r.token_coverage || {}
  assert(tc.searchable === 4 && tc.coverage === 0.25, `⑥ 1/4 → searchable=4、coverage=0.25（得 ${JSON.stringify(tc)}）`)
  const inMain = (r.results || []).some(x => String(x.name || x.path || '').includes('repoLocks'))
  assert(!inMain, `⑥ 1/4 命中不得进 results 主表（得 ${JSON.stringify((r.results || []).map(x => x.name || x.path))}）`)
  const pm = (r.partial_matches || []).some(x => String(x.name || x.path || '').includes('repoLocks'))
  assert(pm, `⑥ 1/4 命中必须落 partial_matches（得 ${JSON.stringify((r.partial_matches || []).map(x => x.name || x.path))}）`)
}

// ── ⑦ 生成副本：保留但稳定后置，并标明 rank_reason ──
{
  const r = await searchHandle({ workspace_dir: WS, query: 'hot', limit: 10 }, ctx)
  const all = [...(r.results || []), ...(r.partial_matches || [])]
  const srcIdx = all.findIndex(x => /(^|\/)src\/hot\.js$/.test(String(x.file || x.path || '')))
  const genIdx = all.findIndex(x => String(x.file || x.path || '').includes('dsh/bundle/'))
  assert(srcIdx >= 0 && genIdx >= 0, '⑦ 源码与生成副本都要在结果里（不得删索引）（得 ' + srcIdx + '/' + genIdx + '）')
  assert(srcIdx < genIdx, '⑦ 生成副本必须排在源码之后（得 src=' + srcIdx + ' gen=' + genIdx + '）')
  assert(all[genIdx].rank_reason === 'generated_bundle', '⑦ 生成副本必须标 rank_reason=generated_bundle（得 ' + JSON.stringify(all[genIdx].rank_reason) + '）')
  assert(all[srcIdx].rank_reason === undefined, '⑦ 源码不得被误标为生成副本（得 ' + JSON.stringify(all[srcIdx].rank_reason) + '）')
}

// ── ⑧ 文档 3 字滑窗：单滑窗不足以定罪，多滑窗必须标 weak ──
{
  const { searchDocFiles } = await import(pathToFileURL(join(__dirname, '..', 'doc-files.js')).href)
  const hits = searchDocFiles(WS, '回滚时怎么判断文件被别人改过', { limit: 10 })
  const files = hits.map(h => h.file)
  assert(!files.includes('docs/noise.md'), '⑧ 单个 3 字滑窗命中的文档必须被丢弃（得 ' + JSON.stringify(files) + '）')
  const real = hits.find(h => h.file === 'docs/real.md')
  assert(!!real && real.match_basis === 'exact_query', '⑧ 整串命中保留且标 exact_query（得 ' + JSON.stringify(real && real.match_basis) + '）')
  const multi = hits.find(h => h.file === 'docs/multi.md')
  assert(!!multi && multi.match_basis === 'cjk_trigram' && multi.weak === true, '⑧ 多滑窗命中保留但必须标 weak（得 ' + JSON.stringify(multi && { b: multi.match_basis, w: multi.weak }) + '）')
  const onlyWeak = await searchHandle({ workspace_dir: WS, query: '为什么重启之后行为没变化', limit: 10 }, ctx)
  assert(/weak/.test(onlyWeak.summary || ''), '⑧ summary 必须说清弱文档命中（得 ' + JSON.stringify(onlyWeak.summary) + '）')
  assert(/WEAK/.test(onlyWeak.next_step || ''), '⑧ 全是弱命中时不得引导“去读文档当答案”（得 ' + JSON.stringify(onlyWeak.next_step) + '）')
}

// ── ⑨ 检索 MISS 日志：有命中不记、0 命中才记（P3 的唯一数据来源）──
{
  const st = mkdtempSync(join(os.tmpdir(), 'malong-sl-'))
  const prevState = process.env.MALONG_STATE_DIR
  process.env.MALONG_STATE_DIR = st
  process.env.MALONG_SEARCH_LOG = 'misses'
  try {
    const { readSearchMisses } = await import(pathToFileURL(join(__dirname, '..', 'search-log.js')).href)
    const hit = await searchHandle({ workspace_dir: WS, query: 'hot', limit: 10 }, ctx)
    assert(hit.count > 0, '⑨ 用例前置：hot 应有命中（得 ' + hit.count + '）')
    assert(readSearchMisses({ limit: 0 }).total === 0, '⑨ 有命中时不得记 MISS（得 ' + readSearchMisses({ limit: 0 }).total + '）')
    const miss = await searchHandle({ workspace_dir: WS, query: 'zebra_qq_zz_不存在', limit: 10 }, ctx)
    assert(miss.count === 0, '⑨ 用例前置：构造查询应 0 命中（得 ' + miss.count + '）')
    const r = readSearchMisses({ limit: 0 })
    assert(r.total === 1, '⑨ 0 命中必须记一行（得 ' + r.total + '）')
    const e0 = r.entries[0] || {}
    assert(e0.entry === 'code_search', '⑨ 记录带 entry=code_search（得 ' + JSON.stringify(e0.entry) + '）')
    assert(e0.code_hits === 0, '⑨ 记录带 code_hits=0（得 ' + JSON.stringify(e0.code_hits) + '）')
    assert(typeof e0.query === 'string' && e0.query.length > 0, '⑨ 记录带查询词（得 ' + JSON.stringify(e0.query) + '）')
  } finally {
    delete process.env.MALONG_SEARCH_LOG
    if (prevState == null) delete process.env.MALONG_STATE_DIR
    else process.env.MALONG_STATE_DIR = prevState
    rmSync(st, { recursive: true, force: true })
  }
}

try { rmSync(WS, { recursive: true, force: true }) } catch {}
console.log(`== test-search-coverage: ${pass} passed, ${fail} failed ==`)
process.exit(fail > 0 ? 1 : 0)
