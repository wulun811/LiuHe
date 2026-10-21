// code_query — P2 只读结构化查询入口（无需 task）。
// 设计约束（专家 P2）：不授予写权限；静态图非运行时证明；缺失/陈旧/动态关系必须明示；
// 复用现有只读实现（不重造）；工作区边界由底层 handler 守住。
import { handle as readOutline } from '../tool-outline-reader/handler.js'
import { handle as symbolSearch } from '../tool-symbol-search/handler.js'
import { handle as referencesHandle } from '../tool-references/handler.js'
import { handle as readSymbolHandle } from '../tool-read-symbol/handler.js'
import { handle as callChain } from '../tool-call-chain/handler.js'
import { handle as impactAnalysis } from '../tool-impact-analysis/handler.js'
import { handle as codeSearchHandle } from '../tool-code-search/handler.js'
import { handle as findTestsHandle } from '../tool-find-tests/handler.js'
import { handle as sandboxValidateHandle } from '../tool-edit-sandbox/handler.js'
import { traceId, ensureIndexed } from '../entry-shared.js'
import { listCapabilities, describeCapability, intentHints } from '../../workflow/capability-catalog.js'
import { pickOptions as pickEntryOptions } from '../../entry-options.js'
import { sanitizeAdvisory, sanitizeGraphActions } from '../../workflow/action-map.js'
import { existsSync, statSync } from 'node:fs'
import { resolve, sep, relative, isAbsolute } from 'node:path'

const MODES = ['outline', 'symbols', 'references', 'callers', 'callees', 'impact', 'map', 'body', 'search', 'tests', 'validate', 'capabilities', 'capability']

function fail(error, message, suggestion) {
  return { ok: false, error, message, ...(suggestion ? { suggestion } : {}), trace_id: traceId() }
}

// Phase2 F2（接线核对 L02）：建议字段隐藏工具改写——实现抽至 ../../workflow/action-map.js（R05：invoke 出口亦复用）。
// 只在返回副本上改写【建议字段】；不改底层 classic handler，也不触碰结果正文（context 代码片段可能含同名子串）。
// 兼容再导出（test-code-query 自本文件导入；实现见 ../../workflow/action-map.js）
export { sanitizeAdvisory, sanitizeGraphActions }

// G2-B/C（ADR-019 D2）：options 校验透传——共享实现见 ../../entry-options.js（audit 亦复用）。
const OPTION_ALLOW = {
  outline: ['include_refs', 'include_test_refs', 'max_items'],
  callers: ['max_callers', 'max_callees'],
  callees: ['max_callers', 'max_callees'],
  impact: ['symbols', 'change_type', 'context_mode', 'max_callers', 'max_results'],
  body: ['locators', 'context_lines', 'include_outline', 'outline_depth', 'source', 'on_ambiguous'],
  map: ['prefix'],
}
export function pickOptions(mode, options) {
  const r = pickEntryOptions(OPTION_ALLOW[mode] || [], options, 'mode=' + mode)
  if (r.ok) return { ok: true, opts: r.opts }
  return { ok: false, fail: fail(r.error, r.message, r.suggestion) }
}

