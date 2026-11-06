// 码龙 — NL 代码搜索模块 (v3 P4.2.5)
// 确定性 token + 意图正则匹配（非语义/embedding 搜索）：精确符号名优先，长句自然语言退化为文件级匹配
// 回退策略：符号匹配 → 文件路径模糊匹配 → 内容关键词

const NL_PATTERNS = [
  { intents: ['findFunction', 'findMethod'], patterns: [/function\s+(\w+)/i, /method\s+(\w+)/i, /where is (\w+) (?:function|method|defined)/i, /find\s+(?:the\s+)?(\w+)\s+(?:function|method)/i] },
  { intents: ['findClass'], patterns: [/class\s+(\w+)/i, /where is (\w+) class/i, /find\s+(?:the\s+)?(\w+)\s+class/i] },
  { intents: ['findVariable'], patterns: [/variable\s+(\w+)/i, /where is (\w+) (?:variable|const)/i] },
  { intents: ['whereUsed', 'impactAnalysis'], patterns: [/(?:where|how|what)\s+(?:is\s+)?(\w+)\s+(?:used|called|referenced)/i, /who calls (\w+)/i, /impact.*(\w+)/i] },
  { intents: ['deadCode'], patterns: [/dead\s*code/i, /unused\s+(?:function|code)/i, /never\s+called/i, /what.*not.*used/i] },
  { intents: ['dependencyTree'], patterns: [/dependency\s+(?:tree|graph|chain)/i, /depend.*module/i, /import.*graph/i] },
  { intents: ['complexity'], patterns: [/complexity/i, /complex/i, /hard to understand/i, /too many lines/i] },
  { intents: ['search'], patterns: [/search\s+(?:for\s+)?(\w+)/i, /find\s+(?:the\s+)?(\w+)/i, /locate\s+(\w+)/i] },
]

export const name = 'malong-code-search'
export const version = '0.1.0'

let _core, _codeIndex, _langParser

// ── H01（0.5.14 复审修复）：轻量排序改进（确定性规则，不引入语义检索/embedding）──
// ① 停用词：自然语言里的 after/how/the/for 等普通词不再当强锚点（仅多词查询过滤；单词查询原样保留）；
// ② fixtures/历史 benchmark 副本默认降权；目标在测试目录或用户明确找测试时不降权（有限改进，不当通用语义检索宣传）；
// ③ 低置信声明：无强匹配时明确说低置信并建议补锚点，不强造答案。
const STOPWORDS = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'before', 'after', 'by', 'can', 'could', 'did', 'do', 'does', 'for', 'from', 'how', 'if', 'in', 'into', 'is', 'it', 'its', 'me', 'my', 'of', 'on', 'or', 'our', 'please', 'should', 'so', 'some', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'this', 'those', 'to', 'up', 'use', 'used', 'using', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'while', 'who', 'why', 'will', 'with', 'would', 'you', 'your', 'find', 'search', 'locate', 'show', 'list', 'get', 'all', 'any', 'need', 'want'])
const TEST_INTENT = /\b(tests?|specs?|fixtures?|benchs?|benchmarks?|mocks?)\b/i
const TESTY_PATH = /(^|\/)(tests?|__tests__|fixtures?|benchmarks?|mocks?|samples?)(\/|$)|\.[a-z0-9]+\.(test|spec)\.[a-z0-9]+$/i

// F2-L0（2026-10-29 自用试用修正）：覆盖率阈值。
// 命中的查询词不足一半时，结果不是「低分答案」，而是「只匹配了查询的一部分」——
// 必须与主表分开呈现，否则裸分会被读成「相似度不高」而不是「它只答了问题的一个碎片」。
// 不变量：主表里每条结果的 coverage >= 本阈值。
const PARTIAL_COVERAGE = 0.5

// 生成副本识别：与 tools/entry-shared.js 的 GENERATED_PATH_RE 同一条口径。
// 两处必须一起改——否则同一份代码事实在 code_task 与 code_search 会给出相反的先后顺序。
const GENERATED_SEGMENTS = ['dsh/bundle', 'bundle', 'bundled', 'dist', 'build', 'out', 'generated']
function _isGeneratedPath(r) {
  const raw = String((r && (r.file || r.path)) || '')
  const p = '/' + raw + '/'
  return GENERATED_SEGMENTS.some(function (s) { return p.indexOf('/' + s + '/') >= 0 })
}

