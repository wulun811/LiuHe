import { join } from 'node:path'
import { statSync, existsSync } from 'node:fs'

export async function checkFileStaleness(codeIndexService, workspaceDir, filePath) {
  if (!codeIndexService || !workspaceDir || !filePath) return null
  const absPath = join(workspaceDir, filePath)
  try {
    const diskMtime = statSync(absPath).mtimeMs
    const indexedMtime = codeIndexService.getFileMtime(filePath)
    // R11：两边取整比较——files.mtime 实际存 REAL 浮点（SQLite 亲和），与 statSync.mtimeMs 同为浮点，直接 !== 会因亚毫秒差异恒 auto-index
    if (Math.round(diskMtime) !== Math.round(indexedMtime)) {
      // P2-C8：!= 而非 >——mtime 回退（checkout/快照恢复）同样触发重索引；
      // 未索引（indexedMtime=0）同样触发（auto_index 语义）；旧实现 diskMtime > indexedMtime 覆盖不到这两类
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
  // 调用方拿到的是 getImpactAnalysis 的快照（R1 修复后为浅拷贝结构），改写不污染驻留缓存。
  // 浅拷贝假设：此处只改顶层字段（warning/stale_file/suggestion/auto_indexed）。
  // 若未来 handler 扩展修改数组型子字段（callers/callees/test_callers），需将快照升级为 structuredClone。
  if (!staleness) return result
  if (staleness.auto_indexed) {
    result.auto_indexed = true
    return result
  }
  // R19-②：服务层 freshness 的 {auto_indexed:false} 形态不产生任何字段（旧 checkFileStaleness 的 index_stale warning 由服务层静默降级取代）
  if (!staleness.warning) return result
  result.warning = staleness.warning
  result.stale_file = staleness.file
  result.suggestion = staleness.suggestion
  return result
}
