// code_quality — 5 维质量探针（B13 缺口三）
// techDebt/overEngineering 来自 rust-service compute_metrics（AST 圈复杂度/认知复杂度/嵌套深度），
// archViolation/blastRadius/paradigmFit 为文本正则（移植 0AIT/0通天/plugins/code-quality.js）。
// 0% LLM，纯静态分析。工具内返回错误对象，不 throw。

import { readFileSync, realpathSync, existsSync } from 'node:fs'
import { extname, join, relative, isAbsolute, sep } from 'node:path'
import { stripStrings } from '../../string-utils.js'

// R22-⑪：注释/字符串剥离——blastRadius/archViolation 此前对注释里的 'eval' 等子串计数
//（实测注释-only 文件报 3 个 archViolation）；支持跨行块注释状态机
function stripCommentsAndStrings(source) {
  const lines = source.split('\n')
  let inBlock = false
  return lines.map(line => {
    let l = line
    if (inBlock) {
      const end = l.indexOf('*/')
      if (end === -1) return ''
      l = l.slice(end + 2)
      inBlock = false
    }
    const bs = l.indexOf('/*')
    if (bs !== -1) {
      const be = l.indexOf('*/', bs + 2)
      if (be === -1) { l = l.slice(0, bs); inBlock = true }
      else l = l.slice(0, bs) + l.slice(be + 2)
    }
    l = l.replace(/^\s*\/\/.*$/, '').replace(/^\s*#.*$/, '').replace(/^\s*--.*$/, '')
    return stripStrings(l)
  }).join('\n')
}

const CODE_EXTS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.go', '.rs', '.java', '.rb', '.php', '.c', '.cpp', '.h', '.sh', '.bash'])
const PARADIGM_SKIPPED = { value: 0.5, rawMatchRate: 0.5, applicable: false, note: 'non-code file; paradigm fit not meaningful' }

// r42: 文件读取必须真实文件系统（getWorkspaceDir 沙箱映射只有索引 db，MCP 下 file 模式必失败）
function isInsideWorkspace(ws, abs) {
  const rel = relative(ws, abs)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function traceId() {
  return `trc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function makeError(code, message, suggestion) {
  return { error: code, message, ...(suggestion ? { suggestion } : {}), trace_id: traceId() }
}

// ── 2. archViolation：全局 API 违规 + 深层成员访问（文本近似，无 AST 也能算） ──

function calcArchViolations(source) {
  let violations = 0
  const globalApi = /(^|\b)(process|global|root|eval|Function)\b/g
  for (const m of source.matchAll(globalApi)) violations++
  const deepMember = /(?:[\w$]+\.){3,}[\w$]+/g
  for (const m of source.matchAll(deepMember)) violations++
  return violations
}

// ── 3. blastRadius：危险 API 计数 + 文件大小代理 ──

const DANGEROUS_APIS = ['eval', 'Function', 'exec', 'execSync', 'execFile',
  'execFileSync', 'spawn', 'spawnSync', 'child_process',
  '__import__', 'os.system', 'subprocess', 'sys.exit',
  'unsafe', 'ptr::read', 'transmute']

function calcBlastRadius(source) {
  let dangerousCount = 0
  for (const api of DANGEROUS_APIS) {
    if (source.includes(api)) dangerousCount++
  }
  const sizeScore = Math.min(1, source.length / 50000)
  return { dangerousCount, sizeScore, score: Math.min(1, dangerousCount * 0.3 + sizeScore * 0.7) }
}

// ── 5. paradigmFit：项目风格一致性 ──

// r54(P1): 正确的 case 判定——旧 snake_case 用 /_/.test 令单词名(Rust fn main)判不一致；
// 每模式给可接受 case 集合，惯用形态（Go 导出 PascalCase / JS 常量 UPPER_SNAKE）不再误扣
const CASE_CHECKS = {
  snake_case: (n) => /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(n),
  camelCase: (n) => /^[a-z][a-zA-Z0-9]*$/.test(n),
  PascalCase: (n) => /^[A-Z][a-zA-Z0-9]*$/.test(n),
  UPPER_SNAKE: (n) => /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/.test(n),
}

function paradigmPatternsFor(ext) {
  if (ext === '.py') return [
    [/\bdef\s+(\w+)/g, ['snake_case']], // r54(P1): 旧 ^(\w+)=lambda|def|class 只匹配 lambda 赋值，def foo 完全不被采样
    [/\bclass\s+(\w+)/g, ['PascalCase']],
  ]
  if (ext === '.go') return [
    [/\bfunc\s+(\w+)/g, ['camelCase', 'PascalCase']], // 导出函数惯用 PascalCase
    [/\btype\s+(\w+)/g, ['PascalCase']],
  ]
  if (ext === '.rs') return [
    [/\bfn\s+(\w+)/g, ['snake_case']],
    [/\bstruct\s+(\w+)/g, ['PascalCase']],
    [/\benum\s+(\w+)/g, ['PascalCase']],
  ]
  return [
    [/\bfunction\s+(\w+)/g, ['camelCase']],
    [/\b(?:const|let|var)\s+(\w+)/g, ['camelCase', 'UPPER_SNAKE']], // const MAX_RETRIES 惯用 UPPER_SNAKE
    [/\bclass\s+(\w+)/g, ['PascalCase']],
  ]
}

function calcParadigmFit(source, ext) {
  const expectedPatterns = paradigmPatternsFor(ext)
  let matchCount = 0, totalCount = 0
  for (const [regex, acceptable] of expectedPatterns) {
    for (const match of source.matchAll(regex)) {
      totalCount++
      const name = match[1] || match[0]
      if (acceptable.some(c => CASE_CHECKS[c] && CASE_CHECKS[c](name))) matchCount++
    }
  }
  return totalCount > 0 ? matchCount / totalCount : 0.5
}

export async function handle(args, context) {
  const { langParserService, getWorkspaceDir } = context
  const workspaceDir = args?.workspace_dir
  const file = args?.file
  if (!workspaceDir) {
    return makeError('missing_parameter', 'workspace_dir is required', 'Provide the absolute path to the project root directory.')
  }
  // R22-⑯：非字符串 workspace_dir 让 join 裸抛 TypeError
  if (typeof workspaceDir !== 'string') {
    return makeError('invalid_input', `workspace_dir must be a string (got ${typeof workspaceDir})`, 'Provide a valid workspace directory path.')
  }
  if (!file) {
    return makeError('missing_parameter', 'file is required', 'Provide a file path relative to workspace_dir (e.g. "src/auth.py").')
  }

  // r43: 非字符串 file 会让 join() 抛 TypeError（r23-fix3 同教训）——先返回错误对象
  if (typeof file !== 'string') {
    return makeError('invalid_input', 'file must be a string', 'Provide a file path relative to workspace_dir.')
  }
  const absPath = join(workspaceDir, file)
  if (!isInsideWorkspace(workspaceDir, absPath)) {
    return makeError('path_blocked', `file escapes workspace: ${absPath}`, 'Provide a file path relative to workspace_dir.')
  }
  // R22-⑯：存在性检查前置——realpath 对不存在路径抛错，会误报 path_blocked 而非 file_not_found
  if (!existsSync(absPath)) {
    return makeError('file_not_found', `File not found: ${file}`, 'Provide a file path relative to workspace_dir that exists.')
  }
  // R22-⑯：symlink 逃逸守卫——isInsideWorkspace 字符串级不 realpath，file 指向 symlink 外部文件时外部源码被读取计算指标
  try {
    const realWs = realpathSync(workspaceDir)
    const realAbs = realpathSync(absPath)
    if (realAbs !== realWs && !realAbs.startsWith(realWs + sep)) {
      return makeError('path_blocked', `file resolves outside workspace: ${absPath}`, 'Provide a file path that does not escape workspace_dir via symlinks.')
    }
  } catch {
    return makeError('path_blocked', `cannot resolve file path: ${absPath}`, 'Ensure the path is accessible.')
  }
  let source
  try {
    source = readFileSync(absPath, 'utf-8')
  } catch {
    return makeError('file_not_found', `File not found: ${file}`, 'Provide a file path relative to workspace_dir that exists.')
  }

  const ext = extname(file)
  const metrics = { cyclomatic_complexity: null, cognitive_complexity: null, max_nesting_depth: null, loc: null, function_count: null, class_count: null }
  if (langParserService?.computeMetrics) {
    try {
      // 始终用 source 模式（file_path 模式要求文件真实存在于磁盘且受 workspace_root 约束）
      const m = await langParserService.computeMetrics(source, ext)
      if (m && !m.error) Object.assign(metrics, m)
    } catch {}
  }
  if (metrics.cyclomatic_complexity === null && langParserService?.computeMetricsAsync) {
    try {
      const m = await langParserService.computeMetricsAsync(source, ext)
      if (m && !m.error) Object.assign(metrics, m)
    } catch {}
  }

  const cyc = metrics.cyclomatic_complexity ?? 1
  const cog = metrics.cognitive_complexity ?? 0
  const nesting = metrics.max_nesting_depth ?? 0
  const lines = source.split('\n').length

  // techDebt：圈复杂度/认知复杂度（与通天 scoreSource 同公式）
  const techDebt = Math.min(1, (cyc / 20 + cog / 30) / 2)
  // R22-⑪：全部文本维度基于剥离注释/字符串后的 codeOnly（注释/字符串里的危险 API 名不再误报）
  const codeOnly = stripCommentsAndStrings(source)
  // archViolation：违规数 / 5
  const archRaw = calcArchViolations(codeOnly)
  const archScore = Math.min(1, archRaw / 5)
  // blastRadius：危险 API + 文件大小
  const br = calcBlastRadius(codeOnly)
  // overEngineering：嵌套深度 vs 文件大小
  const oe = Math.min(1, (nesting / Math.sqrt(lines)) / 3)
  // paradigmFit：风格一致性（非代码文件不适用——返回中性 0.5 但标 applicable=false）
  const pfData = CODE_EXTS.has(ext) ? { value: Math.round(calcParadigmFit(codeOnly, ext) * 100) / 100, rawMatchRate: calcParadigmFit(codeOnly, ext), applicable: true } : PARADIGM_SKIPPED

  const dimensions = {
    techDebt: { value: Math.round((1 - techDebt) * 100) / 100, rawCyclomatic: cyc, rawCognitive: cog },
    archViolation: { value: Math.round((1 - archScore) * 100) / 100, rawViolations: archRaw },
    blastRadius: { value: Math.round((1 - br.score) * 100) / 100, rawDangerousAPIs: br.dangerousCount },
    overEngineering: { value: Math.round((1 - oe) * 100) / 100, rawNestingDepth: nesting },
    paradigmFit: pfData,
  }
  const overall = Math.round((
    dimensions.techDebt.value * 0.25 +
    dimensions.archViolation.value * 0.20 +
    dimensions.blastRadius.value * 0.20 +
    dimensions.overEngineering.value * 0.20 +
    dimensions.paradigmFit.value * 0.15
  ) * 100) / 100

  return {
    dimensions,
    overall,
    file,
    approximation: metrics.cyclomatic_complexity === null,
    // r12.1: 统一边界字段——overall 是形状维度加权，不含正确性/安全性结论
    coverage: 'shape-metrics (5 dims); correctness, security, architecture verdict NOT implied',
  }
}
