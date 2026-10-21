// S1 只读入口共享逻辑：内存任务注册表 + envelope + 索引保障 + 候选定位。
// 不持久化（S1 state:false）；任务仅在当前 MCP 进程生命周期内有效。
import { existsSync, readFileSync, statSync } from 'node:fs'
import { randomBytes, createHash } from 'node:crypto'
import { join, relative, isAbsolute } from 'node:path'
import { DEFAULT_IGNORE_DIRS, collectFilesWithDirStats, parseMalongignore } from '../file-collector.js'
import * as store from './entry-store.js'
import { projectEffectiveState, inflightFacts } from '../workflow/effective-state.js'
import { checkAttempts, latestCheckScope, checkScopeForJob, unresolvedStoppedAttempt, stoppedAttemptResolutions, resolvedStoppedCheckOperationIds } from '../workflow/check-attempts.js'
import { listJobs } from '../workflow/jobs.js'

export function traceId() { return `trc_${Date.now()}_${randomBytes(3).toString('hex')}` }

// allowed_actions 语义（ADR-004）：它是「推荐下一步」而非权限清单——active 任务上
// 写/检/控制工具仍可调用（各自有前置校验）。显式告知，避免调用方当 ACL 读。
export const ACTIONS_NOTE = 'allowed_actions = recommended next steps, NOT permissions — other graph tools stay callable on an active task (dry_run defaults: patch previews).'

export function makeError(code, message, suggestion) {
  return { ok: false, error: code, code, message, ...(suggestion ? { suggestion } : {}), trace_id: traceId() }
}

// WP08R-5 P4：未知 task_id 错误可执行化——附同 workspace 活跃任务候选（防模型编造 task id 后无路可走）
export function unknownTaskError(workspaceDir, task_id) {
  let actives = []
  try { actives = (listTasks(workspaceDir) || []).filter(t => t.lifecycle !== 'cancelled').map(t => t.task_id).slice(0, 3) } catch {}
  const suggestion = actives.length
    ? 'Re-use an active task in this workspace (' + actives.join(', ') + ') or call code_task {workspace_dir, goal} to create a new one.'
    : 'Call code_task {workspace_dir, goal} to create a task first — do not invent a task_id.'
  return makeError('task_not_found', 'Unknown task_id: ' + task_id, suggestion)
}

// WP08R-5 P6：graph 接口读工具是 code_read——写错误透出前归一 read_symbol 旧名（classic 接口名称本就是 read_symbol，只在 S2/S3 出口调用）
export function normalizeReadToolText(text) {
  return typeof text === 'string' ? text.replace(/\bread_symbol\b/g, 'code_read') : text
}

// WP08R-5 P6：写错误 next_action 可执行化（params→args + 补 ctx）——与 G2 同形，共享给 maintain 等 handler
export function executableNextAction(na, ctx) {
  const tool = na?.tool === 'read_symbol' ? 'code_read' : na?.tool
  const src = (na?.args && typeof na.args === 'object') ? na.args : ((na?.params && typeof na.params === 'object') ? na.params : {})
  const args = { ...src }
  if (ctx?.workspace_dir != null && args.workspace_dir == null) args.workspace_dir = ctx.workspace_dir
  if (ctx?.task_id != null && args.task_id == null) args.task_id = ctx.task_id
  return { tool, args, note: na?.note || ('Re-run ' + tool + ' with these args to fill the failed write precondition.') }
}

// LH-001：终态写守卫——cancelled 任务拒绝一切新副作用操作（已完成操作的无副作用结果核对
// 由调用方先行的 request_id dedup 分支放行）。返回 error 对象，或 null（可写）。
export function assertTaskWritable(task) {
  if (task?.lifecycle === 'cancelled') {
    return makeError(
      'task_cancelled',
      `task ${task.task_id} is cancelled (terminal): new writes/operations are closed.`,
      'Call code_control(action="reopen") to continue this task, or create a new task with code_task.',
    )
  }
  return null
}

// 统一任务头：透出真实 lifecycle（禁止各 handler 硬编码 active）
export function taskHeader(task) {
  return { task_id: task.task_id, revision: task.revision, route: task.route, node: task.node, lifecycle: task.lifecycle }
}

export function envelope({ task = null, observation = null, allowed_actions = [], extra = {} }) {
  return {
    ok: true,
    ...(task ? { task } : {}),
    ...(observation ? { observation } : {}),
    ...(allowed_actions.length ? { allowed_actions } : {}),
    ...extra,
    trace_id: traceId(),
  }
}

// S2：任务状态改为持久化（ADR-001）；签名带 workspaceDir。
export function getTask(workspaceDir, task_id) { return store.getTask(workspaceDir, task_id) }
export function putTask(workspaceDir, task, event) { return store.putTask(workspaceDir, task, event) }
export function listTasks(workspaceDir) { return store.listTasks(workspaceDir) }
export function newTaskId() { return `task_${randomBytes(4).toString('hex')}` }
export function newOperationId() { return `op_${randomBytes(4).toString('hex')}` }
export function newEvidenceId() { return `ev_${randomBytes(4).toString('hex')}` }
export function sha256Hex(s) { return createHash('sha256').update(String(s)).digest('hex') }

// LH-005：路径归一（POSIX 语义）——win32 反斜杠/盘符大小写/混合分隔符统一处理，
// 供候选扫描、target 锚定、TEST_PATH_RE、file-arg 共用（旧各层各自 replace 导致失配）
export function toPosix(p) { return typeof p === 'string' ? p.replace(/\\/g, '/') : p }

// 绝对（含 Windows 盘符）→ 工作区相对；越界/跨风格 → null；相对原样（剥 ./ 与尾斜杠）
// 7-A（2026-10-07 专家复测 LH-004/006）：输入分类先于 base 风格——盘符相对（N:z.js）拒绝；
// 纯相对路径在任意 base（含盘符工作区）下保留工作区相对语义。旧实现见 bDrive 即要求 fDrive，
// win 工作区下相对路径恒 null → file-arg 归一成 '' 再拼回工作区根 → 目录当文件（dir_as_file）；
// 联合锚点 targetFile 丢失 → 同名符号在别的文件抢首。
export function toWorkspaceRel(file, workspaceDir) {
  if (typeof file !== 'string' || !file.trim()) return null
  let f = toPosix(file.trim()).replace(/^\.\//, '')
  const base = workspaceDir ? toPosix(workspaceDir).replace(/\/+$/, '') : null
  if (!base) return f.replace(/\/+$/, '') || null
  const fDrive = /^([A-Za-z]):\//.exec(f)
  const bDrive = /^([A-Za-z]):\//.exec(base)
  if (/^[A-Za-z]:/.test(f)) {
    // 绝对盘符路径（fDrive 有值）或盘符相对路径（N:z.js，拒绝）；base 也必须是盘符路径且同盘
    if (!fDrive || !bDrive) return null
    if (fDrive[1].toLowerCase() !== bDrive[1].toLowerCase()) return null
    const fr = f.slice(2), br = base.slice(2)
    if (fr.toLowerCase() === br.toLowerCase()) return null
    if (fr.toLowerCase().startsWith(br.toLowerCase() + '/')) return fr.slice(br.length + 1)
    const r = relative(br, fr)
    return (r && !r.startsWith('..') && !/^[A-Za-z]:/.test(r)) ? toPosix(r) : null
  }
  if (f.startsWith('/')) {
    if (bDrive) return null // POSIX 绝对路径 + 盘符工作区 = 跨风格拒绝
    const r = relative(base, f)
    return (r && !r.startsWith('..') && !isAbsolute(r)) ? toPosix(r) : null
  }
  if (f === '..' || f.startsWith('../')) return null
  return f.replace(/\/+$/, '') || null
}

export function hasNonAscii(s) { return /[^\x00-\x7F]/.test(String(s ?? '')) }

// S3.3（T20）：任务 schema/graph 版本。新建任务盖章；读/写入口对「更新的版本」显式拒绝（不猜）。
// 旧任务（无 schema_version）视为当前兼容，不强制迁移、不写盘（向后兼容 fixtures）。
export const TASK_SCHEMA_VERSION = 1
export const GRAPH_VERSION = '0.5.27'
export function ensureTaskVersion(task) {
  const v = task?.schema_version
  if (v == null) return { ok: true, legacy: true }
  if (v > TASK_SCHEMA_VERSION) return { ok: false, code: 'task_schema_newer', message: `schema_version=${v} is newer than supported ${TASK_SCHEMA_VERSION}` }
  return { ok: true }
}

// 文件内容哈希（读写路径共用）：缺失/不可读 → null，不抛
// malong-ignore: 版本锚定哈希，非密码学用途
export function fileHash(workspaceDir, rel) {
  try { return `sha256:${sha256Hex(readFileSync(join(workspaceDir, rel), 'utf-8'))}` } catch { return null }
}

// 统一操作写入：upsert 到 t.operations + 同步 node/result_kind + 生成 operation 事件
// （code_patch/code_batch 共用，§消重）
export function operationEvent(t, op, { node, result_kind } = {}) {
  const arr = [...(t.operations || [])]
  const i = arr.findIndex(o => o.operation_id === op.operation_id)
  if (i >= 0) arr[i] = op; else arr.push(op)
  t.operations = arr
  if (node) t.node = node
  if (result_kind) t.result_kind = result_kind
  return { type: 'operation', data: { operation: op, ...(node ? { node } : {}), ...(result_kind ? { result_kind } : {}) } }
}

// 稳定序列化：键排序，确保同载荷同哈希（跨进程/字段顺序无关）
function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']'
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}'
}
// 操作载荷哈希：同 request_id 必须同载荷，否则拒绝（§7.6-2）；同载荷重试幂等
// malong-ignore: 操作身份指纹，非密码学用途
export function payloadHash(obj) { return `sha256:${sha256Hex(stableStringify(obj))}` }

// 按 request_id 定位任务内操作（去重先于 CAS，§7.6）
export function findOperation(task, request_id) {
  if (!request_id || !Array.isArray(task?.operations)) return null
  return task.operations.find(o => o.request_id === request_id) || null
}
export function findByRequestId(workspaceDir, request_id) { return store.findByRequestId(workspaceDir, request_id) }
export function updateTaskCas(workspaceDir, task_id, expectedRevision, mutate, eventType) { return store.updateTaskCas(workspaceDir, task_id, expectedRevision, mutate, eventType) }

