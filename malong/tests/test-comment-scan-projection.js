// test-comment-scan-projection.js — G2-FB01：注释扫描是「观察事实」，必须在回执里无条件投影
//
// 来源：六合第六轮专家独立复核（2026-10-30）§三 残余反馈断点 G2-FB01。
// 现象：tool-code-search/handler.js 只在 commentRes.hits.length > 0 时才吐出 comment_* 字段。
// 于是三件**不同**的事在回执里压成同一句 "0 matches found"：
//   ① 注释扫描根本没运行（非中文查询 + 符号已命中）
//   ② 运行了、扫了 N 个文件、零命中（查询词不在语料里）
//   ③ 运行了、但被扫描上限截断 ——「这段范围里没找到」≠「仓库没有」
//
// 修法：无条件输出有界摘要 comment_search =
//   { performed, result_count, corpus_scanned, corpus_truncated, corpus_files, corpus_chunks, reason }
// 命中与零命中同一形状；零命中的 next_step 由 reason 决定说法，不得混为一谈。
//
// 本测试**不依赖 malong-parse**：注入可控 codeSearchService + 空的 code-index.db 占位，
// 所以缺 Rust 解析服务的环境也能独立复跑（test-search-coverage.js 会卡在索引构建处）。
import { join, dirname } from 'node:path'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  FAIL:', msg) } }

const WS = join(os.tmpdir(), 'opencode', 'g2-fb01-ws')
try { rmSync(WS, { recursive: true, force: true }) } catch {}
mkdirSync(join(WS, 'src'), { recursive: true })
writeFileSync(join(WS, 'src/alpha.js'), [
  '// 锁登记表：同时持有多把 .mlock 的写入者会在这里登记',
  'export function alpha() { return 1 }',
].join('\n') + '\n')
writeFileSync(join(WS, 'src/beta.js'), [
  '// beta 只做只读统计',
  'export function beta() { return 2 }',
].join('\n') + '\n')
// handler 只检查 db 文件存在（符号索引由 codeSearchService 负责，这里是注入的假服务）
writeFileSync(join(WS, 'code-index.db'), '')

const csMod = await import(pathToFileURL(join(__dirname, '..', 'comment-search.js')).href)
const { queryTokens } = csMod
const { handle, summarizeCommentScan, commentZeroHitNextStep } =
  await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-code-search', 'handler.js')).href)

// 可控 codeSearchService：结果完全由测试给定，不碰索引/解析器
function fakeService(results) {
  return {
    search: async (query) => ({ query, intent: 'search', results, partial_matches: [], token_coverage: null }),
  }
}
// R17-B2：getWorkspaceDir 必须返回【与源码目录不同】的 state 目录——生产就是 state 目录
// （<stateDir>/workspaces/<md5>，只有 code-index.db）。旧夹具写的是 `() => WS`，
// 把 state 目录指成了源码目录，于是 handler 无论传哪个目录都能扫到文件——
// 「注释扫描扫错目录」这个缺陷在测试里永远是绿的。
const STATE = join(os.tmpdir(), 'opencode', 'g2-fb01-state')
try { rmSync(STATE, { recursive: true, force: true }) } catch {}
mkdirSync(STATE, { recursive: true })
writeFileSync(join(STATE, 'code-index.db'), '')
const ctxOf = (results, extra = {}) => ({
  codeSearchService: fakeService(results),
  getWorkspaceDir: () => STATE,
  ...extra,
})
const SYMBOL_HIT = [{ type: 'symbol', name: 'alpha', file: 'src/alpha.js', line: 2, matched: ['alpha'], coverage: 1, match_kind: 'exact_symbol' }]

