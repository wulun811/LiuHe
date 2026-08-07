// verify_pipeline — 项目验证管线（B13 缺口一）
// detectScripts（package.json 探测 lint/test/typecheck）→ 逐 stage execFile 执行 → 结构化结果。
// 移植自 0AIT/0通天/plugins/verify-pipeline.js（v0.2.0），去掉服务注册/事件发射，纯 handler。
// 工具内返回错误对象，不 throw。

import { spawnWithGroup } from '../../spawn-guard.js'
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { join, relative, isAbsolute, resolve, sep } from 'node:path'

// r41: 执行类工具必须真实文件系统——getWorkspaceDir 沙箱映射只适用于索引 db 查找
//（MCP 环境下映射目录只有 code-index.db，npm 命令/文件读取会全部落空）
function isInsideWorkspace(ws, abs) {
  const rel = relative(ws, abs)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

const DEFAULT_TIMEOUT = 120000
const MAX_OUTPUT = 4000

function traceId() {
  return `trc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function makeError(code, message, suggestion) {
  return { error: code, message, ...(suggestion ? { suggestion } : {}), trace_id: traceId() }
}

function findPkgJson(dir, stopDir) {
  let current = dir
  // 审核修复：stopDir 归一化（workspace_dir 带尾斜杠时 next === stopDir 恒 false → 可爬出 workspace 边界）
  const stopResolved = stopDir ? resolve(stopDir) : null
  for (let i = 0; i < 10; i++) {
    const p = join(current, 'package.json')
    if (existsSync(p)) return p
    const next = join(current, '..')
    if (next === current) return null
    // R15: 不越过 workspace 边界——向上到 stopDir 还没找到即停（防执行 workspace 外脚本）
    if (stopResolved && resolve(next) === stopResolved) {
      const rootPkg = join(stopDir, 'package.json')
      if (existsSync(rootPkg)) return rootPkg
      return null
    }
    current = next
  }
  return null
}

function detectScripts(dir, stopDir) {
  const pkgPath = findPkgJson(dir, stopDir)
  if (!pkgPath) return { lint: false, test: false, typecheck: false }
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    const scripts = pkg.scripts || {}
    // 返回真实脚本 key（string|false）：npm scripts 是 {名字: 内容}，值不可当脚本名跑
    // runStage 用探测到的 key 执行，避免检测认 lint:fix 却硬编码 run lint → Missing script 假失败
    const find = (keys) => {
      for (const k of keys) if (typeof scripts[k] === 'string') return k
      return false
    }
    return {
      lint: find(['lint', 'lint:fix']),
      test: find(['test', 'ci']),
      typecheck: find(['typecheck', 'tsc']),
    }
  } catch {
    return { lint: false, test: false, typecheck: false }
  }
}

function detectPkgManager(dir, stopDir) {
  const pkgPath = findPkgJson(dir, stopDir)
  if (!pkgPath) return 'npm'
  const base = join(pkgPath, '..')
  if (existsSync(join(base, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(base, 'yarn.lock'))) return 'yarn'
  return 'npm'
}

async function execStage(cmd, args, cwd, timeout) {
  // R14：spawnWithGroup 进程组杀——npm 的孙脚本（lint/test 子进程）超时一并清，防孤儿
  // r45: stdio stdin='ignore'（spawnWithGroup 默认）——从 stdin 读的命令不再挂起
  const res = await spawnWithGroup(cmd, args, { cwd, timeout, maxBuffer: 1024 * 1024 }).catch((e) => ({ code: undefined, stdout: '', stderr: '', killed: false, error: e }))
  return {
    exitCode: typeof res.code === 'number' ? res.code : (res.error || res.killed ? 1 : 0),
    killed: res.killed,
    timed_out: res.killed ? { timeout_ms: timeout } : null,
    stdout: (res.stdout || '').trim(),
    stderr: (res.stderr || '').trim(),
    error: res.error && res.error.code === undefined ? res.error.message : null,
  }
}

function parseLintOutput(stdout, stderr) {
  const combined = stdout + '\n' + stderr
  if (stderr.includes('command not found') || stderr.includes('not recognized') || stderr.includes('无法识别')) {
    return [{ file: '', line: 0, col: 0, severity: 'error', message: 'eslint not found — install with: npm install eslint' }]
  }
  const errors = []
  for (const line of combined.split('\n')) {
    const m = line.match(/^([^:]+):(\d+):(\d+):\s+(error|warning)\s+(.+)/)
    if (m) errors.push({ file: m[1], line: parseInt(m[2]), col: parseInt(m[3]), severity: m[4], message: m[5] })
  }
  return errors.length > 0 ? errors : null
}

function parseTestOutput(stdout, stderr) {
  const combined = stdout + '\n' + stderr
  const lines = combined.split('\n')
  let passed = 0, failed = 0
  for (const line of lines) {
    const passMatch = line.match(/(\d+)\s+pass(?:ing|ed)/i)
    const failMatch = line.match(/(\d+)\s+fail(?:ing|ed)/i)
    if (passMatch) passed = parseInt(passMatch[1])
    if (failMatch) failed = parseInt(failMatch[1])
  }
  if (passed === 0 && failed === 0) {
    const failLines = lines.filter(l => l.includes('FAIL') || l.includes('failed') || l.includes('✗'))
    const passLines = lines.filter(l => l.includes('PASS') || l.includes('passed') || l.includes('✓') || l.includes('ok'))
    if (passLines.length > 0 || failLines.length > 0) {
      passed = passLines.length
      failed = failLines.length
    }
  }
  return { passed, failed, total: passed + failed }
}

// r45: syntax 阶段用真实文件语法检查——旧实现 `node --check` 无文件参数从 stdin 读，挂起至超时
const SYNTAX_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.venv', 'venv', '__pycache__', '.next'])
function collectJsFiles(dir, limit, out = []) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    if (out.length >= limit) return out
    if (entry.name.startsWith('.') || SYNTAX_SKIP_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      collectJsFiles(full, limit, out)
    } else if (entry.isFile() && /\.(?:js|mjs|cjs)$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

async function runStage(stage, dir, timeout, stopDir) {
  const t0 = Date.now()
  const scripts = detectScripts(dir, stopDir)
  const pm = detectPkgManager(dir, stopDir)
  let cmd, args, result
  if (stage === 'lint') {
    // 优先跑项目 lint 脚本（契约：detectScripts 探测 → 对应脚本），无脚本用 eslint 兜底
    if (scripts.lint) { cmd = pm; args = ['run', scripts.lint] }
    // r54(P2): --no-install——无 eslint 项目首次 npx 会联网下载（对齐 tsc-check r46）
    else { cmd = 'npx'; args = ['--no-install', 'eslint', '.'] }
  } else if (stage === 'test') {
    if (scripts.test) { cmd = pm; args = ['run', scripts.test] }
    else {
      // r54(P2): 无 test 脚本时 `node --check`(无文件参数) 在 stdin ignore 下恒 exit 0 → 假 passed。
      // 返回 skipped 而非空过，避免「验证了但什么都没验证」
      return {
        ran: false,
        passed: null,
        skipped: true,
        duration_ms: Date.now() - t0,
        notice: 'No test script in package.json; nothing to run. Add a "test" script or pass stages explicitly.',
      }
    }
  } else if (stage === 'typecheck') {
    if (scripts.typecheck) { cmd = pm; args = ['run', scripts.typecheck] }
    else { cmd = 'tsc'; args = ['--noEmit'] }
  } else if (stage === 'syntax') {
    // r45: 逐个文件 node --check（带文件参数 + stdin ignore，不挂起）；上限 50 文件、失败累积 10 个即止
    const files = collectJsFiles(dir, 50)
    const failed = []
    for (const f of files) {
      const r = await execStage('node', ['--check', f], dir, timeout)
      if (r.exitCode !== 0) {
        failed.push({ file: f, error: String(r.stderr || r.error || '').slice(0, 200) })
        if (failed.length >= 10) break
      }
    }
    return {
      ran: true,
      passed: failed.length === 0,
      duration_ms: Date.now() - t0,
      exitCode: failed.length > 0 ? 1 : 0,
      checked: files.length,
      failed,
      ...(files.length === 0 ? { notice: 'No .js/.mjs/.cjs files found in workdir' } : {}),
    }
  }
  result = await execStage(cmd, args, dir, timeout)
  const duration_ms = Date.now() - t0
  const ok = result.exitCode === 0
  const base = {
    ran: true,
    passed: ok,
    duration_ms,
    exitCode: result.exitCode,
    stdout: result.stdout.slice(0, MAX_OUTPUT),
    stderr: result.stderr.slice(0, MAX_OUTPUT),
    // r10d：超时被杀显式透传（execStage 已标注，runStage 不能丢）
    ...(result.killed ? { killed: true, timed_out: result.timed_out } : {}),
    ...(result.error ? { error: result.error } : {}),
  }
  if (stage === 'lint') {
    const lintErrors = !ok ? parseLintOutput(result.stdout, result.stderr) : []
    return { ...base, errors: lintErrors, errorCount: lintErrors ? lintErrors.length : 0 }
  }
  if (stage === 'test') {
    const stats = parseTestOutput(result.stdout, result.stderr)
    return { ...base, passedCount: stats.passed, failedCount: stats.failed, total: stats.total }
  }
  return base
}

export async function handle(args, context) {
  const { getWorkspaceDir } = context
  const workspaceDir = args?.workspace_dir
  if (!workspaceDir) {
    return makeError('missing_parameter', 'workspace_dir is required', 'Provide the absolute path to the project root directory.')
  }
  const root = workspaceDir
  if (!existsSync(root)) {
    return makeError('workspace_not_found', `Workspace not found: ${root}`, 'Provide an existing absolute path.')
  }
  // r43: 非字符串 workdir 会让 join() 抛 TypeError（r23-fix3 同教训）——先返回错误对象
  // r44: != null 让 null 与 undefined 一致视为「缺省」（用 root），只拒真·非字符串值
  if (args?.workdir != null && typeof args.workdir !== 'string') {
    return makeError('invalid_input', 'workdir must be a string', 'Provide a subdirectory path relative to workspace_dir.')
  }
  const workdir = args?.workdir ? join(root, args.workdir) : root
  if (!isInsideWorkspace(root, workdir)) {
    return makeError('path_blocked', `workdir escapes workspace: ${workdir}`, 'Provide a subdirectory relative to workspace_dir.')
  }
  if (!existsSync(workdir)) {
    return makeError('workdir_not_found', `Workdir not found: ${workdir}`, 'Provide a subdirectory that exists relative to workspace_dir.')
  }
  // R22-⑯：isInsideWorkspace 是字符串级判断不 realpath 去引用——symlink 到外部目录时绕过，外部 package.json 脚本被真实执行
  try {
    const realWs = realpathSync(root)
    const realWd = realpathSync(workdir)
    if (realWd !== realWs && !realWd.startsWith(realWs + sep)) {
      return makeError('path_blocked', `workdir resolves outside workspace: ${workdir}`, 'Provide a subdirectory that does not escape workspace_dir via symlinks.')
    }
  } catch {
    return makeError('path_blocked', `cannot resolve workdir: ${workdir}`, 'Ensure the path is accessible.')
  }
  let timeout = parseInt(args?.timeout)
  if (!Number.isFinite(timeout) || timeout <= 0) timeout = DEFAULT_TIMEOUT
  // R15: timeout 上钳 110s（对齐 test-bridge/tsc-check）——链超 MCP 120s 会僵尸占槽
  if (timeout > 110_000) timeout = 110_000

  const detected = detectScripts(workdir, root)
  const stagesArg = args?.stages
  const wanted = stagesArg
    ? String(stagesArg).split(',').map(s => s.trim().toLowerCase()).filter(s => ['lint', 'test', 'typecheck'].includes(s))
    : ['lint', 'typecheck', 'test'].filter(s => detected[s])
  // r45: stages 显式传了但全部不可识别 → 报错而非静默兜底跑 syntax（此前 stages='lint:fix' 会被过滤成空 → 意外触发挂起路径）
  if (stagesArg && wanted.length === 0) {
    return makeError('invalid_input', `Unknown stage(s): ${String(stagesArg)}`, 'Valid stages: lint, test, typecheck (comma-separated).')
  }

  const results = {}
  for (const stage of wanted) {
    results[stage] = await runStage(stage, workdir, timeout, root)
  }
  if (Object.keys(results).length === 0) {
    results.syntax = await runStage('syntax', workdir, timeout, root)
  }
  const status = Object.values(results).every(r => r.passed) ? 'pass' : 'fail'
  // r10e(F3)：MCP 请求超时 120s 硬限制——多阶段全链（lint+test+typecheck × timeout）超预算时预警，
  // 否则工具超时后服务端仍继续跑、占满 semaphore 槽导致其他工具排队 60s 超时（实测 verify_pipeline 全链 3-4 分钟）
  const totalBudgetMs = wanted.length * timeout
  const mcp_note = totalBudgetMs > 100_000
    ? `MCP 请求超时 120s 硬限制：本次 ${wanted.length} 阶段 × ${Math.round(timeout / 1000)}s 预算 ${Math.round(totalBudgetMs / 1000)}s 必然超时。建议 stages=lint 单阶段，或用 test_bridge(action="run") 按文件 scope 分批。`
    : null
  return {
    status,
    results,
    ...(mcp_note ? { mcp_note } : {}),
    scripts: { lint: !!detected.lint, test: !!detected.test, typecheck: !!detected.typecheck },
    workdir,
    summary: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, { passed: v.passed, duration_ms: v.duration_ms }])),
  }
}
