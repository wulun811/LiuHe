import { join, extname, basename, resolve, sep } from 'node:path'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { parseOutput } from './parsers.js'

const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', 'dist', 'build', '.next'])
// 仅允许安全字符与空白分隔（[ \t] 不吞换行——换行可注入多行 shell 命令）
const SAFE_SCOPE_RE = /^[\w\/\.\-:\[\]]+(?:[ \t]+[\w\/\.\-:\[\]]+)*$/

function sanitizeScope(scope) {
  if (typeof scope !== 'string') return null
  if (!SAFE_SCOPE_RE.test(scope)) return null
  if (scope.split(/[ \t]/).some(seg => seg.split('/').includes('..'))) return null
  // 7（T3）：`-` 开头段是 CLI 选项注入面（-p 执行任意模块 / --watch 挂起 / -x 改语义），白名单内但必须拒
  if (scope.split(/[ \t]/).some(seg => seg.startsWith('-'))) return null
  return scope
}

function detectJsFramework(workspaceDir) {
  const pkgPath = join(workspaceDir, 'package.json')
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
      const deps = { ...pkg.dependencies, ...pkg.devDependencies }
      const testScript = pkg.scripts?.test || ''
      if (deps.jest || testScript.includes('jest')) return 'jest'
      if (deps.vitest || testScript.includes('vitest')) return 'vitest'
      if (deps.mocha || testScript.includes('mocha')) return 'mocha'
    } catch {}
  }
  return null
}

function detectFramework(workspaceDir, file) {
  // 10（F2）：有目标文件时按扩展名锁定语言族——旧实现纯按 workspace 根判定，根目录有 pyproject/.venv 时
  // 对 .js 文件也判 pytest → 建议 `python -m pytest x.js`（胡来）。文件扩展名优先于 workspace 探测
  if (file) {
    const ext = extname(file).toLowerCase()
    if (ext === '.py') return 'pytest'
    if (ext === '.go') return 'go_test'
    if (ext === '.rs') return 'cargo_test'
    if (['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx'].includes(ext)) return detectJsFramework(workspaceDir) || 'jest'
    if (ext === '.java' || ext === '.kt') return existsSync(join(workspaceDir, 'pom.xml')) ? 'maven' : 'gradle'
  }
  if (existsSync(join(workspaceDir, 'pytest.ini')) ||
      existsSync(join(workspaceDir, 'pyproject.toml')) ||
      existsSync(join(workspaceDir, 'setup.cfg')) ||
      existsSync(join(workspaceDir, 'tox.ini'))) return 'pytest'

  const jsFw = detectJsFramework(workspaceDir)
  if (jsFw) return jsFw

  if (existsSync(join(workspaceDir, 'go.mod'))) return 'go_test'
  if (existsSync(join(workspaceDir, 'Cargo.toml'))) return 'cargo_test'
  if (existsSync(join(workspaceDir, 'pom.xml'))) return 'maven'
  if (existsSync(join(workspaceDir, 'build.gradle')) || existsSync(join(workspaceDir, 'build.gradle.kts'))) return 'gradle'

  return 'unknown'
}

function findPython(workspaceDir) {
  for (const p of ['venv/bin/python', '.venv/bin/python', 'env/bin/python', 'venv/bin/python3', '.venv/bin/python3']) {
    const full = join(workspaceDir, p)
    if (existsSync(full)) return `"${full}"`
  }
  return 'python3'
}

function buildCommand(framework, scope, workspaceDir) {
  const python = findPython(workspaceDir)
  switch (framework) {
    case 'pytest': return `${python} -m pytest ${scope} -v --tb=short`
    case 'jest': return `npx jest ${scope} --json --no-coverage 2>&1`
    case 'vitest': return `npx vitest run ${scope} --reporter=json 2>&1`
    case 'go_test': return `go test ${scope === '.' ? './...' : scope} -v -count=1 2>&1`
    case 'cargo_test': return `cargo test ${scope === '.' ? '' : scope} 2>&1`
    case 'maven': return `mvn test ${scope !== '.' ? '-pl ' + scope : ''} -q 2>&1`
    case 'gradle': return `./gradlew test ${scope !== '.' ? '--tests "' + scope + '"' : ''} -q 2>&1`
    default: return null
  }
}