// 生成副本是同一份代码的旧快照：保留在结果里（用户可能需要对照），但稳定后置并标明原因。
// 稳定 = 两组内部相对顺序不变；不改分数（分数仍可解释、可比较）。
function _deprioritizeGenerated(list) {
  const prod = []
  const gen = []
  for (const r of list) { if (_isGeneratedPath(r)) gen.push(r); else prod.push(r) }
  for (const r of gen) r.rank_reason = 'generated_bundle'
  return prod.concat(gen)
}

export async function init(core) {
  _core = core
  core.registerService('codeSearch', {
    async search(query, { topK = 10, tenantId = 'default' } = {}) {
      if (!query || query.trim().length < 2) return { query, results: [], intent: 'unknown', confidence: 'none', search_method: 'deterministic tokens + intent regex (NOT semantic/RAG)' }
      const intent = _classifyQuery(query)
      const tokens = _tokenize(query)
      const [symbolResults, fileResults, callResults] = await Promise.all([
        _searchSymbols(tokens, topK, query),
        _searchFiles(tokens, topK, query),
        _executeIntent(intent, tokens, query),
      ])
      const fused = _fuseResults(symbolResults, fileResults, callResults, query, topK)
      // F2-L0：给每条结果标出「命中了哪些查询词 / 覆盖了几个」。
      // 没有这个字段时，只命中 1/5 个词的裸分候选会和真实命中混在同一张表里。
      const annotated = _annotateCoverage(fused, tokens)
      // F2-L0：分区只看「弱证据」。保留主表：
      //   ① 精确符号名（用户直接打出来的名字，匹配度低也是答案）
      //   ② coverage >= 0.5（命中查询一半以上）
      //   ③ 命中 >= 2 个查询词（两个独立词收敛到同一符号是证据）
      //   ④ 短查询（可检索词 < 4）——3 个词里命中 1 个不足以判为噪声
      // 只有「长查询 + 只沾到一个词」才降级，这是唯一有把握的巧合签名。
      // 全链回归三次抓到过严：guard（1/3 但精确）、repeatedRequests（2/5）、outletLedger（1/3）。
      const searchableTokens = tokens.filter(t => t.length >= 2)
      const keep = r => r.match_kind === 'exact_symbol' || r.coverage >= PARTIAL_COVERAGE ||
        r.matched.length >= 2 || searchableTokens.length < 4
      const results = _deprioritizeGenerated(annotated.filter(keep))
      const partialMatches = _deprioritizeGenerated(annotated.filter(r => !keep(r)))
      const searchable = tokens.filter(t => t.length >= 2)
      const coveredTokens = searchable.filter(t => annotated.some(r => r.matched.includes(t)))
      const tokenCoverage = {
        searchable: searchable.length,
        tokens: searchable,
        covered: coveredTokens,
        coverage: searchable.length ? Math.round((coveredTokens.length / searchable.length) * 100) / 100 : 0,
      }
      // H01：低置信声明（不强造答案；有限改进不等于通用语义检索）
      const topScore = results.length ? (results[0].score || 0) : 0
      const confidence = results.length === 0
        ? (partialMatches.length ? 'low' : 'none')
        : topScore >= 0.75 ? 'high' : topScore >= 0.5 ? 'medium' : 'low'
      const note = (confidence === 'low' || confidence === 'none')
        ? 'Low-confidence: no strong match on natural-language terms (deterministic token search + intent regex, NOT semantic/RAG). Add an exact identifier/backticked symbol, or pass file/symbol anchors — weak or zero hits are not proof of absence.'
        : undefined
      return {
        query, intent,
        results,
        partial_matches: partialMatches,
        token_coverage: tokenCoverage,
        confidence,
        search_method: 'deterministic tokens + intent regex (NOT semantic/RAG)',
        ...(note ? { note } : {}),
      }
    },
  })
  core.log('info', `[code-search] service registered`)
}

export async function start() {}

export async function stop() {
  _codeIndex = null
  _langParser = null
}

// F2-L0：把「命中了哪些查询词」变成结果的一等字段。
// 没有这个字段时，_repoLocks（只命中 locks，1/5 词，score 0.65）与精确命中同表同字段名，
// 读方无从判断差别——症状正是「算出了分数，但分数没带上覆盖了多少」。
function _annotateCoverage(fused, tokens) {
  const searchable = tokens.filter(t => t.length >= 2)
  const total = Math.max(1, searchable.length)
  return fused.map(r => {
    const { matchedTokens, isIntent, ...rest } = r
    if (isIntent) {
      // 意图类结果（caller/callee/deadCode/complexity/import）由正则整体识别，不是 token 命中，
      // 不参与覆盖率判定，也不得被降级。
      return { ...rest, matched: searchable.slice(), coverage: 1, match_kind: 'intent' }
    }
    const matched = [...new Set(matchedTokens || [])].filter(t => t.length >= 2)
    const coverage = Math.round((matched.length / total) * 100) / 100
    return { ...rest, matched, coverage, match_kind: _matchKindOf(r, matched) }
  })
}

