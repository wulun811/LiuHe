// code_task — S1 只读入口：建立任务 + 可决策首屏（候选符号）。
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  makeError, envelope, inferRoute, newTaskId, putTask, getTask, findByRequestId, ensureIndexed, findCandidates,
  structureSummary, impactOf, payloadHash, TASK_SCHEMA_VERSION, GRAPH_VERSION, ACTIONS_NOTE, buildZeroHitGuidance, toWorkspaceRel,
} from '../entry-shared.js'
import { fitVisibleBudget, CODE_TASK_FILE_TARGET_BUDGET, CODE_TASK_GENERAL_BUDGET } from '../../workflow/output-budget.js'
import { intentHints } from '../../workflow/capability-catalog.js'
import { detectEntryPoints, reproBoundary, docCoverage } from '../../workflow/orient.js'
import { parseMalongignore } from '../../file-collector.js'

const ROUTE_ENUM = new Set(['understand', 'change', 'diagnose', 'review', 'maintain', 'document', 'isolate', 'system'])

export async function handle(args, context) {
  const { codeIndexService } = context
  const workspaceDir = args?.workspace_dir
  if (typeof workspaceDir !== 'string' || !workspaceDir) {
    return makeError('missing_parameter', 'workspace_dir is required', 'Pass the absolute project root path.')
  }
  if (!existsSync(workspaceDir)) {
    return makeError('invalid_input', `workspace_dir not found: ${workspaceDir}`)
  }
  const goal = args?.goal
  if (typeof goal !== 'string' || !goal.trim()) {
    return makeError('missing_parameter', 'goal is required', 'Describe the coding goal in one sentence.')
  }
  if (!codeIndexService) {
    return makeError('service_unavailable', 'codeIndex service not available')
  }
  if (args?.route != null && !ROUTE_ENUM.has(args.route)) {
    return makeError('invalid_input', `route must be one of ${[...ROUTE_ENUM].join(', ')} (got ${args.route})`)
  }
  const target = (args?.target && typeof args.target === 'object') ? args.target : null
  // 9-D：search_terms = 模型提供的概念词（假设，非事实）——确定性并入检索，不引入 LLM
  let searchTerms = null
  if (args?.search_terms != null) {
    if (!Array.isArray(args.search_terms)) {
      return makeError('invalid_input', 'search_terms must be an array of strings', 'Pass search_terms=["conceptTerm", ...] (model-supplied hypotheses, not facts).')
    }
    const cleaned = []
    for (const s of args.search_terms) {
      if (typeof s !== 'string') continue
      const t = s.trim()
      if (!t || t.length > 64) continue
      if (!cleaned.includes(t)) cleaned.push(t)
      if (cleaned.length >= 8) break
    }
    searchTerms = cleaned
  }

  // S2 去重：相同 request_id 不重复建任务（幂等）；同 ID 不同载荷拒绝（§7.6-2）
  if (args?.request_id) {
    const existingId = findByRequestId(workspaceDir, args.request_id)
    const existing = existingId ? getTask(workspaceDir, existingId) : null
    if (existing) {
      // 债务⑤修复：载荷比对用稳定哈希（stableStringify），JSON.stringify 对键序敏感 → 同载荷会被误判 request_conflict
      const sameTarget = payloadHash(existing.target || null) === payloadHash(target)
      // 第二轮审查：显式 route 也必须参与载荷比对（旧只比 goal/target，异 route 请求被静默去重丢弃）
      const sameRoute = (args?.route ?? null) === (existing.route ?? null)
      const sameTerms = payloadHash(args?.search_terms ?? null) === payloadHash(existing.search_terms ?? null)
      if (existing.goal !== goal || !sameTarget || (args?.route != null && !sameRoute) || !sameTerms) {
        return makeError('request_conflict', `request_id ${args.request_id} was used with a different goal/target/route`, 'Use a fresh request_id for a different task.')
      }
      return envelope({
        task: { task_id: existing.task_id, revision: existing.revision, route: existing.route, node: existing.node, lifecycle: existing.lifecycle },
        observation: { summary: `Deduplicated: request_id already created ${existing.task_id}.`, deduplicated: true, candidates: existing.candidates || [], read_refs: (existing.materials || []).map(m => m.read_ref) },
        allowed_actions: ['code_read', 'code_status'],
        extra: { request_id: args.request_id, next_step: `code_read(workspace_dir="${workspaceDir}", task_id="${existing.task_id}", ...)`, actions_note: ACTIONS_NOTE },
      })
    }
  }

  const task_id = newTaskId()
  const route = args?.route || inferRoute(goal)

  let indexInfo
  try {
    indexInfo = await ensureIndexed(codeIndexService, workspaceDir)
  } catch (e) {
    return makeError('index_failed', `Indexing failed: ${e.message}`, /malong-parse binary not found/.test(String(e.message)) ? 'Install malong-parse or set MALONG_PARSE_BIN (searched locations are listed in the message), then retry.' : 'Check the workspace is readable, or reindex with the reindex tool.')
  }

  let candidates = []
  const scanState = {}
  try {
    candidates = await findCandidates(codeIndexService, workspaceDir, goal, target, { files: indexInfo.files, scan_meta: scanState, search_terms: searchTerms })
  } catch {
    candidates = []
  }
  // R4（0.5.14 复审修复）：文件级目标直达——显式 target.file 存在且可读时，首屏第一动作就是读该文件；
  // 「没有目标符号」≠「没有目标文件」（Markdown/配置/无符号脚本同样是明确目标；
  // 原 007/067：中文 document 任务给了 README.md 却退到结构浏览，响应 43.7k/45.7k 字符且建议读无关代码文件）。
  const rawTargetFile = typeof target?.file === 'string' ? target.file : (typeof target?.file_path === 'string' ? target.file_path : null)
  const targetRel = rawTargetFile ? toWorkspaceRel(rawTargetFile, workspaceDir) : null
  let fileTarget = null
  if (targetRel) {
    let readable = false
    try { readable = existsSync(join(workspaceDir, targetRel)) && statSync(join(workspaceDir, targetRel)).isFile() } catch {}
    if (readable) {
      let symbolCount = 0
      try {
        const o = await codeIndexService.getFileOutline?.(targetRel, { depth: 0 })
        symbolCount = (o?.outline || o?.symbols || o?.functions || []).length
      } catch {}
      fileTarget = { file: targetRel, readable: true, symbols: symbolCount, has_symbols: symbolCount > 0 }
    } else {
      fileTarget = { file: targetRel, readable: false, reason: 'not_found_or_not_file' }
    }
  }
  const directRead = fileTarget?.readable
    ? {
      tool: 'code_read',
      args: { workspace_dir: workspaceDir, task_id, locator: { file_path: fileTarget.file, ...(typeof target?.symbol === 'string' && target.symbol ? { name: target.symbol } : {}) } },
      note: fileTarget.has_symbols
        ? 'Explicit file target (readable): read it directly — no symbol search needed. If you will edit several places in one file: read once, then submit ALL edits in ONE code_batch (dry_run first, then reuse writes with dry_run:false).'
        : 'Explicit file target (readable; ' + fileTarget.symbols + ' indexed symbol(s) — likely doc/config/script): read it directly. A file target is a target even without code symbols.',
    }
    : null
  // WP08R-3 A4：首屏候选上限 8，但截断不静默——candidates_total + summary 明示（R6 实测 12→8 后模型不知道还有）
  const CAND_LIMIT = 8
  const top = candidates.slice(0, CAND_LIMIT)
  const candidatesTotal = candidates.length
  const candidatesTruncated = candidatesTotal > top.length
  // F3（0.5.14 Windows 复核）：置信度与测试候选可见性——低置信时不得把夹具/噪声当可信目标推「下一步」
  const conf = scanState.confidence || null
  const TESTY_PATH = /(^|\/)(tests?|__tests__|specs?|fixtures?|mocks?|samples?|benchmarks?)(\/|$)|\.(test|spec)\.[^/]+$|_test\.[^/]+$/i
  const testPathCandidates = candidates
    .filter(c => TESTY_PATH.test(String(c.file_path || '')))
    .slice(0, 3)
    .map(c => ({ file_path: c.file_path, name: c.name, kind: c.kind || null, rank_reason: c.rank_reason || null, note: 'test/fixture path — kept visible; ranked after production candidates' }))
  const lowConfidence = conf?.level === 'low'
  const confidenceNote = lowConfidence
    ? 'Candidates are LOW-CONFIDENCE: the strongest hits are test/fixture (or weak generic) matches, not evidence that they are the target. ' + (conf?.best_production ? 'Best production candidate: ' + conf.best_production.file + '::' + conf.best_production.name + '.' : 'No production candidate scored a strong match.') + ' Refine with target={file|symbol} or backticked identifiers.'
    : (conf?.level === 'medium' ? 'Medium confidence: the top hit is a production path but the match is generic/substring — verify it is the right target.' : null)

  const task = {
    task_id,
    revision: 1,
    schema_version: TASK_SCHEMA_VERSION,
    graph_version: GRAPH_VERSION,
    route,
    goal,
    target,
    workspace_dir: workspaceDir,
    lifecycle: 'active',
    node: 'orient',
    // T18：记录扫描范围（截断 ≠ 全量已查）；证据/状态据此标注 limitation
    index_scope: { files_scanned: indexInfo.files_scanned, files_indexed: indexInfo.files_indexed, truncated: !!indexInfo.truncated,
      // WP05：workspace 索引忽略与 Git 忽略明确区分——扫描范围由 .malongignore+内置默认决定，
      // 不读写用户 .gitignore；状态目录的 git 提交排除走 .git/info/exclude，两者互不影响
      ignore_scope: 'workspace scan: .malongignore + built-in defaults; git tracking: untouched (state dirs excluded via .git/info/exclude)' },
    created: new Date().toISOString(),
    materials: [],
    candidates: top,
    ...(searchTerms && searchTerms.length ? { search_terms: searchTerms } : {}),
    ...(args?.request_id ? { request_id: args.request_id } : {}),
  }
  putTask(workspaceDir, task, { type: 'task_created', task })

  // R4：显式文件目标直达时不展开 impact 导航（入口预算；按需 code_query(mode="impact")）
  const nav = (top.length && !directRead) ? await impactOf(codeIndexService, top[0], 6) : null
  // R4：显式文件目标直达时不再展开结构/导航（入口预算）；结构按需用 code_query(mode="outline"|"map") 展开
  const needStructure = !directRead && (route === 'system' || route === 'document' || top.length === 0)
  const structure = needStructure
    ? await structureSummary(codeIndexService, indexInfo.files || [], { limit: 20, workspaceDir })
    : null
  const structModules = structure?.modules || []
  const structErrors = structure?.errors || []
  // 8-A（2026-10-07 专家复测 §1）：零候选不再只给 <path> 模板——从结构概览挑真实文件/符号给出可调用下一步
  // 9-A（2026-10-07 专家 Lite 建议）：按信息价值排序（入口点>业务目录>文档；噪声降权），并附紧凑仓库地图
  const zeroGuidance = (!directRead && top.length === 0)
    ? buildZeroHitGuidance(structModules, { workspaceDir, task_id, entryFiles: detectEntryPoints(workspaceDir).files })
    : null
  let navigation = null
  if (zeroGuidance) {
    try {
      const nav = await context?.repoMapService?.generateCompact?.(workspaceDir, { workspaceDir, maxTokens: 700, pageSize: 12 })
      if (nav && !nav.error && nav.map) {
        navigation = {
          kind: 'repo_map_compact',
          map: nav.map,
          tokens_estimate: nav.tokens,
          top_entries: (nav.skeleton || []).slice(0, 12),
          truncated: !!nav.truncated,
          ...(nav.index_stale_note ? { index_stale_note: nav.index_stale_note } : {}),
          note: 'Browse entry (compact repo map) — NOT a query hit; refine with search_terms or target={file|symbol} when irrelevant.',
        }
      }
    } catch {}
  }

  // S5.3 路由纵切首屏（不猜业务影响；启发式附 note）
  let orientation = null
  if (route === 'system') {
    orientation = { kind: 'system', entry_points: detectEntryPoints(workspaceDir), structure: structModules, ...(structErrors.length ? { structure_errors: structErrors } : {}) }
  } else if (route === 'isolate') {
    orientation = { kind: 'isolate', boundary: reproBoundary(nav), limitations: nav ? [] : ['no candidate symbol to bound; pass target.symbol'] }
  } else if (route === 'document') {
    orientation = { kind: 'document', coverage: docCoverage(workspaceDir, structModules) }
  }
  const summaryParts = [`Task accepted (route=${route}).`]
  if (top.length) summaryParts.push(`${top.length} candidate symbol(s); top = ${top[0].file_path}::${top[0].name}.`)
  if (candidatesTruncated) summaryParts.push('Showing top ' + top.length + ' of ' + candidatesTotal + ' candidate symbol(s) — ' + (candidatesTotal - top.length) + ' more exist; narrow with target={file|symbol} or search_terms to surface them.')
  if (nav) summaryParts.push(`Impact of top candidate: ${nav.caller_count?.direct || 0} direct + ${nav.caller_count?.indirect || 0} indirect caller(s), risk=${nav.risk_level || 'n/a'}.`)
  if (structModules.length) summaryParts.push(`Repo structure: ${structModules.length} module(s)${structErrors.length ? ` (${structErrors.length} unreadable)` : ''}.`)
  if (orientation?.kind === 'system') summaryParts.push(`Entry points: ${orientation.entry_points.files.length}.`)
  if (orientation?.kind === 'isolate' && orientation.boundary) summaryParts.push(`Repro boundary: ${orientation.boundary.files.length} file(s), ${orientation.boundary.callee_count} callee(s).`)
  if (orientation?.kind === 'document' && orientation.coverage?.coverage != null) summaryParts.push(`Doc coverage: ${orientation.coverage.documented}/${orientation.coverage.total}.`)
  if (!top.length) summaryParts.push('No symbol candidates under the current scan scope (zero hits are not proof of absence). See observation.next_candidates + next_action (top-level) for concrete reads, or start a new code_task with target={file} or target={symbol}.')
  if (confidenceNote) summaryParts.push(confidenceNote)
  if (testPathCandidates.length && !directRead) summaryParts.push('Test/fixture candidates kept visible: ' + testPathCandidates.map(c => c.file_path + '::' + c.name).join(', ') + ' (ranked after production candidates).')
  // R4：文件级目标明确时，把「读该文件」作为唯一主动作说明；目标缺失时明确拒绝而非用无关结构掩盖
  if (directRead) summaryParts.push('Explicit file target ' + fileTarget.file + ' is readable (' + fileTarget.symbols + ' indexed symbol(s)) — read it directly; structure/navigation omitted by the entry budget.')
  else if (fileTarget && !fileTarget.readable) summaryParts.push('Explicit file target ' + fileTarget.file + ' was NOT found or unreadable — verify the path; the candidates below are from other locations, not the requested file.')

  // 残留①：扫描覆盖度不足必须显式提示（截断 ≠ 全量已查）
  const contentScan = scanState.content || null
  const scanWarnings = []
  if (contentScan?.truncated) {
    scanWarnings.push(`Content scan truncated: scanned ${contentScan.files_scanned}/${contentScan.files_considered} file(s) (limits: ${contentScan.max_files} files, ${contentScan.max_bytes}B/file${contentScan.files_skipped_large ? `, ${contentScan.files_skipped_large} large file(s) skipped` : ''}); candidates may be incomplete — raise MALONG_CONTENT_SCAN_MAX_FILES / MALONG_CONTENT_SCAN_MAX_BYTES or narrow target.`)
  }
  if (scanState.target_dir?.truncated) {
    scanWarnings.push(`Target directory file list truncated at ${scanState.target_dir.files} file(s); candidates may be incomplete.`)
  }
  if (scanState.anchor && !scanState.anchor.matched) {
    scanWarnings.push(`Target symbol "${scanState.anchor.target_symbol}" not found in target file ${scanState.anchor.target_file}; candidates are ranked from other locations — verify the name/file or read the file directly.`)
  }
  if (contentScan?.non_ascii_goal && !top.length) {
    scanWarnings.push('Goal contains non-ASCII text but no ASCII identifiers were found to search; pass target={file|symbol}, quote exact identifiers in backticks, or code_read a file directly.')
  }
  if (scanWarnings.length) summaryParts.push(scanWarnings[0])

  // R2：无 target 时候选仅来自索引集（.malongignore 排除文件不在内）——显式附注，防镜像/空候选误导
  let scanScopeNote = null
  let targetNote = null
  if (!target) {
    try {
      const rules = parseMalongignore(workspaceDir + '/.malongignore')
      if (rules.length) scanScopeNote = `Candidates come from indexed files only; .malongignore has ${rules.length} rule(s) (excluded files are skipped). Pass target={file} to scan an excluded path.`
    } catch {}
  } else {
    // 12-B（专家 05109e1）：target 是锚点/亲和提示，不是严格 scope 过滤——显式讲清
    targetNote = 'target is an anchor/affinity hint (boost + target-dir scan), NOT a strict scope filter — candidates outside target may still be returned.'
  }

  // 13-D（专家 c2a83e4 建议）：按文件聚合视图（仅展示层，不改平铺候选排序）——减少同文件重复项占满首屏
  const groupMap = new Map()
  for (const c of top) {
    const g = groupMap.get(c.file_path) || []
    g.push({ name: c.name, kind: c.kind, rank_reason: c.rank_reason || null, matched_terms: c.matched_terms || null })
    groupMap.set(c.file_path, g)
  }
  const fileGroups = [...groupMap.entries()].map(([file_path, syms]) => ({ file_path, count: syms.length, truncated: syms.length > 3, symbols: syms.slice(0, 3) }))

  const observation = {
    summary: summaryParts.join(' '),
    scope: top.map(c => `${c.file_path}::${c.name}`),
    target: target ? { locator: target } : null,
    ...(fileTarget ? { target_file: fileTarget } : {}),
    candidates: top,
    ...(conf ? { candidates_confidence: conf.level } : {}),
    ...(confidenceNote ? { candidates_note: confidenceNote } : {}),
    ...(testPathCandidates.length ? { test_path_candidates: testPathCandidates } : {}),
    ...(candidatesTruncated ? { candidates_total: candidatesTotal, candidates_truncated: true } : {}),
    ...(nav ? { navigation: nav } : {}),
    ...(structModules.length ? { structure: structModules } : {}),
    ...(structErrors.length ? { structure_errors: structErrors } : {}),
    orientation,
    index: { files_scanned: indexInfo.files_scanned, files_indexed: indexInfo.files_indexed, truncated: indexInfo.truncated },
    ...(contentScan ? { content_scan: contentScan } : {}),
    ...(scanState.search_terms_used ? { search_terms_used: scanState.search_terms_used } : {}),
    ...(scanWarnings.length ? { scan_warnings: scanWarnings } : {}),
    ...(zeroGuidance?.next_candidates?.length ? { next_candidates: zeroGuidance.next_candidates } : {}),
    ...(navigation ? { navigation } : {}),
    ...(scanScopeNote ? { scan_scope_note: scanScopeNote } : {}),
    ...(targetNote ? { target_note: targetNote } : {}),
    ...(fileGroups.length ? { file_groups: fileGroups, unique_candidate_files: fileGroups.length } : {}),
    body_excerpt: null,
    read_refs: [],
  }

  const loc = top[0]?.symbol_id
    ? `locator={"symbol_id":"${top[0].symbol_id}"}`
    : `locator={"file_path":"${top[0]?.file_path || '<path>'}"}`

  // H07（0.5.14）：情境能力提示（≤2 条、条件匹配 goal；只建议不执行）
  const capabilityHints = intentHints(String(goal || ''), { workspace_dir: workspaceDir })

  // H02/R4：预算降级步骤（最可牺牲在前；安全/失败/副作用/恢复字段不列入）
  const BUDGET_STEPS = [
    { name: 'navigation', apply: (o) => { if (o.observation && o.observation.navigation) o.observation.navigation = { omitted: true, reason: 'entry_budget', expand: 'code_query(mode="map")' } } },
    { name: 'structure_symbols', apply: (o) => { if (Array.isArray(o.observation?.structure)) o.observation.structure = o.observation.structure.slice(0, 8).map(m => ({ file: m.file, symbols: (m.symbols || []).slice(0, 2) })) } },
    { name: 'content_scan_detail', apply: (o) => { const c = o.observation?.content_scan; if (c) o.observation.content_scan = { files_scanned: c.files_scanned, files_considered: c.files_considered, truncated: c.truncated, omitted_detail: true } } },
    { name: 'file_groups', apply: (o) => { if (Array.isArray(o.observation?.file_groups)) { o.observation.file_groups_omitted = o.observation.file_groups.length; delete o.observation.file_groups; delete o.observation.unique_candidate_files } } },
    { name: 'candidates', apply: (o) => { const c = o.observation?.candidates; if (Array.isArray(c) && c.length > 3) { o.observation.candidates_total = o.observation.candidates_total || c.length; o.observation.candidates = c.slice(0, 3); o.observation.candidates_truncated = true } } },
    { name: 'next_candidates', apply: (o) => { const c = o.observation?.next_candidates; if (Array.isArray(c) && c.length > 2) o.observation.next_candidates = c.slice(0, 2) } },
    { name: 'scan_warnings', apply: (o) => { const w = o.observation?.scan_warnings; if (Array.isArray(w) && w.length > 2) { o.observation.scan_warnings_omitted = w.length - 2; o.observation.scan_warnings = w.slice(0, 2) } } },
    // N1（2026-10-19 专家 012）：精确 target 首屏仍超 6000——先削重复/辅助信息，
    // 不删安全/失败/恢复字段与版本锚点；计数仍由 fitVisibleBudget 在最终序列化上收敛。
    { name: 'next_step_duplicate', apply: (o) => { if (o.next_action && typeof o.next_step === 'string') { o.next_step_omitted = 'same as next_action (entry budget)'; delete o.next_step } } },
    { name: 'candidates_top1', apply: (o) => { const c = o.observation?.candidates; if (Array.isArray(c) && c.length > 1) { o.observation.candidates_total = o.observation.candidates_total || c.length; o.observation.candidates = c.slice(0, 1); o.observation.candidates_truncated = true } } },
    { name: 'summary', apply: (o) => { const s = o.observation?.summary; if (typeof s === 'string' && s.length > 420) o.observation.summary = s.slice(0, 400).replace(/[ ,;]+$/, '') + ' … (summary truncated by the entry budget; see observation fields + next_action)' } },
    { name: 'scope', apply: (o) => { const s = o.observation?.scope; if (Array.isArray(s) && s.length > 8) { o.observation.scope_total = s.length; o.observation.scope = s.slice(0, 8) } } },
    { name: 'capability_hints', apply: (o) => { if (Array.isArray(o.capability_hints) && o.capability_hints.length > 1) { o.capability_hints = o.capability_hints.slice(0, 1); o.capability_hints_omitted = true } } },
    { name: 'budget_note', apply: (o) => { const b = o.observation?.visible_char_budget; if (b) { b.note = 'Partial view: reduced fields are listed above; expand via the pointed actions. Safety/failure/recovery fields kept.'; delete b.suggestion } } },
    { name: 'test_path_candidates', apply: (o) => { const t = o.observation?.test_path_candidates; if (Array.isArray(t) && t.length) { o.observation.test_path_candidates_total = o.observation.test_path_candidates_total || t.length; o.observation.test_path_candidates_omitted = 'folded by the entry budget; query with code_query(mode="search") for test/fixture hits'; delete o.observation.test_path_candidates } } },
  ]
  // M4（2026-10-19 专家 Windows 复核）：精确文件目标的专属降级链。
  // 旧实现把同一串步骤套给「已给 target.file」的入口——最终 6270/6000，且 suggestion 还在要求
  // 「Narrow with target」，而目标已是最小单位。这里先把与「读这个文件」无关的候选细节/提示折叠掉。
  const FILE_TARGET_BUDGET_STEPS = [
    ...BUDGET_STEPS,
    { name: 'file_target_candidate_detail', apply: (o) => { const c = o.observation?.candidates; if (Array.isArray(c) && c.length) { o.observation.candidates_total = o.observation.candidates_total || c.length; o.observation.candidates = c.map(x => ({ file_path: x.file_path, name: x.name, kind: x.kind ?? null })); o.observation.candidates_detail_omitted = 'entry budget: file target already gives the read action; use code_query(mode="search") for candidate detail' } } },
    // 极长嵌套路径下 scope（file::symbol 字串列表）可吃掉 2k+ 字符，却与 target_file/next_action 重复表达同一事实
    { name: 'file_target_scope', apply: (o) => { const s = o.observation?.scope; if (Array.isArray(s) && s.length) { o.observation.scope_total = o.observation.scope_total || s.length; o.observation.scope_folded = 'entry budget: candidate scope list folded (target.file + next_action carry the read target); use code_query(mode="search") for candidate paths'; delete o.observation.scope } } },
    // observation.target 的 locator 与 target_file.file、next_action.args.locator 逐字重复——不是独立事实
    { name: 'file_target_target_dup', apply: (o) => { const t = o.observation?.target; if (t && t.locator) { o.observation.target_omitted = 'entry budget: duplicate of target_file.file + next_action locator'; delete o.observation.target } } },
    { name: 'file_target_candidates_fold', apply: (o) => { const c = o.observation?.candidates; if (Array.isArray(c) && c.length) { o.observation.candidates_total = o.observation.candidates_total || c.length; o.observation.candidates_folded = 'entry budget: candidates are not the target here (target.file is explicit) — query code_query(mode="search") with search_terms if you need alternatives'; delete o.observation.candidates } } },
    // target_note 是「target 只是亲和提示」的通用说明；显式文件已直达，保留它会误导（且占 139 字符）
    { name: 'file_target_note', apply: (o) => { if (typeof o.observation?.target_note === 'string') { o.observation.target_note_omitted = 'target.file is read directly (anchor caveat not applicable)'; delete o.observation.target_note } } },
    { name: 'file_target_summary', apply: (o) => { const s = o.observation?.summary; if (typeof s === 'string' && s.length > 240) o.observation.summary = s.slice(0, 220).replace(/[ ,;]+$/, '') + ' … (summary truncated; target_file + next_action carry the decision)' } },
  ]
  const steps = directRead ? FILE_TARGET_BUDGET_STEPS : BUDGET_STEPS
  // M4：精确文件目标的超预算建议不得再叫用户 Narrow target（自指）；只保留可展开出口与安全字段承诺
  const overSuggestion = directRead
    ? 'Entry still above the ' + CODE_TASK_FILE_TARGET_BUDGET + '-char visible budget after folding entry-only fields: remaining fields are the safety/recovery anchor set (target_file, index, next_action). Use next_action (code_read) directly; expand detail with code_query(mode="outline"|"search").'
    : null
  const out = envelope({
    task: { task_id, revision: 1, route, node: 'orient', lifecycle: 'active' },
    observation,
    allowed_actions: ['code_read', 'code_status'],
    extra: {
      ...(args?.request_id ? { request_id: args.request_id } : {}),
      ...(directRead ? { next_action: directRead }
        : zeroGuidance ? { next_action: zeroGuidance.next_action }
        : (top.length && lowConfidence && conf?.best_production
          ? {
            next_action: {
              tool: 'code_read',
              args: { workspace_dir: workspaceDir, task_id, locator: { file_path: conf.best_production.file, ...(conf.best_production.name ? { name: conf.best_production.name } : {}) } },
              note: 'Low-confidence candidates: read the best PRODUCTION candidate (test/fixture hits stay listed in observation.test_path_candidates — they are not recommended as the target).',
            },
          }
          : top.length && lowConfidence
            ? {
              next_action: {
                tool: 'code_query',
                args: { workspace_dir: workspaceDir, mode: 'search', query: goal },
                note: 'No production candidate matched strongly (only test/fixture or weak hits) — refine instead of reading an unrelated fixture: quote exact identifiers in backticks or pass target={file|symbol}. ' + (confidenceNote || ''),
              },
            }
            : (top.length ? {
        next_action: {
          tool: 'code_read',
          args: { workspace_dir: workspaceDir, task_id, ...(top[0]?.symbol_id ? { locator: { symbol_id: top[0].symbol_id } } : { locator: { file_path: top[0]?.file_path } }) },
          note: 'Read the top candidate to gather evidence; observation.candidates lists more. Multiple edits in one file: read once, then submit ALL edits in ONE code_batch (dry_run first, then reuse writes with dry_run:false).',
        },
      } : {}))),
      next_step: directRead
        ? ('code_read(workspace_dir=' + JSON.stringify(workspaceDir) + ', task_id=' + JSON.stringify(task_id) + ', locator=' + JSON.stringify(directRead.args.locator) + ')')
        : (zeroGuidance ? zeroGuidance.next_step
          : lowConfidence
            ? (conf?.best_production
              ? 'code_read(workspace_dir=' + JSON.stringify(workspaceDir) + ', task_id=' + JSON.stringify(task_id) + ', locator=' + JSON.stringify({ file_path: conf.best_production.file, ...(conf.best_production.name ? { name: conf.best_production.name } : {}) }) + ') — low confidence: best production candidate; test/fixture hits are listed but not recommended.'
              : 'code_query(workspace_dir=' + JSON.stringify(workspaceDir) + ', mode="search", query=<refined goal>) — low confidence (only test/fixture or weak hits); refine with target={file|symbol} or backticked identifiers.')
            : ('code_read(workspace_dir=' + JSON.stringify(workspaceDir) + ', task_id=' + JSON.stringify(task_id) + ', ' + loc + ')')),
      ...(capabilityHints.length ? { capability_hints: capabilityHints } : {}),
      actions_note: ACTIONS_NOTE,
    },
  })
  // H02/R4：入口可见文本预算（显式文件目标 6000 / 一般定位入口 12000）——超预算逐级降级，截断显式可展开
  return fitVisibleBudget(out, directRead ? CODE_TASK_FILE_TARGET_BUDGET : CODE_TASK_GENERAL_BUDGET, steps, overSuggestion ? { overSuggestion } : {})
}