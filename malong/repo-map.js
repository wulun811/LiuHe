// 码龙 — Repo Map 生成器 (v2 P2.1)
// 多语言代码地图生成器，带缩进的文本版代码地图 (~1500 tokens/中型项目)
// 详见：通天计划 §六 码龙

import { readFileSync } from 'node:fs'
import { join, relative, extname, basename } from 'node:path'
import { collectFiles } from './file-collector.js'

export const name = 'malong-repo-map'
export const version = '0.2.0'

const MAX_CACHE_AGE = 5 * 60 * 1000
const MAX_FOCUSED_TOKENS = 2000
const CHARS_PER_TOKEN = 4

let _core, _langParser, _cache = null, _cacheTime = 0

async function extractTopSymbols(source, ext) {
  try {
    return await _langParser.extractTopLevelAsync(source, ext)
  } catch {
    return []
  }
}

function estimateTokens(text) {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

async function buildTree(files, rootDir, relevantFiles, relevantEntities) {
  const useFilter = relevantFiles && relevantFiles.length > 0
  const filterSet = useFilter ? new Set(relevantFiles.map(f => f.startsWith('/') ? f : join(rootDir, f))) : null
  const entitySet = relevantEntities && relevantEntities.length > 0 ? new Set(relevantEntities) : null

  // Build tree structure
  const tree = { name: basename(rootDir), type: 'dir', children: [], depth: 0 }
  let parseCount = 0

  for (const file of files) {
    if (filterSet && !filterSet.has(file.path)) continue
    const rel = relative(rootDir, file.path)
    const parts = rel.split('/')
    let current = tree

    for (let i = 0; i < parts.length; i++) {
      const isLast = i === parts.length - 1
      if (isLast) {
        // 7：先 stat 后整读——巨型生成文件（bundle/vendor）readFileSync 抛 RangeError 毁掉整个 map 工具
        let src = null
        try {
          if (statSync(file.path).size < 50000) src = readFileSync(file.path, 'utf-8')
        } catch {}
        const symbols = file.isCode && src != null
          ? await extractTopSymbols(src, extname(file.path)) : []
        const filtered = entitySet ? symbols.filter(s => entitySet.has(s.name)) : symbols
        const entry = { name: parts[i], type: 'file', symbols: filtered, depth: i + 1 }
        current.children.push(entry)
      } else {
        let dir = current.children.find(c => c.type === 'dir' && c.name === parts[i])
        if (!dir) {
          dir = { name: parts[i], type: 'dir', children: [], depth: i + 1 }
          current.children.push(dir)
        }
        current = dir
      }
    }
    parseCount++
    if (parseCount % 50 === 0 && typeof global.gc === 'function') {
      global.gc()
      await new Promise(r => setImmediate(r))
    }
  }

  return tree
}

function renderTree(node, indent = '', isLast = true) {
  const prefix = indent + (isLast ? '└── ' : '├── ')
  const suffix = node.type === 'dir' ? '/' : ''
  let result = prefix + node.name + suffix + '\n'

  if (node.type === 'file' && node.symbols.length > 0) {
    const childIndent = indent + (isLast ? '    ' : '│   ')
    for (let i = 0; i < node.symbols.length; i++) {
      const s = node.symbols[i]
      const last = i === node.symbols.length - 1
      result += childIndent + (last ? '└── ' : '├── ') + s.type + ' ' + s.name + ':' + s.line + '\n'
    }
  }

  if (node.type === 'dir' && node.children) {
    for (let i = 0; i < node.children.length; i++) {
      result += renderTree(node.children[i], indent + (isLast ? '    ' : '│   '), i === node.children.length - 1)
    }
  }

  return result
}

async function getFilesByEntities(files, rootDir, entities) {
  const result = []
  const entitySet = new Set(entities)
  let parseCount = 0
  for (const f of files) {
    if (!f.isCode) continue
    // 7：先 stat 后整读（超大文件 RangeError 直接毁掉整个 getFilesByEntities）
    let source = null
    try {
      if (statSync(f.path).size <= 100000) source = readFileSync(f.path, 'utf-8')
    } catch {}
    if (source == null) continue
    const syms = await extractTopSymbols(source, extname(f.path))
    if (syms.some(s => entitySet.has(s.name))) {
      result.push(f)
    }
    parseCount++
    if (parseCount % 50 === 0 && typeof global.gc === 'function') {
      global.gc()
      await new Promise(r => setImmediate(r))
    }
  }
  return result
}

function _injectToYingMini(map) {
  if (!_core) return
  const yingMini = _core.getService('ying-mini')
  if (yingMini?.setRepoMap) {
    yingMini.setRepoMap(map)
  }
}

export async function init(core) {
  _core = core
  _langParser = core.getService('langParser')
  if (!_langParser) throw new Error('[repo-map] lang-parser service required but not registered')

  await core.registerService('repoMap', {
    async generate(rootDir, opts = {}) {
      const { ignoreRules, relevantFiles, relevantEntities } = opts
      const files = collectFiles(rootDir, { ignoreRules: ignoreRules || [] })
      const tree = await buildTree(files, rootDir)
      const map = renderTree(tree)
      _cache = { map, files: files.length, timestamp: Date.now() }
      _cacheTime = Date.now()
      // 注入番天印 L2 结构记忆
      _injectToYingMini(map)
      return { map, files: files.length, tokens: estimateTokens(map) }
    },

    async generateFocused(rootDir, opts = {}) {
      const { relevantFiles, relevantEntities, ignoreRules } = opts
      let files = collectFiles(rootDir, { ignoreRules: ignoreRules || [] })
      if (relevantEntities && relevantEntities.length > 0) {
        files = await getFilesByEntities(files, rootDir, relevantEntities)
      }
      const tree = await buildTree(files, rootDir, relevantFiles || null, relevantEntities || null)
      let map = renderTree(tree)
      const tokens = estimateTokens(map)

      if (tokens > MAX_FOCUSED_TOKENS) {
        function prune(node) {
          if (node.type === 'file') node.symbols = []
          if (node.type === 'dir' && node.children) node.children.forEach(prune)
        }
        prune(tree)
        map = renderTree(tree)
      }
      let truncated = estimateTokens(map)
      if (truncated > MAX_FOCUSED_TOKENS) {
        map = map.split('\n').slice(0, 400).join('\n') + '\n... (truncated)'
        truncated = estimateTokens(map)
      }

      _injectToYingMini(map)
      return { map, files: files.length, tokens: truncated }
    },

    getSummary() {
      if (_cache && (Date.now() - _cacheTime) < MAX_CACHE_AGE) {
        return { ..._cache, cached: true }
      }
      return _cache ? { ..._cache, cached: false, stale: true } : null
    },

    invalidate(filePath) {
      _cache = null
      _cacheTime = 0
      return true
    },
  })
}

export async function start() {
  _core.log('info', '[repo-map] ready')
}

export async function stop() {
  _cache = null
  _langParser = null
}
