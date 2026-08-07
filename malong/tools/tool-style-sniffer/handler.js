import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync, realpathSync } from 'node:fs'
import { join, extname, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { collectStringRanges } from '../../string-utils.js'

function guardPath(root, userPath) {
  // r23-fix3: LLM 可能传非字符串路径（数字/对象）→ resolve() 会抛 TypeError 崩溃
  if (typeof root !== 'string' || typeof userPath !== 'string' || userPath === '') return null
  const rootResolved = resolve(root)
  const resolved = resolve(rootResolved, userPath)
  const rootPrefix = rootResolved.endsWith(sep) ? rootResolved : rootResolved + sep
  return resolved === rootResolved || resolved.startsWith(rootPrefix) ? resolved : null
}

const CACHED_EXT = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts', '.py', '.go', '.rs', '.c', '.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx', '.java', '.sh', '.bash'])
// r23-fix5: 去掉通天项目私有目录名（不再特殊对待隐藏目录，统一由 startsWith('.') 规则处理）
const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage'])
const MAX_SCAN_FILES = 5
const MIN_SCAN_FILES = 3

// r23-fix2: 确定性抽样——按文件路径 sha256 排序取前 N，替代原版 Math.random()（见性成佛校验：无非确定性）
// r23-fix3: walk 上限 5000——几万文件的超大项目全量读盘会卡住 LLM 调用
// R22-⑪：只读排序后前 N 个文件内容——旧实现 walk 时读全部候选（≤5000 文件整读盘一次调用巨慢）
const MAX_WALK_FILES = 5000
function collectCodeFiles(dir) {
  const paths = []
  function walk(d) {
    if (paths.length >= MAX_WALK_FILES) return
    let entries
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (paths.length >= MAX_WALK_FILES) break
      if (IGNORE_DIRS.has(e.name) || e.name.startsWith('.')) continue
      const full = join(d, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.isFile() && CACHED_EXT.has(extname(e.name))) paths.push(full)
    }
  }
  walk(dir)
  paths.sort((a, b) => createHash('sha256').update(a).digest('hex').localeCompare(createHash('sha256').update(b).digest('hex')))
  const files = []
  for (const p of paths.slice(0, MAX_SCAN_FILES)) {
    try {
      const source = readFileSync(p, 'utf-8')
      if (source.length < 20000 && source.length > 10) files.push({ path: p, source })
    } catch { continue }
  }
  return { files, walk_truncated: paths.length > MAX_WALK_FILES }
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
  // R22-⑪：撇号污染——旧实现 `(source.match(/'/g))` 把 don't/it's 等英文撇号计为单引号
  // 改：collectStringRanges 只统计成对字符串的开引号（未闭合撇号不产区间）；返回计数供全文件聚合
  let single = 0, double = 0, backtick = 0
  for (const line of source.split('\n')) {
    for (const [s] of collectStringRanges(line)) {
      const ch = line[s]
      if (ch === "'") single++
      else if (ch === '"') double++
      else backtick++
    }
  }
  return { single, double, backtick }
}

function sniffSemicolons(source) {
  const stmts = (source.match(/;\s*$/gm) || []).length
  const noStmts = source.split('\n').filter(l => {
    const t = l.trim()
    return t.length > 0 && !t.startsWith('//') && !t.startsWith('/*') && !t.endsWith(';') &&
      !t.endsWith('{') && !t.endsWith('}') && !t.endsWith('(') && !t.endsWith(',') && !t.startsWith('*')
  }).length
  if (stmts + noStmts === 0) return null
  return stmts >= noStmts ? 'yes' : 'no'
}

