import { join } from 'node:path'
import { statSync } from 'node:fs'

export function checkFileStaleness(codeIndexService, workspaceDir, filePath) {
  if (!codeIndexService || !workspaceDir || !filePath) return null
  const absPath = join(workspaceDir, filePath)
  try {
    const diskMtime = statSync(absPath).mtimeMs
    const indexedMtime = codeIndexService.getFileMtime(filePath)
    if (diskMtime > indexedMtime) {
      return {
        warning: 'index_stale',
        file: filePath,
        suggestion: `File "${filePath}" was modified after last index. Call reindex to refresh.`
      }
    }
  } catch {}
  return null
}

export function attachStalenessWarning(result, staleness) {
  if (!staleness) return result
  result.warning = staleness.warning
  result.stale_file = staleness.file
  result.suggestion = staleness.suggestion
  return result
}
