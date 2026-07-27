import { parentPort } from 'node:worker_threads'
import { readFileSync } from 'node:fs'
import { extname, relative } from 'node:path'
import Parser from 'tree-sitter'
import { LANG_MAP, LANG_HANDLERS } from './lang-parser.js'

const parserCache = {}

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

parentPort.on('message', ({ files, repo }) => {
  const results = []
  for (const fp of files) {
    const ext = extname(fp)
    const parser = getParser(ext)
    if (!parser) continue
    let source
    try { source = readFileSync(fp, 'utf-8') } catch { continue }
    const tree = parser.parse(source)
    if (!tree) continue
    const lang = LANG_MAP[ext]?.name || 'javascript'
    const handler = LANG_HANDLERS[lang]
    if (!handler || !handler.extractAll) continue
    const { symbols, refs } = handler.extractAll(tree, source)
    const relPath = repo ? relative(repo, fp) : fp
    results.push({ relPath, sourceLength: source.length, symbols, refs })
  }
  parentPort.postMessage({ results })
})