// P3（0.5.17 狗粮）：写后自动续基——成功写入且回读校验通过后，为该文件登记一个 write base（wbase_N），
// 下一次编辑可直接当 read_ref 用，不必为了拿 base 再 code_read 一遍刚写完的内容。
// 安全性不变：base = 本次写前校验的 result hash；两次写之间外部改动仍由 classifyConflict 报 FILE_CHANGED。
// 单列 write_bases 而不改 materials：读材料是历史事实，写基准是写操作副产品，两者审计语义不同。
// 纯 mutator：在调用方记录成功操作的同一 CAS 里调用——不额外推 revision、不额外记事件。
export const MAX_WRITE_BASES = 50
export function addWriteBasesToTask(t, workspaceDir, files, { operation_id = null } = {}) {
  const out = {}
  if (!t || !Array.isArray(files) || files.length === 0) return out
  if (!Array.isArray(t.write_bases)) t.write_bases = []
  for (const f of files) {
    if (!f?.file || !f?.hash) continue
    const seq = (t.write_base_seq || 0) + 1
    t.write_base_seq = seq
    let st = null
    try { st = statSync(join(workspaceDir, f.file)) } catch {}
    const ref = `wbase_${seq}`
    t.write_bases.push({
      read_ref: ref,
      origin: 'write',
      locator: { file_path: f.file },
      canonical_path: f.file,
      symbol: null,
      file_version: { hash: f.hash, size: st ? st.size : null, mtime: st ? new Date(st.mtimeMs).toISOString() : null },
      symbol_version: null,
      operation_id,
      created: new Date().toISOString(),
    })
    out[f.file] = ref
  }
  if (t.write_bases.length > MAX_WRITE_BASES) t.write_bases = t.write_bases.slice(-MAX_WRITE_BASES)
  return out
}

// P3 补齐（0.5.18，Windows 复核）：同 request_id 幂等重放时，从已持久化的 write_bases 恢复同一批
// wbase_*——调用方丢失首次响应后仍能免重读续写。只读已有记录，不新建基准、不推 revision；
// 已回收（超过 MAX_WRITE_BASES）时自然为空，由调用方回退到 code_read。
export function writeBasesForOperation(task, operationId) {
  const out = {}
  if (!operationId || !Array.isArray(task?.write_bases)) return out
  for (const b of task.write_bases) {
    if (b?.operation_id !== operationId) continue
    if (!b.canonical_path || !b.read_ref) continue
    out[b.canonical_path] = b.read_ref
  }
  return out
}

// 路由推断：goal 关键词 → plan §6.2 enum（显式 route 优先，服务端不再改）
const ROUTES = [
  ['change', /\b(add|implement|change|modify|refactor|fix|rename|edit|update|remove|delete|support)\b/i],
  ['diagnose', /\b(bug|error|fail|crash|why|debug|broken|incorrect|wrong|diagnose)\b/i],
  ['review', /\b(review|audit|risk|security|quality|lint)\b/i],
  ['maintain', /\b(clean|dead[ -]?code|dependency|upgrade|maintain)\b/i],
  ['document', /\b(document|docstring|comment)\b/i],
  ['isolate', /\b(isolate|minimal|repro|bisect)\b/i],
  ['system', /\b(architecture|structure|overview|map|orient|entry point|initializ)\b/i],
]
export function inferRoute(goal) {
  const g = String(goal || '')
  for (const [r, re] of ROUTES) if (re.test(g)) return r
  return 'understand'
}

const STOP = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'list', 'find', 'every', 'each',
  'what', 'which', 'when', 'where', 'file', 'files', 'function', 'functions', 'return', 'returns',
  'value', 'using', 'use', 'should', 'not', 'has', 'have', 'are', 'was', 'were', 'all', 'any',
  'its', 'their', 'implementation', 'identify', 'together', 'separately', 'empty', 'string',
  'input', 'argument', 'password', 'change', 'changes', 'affect', 'affected', 'transitively',
  'responsible', 'loading', 'initialization', 'order', 'starting', 'entry', 'point', 'currently',
  'hardcodes', 'unrelated', 'uses', 'number', 'project', 'repo', 'repository', 'python', 'javascript',
])

// F3（0.5.14 Windows 复核）：自然语言虚词不再当锚点——多词目标才过滤（≤2 token 原样保留），
// 反引号标识符始终保留。旧实现只有 12 个业务停用词，after/how/explain 这类虚词会命中名为 after 的局部变量
// 而挤占首屏（专家 005/035：首位是 Rust 夹具 Command，仅因 command/after 这类通用词命中）。
const NL_STOP = new Set(['after', 'before', 'how', 'what', 'when', 'where', 'which', 'while', 'who', 'why', 'does', 'did', 'do', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'and', 'or', 'but', 'if', 'then', 'than', 'that', 'this', 'these', 'those', 'there', 'their', 'them', 'it', 'its', 'of', 'in', 'on', 'at', 'to', 'for', 'from', 'with', 'without', 'into', 'over', 'under', 'about', 'as', 'by', 'so', 'such', 'not', 'no', 'only', 'also', 'can', 'could', 'should', 'would', 'will', 'shall', 'may', 'might', 'must', 'please', 'explain', 'describe', 'tell', 'show', 'list', 'find', 'locate', 'search', 'get', 'give', 'need', 'want', 'use', 'using', 'used', 'avoid', 'happen', 'happens', 'instead', 'again', 'still', 'just', 'very', 'more', 'most', 'less', 'least', 'first', 'last', 'already', 'because'])

