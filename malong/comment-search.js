// comment-search.js — F2-L1：把「注释」当语料做确定性全文检索（无 embedding、无网络）
//
// 为什么需要它（2026-10-29 自用试用）：
//   code_search 的 token 化把整段中文当成**一个** token 去比对符号名，所以
//   中文自然语言问句（带「怎么/为什么/在哪」的完整句子）恒返回 0 条。
//   但本仓代码有极密的中文注释——自然语言里的词**真的存在于注释里**。
//   探针实测：只检索「注释 + 字符串字面量」，4 条自然语言查询 top-3 命中 3/4（现状 0/4）。
//
// 边界（必须明说的）：
//   · 这不是语义检索。词面不重合时仍然失效（例：注释写「同时持有多把 .mlock」，
//     问题问「数组/收进」→ 命中不了）。这是关键词法的原理性上限，不要宣传成 embedding。
//   · 注释命中只说明「这个概念在这里被讨论过」，不等于「实现在这里」。
//     所以结果放在独立字段 comment_matches，**不混进 results**——不同证据类型不同栏，
//     与 F2-L0「部分命中不得与真实命中同表」是同一条原则。
//   · 只读、无副作用、无时间依赖：可复现（同输入同输出）。
import { readdirSync, statSync, readFileSync } from 'node:fs'
import { join, extname } from 'node:path'

// 参与扫描的源码扩展名（注释语义在文本类文件里都一样）
const EXTS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.mts', '.cts',
  '.py', '.go', '.java', '.rs', '.rb', '.sh', '.bash', '.sql',
  '.kt', '.kts', '.php', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.lua', '.vue', '.swift',
])
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.malong', '.ai-transactions', 'bundle', 'data',
  'dist', 'build', 'coverage', '.next', '.nuxt', 'target', 'vendor', '__pycache__', '.venv',
])
const MAX_FILES = 2000          // 超过就不建，明确降级（不静默只搜一部分）
const MAX_FILE_BYTES = 512 * 1024
const MAX_CHUNKS_PER_FILE = 400
const MIN_COVERAGE = 0.4        // 注释命中要求覆盖 40% 查询词，低于不给（宁缺勿滥）
const COMMON_DF_RATIO = 0.6     // 出现在 60% 以上文件里的词没有区分度，丢弃
// 测试/夹具路径降权（与 code-search.js 的 _testyTier 同一原则）：测试里的注释会大量引用
// 被测概念，不降权会把实现埋在同分候选里。不隐藏，只排在后面并标原因。
const TESTY_PATH = /(^|\/)(tests?|__tests__|fixtures?|benchmarks?|mocks?|samples?)(\/|$)|\.(test|spec)\.[^/]+$/i

// 中文高频二元组（无 IDF 时用来压噪；不追求完备）
const CN_STOP_BIGRAMS = new Set([
  '我们', '这个', '那个', '怎么', '什么', '可以', '需要', '应该', '如果', '但是',
  '因为', '所以', '就是', '一个', '不是', '没有', '已经', '还是', '或者', '然后',
  '这样', '那样', '时候', '现在', '自己', '他们', '你们', '问题', '地方', '东西',
  '的时', '了的', '是的', '是不', '不能', '不会', '不要', '这里', '那里', '哪些',
])
const EN_STOPWORDS = new Set(['the', 'and', 'for', 'are', 'was', 'were', 'has', 'have', 'with', 'this', 'that', 'from', 'not', 'but', 'you', 'all', 'can', 'how', 'what', 'when', 'where', 'why', 'who', 'how', 'does', 'did'])

// 缓存：absPath -> { mtimeMs, size, chunks: [{line,text}], tokens: Set }
// 失效判据是文件 mtime+size（文件系统状态，不读时钟）——确定性，不用 TTL。
const cache = new Map()

function walk(dir, out, limit) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) { walk(p, out, limit); if (out.length >= limit) return }
    else if (e.isFile() && EXTS.has(extname(e.name).toLowerCase())) { out.push(p); if (out.length >= limit) return }
  }
}

