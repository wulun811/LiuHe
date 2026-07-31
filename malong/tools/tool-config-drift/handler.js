import { join, extname } from 'node:path'
import { existsSync, readFileSync, readdirSync } from 'node:fs'

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

const SOURCE_EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.py', '.go', '.rs', '.java', '.rb'])
const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', 'dist', 'build'])

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

    for (const pat of ENV_PATTERNS) {
      pat.lastIndex = 0
      let m
      while ((m = pat.exec(line)) !== null) {
        refs.push({ type: 'env_var', name: m[1], line: i + 1, context: line.trim() })
      }
    }

    for (const pat of DB_PATTERNS) {
      pat.lastIndex = 0
      let m
      while ((m = pat.exec(line)) !== null) {
        const name = m[1]
        if (!/^(?:SELECT|INSERT|UPDATE|DELETE|FROM|INTO|TABLE|WHERE|SET|VALUES|AND|OR|JOIN|LEFT|RIGHT|INNER|OUTER|ON|AS|GROUP|ORDER|BY|HAVING|LIMIT|OFFSET|UNION|ALL|DISTINCT|CASE|WHEN|THEN|ELSE|END|NULL|NOT|IN|EXISTS|BETWEEN|LIKE|IS|CREATE|DROP|ALTER|INDEX|VIEW|TRIGGER|PROCEDURE|FUNCTION|DATABASE|SCHEMA|GRANT|REVOKE|COMMIT|ROLLBACK|BEGIN|TRANSACTION|PRIMARY|KEY|FOREIGN|REFERENCES|CONSTRAINT|DEFAULT|CHECK|UNIQUE|AUTO_INCREMENT|INT|INTEGER|VARCHAR|TEXT|BOOLEAN|DATE|TIMESTAMP|FLOAT|DOUBLE|DECIMAL|BLOB|CHAR|BIGINT|SMALLINT|TINYINT|SERIAL)$/i.test(name)) {
          refs.push({ type: 'db_table', name, line: i + 1, context: line.trim() })
        }
      }
    }

    for (const pat of SERVICE_PATTERNS) {
      if (pat.test(line)) {
        const svc = /redis/i.test(line) ? 'redis' : /mongo/i.test(line) ? 'mongodb' : 'unknown'
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
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    if (files.length >= maxFiles) break
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      walkSourceFiles(workspaceDir, fullPath, files, maxFiles)
    } else if (entry.isFile() && SOURCE_EXTS.has(extname(entry.name))) {
      files.push(fullPath.startsWith(workspaceDir + '/') ? fullPath.slice(workspaceDir.length + 1) : fullPath)
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

  if (file) {
    const absPath = join(workspaceDir, file)
    let content
    try { content = readFileSync(absPath, 'utf-8') } catch {
      return { error: 'file_not_found', message: `Cannot read file: ${file}` }
    }
    allRefs = extractRefs(content, file).map(r => ({ ...r, file }))
  } else {
    const files = []
    walkSourceFiles(workspaceDir, workspaceDir, files, 200)
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