function _matchKindOf(r, matched) {
  if (r.type === 'file') return 'file_path'
  if (r.type === 'symbol') {
    const raw = typeof r.rawScore === 'number' ? r.rawScore : (r.score || 0)
    if (raw >= 0.85 && matched.length > 0) return 'exact_symbol'
    if (raw >= 0.55) return 'symbol_substring'
    return 'symbol_weak'
  }
  return 'other'
}

function _classifyQuery(query) {
  const q = query.trim()
  for (const entry of NL_PATTERNS) {
    for (const p of entry.patterns) {
      if (p.test(q)) return entry.intents[0]
    }
  }
  return 'search'
}

function _tokenize(query) {
  const raw = query
    .replace(/[^a-zA-Z0-9_\u4e00-\u9fff]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 1)
  // H01：仅多词查询做停用词过滤；过滤后为空则回退原样（不吞用户输入）
  if (raw.length <= 2) return raw
  const filtered = raw.filter(t => /[\u4e00-\u9fff]/.test(t) || t.length < 3 || !STOPWORDS.has(t.toLowerCase()))
  return filtered.length ? filtered : raw
}

// H01/F3：路径降权（测试/夹具/基准副本）；F3（0.5.14 Windows 复核）修正语义——明确测试意图不再「整体豁免」
// 降权（测试候选仍可见、降到 0.8 并标原因），否则无关夹具只靠通用词就能排到实现前面（专家 035：Command 夹具首位）。
function _pathPenalty(p, query) {
  const s = String(p || '')
  if (!s) return 1
  const testIntent = TEST_INTENT.test(String(query || ''))
  if (TESTY_PATH.test(s)) return testIntent ? 0.8 : 0.45
  return 1
}

function _testyPenaltyReason(query) {
  return TEST_INTENT.test(String(query || ''))
    ? 'test/fixture path (explicit test intent: kept but ranked after production)'
    : 'test/fixture/benchmark path downranked (no explicit test intent in query)'
}

// H01：符号评分——精确名 > 名称包含 token > token 包含名称 > 仅弱子串命中（不把通用词抬成强锚点）
function _symbolScore(tok, name) {
  const t = String(tok || '').toLowerCase()
  const n = String(name || '').toLowerCase()
  if (!t || !n) return 0
  if (t === n) return 0.9
  if (n.includes(t)) return 0.6 + 0.1 * (t.length / Math.max(1, n.length))
  if (t.includes(n)) return 0.55
  return 0.3 * (t.length / Math.max(t.length, n.length))
}

async function _searchSymbols(tokens, limit, rawQuery) {
  const _getService = () => _core?.services?.codeIndex
  const ci = _getService()
  if (!ci?.searchSymbols) return []
  const results = []
  const seen = new Set()
  for (const tok of tokens) {
    if (tok.length < 2 || seen.has(tok)) continue
    seen.add(tok)
    try {
      const matches = await ci.searchSymbols(tok, { limit: Math.ceil(limit / Math.max(1, tokens.length)) })
      for (const m of matches) {
        const pen = _pathPenalty(m.file, rawQuery)
        const rawScore = _symbolScore(tok, m.name)
        results.push({
          type: 'symbol',
          name: m.name,
          kind: m.type,
          file: m.file,
          line: m.start_line,
          score: rawScore * pen,
          // F2-L0：rawScore 不受路径降权影响，match_kind 用它判定「是不是精确命中」
          rawScore,
          matchedTokens: [tok],
          ...(pen < 1 ? { rank_reason: _testyPenaltyReason(rawQuery) } : {}),
        })
      }
    } catch {}
  }
  results.sort((a, b) => b.score - a.score)
  return results.slice(0, limit)
}

async function _searchFiles(tokens, limit, rawQuery) {
  const _getService = () => _core?.services?.codeIndex
  const ci = _getService()
  if (!ci?.getStats) return []
  try {
    const stats = ci.getStats?.()
    if (!stats || !stats.files) return []
  } catch { return [] }
  const results = []
  const seen = new Set()
  for (const tok of tokens) {
    if (tok.length < 2) continue
    try {
      const syms = await ci.searchSymbols(tok, { limit })
      for (const s of syms) {
        if (!seen.has(s.file)) {
          seen.add(s.file)
          const pen = _pathPenalty(s.file, rawQuery)
          results.push({ type: 'file', path: s.file, score: (tok.length > 3 ? 0.5 : 0.3) * pen, matchedTokens: [tok], ...(pen < 1 ? { rank_reason: _testyPenaltyReason(rawQuery) } : {}) })
        }
      }
    } catch {}
  }
  return results.slice(0, limit)
}

