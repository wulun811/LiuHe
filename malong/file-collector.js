import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, relative, extname } from 'node:path'

export const DEFAULT_IGNORE_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn',
  'dist', 'build', 'out', 'target', 'coverage', 'obj', 'bin',
  '__pycache__', '.venv', 'venv', '.env', 'site-packages', '.tox', '.mypy_cache', '.pytest_cache', '.ruff_cache',
  '.next', '.nuxt', '.cache', '.parcel-cache', '.turbo', '.svelte-kit', '.output',
  '.gradle', '.idea', '.vscode',
  '.tusunsun', 'vendor', 'third_party', 'third-party',
  // 15（P1）：写管线自己的产物——journal 备份（.malong/journal/*/backup/）和碰撞备份
  // （.ai-transactions/*/backup/）此前被 watcher 当新文件索引进项目（符号重复/ref 指向备份）
  '.malong', '.ai-transactions',
  // P2-C5：去掉 lib/deps/runtime/external——通用目录名误伤用户自有源码
  // （本仓库 runtime1 曾被 runtime 规则静默排除）。第三方依赖用 .malongignore 显式声明
])
const DEFAULT_CACHED_EXT = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts', '.py', '.go', '.rs', '.c', '.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx', '.java', '.sh', '.bash'])
const MAX_RULES = 100

export function parseMalongignore(filePath) {
  if (!existsSync(filePath)) return []
  const content = readFileSync(filePath, 'utf-8')
  const rules = []
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    if (rules.length >= MAX_RULES) break
    rules.push(trimmed)
  }
  return rules
}

export function isIgnored(relPath, rules, isDir) {
  for (const rule of rules) {
    if (rule.includes('*')) {
      // **/node_modules → 任意层 node_modules；*.min.js → 文件名后缀匹配
      const post = rule.split('*').pop() || ''
      if (rule.startsWith('**/') && post.includes('/')) {
        // **/seg → 任意层级含该段
        if (relPath.split('/').some(seg => seg.includes(post.replace(/^\//, '')))) return true
        continue
      }
      if (rule.startsWith('**/')) {
        // 7（T12）：**/dist/** → post='' 且 post 不含 '/'，旧逻辑落到 startsWith('*') 分支
        // → endsWith('') 恒真 → 整个仓库被忽略（reindex/read-symbol 全链路静默空扫描）
        const mid = rule.split('**/')[1]?.split('/**')[0] || ''
        if (mid && relPath.split('/').some(s => s === mid)) return true
        continue
      }
      if (rule.startsWith('*')) {
        if (!isDir && relPath.split('/').pop().endsWith(post)) return true
        continue
      }
      const pre = rule.split('*')[0]
      if (relPath.startsWith(pre)) return true
    } else if (rule.endsWith('/')) {
      const ruleDir = rule.slice(0, -1)
      if (relPath === ruleDir || relPath.startsWith(rule)) return true
    } else {
      if (relPath === rule || relPath === rule + '/') return true
    }
  }
  return false
}

export function collectFiles(rootDir, opts = {}) {
  const {
    ignoreRules = [],
    cachedExt = DEFAULT_CACHED_EXT,
    ignoreDirs = DEFAULT_IGNORE_DIRS,
    skipDirs = [],
    maxFiles = 5000,
  } = opts

  const skipSet = new Set(skipDirs)

  const files = []
  function walk(d, depth = 0) {
    if (depth > 8) return
    let entries
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (maxFiles > 0 && files.length >= maxFiles) return
      if (ignoreDirs.has(e.name) || e.name.startsWith('.')) continue
      const full = join(d, e.name)
      const relPath = relative(rootDir, full)
      if (e.isDirectory()) {
        if (skipSet.has(relPath)) continue
        const dirPath = relPath.endsWith('/') ? relPath : relPath + '/'
        if (!isIgnored(dirPath, ignoreRules, true)) {
          walk(full, depth + 1)
        }
      } else if (e.isFile()) {
        if (isIgnored(relPath, ignoreRules, false)) continue
        if (cachedExt.has(extname(e.name))) {
          files.push({ path: full, name: e.name, isCode: true })
        }
      }
    }
  }
  walk(rootDir)
  return files
}

export function collectFilesWithDirStats(rootDir, opts = {}) {
  const {
    ignoreRules = [],
    cachedExt = DEFAULT_CACHED_EXT,
    ignoreDirs = DEFAULT_IGNORE_DIRS,
    skipDirs = [],
    maxFiles = 0,
    hardCap = 0, // 17：统计阶段硬上限——收集到 hardCap 个文件即截断（truncated=true），
    // 让 reindex 对超大仓库秒回 needs_review，而不是无上限同步 walk 全树导致请求超时
  } = opts

  const skipSet = new Set(skipDirs)
  const files = []
  const dirStats = {}
  let truncated = false

  function walk(d, depth = 0) {
    if (depth > 8) return
    let entries
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (maxFiles > 0 && files.length >= maxFiles) { truncated = true; return }
      if (hardCap > 0 && files.length >= hardCap) { truncated = true; return }
      if (ignoreDirs.has(e.name) || e.name.startsWith('.')) continue
      const full = join(d, e.name)
      const relPath = relative(rootDir, full)
      if (e.isDirectory()) {
        if (skipSet.has(relPath)) continue
        const dirPath = relPath.endsWith('/') ? relPath : relPath + '/'
        if (!isIgnored(dirPath, ignoreRules, true)) {
          walk(full, depth + 1)
        }
      } else if (e.isFile()) {
        if (isIgnored(relPath, ignoreRules, false)) continue
        if (cachedExt.has(extname(e.name))) {
          files.push({ path: full, name: e.name, isCode: true })
          const parentDir = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '.'
          dirStats[parentDir] = (dirStats[parentDir] || 0) + 1
        }
      }
    }
  }
  walk(rootDir)
  return { files, dirStats, truncated }
}