function suggestRootCause(failure) {
  const msg = failure.error || ''
  if (/AssertionError|assert/.test(msg)) return '断言失败：预期值与实际值不匹配，检查函数返回值是否变更'
  if (/ImportError|ModuleNotFoundError|Cannot find module/.test(msg)) return '导入失败：检查是否新增了依赖或重命名了模块'
  if (/TypeError|AttributeError|is not a function|has no attribute/.test(msg)) return '类型/属性错误：检查函数签名是否变更'
  if (/NameError|is not defined/.test(msg)) return '名称错误：检查是否重命名了变量或函数'
  if (/ConnectionError|timeout|ECONNREFUSED/.test(msg)) return '连接失败：检查外部服务是否可用（非代码问题）'
  if (/FileNotFoundError|ENOENT/.test(msg)) return '文件未找到：检查路径或 fixture 配置'
  if (/KeyError|IndexError|undefined is not/.test(msg)) return '键/索引错误：检查数据结构是否变更'
  return '请检查代码变更与测试预期的差异'
}

function enrichFailures(failures, workspaceDir) {
  for (const f of failures) {
    f.root_cause_hint = suggestRootCause(f)

    if (f.file && f.line) {
      try {
        // 7（T4）：f.file 来自测试输出解析，可被 `../../etc/passwd::x FAILED` 污染 → 任意文件内容泄露
        const abs = resolve(workspaceDir, f.file)
        if (!abs.startsWith(resolve(workspaceDir) + sep) && abs !== resolve(workspaceDir)) continue
        const absPath = abs
        if (existsSync(absPath)) {
          const content = readFileSync(absPath, 'utf-8')
          const lines = content.split('\n')
          const start = Math.max(0, f.line - 4)
          const end = Math.min(lines.length, f.line + 3)
          f.test_snippet = lines.slice(start, end).map((l, i) => `${start + i + 1}: ${l}`).join('\n')

          const mtime = statSync(absPath).mtimeMs
          const minutesAgo = Math.floor((Date.now() - mtime) / 60000)
          f.test_recently_modified = minutesAgo < 5
          f.test_modified_minutes_ago = minutesAgo
        }
      } catch {}
    }
  }
  return failures
}

function isTestFile(path) {
  return /(?:^|\/)(?:tests?|__tests__)\/|\.test\.|\.spec\.|_test\./.test(path)
}

const CONVENTIONS = {
  '.py': (base, dir) => [`tests/test_${base}.py`, `test/test_${base}.py`, `${dir}/test_${base}.py`, `test_${base}.py`],
  '.js': (base, dir) => [`${dir}/${base}.test.js`, `${dir}/__tests__/${base}.test.js`, `test/${base}.test.js`],
  '.ts': (base, dir) => [`${dir}/${base}.test.ts`, `${dir}/__tests__/${base}.test.ts`, `test/${base}.test.ts`],
  '.go': (base, dir) => [`${dir}/${base}_test.go`],
  '.rs': (base, dir) => [`tests/${base}_test.rs`],
  '.java': (base, dir) => [`test/${base}Test.java`],
}

function deriveTestPaths(file) {
  const ext = extname(file)
  const base = basename(file, ext)
  const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : ''
  const convention = CONVENTIONS[ext]
  return convention ? convention(base, dir) : []
}

