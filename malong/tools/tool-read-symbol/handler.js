// 码龙 — read_symbol 原语（原语化 P2）
// 附录：A（symbol_id 解析）、C（version 对象）、E（非代码降级）
// 快路径：索引新 → 按 range 读文件行取正文，不 parse；body_hash 读文件切片计算

import { join, relative, sep } from 'node:path'
import { readFileSync, statSync, existsSync, openSync, readSync, closeSync, realpathSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { sha256 } from '../../hash-utils.js'
import { validateFilePath } from '../../error-codes.js'
import { attachStalenessWarning } from '../../staleness.js'

const MAX_LIVE_READ = 1024 * 1024

function traceId() {
  return `trc_${Date.now()}_${randomBytes(3).toString('hex')}`
}

function pipelineStep(pipeline, step, status, extra = {}) {
  pipeline.push({ step, status, ...extra })
}

// Y002-S5（D3）：批量 read_symbols 原语——args.locators 数组入口，逐条复用 readOne，
// 并行执行（只读无锁），任一失败不阻断其他条目（与 write_symbols all_or_nothing 相反：
// 读是幂等查询，无补偿语义）
export async function handle(args, context) {
  const locators = args?.locators
  if (Array.isArray(locators) && locators.length > 0) {
    if (typeof args?.workspace_dir !== 'string' || !args?.workspace_dir) {
      return { error: 'missing_parameter', code: 'missing_parameter', message: 'workspace_dir is required', trace_id: traceId() }
    }
    const shared = { workspace_dir: args.workspace_dir, source: args.source, mode: args.mode, context_lines: args.context_lines }
    const results = await Promise.all(locators.map(async (locator) => {
      try {
        return await readOne({ ...shared, locator, ...(locator.mode ? {} : {}) }, context)
      } catch (e) {
        return { error: { code: 'INTERNAL', message: e.message }, trace_id: traceId() }
      }
    }))
    const failed = results.filter(r => r.error)
    return {
      symbols: results,
      batch: true,
      summary: { total: results.length, success: results.length - failed.length, failed: failed.length },
      ...(failed.length ? { failed_entries: failed.map(r => ({ error_code: typeof r.error === 'object' ? r.error.code : r.error, message: typeof r.error === 'object' ? r.error.message : undefined })) } : {}),
    }
  }
  return readOne(args, context)
}

async function readOne(args, context) {
  const { codeIndexService, getWorkspaceDir } = context
  const workspaceDir = args?.workspace_dir
  const pipeline = []
  const trace_id = traceId()

  if (typeof workspaceDir !== 'string' || !workspaceDir) {
    return { error: 'missing_parameter', code: 'missing_parameter', message: 'workspace_dir is required', trace_id }
  }
  const locator = args?.locator || {}
  let filePath = locator?.file_path
  if (!filePath && locator?.symbol_id && codeIndexService) {
    const byId = codeIndexService.getSymbolByStableId(locator.symbol_id)
    if (byId) filePath = byId.file_path
  }
  if (!filePath) {
    return { error: 'missing_parameter', code: 'missing_parameter', message: 'locator.file_path is required (or provide a resolvable symbol_id)', trace_id }
  }
  const pathCheck = validateFilePath(filePath)
  if (pathCheck.blocked) {
    return { error: 'PATH_BLOCKED', code: 'PATH_BLOCKED', message: pathCheck.detail, trace_id }
  }
  const absPath = join(workspaceDir, filePath)
  if (!existsSync(absPath)) {
    return { error: 'FILE_NOT_FOUND', code: 'FILE_NOT_FOUND', message: `File not found: ${filePath}`, trace_id }
  }

  // r8(B3)：symlink 越界守卫——validateFilePath 只查链接名（.env/.pem/.key 可被链接名绕过），
  // realpath 解析后对真目标重查：越界拒绝 + 禁名单重验
  try {
    const realRoot = realpathSync(workspaceDir)
    const real = realpathSync(absPath)
    if (real !== realRoot && !real.startsWith(realRoot + sep)) {
      return { error: 'PATH_BLOCKED', code: 'PATH_BLOCKED', message: `symlink escape: ${filePath} resolves outside workspace`, trace_id }
    }
    const realCheck = validateFilePath(relative(realRoot, real))
    if (realCheck.blocked) {
      return { error: 'PATH_BLOCKED', code: 'PATH_BLOCKED', message: `${realCheck.detail} (via symlink ${filePath})`, trace_id }
    }
  } catch {
    return { error: 'PATH_BLOCKED', code: 'PATH_BLOCKED', message: `cannot resolve path: ${filePath}`, trace_id }
  }

  // r54(P1): budget 钳上限——budget_hint 无上限时一次调用可吐数十万 token
  // R22-⑨：budget_hint=0 曾被 `|| 1200` 吞为默认（显式传 0 的语义被毁）——0 = 不截断（全文，受 100000 硬上限保护）
  let requested
  if (args?.budget_hint === undefined || args?.budget_hint === null || args?.budget_hint === '') requested = 1200
  else {
    requested = parseInt(args.budget_hint)
    if (!Number.isFinite(requested)) requested = 1200
  }
  const budget = requested === 0 ? 100000 : Math.min(Math.max(requested, 200), 100000)
  const source = args?.source || 'live'
  const onAmbiguous = args?.on_ambiguous || 'fail'
  const hasRange = Array.isArray(locator?.line_range) && locator.line_range.length === 2

  const t0 = Date.now()
  let staleness = null
  if (source === 'live' && codeIndexService) {
    await codeIndexService.initWorkspace(workspaceDir)
    // R19-②：getSymbolByStableId 不走服务层 7 出口——显式调服务层统一入口（带守卫）
    staleness = await codeIndexService.ensureFreshFile?.(filePath)
    pipelineStep(pipeline, 'index_status_check', 'ok', {
      detail: staleness?.auto_indexed ? 'auto_reindexed' : 'fresh',
    })
  }

  let content = null
  let size = 0
  let mtime = 0
  const HARD_READ_MAX = 32 * 1024 * 1024
  try {
    const st = statSync(absPath)
    size = st.size
    mtime = st.mtimeMs
    // R22-⑮：目录被当文件读 → 语义化 DIR_AS_FILE（旧实现进 catch 报 READ_FAILED/EISDIR，错误码不达意）
    if (st.isDirectory()) {
      return { error: 'DIR_AS_FILE', code: 'DIR_AS_FILE', message: `Path is a directory, not a file: ${filePath}`, suggestion: 'Provide a file path; use read_outline or repo_map for directory-level inspection.', trace_id }
    }
    // r54(P1): 硬上限防 GB 级文件 OOM（line_range 模式旧实现也整读，同样无保护）
    if (size > HARD_READ_MAX) {
      return { error: 'FILE_TOO_LARGE', code: 'FILE_TOO_LARGE', message: `File is ${(size / 1024 / 1024).toFixed(1)}MB (limit 32MB); read_symbol cannot safely load it`, suggestion: 'Read a smaller region with a different tool, or split the file.', trace_id }
    }
    // r54(P1): 定点有界读取——旧实现整读进内存再 subarray，大文件仍 OOM；改用 fd 只读前 MAX_LIVE_READ 字节
    if (size > MAX_LIVE_READ && !hasRange) {
      const fd = openSync(absPath, 'r')
      try {
        const buf = Buffer.alloc(MAX_LIVE_READ)
        const bytesRead = readSync(fd, buf, 0, MAX_LIVE_READ, 0)
        content = buf.subarray(0, bytesRead).toString('utf-8')
      } finally {
        closeSync(fd)
      }
    } else {
      content = readFileSync(absPath, 'utf-8')
    }
  } catch (e) {
    return { error: 'READ_FAILED', code: 'READ_FAILED', message: `Failed to read ${filePath}: ${e.message}`, trace_id }
  }
  const fileHash = sha256(content)
  // r11(M5)：>MAX_LIVE_READ 截断读取时哈希基于前 1MB——必须标记 truncated_hash，否则 write_symbol
  // 拿它当 base_version 与全量哈希比对恒 FILE_CHANGED（大型文件读写闭环结构性断裂，已修复）
  const fileTruncated = size > MAX_LIVE_READ && !hasRange
  const fileVersion = { hash: `sha256:${fileHash}`, size, mtime: new Date(mtime).toISOString(), ...(fileTruncated ? { truncated_hash: true, note: 'content truncated to first 1MB; file-level hash not comparable to full content' } : {}) }

  // ---- 解析 locator：symbol 模式 / line_range 模式 / file 模式 ----
  let symbol = null
  let symbolRows = []
  let range = null

  if (locator.symbol_id && codeIndexService) {
    symbol = codeIndexService.getSymbolByStableId(locator.symbol_id)
    if (symbol && symbol.file_path !== filePath) {
      symbol = null
    }
    if (!symbol) {
      pipelineStep(pipeline, 'resolve_locator', 'error', { reason: 'symbol_not_found' })
      return {
        success: false,
        error: 'SYMBOL_NOT_FOUND',
        code: 'SYMBOL_NOT_FOUND',
        message: `No symbol with stable_id ${locator.symbol_id} in ${filePath}`,
        suggestion: 'Re-index or re-read; fallback to name+file_path locator.',
        trace_id,
      }
    }
    pipelineStep(pipeline, 'resolve_locator', 'ok', { via: 'symbol_id' })
  } else if (locator.name && codeIndexService) {
    symbolRows = codeIndexService.findSymbolsInFile(filePath, locator.name, locator.kind)
    if (symbolRows.length === 0) {
      pipelineStep(pipeline, 'resolve_locator', 'warn', { reason: 'name_not_found', degraded: 'line_range' })
      return {
        success: false,
        error: 'SYMBOL_NOT_FOUND',
        code: 'SYMBOL_NOT_FOUND',
        message: `No symbol named "${locator.name}" in ${filePath}`,
        suggestion: 'Check name/kind, or use line_range locator.',
        trace_id,
      }
    }
    if (symbolRows.length > 1 && onAmbiguous === 'fail') {
      pipelineStep(pipeline, 'resolve_locator', 'error', { reason: 'ambiguous' })
      return {
        success: false,
        error: 'AMBIGUOUS_SYMBOL',
        code: 'AMBIGUOUS_SYMBOL',
        message: `${symbolRows.length} candidates for "${locator.name}" in ${filePath}`,
        candidates: symbolRows.map(r => ({ symbol_id: r.stable_id, name: r.name, kind: r.type, range: [r.start_line, r.end_line], signature: r.signature })),
        suggestion: 'Disambiguate via symbol_id (get from candidates above).',
        trace_id,
      }
    }
    symbol = symbolRows[0]
    pipelineStep(pipeline, 'resolve_locator', 'ok', { via: 'name+file' })
  }

  if (!symbol) {
    // 降级：line_range / file（附录 E）
    const lines = content.split('\n')
    if (hasRange) {
      const [ra, rb] = locator.line_range
      const a = parseInt(ra), b = parseInt(rb)
      // r54(P1): 倒置/非法 line_range 旧实现静默返回空 body——显式报 INVALID_INPUT
      if (!Number.isFinite(a) || !Number.isFinite(b) || a < 1 || b < 1 || a > b) {
        pipelineStep(pipeline, 'resolve_locator', 'error', { reason: 'invalid_line_range' })
        return { error: 'INVALID_INPUT', code: 'INVALID_INPUT', message: `line_range [${ra}, ${rb}] is invalid; must be positive integers with start <= end`, trace_id }
      }
      range = [a, b]
      pipelineStep(pipeline, 'resolve_locator', 'ok', { via: 'line_range', degraded: true })
    } else {
      range = [1, lines.length]
      pipelineStep(pipeline, 'resolve_locator', 'ok', { via: 'file', degraded: true })
    }
  } else {
    range = [symbol.start_line, Math.max(symbol.start_line, symbol.end_line)]
    pipelineStep(pipeline, 'resolve_locator', 'ok', { via: 'symbol' })
  }

  // ---- 正文切片 + budget 截断 ----
  const lines = content.split('\n')
  const contextLines = Math.max(0, parseInt(args?.context_lines) || 0)
  // r54(P1): context_lines 旧实现是死代码（算后从不参与切片）——向两侧扩展（不越文件界），range 本身保持不变供 version 用
  const ctxStart = Math.max(1, range[0] - contextLines)
  const ctxEnd = Math.min(lines.length, range[1] + contextLines)
  const bodyLines = lines.slice(ctxStart - 1, ctxEnd)
  let body = bodyLines.join('\n')
  let truncated = false
  if (body.length > budget) {
    body = body.slice(0, budget) + '\n…[truncated]'
    truncated = true
  }
  pipelineStep(pipeline, 'budget_truncate', truncated ? 'warn' : 'ok', { requested: budget, truncated })

  // ---- version 对象（附录 C）----
  const symbolVersion = symbol ? {
    symbol_id: symbol.stable_id || null,
    range,
    body_hash: symbol.body_hash ? `sha256:${symbol.body_hash}` : (() => { const b = bodyLines.join('\n'); return b ? `sha256:${sha256(b)}` : null })(),
    signature_hash: symbol.signature_hash ? `sha256:${symbol.signature_hash}` : null,
  } : null
  const indexRow = codeIndexService?.getFileByPath(filePath)
  const version = {
    file: fileVersion,
    symbol: symbolVersion,
    index: {
      index_state: indexRow?.index_state || (codeIndexService ? 'fresh' : 'unknown'),
      stale: !!staleness && !staleness.auto_indexed,
    },
  }

  // ---- outline 摘要（core 默认不带，省 token；rich 带；显式 include_outline=true 强制） ----
  let outline = null
  const wantOutline = args?.mode === 'rich' ? (args?.include_outline !== false) : (args?.include_outline === true)
  if (wantOutline && codeIndexService) {
    try {
      const depth = Math.max(0, Math.min(10, parseInt(args?.outline_depth) || 1))
      const o = await codeIndexService.getFileOutline(filePath, { depth })
      if (o && !o.error) {
        const items = o.outline || o.symbols || o.functions || []
        outline = { truncated: (o.truncated || false) || items.length > 50, items: items.slice(0, 50).map(i => ({ name: i.name, type: i.type, line: i.line })) }
      }
    } catch { outline = null }
  }

  // ---- navigation（rich 模式）----
  let navigation = null
  if (args?.mode === 'rich' && symbol && codeIndexService) {
    try {
      // 签名 (filePath, { symbol })：旧实现把符号名当 filePath → path 查不到 → navigation 恒空
      const impact = await codeIndexService.getImpactAnalysis(filePath, { symbol: symbol.name })
      navigation = {
        callers_count: impact?.callers?.length || 0,
        callees_count: impact?.callees?.length || 0,
        next_action: { tool: 'read_symbol', params: { locator: { symbol_id: symbol.stable_id }, mode: 'core' } },
      }
    } catch { navigation = null }
  }

  const result = {
    symbol: symbol ? {
      symbol_id: symbol.stable_id || null,
      name: symbol.name,
      kind: symbol.type,
      range,
      signature: symbol.signature || '',
      text: body,
    } : {
      symbol_id: null,
      name: null,
      kind: null,
      range,
      signature: null,
      text: body,
    },
    version,
    outline,
    navigation,
    budget: { requested: budget, used_estimate: body.length, truncated },
    index_status: { state: version.index.index_state, auto_indexed: staleness?.auto_indexed || false, stale: version.index.stale },
    pipeline,
    trace_id,
    duration_ms: Date.now() - t0,
  }
  result.next_step = 'To modify: impact_analysis(workspace_dir=...) to check blast radius, then edit_batch. After: test_bridge(action="run")'
  return attachStalenessWarning(result, staleness)
}