export async function handle(args, context) {
  const workspaceDir = args?.workspace_dir
  if (typeof workspaceDir !== 'string' || !workspaceDir) {
    return fail('missing_parameter', 'workspace_dir is required')
  }
  const mode = args?.mode
  if (!MODES.includes(mode)) {
    return fail('missing_parameter', 'mode must be one of ' + MODES.join('|'), 'Example: code_query(workspace_dir=<abs>, mode="outline", file="src/util.js")')
  }
  const picked = pickOptions(mode, args?.options)
  if (!picked.ok) return picked.fail
  const opts = picked.opts

  // 每个 mode 的取参+委派；返回 { r } 或 { fail }（参数校验失败不触发索引）。
  const runMode = async () => {
    if (mode === 'outline') {
      if (typeof args?.file !== 'string' || !args.file) return { fail: fail('missing_parameter', 'outline requires file') }
      return { r: await readOutline({ workspace_dir: workspaceDir, file: args.file, depth: args.depth, ...opts }, context) }
    }
    if (mode === 'symbols') {
      if (typeof args?.query !== 'string' || !args.query) return { fail: fail('missing_parameter', 'symbols requires query') }
      return { r: await symbolSearch({ workspace_dir: workspaceDir, query: args.query, limit: args.limit }, context) }
    }
    if (mode === 'references') {
      if (typeof args?.symbol !== 'string' || !args.symbol) return { fail: fail('missing_parameter', 'references requires symbol') }
      let rr = await referencesHandle({ workspace_dir: workspaceDir, symbol: args.symbol, file: args.file, kind: args.kind }, context)
      // F5（专家 §9-7）：manifest 声明 limit 但该分支原未消费——按 limit 截断并标记，避免 count 失真。
      if (rr && !rr.error && typeof args.limit === 'number' && Number.isInteger(args.limit) && args.limit > 0 && Array.isArray(rr.results) && rr.results.length > args.limit) {
        rr = { ...rr, results: rr.results.slice(0, args.limit), count: args.limit, truncated: true, limit_applied: args.limit }
      }
      return { r: rr }
    }
    if (mode === 'callers' || mode === 'callees') {
      if (typeof args?.file !== 'string' || !args.file) return { fail: fail('missing_parameter', mode + ' requires file') }
      // 狗粮r3（P3）：schema 只强制 file，但底层 call_chain 需 symbol（或文件内 line）定位符号——
      // 此前直接委派会抛 “Could not determine symbol from file+line”，用户照 schema 传 file 即撞墙。
      if ((typeof args?.symbol !== 'string' || !args.symbol) && !Number.isInteger(args?.line)) {
        return { fail: fail('missing_parameter', mode + ' requires symbol (or line inside a function)', 'Pass symbol="name", or line=<n> within a function/class in ' + args.file + '.') }
      }
      const cc = await callChain({
        workspace_dir: workspaceDir, file: args.file, line: args.line, symbol: args.symbol,
        depth: args.depth, max_callers: args.limit, max_callees: args.limit, ...opts,
      }, context)
      // F6（专家 §9.7）：此前只取数组、丢弃底层覆盖说明（truncated_*/test_references/metadata/staleness）。
      // 保留除「非请求数组」外的完整结果，避免用通用 boundaries.note 冒充实际扫描范围。
      if (!cc || cc.error) return { r: cc }
      const { callers, callees, ...coverage } = cc
      const arr = mode === 'callers' ? (callers || []) : (callees || [])
      return { r: { [mode]: arr, ...coverage } }
    }
    if (mode === 'impact') {
      if (typeof args?.file !== 'string' || !args.file) return { fail: fail('missing_parameter', 'impact requires file') }
      return { r: await impactAnalysis({ workspace_dir: workspaceDir, file: args.file, symbol: args.symbol, depth: args.depth, max_results: args.limit, ...opts }, context) }
    }
    if (mode === 'search') {
      // G2-A：真委派 code_search（意图/内容搜索）——不再用 mode=symbols 冒充（§8.4 假替代修正）。
      if (typeof args?.query !== 'string' || !args.query) return { fail: fail('missing_parameter', 'search requires query') }
      if (typeof context?.codeSearchService?.search !== 'function') return { fail: fail('capability_unavailable', 'code search service unavailable in this context', `Describe the original tool: code_query(mode="capability", name="code_search").`) }
      return { r: await codeSearchHandle({ workspace_dir: workspaceDir, query: args.query, limit: args.limit }, context) }
    }
    if (mode === 'tests') {
      // G2-A：真委派 find_tests（测试文件候选）——不再用 code_check(test) 跑全量冒充（§8.4）。
      if (typeof args?.file !== 'string' || !args.file) return { fail: fail('missing_parameter', 'tests requires file') }
      return { r: await findTestsHandle({ workspace_dir: workspaceDir, file: args.file, symbol: args.symbol }, context) }
    }
    if (mode === 'validate') {
      // G2-A：真委派 sandbox_validate（候选内容验证；不落盘）——不再改写为 code_patch（§8.4）。
      if (typeof args?.file !== 'string' || !args.file) return { fail: fail('missing_parameter', 'validate requires file') }
      if (typeof args?.new_content !== 'string') return { fail: fail('missing_parameter', 'validate requires new_content (full candidate content)') }
      return { r: await sandboxValidateHandle({ workspace_dir: workspaceDir, file: args.file, new_content: args.new_content }, context) }
    }
    if (mode === 'map') {
      // F3（专家 §1.2）：复用 repoMapService.generateCompact；不限于零候选；暴露截断/陈旧。
      // F5（0.5.14 Windows 复核）：分页与目录下钻贯穿公开入口——page/dir 顶层参数 + 预算/条数控制，
      // 返回页码/页数/下一页/折叠目录/预算单位 + 可原样执行的 navigation 动作。
      const rm = context?.repoMapService
      if (!rm || typeof rm.generateCompact !== 'function') return { fail: fail('capability_unavailable', 'repo map service unavailable in this context') }
      // dir 必须在工作区内（越界/非目录显式拒绝，不静默给空图）
      let scanDir = workspaceDir
      let dirRel = null
      if (typeof args?.dir === 'string' && args.dir.trim()) {
        const wsAbs = resolve(workspaceDir)
        const target = isAbsolute(args.dir) ? resolve(args.dir) : resolve(wsAbs, args.dir)
        if (target !== wsAbs && !target.startsWith(wsAbs + sep)) {
          return { fail: fail('path_blocked', 'dir escapes workspace_dir: ' + args.dir, 'Pass a directory inside workspace_dir (relative or absolute).') }
        }
        let isDir = false
        try { isDir = existsSync(target) && statSync(target).isDirectory() } catch { isDir = false }
        if (!isDir) return { fail: fail('dir_not_found', 'dir not found or not a directory: ' + args.dir, 'Pass an existing directory inside workspace_dir (relative or absolute), or omit dir to map the whole workspace.') }
        scanDir = target
        dirRel = relative(wsAbs, target).split(sep).join('/') || null
      }
      const nav = await rm.generateCompact(scanDir, {
        workspaceDir,
        maxTokens: typeof args.max_tokens === 'number' ? args.max_tokens : 700,
        pageSize: typeof args.page_size === 'number' ? args.page_size : 12,
        page: Number.isInteger(args?.page) && args.page > 0 ? args.page : 1,
        ...(dirRel ? { scope: dirRel } : {}),
        ...opts,
      })
      // R22 修复 #2（2026-10-12）：workspace_not_indexed 不得包成 {fail} 提前返回——那会跳过入口自带的自动索引重试（仅 map 是此形状，outline 等为 {r:{error}} 可自愈）。
      if (nav && nav.error) return { r: { error: nav.error, message: nav.message || String(nav.error), suggestion: nav.suggestion } }
      return {
        r: {
          map: nav?.map ?? null,
          scope: nav?.scope ?? null,
          page: nav?.page ?? null,
          page_size: nav?.page_size ?? null,
          total_pages: nav?.total_pages ?? null,
          total_entries: nav?.total_entries ?? null,
          next_page: nav?.next_page ?? null,
          has_next_page: !!nav?.has_next_page,
          truncated: !!nav?.truncated,
          truncated_by_budget: !!nav?.truncated_by_budget,
          tokens_estimate: nav?.tokens ?? null,
          budget: nav?.budget ?? null,
          top_entries: nav?.skeleton || [],
          skeleton_total: nav?.skeleton_total ?? (nav?.skeleton || []).length,
          skeleton_omitted: nav?.skeleton_omitted ?? 0,
          ...(nav?.skeleton_text_omitted ? { skeleton_text_omitted: nav.skeleton_text_omitted } : {}),
          folded_dirs: nav?.folded_dirs || [],
          navigation: nav?.navigation || [],
          ...(nav?.page_out_of_range ? { page_out_of_range: true, suggestion: nav.suggestion } : {}),
          ...(nav?.index_stale_note ? { index_stale_note: nav.index_stale_note } : {}),
        },
      }
    }
    if (mode === 'capabilities') {
      // ADR-018 发现出口：枚举原 classic 44（只读目录，不执行任何工具）；无需 task/索引。
      return { r: listCapabilities({
        query: typeof args?.query === 'string' ? args.query : null,
        category: typeof args?.category === 'string' ? args.category : null,
        cursor: Number.isInteger(args?.cursor) ? args.cursor : 0,
        limit: Number.isInteger(args?.limit) && args.limit > 0 ? args.limit : 50,
      }) }
    }
    if (mode === 'capability') {
      // ADR-018 describe：按精确名返回原 schema/effects/safety；未知名 typed 拒绝（不泄漏路径）。
      const d = describeCapability(args?.name)
      if (d && d.error) return { fail: fail(d.error, d.message, d.suggestion) }
      return { r: d }
    }
    // body（F4 / N01 前提）：免 task 正文读——直接委派 read_symbol 原语（不经 code_read 的 task 链路）。
    const hasFile = typeof args?.file === 'string' && args.file
    const hasSym = typeof args?.symbol === 'string' && args.symbol
    if (!hasFile && !hasSym) return { fail: fail('missing_parameter', 'body requires file (optionally with symbol) or symbol') }
    const locator = hasSym ? { file_path: args.file, name: args.symbol } : { file_path: args.file }
    return { r: await readSymbolHandle({ workspace_dir: workspaceDir, locator, mode: args.rich ? 'rich' : 'core', ...(typeof args.budget_hint === 'number' ? { budget_hint: args.budget_hint } : {}), ...opts }, context) }
  }

  let { r, fail: paramFail } = await runMode()
  if (paramFail) return paramFail

  // Phase2-b3（用户反馈①）：入口自带索引保障——空索引首次 code_query 不报死胡同，而是自动增量索引后重试
  // （与 code_task 的“未索引自动索引”一致；graph 面不含 reindex，故不能只提示 reindex）。
  if (r && r.error === 'workspace_not_indexed' && context?.codeIndexService) {
    try {
      await ensureIndexed(context.codeIndexService, workspaceDir)
      const again = await runMode()
      if (again && !again.fail) r = again.r
    } catch {}
  }

  if (r && r.error) {
    return fail(r.error, r.message || String(r.error), sanitizeAdvisory(r.suggestion || ''))
  }

  const boundaries = mode === 'capabilities' || mode === 'capability'
    ? { read_only: true, static_not_runtime: true, note: 'Capability catalog (discovery only; nothing executed). Source: tools/*/manifest.json + contracts/classic-44.positions.json.' }
    : mode === 'body'
    ? { read_only: true, live_file_read: true, note: 'Live file content read; external edits may have landed — confirm against current file when it matters.' }
    : mode === 'search'
    ? { read_only: true, static_not_runtime: true, note: 'Intent/content search over the index (original code_search semantics), not symbol-name matching.' }
    : mode === 'tests'
    ? { read_only: true, static_not_runtime: true, note: 'Test-file candidates from naming conventions + reference scan; candidates are not proof of coverage.' }
    : mode === 'validate'
    ? { read_only: true, static_not_runtime: true, note: 'Candidate-content checks (syntax/bracket + indentation, symbol refs when indexed) against the current file; no write, not a compile/test run.' }
    : mode === 'map'
      ? { read_only: true, static_not_runtime: true, note: 'Compact repo map with real pagination: page/page_size/total_pages/next_page + navigation actions (next_page / drill_down with dir=...). max_tokens bounds the MAP TEXT estimate (ceil(chars/4)) and the trailing truncation notice is counted in it — not the whole MCP response; truncated_by_budget and has_next_page are distinct. Test/fixture subtrees are folded by default (drill down with dir=...). Not a full file listing; may be stale (see index_stale_note).' }
      : (mode === 'callers' || mode === 'callees')
        ? { read_only: true, static_not_runtime: true, note: 'Static call graph from index (not runtime); may miss dynamic/indirect calls; depth-limited (default 2); see truncated_* flags for actual scan coverage.' }
        : { read_only: true, static_not_runtime: true, note: 'Structural index result. Missing/stale/dynamic relations may be absent; confirm with a live read if it matters.' }
  return {
    ok: true,
    mode,
    result: sanitizeGraphActions(r),
    boundaries,
    // H07（0.5.14）：情境能力提示（≤2 条，有条件）——只建议不执行；名称/副作用/描述动作取自能力目录
    // F4：中英意图分别匹配；描述动作自带 workspace_dir，可原样调用
    ...(() => {
      const hints = intentHints(typeof args?.query === 'string' ? args.query : '', { workspace_dir: workspaceDir })
      return hints.length ? { capability_hints: hints } : {}
    })(),
    trace_id: traceId(),
  }
}
