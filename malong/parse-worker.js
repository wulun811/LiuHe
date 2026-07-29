import { parentPort } from 'node:worker_threads'
import { readFileSync, statSync } from 'node:fs'
import { extname, relative } from 'node:path'
import Parser from 'tree-sitter'
import { LANG_MAP, LANG_HANDLERS } from './lang-parser.js'

const MAX_FILE_SIZE = 1024 * 1024

const parserCache = {}
let _parseCount = 0

function getParser(ext) {
  if (!parserCache[ext]) {
    const entry = LANG_MAP[ext]
    if (!entry) return null
    const p = new Parser()
    p.setLanguage(entry.lang)
    parserCache[ext] = p
  }
  return parserCache[ext]
}

parentPort.on('message', async ({ files, repo }) => {
  const results = []
  for (const fp of files) {
    const ext = extname(fp)
    const parser = getParser(ext)
    if (!parser) continue
    let size = 0
    try { size = statSync(fp).size } catch { continue }
    if (size > MAX_FILE_SIZE) continue
    let source
    try { source = readFileSync(fp, 'utf-8') } catch { continue }
    const relPath = repo ? relative(repo, fp) : fp
    try {
      const tree = parser.parse(source)
      if (!tree) continue
      const lang = LANG_MAP[ext]?.name || 'javascript'
      const handler = LANG_HANDLERS[lang]
      if (!handler || !handler.extractAll) continue
      const { symbols, refs } = handler.extractAll(tree, source)
      results.push({ relPath, sourceLength: source.length, symbols, refs })
      _parseCount++
      if (_parseCount >= 50 && typeof global.gc === 'function') {
        _parseCount = 0
        global.gc()
        await new Promise(r => setImmediate(r))
      }
    } catch { continue }
  }
  parentPort.postMessage({ results })
})
