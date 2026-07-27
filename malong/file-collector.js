import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, relative, extname } from 'node:path'

export const DEFAULT_IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '__pycache__', '.venv', '.tusunsun', 'vendor', 'third_party', 'third-party', 'runtime', 'external', 'deps', 'lib', 'bin', 'obj'])
const DEFAULT_CACHED_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.py', '.go', '.rs'])
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
      const prefix = rule.split('*')[0]
      if (relPath.startsWith(prefix)) return true
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
  } = opts

  const skipSet = new Set(skipDirs)
  const files = []
  const dirStats = {}

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
          const parentDir = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '.'
          dirStats[parentDir] = (dirStats[parentDir] || 0) + 1
        }
      }
    }
  }
  walk(rootDir)
  return { files, dirStats }
}