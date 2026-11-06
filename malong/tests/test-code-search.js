// test-code-search.js — B13 缺口五：code_search 意图分类多路搜索
// 覆盖：契约（缺 query）/ 未索引 / 真实索引后 whereUsed 意图识别 /
//       符号搜索 findFunction / limit 钳制 / service_unavailable
import { join, dirname } from 'node:path'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}

const WS = join(os.tmpdir(), 'opencode', 'b13-cs-ws')
const SOCK = join(os.tmpdir(), 'opencode', 'b13-cs.sock')
try { rmSync(WS, { recursive: true, force: true }) } catch {}
mkdirSync(join(WS, 'src'), { recursive: true })
writeFileSync(join(WS, 'src/app.js'), [
  'export function hot() { return 1 }',
  'export function c1() { hot() }',
  'export function c2() { hot() }',
  // R7：含下划线符号——code_search 的 search 意图 token 化保留 `_`，
  // searchSymbols 转义后按字面量匹配，防全表命中
  'export function snake_case_fn() { return 3 }',
].join('\n') + '\n')
writeFileSync(join(WS, 'src/other.js'), 'export function unrelated() { return 2 }\n')

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
await svc.indexBatch([join(WS, 'src/app.js'), join(WS, 'src/other.js')], WS)

// 注册 code-search 服务（模拟 mcp-server 的 init 注入）
const codeSearchMod = await import(pathToFileURL(join(__dirname, '..', 'code-search.js')).href)
await codeSearchMod.init(core)
const codeSearchService = services.codeSearch

const { handle } = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-code-search', 'handler.js')).href)
const ctx = { codeSearchService, getWorkspaceDir: () => WS }

// ① 契约：缺 query
{
  const r = await handle({ workspace_dir: WS }, ctx)
  assert(r.error === 'missing_parameter', `① 缺 query → missing_parameter（得 ${r.error}）`)
}
// ② 未索引工作区
{
  const empty = join(WS, 'empty')
  mkdirSync(empty, { recursive: true })
  const r = await handle({ workspace_dir: empty, query: 'hot' }, { codeSearchService, getWorkspaceDir: () => empty })
  assert(r.error === 'workspace_not_indexed', `② workspace_not_indexed（得 ${r.error}）`)
}
// ③ whereUsed 意图识别
{
  const r = await handle({ workspace_dir: WS, query: 'where is hot used?' }, ctx)
  assert(r.intent === 'whereUsed', `③ intent=whereUsed（得 ${r.intent}）`)
  assert(r.count >= 2, `③ hot 至少 2 处调用（得 ${r.count}）`)
  const hasCaller = r.results.some(x => x.type === 'caller' && x.name === 'hot')
  assert(hasCaller, `③ 有 caller 类型结果（得 ${JSON.stringify(r.results.map(x => x.type))}）`)
}
// ④ 符号搜索 findFunction
{
  const r = await handle({ workspace_dir: WS, query: 'find function hot' }, ctx)
  assert(r.intent === 'findFunction' || r.intent === 'search', `④ intent 识别（得 ${r.intent}）`)
  assert(r.results.some(x => x.name === 'hot'), `④ 结果含 hot`)
}
// ⑤ limit 钳制
{
  const r = await handle({ workspace_dir: WS, query: 'hot', limit: 1 }, ctx)
  assert(r.results.length <= 1, `⑤ limit=1 生效（得 ${r.results.length}）`)
}
// ⑥ service_unavailable
{
  const r = await handle({ workspace_dir: WS, query: 'hot' }, { getWorkspaceDir: () => WS })
  assert(r.error === 'service_unavailable', `⑥ service_unavailable（得 ${r.error}）`)
}
// ⑦ R7: code_search 含 `_` token 回归——search 意图 token 化保留 `_`，
// searchSymbols 转义后按字面量匹配，不得全表命中
{
  const r = await handle({ workspace_dir: WS, query: 'snake_case_fn' }, ctx)
  const symNames = (r.results || []).filter(x => x.name).map(x => x.name)
  assert(symNames.includes('snake_case_fn'), `⑦ _ token 字面量命中蛇形名（得 ${symNames.join(',')}）`)
  const leaked = symNames.filter(n => !['snake_case_fn'].includes(n))
  assert(leaked.length === 0, `⑦ 无全表误命中（leaked=${leaked.join(',') || '无'}）`)
}
{
  const r = await handle({ workspace_dir: WS, query: 'snake  case' }, ctx)
  const symNames = (r.results || []).filter(x => x.name).map(x => x.name)
  const leaked = symNames.filter(n => !['snake_case_fn'].includes(n))
  assert(leaked.length === 0, `⑦ 分 token 后仍无全表误命中（leaked=${leaked.join(',') || '无'}）`)
}

