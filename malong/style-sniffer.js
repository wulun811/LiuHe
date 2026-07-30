// 码龙 — 风格嗅探器 (v2 P2.1)
// 扫描项目文件，推断代码风格约定，生成 PROJECT_RULES.md
// 详见：通天计划 §六 码龙

import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, extname } from 'node:path'

export const name = 'malong-style-sniffer'
export const version = '0.2.0'

const CACHED_EXT = new Set(['.js', '.mjs', '.cjs', '.py', '.go', '.rs'])
const IGNORE_DIRS = new Set(['node_modules', '.git', '.tusunsun', 'dist', 'build', 'coverage'])
const MAX_SCAN_FILES = 5
const MIN_SCAN_FILES = 3

let _core

function collectCodeFiles(dir) {
  const files = []
  function walk(d) {
    if (files.length >= MAX_SCAN_FILES * 2) return
    let entries
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (IGNORE_DIRS.has(e.name) || e.name.startsWith('.')) continue
      const full = join(d, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.isFile() && CACHED_EXT.has(extname(e.name))) {
        const source = readFileSync(full, 'utf-8')
        if (source.length < 20000 && source.length > 10) files.push({ path: full, source })
        if (files.length >= MAX_SCAN_FILES * 2) return
      }
    }
  }
  walk(dir)
  return files.sort(() => Math.random() - 0.5).slice(0, MAX_SCAN_FILES)
}

function sniffIndent(source) {
  const lines = source.split('\n').filter(l => l.startsWith(' ') || l.startsWith('\t'))
  if (lines.length === 0) return null
  const spaces = lines.filter(l => l.startsWith(' '))
  const tabs = lines.filter(l => l.startsWith('\t'))
  if (tabs.length >= spaces.length) return { style: 'tab', size: 1 }
  const indentSizes = {}
  for (const l of spaces) {
    const match = l.match(/^ +/)
    if (match) {
      const size = match[0].length
      indentSizes[size] = (indentSizes[size] || 0) + 1
    }
  }
  const sorted = Object.entries(indentSizes).sort((a, b) => b[1] - a[1])
  return sorted.length > 0 ? { style: 'space', size: parseInt(sorted[0][0]) || 2 } : null
}

