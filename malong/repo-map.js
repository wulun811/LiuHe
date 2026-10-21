// 码龙 — Repo Map 生成器 (v2 P2.1 + r20)
// 多语言代码地图生成器，带缩进的文本版代码地图 (~1500 tokens/中型项目)
// 详见：通天计划 §六 码龙
// r20：数据源从「磁盘扫描 + Rust AST 解析」改为「读 code-index.db」——大仓库从几十秒降到秒级

import { createDb } from './db-adapter.js'
import { join, relative, resolve, sep, basename, isAbsolute } from 'node:path'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { langOf } from './symbol-anchors.js'

export const name = 'malong-repo-map'
export const version = '0.2.1'

const MAX_CACHE_AGE = 5 * 60 * 1000
const MAX_FOCUSED_TOKENS = 2000
// r54(P1): 非 focused（默认）也需预算——大仓库全量 map 一次调用数十万 token
const MAX_FULL_TOKENS = 30000
const CHARS_PER_TOKEN = 4
// F3/F5（0.5.14 Windows 复核）：测试/夹具/基准目录判定——地图默认（紧凑入口）不展开深层夹具，
// 与 code-search/entry-shared 同口径（旧实现只把顶层测试目录挪后，真实树 malong→tests→fixtures 内部展开顺序不变）。
const TESTY_DIR_RE = /^(tests?|__tests__|specs?|fixtures?|benchmarks?|mocks?|samples?)$/i

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
// P1 修复（2026-10-12 狗粮发现）：只统计「应被索引的代码文件」——索引 files 表只含代码文件，旧实现把
// README/package.json 等非代码文件也计入 max(mtime)，任何非代码写入都让判定恒 stale 且 reindex 清不掉
//（非代码永不进索引）→ 永久误报。导出供测试。
export function checkRepoMapStaleness(db, rootDir) {
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
        if (!langOf(e.name)) continue // P1：非代码文件不进索引，也不参与陈旧比对
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
    return { index_stale: true, note: 'Index is older than some source files — results may be stale. Run reindex(workspace_dir=...) for an up-to-date map (if a reindex was just started, this clears when it completes).', disk_newest: Math.round(diskNewest), indexed_newest: Math.round(indexedNewest) }
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
  const hitNames = new Set()
  for (const r of rows) {
    hitNames.add(r.name)
    const normPath = normalizeDbPath(r.path, workspaceDir)
    if (filterSet && !filterSet.has(normPath)) continue
    // scanDir 可能是 workspace 子目录：换算相对路径
    let rel = normPath
    if (rootDir !== workspaceDir) {
      const full = join(workspaceDir, normPath)
      const rp = relative(rootDir, full)
      // R17-4：目录外文件跳过计数——否则 LLM 以为 scanDir 内只有这些符号
      if (rp.startsWith('..' + sep) || rp === '..') { skippedOutside++; continue }
      // Tree paths use '/' on every platform; Windows relative() returns '\\'.
      // Without normalization, nested directories become single file entries and
      // their fold/drill-down actions disappear after the first directory hop.
      rel = rp.split(sep).join('/')
    }
    if (!byFile.has(rel)) byFile.set(rel, [])
    byFile.get(rel).push({ name: r.name, type: TYPE_SHORT[r.type] || r.type, line: r.line })
  }
  const missingEntities = relevantEntities && relevantEntities.length > 0
    ? relevantEntities.filter(e => !hitNames.has(e))
    : []
  return {
    files: [...byFile.entries()].map(([path, symbols]) => ({ path, symbols })),
    rows: rows.length,
    ...(missingEntities.length > 0
      ? { entities_not_found: missingEntities, note: `Entities not found in index: ${missingEntities.join(', ')} — check symbol names (case-sensitive) or run reindex to refresh` }
      : {}),
    ...(skippedOutside > 0 ? { skipped_outside: skippedOutside } : {}),
  }
}

function buildTree(entries, rootName) {
  const tree = { name: rootName, type: 'dir', children: [], depth: 0, path: '' }
  for (const { path, symbols, doc } of entries) {
    const parts = path.split('/')
    let current = tree
    for (let i = 0; i < parts.length; i++) {
      const isLast = i === parts.length - 1
      const childPath = parts.slice(0, i + 1).join('/')
      if (isLast) {
        current.children.push({ name: parts[i], type: 'file', symbols, depth: i + 1, path: childPath, ...(doc ? { doc: true } : {}) })
      } else {
        let dir = current.children.find(c => c.type === 'dir' && c.name === parts[i])
        if (!dir) {
          dir = { name: parts[i], type: 'dir', children: [], depth: i + 1, path: childPath }
          current.children.push(dir)
        }
        current = dir
      }
    }
  }
  sortChildren(tree)
  return tree
}

