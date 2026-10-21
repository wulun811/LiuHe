import { join, extname, basename, resolve, sep, isAbsolute } from 'node:path'
import { existsSync, readFileSync, statSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawnWithGroup } from '../../spawn-guard.js'
import { getPythonCmd } from '../../python-cmd.js'
// 0.5.25：Python 项目/解释器解析（项目根 + venv）——工作区在项目之上时不再落回系统 python3
import { resolvePythonProject, pythonCommandString } from '../python-project.js'
import { parseOutput } from './parsers.js'
// r10d：discover 三层覆盖（约定 + 索引反查 + 文本兜底）——复用 find_tests 的 import 反查/文本扫描，
// 命名约定不符的测试文件（如 tests/test-dogfood-r12.js import health-check.js）不再漏找
import { handle as findTestsHandle } from '../tool-find-tests/handler.js'

// 测试文件形态判定（与 find_tests 的 TEST_PATH_RE 同口径）
function isTestFileLike(path) {
  return /(?:^|\/)(?:tests?|__tests__)\/|\.test\.|\.spec\.|_test\./.test(path)
}

// r42：execSync → execFile 异步化（D 组唯一阻塞债）——MCP 单进程 stdio 下跑测试不能卡事件循环
// command 为白名单模板拼装（buildCommand），含 shell 语法 `2>&1` 需剥离，参数用引号感知拆分
function splitCommand(cmd) {
  const parts = []
  let current = '', inQuote = false, quoteChar = ''
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    if (inQuote) {
      if (ch === quoteChar) { inQuote = false; continue }
      current += ch
    } else if (ch === '"' || ch === "'") {
      inQuote = true; quoteChar = ch
    } else if (ch === ' ') {
      if (current) { parts.push(current); current = '' }
    } else current += ch
  }
  if (current) parts.push(current)
  return parts
}

const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', 'dist', 'build', '.next'])
// 仅允许安全字符与空白分隔（[ \t] 不吞换行——换行可注入多行 shell 命令）
// r10e(F2)：中文路径（docs/六合工具集/...）此前被 \b\w\b 排除——SAFE_SCOPE_RE 拒绝中文目录，MCP 下 test_bridge run 无法跑中文路径测试。中文不是 CLI 注入向量（- 开头已另拒）
const SAFE_SCOPE_RE = /^[\w\u4e00-\u9fa5\/\\.\-:\[\]]+(?:[ \t]+[\w\u4e00-\u9fa5\/\\.\-:\[\]]+)*$/

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
      // dogfood-050 修复：package.json 的 `node --test` 旧实现不识别 → unknown_framework，
      // 用户需连吃两错（unknown→unsupported）才知道要用文件 scope / verify_pipeline
      if (/node\s+--test/.test(testScript)) return 'node'
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
    if (['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx'].includes(ext)) return detectJsFramework(workspaceDir) || 'node'
    if (ext === '.java' || ext === '.kt') return existsSync(join(workspaceDir, 'pom.xml')) ? 'maven' : 'gradle'
  }
  if (existsSync(join(workspaceDir, 'pytest.ini')) ||
      existsSync(join(workspaceDir, 'pyproject.toml')) ||
      existsSync(join(workspaceDir, 'setup.cfg')) ||
      existsSync(join(workspaceDir, 'tox.ini'))) return 'pytest'
  // 0.5.25：scope 是目录/通配（无扩展名）时，先看 scope 所在项目根的 pytest 标记——
  // 工作区在项目之上时（会话工作区=仓库根、Python 项目在子目录）旧实现只看工作区根 → unknown_framework。
  const proj = resolvePythonProject({ workspaceDir, scope: file })
  if (proj.pytest_project) return 'pytest'

  const jsFw = detectJsFramework(workspaceDir)
  if (jsFw) return jsFw

  if (existsSync(join(workspaceDir, 'go.mod'))) return 'go_test'
  if (existsSync(join(workspaceDir, 'Cargo.toml'))) return 'cargo_test'
  if (existsSync(join(workspaceDir, 'pom.xml'))) return 'maven'
  if (existsSync(join(workspaceDir, 'build.gradle')) || existsSync(join(workspaceDir, 'build.gradle.kts'))) return 'gradle'

  return 'unknown'
}

