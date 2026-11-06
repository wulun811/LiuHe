// code_search — 意图分类多路融合搜索（B13 缺口五）
// 复用 code-search.js 的 search 服务（9 意图 + 符号/文件/调用链融合 + 排序）。
// 工具内返回错误对象，不 throw。

import { join } from 'node:path'
import { existsSync } from 'node:fs'
// 0.5.25：文档字面兜底——.md 等交付物型文件不在符号索引里（Rust 解析服务只吃代码），
// 「交付物就是文档」的仓搜代码永远 0 命中。这里做一次受限的字面扫描补上。
import { searchDocFiles } from '../../doc-files.js'
// F2-L1：注释/字符串字面量检索——中文自然语言问题靠它才有答案
import { searchComments } from '../../comment-search.js'
// P1：假设词边界校验与 code_task 共用同一个纯函数（两个入口不允许两套规则）
import { normalizeSearchTerms } from '../../search-terms.js'
// P3：检索 MISS 本地日志（opt-in、默认 off；trace 刻意不记查询词，见 TRACE-GUIDE §9）
import { logSearchMiss } from '../../search-log.js'

// 命中去重键：同一符号/位置只出现一次（扩展词不得把原查询命中再复制一遍）
function hitKey(h) {
  const f = h?.file_path || h?.file || ''
  const n = h?.name || ''
  return String(h?.symbol_id || (f + '::' + n + '::' + (h?.line ?? '')))
}

function traceId() {
  return `trc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function makeError(code, message, suggestion) {
  return { error: code, message, ...(suggestion ? { suggestion } : {}), trace_id: traceId() }
}

// ── G2-FB01（2026-10-30 专家第六轮）：注释扫描的观察事实投影（纯函数：无 I/O、无时间、无随机）──
//
// 缺陷：原来只在 commentRes.hits.length > 0 时才吐出 comment_* 字段。于是下面三件**不同**的事
// 在回执里压成同一句 "0 matches found"：
//   · 注释扫描根本没运行（查询非中文且符号已命中）
//   · 运行了、扫了 N 个文件、零命中（词不在语料 / 覆盖度不够）
//   · 运行了但被扫描上限截断——「这段范围里没找到」≠「仓库没有」
// 这里把它们拆成 performed / corpus_scanned / corpus_truncated / reason 四个可判读的事实。
const COMMENT_SCAN_REASONS = {
  skipped_symbol_hits_present: 'not run: non-CJK query and symbol search already returned hits',
  query_has_no_searchable_tokens: 'run: the query produced no searchable tokens',
  no_source_files_in_scope: 'run: no source files found under the workspace',
  nothing_scanned: 'run: the scan started but read no files',
  hits_found: 'run: comment/string snippets matched',
  zero_hit_query_tokens_absent_from_corpus: 'run: no query word occurs in the scanned comments (keyword mismatch)',
  zero_hit_below_min_coverage: 'run: query words occur, but no snippet covered enough of the query',
  scan_failed: 'run: the scan threw — result is UNKNOWN, not zero',
}

export function summarizeCommentScan(result, meta = {}) {
  const corpus = result?.corpus || null
  const hits = Array.isArray(result?.hits) ? result.hits : []
  const qTokens = Array.isArray(result?.query_tokens) ? result.query_tokens : []
  const missing = Array.isArray(result?.corpus_missing_tokens) ? result.corpus_missing_tokens : []
  const err = meta?.error ? String(meta.error).slice(0, 300) : null
  let reason
  if (meta?.performed !== true) reason = 'skipped_symbol_hits_present'
  else if (err) reason = 'scan_failed'
  else if (qTokens.length === 0) reason = 'query_has_no_searchable_tokens'
  else if (corpus?.scanned !== true) reason = Number(corpus?.files || 0) === 0 ? 'no_source_files_in_scope' : 'nothing_scanned'
  else if (hits.length > 0) reason = 'hits_found'
  // 全部查询词在语料里都不存在 → 这是关键词法的词面失配，不是「概念不存在」
  else if (missing.length === qTokens.length) reason = 'zero_hit_query_tokens_absent_from_corpus'
  else reason = 'zero_hit_below_min_coverage'
  return {
    performed: meta?.performed === true,
    result_count: hits.length,
    corpus_scanned: corpus?.scanned === true,
    corpus_truncated: corpus?.truncated === true,
    corpus_files: Number(corpus?.files || 0),
    corpus_chunks: Number(corpus?.chunks || 0),
    reason,
    reason_detail: COMMENT_SCAN_REASONS[reason],
    ...(err ? { error: err } : {}),
  }
}

// 零命中时的下一步：不得把「未运行 / 未找到 / 未覆盖」说成同一件事，
// 更不得把「扫描范围受限的零命中」表述成「仓库里没有」。
export function commentZeroHitNextStep(scan) {
  const s = scan || {}
  if (s.performed !== true) {
    return `No matches. Comments were NOT scanned for this query (${s.reason || 'skipped'}) — the comment scan only runs for CJK queries or when symbol search returns nothing. Try references(symbol=...) with one exact identifier, or reindex if the workspace changed.`
  }
  if (s.reason === 'scan_failed') {
    return `No matches. The comment scan FAILED (${s.error || 'unknown error'}) — treat this as UNKNOWN, not as "the concept is absent". Try references(symbol=...) with one exact identifier, or reindex if the workspace changed.`
  }
  if (!s.corpus_scanned) {
    const reason = String(s.reason || '')
    const noTokens = reason.includes('no_searchable_tokens')
    return `No matches. The comment scan ran but read no files (${reason}) — this says nothing about whether the concept exists.`
      + (noTokens
        ? ' The query has no ASCII identifier to match: this search is literal, so rephrase to a concrete identifier (an English function/file name), or pass the caller English identifier guesses as search terms (those are hypotheses, not verified names).'
        : ' Check workspace_dir, or reindex if the workspace changed.')
  }
  const head = `${s.result_count || 0} comment hits across ${s.corpus_files} scanned source files.`
  if (s.corpus_truncated) {
    return `No symbol, document or comment hit. ${head} The scan stopped at its file limit, so this covers the scanned range only — re-run before concluding the concept is missing.`
  }
  if (s.reason === 'zero_hit_query_tokens_absent_from_corpus') {
    return `No symbol, document or comment hit. ${head} None of your query words occur in the scanned comments — a keyword search cannot match wording that never appears; switch to the code's own vocabulary, or use references(symbol=...).`
  }
  return `No symbol, document or comment hit. ${head} Some query words occur in comments, but no snippet covered enough of the query to be admitted. Narrow to ONE exact identifier, or use references(symbol=...).`
}

