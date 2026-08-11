// 码龙 — Repo Map 生成器 (v2 P2.1 + r20)
// 多语言代码地图生成器，带缩进的文本版代码地图 (~1500 tokens/中型项目)
// 详见：通天计划 §六 码龙
// r20：数据源从「磁盘扫描 + Rust AST 解析」改为「读 code-index.db」——大仓库从几十秒降到秒级

import { createDb } from './db-adapter.js'
import { join, relative, resolve, sep, basename, isAbsolute } from 'node:path'
import { existsSync, readdirSync, statSync } from 'node:fs'

export const name = 'malong-repo-map'
export const version = '0.2.1'

const MAX_CACHE_AGE = 5 * 60 * 1000
const MAX_FOCUSED_TOKENS = 2000
// r54(P1): 非 focused（默认）也需预算——大仓库全量 map 一次调用数十万 token
const MAX_FULL_TOKENS = 30000
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

async function openDb(workspaceDir) {
  const dbPath = join(_core.getWorkspaceDir(workspaceDir), 'code-index.db')
  if (!existsSync(dbPath)) return null
  return await createDb(dbPath, { readonly: true })
}

// R19：repo_map 走独立只读 DB 连接不经服务层——对根目录树做有界 mtime 粗检（深度 ≤8、≤5000 文件），
// 与库内 max(mtime) 比对，不一致 → 结果附 index_stale 警告（避免陈旧索引生成误导性地图）
function checkRepoMapStaleness(db, rootDir) {
  let diskNewest = 0
  let diskFiles = 0
  const walk = (d, depth) => {
    if (depth > 8 || diskFiles > 5000) return
    let entries
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue
      const full = join(d, e.name)
      if (e.isDirectory()) walk(full, depth + 1)
      else if (e.isFile()) {
        diskFiles++
        try { const st = statSync(full); if (st.mtimeMs > diskNewest) diskNewest = st.mtimeMs } catch {}
      }
    }
  }
  walk(rootDir, 0)
  if (diskNewest === 0) return null
  let indexedNewest = 0
  try { indexedNewest = db.prepare('SELECT MAX(mtime) AS m FROM files').get().m || 0 } catch { return null }
  if (diskNewest > indexedNewest) {
    return { index_stale: true, note: 'Index is older than some source files — results may be stale. Run reindex(workspace_dir=...) for an up-to-date map.', disk_newest: Math.round(diskNewest), indexed_newest: Math.round(indexedNewest) }
  }
  return null
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
        if (isAbsolute(f)) return normalizeDbPath(relative(workspaceDir, f).replace(/\\/g, '/'), workspaceDir)
        return f
      }))
    : null

  const byFile = new Map()
  let skippedOutside = 0
  for (const r of rows) {
    const normPath = normalizeDbPath(r.path, workspaceDir)
    if (filterSet && !filterSet.has(normPath)) continue
    // scanDir 可能是 workspace 子目录：换算相对路径
    let rel = normPath
    if (rootDir !== workspaceDir) {
      const full = join(workspaceDir, normPath)
      const rp = relative(rootDir, full)
      // R17-4：目录外文件跳过计数——否则 LLM 以为 scanDir 内只有这些符号
      if (rp.startsWith('..' + sep) || rp === '..') { skippedOutside++; continue }
      rel = rp
    }
    if (!byFile.has(rel)) byFile.set(rel, [])
    byFile.get(rel).push({ name: r.name, type: TYPE_SHORT[r.type] || r.type, line: r.line })
  }
  return { files: [...byFile.entries()].map(([path, symbols]) => ({ path, symbols })), rows: rows.length, ...(skippedOutside > 0 ? { skipped_outside: skippedOutside } : {}) }
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

// ── 骨架化分页（r23：截断必须给导航）──
// 核心思想：map 超预算时不再简单截断——第一页永远输出完整骨架（全部顶层条目 + 页号），
// 详情只渲染当前页。LLM 调用一次就知道仓库有哪些主目录、各自在第几页，
// 然后精确翻页（page=）或过滤（prefix=）。翻页后骨架始终保留（导航不断）。