// F3（0.5.14 Windows 复核）：每一层都把测试/夹具目录排到末尾（旧只调顶层顺序，内部展开顺序不变）
function sortChildren(node) {
  if (!node || node.type !== 'dir' || !node.children) return
  const idx = new Map(node.children.map((c, i) => [c, i]))
  node.children.sort((a, b) => {
    const ta = (a.type === 'dir' && TESTY_DIR_RE.test(a.name)) ? 1 : 0
    const tb = (b.type === 'dir' && TESTY_DIR_RE.test(b.name)) ? 1 : 0
    return ta - tb || idx.get(a) - idx.get(b)
  })
  for (const c of node.children) sortChildren(c)
}

function countFilesIn(node) {
  if (!node) return 0
  if (node.type === 'file') return 1
  let n = 0
  for (const c of node.children || []) n += countFilesIn(c)
  return n
}

function renderTree(node, indent = '', isLast = true, opts = {}) {
  const prefix = indent
  const suffix = node.type === 'dir' ? '/' : ''
  // F3（0.5.14 Windows 复核）：紧凑入口默认不展开测试/夹具子树——一行折叠 + 下钻路径（按需 dir=... 展开）
  if (node.type === 'dir' && opts.foldTests && TESTY_DIR_RE.test(node.name) && node.children) {
    const rel = (opts.pathPrefix || '') + node.path
    if (Array.isArray(opts.folded) && rel && !opts.folded.includes(rel)) opts.folded.push(rel)
    return prefix + node.name + '/  (' + countFilesIn(node) + ' test/fixture file(s) folded — drill down: dir="' + rel + '")\n'
  }
  let result = prefix + node.name + suffix + (node.doc ? '  (doc)' : '') + '\n'

  if (node.type === 'file' && node.symbols.length > 0) {
    const childIndent = indent + '  '
    for (let i = 0; i < node.symbols.length; i++) {
      const s = node.symbols[i]
      result += childIndent + s.type + ' ' + s.name + ':' + s.line + '\n'
    }
  }

  if (node.type === 'dir' && node.children) {
    for (let i = 0; i < node.children.length; i++) {
      result += renderTree(node.children[i], indent + '  ', i === node.children.length - 1, opts)
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

// ── 0.5.25：文档文件纳入地图 ──
// .md/.mdx/.rst/.txt 这类「交付物型文件」不进符号索引（Rust 解析服务只吃代码语言），于是
// 「交付物就是文档」的仓在 map 里整个目录是空的（实测 DOCS/ 空）。地图额外做一次受限磁盘扫描，
// 把文档文件作为叶子节点补进树里——不进符号索引、不进搜索，只让地图看得见。
// （扫描实现与 code_search 的文档兜底共用 doc-files.js）
import { collectDocFiles } from './doc-files.js'

function withDocFiles(files, rootDir) {
  let docs = []
  try { docs = collectDocFiles(rootDir) } catch { docs = [] }
  if (!docs.length) return { files, doc_files: 0, doc_files_total: 0 }
  const known = new Set(files.map((f) => f.path))
  const extra = docs.filter((d) => !known.has(d)).map((d) => ({ path: d, symbols: [], doc: true }))
  return {
    files: [...files, ...extra],
    doc_files: extra.length,
    doc_files_total: docs.length,
  }
}

// 渲染单个顶层条目（纯缩进 + name，子树递归 renderTree）
function renderEntry(node, isLast, opts = {}) {
  const prefix = ''
  const suffix = node.type === 'dir' ? '/' : ''
  if (node.type === 'dir' && opts.foldTests && TESTY_DIR_RE.test(node.name) && node.children) {
    const rel = (opts.pathPrefix || '') + node.path
    if (Array.isArray(opts.folded) && rel && !opts.folded.includes(rel)) opts.folded.push(rel)
    return prefix + node.name + '/  (' + countFilesIn(node) + ' test/fixture file(s) folded — drill down: dir="' + rel + '")\n'
  }
  let out = prefix + node.name + suffix + (node.doc ? '  (doc)' : '') + '\n'
  const childIndent = '  '
  if (node.type === 'file' && node.symbols.length > 0) {
    for (let i = 0; i < node.symbols.length; i++) {
      const s = node.symbols[i]
      out += childIndent + s.type + ' ' + s.name + ':' + s.line + '\n'
    }
  }
  if (node.type === 'dir' && node.children) {
    for (let i = 0; i < node.children.length; i++) {
      out += renderTree(node.children[i], '  ', i === node.children.length - 1, opts)
    }
  }
  return out
}

function renderPaginated(tree, opts = {}) {
  const { page = 1, pageSize = 40, prefix, pageSizeTokens, focused, foldTests = false, scope = null, pathPrefix = '' } = opts
  let top = tree.children
  if (prefix) top = top.filter((n) => matchPrefix(n.name, prefix))
  // H01/F3（0.5.14 复核）：顶层分层排序已由 buildTree 逐层完成（测试/夹具/基准目录排末尾，生产入口在前）；
  // focused（围绕目标展开）或 prefix 过滤时保持原序（用户已给出明确目标）。
  const folded = []
  const renderOpts = { foldTests, folded, pathPrefix }
  const totalEntries = top.length

  // 每条目原始渲染成本（未 prune）
  const costs = top.map((n) => estimateTokens(renderEntry(n, true, renderOpts)))

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

  // 骨架：全部顶层条目 + 页号（文本有预算上限防喧宾夺主）
  const skeleton = []
  for (let p = 0; p < pages.length; p++) {
    for (const idx of pages[p].entries) {
      skeleton.push({ name: top[idx].name + (top[idx].type === 'dir' ? '/' : ''), page: p + 1, detail: p + 1 === clampedPage })
    }
  }
  // N1（2026-10-19 专家 011/048）：结构化骨架必须有界——旧实现把全部顶层条目 prettify 返回，
  // tests 密集目录 163 条 ≈ 12k 字符，整次响应被外围结构主导（21690 字符，而 map 文本仅 699 token）。
  // 窗口：当前页条目优先 → 相邻页 → 其余（保持原始顺序）；完整清单仍可由 page/prefix/dir 逐页取。
  const SKELETON_MAX_ENTRIES = 12
  const SKELETON_MAX_CHARS = 1200
  const skelOrder = []
  for (const idx of pages[clampedPage - 1].entries) skelOrder.push(idx)
  for (let p = 0; p < pages.length; p++) {
    if (Math.abs(p + 1 - clampedPage) === 1) for (const idx of pages[p].entries) skelOrder.push(idx)
  }
  for (let i = 0; i < skeleton.length; i++) skelOrder.push(i)
  const skelSeen = new Set()
  const picked = []
  let skelChars = 0
  for (const idx of skelOrder) {
    if (skelSeen.has(idx) || picked.length >= SKELETON_MAX_ENTRIES) continue
    const c = JSON.stringify(skeleton[idx]).length + 2
    if (picked.length > 0 && skelChars + c > SKELETON_MAX_CHARS) continue
    skelSeen.add(idx)
    picked.push(idx)
    skelChars += c
  }
  picked.sort((a, b) => a - b)
  const skeletonWindow = picked.map((idx) => skeleton[idx])
  const skeletonTotal = skeleton.length
  const skeletonOmitted = Math.max(0, skeletonTotal - skeletonWindow.length)
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
  const detailParts = curEntries.map((idx, i) => renderEntry(top[idx], i === curEntries.length - 1, renderOpts))
  const curPageDirs = curEntries.map((idx) => top[idx]).filter((n) => n && n.type === 'dir' && n.path).map((n) => (pathPrefix || '') + n.path)

  // 拼装 + 预算兜底（行截断）
  let map = `${tree.name}/\n` + (skelLines.length ? skelLines.join('\n') + '\n' : '')
  if (skelOmitted > 0) map += `  ... +${skelOmitted} more top-level entries (use prefix=... to filter)\n`
  map += '\n' + detailParts.join('')

  let truncated = clampedPage < totalPages || skelOmitted > 0
  let truncatedByBudget = false
  if (estimateTokens(map) > pageSizeTokens) {
    const notice = '\n... (truncated by the map text budget; use page=N to view other pages or dir=... to drill down)'
    // F5：截断提示本身计入预算（旧实现裁完再加提示，实际文本超出声明预算）
    const budget = pageSizeTokens * CHARS_PER_TOKEN - notice.length
    const lines = map.split('\n')
    let keep = 0
    let used = 0
    while (keep < lines.length - 1 && used + lines[keep].length + 1 <= budget) {
      used += lines[keep].length + 1
      keep++
    }
    map = lines.slice(0, keep).join('\n') + notice
    truncated = true
    truncatedByBudget = true
  }

  // N1：折叠目录清单同样有界（根目录可达数十项、长路径 1.3k+ 字符）——按条数+字符双上限截，
  // 完整下钻仍由 navigation/dir 给出（短路径优先入窗，如 malong/tests）。
  const foldedList = [...new Set(folded)]
  const foldedWindow = []
  let foldedChars = 0
  for (const d of foldedList) {
    if (foldedWindow.length >= 20) break
    if (foldedWindow.length > 0 && foldedChars + d.length + 4 > 600) break
    foldedWindow.push(d)
    foldedChars += d.length + 4
  }
  return {
    map,
    page: clampedPage,
    page_size: pageSize,
    total_pages: totalPages,
    total_entries: totalEntries,
    scope: scope || tree.name,
    truncated,
    truncated_by_budget: truncatedByBudget,
    has_next_page: clampedPage < totalPages,
    next_page: clampedPage < totalPages ? clampedPage + 1 : undefined,
    skeleton: skeletonWindow,
    skeleton_total: skeletonTotal,
    skeleton_omitted: skeletonOmitted,
    ...(skelOmitted > 0 ? { skeleton_text_omitted: skelOmitted } : {}),
    folded_dirs: foldedWindow,
    ...(foldedList.length > foldedWindow.length ? { folded_dirs_total: foldedList.length } : {}),
    current_page_dirs: curPageDirs,
    budget: { unit: 'estimated_tokens', chars_per_token: CHARS_PER_TOKEN, limit: pageSizeTokens, used: estimateTokens(map), note: 'max_tokens bounds the map TEXT only; skeleton is a bounded window (skeleton_total/omitted) — use page=/prefix=/dir= for the rest.' },
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

// F5（0.5.14 Windows 复核）：紧凑地图的可执行导航动作——每条都能原样 code_query(mode="map", ...) 调用；
// 末页明确「无下一页」（与预算截断分开）；折叠目录/本页大目录给下钻动作。
// M1（2026-10-19 专家 Windows 复核）：导航必须带**真实扫描目录** dir——旧实现只用 scope 写文案，
// next_page 缺 dir，原样执行后从子目录跳回仓库根（page=2 of repo 而非 dir）。
// dir 取工作区相对路径（与 code_query 的 dir 参数同口径）；根目录省略 dir，不用展示名反推。
function compactNavigation({ workspaceDir, scope, page, totalPages, nextPage, pageSize, maxTokens, foldedDirs, currentPageDirs, prefix, dir }) {
  const base = { workspace_dir: workspaceDir, mode: 'map', page_size: pageSize, max_tokens: maxTokens, ...(dir ? { dir } : {}), ...(prefix ? { prefix } : {}) }
  const out = []
  if (nextPage) out.push({ action: 'next_page', tool: 'code_query', args: { ...base, page: nextPage }, note: 'Next page ' + nextPage + '/' + totalPages + ' of scope ' + scope + '.' })
  else out.push({ action: 'no_next_page', note: 'Page ' + page + '/' + totalPages + ' is the last page of scope ' + scope + ' — there is no next page (this is not a budget truncation).' })
  const drills = [...new Set([...(foldedDirs || []), ...(currentPageDirs || [])])].filter((d) => d && d !== scope).slice(0, 3)
  for (const d of drills) out.push({ action: 'drill_down', tool: 'code_query', args: { ...base, page: 1, dir: d }, note: 'Drill into ' + d + ' (folded test/fixture subtree, or larger than one page) instead of re-reading this page.' })
  return out
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
        const { files: dbFiles, rows } = queryFilesWithSymbols(db, rootDir, workspaceDir, null, null)
        // 0.5.25：文档文件补进地图（不进符号索引，只让地图看得见 .md 等交付物）
        const { files, doc_files, doc_files_total } = withDocFiles(dbFiles, rootDir)
        const tree = buildTree(files, basename(resolve(rootDir)))
        // r23：骨架化分页——超预算不再盲截断，返回全局骨架 + 当前页详情
        const paginated = renderPaginated(tree, {
          page: opts.page || 1,
          pageSize: opts.pageSize ?? 40,
          prefix: opts.prefix,
          pageSizeTokens: MAX_FULL_TOKENS,
          focused: false,
        })
        _cache = { workspace: workspaceDir, map: paginated.map, files: dbFiles.length, timestamp: Date.now() }
        _cacheTime = Date.now()
        _injectToYingMini(paginated.map)
        const stale = checkRepoMapStaleness(db, rootDir)
        return { files: dbFiles.length, ...(doc_files ? { doc_files, files_total: files.length, ...(doc_files_total > doc_files ? { doc_files_total, doc_files_truncated: true } : {}) } : {}), tokens: estimateTokens(paginated.map), ...paginated, ...(stale ? { index_stale_note: stale.note } : {}) }
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
        const { files, rows, entities_not_found, note } = queryFilesWithSymbols(db, rootDir, workspaceDir, relevantFiles, relevantEntities)
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
        return { files: files.length, tokens: estimateTokens(paginated.map), ...paginated, ...(entities_not_found ? { entities_not_found, note } : {}), ...(stale ? { index_stale_note: stale.note } : {}) }
      } finally {
        db.close()
      }
    },

    // 9-A（2026-10-07 专家 Lite 建议）：紧凑导航——零候选首屏用；无 ying-mini 注入、不写共享缓存（副作用隔离）
    // F5（0.5.14 Windows 复核）：公开分页合同——page/prefix/pageSize/maxTokens 贯穿渲染，返回 scope/页码/页数/
    // 下一页/折叠目录/预算单位；默认不展开深层测试夹具；末页明确无下一页；预算截断与「还有下一页」分开。
    async generateCompact(rootDir, opts = {}) {
      const { workspaceDir = rootDir, maxTokens = 700, pageSize = 12, prefix, page = 1, scope = null, foldTests = true } = opts
      const db = await openDb(workspaceDir)
      if (!db) {
        return { error: 'workspace_not_indexed', message: 'Workspace not indexed: ' + workspaceDir }
      }
      try {
        const { files: dbFiles, skipped_outside: skippedOutside } = queryFilesWithSymbols(db, rootDir, workspaceDir, null, null)
        const rootName = basename(resolve(rootDir))
        // 0.5.25：文档文件补进地图（紧凑入口同样要看得见 .md 等交付物）
        const { files } = withDocFiles(dbFiles, rootDir)
        const tree = buildTree(files, rootName)
        // F5：折叠提示/下钻路径一律写成「工作区相对路径」（嵌套下钻时范围相对路径会指向不存在的目录）
        const rootRel = relative(resolve(workspaceDir), resolve(rootDir)).split(sep).join('/')
        const pathPrefix = rootRel && rootRel !== '.' ? rootRel + '/' : ''
        const paginated = renderPaginated(tree, { page, pageSize, prefix, pageSizeTokens: maxTokens, focused: false, foldTests, scope: scope || rootName, pathPrefix })
        const stale = checkRepoMapStaleness(db, rootDir)
        // M1：真实扫描目录（工作区相对）；根目录为 null → 导航不带 dir
        const scanDirRel = rootRel && rootRel !== '.' ? rootRel : null
        const navigation = compactNavigation({ workspaceDir, scope: paginated.scope, page: paginated.page, totalPages: paginated.total_pages, nextPage: paginated.next_page, pageSize, maxTokens, foldedDirs: paginated.folded_dirs, currentPageDirs: paginated.current_page_dirs, prefix, dir: scanDirRel })
        return {
          files: files.length,
          tokens: estimateTokens(paginated.map),
          map: paginated.map,
          skeleton: paginated.skeleton,
          skeleton_total: paginated.skeleton_total,
          skeleton_omitted: paginated.skeleton_omitted,
          ...(paginated.skeleton_text_omitted ? { skeleton_text_omitted: paginated.skeleton_text_omitted } : {}),
          scope: paginated.scope,
          page: paginated.page,
          page_size: paginated.page_size,
          total_pages: paginated.total_pages,
          total_entries: paginated.total_entries,
          next_page: paginated.next_page,
          has_next_page: paginated.has_next_page,
          truncated: paginated.truncated,
          truncated_by_budget: paginated.truncated_by_budget,
          budget: paginated.budget,
          folded_dirs: paginated.folded_dirs,
          ...(paginated.folded_dirs_total ? { folded_dirs_total: paginated.folded_dirs_total } : {}),
          current_page_dirs: paginated.current_page_dirs,
          navigation,
          ...(paginated.page_out_of_range ? { page_out_of_range: true, suggestion: paginated.suggestion } : {}),
          ...(skippedOutside ? { skipped_outside: skippedOutside } : {}),
          ...(stale ? { index_stale_note: stale.note } : {}),
        }
      } finally {
        db.close()
      }
    },

    getSummary(workspaceDir) {
      // 审查修复（二轮）：缓存单槽曾无 workspace 隔离——同进程多工作区时 A 的 map 会被 B 读到。
      // 调用方传 workspace_dir；不一致时视为 miss（不跨工作区串台）
      if (_cache && (!workspaceDir || _cache.workspace === workspaceDir) && (Date.now() - _cacheTime) < MAX_CACHE_AGE) {
        return { ..._cache, cached: true }
      }
      return _cache && (!workspaceDir || _cache.workspace === workspaceDir) ? { ..._cache, cached: false, stale: true } : null
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
