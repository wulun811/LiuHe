import { setImmediate } from 'node:timers'
import { randomBytes } from 'node:crypto'
import { DEFAULT_IGNORE_DIRS, collectFilesWithDirStats, parseMalongignore } from '../../file-collector.js'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { ErrorCodes, makeError } from '../../error-codes.js'

const DEFAULT_THRESHOLD = 2000
const CONFIRM_TTL_MS = 10 * 60 * 1000

// r10d：二次确认 token 表（workspace_dir → { token, expiresAt, userMaxFiles }）——
// 超阈值索引必须回传首次调用返回的随机 token，LLM 无法编造，杜绝「看了警告直接跳过确认」的损失
const _confirmTokens = new Map()

// 估算基准（benchmarks/results/r10-reindex-baseline.json 的 full_index 段，r10e 实测 2026-08-05）:
// 0FTYcloud 737 文件 × 3 次全量：collect 28ms + parse p50 1.5s + DB 写 p50 5.4s（占 ~95%）= 全流程 p50 5.63s → 131 files/s。
// r10e(F1)：旧基准 files/30 高估 4.5x——「extract p50 3000 文件 ~11.6s→258 files/s→÷8.6」的 8.6 系数拍脑袋，且 DB 写从没实测。
// 新公式：固定 1s（collect+启动）+ files/100（实测 131 × 0.76 保守），量级与实测吻合（737→9s，实测 5.6s）。
function estimateIndexSeconds(totalFiles) {
  return Math.ceil(1 + totalFiles / 100)
}

function formatDuration(seconds) {
  if (seconds < 60) return `~${Math.max(1, seconds)}s`
  const m = Math.ceil(seconds / 60)
  if (m < 60) return `~${m} min`
  return `~${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`
}

async function runIndexing(codeIndexService, filePaths, workspaceDir, totalFiles, opts, log) {
  const { forceMarked = 0, blocking = false, note = null } = opts
  const startTime = Date.now()
  codeIndexService.indexing = true
  codeIndexService.indexProgress = { workspaceDir, total: totalFiles, indexed: 0, startTime }
  const progress = (indexed, total) => { codeIndexService.indexProgress = { ...codeIndexService.indexProgress, indexed, total } }

  if (blocking) {
    try {
      const result = await codeIndexService.indexBatch(filePaths, workspaceDir, progress)
      codeIndexService.indexing = false
      const durationMs = Date.now() - startTime
      log('info', `[reindex] blocking done: ${totalFiles} files, ${durationMs}ms`)
      const last = codeIndexService.lastIndexed || {}
      // 真实重抽数（indexBatch 按 mtime 增量，0 变化时返回空数组）——
      // files_indexed 不再是全量文件数，避免 LLM 误以为每次都在全量建索引
      const indexedCount = Array.isArray(result) ? result.length : filePaths.length
      const alreadyFresh = indexedCount === 0
      return {
        status: 'completed',
        done: true,
        workspace_dir: workspaceDir,
        total_files: totalFiles,
        files_indexed: indexedCount,
        unchanged_skipped: Math.max(totalFiles - indexedCount, 0),
        already_fresh: alreadyFresh,
        symbols: last.symbols,
        refs: last.refs,
        // r11(M4)：parse 失败文件数（>0 说明有病态/超大文件未入索引，仍是 dirty 下次增量重试）
        parse_errors: last.parse_errors || 0,
        duration_seconds: Math.round(durationMs / 1000),
        force_marked_dirty: forceMarked,
        ...(note ? { warning: note } : {}),
        ...(alreadyFresh ? {
          note: 'Index is already up to date — no files changed since last index. No need to reindex; read tools are served from fresh index.',
        } : {}),
      }
    } catch (e) {
      codeIndexService.indexing = false
      log('error', `[reindex] blocking failed: ${e.message}`)
      return makeError(ErrorCodes.SERVICE_UNAVAILABLE, `Indexing failed: ${e.message}`)
    }
  }

  setImmediate(async () => {
    try {
      await codeIndexService.indexBatch(filePaths, workspaceDir, progress)
      codeIndexService.indexing = false
      log('info', `[reindex] done: ${filePaths.length} files, ${Date.now() - startTime}ms`)
    } catch (e) {
      log('error', `[reindex] failed: ${e.message}`)
      codeIndexService.indexing = false
    }
  })

  return {
    status: 'started',
    done: false,
    workspace_dir: workspaceDir,
    total_files: totalFiles,
    files_to_index: filePaths.length,
    estimated_time_seconds: estimateIndexSeconds(filePaths.length),
    estimated_time_human: formatDuration(estimateIndexSeconds(filePaths.length)),
    force_marked_dirty: forceMarked,
    next_action: 'Call reindex() to check progress, or pass blocking=true to wait for completion',
    note: note || `Incremental indexing started: only files changed since last index are re-extracted (${filePaths.length} files scanned). If already indexed, this finishes in seconds. You can continue with other tasks.`,
  }
}