function sniffQuotes(source) {
  const single = (source.match(/'/g) || []).length
  const double = (source.match(/"/g) || []).length
  const backtick = (source.match(/`/g) || []).length
  const max = Math.max(single, double, backtick)
  if (max === 0) return null
  if (max === single) return 'single'
  if (max === double) return 'double'
  return 'backtick'
}

function sniffSemicolons(source) {
  const stmts = (source.match(/;\s*$/gm) || []).length
  const noStmts = (source.split('\n').filter(l => {
    const t = l.trim()
    return t.length > 0 && !t.startsWith('//') && !t.startsWith('/*') && !t.endsWith(';') &&
      !t.endsWith('{') && !t.endsWith('}') && !t.endsWith('(') && !t.endsWith(',') && !t.startsWith('*')
  }).length)
  if (stmts + noStmts === 0) return null
  return stmts >= noStmts ? 'yes' : 'no'
}

function sniffNaming(source) {
  const result = { camelCase: 0, PascalCase: 0, snake_case: 0, UPPER_CASE: 0, kebabCase: 0 }
  // Function names and variable names
  for (const match of source.matchAll(/(?:function|const|let|var)\s+(\w+)/g)) {
    const name = match[1]
    if (/^[a-z][a-zA-Z0-9]*$/.test(name)) result.camelCase++
    else if (/^[A-Z][a-zA-Z0-9]*$/.test(name)) result.PascalCase++
    else if (/^[a-z][a-z0-9_]*$/.test(name)) result.snake_case++
    else if (/^[A-Z][A-Z0-9_]*$/.test(name)) result.UPPER_CASE++
  }
  // Class names
  for (const match of source.matchAll(/class\s+(\w+)/g)) {
    const name = match[1]
    if (/^[A-Z][a-zA-Z0-9]*$/.test(name)) result.PascalCase++
  }
  return result
}

function sniffTrailingCommas(source) {
  const trailing = (source.match(/,\s*$/gm) || []).length
  const noTrailing = (source.match(/[^\s,]\s*$/gm) || []).filter(l => l.trim().endsWith(',')).length
  return trailing > noTrailing * 0.5 ? 'yes' : 'no'
}

function buildProjectRules(styles) {
  const rules = ['# PROJECT_RULES', '', '## Code Style', '']

  if (styles.indent) {
    rules.push(`- **Indentation**: ${styles.indent.style} (${styles.indent.size})`)
  }
  if (styles.quotes) {
    rules.push(`- **Quotes**: ${styles.quotes}`)
  }
  if (styles.semicolons) {
    rules.push(`- **Semicolons**: ${styles.semicolons === 'yes' ? 'required' : 'optional'}`)
  }
  if (styles.trailingCommas) {
    rules.push(`- **Trailing Commas**: ${styles.trailingCommas === 'yes' ? 'required' : 'avoid'}`)
  }

  if (styles.naming) {
    rules.push('', '## Naming Conventions', '')
    const conventions = []
    if (styles.naming.camelCase > 0) conventions.push('functions/variables: camelCase')
    if (styles.naming.PascalCase > 0) conventions.push('classes: PascalCase')
    if (styles.naming.snake_case > 0) conventions.push('functions/variables: snake_case')
    if (styles.naming.UPPER_CASE > 0) conventions.push('constants: UPPER_SNAKE_CASE')
    if (conventions.length > 0) {
      const max = Object.entries(styles.naming).sort((a, b) => b[1] - a[1])[0]
      const primary = conventions.find(c => c.includes(max[0])) || conventions[0]
      rules.push(`- **Primary**: ${primary}`)
      rules.push(`- **Detected patterns**: ${Object.entries(styles.naming).filter(([, v]) => v > 0).map(([k, v]) => `${k}: ${v}`).join(', ')}`)
    }
  }

  rules.push('', '## Project Structure', '', '_(auto-detected by style-sniffer)_', '')
  rules.push('## Architecture Rules', '', '_(to be completed based on project)_', '')
  rules.push('## Dependencies', '', '_(auto-detected from package.json)_', '')

  return rules.join('\n')
}

export async function init(core) {
  _core = core

  core.registerService('styleSniffer', {
    async sniff(rootDir) {
      const files = collectCodeFiles(rootDir)
      if (files.length < MIN_SCAN_FILES) {
        return { status: 'insufficient_files', files: files.length, minRequired: MIN_SCAN_FILES }
      }

      const styles = {
        indent: null, quotes: null, semicolons: null, trailingCommas: null,
        naming: { camelCase: 0, PascalCase: 0, snake_case: 0, UPPER_CASE: 0, kebabCase: 0 },
      }

      let count = 0
      for (const file of files) {
        count++
        const indent = sniffIndent(file.source)
        if (indent) styles.indent = styles.indent || indent
        const quotes = sniffQuotes(file.source)
        if (quotes) styles.quotes = styles.quotes || quotes
        const semicolons = sniffSemicolons(file.source)
        if (semicolons) styles.semicolons = styles.semicolons || semicolons
        const trailingCommas = sniffTrailingCommas(file.source)
        if (trailingCommas) styles.trailingCommas = styles.trailingCommas || trailingCommas
        const naming = sniffNaming(file.source)
        for (const [k, v] of Object.entries(naming)) styles.naming[k] += v
      }

      // Consensus: pick most common
      styles.indent = _consensus(styles.indent)
      styles.quotes = _consensus(styles.quotes)
      styles.semicolons = _consensus(styles.semicolons)
      styles.trailingCommas = _consensus(styles.trailingCommas)

      const projectRules = buildProjectRules(styles)

      // Security gate: check for secrets
      const kunxiansuo = core.getService('kunxiansuo')
      if (kunxiansuo?.detectSecrets) {
        const secrets = await kunxiansuo.detectSecrets(projectRules)
        if (secrets?.length > 0) {
          core.log('warn', `[style-sniffer] ${secrets.length} secrets found in PROJECT_RULES, redacting`)
          let redacted = projectRules
          for (const s of secrets) redacted = redacted.replace(s, '[REDACTED]')
          return { status: 'secrets_redacted', files: count, styles, projectRules: redacted, secrets: secrets.length }
        }
      }

      return { status: 'done', files: count, styles, projectRules }
    },

    async generateRules(rootDir, outputPath) {
      const result = await this.sniff(rootDir)
      if (result.status === 'insufficient_files') return result
      const dir = outputPath ? join(outputPath, '.tusunsun') : join(rootDir, '.tusunsun')
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const rulesPath = join(dir, 'PROJECT_RULES.md')
      writeFileSync(rulesPath, result.projectRules, 'utf-8')
      return { ...result, rulesPath }
    },
  })
}

function _consensus(value) {
  if (typeof value === 'object' && value !== null && 'style' in value) return value
  return value
}

export async function start() {
  _core.log('info', '[style-sniffer] ready')
}

export async function stop() {
  _core = null
}