export function extractTokens(goal) {
  const s = String(goal || '')
  const quoted = new Set()
  for (const m of s.matchAll(/`([^`]+)`/g)) quoted.add(m[1].trim())
  const bare = []
  for (const m of s.matchAll(/[A-Za-z_][A-Za-z0-9_]{2,}/g)) if (!bare.includes(m[0])) bare.push(m[0])
  const multiWord = (quoted.size + bare.length) > 2
  const keep = (t, isQuoted) => !!t && (isQuoted || (!STOP.has(t.toLowerCase()) && !(multiWord && NL_STOP.has(t.toLowerCase()))))
  const out = []
  for (const t of [...quoted, ...bare]) if (keep(t, quoted.has(t)) && !out.includes(t)) out.push(t)
  return out.slice(0, 12)
}

// S1：入口自带索引保障（graph 臂不含 reindex 工具）。小仓库直接全量增量索引；
// 超 5000 文件截断并标记（S1 面向合成小仓库/单仓定位，不做全量大仓审计）。
export async function ensureIndexed(codeIndexService, workspaceDir) {
  await codeIndexService.initWorkspace(workspaceDir)
  const igPath = join(workspaceDir, '.malongignore')
  const ignoreRules = existsSync(igPath) ? parseMalongignore(igPath) : []
  const pre = collectFilesWithDirStats(workspaceDir, {
    ignoreRules, ignoreDirs: new Set(DEFAULT_IGNORE_DIRS), maxFiles: 5000, hardCap: 5001,
  })
  const files = pre.files.map(f => f.path)
  const changed = await codeIndexService.indexBatch(files, workspaceDir, undefined, { prune: !pre.truncated })
  return {
    files_scanned: files.length,
    files_indexed: Array.isArray(changed) ? changed.length : 0,
    truncated: !!pre.truncated,
    files,
  }
}

// 结构总览：逐文件顶层符号（orientation/understand 路由的首屏价值）。
// LH-006：路径先归一（collector 产绝对路径，直传索引 API 必 miss）；错误不再静默吞——
// 返回 { modules, errors }（modules 失败项保留占位 symbols: []，errors 逐条归因）。
export async function structureSummary(codeIndexService, files, opts = {}) {
  const { limit = 20, workspaceDir = null } = (typeof opts === 'number') ? { limit: opts } : (opts || {})
  const modules = []
  const errors = []
  for (const raw of (files || []).slice(0, limit)) {
    const f = workspaceDir ? toWorkspaceRel(raw, workspaceDir) : toPosix(raw)
    if (!f) {
      errors.push({ file: String(raw), error: 'outside_workspace' })
      continue
    }
    try {
      const o = await codeIndexService.getFileOutline?.(f, { depth: 0 })
      if (o?.error) {
        errors.push({ file: f, error: String(o.error), ...(o.message ? { message: String(o.message).slice(0, 200) } : {}) })
        modules.push({ file: f, symbols: [] })
        continue
      }
      const arr = o?.outline || o?.symbols || o?.functions || []
      modules.push({ file: f, symbols: arr.slice(0, 8).map(i => ({ name: i.name, kind: i.type, line: i.line })) })
    } catch (e) {
      errors.push({ file: f, error: e?.message || 'outline_failed' })
      modules.push({ file: f, symbols: [] })
    }
  }
  return { modules, errors }
}

// 影响面：目标符号的调用者（直接+间接）与被调者——宿主文本工具看不到传递闭包。
export async function impactOf(codeIndexService, candidate, depth = 2) {
  if (!candidate?.file_path || !candidate?.name) return null
  let r
  try {
    r = await codeIndexService.getImpactAnalysis?.(candidate.file_path, { symbol: candidate.name, depth, maxCallers: 40, contextMode: 'none' })
  } catch { return null }
  if (!r || r.file_error) return null
  const norm = (c) => ({ type: c.type, name: c.function || c.name || c.target_name || null, file: c.file || c.file_path || c.source_file_path || null, line: c.line || 0, depth: c.depth })
  const callers = (r.callers || []).map(norm)
  const callees = (r.callees || []).map(c => ({ name: c.name || c.target_name || null, file: c.file || c.file_path || c.source_file_path || null, line: c.line || 0 }))
  return {
    symbol: candidate.name,
    file: candidate.file_path,
    caller_count: r.caller_count || { direct: callers.filter(c => c.type === 'direct').length, indirect: callers.filter(c => c.type === 'indirect').length },
    callers,
    callees,
    risk_level: r.risk_level || null,
    limitations: r.limitations || [],
  }
}

// 9-A（2026-10-07 专家 Lite 建议）：零候选导航升级——不再按结构顺序取前几个文件，
// 按信息价值排序（项目入口 > 业务目录 > 文档 > 其它；测试/基准/生成物/报告降权），
// 首符号跳过 __/变量类；每条标 kind=browse_entry + why（浏览入口，不冒充查询命中）。
const BROWSE_NOISE_DIRS = new Set(['test', 'tests', '__tests__', 'spec', '__mocks__', 'benchmark', 'benchmarks', 'bench', 'report', 'reports', 'dist', 'build', 'out', 'coverage', 'vendor', 'generated', 'fixture', 'fixtures'])
const BROWSE_BUSINESS_DIRS = new Set(['src', 'lib', 'app', 'internal', 'core', 'server'])
const BROWSE_DOC_DIRS = new Set(['doc', 'docs', 'documentation'])
function browseNorm(file) {
  const f = String(file || '')
  return f.startsWith('./') ? f.slice(2) : f
}
function browseRank(file, entrySet) {
  const f = browseNorm(file)
  if (entrySet.has(f)) return 0
  const segs = f.split('/').map(s => s.toLowerCase())
  const dirs = segs.slice(0, -1)
  if (dirs.some(d => BROWSE_BUSINESS_DIRS.has(d))) return 1
  if (dirs.some(d => BROWSE_DOC_DIRS.has(d)) || (segs[segs.length - 1] || '').toLowerCase().startsWith('readme')) return 2
  if (dirs.some(d => BROWSE_NOISE_DIRS.has(d))) return 4
  return 3
}
function browseWhy(rank) {
  return rank === 0 ? 'entry point (package.json main/bin)'
    : rank === 1 ? 'business source dir'
      : rank === 2 ? 'docs'
        : rank === 3 ? 'structure order fallback'
          : 'fallback (low-information path)'
}
function pickBrowseSymbols(symbols, maxSymbols) {
  const arr = (Array.isArray(symbols) ? symbols : []).filter(s => s && s.name && !s.name.startsWith('__'))
  const preferred = arr.filter(s => s.kind !== 'variable')
  const vars = arr.filter(s => s.kind === 'variable')
  return [...preferred, ...vars].slice(0, maxSymbols)
}
export function buildZeroHitGuidance(modules, { workspaceDir, task_id, entryFiles = [], maxFiles = 3, maxSymbols = 3 } = {}) {
  const entrySet = new Set((Array.isArray(entryFiles) ? entryFiles : []).map(browseNorm))
  const ranked = (Array.isArray(modules) ? modules : [])
    .map((m, i) => ({ m, i, rank: browseRank(m?.file, entrySet) }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
  const next_candidates = ranked
    .filter(x => x.m && x.m.file)
    .slice(0, maxFiles)
    .map(x => ({ file: x.m.file, symbols: pickBrowseSymbols(x.m.symbols, maxSymbols), kind: 'browse_entry', why: browseWhy(x.rank) }))
  const first = next_candidates.find(c => c.symbols.length) || next_candidates[0] || null
  if (first) {
    const name = first.symbols[0]?.name
    const locator = { file_path: first.file, ...(name ? { name } : {}) }
    return {
      next_candidates,
      next_action: {
        tool: 'code_read',
        args: { workspace_dir: workspaceDir, task_id, locator },
        note: 'Browse entries (ranked: entry points > business dirs > docs; NOT query hits). Read a concrete file/symbol, or refine with search_terms=[...] / target={file|symbol} when irrelevant.',
      },
      next_step: 'code_read(workspace_dir="' + workspaceDir + '", task_id="' + task_id + '", locator=' + JSON.stringify(locator) + ')',
    }
  }
  return {
    next_candidates,
    next_action: {
      tool: 'code_read',
      args: { workspace_dir: workspaceDir, task_id, locator: { file_path: '<path>' } },
      template: true,
      required_args: ['locator.file_path'],
      note: 'Zero candidates and no readable structure modules: pass a concrete file path, or refine with search_terms=[...] / target={file|symbol}.',
    },
    next_step: 'code_read(workspace_dir="' + workspaceDir + '", task_id="' + task_id + '", locator={"file_path":"<path>"}) — pass a concrete file path, or refine with search_terms=[...] / target={file|symbol}.',
  }
}

// LH-008/LH-013：下一步必须结构化——args 可直接调用；需要模型补编辑载荷的场景显式标 template + required_args。
// 8-B（2026-10-07 专家复测 §2）：按真实 lifecycle/result_kind/route 生成，禁止固定「S1 只读」文案。
// 14-B AC03：返回 null = 工具侧机械要求已满足（done 空动作）——调用方用 completionProjection() 透出合同字段。
export function buildTaskNextAction({ workspaceDir, task_id, task, read_ref = null, locator = null, canonical = null, p = null } = {}) {
  if (task?.lifecycle === 'cancelled') {
    return {
      tool: 'code_control',
      args: { workspace_dir: workspaceDir, task_id, action: 'reopen' },
      note: 'Task is cancelled; reopen to continue this task, or start a new code_task.',
    }
  }
  // WP01：有效性/在途统一取共享投影（p 未传则内部计算一次；所有出口共用同一投影结果）
  const proj = p || projectEffectiveState(workspaceDir, task)
  // 14-A AC31：在途优先——后台 job / 在途写操作不得被「完成」或「重新检查」覆盖（专家 ed28e0a：in_flight=1 仍 done）
  const flight = proj.in_flight
  if (flight) {
    // N2（0.5.14 Windows 复核）：已停止但效果未知（indeterminate）≠ 在途等待——
    // 旧实现返回 code_control status + progress=waiting（核查自指）。现在按已知事实给具体核查动作；
    // 无任何自动可查目标时明确交还宿主判断（tool=null + host_required），不把停止当回滚、不强制完成。
    if (flight.kind === 'indeterminate') {
      const review = indeterminateReview(task, { workspaceDir }) || []
      const files = [...new Set(review.flatMap(r => (Array.isArray(r.files) ? r.files : [])).filter(Boolean))]
      // M2/M3：说明是哪一次尝试（job/operation）——旧文案只说「an operation」，同任务多次检查时无法分辨
      const attemptIds = [...new Set(review.map(r => r.request_id || r.job_id || r.operation_id).filter(Boolean))]
      const attemptLabel = attemptIds.length ? ' (attempt ' + attemptIds.slice(0, 2).join(', ') + ')' : ''
      // 复核四 / P2（2026-10-19）：已停止 check 的恢复动作必须跟随共享投影里**真正未收口**的那次尝试。
      // 旧实现用 lastCheckParams（最近一次任何检查）：D(id) 取消 + E 重验后动作仍指 E；根对照成功后指根。
      // 覆盖事实已正确，问题只在消费者分支绕过了 proj.unresolved_check。
      const uc = proj.unresolved_check || null
      const ucScope = (uc && uc.scope) || null
      const remaining = Array.isArray(proj.unresolved_checks) ? proj.unresolved_checks.length : (uc ? 1 : 0)
      // 写操作永不被检查覆盖：仍有带文件目标的 indeterminate 写操作时，先做文件/哈希核查（安全优先）。
      const indetOps = (Array.isArray(task?.operations) ? task.operations : []).filter(o => o?.state === 'indeterminate')
      const writeOps = indetOps.filter(o => o?.kind !== 'check')
      const checkCtx = lastCheckParams(task, { workspaceDir })
      if (files.length) {
        return {
          tool: 'code_read',
          args: { workspace_dir: workspaceDir, task_id, locator: { file_path: files[0] } },
          progress: 'indeterminate',
          effect_judgment: 'host_required',
          effect_review: review,
          note: 'An operation was interrupted and its effect is UNCONFIRMED (stopped ≠ rolled back)' + attemptLabel + '. Re-read/re-hash the affected file(s) (' + files.slice(0, 4).join(', ') + ') and compare with the recorded intent' + (ucScope || checkCtx ? ', then re-run the stopped check scope (code_check run=true, same scope)' : '') + '. Retry writes only with a NEW request_id; do not force-complete.',
        }
      }
      // P2：选一条真正未收口的 check attempt，用它的 scope 生成下一步（与 effect_review 同一份事实）。
      if (ucScope) {
        return {
          tool: 'code_check',
          args: { workspace_dir: workspaceDir, task_id, checks: ucScope.checks, ...(ucScope.workdir != null ? { workdir: ucScope.workdir } : {}), ...(ucScope.timeout != null ? { timeout: ucScope.timeout } : {}), ...(ucScope.verifier ? { verifier: ucScope.verifier } : {}), run: true },
          optional: true,
          progress: 'indeterminate',
          effect_judgment: 'host_required',
          effect_review: review,
          unresolved_attempt: { attempt_id: uc.attempt_id ?? null, job_id: uc.job_id ?? null, operation_id: uc.operation_id ?? null, state: uc.state ?? null },
          note: 'A check attempt was stopped (' + (uc.attempt_id || uc.state || 'unknown') + '): its effect is NOT verified. Re-run the SAME recorded scope (' + ucScope.checks.join(',') + (ucScope.workdir != null ? ', workdir=' + ucScope.workdir : '') + (ucScope.timeout != null ? ', timeout=' + ucScope.timeout : '') + (ucScope.verifier ? ', verifier=' + ucScope.verifier : '') + ') — that is not a rollback proof; judge the effect yourself.' + (remaining > 1 ? ' (' + remaining + ' stopped attempts remain unresolved — each needs its own same-scope verification, in turn.)' : '') + (writeOps.length ? ' Also ' + writeOps.length + ' interrupted write operation(s) remain unconfirmed — checks do NOT cover write effects; re-read/re-hash their files first.' : ''),
        }
      }
      // 没有可重验的停止 check：若还有不带文件目标的写操作，沿用「按已记录检查复跑」的既有安全出口。
      if (writeOps.length && checkCtx) {
        return {
          tool: 'code_check',
          args: { workspace_dir: workspaceDir, task_id, ...checkReuseArgs(task, checkCtx.checks, { workspaceDir }), run: true },
          optional: true,
          progress: 'indeterminate',
          effect_judgment: 'host_required',
          effect_review: review,
          note: 'Interrupted operation with unconfirmed effects and no recorded target file' + attemptLabel + ' (stopped ≠ rolled back). Re-running the recorded checks re-establishes the current revision state — it does NOT prove the interrupted side effect was rolled back; judge that yourself. Do not force-complete.',
        }
      }
      return {
        tool: null,
        host_required: true,
        effect_judgment: 'host_required',
        progress: 'indeterminate',
        effect_review: review,
        note: 'Interrupted operation(s)' + attemptLabel + ' with unconfirmed effects and no automatable target (no affected file, no recorded checks, no live job). Host judgment required: inspect the workspace/behavior you can observe, then continue with a NEW request_id. No tool action is proposed — repeating the same request_id stays closed. Stopped ≠ rolled back.',
      }
    }
    return {
      tool: 'code_control',
      args: { workspace_dir: workspaceDir, task_id, action: flight.kind === 'job' ? 'job' : 'status', ...(flight.kind === 'job' ? { job_id: flight.job_id } : {}) },
      progress: 'waiting',
      note: inflightNote(flight),
    }
  }
  // M3（2026-10-19 专家 Windows 复核）：检查尝试已停止、效果未核——不能因更早的 validated 证据回 null（done）。
  // 给同一 scope 的 optional 重验（不证明回滚），历史证据与回执保留；重验出确定结果后本分支自然消失。
  if (proj.unresolved_check) {
    const uc = proj.unresolved_check
    const sc = uc.scope || null
    const remaining = Array.isArray(proj.unresolved_checks) ? proj.unresolved_checks.length : 1
    const pendingWrites = (Array.isArray(task?.operations) ? task.operations : []).filter(o => o?.state === 'indeterminate' && o?.kind !== 'check')
    const review = indeterminateReview(task, { workspaceDir })
    return {
      tool: 'code_check',
      args: { workspace_dir: workspaceDir, task_id, ...(sc ? { checks: sc.checks, ...(sc.workdir != null ? { workdir: sc.workdir } : {}), ...(sc.timeout != null ? { timeout: sc.timeout } : {}), ...(sc.verifier ? { verifier: sc.verifier } : {}) } : { checks: ['test'] }), run: true },
      optional: true,
      progress: 'indeterminate',
      effect_judgment: 'host_required',
      ...(review ? { effect_review: review } : {}),
      unresolved_attempt: { attempt_id: uc.attempt_id ?? null, job_id: uc.job_id ?? null, operation_id: uc.operation_id ?? null, state: uc.state ?? null },
      note: 'A check attempt was stopped (' + (uc.attempt_id || uc.state || 'unknown') + '): its effect is NOT verified, and earlier passing evidence does not cover it. Re-run the SAME recorded scope' + (sc ? ' (' + sc.checks.join(',') + (sc.workdir != null ? ', workdir=' + sc.workdir : '') + (sc.timeout != null ? ', timeout=' + sc.timeout : '') + (sc.verifier ? ', verifier=' + sc.verifier : '') + ')' : '') + ' to re-establish the current revision state — that is not a rollback proof; judge the effect yourself. Optional: if you can establish the effect another way, finish and report it as unverified.' + (remaining > 1 ? ' (' + remaining + ' stopped attempts remain unresolved — each needs its own same-scope verification, in turn.)' : '') + (pendingWrites.length ? ' Also ' + pendingWrites.length + ' interrupted write operation(s) remain unconfirmed — checks do NOT cover write effects; re-read/re-hash their files first.' : ''),
    }
  }
  if (task?.result_kind === 'partial') {
    // 狗粮r2 修复：区分「上次检查失败」与「尚未检查」——失败时正确动作是先改后重跑，而非「进一步编辑前先跑检查」
    // R3（0.5.14）：环境性未验证（最近一组检查全 skipped/unavailable）→ 允许 partial/unverified 交还，不循环重跑；
    // 重跑建议一律复用上次 checks/workdir/timeout/verifier（旧实现丢 workdir → 静默回工作区根）。
    const lastCheck = [...(task?.evidence || [])].reverse().find(e => ['test', 'typecheck', 'lint'].includes(e.kind))
    const lastCheckFailed = !!lastCheck && lastCheck.result === 'failed'
    const uv = !lastCheckFailed ? envUnverified(task) : null
    // N2/M3：后台检查被取消的“同范围重验”建议已上提到 unresolved_check 分支（见函数开头）；
    // 这里不再用 lastCheckJob 单独判「停止」——那会忽略「更新一次已确定成功/失败」的尝试，
    // 把已收口的任务重新报成未核（专家 M2/M3 的同一类时间序错误）。
    if (uv) {
      const uvParams = lastCheckParams(task, { workspaceDir })
      return {
        tool: 'code_check',
        args: { workspace_dir: workspaceDir, task_id, ...checkReuseArgs(task, uv.kinds, { workspaceDir }), run: true },
        optional: true,
        unverified: { reason: uv.reason, kinds: uv.kinds, detail: uv.detail, scope: (uv.scope ?? uvParams?.workdir ?? null) },
        note: 'Unverified: the selected checks have no runnable target in this workspace (' + uv.detail.join('; ') + ') — environment limitation, not a code defect. Finish and report the change as unverified, or add a check target and re-run with these args (same scope' + (uvParams?.workdir != null ? ', workdir=' + uvParams.workdir : '') + '). Do not edit code to satisfy this message.',
      }
    }
    return {
      tool: 'code_check',
      args: { workspace_dir: workspaceDir, task_id, ...checkReuseArgs(task, ['test'], { workspaceDir }), run: true },
      note: lastCheckFailed
        ? `The last check FAILED (${lastCheck.kind}): fix the code, then re-run code_check (run=true) with these args (same scope).`
        : 'A prior edit is unvalidated (result_kind=partial): run checks before further edits.',
    }
  }
  // 13-B（专家 c2a83e4 P2-a）：有效状态统一口径——validated 但失效（goal 漂移/文件变化/后台不确定）不得先进完成分支
  const stale = !!proj.freshness.result_stale
  if (task?.result_kind === 'validated' && stale) {
    if (task?.route === 'review') {
      return {
        tool: 'code_audit',
        args: { workspace_dir: workspaceDir, task_id, ...(canonical ? { files: [canonical] } : {}) },
        note: staleNote(proj.freshness.stale_reason, task, proj) + ' Route=review: run audit for the current goal; judge findings yourself.',
      }
    }
    // P3 修复（2026-10-12 狗粮）：audit-only 过期 → 指 code_audit（刷 test 无效果）
    if (auditOnlyStale(task, proj)) {
      return {
        tool: 'code_audit',
        args: { workspace_dir: workspaceDir, task_id, ...(canonical ? { files: [canonical] } : {}) },
        note: staleNote(proj.freshness.stale_reason, task, proj),
      }
    }
    return {
      tool: 'code_check',
      args: { workspace_dir: workspaceDir, task_id, ...checkReuseArgs(task, ['test'], { workspaceDir }), run: true },
      note: staleNote(proj.freshness.stale_reason, task, proj),
    }
  }
  // 9-C（2026-10-07 专家报告 P3）：validated 后复核为主，继续编辑降为可选（旧默认推回 code_patch 像「还要改」）
  if (task?.result_kind === 'validated') {
    // 13-B（专家 P2-b）：review 路线完成态由 audit 驱动——旧测试通过 ≠ 新目标已处理（适用性取投影 AC30 口径）
    if (task?.route === 'review' && proj.applicability.audit_applicable !== true) {
      return {
        tool: 'code_audit',
        args: { workspace_dir: workspaceDir, task_id, ...(canonical ? { files: [canonical] } : {}) },
        note: hasAuditEvidence(task)
          ? 'Prior audit evidence does not apply to the current goal/state (goal changed, files changed, or analyzer did not run) — re-run audit for the current goal; judge findings yourself.'
          : 'Selected checks passed (goal_revision ' + (task.validated_goal_revision || task.goal_revision || 1) + '), but route=review completion is audit-driven — run audit; judge findings yourself.',
      }
    }
    // 14-B AC03：非 review 路线的机械要求已满足 → 空动作（null）；done 合同（progress/mechanical/
    // goal_judgment）由调用方经 completionProjection 透出，工具不冒充业务目标完成。
    if (task?.route !== 'review') return null
    return {
      tool: 'code_status',
      args: { workspace_dir: workspaceDir, task_id },
      // 13-C（专家 c2a83e4 P3-b）：完成即交还——显式 awaiting_decision，不机械推荐继续调用
      awaiting_decision: true,
      note: 'Selected checks passed (goal_revision ' + (task.validated_goal_revision || task.goal_revision || 1) + '): done for this goal — decide to finish, review state/evidence, or continue editing (code_patch template).',
    }
  }
  if (task?.route === 'review') {
    // 13-C（专家 c2a83e4 P3-b）：已有 audit 证据 → 交还判断；14-A AC30：仅当证据适用于当前 revision/依赖（取投影口径）
    if (proj.applicability.audit_applicable === true) {
      return {
        tool: 'code_status',
        args: { workspace_dir: workspaceDir, task_id },
        awaiting_decision: true,
        note: 'Applicable audit findings are recorded — decide next: expand findings (code_control), fix via code_patch, or finish. No further action is required.',
      }
    }
    return {
      tool: 'code_audit',
      args: { workspace_dir: workspaceDir, task_id, ...(canonical ? { files: [canonical] } : {}) },
      note: hasAuditEvidence(task)
        ? 'Prior audit evidence does not apply to the current goal/state (goal changed, files changed, or analyzer did not run) — re-run audit for the current goal.'
        : 'Run read-only analyzers over the read scope (default checks).',
    }
  }
  if (task?.route === 'maintain') {
    return {
      tool: 'code_maintain',
      args: { workspace_dir: workspaceDir, task_id, action: 'plan', ...(canonical ? { files: [canonical] } : {}) },
      note: 'Propose safe import fixes (plan is read-only).',
    }
  }
  if (task?.route === 'change') {
    return {
      tool: 'code_patch',
      args: {
        workspace_dir: workspaceDir,
        task_id,
        ...(read_ref ? { read_ref } : (locator ? { locator } : {})),
        dry_run: true,
      },
      template: true,
      required_args: [
        ...(read_ref || locator ? [] : ['read_ref or locator']),
        'edit_mode',
        'content (replace_symbol) or patch.old_string/new_string (patch)',
      ],
      note: 'Anchored preview for the edit you are about to compose: add the edit payload, then pass dry_run=false to apply.',
    }
  }
  // WP03（12.5 八路线）：路线是分类与推荐，不复制八套流程——其余五路线显式只读出口。
  // 涉写/隔离的能力在 note 中点名，但缺载荷/锚点不算可直接调用（不假装可直接应用）。
  if (task?.route === 'understand') {
    return {
      tool: 'code_status',
      args: { workspace_dir: workspaceDir, task_id },
      note: 'Route=understand: read the listed candidates (code_read) until the requested material is read or no coverage is confirmed — answering from evidence is yours; no test run is required.',
    }
  }
  if (task?.route === 'diagnose') {
    return {
      tool: 'code_status',
      args: { workspace_dir: workspaceDir, task_id },
      note: 'Route=diagnose: run requested reproductions/checks via code_check (run=true) to collect evidence — cause hypotheses stay with you; a failed reproduction is not a successful diagnosis.',
    }
  }
  if (task?.route === 'document') {
    return {
      tool: 'code_status',
      args: { workspace_dir: workspaceDir, task_id },
      note: 'Route=document: gather code facts via code_read; document writes go through the same write path (code_patch template with required payload) — accuracy and wording are yours.',
    }
  }
  if (task?.route === 'isolate') {
    return {
      tool: 'code_status',
      args: { workspace_dir: workspaceDir, task_id },
      note: 'Route=isolate: worktree transactions run via code_worktree preview/apply (requires a changes payload); isolation purpose and scheduling stay with you.',
    }
  }
  if (task?.route === 'system') {
    return {
      tool: 'code_status',
      args: { workspace_dir: workspaceDir, task_id },
      note: 'Route=system: structure queries via code_task within budget; scope limits are reported as-is — architecture trade-offs stay with you.',
    }
  }
  return {
    tool: 'code_status',
    args: { workspace_dir: workspaceDir, task_id },
    note: 'Inspect task state or read another candidate.',
  }
}

// 13-B：review 完成态判定——有 audit 类证据才算走过审查（测试通过不算；专家 P2-b）
function hasAuditEvidence(task) {
  return (task?.evidence || []).some(e => String(e?.kind || '').startsWith('audit'))
}
// 14-A AC31：在途判定（live job 优先于在途 op）——buildTaskNextAction 与 resume 共用。
// WP01：实现收拢到 workflow/effective-state.inflightFacts；本壳保留旧返回形状（kind/what/state）。
export function inflightOf(workspaceDir, task) {
  const f = inflightFacts(workspaceDir, task)
  if (!f) return null
  if (f.kind === 'job') return { kind: 'job', job_id: f.job_id, state: f.state, what: f.what }
  return { kind: 'op', operation_id: f.operation_id, state: f.state, what: f.what }
}
export function inflightNote(f) {
  return f.state === 'running'
    ? 'In flight: ' + f.what + ' is running — wait for it or inspect via code_control; do not start a second run for the same check.'
    : 'In flight: ' + f.what + ' is ' + f.state + ' — verify file reality and task state via code_control before re-running or re-writing; do not start a second uncertain run.'
}

// ── R3/H06（0.5.14 复审修复）：检查参数复用 + 环境性未验证交还 + 不确定操作核对清单 ──
// R3 背景：无检查目标的子目录检查（skipped/partial）后，resume 仍无条件建议重跑 code_check 且丢 workdir（静默回工作区根）。
// 最近一次 check 操作记录了 checks/workdir/timeout/verifier——重跑建议必须复用它们；环境性未验证允许 partial/unverified 交还，不循环。
// N2（0.5.14 Windows 复核）：最近一次 check job（含「没给公开 request_id」的后台检查）。
// 旧路径只从 task.operations 找 check——无 request_id 的 async 检查不产生 operation，job 又只存 kind，
// 取消后 checks/workdir/timeout/verifier 全丢，resume 落到仓库根（专家 034–036）。
// N2（0.5.14 Windows 复核）：最近一次 check job（含「没给公开 request_id」的后台检查）。
// 只用作兼容壳：新口径一律走 workflow/check-attempts（操作+job 配对后按时间排序）。
export function lastCheckJob(task, { workspaceDir = null } = {}) {
  if (!workspaceDir || !task?.task_id) return null
  try {
    // listJobs 新→旧；只取本任务
    const jobs = listJobs(workspaceDir, { task_id: task.task_id, limit: 0 })
    return jobs.find(j => j?.kind === 'check') || null
  } catch { return null }
}

// M2/M3（2026-10-19 专家 Windows 复核）：检查尝试身份统一收拢到 workflow/check-attempts.js。
// 旧实现 lastCheckParams「有 check operation 就优先」——同一任务里先跑的 check-A（带 request_id）
// 会一直压住后开的 check-B（无 request_id 的 async job），取消 B 时回执报的却是 A 的 workdir/timeout；
// 旧证据又把「B 已停止」投影成 done。本壳保留旧导出名，口径只在新模块一处维护。
// M2：最新一次检查尝试的范围（恢复/重验建议的唯一来源——按时间而非「哪层先有记录」）。
export function lastCheckParams(task, { workspaceDir = null } = {}) {
  return latestCheckScope(task, { workspaceDir })
}

// M2：取消/效果核对——以被取消的那个 job 为权威，只按 operation_id 关联补全。
export { checkScopeForJob, checkAttempts }

// M3：存在「已停止、效果未核」的检查尝试，且之后没有确定结果覆盖——完成态不得越过它。
// （供测试/调试直接调用；正式出口从 projectEffectiveState().unresolved_check 取。）
export function unresolvedStoppedCheck(task, { workspaceDir = null } = {}) {
  return unresolvedStoppedAttempt(task, { workspaceDir })
}

// 重跑参数复用（缺省 checks 取 fallback；workdir/timeout/verifier 有则带）
export function checkReuseArgs(task, fallbackChecks = ['test'], opts = {}) {
  const p = lastCheckParams(task, opts)
  return {
    checks: (p && p.checks && p.checks.length ? p.checks : fallbackChecks),
    ...(p && p.workdir != null ? { workdir: p.workdir } : {}),
    ...(p && p.timeout != null ? { timeout: p.timeout } : {}),
    ...(p && p.verifier ? { verifier: p.verifier } : {}),
  }
}

// 最近一组检查证据是否全部为环境性未执行（skipped/unavailable）——若是，允许以 partial/unverified 交还（不循环重跑）
export function envUnverified(task) {
  const ev = Array.isArray(task?.evidence) ? task.evidence : []
  const checks = ev.filter(e => ['test', 'typecheck', 'lint'].includes(String(e?.kind || '')))
  if (checks.length === 0) return null
  const last = checks[checks.length - 1]
  const group = last?.operation_id ? checks.filter(e => e.operation_id === last.operation_id) : [last]
  if (group.length === 0) return null
  if (!group.every(e => ['skipped', 'unavailable'].includes(String(e?.result || '')))) return null
  return {
    reason: 'environment_limited',
    kinds: [...new Set(group.map(e => e?.kind).filter(Boolean))],
    detail: group.map(e => e.kind + ':' + e.result + (e?.actual?.notice ? ' (' + String(e.actual.notice).slice(0, 140) + ')' : '')),
    operation_id: last?.operation_id || null,
    scope: group.find(e => e && e.scope)?.scope ?? null,
  }
}

// H06：不确定操作（indeterminate）的核对清单——区分「进程已停止」「操作效果待核对」「目标是否完成」；
// 依据已有操作记录给出受影响文件 / pre·intended·result 哈希 / 原因，给具体核对入口；
// 不提供「强制完成 / 强制清账」捷径，也不建议换 id 盲重放。
// H06/N2（0.5.14 Windows 复核）：不确定操作的核对清单——只用已知事实，不编造哈希；
// 旧实现给 tool/file/files/hash 大多为 null 却要求「against these hashes」，且主 next_action 又回到 status/waiting（核查自指）。
// 现在：known（file/workdir/checks/命令/job/输出尾部）+ unknown（明确未记录的范围）+ effect_judgment=host_required + do_not；
// `check` 字段保留（兼容旧出口），但仅在已知目标时才提哈希核对。
// N2（0.5.14 Windows 复核）：已停止的后台检查 job 的效果核对——只用 job 里记录的范围快照，
// 不编造哈希、不把「进程已停」当成回滚。与 operation 版共用同一形状（known/unknown/effect_judgment/do_not）。
export function jobEffectReview(job) {
  const p = (job && job.params) || {}
  const checks = Array.isArray(p.checks) && p.checks.length ? [...p.checks] : null
  const scope = {
    ...(checks ? { checks } : {}),
    ...(p.workdir != null ? { workdir: p.workdir } : {}),
    ...(p.timeout != null ? { timeout: p.timeout } : {}),
    ...(p.verifier ? { verifier: p.verifier } : {}),
  }
  const hasScope = Object.keys(scope).length > 0
  const scopeText = hasScope
    ? (checks ? checks.join(',') : '<checks>') + ' (workdir=' + (p.workdir != null ? p.workdir : '<workspace root>') + (p.timeout != null ? ', timeout=' + p.timeout : '') + (p.verifier ? ', verifier=' + p.verifier : '') + ')'
    : null
  return {
    job_id: job?.job_id || null,
    kind: job?.kind || null,
    operation_id: job?.operation_id || null,
    request_id: job?.request_id || null,
    state: job?.state || null,
    stopped: job?.state === 'cancelled',
    known: { job_state: job?.state || null, ...scope },
    unknown: ['file hashes of any partially written files (check jobs do not write files)', 'whether the interrupted process left external side effects (build artifacts, test fixtures)'],
    effect_judgment: 'host_required',
    host_check: hasScope
      ? 'Process stopped before the job settled. Re-run the recorded check(s) ' + scopeText + ' to re-establish the CURRENT revision state — that does not prove the interrupted run was rolled back; judge the effect yourself.'
      : 'Process stopped and no scope was recorded — judge the effect from the workspace/behavior you can observe. Do not invent hashes.',
    do_not: [
      'Treat the stop as a rollback (cancel ≠ rollback; stopped ≠ effect checked).',
      'Re-run the checks in a different scope (repo root) and present that as the effect check.',
      'Force-complete or force-clear the job without checking the effect.',
    ],
  }
}

export function indeterminateReview(task, { workspaceDir = null } = {}) {
  // S2：已被更新、同范围确定重验收口的检查 operation 不再列入待核清单（写操作永不被检查收口）。
  let settledCheckOps = new Set()
  try { settledCheckOps = resolvedStoppedCheckOperationIds(task, { workspaceDir }) } catch {}
  const ops = (Array.isArray(task?.operations) ? task.operations : [])
    .filter(o => o?.state === 'indeterminate')
    .filter(o => !(o?.kind === 'check' && o?.operation_id && settledCheckOps.has(o.operation_id)))
  const out = ops.map(o => {
    const files = Array.isArray(o.files) ? o.files.filter(Boolean) : (o.file ? [o.file] : [])
    const pre = o.pre_file_hash ? { [o.file || '(file)']: o.pre_file_hash } : (o.pre_hashes || null)
    const intended = o.intended_file_hash ? { [o.file || '(file)']: o.intended_file_hash } : (o.intended_hashes || null)
    const result = o.result_file_hash ? { [o.file || '(file)']: o.result_file_hash } : (o.result_hashes || null)
    const hashes = (pre || intended || result) ? { pre_hashes: pre, intended_hashes: intended, result_hashes: result } : {}
    const known = {
      ...(files.length ? { files } : {}),
      ...(o.kind ? { kind: o.kind } : {}),
      ...(o.tool ? { tool: o.tool } : {}),
      ...(o.workdir != null ? { workdir: o.workdir } : {}),
      ...(o.command ? { command: String(o.command).slice(0, 200) } : {}),
      ...(o.operation_id ? { operation_id: o.operation_id } : {}),
      ...(o.request_id ? { request_id: o.request_id } : {}),
      ...(Array.isArray(o.checks) && o.checks.length ? { checks: [...o.checks] } : {}),
      ...(o.reason || o.error ? { reason: String(o.reason || o.error).slice(0, 200) } : {}),
    }
    const unknown = []
    if (!files.length) unknown.push('affected files (none recorded)')
    if (!pre) unknown.push('pre-edit file hashes')
    if (!result) unknown.push('post-operation file hashes')
    if (!o.command && !o.workdir) unknown.push('command/workdir of the interrupted work')
    const hostCheck = files.length
      ? 'Re-read/re-hash ' + files.join(', ') + ' and compare with the recorded intent' + (o.checks && o.checks.length ? ', then re-run the recorded check(s) (' + o.checks.join(',') + ') for the current revision' : '') + '.'
      : 'No automatable target was recorded — judge the effect from the workspace/behavior you can observe. Do not invent hashes.'
    return {
      operation_id: o.operation_id || null,
      kind: o.kind || null,
      request_id: o.request_id || null,
      tool: o.tool || null,
      file: o.file || null,
      files: files.length ? files : null,
      ...hashes,
      known,
      ...(unknown.length ? { unknown } : {}),
      reason: o.reason || o.error || null,
      effect_judgment: 'host_required',
      host_check: hostCheck,
      do_not: [
        'Treat the stop as a rollback (cancel ≠ rollback; stopped ≠ effect checked).',
        'Blind-replay the same request_id (it stays closed until reconciled).',
        'Force-complete or force-clear the operation without checking the effect.',
      ],
      check: (files.length || pre || intended)
        ? 'Stopped, effect unknown: verify the actual workspace state against the recorded file(s)/hashes (re-read the file / re-hash) before any retry; do not force-complete or blindly replay the same request_id.'
        : 'Stopped, effect unknown and no automatable target was recorded: host judgment required — do not force-complete or blindly replay the same request_id.',
    }
  })
  // N2/M3/S1：未被收口的停止检查尝试都要出现在同一份核对清单里，每条自带 job 快照范围、互不冒充。
  // S1：异范围（不同 workdir）的确定结果不覆盖 B；只有更新、同范围、checks 覆盖的后继确定尝试才收口。
  let resolutions = []
  try { resolutions = stoppedAttemptResolutions(task, { workspaceDir }) } catch { resolutions = [] }
  for (const r of resolutions) {
    if (r.resolved_by) continue
    const a = r.attempt
    if (!a.job) continue
    const dup = out.some(x => (x.job_id && a.job_id && x.job_id === a.job_id) || (x.operation_id && a.operation_id && x.operation_id === a.operation_id))
    if (!dup) out.push(jobEffectReview(a.job))
  }
  return out.length ? out : null
}
// 14-B AC03：机械要求满足判定（工具侧完成）——done 空动作 + host_required 的统一出口。
// 条件：validated 且未陈旧、无在途 job/op、route≠review（review 的完成由 audit 证据与 findings 交还驱动）。
// 返回 null 表示不适用；note 明说「仅工具侧完成」，不冒充业务目标达成。
export function completionProjection({ workspaceDir, task, p = null } = {}) {
  if (!task || task.lifecycle === 'cancelled') return null
  // WP01：机械要求满足 = 共享投影 progress=done（validated 且非陈旧、无在途/不确定、非终态）且 route≠review
  const proj = p || projectEffectiveState(workspaceDir, task)
  if (proj.progress !== 'done') return null
  if (task.route === 'review') return null
  const rev = task.validated_goal_revision || task.goal_revision || 1
  return {
    progress: 'done',
    mechanical_requirements_met: true,
    goal_judgment: 'host_required',
    note: 'Tool-side mechanical requirements are met for goal_revision ' + rev + ' — no further tool action is required. This reports tool-side completion only (mechanical_requirements_met=true, goal_judgment=host_required); it does not certify that the business goal is achieved.',
  }
}
// 13-B：失效原因文案（goal 变更 ≠ 文件变更；专家 P3-c）
// P3 修复（2026-10-12 狗粮）：file_change 且过期证据全为 audit 类时指 code_audit（跑 test 不会刷新 audit；
// 旧文案统一 re-run code_check，实测 validated 后仍提示重跑 test——与刷新目标无关）。判定抽 helper 供路由复用。
function auditOnlyStale(task, proj) {
  const ids = proj?.freshness?.stale_evidence || []
  const kinds = (task?.evidence || []).filter(e => ids.includes(e.evidence_id)).map(e => String(e.kind || ''))
  return kinds.length > 0 && kinds.every(k => k.startsWith('audit'))
}
function staleNote(reason, task, proj) {
  if (reason === 'goal_change') return 'Goal/route changed after validation: previous checks do not cover the current goal — re-run checks for the current goal.'
  if (reason === 'pending_work') return 'Background result indeterminate: re-run code_check(run=true) before trusting the prior validation.'
  if (auditOnlyStale(task, proj)) return 'Review (audit) evidence predates current files: re-run code_audit to refresh findings; test/check evidence is unaffected.'
  return 'Files changed after validation: re-run code_check(run=true) to refresh evidence.'
}

function enrich(codeIndexService, file, name, kind, startLine, endLine, type) {
  let symbol_id = null, range = endLine != null ? [startLine, endLine] : null, signature = null
  try {
    const rows = codeIndexService.findSymbolsInFile(file, name, kind || type)
    if (rows && rows.length) {
      const r = rows[0]
      symbol_id = r.stable_id || null
      if (r.start_line != null) range = [r.start_line, r.end_line]
      signature = r.signature || null
    }
  } catch {}
  return { name, kind: kind || type || null, file_path: file, symbol_id, range, signature, locator: { file_path: file, name, ...(symbol_id ? { symbol_id } : {}) } }
}

// 测试类路径不进内容候选（实现优先；测试文件靠 references/impact 触达）
const TEST_PATH_RE = /(^|\/)(tests?|__tests__|spec|__mocks__)(\/|$)|\.(test|spec)\.[^/]+$|_test\.[^/]+$/i
// 12-D：非生产路径（基准/工具脚本）——非 legacy 臂不进内容候选，符号候选与 tests 同层降权
// 13-E（live 狗粮）：dsh/bundle/ 是 .gitignore 的构建副本（reprep.sh 产物）——副本内容不应进候选挤占生产入口
const NON_PROD_PATH_RE = /(^|\/)(benchmarks?|bench)(\/|$)|(^|\/)dsh\/bundle(\/|$)/i

// 正文内容扫描（dogfood ①）：distinctive token 可能只出现在正文/字符串里（如 MALONG_INTERFACE），
// 符号名未必含它。按 target 目录优先扫描文件内容，命中行经 getSymbolsAtLine 映射回符号。
function contentMatches(workspaceDir, files, tokens, targetDir, { maxFiles, maxBytes, maxPerToken = 4, maxHits = 12, skipNonProd = false } = {}) {
  // 残留①：扫描上限可用 env 调（大仓免改代码）；覆盖度必须可归因
  const envMaxFiles = Number.parseInt(process.env.MALONG_CONTENT_SCAN_MAX_FILES, 10)
  const envMaxBytes = Number.parseInt(process.env.MALONG_CONTENT_SCAN_MAX_BYTES, 10)
  const scanMaxFiles = Number.isFinite(maxFiles) && maxFiles > 0 ? maxFiles : (envMaxFiles > 0 ? envMaxFiles : 400)
  const scanMaxBytes = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : (envMaxBytes > 0 ? envMaxBytes : 200_000)
  const ordered = targetDir
    ? [...files].sort((a, b) => (a.startsWith(targetDir + '/') ? 0 : 1) - (b.startsWith(targetDir + '/') ? 0 : 1))
    : files
  const hits = []
  const perToken = new Map()
  let scanned = 0
  const meta = {
    files_considered: ordered.length, files_scanned: 0, files_skipped_large: 0,
    files_truncated: false, hits_truncated: false, max_files: scanMaxFiles, max_bytes: scanMaxBytes,
  }
  for (const f of ordered) {
    if (scanned >= scanMaxFiles) { meta.files_truncated = true; break }
    if (hits.length >= maxHits) { meta.hits_truncated = true; break }
    if (TEST_PATH_RE.test(toPosix(f)) || (skipNonProd && NON_PROD_PATH_RE.test(toPosix(f)))) continue
    let src = null
    try {
      // live 审查 H5：先看大小再读——旧实现先 readFileSync 整读再比较，超大文件不进内存（上限形同虚设）
      const st = statSync(join(workspaceDir, f))
      if (st.size > scanMaxBytes) { meta.files_skipped_large++; continue }
      src = readFileSync(join(workspaceDir, f), 'utf-8')
    } catch { continue }
    if (src.length > scanMaxBytes) { meta.files_skipped_large++; continue } // 编码差异双保险
    scanned++
    meta.files_scanned = scanned
    const lines = src.split('\n')
    for (const t of tokens) {
      if ((perToken.get(t) || 0) >= maxPerToken) continue
      const matched = []
      for (let i = 0; i < lines.length && matched.length < 5; i++) {
        if (lines[i].includes(t)) matched.push(i + 1)
      }
      if (matched.length) {
        hits.push({ file: f, token: t, lines: matched })
        perToken.set(t, (perToken.get(t) || 0) + 1)
      }
      if (hits.length >= maxHits) break
    }
  }
  meta.truncated = meta.files_truncated || meta.hits_truncated || meta.files_skipped_large > 0
  return { hits, meta }
}

// 11-B：标识符词部件（camel/snake/kebab/数字边界）——模糊匹配与共现评分共用
export function wordParts(s) {
  const out = []
  for (const seg of String(s || '').split(/[^A-Za-z0-9]+/)) {
    if (!seg) continue
    const m = seg.match(/[A-Z]+(?![a-z])|[A-Z][a-z0-9]*|[a-z0-9]+/g) || [seg]
    for (const p of m) { const q = p.toLowerCase(); if (q.length >= 2) out.push(q) }
  }
  return out
}

// 11-B：单 token 对候选的匹配强度（0=不命中）：精确名 > 子串 > 词部件 > 路径词部件
function matchScore(token, name, filePath) {
  const t = String(token || '').toLowerCase()
  const n = String(name || '').toLowerCase()
  if (!t || !n) return 0
  if (n === t) return 60
  if (t.length >= 4 && n.includes(t)) return 45
  const tp = wordParts(token)
  const np = wordParts(name)
  let s = 0
  for (const p of tp) {
    if (p.length < 3) continue
    if (np.includes(p)) { if (s < 30) s = 30; continue }
    if (p.length >= 5 && np.some(q => q.length >= 5 && (q.includes(p) || p.includes(q)))) { if (s < 20) s = 20 }
  }
  if (s === 0 && t.length >= 4) {
    const fp = String(filePath || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
    if (fp.includes(t)) s = 15
    else if (t.length >= 5 && fp.some(p => p.length >= 5 && p.includes(t))) s = 12
  }
  return s
}

// 候选符号：显式 target.symbol/target.file 锚定优先；其次 goal token 的
// 内容命中（真实文件扫描）与符号名精确/模糊命中；最后按 target 路径亲和排序（同文件 > 同目录 > 全局）。
export async function findCandidates(codeIndexService, workspaceDir, goal, target, opts = {}) {
  // 收集器返回绝对路径（索引 API 用相对路径）——统一归一化为工作区相对路径，防跨层比较/拼接失配
  // LH-005：统一走 toWorkspaceRel（win 反斜杠/盘符/混合分隔符归一后再比较）
  const norm = (f) => toWorkspaceRel(f, workspaceDir)
  const files = (Array.isArray(opts.files) ? opts.files : []).map(norm).filter(Boolean)
  const seenFiles = new Set(files)

  // live 审查 H3：target.file 归一化为工作区相对路径——
  // 绝对路径直接 join 会双重拼接（join(ws,'/abs/ws/x')=ws+abs）；根级文件无斜杠不得当作目录
  const rawTarget = typeof target?.file === 'string' ? target.file
    : (typeof target?.file_path === 'string' ? target.file_path : null)
  let targetFile = rawTarget ? toWorkspaceRel(rawTarget, workspaceDir) : null
  const slashIdx = targetFile ? targetFile.lastIndexOf('/') : -1
  const targetDir = slashIdx > 0 ? targetFile.slice(0, slashIdx) : null
  // 扫描覆盖度归因（残留①）：handler 传入空对象，本函数填充后由调用方透出
  const scanMeta = (opts.scan_meta && typeof opts.scan_meta === 'object') ? opts.scan_meta : null

  // 显式 target 覆盖 .malongignore（用户指名即授权）：目标模块目录递归加入扫描集。
  // 现实场景：工作区的 .malongignore 排除某目录，但用户 target 明确指向其中文件。
  if (targetDir) {
    try {
      const extra = collectFilesWithDirStats(join(workspaceDir, targetDir), {
        ignoreRules: [], ignoreDirs: new Set(DEFAULT_IGNORE_DIRS), maxFiles: 800, hardCap: 801,
      })
      if (scanMeta) scanMeta.target_dir = { files: extra.files.length, truncated: !!extra.truncated }
      for (const e of extra.files) {
        const r = norm(e.path)
        if (r && !seenFiles.has(r)) { seenFiles.add(r); files.push(r) }
      }
    } catch {}
  }

  const seen = new Map()
  // F3（0.5.14 Windows 复核）：测试/夹具/噪声与生产实现分档（测试候选仍可见，不再与实现同层竞争首屏）
  const TESTY_PATH_RE = /(^|\/)(tests?|__tests__|specs?|fixtures?|mocks?|samples?|benchmarks?)(\/|$)|\.(test|spec)\.[^/]+$|_test\.[^/]+$/i
  const isTestyPath = (f) => TESTY_PATH_RE.test(toPosix(f))
  const goalHasTestIntent = /(^|[^A-Za-z])(tests?|specs?|fixtures?|benchmarks?|mocks?|测试|用例|夹具)([^A-Za-z]|$)/i.test(String(goal || ''))
  // 11-B：排序/收集改进开关——legacy 回放 A/B 臂（旧插入序），默认改进路径
  const legacy = opts.legacy_ranking === true || process.env.MALONG_RETRIEVAL_LEGACY === '1'
  const seenCap = legacy ? 12 : 40
  const add = (c, anchor = false) => {
    const k = `${c.file_path}::${c.name}`
    if (!seen.has(k)) seen.set(k, { c, anchor, order: seen.size })
  }

  if (target?.symbol) {
    try {
      const defs = await codeIndexService.findDefinitions(target.symbol, { limit: 10, includeMethods: true })
      for (const d of defs) add(enrich(codeIndexService, d.path || d.file, d.name, d.type, d.start_line, d.end_line, d.type), true)
    } catch {}
  }

  // target.file 锚定：文件顶层符号（不依赖 token 命中；即「从这个文件出发」）
  if (targetFile) {
    try {
      const o = await codeIndexService.getFileOutline?.(targetFile, { depth: 0 })
      const arr = o?.outline || o?.symbols || o?.functions || []
      for (const i of arr.slice(0, 6)) {
        const name = i.name || i.symbol
        if (!name) continue
        add(enrich(codeIndexService, targetFile, name, i.type, i.line ?? i.start_line, i.end_line ?? i.line, i.type))
      }
    } catch {}
  }

  // 9-D（2026-10-07 专家 Lite 建议）：模型提供的概念词（假设，非事实）优先并入检索 token
  const goalTokens = extractTokens(goal)
  const extraTerms = Array.isArray(opts.search_terms) ? opts.search_terms.filter(t => typeof t === 'string' && t.trim()).map(t => t.trim()) : []
  const tokens = [...new Set([...extraTerms, ...goalTokens])].slice(0, 16)
  const goalNonAscii = hasNonAscii(goal)
  if (scanMeta) {
    scanMeta.tokens = tokens
    if (extraTerms.length) scanMeta.search_terms_used = [...new Set(extraTerms)].slice(0, 8)
  }

  // 内容命中：distinctive token（≥6 字符）真实文件扫描（codeSearchService 仅符号名检索，不能替代）
  const distinctive = tokens.filter(t => t.length >= 6).slice(0, 3)
  if (distinctive.length && files.length) {
    const { hits, meta: contentMeta } = contentMatches(workspaceDir, files, distinctive, targetDir, legacy ? {} : { maxHits: 24, maxPerToken: 6, skipNonProd: true })
    if (scanMeta) scanMeta.content = contentMeta
    for (const hit of hits) {
      if (seen.size >= seenCap) break
      // 同一文件的命中行可能落在注释/字符串（不在任何符号内）——逐行尝试映射，首个命中符号为准
      let sym = null
      for (const line of (hit.lines || []).slice(0, 5)) {
        try { const rows = await codeIndexService.getSymbolsAtLine?.(hit.file, line); if (Array.isArray(rows) && rows[0]) { sym = rows[0]; break } } catch {}
      }
      if (sym) add(enrich(codeIndexService, hit.file, sym.name, sym.type, sym.start_line, sym.end_line, sym.type))
      else add({ name: hit.token, kind: 'content', file_path: hit.file, symbol_id: null, range: [hit.lines?.[0] || 1, hit.lines?.[0] || 1], signature: null, locator: { file_path: hit.file } })
    }
  } else if (scanMeta) {
    const skipped = distinctive.length
      ? 'no files to scan'
      : tokens.length === 0 && goalNonAscii
        ? 'non_ascii_goal'
        : (goalNonAscii ? 'non-ASCII goal: no distinctive ASCII token; quote identifiers in backticks' : 'no distinctive token (>=6 chars) in goal')
    scanMeta.content = {
      files_considered: files.length,
      files_scanned: 0,
      skipped,
      ...(skipped === 'non_ascii_goal' ? { hint: 'Non-ASCII goals cannot drive content scan. Pass target={file:"<path>"} (absolute or workspace-relative; target-directed scan covers .malongignore), target={symbol:"Name"}, or quote ASCII identifiers in backticks (e.g. `FooBar`).' } : {}),
      ...(tokens.length === 0 && goalNonAscii ? { non_ascii_goal: true } : {}),
      truncated: false,
      max_files: 0,
      max_bytes: 0,
    }
  }

  for (const t of tokens) {
    if (seen.size >= seenCap) break
    try {
      // 11-B：方法（method）默认被 findDefinitions 过滤——token 恒看不到类方法（malong-08 残差）
      const defs = await codeIndexService.findDefinitions(t, { limit: legacy ? 5 : 10, includeMethods: !legacy })
      for (const d of defs) add(enrich(codeIndexService, d.path || d.file, d.name, d.type, d.start_line, d.end_line, d.type))
    } catch {}
  }
  // 11-B：子串命中恒开（旧实现仅在全空时兜底）——大小写/词部件变体（entity↔EntityRegistry）
  if (!legacy || seen.size === 0) {
    for (const t of tokens) {
      if (seen.size >= seenCap) break
      try {
        const rows = await codeIndexService.searchSymbols(t, { limit: 6 })
        for (const r of rows) add(enrich(codeIndexService, r.file, r.name, r.type, r.start_line, r.end_line, r.type))
      } catch {}
    }
  }
  // 11-B：路径命中——token 词部件命中文件路径（上限 6 文件 × 2 符号）
  if (!legacy) {
    let added = 0
    for (const f of files) {
      if (added >= 6 || seen.size >= seenCap) break
      const fp = toPosix(f).toLowerCase().split(/[^a-z0-9]+/).filter(p => p.length >= 3)
      const hit = tokens.some(t => {
        const tl = t.toLowerCase()
        return fp.includes(tl) || (tl.length >= 5 && fp.some(p => p.length >= 5 && (p.includes(tl) || tl.includes(p))))
      })
      if (!hit) continue
      try {
        const o = await codeIndexService.getFileOutline?.(f, { depth: 0 })
        const arr = o?.outline || o?.symbols || o?.functions || []
        for (const i of arr.slice(0, 2)) {
          const name = i.name || i.symbol
          if (!name) continue
          add(enrich(codeIndexService, f, name, i.type, i.line ?? i.start_line, i.end_line ?? i.line, i.type))
        }
        added++
      } catch {}
    }
  }

  // live 审查 H4：显式 target.symbol 兜底——方法/嵌套符号可能未被任一档命中；只要锚点缺席就补一轮按名检索
  if (target?.symbol && ![...seen.values()].some(e => e.c.name === target.symbol)) {
    try {
      const rows = await codeIndexService.searchSymbols(target.symbol, { limit: 6 })
      for (const r of rows) add(enrich(codeIndexService, r.file, r.name, r.type, r.start_line, r.end_line, r.type))
    } catch {}
  }

  // 排序：显式锚点/精确名命中 > target 路径亲和（同文件/同目录）> 其它；同级保持插入序（稳定）
  // R3：goal/target.symbol 中的精确符号名置顶（旧实现按文件 outline 声明序，goal 点名
  // pruneJobs 却把同文件常量 JOB_ROOT 放在 top）
  const exactNames = new Set(tokens.map(t => t.toLowerCase()))
  if (target?.symbol) exactNames.add(String(target.symbol).toLowerCase())
  const isExact = (e) => exactNames.has(String(e.c.name || '').toLowerCase())
  // LH-004：联合锚点——target.file∩符号名 > 同目录/同文件 > 其它锚点 > 其余；
  // 旧实现「任一 anchor 恒 rank0」让同名符号在别的文件也压过 target.file 里的命中。
  const fileOf = (e) => toPosix(e.c.file_path || '')
  const rank = (e) => {
    const anchored = e.anchor || isExact(e)
    if (targetFile) {
      if (fileOf(e) === targetFile && anchored) return 0
      if (fileOf(e) === targetFile) return 1
      if (targetDir && fileOf(e).startsWith(targetDir + '/')) return 1
      if (anchored) return 2
      return 3
    }
    return anchored ? 0 : 1
  }
  // 目标文件不含目标符号 → 显式警告（不静默把他处命中当锚点；排序照常）
  if (scanMeta && target?.symbol && targetFile) {
    scanMeta.anchor = {
      target_file: targetFile,
      target_symbol: String(target.symbol),
      matched: [...seen.values()].some(e => fileOf(e) === targetFile && String(e.c.name || '') === String(target.symbol)),
    }
  }
  if (legacy) return [...seen.values()].sort((a, b) => rank(a) - rank(b) || a.order - b.order).map(e => e.c)

  // 11-B：评分排序——匹配强度求和 + 共现加成（同符号命中多 token）+ 锚点/内容/路径亲和
  // 12-B：短泛常量降权——variable/constant 精确同名证据弱于函数/方法（version/source/hash 不应压过核心逻辑）；
  // 噪声目录（scratch/reports/coverage/dist，如仓内副本/本地报告）与测试路径轻度降权（专家：测试不应默认挤占生产入口）
  const isNoisyPath = (f) => {
    const segs = toPosix(f).toLowerCase().split('/')
    // 13-D（专家 c2a83e4 建议）：计划/实验目录（plan-* / plans）默认降权——计划文档里的高频通信词不应挤占生产入口
    return segs.includes('scratch') || segs.includes('reports') || segs.includes('coverage') || segs.includes('dist') ||
      segs.includes('plans') || segs.some(s => s.startsWith('plan-'))
  }
  const isTestPath = (f) => TEST_PATH_RE.test(toPosix(f))
  const isBenchPath = (f) => NON_PROD_PATH_RE.test(toPosix(f))
  const matchedTermsOf = (e) => tokens.filter(t => matchScore(t, e.c.name, fileOf(e)) > 0)
  // 12-D：同名歧义（≥2 候选精确同名）→ 精确名证据不具区分度，不吃加成
  const exactDf = new Map()
  for (const e of seen.values()) {
    if (e.c.kind === 'content') continue
    const n = String(e.c.name || '').toLowerCase()
    if (exactNames.has(n)) exactDf.set(n, (exactDf.get(n) || 0) + 1)
  }
  const isAmbiguous = (e) => (exactDf.get(String(e.c.name || '').toLowerCase()) || 0) >= 2
  const scoreOf = (e) => {
    const file = fileOf(e)
    let sum = 0
    let matched = 0
    for (const t of tokens) {
      const s = matchScore(t, e.c.name, file)
      if (s > 0) { matched++; sum += s }
    }
    let score = sum + (matched > 1 ? 15 : 0)
    if (e.anchor) score += 500
    // 内容回退候选（kind=content）名字即 token，不吃 isExact 加成——否则 import 行命中会压过真实定义
    if (isExact(e) && e.c.kind !== 'content' && !isAmbiguous(e)) {
      if (e.c.kind === 'variable' || e.c.kind === 'constant') {
        // 单泛词短常量（source/version/hash）证据最弱——不吃精确名加成；多词/长名常量保留部分加成
        const parts = wordParts(String(e.c.name || ''))
        score += (parts.length >= 2 || String(e.c.name || '').length >= 8) ? 120 : 0
      } else {
        score += 300
      }
    }
    // 12-D：正文回退候选（名字即 token，无符号映射）证据弱于真实符号名命中，不吃加成且轻度降权
    if (e.c.kind === 'content') score -= 10
    if (targetFile) {
      if (file === targetFile) score += 120
      else if (targetDir && file.startsWith(targetDir + '/')) score += 40
    }
    if (isNoisyPath(file)) score -= 40
    if (isTestPath(file)) score -= 40
    if (isBenchPath(file)) score -= 40
    return score
  }
  // 12-B：排序原因/命中词回执（专家 05109e1：候选需可解释、可消歧）
  const reasonOf = (e) => {
    const parts = []
    if (e.anchor) parts.push('anchor')
    if (isExact(e) && e.c.kind !== 'content') parts.push(isAmbiguous(e) ? 'ambiguous_name' : 'exact_name')
    if (matchedTermsOf(e).length > 1) parts.push('cooccur')
    if (e.c.kind === 'content') parts.push('content_hit')
    if (targetFile && fileOf(e) === targetFile) parts.push('target_file')
    if (isNoisyPath(fileOf(e))) parts.push('noisy_path')
    if (isTestPath(fileOf(e))) parts.push('test_path')
    if (isBenchPath(fileOf(e))) parts.push('benchmark_path')
    return parts.length ? parts.join('+') : 'fuzzy'
  }
  // 12-D：噪声目录候选末位分层（显式锚点/target 例外）——仓内副本不挤占生产入口
  // F3（0.5.14 Windows 复核）：档位细化为「生产实现 0 / 测试夹具 1 / 噪声目录 2」——原实现只把噪声挪后，
  // 测试夹具与实现同层竞争，通用词（command/after）即可把无关夹具顶上首位（专家 005/006/035）。
  const pathTier = (e) => {
    const f = fileOf(e)
    if (e.anchor) return 0
    if (targetFile && (f === targetFile || (targetDir && f.startsWith(targetDir + '/')))) return 0
    if (isNoisyPath(f)) return 2
    if (isTestyPath(f)) return 1
    return 0
  }
  const ordered = [...seen.values()].sort((a, b) => pathTier(a) - pathTier(b) || scoreOf(b) - scoreOf(a) || a.order - b.order)
  // F3：候选置信度（诚实声明）——首位是否为生产实现 + 命中强度；低置信时上游不得把夹具当可信目标推下一步
  const topEntry = ordered[0] || null
  const bestProd = ordered.find(e => pathTier(e) === 0) || null
  const topScore = topEntry ? scoreOf(topEntry) : 0
  const bestProdScore = bestProd ? scoreOf(bestProd) : 0
  const confidenceLevel = !topEntry ? 'none'
    : (pathTier(topEntry) === 0 && topScore >= 100) ? 'high'
      : (bestProdScore >= 100) ? 'medium'
        : 'low'
  if (scanMeta) {
    scanMeta.confidence = {
      level: confidenceLevel,
      top_is_test_or_noisy: !!topEntry && pathTier(topEntry) > 0,
      test_intent: goalHasTestIntent,
      best_production: bestProd ? { file: bestProd.c.file_path, name: bestProd.c.name, score: bestProdScore } : null,
      ...(confidenceLevel === 'low' ? { note: 'Low confidence: the strongest hits are test/fixture (or weak generic) matches — not evidence they are the target. Add target={file|symbol}, or quote exact identifiers in backticks; test/fixture candidates stay listed.' } : {}),
    }
  }
  // 14-A AC32：候选预算——优先按每文件至多 2 项填充首屏（8），防同文件高频词占满首屏、挤掉其他文件的相关分支；
  // 其余候选按原序追加（完整列表仍可达；候选供给不足 8 时溢出紧随配额头）。legacy 回放不经过此处（A/B 冻结）。
  const FIRST_SCREEN = 8
  const PER_FILE_TOP = 2
  const head = []
  const overflow = []
  const perFile = new Map()
  for (const e of ordered) {
    const f = fileOf(e)
    const n = perFile.get(f) || 0
    if (head.length < FIRST_SCREEN && n < PER_FILE_TOP) { head.push(e); perFile.set(f, n + 1) }
    else overflow.push(e)
  }
  return [...head, ...overflow].map(e => {
    const c = { ...e.c }
    const mt = matchedTermsOf(e)
    if (mt.length) c.matched_terms = mt
    c.rank_reason = reasonOf(e)
    return c
  })
}