export async function handle(args, context) {
  const { codeIndexService, log } = context
  const workspaceDir = args?.workspace_dir

  if (!workspaceDir) {
    if (!codeIndexService) {
      return makeError(ErrorCodes.SERVICE_UNAVAILABLE, 'codeIndex service not available')
    }
    if (codeIndexService.indexing && codeIndexService.indexProgress) {
      const p = codeIndexService.indexProgress
      const pct = p.total > 0 ? Math.round((p.indexed / p.total) * 100) : 0
      return {
        status: 'indexing',
        done: false,
        workspace_dir: p.workspaceDir,
        files_indexed: p.indexed,
        total_files: p.total,
        progress_pct: pct,
        elapsed_seconds: Math.round((Date.now() - p.startTime) / 1000),
        next_action: 'Call reindex() again to check progress',
      }
    }
    const last = codeIndexService.lastIndexed
    if (last) {
      return {
        status: 'completed',
        done: true,
        workspace_dir: last.workspace_dir,
        files_indexed: last.files,
        symbols: last.symbols,
        refs: last.refs,
        completed_at: last.completed_at,
        suggestion: 'Call reindex(workspace_dir="...") to index a different workspace',
        next_step: 'Index ready — read_symbol / symbol_search / references now work. Self-check: health(action="check")',
      }
    }
    return { status: 'not_started', done: false, suggestion: 'Call reindex(workspace_dir="...") to start indexing' }
  }

  if (!existsSync(workspaceDir)) {
    return makeError(ErrorCodes.INVALID_INPUT, `workspace_dir not found: ${workspaceDir}`)
  }

  if (!codeIndexService) {
    return makeError(ErrorCodes.SERVICE_UNAVAILABLE, 'codeIndex service not available', { suggestion: 'Check MCP server configuration' })
  }

  await codeIndexService.initWorkspace(workspaceDir)

  if (codeIndexService.indexing && codeIndexService.indexProgress) {
    const p = codeIndexService.indexProgress
    const pct = p.total > 0 ? Math.round((p.indexed / p.total) * 100) : 0
    return {
      status: 'indexing',
      done: false,
      workspace_dir: workspaceDir,
      files_indexed: p.indexed,
      total_files: p.total,
      progress_pct: pct,
      elapsed_seconds: Math.round((Date.now() - p.startTime) / 1000),
      estimated_remaining_seconds: p.indexed > 0 ? Math.round((Date.now() - p.startTime) / p.indexed * (p.total - p.indexed) / 1000) : null,
      next_action: 'Call reindex() again to check progress',
    }
  }

  const malongignorePath = join(workspaceDir, '.malongignore')
  const ignoreRules = existsSync(malongignorePath) ? parseMalongignore(malongignorePath) : []

  const userMaxFilesRaw = args?.maxFiles ?? 5000
  const userMaxFiles = typeof userMaxFilesRaw === 'number' && Number.isFinite(userMaxFilesRaw) && userMaxFilesRaw > 0
    ? Math.floor(userMaxFilesRaw)
    : 5000
  const userSkipDirs = args?.skipDirs ?? []
  const userIgnoreDirs = args?.ignoreDirs ?? []
  const threshold = args?.threshold ?? DEFAULT_THRESHOLD
  const confirmToken = typeof args?.confirm === 'string' && args.confirm ? args.confirm : null

  const mergedIgnoreDirs = new Set(DEFAULT_IGNORE_DIRS)
  for (const d of userIgnoreDirs) mergedIgnoreDirs.add(d)

  const scanOpts = { ignoreRules, skipDirs: userSkipDirs, ignoreDirs: mergedIgnoreDirs }

  // 阶段一：预检统计——hardCap=threshold+1 秒回，绝不在未确认时无上限同步 walk 全树（防请求超时）
  const pre = collectFilesWithDirStats(workspaceDir, { ...scanOpts, maxFiles: 0, hardCap: threshold + 1 })
  const totalFiles = pre.files.length
  const overThreshold = totalFiles > threshold || pre.truncated

  // 阶段二：已带确认 token → 校验并执行
  if (overThreshold && confirmToken) {
    const rec = _confirmTokens.get(workspaceDir)
    if (!rec || rec.token !== confirmToken || rec.expiresAt < Date.now()) {
      _confirmTokens.delete(workspaceDir)
      return {
        status: 'needs_review',
        done: false,
        workspace_dir: workspaceDir,
        total_files: totalFiles,
        threshold,
        maxFiles: userMaxFiles,
        confirm_error: 'invalid_or_expired_confirm_token',
        message: `Confirm token invalid or expired (TTL ${CONFIRM_TTL_MS / 60000} min). Call reindex(workspace_dir="${workspaceDir}") again to get a fresh token before confirming.`,
      }
    }
    _confirmTokens.delete(workspaceDir)

    // maxFiles 即「索引上限」：收集到 maxFiles 个即截断；force 标记脏数据全量重抽
    const { files, truncated } = collectFilesWithDirStats(workspaceDir, { ...scanOpts, maxFiles: userMaxFiles, hardCap: 0 })
    const filePaths = files.map(f => f.path)
    const forceMarked = args?.force === true ? codeIndexService.markAllDirty() : 0
    if (forceMarked > 0) log('info', `[reindex] force=true: marked ${forceMarked} files dirty for full re-extract`)

    const note = truncated
      ? `File count ${totalFiles} exceeds maxFiles=${userMaxFiles}: only the first ${filePaths.length} files will be indexed (truncated). The rest are skipped; raise maxFiles or exclude dirs with ignoreDirs to index everything.`
      : null
    return runIndexing(codeIndexService, filePaths, workspaceDir, totalFiles, {
      forceMarked,
      blocking: args?.blocking === true,
      note,
    }, log)
  }

  // 阶段三：超阈值且未确认 → needs_review + 二次确认（token 复用未过期值）
  if (overThreshold) {
    const estimateSec = estimateIndexSeconds(totalFiles)
    const existing = _confirmTokens.get(workspaceDir)
    const token = existing && existing.expiresAt >= Date.now()
      ? existing.token
      : randomBytes(6).toString('hex')
    _confirmTokens.set(workspaceDir, { token, expiresAt: Date.now() + CONFIRM_TTL_MS, userMaxFiles })

    const topDirs = Object.entries(pre.dirStats)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([dir, count]) => ({ dir, files: count, pct: Math.round((count / totalFiles) * 100) }))
    const displayTotal = pre.truncated ? `>=${totalFiles}` : totalFiles

    return {
      status: 'needs_review',
      done: false,
      workspace_dir: workspaceDir,
      total_files: displayTotal,
      threshold,
      maxFiles: userMaxFiles,
      truncated: pre.truncated,
      top_directories: topDirs,
      confirm_required: true,
      confirm_token: token,
      confirm_ttl_seconds: CONFIRM_TTL_MS / 1000,
      estimated_time_seconds: estimateSec,
      estimated_time_human: formatDuration(estimateSec),
      estimation_note: 'Estimation baseline (benchmarks/results/r10-reindex-baseline.json): collect 20000 files ~95ms; extract p50 3000 files ~11.6s; conservative full-flow estimate at 30 files/s.',
      indexing_plan: (pre.truncated || totalFiles > userMaxFiles)
        ? `File count ${displayTotal} may exceed maxFiles=${userMaxFiles}: on confirm, at most the first ${userMaxFiles} files are collected, the rest truncated; raise maxFiles or use ignoreDirs to index everything`
        : `Will index all ${displayTotal} files (top-15 dir breakdown included; exclude with skipDirs/ignoreDirs before confirming)`,
      next_action: `Second confirmation: call reindex(workspace_dir="${workspaceDir}", confirm="${token}") to start indexing; or adjust maxFiles/ignoreDirs/skipDirs and call again`,
    }
  }

  // 阶段四：文件数在阈值内，直接索引（小项目无摩擦）
  const filePaths = pre.files.map(f => f.path)
  const forceMarked = args?.force === true ? codeIndexService.markAllDirty() : 0
  if (forceMarked > 0) log('info', `[reindex] force=true: marked ${forceMarked} files dirty for full re-extract`)
  return runIndexing(codeIndexService, filePaths, workspaceDir, totalFiles, {
    forceMarked,
    blocking: args?.blocking === true,
  }, log)
}