function extractTestNames(filePath, workspaceDir) {
  const abs = join(workspaceDir, filePath)
  if (!existsSync(abs)) return []
  try {
    const content = readFileSync(abs, 'utf-8')
    const ext = extname(filePath)
    const tests = []
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      let m
      if (ext === '.py') m = /^\s*(?:async\s+)?def\s+(test_\w+)/.exec(lines[i])
      else if (['.js', '.mjs', '.ts', '.tsx'].includes(ext)) m = /(?:it|test)\s*\(\s*['"`](.+?)['"`]/.exec(lines[i])
      else if (ext === '.go') m = /^func\s+(Test\w+)/.exec(lines[i])
      if (m) tests.push({ name: m[1], line: i + 1 })
    }
    return tests
  } catch { return [] }
}

async function handleRun(args, context) {
  const workspaceDir = args.workspace_dir
  if (!existsSync(workspaceDir)) {
    return { error: 'workspace_not_found', message: `Workspace directory does not exist: ${workspaceDir}` }
  }
  const scope = args.scope || '.'
  const safeScope = sanitizeScope(scope)
  if (!safeScope) {
    return { error: 'invalid_input', message: `Unsafe scope: "${scope}". Only alphanumeric, /, ., -, :, spaces allowed.` }
  }
  const timeout = (args.timeout ?? 60) * 1000
  // 7（T1）：旧 `typeof args.timeout !== 'number'` 在未传时恒真 → 默认值 60 是死代码，默认路径 100% 报错
  if (args.timeout !== undefined && (typeof args.timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0)) {
    return { error: 'invalid_input', message: 'timeout must be a positive number (seconds)' }
  }
  const framework = args.framework || detectFramework(workspaceDir, args.scope)

  if (framework === 'unknown') {
    return {
      error: 'unknown_framework',
      message: 'Could not detect test framework',
      checked: ['pytest.ini', 'pyproject.toml', 'setup.cfg', 'package.json', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle'],
      suggestion: 'Specify framework explicitly: test_bridge(action="run", framework="pytest", ...)',
    }
  }

  const command = buildCommand(framework, safeScope, workspaceDir)
  if (!command) {
    return { error: 'unsupported_framework', message: `Framework "${framework}" is not supported for running` }
  }

  let rawOutput = ''
  let exitCode = 0
  let timedOut = false

  try {
    rawOutput = execSync(command, {
      cwd: workspaceDir,
      encoding: 'utf-8',
      timeout,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', TERM: 'dumb' },
    })
  } catch (e) {
    exitCode = e.status ?? e.code ?? 1
    rawOutput = (e.stdout || '') + '\n' + (e.stderr || '')
    if (e.killed || e.code === 'ETIMEDOUT') timedOut = true
  }

  const parsed = parseOutput(rawOutput, framework)
  const failures = enrichFailures(parsed.failures, workspaceDir)
  // 14：run 失败但一个结果都没解析出来时（如 npx 未装、命令不存在），parser 的 raw_hint 或输出尾部
  // 必须透出——否则 agent 只能看到 exit_code=1 + 全空结果，分不清「没装依赖」和「测试挂了」
  const runError = exitCode !== 0 && parsed.results.length === 0
    ? (parsed.raw_hint || rawOutput.slice(-500))
    : undefined

  let suggestedFix = null
  if (failures.length > 0) {
    const hints = failures.map(f => f.root_cause_hint).filter(Boolean)
    const unique = [...new Set(hints)]
    suggestedFix = unique.slice(0, 3).join('；')
  }

  let nextStep = null
  if (exitCode !== 0) {
    nextStep = 'Fix failures above, then re-run. Use inspect() to understand failing code.'
  } else {
    nextStep = 'All tests pass. Use edit_transaction to commit changes.'
  }

  return {
    action: 'run',
    framework,
    command,
    exit_code: exitCode,
    timed_out: timedOut || undefined,
    run_error: runError,
    results: parsed.results.slice(0, 50),
    truncated: parsed.results.length > 50 || undefined,
    failures,
    summary: {
      ...parsed.summary,
      duration_ms: parsed.results.reduce((s, r) => s + (r.duration_ms || 0), 0),
    },
    suggested_fix: suggestedFix,
    next_step: nextStep,
  }
}

async function handleSuggest(args, context) {
  const { codeIndexService, getWorkspaceDir } = context
  const workspaceDir = args.workspace_dir
  const file = args.file
  const symbol = args.symbol

  if (!file) {
    return { error: 'missing_parameter', message: 'file is required for action=suggest' }
  }

  // 检测 file 是否为目录
  const absFile = join(workspaceDir, file)
  if (existsSync(absFile)) {
    const stat = statSync(absFile)
    if (stat.isDirectory()) {
      return { error: 'invalid_input', message: `"${file}" is a directory, not a file. Please specify a source file path.` }
    }
  }

  const framework = args.framework || detectFramework(workspaceDir, args.file)
  const affectedTests = []
  const seen = new Set()

  if (codeIndexService && symbol) {
    const dbPath = join(getWorkspaceDir(workspaceDir), 'code-index.db')
    if (existsSync(dbPath)) {
      try {
        codeIndexService.initWorkspace(workspaceDir)
        const impact = await codeIndexService.getImpactAnalysis(file, { symbol, maxCallers: 50 })
        for (const c of impact.callers || []) {
          if (c.type === 'test') {
            const key = `${c.file}:${c.function}`
            if (!seen.has(key)) {
              seen.add(key)
              affectedTests.push({ file: c.file, name: c.function, line: c.line, priority: 'high', source: 'call_graph' })
            }
          }
        }
      } catch {}
    }
  }

  const candidates = deriveTestPaths(file)
  for (const tf of candidates) {
    if (!existsSync(join(workspaceDir, tf))) continue
    const testNames = extractTestNames(tf, workspaceDir)
    for (const t of testNames) {
      const key = `${tf}:${t.name}`
      if (!seen.has(key)) {
        seen.add(key)
        affectedTests.push({ file: tf, name: t.name, line: t.line, priority: 'medium', source: 'convention' })
      }
    }
  }

  if (codeIndexService) {
    try {
      const refs = await codeIndexService.getReferences(basename(file, extname(file)))
      for (const r of refs || []) {
        if (!isTestFile(r.path || '')) continue
        const testNames = extractTestNames(r.path, workspaceDir)
        for (const t of testNames) {
          const key = `${r.path}:${t.name}`
          if (!seen.has(key)) {
            seen.add(key)
            affectedTests.push({ file: r.path, name: t.name, line: t.line, priority: 'medium', source: 'import' })
          }
        }
      }
    } catch {}
  }

  const order = { high: 0, medium: 1, low: 2 }
  affectedTests.sort((a, b) => order[a.priority] - order[b.priority])

  const testFiles = [...new Set(affectedTests.map(t => t.file))]
  let suggestedCommand = null
  if (testFiles.length > 0 && framework !== 'unknown') {
    suggestedCommand = buildCommand(framework, testFiles.map(f => `"${f}"`).join(' '), workspaceDir)
  }

  let nextStep = null
  if (affectedTests.length > 0) {
    const firstFile = affectedTests[0].file
    nextStep = `Run: test_bridge(action="run", scope="${firstFile}")`
  }

  return {
    action: 'suggest',
    source_file: file,
    symbol: symbol || undefined,
    framework,
    affected_tests: affectedTests.slice(0, 30),
    total: affectedTests.length,
    suggested_command: suggestedCommand,
    next_step: nextStep,
  }
}

async function handleDiscover(args, context) {
  const workspaceDir = args.workspace_dir
  const file = args.file

  if (!file) {
    return { error: 'missing_parameter', message: 'file is required for action=discover' }
  }

  // 检测 file 是否为目录
  const absFile = join(workspaceDir, file)
  if (existsSync(absFile)) {
    const stat = statSync(absFile)
    if (stat.isDirectory()) {
      return { error: 'invalid_input', message: `"${file}" is a directory, not a file. Please specify a source file path.` }
    }
  }

  const framework = args.framework || detectFramework(workspaceDir, args.file)
  const tests = []
  const seen = new Set()

  const candidates = deriveTestPaths(file)
  for (const tf of candidates) {
    if (!existsSync(join(workspaceDir, tf))) continue
    const testNames = extractTestNames(tf, workspaceDir)
    for (const t of testNames) {
      const key = `${tf}:${t.name}`
      if (!seen.has(key)) {
        seen.add(key)
        tests.push({ file: tf, name: t.name, line: t.line })
      }
    }
  }

  const testFiles = [...new Set(tests.map(t => t.file))]
  let coverageHint
  if (testFiles.length === 0) coverageHint = 'no tests found — consider creating tests'
  else coverageHint = `${testFiles.length} test file(s) found with ${tests.length} test function(s)`

  let nextStep = null
  if (tests.length > 0) {
    nextStep = `Run: test_bridge(action="run", scope="${tests[0].file}")`
  }

  return {
    action: 'discover',
    source_file: file,
    framework,
    tests: tests.slice(0, 50),
    total: tests.length,
    coverage_hint: coverageHint,
    next_step: nextStep,
  }
}

export async function handle(args, context) {
  const workspaceDir = args?.workspace_dir
  if (!workspaceDir) {
    return { error: 'missing_parameter', message: 'workspace_dir is required' }
  }

  const action = args?.action
  switch (action) {
    case 'run': return handleRun(args, context)
    case 'suggest': return handleSuggest(args, context)
    case 'discover': return handleDiscover(args, context)
    default:
      return {
        error: 'invalid_action',
        message: `Unknown action: "${action}"`,
        valid_actions: ['run', 'suggest', 'discover'],
        usage: 'test_bridge(action="run", scope="tests/") | test_bridge(action="suggest", file="src/auth.py") | test_bridge(action="discover", file="src/auth.py")',
      }
  }
}
