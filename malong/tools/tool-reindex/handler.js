// 六合工具集 — reindex handler

import { setImmediate } from 'node:timers'
import { collectFiles } from '../../file-collector.js'

export async function handle(args, context) {
  const { codeIndexInstance, workspaceDir, ignoreRules, log } = context

  if (codeIndexInstance._indexing) {
    return { status: 'already indexing' }
  }

  codeIndexInstance._indexing = true
  setImmediate(async () => {
    try {
      const t0 = Date.now()
      const files = collectFiles(workspaceDir, { ignoreRules })
      for (let i = 0; i < files.length; i++) {
        codeIndexInstance.indexFile(files[i].path, workspaceDir)
        if (i > 0 && i % 50 === 0) await new Promise(r => setImmediate(r))
      }
      const crossResolved = codeIndexInstance._resolveCrossFileRefs()
      codeIndexInstance._indexing = false
      log('info', `[reindex] done: ${files.length} files, ${crossResolved} cross-refs, ${Date.now() - t0}ms`)
    } catch (e) {
      log('error', `[reindex] failed: ${e.message}`)
      codeIndexInstance._indexing = false
    }
  })

  return { status: 'started', note: 'indexing in background, check with symbol_search when done (~3 min)' }
}