// 0.5.25：解释器解析改为「项目优先」——scope 所在项目根的 venv → 工作区根的 venv → 系统 python。
// 旧实现只看工作区根：会话工作区在项目之上时找不到 .venv → 落回系统 python3 → 依赖装在 venv 里时
// ModuleNotFoundError（实测：项目包 zmm/.venv 里的 ro 在系统 python3 下 import 不到）。
function findPython(workspaceDir, scope) {
  const r = resolvePythonProject({ workspaceDir, scope })
  return pythonCommandString(r)
}

function buildCommand(framework, scope, workspaceDir) {
  const python = findPython(workspaceDir, scope)
  switch (framework) {
    case 'pytest': return `${python} -m pytest ${scope} -v --tb=short`
    case 'jest': return `npx jest ${scope} --json --no-coverage 2>&1`
    case 'vitest': return `npx vitest run ${scope} --reporter=json 2>&1`
    case 'go_test': return `go test ${scope === '.' ? './...' : scope} -v -count=1 2>&1`
    case 'cargo_test': return `cargo test ${scope === '.' ? '' : scope} 2>&1`
    case 'maven': return `mvn test ${scope !== '.' ? '-pl ' + scope : ''} -q 2>&1`
    case 'gradle': return `./gradlew test ${scope !== '.' ? '--tests "' + scope + '"' : ''} -q 2>&1`
    // r48: 纯 node 脚本项目（无 jest/vitest/mocha，如 malong 自身）可显式 framework="node" 跑测试
    // r51/r54(P2): node 只能跑文件——'.' 或目录 scope（无 .js/.mjs/.cjs 扩展名）返回 null 触发 unsupported+hint
    // （此前目录 scope 生成 `node tests` 报误导性 MODULE_NOT_FOUND）
    case 'node': return /\.(mjs|cjs|js)$/.test(scope) ? `node ${scope} 2>&1` : null
    default: return null
  }
}

function suggestRootCause(failure, pyInfo) {
  const msg = failure.error || ''
  if (/AssertionError|assert/.test(msg)) return 'Assertion failed: actual value does not match expected — check if the function return value changed'
  if (/ImportError|ModuleNotFoundError|Cannot find module/.test(msg)) {
    const base = 'Import failed: check if a dependency was added or a module renamed'
    // 0.5.25：解释器兼底系统 python 时，ModuleNotFoundError 十有八九是「跑错解释器」而非「包被删了」
    if (pyInfo?.fallback_to_system) {
      return base + ' — the interpreter fell back to the system python (no project venv detected at ' + (pyInfo.project_root || pyInfo.searched?.[0] || 'the workspace root') + '): install the dependency in the project venv, or set MALONG_PYTHON to its interpreter'
    }
    return base
  }
  if (/TypeError|AttributeError|is not a function|has no attribute/.test(msg)) return 'Type/attribute error: check if the function signature changed'
  if (/NameError|is not defined/.test(msg)) return 'Name error: check if a variable or function was renamed'
  if (/ConnectionError|timeout|ECONNREFUSED/.test(msg)) return 'Connection failed: check if the external service is reachable (not a code issue)'
  if (/FileNotFoundError|ENOENT/.test(msg)) return 'File not found: check the path or fixture config'
  if (/KeyError|IndexError|undefined is not/.test(msg)) return 'Key/index error: check if the data structure changed'
  return 'Review the diff between the code change and the test expectation'
}

