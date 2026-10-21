// doc-files.js — 文档文件工具集（0.5.25 新增）
//
// 背景：Rust 解析服务（malong-parse）只吃 10 种代码语言，.md/.rst/.txt 这类「交付物型文件」
// 不进符号索引 —— 于是「交付物就是文档」的仓：
//   · repo_map 里整目录是空的（DOCS/ 空）
//   · code_search 永远 0 命中（它只搜符号/文件名）
//
// 本模块提供两块能力（都不进符号索引，纯字面扫描，有上限）：
//   · collectDocFiles(rootDir) → 工作区内的文档文件相对路径（供地图补节点）
//   · searchDocFiles(rootDir, query) → 文档字面命中（文件 + 行号 + 片段）
//
// 上限（防大仓扫爆）：文件数 / 单文件字节 / 深度都有界。
import { join, relative, resolve, sep, extname } from 'node:path'
import { readdirSync, readFileSync, statSync } from 'node:fs'

export const DOC_EXTS = new Set(['.md', '.markdown', '.mdx', '.rst', '.txt', '.adoc'])
export const DOC_SCAN_MAX_FILES = 200
export const DOC_SCAN_MAX_DEPTH = 8
export const DOC_SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '__pycache__', '.venv', 'venv', 'target', 'coverage', '.next',
])

// 收集工作区内的文档文件（相对 rootDir 的 posix 路径，已排序）
export function collectDocFiles(rootDir, { maxFiles = DOC_SCAN_MAX_FILES, maxDepth = DOC_SCAN_MAX_DEPTH } = {}) {
  const out = []
  const root = resolve(rootDir)
  const walk = (dir, depth) => {
    if (depth > maxDepth || out.length >= maxFiles) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (out.length >= maxFiles) return
      if (e.name.startsWith('.') || DOC_SKIP_DIRS.has(e.name)) continue
      const full = join(dir, e.name)
      if (e.isDirectory()) { walk(full, depth + 1); continue }
      if (!e.isFile()) continue
      if (!DOC_EXTS.has(extname(e.name).toLowerCase())) continue
      const rel = relative(root, full).split(sep).join('/')
      if (!rel || rel.startsWith('..')) continue
      out.push(rel)
    }
  }
  walk(root, 0)
  return out.sort()
}

// 文档字面搜索：整串 > 整词 > CJK 3 字滑窗（只扫 CJK 段）；命中按「特异度」排序 + 每文件配额
// 返回 [{ file, line, text, matched, score }]，score = 命中词长度（越长越具体）
export function searchDocFiles(rootDir, query, { limit = 10, maxFiles = DOC_SCAN_MAX_FILES, maxBytes = 2 * 1024 * 1024, perFile = 2, maxHitsPerFile = 50 } = {}) {
  const q = String(query || '').trim()
  if (!q || limit <= 0) return []
  let files = []
  try { files = collectDocFiles(rootDir, { maxFiles }) } catch { files = [] }
  if (!files.length) return []

  // 匹配词优先级：整串（最具体）> 空白分隔的整词 > CJK 3 字滑窗
  // 0.5.26 修复：滑窗只作用于 CJK 段——旧版对「整个 query 串」滑窗，把英文也切成
  // ntr/tri/ent 之类碎片去撞 CONTRIBUTING/Agent，真命中被挤出前 10（混排 query 实测复现）
  const needles = []
  const push = (n) => { if (n && !needles.includes(n)) needles.push(n) }
  push(q)
  for (const w of q.split(/\s+/)) if (w.length >= 2) push(w)
  // CJK 长句没有空格分词 → 退化为 3 字滑窗（"…关于版本协商机制…" → "版本协" 能命中）
  // 只对长 CJK 段滑窗：短词整串包含即可，滑窗只会制造噪音
  for (const run of q.match(/[\u4e00-\u9fa5]+/g) || []) {
    if (run.length <= 6) continue
    for (let i = 0; i + 3 <= run.length && needles.length < 48; i++) push(run.slice(i, i + 3))
  }
  const lowers = needles.map((n) => n.toLowerCase())

  const out = []
  for (const rel of files) {
    const abs = join(rootDir, rel)
    let content
    try {
      const st = statSync(abs)
      if (st.size > maxBytes) continue
      content = readFileSync(abs, 'utf-8')
    } catch { continue }
    const lines = content.split('\n')
    const fh = []
    for (let i = 0; i < lines.length; i++) {
      const low = lines[i].toLowerCase()
      // 取「最长」的命中词（最具体），不是第一个——否则碎片会盖掉整句命中
      let best = -1, bestLen = 0
      for (let k = 0; k < lowers.length; k++) {
        const n = lowers[k]
        if (!n || n.length <= bestLen) continue
        if (low.includes(n)) { best = k; bestLen = n.length }
      }
      if (best < 0) continue
      fh.push({ file: rel, line: i + 1, text: lines[i].trim().slice(0, 200), matched: needles[best], score: bestLen })
      if (fh.length > maxHitsPerFile) {
        // 只留该文件最具体的若干条
        let min = 0
        for (let k = 1; k < fh.length; k++) if (fh[k].score < fh[min].score) min = k
        fh.splice(min, 1)
      }
    }
    // 每文件配额：一个文件不能独占结果位
    fh.sort((a, b) => (b.score - a.score) || (a.line - b.line))
    for (const h of fh.slice(0, perFile)) out.push(h)
  }
  // 全局排序：更具体者优先；同分按文件顺序、行号
  out.sort((a, b) => (b.score - a.score) || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) || (a.line - b.line))
  return out.slice(0, limit)
}
