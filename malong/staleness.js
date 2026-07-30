import { join } from 'node:path'
import { statSync, existsSync } from 'node:fs'

export async function checkFileStaleness(codeIndexService, workspaceDir, filePath) {
  if (!codeIndexService || !workspaceDir || !filePath) return null
  const absPath = join(workspaceDir, filePath)
  try {
    const diskMtime = statSync(absPath).mtimeMs
    const indexedMtime = codeIndexService.getFileMtime(filePath)
    if (diskMtime > indexedMtime) {
      codeIndexService.clearCachesForFile(filePath)
      const result = await codeIndexService.indexFile(absPath, workspaceDir)
      if (result) {
        return { auto_indexed: true, file: filePath }
      } else {
        return {
          warning: 'index_stale',
          file: filePath,
          suggestion: `File "${filePath}" was modified after last index. Call reindex to refresh.`
        }
      }
    }
  } catch {}
  return null
}

export async function ensureIndexed(codeIndexService, workspaceDir, filePath) {
  if (!codeIndexService || !workspaceDir || !filePath) return false
  const absPath = join(workspaceDir, filePath)
  if (!existsSync(absPath)) return false
  const indexedMtime = codeIndexService.getFileMtime(filePath)
  if (indexedMtime > 0) return true
  const result = await codeIndexService.indexFile(absPath, workspaceDir)
  return !!result
}

export function attachStalenessWarning(result, staleness) {
  if (!staleness) return result
  if (staleness.auto_indexed) {
    result.auto_indexed = true
    return result
  }
  result.warning = staleness.warning
  result.stale_file = staleness.file
  result.suggestion = staleness.suggestion
  return result
}