function matchPrefix(name, prefix) {
  if (!prefix) return true
  const first = (name[0] || '').toLowerCase()
  if (prefix === '#') return !/^[a-z]$/.test(first)
  if (/^[a-z]$/.test(prefix)) return first === prefix
  if (/^[a-z]-[a-z]$/.test(prefix)) {
    const [a, b] = prefix.split('-')
    return first >= a && first <= b
  }
  return false
}

function pruneTree(node, maxChildren, maxSymbols) {
  if (node.type === 'dir' && node.children) {
    node.children = node.children.slice(0, maxChildren)
    node.children.forEach((c) => pruneTree(c, maxChildren, maxSymbols))
  }
  if (node.type === 'file' && node.symbols.length > maxSymbols) {
    node.symbols = node.symbols.slice(0, maxSymbols)
  }
}

// 渲染单个顶层条目（首行 ├──/└── + name，子树递归 renderTree）
function renderEntry(node, isLast) {
  const prefix = isLast ? '└── ' : '├── '
  const suffix = node.type === 'dir' ? '/' : ''
  let out = prefix + node.name + suffix + '\n'
  const childIndent = isLast ? '    ' : '│   '
  if (node.type === 'file' && node.symbols.length > 0) {
    for (let i = 0; i < node.symbols.length; i++) {
      const s = node.symbols[i]
      out += childIndent + (i === node.symbols.length - 1 ? '└── ' : '├── ') + s.type + ' ' + s.name + ':' + s.line + '\n'
    }
  }
  if (node.type === 'dir' && node.children) {
    for (let i = 0; i < node.children.length; i++) {
      out += renderTree(node.children[i], childIndent, i === node.children.length - 1)
    }
  }
  return out
}