// 从一行里取注释正文（顺序：块注释状态优先，再 //，再 Python/shell 的 #）
function commentText(line, inBlock) {
  const t = line
  if (inBlock) {
    const end = t.indexOf('*/')
    if (end === -1) return { text: t, inBlock: true }
    return { text: t.slice(0, end), inBlock: false }
  }
  const bi = t.indexOf('/*')
  const li = t.indexOf('//')
  if (bi !== -1 && (li === -1 || bi < li)) return { text: t.slice(bi + 2), inBlock: t.indexOf('*/', bi + 2) === -1 }
  if (li !== -1) return { text: t.slice(li + 2), inBlock: false }
  const hi = t.search(/(^|\s)#/)
  if (hi !== -1) return { text: t.slice(hi).replace(/^[\s#]+/, ''), inBlock: false }
  return { text: '', inBlock: false }
}

function extractChunks(absPath) {
  let st
  try { st = statSync(absPath) } catch { return null }
  if (st.size > MAX_FILE_BYTES) return null
  const hit = cache.get(absPath)
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit

  let src = ''
  try { src = readFileSync(absPath, 'utf-8') } catch { return null }
  const chunks = []
  let inBlock = false
  const lines = src.split('\n')
  for (let i = 0; i < lines.length && chunks.length < MAX_CHUNKS_PER_FILE; i++) {
    const r = commentText(lines[i], inBlock)
    inBlock = r.inBlock
    const text = String(r.text || '').trim()
    if (text.length < 4) continue
    chunks.push({ line: i + 1, text: text.slice(0, 400) })
  }
  // 字符串字面量也是人写的语义（错误文案/提示语），但只取较长的，避免噪声
  for (let i = 0; i < lines.length && chunks.length < MAX_CHUNKS_PER_FILE; i++) {
    for (const m of lines[i].matchAll(/'([^'\n]{8,80})'|"([^"\n]{8,80})"/g)) {
      const s = m[1] || m[2]
      if (s && /[\u4e00-\u9fff]/.test(s)) chunks.push({ line: i + 1, text: s })
    }
  }

  const tokens = new Set()
  for (const c of chunks) {
    const ct = tokensOf(c.text)
    c.tokens = ct
    for (const k of ct) tokens.add(k)
  }
  const entry = { mtimeMs: st.mtimeMs, size: st.size, chunks, tokens }
  cache.set(absPath, entry)
  return entry
}

// 文本 → 匹配用 token：中文取 bigram，英文/标识符取整词（小写）
function tokensOf(text) {
  const out = new Set()
  const s = String(text || '')
  for (const run of (s.match(/[\u4e00-\u9fff]+/g) || [])) {
    if (run.length === 1) { out.add(run); continue }
    for (let i = 0; i + 2 <= run.length; i++) {
      const bg = run.slice(i, i + 2)
      if (!CN_STOP_BIGRAMS.has(bg)) out.add(bg)
    }
  }
  for (const w of (s.match(/[A-Za-z_$][\w$]*/g) || [])) {
    const lw = w.toLowerCase()
    if (lw.length >= 3 && !EN_STOPWORDS.has(lw)) out.add(lw)
  }
  return out
}

// 查询 → token（与语料同一套切分，否则覆盖度算不准）
export function queryTokens(query) {
  return [...tokensOf(query)]
}

function relOf(workspaceDir, abs) {
  const a = abs.split('\\').join('/')
  const b = workspaceDir.split('\\').join('/').replace(/\/$/, '')
  return a.startsWith(b + '/') ? a.slice(b.length + 1) : a
}

// 主入口：确定性全文检索。返回 { hits, corpus }
export function searchComments(workspaceDir, query, opts = {}) {
  const limit = Math.max(1, Math.min(50, Number(opts.limit) || 10))
  const qTokens = queryTokens(query)
  const corpus = { files: 0, chunks: 0, truncated: false, scanned: false }
  // R17-B2：三条早退路径都必须带 query_tokens。旧实现只返回 {hits, corpus}，
  // 上层 summarizeCommentScan 读不到 query_tokens 就归因成「你的查询没有可检索词」，
  // 把「扫描范围为空」误诊成用户查询的问题（DSH 2026-11-02 实测就是这个）。
  if (qTokens.length === 0) return { hits: [], corpus, query_tokens: qTokens }

  // 扫描上限可注入（测试「超限扫描」用），默认 MAX_FILES。超限必须显式声明，不静默只搜一部分。
  const maxFiles = Math.max(1, Math.min(MAX_FILES, Number(opts.max_files) || MAX_FILES))
  const files = []
  walk(workspaceDir, files, maxFiles)
  corpus.truncated = files.length >= maxFiles
  corpus.files = files.length
  if (files.length === 0) return { hits: [], corpus, query_tokens: qTokens }

  const entries = []
  for (const abs of files) {
    const e = extractChunks(abs)
    if (!e) continue
    entries.push({ abs, rel: relOf(workspaceDir, abs), e })
    corpus.chunks += e.chunks.length
  }
  corpus.scanned = true
  if (entries.length === 0) return { hits: [], corpus, query_tokens: qTokens }

  // 丢无区分度的超高频词（无 IDF 时的降噪）；不能把查询词全丢光
  const df = new Map()
  for (const { e } of entries) for (const t of qTokens) if (e.tokens.has(t)) df.set(t, (df.get(t) || 0) + 1)
  let effective = qTokens.filter(t => (df.get(t) || 0) > 0 && (df.get(t) || 0) <= Math.max(1, Math.floor(entries.length * COMMON_DF_RATIO)))
  if (effective.length === 0) effective = qTokens.filter(t => (df.get(t) || 0) > 0)
  const corpusMissing = qTokens.filter(t => (df.get(t) || 0) === 0)
  const effectiveSet = new Set(effective)
  if (effective.length === 0) {
    return {
      hits: [], corpus, query_tokens: qTokens, corpus_missing_tokens: corpusMissing,
      note: 'None of the query terms occur in the scanned comments. This is a KEYWORD search: word mismatch means zero recall — it does NOT mean the concept does not exist in the code.',
    }
  }

  const hits = []
  // 自指过滤：注释原文包含「整条查询串」时，这段文字是在**引用问题**（FAQ/文档/测试用例），
  // 不是在讨论概念。不滤掉的话，每条自然语言查询都会以 coverage=1 命中提问者自己的文件，
  // 把真实结果挤出 top-N。（实测：测试文件里存着查询字面量，6 条基准全部自指命中。）
  // 只对长句（>=12 归一化字符）生效——短关键词命中「包含查询串」是正常现象，不得误删。
  const selfNorm = String(query).replace(/[\s\p{P}]/gu, '').toLowerCase()
  for (const { rel, e } of entries) {
    for (const c of e.chunks) {
      const textNorm = String(c.text).replace(/[\s\p{P}]/gu, '').toLowerCase()
      // 自指（注释原文引用了整条长句）不删，只降到最后并标注——删会连真实讨论一起删掉。
      const selfRef = selfNorm.length >= 12 && textNorm.includes(selfNorm)
      // G2-CE18（2026-10-29 专家实测反例）：这里原来用 effective（语料里出现过的查询词）当分母，
      // 语料缺词时那些词被裁掉 → 只命中 1/3 也报 coverage=1.0。用户看到「100% 覆盖」，
      // 而真实情况是「你查询里有 2 个词这份语料根本没有」。两个分母必须分开：
      //   coverage        = matched / 查询的全部内容词  ← 展示用，用户看的就是这个
      //   corpus_coverage = matched / 区分性查询词      ← 仅用于准入与排序，不得当覆盖率展示
      const matched = qTokens.filter(t => c.tokens.has(t))
      if (matched.length === 0) continue
      const coverage = Math.round((matched.length / qTokens.length) * 100) / 100
      const corpusMatched = matched.filter(t => effectiveSet.has(t))
      const corpusCoverage = Math.round((corpusMatched.length / effective.length) * 100) / 100
      if (corpusCoverage < MIN_COVERAGE) continue
      const unmatched = qTokens.filter(t => !c.tokens.has(t))
      const testy = TESTY_PATH.test(rel)
      const tier = (selfRef ? 2 : 0) + (testy ? 1 : 0)
      hits.push({
        type: 'comment', file: rel, line: c.line, text: c.text,
        matched, unmatched_query_tokens: unmatched,
        coverage, corpus_coverage: corpusCoverage,
        match_kind: 'comment_text', match_basis: 'comment_keyword',
        score: coverage, score_basis: 'query_coverage (keyword overlap, NOT semantic similarity)',
        query_tokens_total: qTokens.length, tier,
        ...(selfRef ? { self_reference: true, rank_reason: 'quotes the query verbatim (FAQ/doc/test self-reference) — ranked last' } : {}),
        ...(!selfRef && testy ? { rank_reason: 'test/fixture path — ranked after production comments' } : {}),
      })
    }
  }
  // 稳定排序：生产非自指 > 生产自指 > 测试非自指 > 测试自指，其次覆盖度/命中词数/路径/行号
  // （全部确定性，无随机/时间）
  hits.sort((a, b) => (a.tier || 0) - (b.tier || 0) ||
    b.coverage - a.coverage || b.corpus_coverage - a.corpus_coverage || b.matched.length - a.matched.length ||
    (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) || a.line - b.line)
  for (const h of hits) delete h.tier
  return {
    hits: hits.slice(0, limit),
    corpus,
    query_tokens: qTokens,
    effective_tokens: effective,
    corpus_missing_tokens: corpusMissing,
    coverage_definition: 'coverage = matched / query_tokens (ALL content words of your query, including those that never occur in the corpus). corpus_coverage = matched / effective_tokens (only terms present in the corpus and not too common) and is used for admission/ranking ONLY — never present it as "how much of the query was covered".',
    note: 'comment_matches are comment/string-literal hits (deterministic keyword match, NOT semantic similarity). coverage = how much of YOUR query this snippet matched; check unmatched_query_tokens before concluding anything. They show WHERE a concept is discussed, not where it is implemented — confirm with a live read. Hits flagged self_reference quote the whole query verbatim (FAQ/doc) and are ranked last, not hidden.',
  }
}
