// 码龙 — Repo Map 生成器 (v2 P2.1 + r20)
// 多语言代码地图生成器，带缩进的文本版代码地图 (~1500 tokens/中型项目)
// 详见：通天计划 §六 码龙
// r20：数据源从「磁盘扫描 + Rust AST 解析」改为「读 code-index.db」——大仓库从几十秒降到秒级

import Database from 'better-sqlite3'
import { join, relative, resolve, sep, basename } from 'node:path'
import { existsSync } from 'node:fs'

export const name = 'malong-repo-map'
export const version = '0.2.1'

const MAX_CACHE_AGE = 5 * 60 * 1000
const MAX_FOCUSED_TOKENS = 2000
const CHARS_PER_TOKEN = 4

// DB type → 展示缩写（对齐 parse-client 的 kind 输出：fn/cls/var/...）
const TYPE_SHORT = {
  function: 'fn', method: 'fn', class: 'cls', variable: 'var',
  interface: 'iface', type: 'type', export: 'exp', import: 'imp',
}

let _core, _cache = null, _cacheTime = 0

function estimateTokens(text) {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

function openDb(workspaceDir) {
  const dbPath = join(_core.getWorkspaceDir(workspaceDir), 'code-index.db')
  if (!existsSync(dbPath)) return null
  return new Database(dbPath, { readonly: true })
}

// 归一化 DB path：历史库基座可能是 workspace 根，也可能是 workspace 的父目录（path 带 basename 前缀）
function normalizeDbPath(p, workspaceDir) {
  const base = basename(resolve(workspaceDir))
  if (p === base) return '.'
  if (p.startsWith(base + '/')) return p.slice(base.length + 1)
  return p
}

// 从索引读文件 + 顶层符号（零磁盘扫描、零 AST 解析）
function queryFilesWithSymbols(db, rootDir, workspaceDir, relevantFiles, relevantEntities) {
  let sql = `SELECT f.path AS path, s.name AS name, s.type AS type, s.start_line AS line
             FROM symbols s JOIN files f ON s.file_id = f.id`
  const params = []
  if (relevantEntities && relevantEntities.length > 0) {
    sql += ` WHERE s.name IN (${relevantEntities.map(() => '?').join(',')})`
    params.push(...relevantEntities)
  }
  sql += ' ORDER BY s.start_line'
  const rows = db.prepare(sql).all(...params)

  const filterSet = relevantFiles && relevantFiles.length > 0
    ? new Set(relevantFiles.map(f => {
        if (f.startsWith('/')) return normalizeDbPath(relative(workspaceDir, f), workspaceDir)
        return f
      }))
    : null

  const byFile = new Map()
  for (const r of rows) {
    const normPath = normalizeDbPath(r.path, workspaceDir)
    if (filterSet && !filterSet.has(normPath)) continue
    // scanDir 可能是 workspace 子目录：换算相对路径
    let rel = normPath
    if (rootDir !== workspaceDir) {
      const full = join(workspaceDir, normPath)
      const rp = relative(rootDir, full)
      if (rp.startsWith('..' + sep) || rp === '..') continue // 目录外文件跳过
      rel = rp
    }
    if (!byFile.has(rel)) byFile.set(rel, [])
    byFile.get(rel).push({ name: r.name, type: TYPE_SHORT[r.type] || r.type, line: r.line })
  }
  return { files: [...byFile.entries()].map(([path, symbols]) => ({ path, symbols })), rows: rows.length }
}

function buildTree(entries, rootName) {
  const tree = { name: rootName, type: 'dir', children: [], depth: 0 }
  for (const { path, symbols } of entries) {
    const parts = path.split('/')
    let current = tree
    for (let i = 0; i < parts.length; i++) {
      const isLast = i === parts.length - 1
      if (isLast) {
        current.children.push({ name: parts[i], type: 'file', symbols, depth: i + 1 })
      } else {
        let dir = current.children.find(c => c.type === 'dir' && c.name === parts[i])
        if (!dir) {
          dir = { name: parts[i], type: 'dir', children: [], depth: i + 1 }
          current.children.push(dir)
        }
        current = dir
      }
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

function _injectToYingMini(map) {
  if (!_core) return
  const yingMini = _core.getService('ying-mini')
  if (yingMini?.setRepoMap) {
    yingMini.setRepoMap(map)
  }
}

export async function init(core) {
  _core = core

  await core.registerService('repoMap', {
    async generate(rootDir, opts = {}) {
      const { workspaceDir = rootDir } = opts
      const db = openDb(workspaceDir)
      if (!db) {
        return { error: 'workspace_not_indexed', message: `Workspace not indexed: ${workspaceDir}`, suggestion: `Call reindex(workspace_dir="${workspaceDir}") first` }
      }
      try {
        const { files, rows } = queryFilesWithSymbols(db, rootDir, workspaceDir, null, null)
        const tree = buildTree(files, basename(resolve(rootDir)))
        const map = renderTree(tree)
        _cache = { map, files: files.length, timestamp: Date.now() }
        _cacheTime = Date.now()
        _injectToYingMini(map)
        return { map, files: files.length, tokens: estimateTokens(map) }
      } finally {
        db.close()
      }
    },

    async generateFocused(rootDir, opts = {}) {
      const { workspaceDir = rootDir, relevantFiles, relevantEntities } = opts
      const db = openDb(workspaceDir)
      if (!db) {
        return { error: 'workspace_not_indexed', message: `Workspace not indexed: ${workspaceDir}`, suggestion: `Call reindex(workspace_dir="${workspaceDir}") first` }
      }
      try {
        const { files, rows } = queryFilesWithSymbols(db, rootDir, workspaceDir, relevantFiles, relevantEntities)
        const tree = buildTree(files, basename(resolve(rootDir)))
        let map = renderTree(tree)
        const tokens = estimateTokens(map)

        if (tokens > MAX_FOCUSED_TOKENS) {
          // 20：不再清空符号——超限时先截文件数，符号保留（地图应返回函数，而非光秃目录树）
          function prune(node) {
            if (node.type === 'dir' && node.children) {
              node.children = node.children.slice(0, 40)
              node.children.forEach(prune)
            }
            if (node.type === 'file' && node.symbols.length > 6) {
              node.symbols = node.symbols.slice(0, 6)
            }
          }
          prune(tree)
          map = renderTree(tree)
        }
        let truncated = estimateTokens(map)
        if (truncated > MAX_FOCUSED_TOKENS) {
          // 20：按 token 预算截断（旧：固定 400 行——每行含符号时仍超 2000t）
          const lines = map.split('\n')
          let budget = MAX_FOCUSED_TOKENS * CHARS_PER_TOKEN
          let keep = 0
          while (keep < lines.length - 1 && budget > 0) {
            budget -= lines[keep].length + 1
            keep++
          }
          map = lines.slice(0, keep).join('\n') + '\n... (truncated)'
          truncated = estimateTokens(map)
        }

        _injectToYingMini(map)
        return { map, files: files.length, tokens: truncated }
      } finally {
        db.close()
      }
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
}
