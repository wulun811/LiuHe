// 六合工具集 — reindex handler

import { setImmediate } from 'node:timers'
import { collectFiles, parseMalongignore } from '../../file-collector.js'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

export async function handle(args, context) {
  const { codeIndexService, log } = context
  const workspaceDir = args?.workspace_dir

  if (!workspaceDir) {
    return { error: 'workspace_dir parameter required — specify the project root directory to index' }
  }

  if (!codeIndexService) {
    return { error: 'codeIndex service not available' }
  }

  // 初始化 workspace 数据库
  codeIndexService.initWorkspace(workspaceDir)

  if (codeIndexService._indexing) {
    return { status: 'already indexing', workspace_dir: workspaceDir }
  }

  // 估算文件数量
  const malongignorePath = join(workspaceDir, '.malongignore')
  const ignoreRules = existsSync(malongignorePath) ? parseMalongignore(malongignorePath) : null
  const files = collectFiles(workspaceDir, { ignoreRules })
  const estimatedFiles = files.length
  const estimatedTimeSeconds = Math.ceil(estimatedFiles / 3) // 约 3 文件/秒

  codeIndexService._indexing = true
  setImmediate(async () => {
    try {
      const t0 = Date.now()
      for (let i = 0; i < files.length; i++) {
        codeIndexService.indexFile(files[i].path, workspaceDir)
        if (i > 0 && i % 50 === 0) await new Promise(r => setImmediate(r))
      }
      const crossResolved = codeIndexService._resolveCrossFileRefs()
      codeIndexService._indexing = false
      log('info', `[reindex] done: ${files.length} files, ${crossResolved} cross-refs, ${Date.now() - t0}ms`)
    } catch (e) {
      log('error', `[reindex] failed: ${e.message}`)
      codeIndexService._indexing = false
    }
  })

  return {
    status: 'started',
    workspace_dir: workspaceDir,
    estimated_files: estimatedFiles,
    estimated_time_seconds: estimatedTimeSeconds,
    note: `首次索引需要约 ${estimatedTimeSeconds} 秒，请耐心等待。后续调用会快很多。`
  }
}
