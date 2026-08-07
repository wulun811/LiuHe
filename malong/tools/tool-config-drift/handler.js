import { join, extname, sep, resolve } from 'node:path'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { stripStrings } from '../../string-utils.js'
import { guardReadPath } from '../../path-guard.js'

const ENV_PATTERNS = [
  /os\.environ\[["'](\w+)["']\]/g,
  /os\.getenv\(["'](\w+)["']/g,
  /process\.env\.(\w+)/g,
  /process\.env\[["'](\w+)["']\]/g,
]

const DB_PATTERNS = [
  /\bFROM\s+[`"]?(\w+)[`"]?/gi,
  /\bINTO\s+[`"]?(\w+)[`"]?/gi,
  /\bUPDATE\s+[`"]?(\w+)[`"]?/gi,
  /\bJOIN\s+[`"]?(\w+)[`"]?/gi,
]

const SERVICE_PATTERNS = [
  /redis[._](?:client|Redis|from_url|connect)/i,
  /mongo(?:ose|db|client)/i,
]

// SQL 执行调用（该行内的字符串是真实 SQL，表名应检出；否则视为自然语言）
const SQL_CALL_RE = /(?:\.\s*)?(?:execute|executemany|executescript|query|prepare|run)\s*\(/i

// r28-fix：移除 parser 不支持的 .rb，补 C/C++/Java/Bash
const SOURCE_EXTS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts', '.py', '.go', '.rs', '.java', '.c', '.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx', '.sh', '.bash'])
// R22-③：全扫模式跳过测试/夹具目录——其 env 引用是故意模拟（fixture）与断言输入（测试），
// 报为配置 drift 是噪音；file 模式（用户显式指定）不受影响。
const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', 'dist', 'build', 'tests', 'test', 'fixtures', '__tests__'])

// CI / 平台内置注入变量（不属于项目配置，不应报 drift）
const CI_BUILTIN_VARS = new Set([
  'CI', 'CONTINUOUS_INTEGRATION', 'HOME', 'PATH', 'LANG', 'SHELL', 'USER', 'TERM', 'TZ', 'PWD', 'TMPDIR',
  'NODE_ENV', 'DEBUG',
  'GITHUB_ACTIONS', 'GITHUB_TOKEN', 'GITHUB_ACTOR', 'GITHUB_SHA', 'GITHUB_REF', 'GITHUB_REPOSITORY',
  'GITHUB_RUN_ID', 'GITHUB_RUN_NUMBER', 'GITHUB_EVENT_NAME', 'GITHUB_WORKSPACE', 'GITHUB_HEAD_REF',
  'GITHUB_BASE_REF', 'GITHUB_JOB', 'GITHUB_STEP_SUMMARY', 'GITHUB_OUTPUT', 'GITHUB_ENV', 'GITHUB_PATH',
  'GITHUB_WORKFLOW', 'GITHUB_ACTION', 'GITHUB_ACTOR_ID', 'GITHUB_REPOSITORY_ID', 'GITHUB_RETENTION_DAYS',
  'RUNNER_OS', 'RUNNER_ARCH', 'RUNNER_TEMP', 'RUNNER_TOOL_CACHE', 'RUNNER_WORKSPACE', 'RUNNER_NAME', 'RUNNER_ENVIRONMENT',
  'TRAVIS', 'TRAVIS_BUILD_ID', 'CIRCLE_CI', 'GITLAB_CI', 'APPVEYOR', 'AZURE_PIPELINES', 'JENKINS_URL',
])

function extractRefs(content, file) {
  const refs = []
  const lines = content.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*(#|\/\/|\*)/.test(line)) continue
    // 字符串感知：剥离字面量后做模式匹配（防模板/字符串里的自然语言误报，如 "initialize from client"）
    const codeLine = stripStrings(line)

    for (const pat of ENV_PATTERNS) {
      pat.lastIndex = 0
      let m
      // ENV key 本身在字符串字面量里（os.environ['KEY']），不能剥离；注释行已在上方过滤
      while ((m = pat.exec(line)) !== null) {
        refs.push({ type: 'env_var', name: m[1], line: i + 1, context: line.trim() })
      }
    }

    for (const pat of DB_PATTERNS) {
      pat.lastIndex = 0
      let m
      // SQL 调用行（execute/query 等）字符串里是真实 SQL → 原行匹配；普通行 → 剥离字符串防自然语言误报
      const matchLine = SQL_CALL_RE.test(line) ? line : codeLine
      while ((m = pat.exec(matchLine)) !== null) {
        const name = m[1]
        if (!/^(?:SELECT|INSERT|UPDATE|DELETE|FROM|INTO|TABLE|WHERE|SET|VALUES|AND|OR|JOIN|LEFT|RIGHT|INNER|OUTER|ON|AS|GROUP|ORDER|BY|HAVING|LIMIT|OFFSET|UNION|ALL|DISTINCT|CASE|WHEN|THEN|ELSE|END|NULL|NOT|IN|EXISTS|BETWEEN|LIKE|IS|CREATE|DROP|ALTER|INDEX|VIEW|TRIGGER|PROCEDURE|FUNCTION|DATABASE|SCHEMA|GRANT|REVOKE|COMMIT|ROLLBACK|BEGIN|TRANSACTION|PRIMARY|KEY|FOREIGN|REFERENCES|CONSTRAINT|DEFAULT|CHECK|UNIQUE|AUTO_INCREMENT|INT|INTEGER|VARCHAR|TEXT|BOOLEAN|DATE|TIMESTAMP|FLOAT|DOUBLE|DECIMAL|BLOB|CHAR|BIGINT|SMALLINT|TINYINT|SERIAL)$/i.test(name)) {
          refs.push({ type: 'db_table', name, line: i + 1, context: line.trim() })
        }
      }
    }

    for (const pat of SERVICE_PATTERNS) {
      if (pat.test(codeLine)) {
        const svc = /redis/i.test(codeLine) ? 'redis' : /mongo/i.test(codeLine) ? 'mongodb' : 'unknown'
        refs.push({ type: 'service', name: svc, line: i + 1, context: line.trim() })
      }
    }
  }
  return refs
}

function parseEnvFiles(workspaceDir) {
  const vars = new Set()
  const files = []
  for (const name of ['.env', '.env.example', '.env.local', '.env.development', '.env.production']) {
    const path = join(workspaceDir, name)
    if (!existsSync(path)) continue
    files.push(name)
    try {
      for (const line of readFileSync(path, 'utf-8').split('\n')) {
        const trimmed = line.trim()
        if (trimmed.startsWith('#') || !trimmed) continue
        const m = /^(?:export\s+)?(\w+)\s*=/.exec(trimmed)
        if (m) vars.add(m[1])
      }
    } catch {}
  }
  return { vars, files }
}

function parseDockerCompose(workspaceDir) {
  const services = new Set()
  for (const name of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
    const path = join(workspaceDir, name)
    if (!existsSync(path)) continue
    try {
      const content = readFileSync(path, 'utf-8')
      const lines = content.split('\n')
      let inServices = false
      for (const line of lines) {
        if (/^services\s*:/.test(line)) { inServices = true; continue }
        if (inServices) {
          if (/^\S/.test(line) && !/^\s/.test(line)) { inServices = false; continue }
          const m = /^\s{2}(\w[\w-]*)\s*:/.exec(line)
          if (m) services.add(m[1])
        }
      }
    } catch {}
  }
  return services
}

function walkSourceFiles(workspaceDir, dir, files, maxFiles) {
  if (files.length >= maxFiles) return
  // R22-⑱（第五轮核实）：尾斜杠归一化——workspaceDir 带尾斜杠时 `ws + '/'` 拼成 `//` 恒不匹配，
  // 全扫模式全文件被 push 绝对路径 → join(ws, f) 对绝对路径无效 → ENOENT 静默跳过 → 假报 Config is in sync
  const wsNorm = workspaceDir.replace(/\\/g, '/')
  const wsPrefix = wsNorm.endsWith('/') ? wsNorm : wsNorm + '/'
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    if (files.length >= maxFiles) break
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
    const fullPath = join(dir, entry.name)
    // Windows：反斜杠绝对路径匹配不了 `/` 前缀 → 归一化后判断与切片
    const normPath = fullPath.replace(/\\/g, '/')
    if (entry.isDirectory()) {
      walkSourceFiles(workspaceDir, fullPath, files, maxFiles)
    } else if (entry.isFile() && SOURCE_EXTS.has(extname(entry.name))) {
      files.push(normPath.startsWith(wsPrefix) ? normPath.slice(wsPrefix.length) : normPath)
    }
  }
}

export async function handle(args, context) {
  const workspaceDir = args?.workspace_dir
  if (!workspaceDir) {
    return { error: 'missing_parameter', message: 'workspace_dir is required' }
  }

  const file = args?.file
  let allRefs = []
  let filesCapped = false

  if (file) {
    // r52: 逃逸拦截——file 可含 ../，直接 join 可读 workspace 外文件（同仓其他工具均有守卫）
    // r54(P0-4): resolve 归一化——workspaceDir 带尾斜杠时 `ws + sep` = `/ws//` 恒不匹配，合法文件被误判逃逸
    // R22-④（审核修复）：补 realpath 守卫——词法 resolve 拦不住工作区内 symlink 指向外部文件（全仓其他读路径均有）
    const wsNorm = resolve(workspaceDir)
    const absPath = resolve(wsNorm, file)
    if (!absPath.startsWith(wsNorm + sep)) {
      return { error: 'invalid_input', message: `File escapes workspace: ${file}` }
    }
    const guard = guardReadPath(workspaceDir, file)
    if (guard.blocked) {
      return { error: 'PATH_BLOCKED', message: guard.detail, file }
    }
    let content
    try { content = readFileSync(absPath, 'utf-8') } catch {
      return { error: 'file_not_found', message: `Cannot read file: ${file}` }
    }
    allRefs = extractRefs(content, file).map(r => ({ ...r, file }))
  } else {
    const files = []
    walkSourceFiles(workspaceDir, workspaceDir, files, 200)
    // R22-④：全扫 200 文件上限截断标注（readdir 顺序依赖，少扫必须告知）
    filesCapped = files.length >= 200
    for (const f of files) {
      try {
        const content = readFileSync(join(workspaceDir, f), 'utf-8')
        allRefs.push(...extractRefs(content, f).map(r => ({ ...r, file: f })))
      } catch {}
    }
  }

  const env = parseEnvFiles(workspaceDir)
  const services = parseDockerCompose(workspaceDir)

  const drifts = []
  for (const ref of allRefs) {
    if (ref.type === 'env_var' && !env.vars.has(ref.name) && !CI_BUILTIN_VARS.has(ref.name)) {
      drifts.push({
        type: 'missing_env_var',
        name: ref.name,
        code_location: `${ref.file}:${ref.line}`,
        expected_in: '.env.example',
        suggestion: `add ${ref.name}= to .env.example`,
      })
    }
    if (ref.type === 'service' && services.size > 0 && !services.has(ref.name)) {
      drifts.push({
        type: 'missing_service',
        name: ref.name,
        code_location: `${ref.file}:${ref.line}`,
        expected_in: 'docker-compose.yml',
        suggestion: `add ${ref.name} service to docker-compose.yml`,
      })
    }
  }

  const seen = new Set()
  const uniqueDrifts = drifts.filter(d => {
    const key = `${d.type}:${d.name}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  let nextStep = null
  if (uniqueDrifts.length > 0) {
    nextStep = `Add missing vars to .env.example via edit_transaction, then re-run to verify.`
  } else {
    nextStep = `Config is in sync.`
  }

  return {
    file: file || '(project-wide)',
    config_references: allRefs.slice(0, 50),
    // R22-④（审核修复）：全扫 200 文件上限 + 展示 50 条上限都标注——截断必标注（R17 精神）
    ...(file ? {} : { scan_files_capped: filesCapped }),
    ...(allRefs.length > 50 ? { config_references_truncated: allRefs.length - 50 } : {}),
    drifts: uniqueDrifts,
    config_manifest: {
      env_files: env.files,
      declared_vars: [...env.vars].sort(),
      services: [...services].sort(),
    },
    summary: {
      references_checked: allRefs.length,
      drifts_found: uniqueDrifts.length,
      clean: uniqueDrifts.length === 0,
    },
    next_step: nextStep,
  }
}