async function _executeIntent(intent, tokens, rawQuery) {
  const _getService = () => _core?.services?.codeIndex
  const ci = _getService()
  if (!ci) return []
  try {
    if (intent === 'whereUsed' || intent === 'impactAnalysis') {
      const symbolMatch = rawQuery.match(/(\w+)/g)
      const target = symbolMatch?.find(t => t.length > 2 && !['where','how','what','is','used','called','the','who','calls','impact','depend','this'].includes(t.toLowerCase()))
      if (target) {
        const [callers, callees] = await Promise.all([
          ci.getCallers(target).catch(() => []),
          ci.getCallees(target).catch(() => []),
        ])
        const results = []
        for (const c of callers) results.push({ type: 'caller', name: target, callerFile: c.caller_file, score: 0.8 })
        for (const c of callees) results.push({ type: 'callee', name: target, targetName: c.target_name, sourceFile: c.source_file, score: 0.7 })
        return results
      }
    }
    if (intent === 'deadCode') {
      const dead = await ci.detectDeadCode().catch(() => [])
      return dead.map(d => ({ type: 'deadCode', name: d.name, file: d.file, line: d.start_line, refCount: d.ref_count, score: 0.9 }))
    }
    if (intent === 'complexity') {
      const symbolMatch = rawQuery.match(/(\w+)\s*(?:function|method|class)?/i)
      if (symbolMatch) {
        const target = symbolMatch[1]
        if (target && target.length > 1) {
          const cx = await ci.getComplexity(target).catch(() => null)
          if (cx) return [{ type: 'complexity', name: cx.name, file: cx.file, linesOfCode: cx.linesOfCode, cyclomatic: cx.cyclomaticComplexity, cognitive: cx.cognitiveComplexity, score: 0.85 }]
        }
      }
      return []
    }
    if (intent === 'dependencyTree') {
      const symbolMatch = rawQuery.match(/(\w+(?:\/\w+)*(?:\.\w+)?)/g)
      const target = symbolMatch?.find(t => t.includes('.') || t.includes('/') || t.length > 4)
      if (target) {
        const deps = await ci.getModuleDependencies(target).catch(() => null)
        if (deps) {
          const results = []
          for (const d of deps.directImports) results.push({ type: 'import', from: target, module: d.module, score: 0.8 })
          for (const d of deps.transitiveDeps) results.push({ type: 'transitiveImport', from: d.from, module: d.module, depth: d.depth, score: 0.6 })
          return results
        }
      }
    }
  } catch {}
  return []
}

function _fuseResults(symbolResults, fileResults, intentResults, query, topK) {
  const seen = new Map()
  const all = []
  // F2-L0：去重时合并 matchedTokens——同一符号被多个查询词命中时要累加，
  // 否则「命中 3 个词」会被算成「命中 1 个词」而误降到 partial。
  const push = (r, isIntent) => {
    const key = `${r.type}:${r.name || r.path || r.file || ''}:${r.file || r.path || ''}`
    const prev = seen.get(key)
    if (prev) {
      prev.matchedTokens = [...new Set([...(prev.matchedTokens || []), ...(r.matchedTokens || [])])]
      if ((r.score || 0) > (prev.score || 0)) prev.score = r.score
      if ((r.rawScore || 0) > (prev.rawScore || 0)) prev.rawScore = r.rawScore
      return
    }
    const item = { ...r, ...(isIntent ? { isIntent: true } : {}) }
    seen.set(key, item)
    all.push(item)
  }
  for (const r of intentResults) push(r, true)
  for (const r of symbolResults) push(r, false)
  for (const r of fileResults) push(r, false)
  all.sort((a, b) => _testyTier(a) - _testyTier(b) || (b.score || 0) - (a.score || 0))
  // F2-L0：多取 3 倍——分区（主表 / partial）在排序之后做，只取 topK 会把主表挤空
  return all.slice(0, Math.max(topK * 3, 30))
}

// F3（0.5.14 Windows 复核）：测试/夹具候选统一排到生产候选之后（仍可见，不隐藏）——
// 专家 035：原实现按分数排序，夹具 Command（0.9 精确名）压过目标实现。
function _testyTier(r) {
  const f = String((r && (r.file || r.path || r.callerFile || r.sourceFile)) || '')
  return TESTY_PATH.test(f) ? 1 : 0
}