function enrichFailures(failures, workspaceDir, pyInfo) {
  for (const f of failures) {
    f.root_cause_hint = suggestRootCause(f, pyInfo)

    if (f.file) {
      try {
        // 7（T4）：f.file 来自测试输出解析，可被 `../../etc/passwd::x FAILED` 污染 → 任意文件内容泄露。
        // macOS：os.tmpdir() 是 /var/...，Node TAP 报 /private/var/...——先 realpath 两侧再比较。
        let raw = String(f.file)
        if (raw.startsWith('file://')) { try { raw = fileURLToPath(raw) } catch {} }
        const wsPlain = resolve(workspaceDir)
        let wsReal = wsPlain
        try { wsReal = realpathSync(wsPlain) } catch {}
        const absPlain = isAbsolute(raw) ? resolve(raw) : resolve(wsPlain, raw)
        let absReal = absPlain
        try { absReal = realpathSync(absPlain) } catch {}
        // 只认 realpath 后的归属：工作区内软链指向区外的文件仍然拒绝
        if (absReal !== wsReal && !absReal.startsWith(wsReal + sep)) continue
        if (existsSync(absReal)) {
          const content = readFileSync(absReal, 'utf-8')
          const lines = content.split('\n')
          const lineNo = Number.isFinite(f.line) && f.line > 0 ? f.line : 1
          const start = Math.max(0, lineNo - 4)
          const end = Math.min(lines.length, lineNo + 3)
          f.test_snippet = lines.slice(start, end).map((l, i) => `${start + i + 1}: ${l}`).join('\n')

          const mtime = statSync(absReal).mtimeMs
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
      // r54(P2): 行首锚定——旧 /(?:it|test)\s*\(/ 无锚定，commit('x')/submit('o') 含 it( 子串被提取为虚构测试（同步 find-tests P2-B6 锚定版）
      else if (['.js', '.mjs', '.ts', '.tsx'].includes(ext)) m = /^\s*(?:it|test)\s*\(\s*['"`](.+?)['"`]/.exec(lines[i])
      else if (ext === '.go') m = /^func\s+(Test\w+)/.exec(lines[i])
      if (m) tests.push({ name: m[1], line: i + 1 })
    }
    // r10e(F2)：裸 assert/expect 风格兜底（malong 全量测试都是裸 assert 无 test() 包裹）——
    // 无 it/test 提取时，若文件含断言调用则给文件级条目，discover 不再报 no tests found
    // r58: assert( 太窄——assert.strictEqual(/equal/ok 等方法调用不匹配 → 裸 assert 文件恒漏判；放宽为 assert 方法链
    if (tests.length === 0 && /^\s*(?:assert(?:\.\w+)?|expect)\(/m.test(content)) {
      tests.push({ name: basename(filePath, extname(filePath)), line: 1 })
    }
    return tests
  } catch { return [] }
}

async function handleRun(args, context) {
  const workspaceDir = args.workspace_dir
  if (!existsSync(workspaceDir)) {
    return { error: 'workspace_not_found', message: `Workspace directory does not exist: ${workspaceDir}` }
  }
  const scope = args.scope || args.file || '.'
  // R22-⑦（拷打发现）：run 模式旧实现只读 args.scope、静默忽略 args.file——用户传 file 期望限定测试文件却跑默认 scope，无任何提示；
  // file 接入 scope 后同时获得 sanitizeScope 的 `..` 穿越与 `-` 注入拦截（../ 恶意 file → invalid_input）
  const safeScope = sanitizeScope(scope)
  if (!safeScope) {
    return { error: 'invalid_input', message: `Unsafe scope: "${scope}". Only alphanumeric, /, ., -, :, spaces allowed.` }
  }
  const timeout = (args.timeout ?? 60) * 1000
  // 7（T1）：旧 `typeof args.timeout !== 'number'` 在未传时恒真 → 默认值 60 是死代码，默认路径 100% 报错
  if (args.timeout !== undefined && (typeof args.timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0)) {
    return { error: 'invalid_input', message: 'timeout must be a positive number (seconds)' }
  }
  // r11(H4)：上钳 110s（MCP 120s 硬超时）——超大 timeout 时客户端先断、工具僵尸占槽数分钟
  const effectiveTimeout = Math.min(timeout, 110_000)
  // 审查修复（二轮）：detectFramework 用生效 scope（args.scope 优先，缺省回退 file）——
  // 旧实现传 args.scope：只传 file 时扩展名锁定被跳过，.js 文件可能被判成 pytest（扩展名优先契约失效）
  const framework = args.framework || detectFramework(workspaceDir, scope)

  // 0.5.25：解释器解析结果（报告用）——「跑了哪个 python、从哪来的、是不是系统兼底」
  const pyInfo = resolvePythonProject({ workspaceDir, scope })

  if (framework === 'unknown') {
    return {
      error: 'unknown_framework',
      message: 'Could not detect test framework',
      checked: ['pytest.ini', 'pyproject.toml', 'setup.cfg', 'package.json', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle'],
      // 0.5.25：把「项目在哪儿」直接告诉调用方（工作区在项目之上时的常见坑）
      ...(pyInfo.project_candidates?.length ? { python_projects_in_workspace: pyInfo.project_candidates } : {}),
      suggestion: 'Specify framework explicitly: test_bridge(action="run", framework="pytest", ...), or use verify_pipeline() to run the project test script.'
        + (pyInfo.project_candidates?.length ? ' (Python projects found in the workspace: ' + pyInfo.project_candidates.join(', ') + ' — pass scope="<project>/" or set workspace_dir to that project root.)' : ''),
    }
  }

  const command = buildCommand(framework, safeScope, workspaceDir)
  if (!command) {
    // r48/r54(P2): node 分支只接受文件 scope（node 无法直接跑目录/'.'）——给出明确指引，避免误导性 unsupported
    const hint = framework === 'node'
      ? ' For framework=node provide a test file scope (e.g. scope="tests/app.test.js"), or use verify_pipeline() to run the project test script.'
      : ''
    return { error: 'unsupported_framework', message: `Framework "${framework}" is not supported for running.${hint}` }
  }

  let rawOutput = ''
  let exitCode = 0
  let timedOut = false

  // r42：execFile 异步执行（无 shell，剥离 2>&1 后合并 stdout+stderr 保持原语义）
  const [cmdBin, ...cmdArgs] = splitCommand(command)
  const childArgs = cmdArgs.filter(a => a !== '2>&1' && a !== '2>1')
  try {
    // R14：spawnWithGroup 进程组杀——npx/go test 的孙进程超时一并清
    const res = await spawnWithGroup(cmdBin, childArgs, {
      cwd: workspaceDir,
      timeout: effectiveTimeout,
      maxBuffer: 10 * 1024 * 1024,
      env: { FORCE_COLOR: '0', NO_COLOR: '1', TERM: 'dumb' },
    })
    rawOutput = res.stdout + (res.stderr ? '\n' + res.stderr : '')
    exitCode = res.code !== null && typeof res.code === 'number' ? res.code : 1
    if (res.killed) timedOut = true
  } catch (e) {
    // 审查修复（二轮）：spawn error 的 e.code 是字符串（'ENOENT'/'EACCES'）——旧实现 exit_code 变字符串类型错乱
    exitCode = typeof e.code === 'number' ? e.code : 1
    // 14：spawn 失败（命令不存在/EACCES）的错误本身也是原始信息，吞掉会让 run_error 为空
    rawOutput = e && e.message ? String(e.message) : ''
    if (e.code === 'ETIMEDOUT') timedOut = true
  }

  const parsed = parseOutput(rawOutput, framework)
  // dogfood-050 r3：TAP/node 等解析器逐用例不带 file——scope 非通配单文件时回填，通过用例不再 file:""
  if (safeScope && safeScope !== '.' && !/[*?[\]{}]/.test(safeScope)) {
    for (const r of parsed.results) if (!r.file) r.file = safeScope
  }
  const failures = enrichFailures(parsed.failures, workspaceDir, pyInfo)
  // 14：run 失败但一个结果都没解析出来时（如 npx 未装、命令不存在），parser 的 raw_hint 或输出尾部
  // 必须透出——否则 agent 只能看到 exit_code=1 + 全空结果，分不清「没装依赖」和「测试挂了」
  const runError = exitCode !== 0 && parsed.results.length === 0
    ? (parsed.raw_hint || rawOutput.slice(-500) || (timedOut
        ? `Test command timed out after ${effectiveTimeout}ms with no captured output: ${command}`
        : `Command exited with code ${exitCode} and produced no output: ${command}`))
    : undefined

  let suggestedFix = null
  if (failures.length > 0) {
    const hints = failures.map(f => f.root_cause_hint).filter(Boolean)
    const unique = [...new Set(hints)]
    suggestedFix = unique.slice(0, 3).join('；')
  }

  let nextStep = null
  // R22-⑰（第四轮审核 P1）：超时 ≠ 失败——next_step 误导 agent 去修代码，实际应加大 timeout/优化测试
  if (timedOut) {
    nextStep = 'Test timed out. Increase timeout or optimize the test (slow I/O / infinite loop). Use inspect() to review the test logic.'
  } else if (exitCode !== 0) {
    nextStep = 'Fix failures above, then re-run: test_bridge(action="run"). To diagnose: debug_runner(workspace_dir=..., test=...) or verify_pipeline for the full chain.'
  } else {
    // dogfood-050 P3：exit 0 但解析不到任何测试计数时，不得宣称 All tests pass（裸 assert/print 脚本无 totals）
    const parsedTotal = parsed?.summary?.total ?? 0
    nextStep = parsedTotal === 0
      ? 'Command exited 0 but no test totals were parsed (total=0) — the command may not run a recognized test framework (plain assert/print scripts produce no totals). Verify the command actually ran tests.'
      : 'All tests pass. Use edit_transaction to commit changes.'
  }

  return {
    action: 'run',
    framework,
    command,
    // 0.5.25：解释器透明化——「用哪个 python 跑的」直接写进结果（依赖装在 venv 时排错第一现场）
    ...(framework === 'pytest' ? {
      interpreter: {
        python: pyInfo.python,
        source: pyInfo.python_source,
        project_root: pyInfo.project_root,
        venv_found: pyInfo.venv_found,
        fallback_to_system: pyInfo.fallback_to_system,
        ...(pyInfo.python_has_pytest === false ? { has_pytest: false, warning: 'The resolved interpreter has no pytest installed — install it in that venv or point MALONG_PYTHON at an interpreter that has it.' } : {}),
      },
    } : {}),
    exit_code: exitCode,
    timed_out: timedOut || undefined,
    ...(exitCode === 0 && (parsed?.summary?.total ?? 0) === 0 ? { no_totals_parsed: true } : {}),
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
        await codeIndexService.initWorkspace(workspaceDir)
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

  // r10d：import 层（索引反查 + 文本兜底）——find_tests 内部对 by_import 为空时做有界文本扫描
  try {
    const ft = await findTestsHandle({ workspace_dir: workspaceDir, file }, context)
    // r10e(F2)：find_tests 内部守卫错误（FILE_NOT_FOUND / FILE_NOT_INDEXED / DIR_AS_FILE）要透传，
    // 否则 discover 对不存在文件静默返回 no tests found
    if (ft?.error) return ft
    for (const hit of ft?.by_import || []) {
      if (isTestFileLike(hit.path)) {
        const testNames = extractTestNames(hit.path, workspaceDir)
        for (const t of testNames) {
          const key = `${hit.path}:${t.name}`
          if (!seen.has(key)) {
            seen.add(key)
            tests.push({ file: hit.path, name: t.name, line: t.line })
          }
        }
      }
    }
  } catch (e) {
    // r11(M1)：find_tests 抛异常时不能静默——否则 discover 假阴性 "no tests found"（r10e 只透了 ft?.error，抛异常路径漏了）
    return { error: 'find_tests_failed', message: `find_tests raised: ${e.message}`, warning: 'discover degraded to convention-only scan' }
  }

  const searchMethods = ['convention']
  if (tests.some(t => !candidates.includes(t.file))) searchMethods.push('import_graph/text_fallback')

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
    search_methods: searchMethods,
    coverage_hint: coverageHint,
    next_step: nextStep,
  }
}

export async function handle(args, context) {
  const workspaceDir = args?.workspace_dir
  if (!workspaceDir) {
    return { error: 'missing_parameter', message: 'workspace_dir is required' }
  }
  // 第二轮审查：非字符串参数不得进入 path.join 裸抛（suggest/discover 走 file join）
  if (typeof workspaceDir !== 'string') {
    return { error: 'invalid_input', message: `workspace_dir must be a string (got ${typeof workspaceDir})` }
  }
  if (args?.file != null && typeof args.file !== 'string') {
    return { error: 'invalid_input', message: `file must be a string (got ${typeof args.file})` }
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
