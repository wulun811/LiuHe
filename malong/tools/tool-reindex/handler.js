import { setImmediate } from 'node:timers'
import { DEFAULT_IGNORE_DIRS, collectFilesWithDirStats, parseMalongignore } from '../../file-collector.js'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { ErrorCodes, makeError } from '../../error-codes.js'

const DEFAULT_THRESHOLD = 2000

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

  codeIndexService.initWorkspace(workspaceDir)

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

  const userMaxFiles = args?.maxFiles ?? 5000
  const userSkipDirs = args?.skipDirs ?? []
  const userIgnoreDirs = args?.ignoreDirs ?? []
  const threshold = args?.threshold ?? DEFAULT_THRESHOLD

  const mergedIgnoreDirs = new Set(DEFAULT_IGNORE_DIRS)
  for (const d of userIgnoreDirs) mergedIgnoreDirs.add(d)

  // 第一次统计：获取真实文件总数（不限制 maxFiles）
  const { files: allFiles, dirStats } = collectFilesWithDirStats(workspaceDir, {
    ignoreRules,
    skipDirs: userSkipDirs,
    maxFiles: 0,  // 不限制，获取真实总数
    ignoreDirs: mergedIgnoreDirs,
  })

  const totalFiles = allFiles.length

  if (totalFiles > threshold) {
    const topDirs = Object.entries(dirStats)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([dir, count]) => ({
        dir,
        files: count,
        pct: Math.round((count / totalFiles) * 100),
      }))

    return {
      status: 'needs_review',
      done: false,
      workspace_dir: workspaceDir,
      total_files: totalFiles,  // 真实总数
      threshold,
      maxFiles: userMaxFiles,
      top_directories: topDirs,
      suggestion: `This project has ${totalFiles} code files (threshold=${threshold}). `
        + 'Consider adding skipDirs=["dir1","dir2"] to exclude non-essential directories, '
        + 'or ignoreDirs=["dirname"] to skip directories by name, '
        + 'or increase maxFiles / threshold. '
        + 'Call reindex again with adjusted parameters when ready.',
    }
  }

  // 文件数在阈值内，直接使用已收集的文件
  const estimatedTimeSeconds = Math.ceil(totalFiles / 30)
  const filePaths = allFiles.map(f => f.path)
  const startTime = Date.now()

  codeIndexService.indexing = true
  codeIndexService.indexProgress = { workspaceDir, total: totalFiles, indexed: 0, startTime }

  // 13#5：force=true → 全量标 dirty，indexBatch 无视 mtime 重抽所有文件（清陈旧/可疑索引数据）
  let forceMarked = 0
  if (args?.force === true) {
    forceMarked = codeIndexService.markAllDirty()
    log('info', `[reindex] force=true: marked ${forceMarked} files dirty for full re-extract`)
  }

  const blocking = args?.blocking === true

  if (blocking) {
    try {
      await codeIndexService.indexBatch(filePaths, workspaceDir, (indexed, total) => {
        codeIndexService.indexProgress = { ...codeIndexService.indexProgress, indexed, total }
      })
      codeIndexService.indexing = false
      const durationMs = Date.now() - startTime
      log('info', `[reindex] blocking done: ${totalFiles} files, ${durationMs}ms`)
      const last = codeIndexService.lastIndexed || {}
      return {
        status: 'completed',
        done: true,
        workspace_dir: workspaceDir,
        total_files: totalFiles,
        files_indexed: totalFiles,
        symbols: last.symbols,
        refs: last.refs,
        duration_seconds: Math.round(durationMs / 1000),
        force_marked_dirty: forceMarked,
      }
    } catch (e) {
      codeIndexService.indexing = false
      log('error', `[reindex] blocking failed: ${e.message}`)
      return makeError(ErrorCodes.SERVICE_UNAVAILABLE, `Indexing failed: ${e.message}`)
    }
  }

  setImmediate(async () => {
    try {
      await codeIndexService.indexBatch(filePaths, workspaceDir, (indexed, total) => {
        codeIndexService.indexProgress = { ...codeIndexService.indexProgress, indexed, total }
      })
      codeIndexService.indexing = false
      log('info', `[reindex] done: ${allFiles.length} files, ${Date.now() - startTime}ms`)
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
    estimated_time_seconds: estimatedTimeSeconds,
    force_marked_dirty: forceMarked,
    next_action: 'Call reindex() to check progress, or pass blocking=true to wait for completion',
    note: `Indexing ${totalFiles} files in background. You can continue with other tasks.`,
  }
}