function renderPaginated(tree, opts = {}) {
  const { page = 1, pageSize = 40, prefix, pageSizeTokens, focused } = opts
  let top = tree.children
  if (prefix) top = top.filter((n) => matchPrefix(n.name, prefix))
  const totalEntries = top.length

  // 每条目原始渲染成本（未 prune）
  const costs = top.map((n) => estimateTokens(renderEntry(n, true)))

  // 贪心装页：token 预算为主 + page_size 条数双保险
  const pages = []
  let cur = null
  for (let i = 0; i < totalEntries; i++) {
    const c = costs[i]
    const limitReached = pageSize > 0 && cur && cur.entries.length >= pageSize
    const budgetReached = cur && cur.tokens + c > pageSizeTokens && cur.entries.length > 0
    if (!cur || limitReached || budgetReached) {
      cur = { entries: [], tokens: 0 }
      pages.push(cur)
    }
    cur.entries.push(i)
    cur.tokens += c
  }
  if (pages.length === 0) pages.push({ entries: [], tokens: 0 })
  const totalPages = pages.length
  const clampedPage = Math.min(Math.max(1, page), totalPages)
  const outOfRange = page !== clampedPage

  // 骨架：全部顶层条目 + 页号（结构化完整返回；文本有预算上限防喧宾夺主）
  const skeleton = []
  for (let p = 0; p < pages.length; p++) {
    for (const idx of pages[p].entries) {
      skeleton.push({ name: top[idx].name + (top[idx].type === 'dir' ? '/' : ''), page: p + 1, detail: p + 1 === clampedPage })
    }
  }
  const SKELETON_BUDGET = Math.max(400, Math.floor(pageSizeTokens * 0.2))
  const skelLines = []
  let skelTokens = 0
  let skelOmitted = 0
  for (const s of skeleton) {
    const line = `  ${s.name}  (p${s.page})`
    const t = estimateTokens(line)
    if (skelTokens + t > SKELETON_BUDGET) { skelOmitted++; continue }
    skelLines.push(line)
    skelTokens += t
  }

  // 详情：当前页条目（focused 模式 prune 40 子项 / 6 符号）
  const curEntries = pages[clampedPage - 1].entries
  if (focused) {
    for (const idx of curEntries) pruneTree(top[idx], 40, 6)
  }
  const detailParts = curEntries.map((idx, i) => renderEntry(top[idx], i === curEntries.length - 1))

  // 拼装 + 预算兜底（行截断）
  let map = `${tree.name}/\n` + (skelLines.length ? skelLines.join('\n') + '\n' : '')
  if (skelOmitted > 0) map += `  ... +${skelOmitted} more top-level entries (use prefix=... to filter)\n`
  map += '\n' + detailParts.join('')

  let truncated = clampedPage < totalPages || skelOmitted > 0
  if (estimateTokens(map) > pageSizeTokens) {
    const lines = map.split('\n')
    let keep = 0
    let used = 0
    const budget = pageSizeTokens * CHARS_PER_TOKEN
    while (keep < lines.length - 1 && used + lines[keep].length + 1 <= budget) {
      used += lines[keep].length + 1
      keep++
    }
    map = lines.slice(0, keep).join('\n') + '\n... (truncated; use page=N to view other pages or dir=... to drill down)'
    truncated = true
  }

  return {
    map,
    page: clampedPage,
    page_size: pageSize,
    total_pages: totalPages,
    total_entries: totalEntries,
    truncated,
    next_page: clampedPage < totalPages ? clampedPage + 1 : undefined,
    skeleton,
    ...(outOfRange ? { page_out_of_range: true, suggestion: `page out of range: requested ${page}, total_pages=${totalPages}. Showing last page.` } : {}),
  }
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
      const db = await openDb(workspaceDir)
      if (!db) {
        return { error: 'workspace_not_indexed', message: `Workspace not indexed: ${workspaceDir}`, suggestion: `Call reindex(workspace_dir="${workspaceDir}") first` }
      }
      try {
        const { files, rows } = queryFilesWithSymbols(db, rootDir, workspaceDir, null, null)
        const tree = buildTree(files, basename(resolve(rootDir)))
        // r23：骨架化分页——超预算不再盲截断，返回全局骨架 + 当前页详情
        const paginated = renderPaginated(tree, {
          page: opts.page || 1,
          pageSize: opts.pageSize ?? 40,
          prefix: opts.prefix,
          pageSizeTokens: MAX_FULL_TOKENS,
          focused: false,
        })
        _cache = { map: paginated.map, files: files.length, timestamp: Date.now() }
        _cacheTime = Date.now()
        _injectToYingMini(paginated.map)
        const stale = checkRepoMapStaleness(db, rootDir)
        return { files: files.length, tokens: estimateTokens(paginated.map), ...paginated, ...(stale ? { index_stale_note: stale.note } : {}) }
      } finally {
        db.close()
      }
    },

    async generateFocused(rootDir, opts = {}) {
      const { workspaceDir = rootDir, relevantFiles, relevantEntities } = opts
      const db = await openDb(workspaceDir)
      if (!db) {
        return { error: 'workspace_not_indexed', message: `Workspace not indexed: ${workspaceDir}`, suggestion: `Call reindex(workspace_dir="${workspaceDir}") first` }
      }
      try {
        const { files, rows } = queryFilesWithSymbols(db, rootDir, workspaceDir, relevantFiles, relevantEntities)
        const tree = buildTree(files, basename(resolve(rootDir)))
        // r23：骨架化分页——focused 同样保留全局骨架 + 页号，翻页不断导航
        const paginated = renderPaginated(tree, {
          page: opts.page || 1,
          pageSize: opts.pageSize ?? 40,
          prefix: opts.prefix,
          pageSizeTokens: MAX_FOCUSED_TOKENS,
          focused: true,
        })

        _injectToYingMini(paginated.map)
        const stale = checkRepoMapStaleness(db, rootDir)
        return { files: files.length, tokens: estimateTokens(paginated.map), ...paginated, ...(stale ? { index_stale_note: stale.note } : {}) }
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