// ── ① 中文零命中：「确实扫了」这件事必须留在回执里 ──
// 查询词在注释语料里一个都不存在 → performed=true、corpus_scanned=true、result_count=0，
// 且原因必须是「词面失配」，不是「仓库没有」。
let scanKeys = null
{
  const q = '量子纠缠磁通域'
  const r = await handle({ workspace_dir: WS, query: q }, ctxOf([]))
  assert(r.error === undefined, `① 中文零命中不应报错（得 ${JSON.stringify(r.error)}）`)
  assert((r.results || []).length === 0, `① 前提：符号结果为空（得 ${(r.results || []).length}）`)
  assert(r.comment_search && typeof r.comment_search === 'object', `① 必须输出 comment_search 摘要（得 ${JSON.stringify(Object.keys(r))}）`)
  const s = r.comment_search || {}
  scanKeys = Object.keys(s).sort()
  assert(s.performed === true, `① 中文查询必须真的扫过注释：performed=true（得 ${JSON.stringify(s.performed)}）`)
  assert(s.corpus_scanned === true, `① corpus_scanned=true（得 ${JSON.stringify(s.corpus_scanned)}）`)
  assert(s.result_count === 0, `① result_count=0（得 ${JSON.stringify(s.result_count)}）`)
  assert(s.corpus_files >= 2, `① 必须报出实际扫描文件数（得 ${JSON.stringify(s.corpus_files)}）`)
  assert(s.corpus_truncated === false, `① 未触上限时 corpus_truncated=false（得 ${JSON.stringify(s.corpus_truncated)}）`)
  assert(s.reason === 'zero_hit_query_tokens_absent_from_corpus',
    `① 零命中原因必须是词面失配（得 ${JSON.stringify(s.reason)}）`)
  const qt = queryTokens(q)
  const missing = r.comment_corpus_missing_tokens || []
  assert(missing.length === qt.length,
    `① 语料缺词必须逐个交代（缺 ${missing.length} / 查询词 ${qt.length}）`)
  assert(typeof r.next_step === 'string' && /None of your query words occur/i.test(r.next_step),
    `① next_step 必须说明是词面失配（得 ${JSON.stringify(r.next_step)}）`)
  assert(!/does not exist|no such concept|not implemented in this (repo|workspace)/i.test(r.next_step || ''),
    `① next_step 不得断言「仓库里没有」（得 ${JSON.stringify(r.next_step)}）`)
  assert(/comment scan: \d+ files scanned, 0 hits/.test(r.summary || ''),
    `① summary 必须写明扫了多少文件仍 0 命中（得 ${JSON.stringify(r.summary)}）`)
}

// ── ② 英文主搜索命中：注释根本没扫，回执必须说「未运行」而不是「没找到」──
{
  const r = await handle({ workspace_dir: WS, query: 'alpha', limit: 5 }, ctxOf(SYMBOL_HIT))
  assert((r.results || []).length === 1, `② 前提：符号命中 1 条（得 ${(r.results || []).length}）`)
  const s = r.comment_search || {}
  assert(s.performed === false, `② 非中文且符号已命中 → performed=false（得 ${JSON.stringify(s.performed)}）`)
  assert(s.corpus_scanned === false, `② 没扫就不能说扫过：corpus_scanned=false（得 ${JSON.stringify(s.corpus_scanned)}）`)
  assert(s.reason === 'skipped_symbol_hits_present', `② 原因=未运行（得 ${JSON.stringify(s.reason)}）`)
  assert(s.result_count === 0, `② result_count=0（得 ${JSON.stringify(s.result_count)}）`)
  assert(!('comment_matches' in r), `② 没扫就不该有 comment_matches（得 ${JSON.stringify(Object.keys(r))}）`)
  assert(/To inspect a hit/.test(r.next_step || ''), `② 有符号命中时不改下一步（得 ${JSON.stringify(r.next_step)}）`)
  assert(JSON.stringify(Object.keys(s).sort()) === JSON.stringify(scanKeys),
    `② 命中与未命中必须是同一形状的摘要（${JSON.stringify(Object.keys(s).sort())} vs ${JSON.stringify(scanKeys)}）`)
}

// ── ③ 扫描触上限：0 命中只能描述「已扫范围」，不得读成「仓库不存在」──
// 用 commentScanMaxFiles 接缝把扫描上限压到 1 个文件（生产不传，走 MAX_FILES=2000）。
{
  const r = await handle({ workspace_dir: WS, query: '量子纠缠磁通域' }, ctxOf([], { commentScanMaxFiles: 1 }))
  const s = r.comment_search || {}
  assert(s.performed === true && s.corpus_scanned === true, `③ 前提：确实扫过（得 ${JSON.stringify(s)}）`)
  assert(s.corpus_files === 1, `③ 上限生效：只扫 1 个文件（得 ${JSON.stringify(s.corpus_files)}）`)
  assert(s.corpus_truncated === true, `③ 触上限必须标 corpus_truncated=true（得 ${JSON.stringify(s.corpus_truncated)}）`)
  assert(s.result_count === 0, `③ result_count=0（得 ${JSON.stringify(s.result_count)}）`)
  assert(/truncated/.test(r.summary || ''), `③ summary 必须标出截断（得 ${JSON.stringify(r.summary)}）`)
  const step = String(r.next_step || '')
  assert(/scan(ner)? ?(limit|stopped)|scanned range/i.test(step),
    `③ next_step 必须点明「只覆盖已扫范围」（得 ${JSON.stringify(step)}）`)
  assert(!/does not exist|no such concept|not implemented in this (repo|workspace)/i.test(step),
    `③ 截断时不得断言「仓库里没有」（得 ${JSON.stringify(step)}）`)
}