function sniffNaming(source) {
  const result = { camelCase: 0, PascalCase: 0, snake_case: 0, UPPER_CASE: 0, kebabCase: 0 }
  // R22-⑱（第五轮核实）：旧只匹配 JS 关键词（function/const/let/var + class）——Python def/Go func/Rust fn
  // 全部不命中 → Python 纯项目 snake_case 恒 0 且 kebabCase 死累加器。补多语言关键词。
  for (const match of source.matchAll(/(?:function|const|let|var|def|func|fn)\s+(\w+)/g)) {
    const name = match[1]
    if (/^[a-z][a-zA-Z0-9]*$/.test(name)) result.camelCase++
    else if (/^[A-Z][a-zA-Z0-9]*$/.test(name)) result.PascalCase++
    else if (/^[a-z][a-z0-9_]*$/.test(name)) result.snake_case++
    else if (/^[A-Z][A-Z0-9_]*$/.test(name)) result.UPPER_CASE++
  }
  for (const match of source.matchAll(/(?:class|struct)\s+(\w+)/g)) {
    if (/^[A-Z][a-zA-Z0-9]*$/.test(match[1])) result.PascalCase++
  }
  return result
}

function sniffTrailingCommas(source) {
  // r23-fix: 原版 noTrailing 的 filter 恒为空（[^\s,] 保证行尾非逗号，endsWith(',') 永远 false）→ 恒判 yes
  let trailing = 0, nonTrailing = 0
  for (const raw of source.split('\n')) {
    const t = raw.trim()
    if (!t || t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || t.startsWith('#') ||
        t.endsWith('{') || t.endsWith('}') || t.endsWith('(') || t.endsWith('[') || t.endsWith(']')) continue
    if (t.endsWith(',')) trailing++
    else nonTrailing++
  }
  if (trailing + nonTrailing === 0) return null
  return { trailing, nonTrailing }
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
      // r23-fix: includes 子串匹配 'UPPER_CASE' 永远匹配不上 'UPPER_SNAKE_CASE' → 改用查表
      const map = {
        camelCase: 'functions/variables: camelCase',
        PascalCase: 'classes: PascalCase',
        snake_case: 'functions/variables: snake_case',
        UPPER_CASE: 'constants: UPPER_SNAKE_CASE',
      }
      const primary = map[max[0]] || conventions[0]
      rules.push(`- **Primary**: ${primary}`)
      rules.push(`- **Detected patterns**: ${Object.entries(styles.naming).filter(([, v]) => v > 0).map(([k, v]) => `${k}: ${v}`).join(', ')}`)
    }
  }

  rules.push('', '## Project Structure', '', '_(scope to project layout; not auto-detected)_', '')
  rules.push('## Architecture Rules', '', '_(to be completed based on project)_', '')
  rules.push('## Dependencies', '', '_(not auto-detected: derive from package.json/requirements.txt manually)_', '')

  return rules.join('\n')
}

