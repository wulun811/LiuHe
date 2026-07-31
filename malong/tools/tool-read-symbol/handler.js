// 码龙 — read_symbol 原语（原语化 P2）
// 附录：A（symbol_id 解析）、C（version 对象）、E（非代码降级）
// 快路径：索引新 → 按 range 读文件行取正文，不 parse；body_hash 读文件切片计算

import { join } from 'node:path'
import { readFileSync, statSync, existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { sha256 } from '../../hash-utils.js'
import { validateFilePath } from '../../error-codes.js'
import { checkFileStaleness, attachStalenessWarning } from '../../staleness.js'

const MAX_LIVE_READ = 1024 * 1024

function traceId() {
  return `trc_${Date.now()}_${randomBytes(3).toString('hex')}`
}

function pipelineStep(pipeline, step, status, extra = {}) {
  pipeline.push({ step, status, ...extra })
}

export async function handle(args, context) {
  const { codeIndexService, getWorkspaceDir } = context
  const workspaceDir = args?.workspace_dir
  const pipeline = []
  const trace_id = traceId()

  if (!workspaceDir) {
    return { error: 'missing_parameter', message: 'workspace_dir is required', trace_id }
  }
  const locator = args?.locator || {}
  let filePath = locator?.file_path
  if (!filePath && locator?.symbol_id && codeIndexService) {
    const byId = codeIndexService.getSymbolByStableId(locator.symbol_id)
    if (byId) filePath = byId.file_path
  }
  if (!filePath) {
    return { error: 'missing_parameter', message: 'locator.file_path is required (or provide a resolvable symbol_id)', trace_id }
  }
  const pathCheck = validateFilePath(filePath)
  if (pathCheck.blocked) {
    return { error: 'PATH_BLOCKED', code: 'PATH_BLOCKED', message: pathCheck.detail, trace_id }
  }
  const absPath = join(workspaceDir, filePath)
  if (!existsSync(absPath)) {
    return { error: 'FILE_NOT_FOUND', code: 'FILE_NOT_FOUND', message: `File not found: ${filePath}`, trace_id }
  }

  const budget = Math.max(200, parseInt(args?.budget_hint) || 1200)
  const source = args?.source || 'live'
  const onAmbiguous = args?.on_ambiguous || 'fail'
  const hasRange = Array.isArray(locator?.line_range) && locator.line_range.length === 2

  const t0 = Date.now()
  let staleness = null
  if (source === 'live' && codeIndexService) {
    codeIndexService.initWorkspace(workspaceDir)
    staleness = await checkFileStaleness(codeIndexService, workspaceDir, filePath)
    pipelineStep(pipeline, 'index_status_check', staleness?.auto_indexed ? 'ok' : staleness ? 'warn' : 'ok', {
      detail: staleness?.auto_indexed ? 'auto_reindexed' : staleness?.warning || 'fresh',
    })
  }

  let content = null
  let size = 0
  let mtime = 0
  try {
    const st = statSync(absPath)
    size = st.size
    mtime = st.mtimeMs
    // 附录 E：file 模式大文件截断保护；line_range 模式必须读全文（目标行可能在后段）
    if (size > MAX_LIVE_READ && !hasRange) {
      const buf = readFileSync(absPath)
      content = buf.subarray(0, MAX_LIVE_READ).toString('utf-8')
    } else {
      content = readFileSync(absPath, 'utf-8')
    }
  } catch (e) {
    return { error: 'READ_FAILED', message: `Failed to read ${filePath}: ${e.message}`, trace_id }
  }
  const fileHash = sha256(content)
  const fileVersion = { hash: `sha256:${fileHash}`, size, mtime: new Date(mtime).toISOString() }

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
        error: { code: 'SYMBOL_NOT_FOUND', message: `No symbol with stable_id ${locator.symbol_id} in ${filePath}`, suggestion: 'Re-index or re-read; fallback to name+file_path locator.' },
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
        error: { code: 'SYMBOL_NOT_FOUND', message: `No symbol named "${locator.name}" in ${filePath}`, suggestion: 'Check name/kind, or use line_range locator.' },
        trace_id,
      }
    }
    if (symbolRows.length > 1 && onAmbiguous === 'fail') {
      pipelineStep(pipeline, 'resolve_locator', 'error', { reason: 'ambiguous' })
      return {
        success: false,
        error: {
          code: 'AMBIGUOUS_SYMBOL',
          message: `${symbolRows.length} candidates for "${locator.name}" in ${filePath}`,
          candidates: symbolRows.map(r => ({ symbol_id: r.stable_id, name: r.name, kind: r.type, range: [r.start_line, r.end_line], signature: r.signature })),
          suggestion: 'Disambiguate via symbol_id (get from candidates above).',
        },
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
      const [a, b] = [Math.max(1, locator.line_range[0]), Math.max(1, locator.line_range[1])]
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
  const bodyLines = lines.slice(range[0] - 1, range[1])
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
  return attachStalenessWarning(result, staleness)
}