// ── ④ 有命中：comment_matches 结构保持原样，comment_search 与零命中同形状 ──
{
  const r = await handle({ workspace_dir: WS, query: '同时持有多把' }, ctxOf([]))
  assert(Array.isArray(r.comment_matches) && r.comment_matches.length > 0,
    `④ 中文关键词命中注释（得 ${(r.comment_matches || []).length}）`)
  const s = r.comment_search || {}
  assert(s.performed === true && s.corpus_scanned === true, `④ 命中时同样是「扫过」（得 ${JSON.stringify(s)}）`)
  assert(s.result_count === (r.comment_matches || []).length,
    `④ result_count 必须等于 comment_matches 条数（${s.result_count} vs ${(r.comment_matches || []).length}）`)
  assert(s.reason === 'hits_found', `④ 命中原因=hits_found（得 ${JSON.stringify(s.reason)}）`)
  assert(JSON.stringify(Object.keys(s).sort()) === JSON.stringify(scanKeys),
    `④ 命中/零命中摘要必须同形状（${JSON.stringify(Object.keys(s).sort())} vs ${JSON.stringify(scanKeys)}）`)
  const h = (r.comment_matches || [])[0] || {}
  assert(h.match_basis === 'comment_keyword', `④ 命中仍标关键词来源（得 ${JSON.stringify(h.match_basis)}）`)
  assert(typeof h.coverage === 'number' && typeof h.corpus_coverage === 'number',
    `④ 双分母不得因本次改动丢失（得 ${JSON.stringify([h.coverage, h.corpus_coverage])}）`)
}

// ── ⑤ 扫描抛错 ≠ 零命中：失败要说「未知」，不得伪装成「没找到」──
{
  const s = summarizeCommentScan({ hits: [], corpus: null }, { performed: true, error: 'EACCES: permission denied' })
  assert(s.performed === true && s.reason === 'scan_failed', `⑤ 扫描异常 → reason=scan_failed（得 ${JSON.stringify(s.reason)}）`)
  assert(/permission denied/.test(s.error || ''), `⑤ 失败原因必须保留（得 ${JSON.stringify(s.error)}）`)
  const step = commentZeroHitNextStep(s)
  assert(/UNKNOWN/.test(step) && !/None of your query words occur/.test(step),
    `⑤ 扫描失败不得说成词面失配（得 ${JSON.stringify(step)}）`)
}
// ⑥ 空查询词表：与「零命中」区分开（queryTokens 为空 = 没有可匹配的词）
{
  const s = summarizeCommentScan({ hits: [], corpus: { files: 0, chunks: 0, truncated: false, scanned: false }, query_tokens: [] },
    { performed: true })
  assert(s.reason === 'query_has_no_searchable_tokens', `⑥ 无查询词 → 专属 reason（得 ${JSON.stringify(s.reason)}）`)
  const s2 = summarizeCommentScan({ hits: [], corpus: { files: 0, chunks: 0, truncated: false, scanned: false }, query_tokens: ['ab'] },
    { performed: true })
  assert(s2.reason === 'no_source_files_in_scope', `⑥ 扫描范围为空 → 专属 reason（得 ${JSON.stringify(s2.reason)}）`)
}

// ── ⑦ 语料为空：必须说「扫描范围里没有源码」，不能说「你的查询没有可检索词」──
// 旧实现两条早退路径都不带 query_tokens，summarizeCommentScan 读不到就归因成查询词为空，
// 于是「扫描范围是空目录」被说成「你的问题不可检索」（DSH 2026-11-02 实测就是这个）。
{
  const EMPTY = join(os.tmpdir(), 'opencode', 'g2-fb01-empty')
  const EMPTY_STATE = join(os.tmpdir(), 'opencode', 'g2-fb01-empty-state')
  for (const d of [EMPTY, EMPTY_STATE]) { try { rmSync(d, { recursive: true, force: true }) } catch {} }
  mkdirSync(EMPTY, { recursive: true })
  mkdirSync(EMPTY_STATE, { recursive: true })
  writeFileSync(join(EMPTY_STATE, 'code-index.db'), '')
  const r = await handle({ workspace_dir: EMPTY, query: '量子纠缠磁通域' }, {
    codeSearchService: fakeService([]),
    getWorkspaceDir: () => EMPTY_STATE,
  })
  const s = r.comment_search || {}
  assert(s.performed === true, `⑦ 中文查询仍标记已执行（得 ${JSON.stringify(s.performed)}）`)
  assert(s.reason === 'no_source_files_in_scope',
    `⑦ 空目录必须归因「扫描范围无源码」（得 ${JSON.stringify(s.reason)}）`)
  assert(s.reason !== 'query_has_no_searchable_tokens', '⑦ 不得把空目录说成「查询没有可检索词」')
  for (const d of [EMPTY, EMPTY_STATE]) { try { rmSync(d, { recursive: true, force: true }) } catch {} }
}

try { rmSync(WS, { recursive: true, force: true }) } catch {}
try { rmSync(STATE, { recursive: true, force: true }) } catch {}
console.log(`== test-comment-scan-projection: ${pass} passed, ${fail} failed ==`)
process.exit(fail > 0 ? 1 : 0)
