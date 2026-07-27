import { setImmediate } from 'node:timers'
import { collectFiles, collectFilesWithDirStats, parseMalongignore } from '../../file-collector.js'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

const DEFAULT_THRESHOLD = 2000

export async function handle(args, context) {
  const { codeIndexService, log } = context
  const workspaceDir = args?.workspace_dir

  if (!workspaceDir) {
    // 不带参数：查询索引状态
    if (!codeIndexService) {
      return { error: 'service_unavailable', message: 'codeIndex service not available' }
    }
    if (codeIndexService.indexing && codeIndexService.indexProgress) {
      const p = codeIndexService.indexProgress
      const pct = p.total > 0 ? Math.round((p.indexed / p.total) * 100) : 0
      return {
        status: 'indexing',
        workspace_dir: p.workspaceDir,
        files_indexed: p.indexed,
        total_files: p.total,
        progress_pct: pct,
        elapsed_seconds: Math.round((Date.now() - p.startTime) / 1000),
      }
    }
    return { status: 'idle', suggestion: 'Call reindex(workspace_dir="...") to start indexing' }
  }

  if (!existsSync(workspaceDir)) {
    return { error: 'invalid_workspace', message: `workspace_dir not found: ${workspaceDir}` }
  }

  if (!codeIndexService) {
    return { error: 'service_unavailable', message: 'codeIndex service not available', suggestion: 'Check MCP server configuration' }
  }

  codeIndexService.initWorkspace(workspaceDir)

  // 正在索引中：返回进度
  if (codeIndexService.indexing && codeIndexService.indexProgress) {
    const p = codeIndexService.indexProgress
    const pct = p.total > 0 ? Math.round((p.indexed / p.total) * 100) : 0
    return {
      status: 'indexing',
      workspace_dir: workspaceDir,
      files_indexed: p.indexed,
      total_files: p.total,
      progress_pct: pct,
      elapsed_seconds: Math.round((Date.now() - p.startTime) / 1000),
      estimated_remaining_seconds: p.indexed > 0 ? Math.round((Date.now() - p.startTime) / p.indexed * (p.total - p.indexed) / 1000) : null,
    }
  }

  const malongignorePath = join(workspaceDir, '.malongignore')
  const ignoreRules = existsSync(malongignorePath) ? parseMalongignore(malongignorePath) : []

  const userMaxFiles = args?.maxFiles ?? 5000
  const userSkipDirs = args?.skipDirs ?? []
  const userIgnoreDirs = args?.ignoreDirs ?? []
  const threshold = args?.threshold ?? DEFAULT_THRESHOLD

  // 预检：收集文件并统计目录分布
  const { files, dirStats } = collectFilesWithDirStats(workspaceDir, {
    ignoreRules,
    skipDirs: userSkipDirs,
    maxFiles: userMaxFiles,
  })

  const totalFiles = files.length

  // 超过阈值，返回 needs_review
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
      workspace_dir: workspaceDir,
      total_files: totalFiles,
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

  // 开始异步索引
  const estimatedTimeSeconds = Math.ceil(totalFiles / 3)

  codeIndexService.indexing = true
  codeIndexService.indexProgress = { workspaceDir, total: totalFiles, indexed: 0, startTime: Date.now() }

  setImmediate(async () => {
    try {
      for (let i = 0; i < files.length; i++) {
        codeIndexService.indexFile(files[i].path, workspaceDir)
        codeIndexService.indexProgress = { ...codeIndexService.indexProgress, indexed: i + 1 }
        if (i > 0 && i % 50 === 0) await new Promise(r => setImmediate(r))
      }
      const crossResolved = codeIndexService.resolveCrossFileRefs()
      codeIndexService.indexing = false
      log('info', `[reindex] done: ${files.length} files, ${crossResolved} cross-refs, ${Date.now() - codeIndexService.indexProgress.startTime}ms`)
    } catch (e) {
      log('error', `[reindex] failed: ${e.message}`)
      codeIndexService.indexing = false
    }
  })

  return {
    status: 'started',
    workspace_dir: workspaceDir,
    total_files: totalFiles,
    estimated_time_seconds: estimatedTimeSeconds,
    note: `Indexing ${totalFiles} files in background. You can continue with other tasks. Call reindex() to check progress.`,
  }
}