// ── CN-P0（专家 2026-10-31 中文语义方案）：零命中且查询无可检索 token 时，
// 必须叫人「改写成具体标识符」，而不是让它以为仓库里没这个能力或命令它去瞎读。──
{
  const { commentZeroHitNextStep } = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-code-search', 'handler.js')).href)
  const txt = commentZeroHitNextStep({ performed: true, reason: 'query_has_no_searchable_tokens', corpus_scanned: 0, result_count: 0 })
  assert(/rephrase to a concrete identifier/.test(txt), 'CN-P0 无可检索 token 的零命中文案要求改写（得 ' + txt + '）')
  assert(/hypotheses, not verified names/.test(txt), 'CN-P0 文案说明扩展词是假设（得 ' + txt + '）')
  const other = commentZeroHitNextStep({ performed: true, reason: 'empty_corpus', corpus_scanned: 0, result_count: 0 })
  assert(!/rephrase to a concrete identifier/.test(other), 'CN-P0 其它原因不套用改写文案（得 ' + other + '）')
}

// ── P1（专家 2026-10-31 中文方案）：search_terms 跨入口同一套校验；扩展词单列不降权 ──
{
  const ctx1 = { codeSearchService, getWorkspaceDir: () => WS }
  // ① 兼容：不传 search_terms 时回执不新增字段
  const plain = await handle({ workspace_dir: WS, query: '让调用链都串起来' }, ctx1)
  assert(!('query_interpretation' in plain) && !('expanded_matches' in plain), 'P1 不传 search_terms 时不新增字段（兼容）')
  assert((plain.results || []).length === 0, 'P1 纯中文查询在符号层零命中（前置）')

  // ② 传假设词：只进 expanded_matches，绝不并进 results
  const withTerms = await handle({ workspace_dir: WS, query: '让调用链都串起来', search_terms: ['hot'] }, ctx1)
  assert((withTerms.results || []).length === 0, 'P1 扩展词命中不得混入 results（得 ' + JSON.stringify((withTerms.results || []).map(r => r.name)) + '）')
  const ex = withTerms.expanded_matches || []
  assert(ex.length > 0 && ex.every(h => h.match_source === 'expanded_term' && h.matched_expansion === 'hot'), 'P1 扩展词命中带来源标注（得 ' + JSON.stringify(ex.map(h => [h.name, h.match_source, h.matched_expansion])) + '）')
  assert(/NOT answers/.test(withTerms.expanded_note || ''), 'P1 扩展词栏明确“不是答案”')
  const qi = withTerms.query_interpretation || {}
  assert(qi.original_query === '让调用链都串起来' && qi.search_terms_source === 'caller_hypothesis', 'P1 原查询不被扩展词覆盖（得 ' + JSON.stringify(qi.original_query) + '）')
  assert(qi.original_query_hit === false && qi.expanded_hit_count === ex.length, 'P1 区分“原查询命中”与“假设词命中”')
  assert(/hypothesis terms/.test(withTerms.next_step || ''), 'P1 仅假设词命中时下一步说明来源（得 ' + withTerms.next_step + '）')

  // ③ 有界校验：重复/超长/控制符/超量
  const dirty = await handle({ workspace_dir: WS, query: 'hot', search_terms: ['hot', 'hot', 'a'.repeat(80), 'bad\u0000term', 1, 2, 3, 4, 5, 6, 7, 8] }, ctx1)
  const terms = dirty.query_interpretation?.search_terms_used || []
  assert(terms.length <= 8, 'P1 扩展词上限 8（得 ' + terms.length + '）')
  assert(terms.filter(t => t === 'hot').length === 1, 'P1 重复词去重（得 ' + JSON.stringify(terms) + '）')
  assert(!terms.some(t => t.includes('\u0000')), 'P1 控制符词被拒（得 ' + JSON.stringify(terms) + '）')
  const reasons = (dirty.query_interpretation?.search_terms_dropped || []).map(d => d.reason)
  assert(reasons.includes('control_char') && reasons.includes('duplicate') && reasons.includes('too_long'), 'P1 丢弃原因可判读（得 ' + JSON.stringify(reasons) + '）')
  assert(!JSON.stringify(dirty.query_interpretation || {}).includes('a'.repeat(80)), 'P1 被丢弃的超长词不回显')

  // ④ 类型错误：与 code_task 同一文案（跨入口一致）
  const bad = await handle({ workspace_dir: WS, query: 'hot', search_terms: 'hot' }, ctx1)
  assert(bad.error === 'invalid_input' && /array of strings/.test(bad.message || ''), 'P1 非数组被拒且文案一致（得 ' + JSON.stringify(bad) + '）')
}

try { rmSync(WS, { recursive: true, force: true }) } catch {} // Windows：db 连接未关闭时删除被占用文件报 EBUSY——best-effort，路径固定开头会重建
console.log(`== test-code-search: ${pass} passed, ${fail} failed ==`)
process.exit(fail > 0 ? 1 : 0)