export async function handle(args, context) {
  const { codeSearchService, codeIndexService, getWorkspaceDir } = context
  const workspaceDir = args?.workspace_dir
  const query = args?.query
  if (!workspaceDir) {
    return makeError('missing_parameter', 'workspace_dir is required', 'Provide the absolute path to the project root directory.')
  }
  // R22-⑯：非字符串 workspace_dir 让 getWorkspaceDir→resolve 裸抛 TypeError
  if (typeof workspaceDir !== 'string') {
    return makeError('invalid_input', `workspace_dir must be a string (got ${typeof workspaceDir})`, 'Provide a valid workspace directory path.')
  }
  if (!query || typeof query !== 'string') {
    return makeError('missing_parameter', 'query is required', 'Provide a natural-language or symbol query.')
  }

  const dbPath = join(getWorkspaceDir(workspaceDir), 'code-index.db')
  if (!existsSync(dbPath)) {
    return makeError('workspace_not_indexed', `Workspace not indexed: ${workspaceDir}`, `Call reindex(workspace_dir="${workspaceDir}") first`)
  }
  if (!codeSearchService?.search) {
    return makeError('service_unavailable', 'codeSearch service not available', 'Check MCP server configuration and ensure code-search.js is loaded')
  }
  // r47: codeIndex 连接是懒初始化（MCP 进程重启后 _db=null，db 文件残留 ≠ 连接已打开）——
  // 不 ensure 则 self._db.prepare 抛错被 search 内部 catch 吞掉 → 恒 0 命中（实测：重启后直接搜 0，reindex 后立即命中）
  let initWarning = null
  if (codeIndexService?.initWorkspace) {
    // R22-⑰（第四轮审核 P1）：initWorkspace 失败不再静默——否则 DB 损坏/连接失败时用户只看到 0 matches
    try {
      await codeIndexService.initWorkspace(workspaceDir)
    } catch (e) {
      initWarning = `initWorkspace failed: ${e?.message || String(e)}`
    }
  }

  const limit = Math.max(1, Math.min(50, parseInt(args?.limit) || 10))
  // P1（专家 2026-10-31）：可选 search_terms——调用方假设词。校验与 code_task 完全一致。
  const termCheck = normalizeSearchTerms(args?.search_terms)
  if (!termCheck.ok) {
    return makeError('invalid_input', termCheck.error, 'Pass search_terms=["conceptTerm", ...] (model-supplied hypotheses, not facts).')
  }
  try {
    const r = await codeSearchService.search(query, { topK: limit })
    // P1：扩展词只召回进**单独一栏**，绝不合并进 results——原查询命中永不降权。
    // 单独一栏 = 证据类别不同：这些是“假设词碰上的候选”，不是“原话找到的答案”。
    const expanded = []
    const expandedErrors = []
    if (termCheck.terms.length) {
      const seen = new Set(r.results.slice(0, limit).map(hitKey))
      for (const term of termCheck.terms) {
        if (expanded.length >= limit) break
        try {
          const er = await codeSearchService.search(term, { topK: limit })
          for (const hit of (er.results || [])) {
            const k = hitKey(hit)
            if (seen.has(k)) continue
            seen.add(k)
            expanded.push({ ...hit, match_source: 'expanded_term', matched_expansion: term })
            if (expanded.length >= limit) break
          }
        } catch (e) {
          expandedErrors.push({ term, error: String(e?.message || e).slice(0, 120) })
        }
      }
    }
    // 0.5.25：文档兜底（字面扫描 .md/.rst/.txt）——符号索引之外的交付物也能被搜到
    let docHits = []
    try { docHits = searchDocFiles(workspaceDir, query, { limit }) } catch { docHits = [] }
    // G2-FB02（2026-11-01 自用实测）：3 字滑窗命中只是“文档里出现过这个片段”，
    // 不是“文档讲了这件事”。数量必须单独说出来，否则会被读成“文档里有答案”。
    const weakDocs = docHits.filter(h => h.weak)
    // F2-L1：把「注释」当语料。只在「查询含中文」或「符号/文件检索 0 命中」时扫——
    // 普通符号查询不需要它，不给它加无谓开销。
    let commentRes = { hits: [], corpus: null }
    let commentError = null
    const hasCJK = /[\u4e00-\u9fff]/.test(query)
    const wantsCommentScan = hasCJK || r.results.length === 0
    if (wantsCommentScan) {
      try {
        // 仅测试/诊断接缝：生产不传 commentScanMaxFiles，走 comment-search.js 的 MAX_FILES 默认值
        const maxFiles = Number(context?.commentScanMaxFiles)
        // R17-B2：必须扫【源码目录】。getWorkspaceDir(workspaceDir) 是索引 state 目录
        // （<stateDir>/workspaces/<md5>，里面只有 code-index.db），传进去 walk() 永远 0 个源码文件，
        // 注释检索自引入（6dcb58d）起从未真正扫过一行代码——DSH 实测中文查询恒报
        // query_has_no_searchable_tokens。同 tool-spec-gen r52 的坑：state 目录只含索引库。
        commentRes = searchComments(workspaceDir, query, {
          limit,
          ...(Number.isFinite(maxFiles) && maxFiles > 0 ? { max_files: maxFiles } : {}),
        })
      } catch (e) {
        // 扫描抛错 ≠ 零命中：原因必须随回执走，不能被吞成「没找到」
        commentError = e?.message || String(e)
        commentRes = { hits: [], corpus: null }
      }
    }
    const commentScan = summarizeCommentScan(commentRes, { performed: wantsCommentScan, error: commentError })
    const out = {
      query: r.query,
      intent: r.intent,
      // F2-L0（2026-10-29 自用试用修正）：原 matching_note 只说了「非语义」，没说「怎么读分」——
      // 于是只命中 1/5 个词的裸分候选被当成「相似度不高的答案」。
      // 现在每条结果自带 matched/coverage/match_kind，低覆盖率的进 partial_matches。
      matching_note: 'Deterministic token+intent matching (NOT semantic/embedding search). Read each hit by: matched = which query tokens it actually hit; coverage = hit tokens / searchable tokens (1 = the whole query matched; <0.5 = only part of the query matched and the hit is parked in partial_matches instead of results); match_kind = exact_symbol | symbol_substring | symbol_weak | file_path | intent. Use precise symbol/file names for best results.',
      results: r.results.slice(0, limit),
      count: r.results.slice(0, limit).length,
      // P1（专家 2026-10-31）：假设词的来源与影响面必须随回执抵达调用方，
      // 否则“靠猜测词命中”会被读成“原话找到了”。
      ...(termCheck.provided ? {
        query_interpretation: {
          original_query: query,
          search_terms_used: termCheck.terms,
          search_terms_source: 'caller_hypothesis',
          original_query_hit: r.results.length > 0,
          expanded_hit_count: expanded.length,
          ...(termCheck.dropped.length ? { search_terms_dropped: termCheck.dropped } : {}),
          note: 'search_terms are caller hypotheses, not verified names. Expanded hits live in expanded_matches and are never merged into results: the original query decides the answer; expansions only add candidates to verify.',
        },
      } : {}),
      ...(expanded.length ? {
        expanded_matches: expanded.slice(0, limit),
        expanded_count: expanded.length,
        expanded_note: 'expanded_matches were reachable ONLY through caller-supplied search_terms (hypotheses). They are NOT answers and do not displace results — read before treating any of them as the target.',
      } : {}),
      ...(expandedErrors.length ? { expanded_errors: expandedErrors } : {}),
      // 文档命中独立字段（不混进符号结果，避免污染排序语义）
      ...(docHits.length ? {
        doc_results: docHits,
        doc_count: docHits.length,
        doc_note: 'doc_results come from a literal text scan of .md/.mdx/.rst/.txt files — those are NOT in the symbol index (the parser handles code languages only). Read one with code_query(mode="body", file="<path>").',
      } : {}),
      // F2-L0：部分命中单独成栏，不与真实答案同表
      ...(r.partial_matches?.length ? {
        partial_matches: r.partial_matches.slice(0, limit),
        partial_count: r.partial_matches.length,
        partial_note: 'partial_matches hit only PART of your query (coverage < 0.5). They are NOT answers — they mean "the query had words this token-based search could not match". Narrow to one exact identifier and search again before treating any of them as the target.',
      } : { partial_matches: [], partial_count: 0 }),
      ...(r.token_coverage ? { token_coverage: r.token_coverage } : {}),
      // F2-L1：注释命中单独成栏——它只说明「这个概念在哪被讨论过」，不是实现位置，
      // 所以不得混进 results（与 F2-L0 同一条原则：不同证据类型不同栏）
      // G2-FB01：有界观察摘要，命中与零命中同一形状（performed / result_count / corpus_scanned /
      // corpus_truncated / reason）。有界 = 只有布尔/整数/枚举，不含正文。
      comment_search: commentScan,
      // 语料里根本不存在的查询词：无论有没有命中都要交代（它决定「要不要换个词再试」）
      ...(commentRes.corpus_missing_tokens?.length ? { comment_corpus_missing_tokens: commentRes.corpus_missing_tokens } : {}),
      ...(commentRes.hits.length ? {
        comment_matches: commentRes.hits,
        comment_count: commentRes.hits.length,
        comment_corpus: commentRes.corpus,
        // G2-CE18：两个分母的语义必须跟着结果一起到达调用方，否则字段正确也会被读错
        ...(commentRes.coverage_definition ? { comment_coverage_definition: commentRes.coverage_definition } : {}),
        comment_note: commentRes.note,
      } : {}),
      // G2-FB01：零命中也必须让 summary 说清「注释扫了多少、是不是被截断」，否则调用方只看到 0
      summary: `${r.results.slice(0, limit).length} matches found${r.partial_matches?.length ? ` (+${r.partial_matches.length} partial, coverage<0.5)` : ''}${commentRes.hits.length ? ` (+${commentRes.hits.length} comment matches)` : ''}${docHits.length ? ` (+${docHits.length} document hits${weakDocs.length ? `, ${weakDocs.length} weak` : ''})` : ''}${expanded.length ? ` (+${expanded.length} via hypothesis terms — NOT results)` : ''}${!commentRes.hits.length && commentScan.performed ? ` (comment scan: ${commentScan.corpus_files} files scanned, 0 hits${commentScan.corpus_truncated ? ', truncated' : ''})` : ''}`,
      ...(initWarning ? { init_warning: initWarning } : {}),
      next_step: r.results.length > 0
        ? 'To inspect a hit: read_symbol(file=..., name=...) or references(symbol=...)'
        : (commentRes.hits.length
          // G2-CE18：注释命中的覆盖率必须写进下一步（它是「值不值得去看」的唯一依据），
          // 且不得暗示已经找到实现
          ? `No symbol/file match. Best comment hit covers ${Math.round((commentRes.hits[0].coverage || 0) * 100)}% of your query${commentRes.hits[0].unmatched_query_tokens?.length ? ` (unmatched: ${commentRes.hits[0].unmatched_query_tokens.join(', ')})` : ''}. comment_matches show WHERE the concept is discussed (comments/strings) — open that file to locate the actual implementation; a comment hit is NOT proof that the implementation is there.`
          : (r.partial_matches?.length
            ? 'Only partial matches (coverage<0.5): your query contains words this token-based search cannot match (it is NOT semantic). Narrow to ONE exact identifier/symbol name, or use references(symbol=...). Do not treat partial_matches as results.'
            : (docHits.length
              ? (weakDocs.length === docHits.length
                ? `Only WEAK document hits (${weakDocs.length} via 3-character fragments): that is NOT evidence the implementation is there. Search again with a concrete identifier (function/file name), or pass search_terms=[...] as hypotheses.`
                : 'Only document hits: read one with code_query(mode="body", file="<path>").')
              // G2-FB01：零命中的说法必须由 comment_search 的事实决定（未运行 / 未找到 / 未覆盖三分）
              : commentZeroHitNextStep(commentScan)))),
    }
    // P1：原查询零命中、只有假设词召回时，下一步必须说清“这是猜中的候选”，
    // 且不得暗示已经找到了实现（否则就是把 hypothesis 当成 fact）。
    if (out.results.length === 0 && expanded.length) {
      const terms = [...new Set(expanded.map(e => e.matched_expansion))].join(', ')
      out.next_step = `Original query matched nothing. ${expanded.length} candidate(s) came ONLY from your hypothesis terms (${terms}) — that is not proof the original wording was found; read them to confirm. For a deterministic answer, rephrase the query to a concrete identifier.`
    }
    // P3（2026-11-01）：代码命中为 0 就是一次真实检索 MISS。trace 刻意不记查询词
    // （隐私白名单，TRACE-GUIDE §2），所以这里单独记一行本地日志：opt-in、默认 off、
    // 写失败不影响本次返回（logSearchMiss 永不抛错）。
    if (out.count === 0 && (out.partial_count || 0) === 0) {
      logSearchMiss({
        entry: 'code_search',
        reason: (weakDocs.length > 0 && weakDocs.length === docHits.length) ? 'weak_docs_only' : 'zero_hit',
        query,
        codeHits: 0,
        partialHits: 0,
        docHits: docHits.length,
        docWeak: weakDocs.length,
        expandedHits: expanded.length,
        searchTerms: termCheck.terms.length,
        workspaceDir,
      })
    }
    return out
  } catch (e) {
    return makeError('search_failed', `Search failed: ${e.message}${initWarning ? ` (${initWarning})` : ''}`, 'Ensure the workspace is indexed.')
  }
}
