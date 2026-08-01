import { basename, extname, join, resolve } from 'node:path'
import { readFileSync, readdirSync, existsSync } from 'node:fs'

function guardPath(root, userPath) {
  // r23-fix3: LLM 可能传非字符串路径（数字/对象）→ resolve() 会抛 TypeError 崩溃
  if (typeof root !== 'string' || typeof userPath !== 'string' || userPath === '') return null
  const rootResolved = resolve(root)
  const resolved = resolve(rootResolved, userPath)
  return resolved === rootResolved || resolved.startsWith(rootResolved + '/') ? resolved : null
}

const SOURCE_EXTS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.go', '.rs', '.java'])
const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', 'dist', 'build', 'coverage'])
const DOTENV_RE = /^\.env(?:\.|$)/
// r23-fix: 安全扫描盲区——.env 无扩展名且以点开头被跳过，而恰恰是密钥最集中的文件

const PATTERNS = [
  { id: 'eval', severity: 'high', category: 'code-injection', re: /\beval\s*\(/g, msg: 'eval() 允许任意代码执行，存在注入风险' },
  { id: 'Function-ctor', severity: 'high', category: 'code-injection', re: /\bnew\s+Function\s*\(/g, msg: 'Function 构造函数存在代码注入风险' },
  { id: 'exec-cmd', severity: 'high', category: 'command-injection', re: /(?<![\w.])(exec|execSync|execFileSync)\s*\([^)]*\+/g, msg: 'exec 中拼接字符串可能导致命令注入' }, // r27: (?<![\w.]) 排除 RegExp.exec 成员调用（pathRe.exec(a+b) 误报），保留独立 exec( 注入形态
  { id: 'spawn-shell', severity: 'high', category: 'command-injection', re: /spawn\s*\([^,]+,\s*[^,]+,\s*{[^}]*shell:\s*true/g, msg: 'spawn 启用 shell=true 可能引入命令注入' },
  { id: 'sql-concat', severity: 'high', category: 'sql-injection', re: /(SELECT|INSERT|UPDATE|DELETE)\s+.+?['"]\s*\+\s*\w+/gi, msg: 'SQL 字符串拼接可能导致 SQL 注入' }, // r27: 去 s 标志——.+? 不跨行，杜绝散文 update/select 词跨行误配（\s 仍可跨行保住真拼接）
  { id: 'innerHTML', severity: 'medium', category: 'xss', re: /\.innerHTML\s*=/g, msg: 'innerHTML 可导致 XSS，建议用 textContent 或 safe DOM API' },
  { id: 'dangerouslySet', severity: 'medium', category: 'xss', re: /dangerouslySetInnerHTML/g, msg: 'dangerouslySetInnerHTML 可导致 XSS' },
  { id: 'fs-unlink-sync', severity: 'medium', category: 'file-access', re: /fs\.(unlinkSync|rmSync|rmdirSync)\s*\(/g, msg: '同步删除大文件会阻塞事件循环' },
  { id: 'process-exit', severity: 'medium', category: 'stability', re: /\bprocess\.exit\s*\(/g, msg: 'process.exit() 硬终止进程，应使用错误返回' },
  { id: 'crypto-md5', severity: 'low', category: 'crypto', re: /crypto\.createHash\s*\(\s*['"]md5['"]\s*\)/gi, msg: 'MD5 不适合安全哈希，推荐 SHA-256' },
  { id: 'jwt-hardcoded', severity: 'high', category: 'secrets', re: /jwt\.sign\s*\([^,]+,\s*['"][a-zA-Z0-9_\-]{8,}['"]/g, msg: 'JWT secret 硬编码在代码中，应使用环境变量' },
  { id: 'password-hardcode', severity: 'high', category: 'secrets', re: /password\s*[=:]\s*['"][^'"]{4,}['"]/gi, msg: '密码硬编码在代码中' },
  { id: 'api-key-hardcode', severity: 'high', category: 'secrets', re: /(api[_-]?key|apikey|secret|token)\s*[=:]\s*['"][a-zA-Z0-9_\-]{8,}['"]/gi, msg: 'API key/secret/token 硬编码在代码中' },
  { id: 'allow-all-cors', severity: 'medium', category: 'cors', re: /(Access-Control-Allow-Origin|origin)\s*[=:]\s*['"]\*['"]/gi, msg: 'CORS 设置为 * 允许所有域访问' },
  { id: 'no-rate-limit', severity: 'low', category: 'dos', re: /app\.(get|post|put|delete|patch)\s*\(['"][^'"]+['"]\s*,\s*(async\s*)?\(/g, msg: '路由缺少速率限制中间件' },
  { id: 'debug-log', severity: 'low', category: 'info-leak', re: /console\.(log|dir|table)\s*\([^)]*(password|secret|token|key)/gi, msg: '调试日志可能泄露敏感信息' },
  { id: 'insecure-compare', severity: 'medium', category: 'timing', re: /===?\s*['"].{4,}['"]\s*\|\|\s*['"].{4,}['"]\s*!==?\s*['"]/g, msg: '字符串比较可能被时序攻击' },
  { id: 'no-input-validation', severity: 'medium', category: 'input-validation', re: /\bbody\.[a-zA-Z]+\b(?:\s*\)|\.\s*map|\s*\.\s*forEach)/g, msg: '直接使用请求体未做输入验证' },
]

function isTestPath(rel) {
  // 测试/示例/夹具文件：secrets 类规则豁免（测试假密钥常见），注入类规则永不豁免
  if (!rel) return false
  const segs = rel.split(/[\\/]/)
  if (segs.some(s => ['tests', 'fixtures', 'examples', '__tests__', 'testdata', 'spec'].includes(s))) return true
  const base = segs[segs.length - 1] || ''
  return /^(test|spec)[-_]?/i.test(base) || /\.(test|spec)[.-]/i.test(base) || /_test\./.test(base)
}

// 在测试/示例文件中豁免的规则子集（注入类不在此列）
const SECRET_RULES_ON_TEST = new Set(['password-hardcode', 'api-key-hardcode', 'jwt-hardcoded', 'dotenv-secret', 'process-exit'])

function scanOne(source, filePath, maxFindings) {
  let s = String(source)
  const findings = []
  const skipped = s.length > 1000000 ? `file too large (${s.length} bytes), truncated scan` : undefined
  if (skipped) s = s.slice(0, 1000000)
  for (const p of PATTERNS) {
    p.re.lastIndex = 0
    let m
    while ((m = p.re.exec(s)) !== null) {
      if (p.id === 'sql-concat') {
        // 参数化语句（.prepare + 绑定参数）内的常量拼接不是注入，跳过；真危险形态是 db.exec('...' + userInput)
        // 在匹配区间 [起点, 拼接点] 内查 .prepare(：参数化 SQL 的拼接点必在 prepare 调用内，跨行贪婪也不会漏
        const inner = m[0]
        const jm = /['"]\s*\+\s*\w+/.exec(inner)
        const plusPos = jm ? m.index + jm.index : m.index
        const span = s.slice(m.index, plusPos)
        if (/\.prepare\s*\(/.test(span)) continue
      }
      if (SECRET_RULES_ON_TEST.has(p.id) && isTestPath(filePath)) continue
      const lineNum = s.slice(0, m.index).split('\n').length
      findings.push({
        id: p.id, severity: p.severity, category: p.category,
        message: p.msg, line: lineNum, match: m[0].slice(0, 80),
      })
      if (findings.length >= maxFindings) break
    }
    if (findings.length >= maxFindings) break
  }
  // .env 专用：KEY=value 无引号格式，通用规则匹配不到
  if (DOTENV_RE.test(basename(filePath || ''))) {
    const envRe = /^[A-Za-z_][A-Za-z0-9_]*=(?:['"]?)([^'"\s]{8,})(?:['"]?)\s*$/gm
    let m
    while ((m = envRe.exec(s)) !== null) {
      if (SECRET_RULES_ON_TEST.has('dotenv-secret') && isTestPath(filePath)) continue
      findings.push({ id: 'dotenv-secret', severity: 'high', category: 'secrets', message: '.env 中的密钥可能被提交进仓库，确认已在 .gitignore', line: s.slice(0, m.index).split('\n').length, match: m[0].slice(0, 40) })
    }
  }
  return {
    summary: {
      total: findings.length,
      high: findings.filter(f => f.severity === 'high').length,
      medium: findings.filter(f => f.severity === 'medium').length,
      low: findings.filter(f => f.severity === 'low').length,
      score: Math.max(0, 100 - findings.filter(f => f.severity === 'high').length * 30
        - findings.filter(f => f.severity === 'medium').length * 10
        - findings.filter(f => f.severity === 'low').length * 3),
      skipped,
    },
    findings,
    file_path: filePath,
    language: extname(filePath || '').slice(1) || 'unknown',
  }
}

function walkFiles(baseDir, dir, files, maxFiles) {
  if (files.length >= maxFiles) return
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    if (files.length >= maxFiles) break
    if (entry.name.startsWith('.') && !DOTENV_RE.test(entry.name)) continue
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      walkFiles(baseDir, fullPath, files, maxFiles)
    } else if (entry.isFile() && (SOURCE_EXTS.has(extname(entry.name)) || DOTENV_RE.test(entry.name))) {
      files.push(fullPath.startsWith(baseDir + '/') ? fullPath.slice(baseDir.length + 1) : fullPath)
    }
  }
}

export async function handle(args, context) {
  const workspaceDir = args?.workspace_dir
  if (!workspaceDir) {
    return { error: 'missing_parameter', message: 'workspace_dir is required' }
  }
  const maxFindings = Math.min(Math.max(parseInt(args?.max_findings) || 50, 1), 200)

  // 目录扫描模式
  if (args?.scope) {
    const scanDir = guardPath(workspaceDir, args.scope)
    if (!scanDir) {
      return { error: 'path_escape', message: `Path escapes workspace_dir: ${args.scope}` }
    }
    if (!existsSync(scanDir)) {
      return { error: 'dir_not_found', message: `Directory not found: ${args.scope}` }
    }
    const files = []
    walkFiles(workspaceDir, scanDir, files, 300)
    const results = []
    let totalFindings = 0
    // r23-fix2: findings 总量上限——40 文件×50 条会爆 LLM 上下文
    const FINDINGS_LIMIT = 200
    let findingsLimited = false
    for (const rel of files) {
      let content
      try { content = readFileSync(join(workspaceDir, rel), 'utf-8') } catch { continue }
      const r = scanOne(content, rel, maxFindings)
      if (r.summary.total > 0) {
        results.push(r)
        totalFindings += r.summary.total
        if (totalFindings >= FINDINGS_LIMIT) { findingsLimited = true; break }
      }
    }
    return {
      mode: 'directory',
      scope: args.scope,
      files_scanned: files.length,
      files_with_issues: results.length,
      total_findings: totalFindings,
      findings_truncated: findingsLimited,
      results: results.slice(0, 30),
      truncated: results.length > 30,
      next_step: totalFindings > 0 ? 'Fix high-severity findings first (injection/secrets).' : 'No security findings. Clean.',
    }
  }

  // 单文件模式
  let source = args?.source
  let file = args?.file
  // r23-fix4: source 优先时返回 file=undefined，避免 LLM 误以为扫描的是磁盘文件
  let readFromFile = false
  if (source === undefined && file) {
    const absPath = guardPath(workspaceDir, file)
    if (!absPath) {
      return { error: 'path_escape', message: `Path escapes workspace_dir: ${file}` }
    }
    if (!existsSync(absPath)) {
      return { error: 'file_not_found', message: `File not found: ${file}` }
    }
    source = readFileSync(absPath, 'utf-8')
    readFromFile = true
  }
  if (source === undefined) {
    return { error: 'missing_parameter', message: 'Provide file (relative to workspace_dir), source, or scope' }
  }

  const result = scanOne(source, file, maxFindings)
  return {
    mode: 'source',
    file: readFromFile ? file : undefined,
    source_provided: !readFromFile,
    summary: result.summary,
    findings: result.findings,
    language: result.language,
    next_step: result.summary.high > 0
      ? `Fix ${result.summary.high} high-severity findings (injection/secrets).`
      : result.summary.total > 0 ? 'Review medium/low findings above.' : 'No security findings. Clean.',
  }
}