export async function handle(args, context) {
  const workspaceDir = args?.workspace_dir
  if (!workspaceDir) {
    return { error: 'missing_parameter', message: 'workspace_dir is required' }
  }

  const scope = args?.scope || '.'
  const scanDir = scope === '.' ? workspaceDir : guardPath(workspaceDir, scope)
  if (!scanDir) {
    return { error: 'path_escape', message: `Path escapes workspace_dir: ${scope}` }
  }
  if (!existsSync(scanDir)) {
    return { error: 'dir_not_found', message: `Directory not found: ${scope}` }
  }
  // R22-⑯：symlink 目录逃逸守卫——guardPath 用 resolve 只归一化不去引用，scope 指向外部 symlink 目录时 collectCodeFiles 跟随遍历外部
  try {
    const realWs = realpathSync(workspaceDir)
    const realScan = realpathSync(scanDir)
    if (realScan !== realWs && !realScan.startsWith(realWs + sep)) {
      return { error: 'path_escape', message: `Scope resolves outside workspace_dir: ${scope}` }
    }
  } catch {
    return { error: 'path_escape', message: `Cannot resolve scope path: ${scope}` }
  }

  const { files, walk_truncated } = collectCodeFiles(scanDir)
  if (files.length < MIN_SCAN_FILES) {
    return { status: 'insufficient_files', files: files.length, min_required: MIN_SCAN_FILES, message: `Only ${files.length} code files found (need ≥${MIN_SCAN_FILES})` }
  }

  const styles = {
    indent: null, quotes: null, semicolons: null, trailingCommas: null,
    naming: { camelCase: 0, PascalCase: 0, snake_case: 0, UPPER_CASE: 0, kebabCase: 0 },
  }

  let trailingTotal = 0, nonTrailingTotal = 0
  // R22-⑪：quotes 改全文件聚合——旧 `styles.quotes || quotes` 首文件胜出（首个含引号文件说了算，样本失真）
  let quoteStats = { single: 0, double: 0, backtick: 0 }
  for (const file of files) {
    const indent = sniffIndent(file.source)
    if (indent) styles.indent = styles.indent || indent
    const q = sniffQuotes(file.source)
    quoteStats.single += q.single; quoteStats.double += q.double; quoteStats.backtick += q.backtick
    const semicolons = sniffSemicolons(file.source)
    if (semicolons) styles.semicolons = styles.semicolons || semicolons
    // r23-fix: 尾逗号是占比语义，取首个文件会失真 → 全文件聚合
    const tc = sniffTrailingCommas(file.source)
    if (tc) { trailingTotal += tc.trailing; nonTrailingTotal += tc.nonTrailing }
    const naming = sniffNaming(file.source)
    for (const [k, v] of Object.entries(naming)) styles.naming[k] += v
  }
  const maxQ = Math.max(quoteStats.single, quoteStats.double, quoteStats.backtick)
  styles.quotes = maxQ === 0 ? null
    : maxQ === quoteStats.single ? 'single'
    : maxQ === quoteStats.double ? 'double' : 'backtick'
  styles.trailingCommas = trailingTotal + nonTrailingTotal === 0 ? null : (trailingTotal >= nonTrailingTotal ? 'yes' : 'no')

  const projectRules = buildProjectRules(styles)

  let rulesPath = null
  if (args?.output) {
    const outDir = args.output === '.' ? workspaceDir : guardPath(workspaceDir, args.output)
    if (!outDir) {
      return { error: 'path_escape', message: `Output path escapes workspace_dir: ${args.output}` }
    }
    const target = join(outDir, 'PROJECT_RULES.md')
    // r23-fix2: 静默覆盖会毁掉人工维护的 rules——默认不覆盖，force=true 才写
    if (existsSync(target) && !args?.force) {
      return {
        status: 'exists',
        rules_path: target,
        warning: 'PROJECT_RULES.md already exists, not overwritten',
        project_rules: projectRules,
        next_step: 'Review the generated content above; pass force=true to overwrite, or merge manually.',
      }
    }
    // r54(P2): mkdir/write 无 try/catch——output 已存在但是文件(ENOTDIR)/权限不足时裸异常违反错误对象契约
    try {
      if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
      rulesPath = target
      writeFileSync(rulesPath, projectRules, 'utf-8')
    } catch (e) {
      return { error: 'write_failed', message: `Failed to write PROJECT_RULES.md: ${e.code || e.message}`, project_rules: projectRules, suggestion: 'Check the output directory is writable and not an existing file.' }
    }
  }

  return {
    status: 'done',
    files: files.length,
    sampled: files.map(f => f.path.startsWith(workspaceDir + '/') ? f.path.slice(workspaceDir.length + 1) : f.path),
    // R22-⑪：低置信度声明——5 文件样本不足以代表全项目风格，防 LLM 当权威规则盲信
    sample_note: `style detected from ${files.length} sampled files (deterministic sha256 pick); small sample may not represent whole project`,
    walk_truncated,
    styles,
    project_rules: projectRules,
    rules_path: rulesPath,
    next_step: rulesPath
      ? `PROJECT_RULES.md written to ${rulesPath}. Review before committing.`
      : 'Pass output="." to write PROJECT_RULES.md into the workspace.',
  }
}
