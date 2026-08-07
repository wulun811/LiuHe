import { spawnWithGroup } from '../../spawn-guard.js'
import { getPythonCmd } from '../../python-cmd.js'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join, extname, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

function guardPath(root, userPath) {
  // r23-fix3: LLM 可能传非字符串路径（数字/对象）→ resolve() 会抛 TypeError 崩溃
  if (typeof root !== 'string' || typeof userPath !== 'string' || userPath === '') return null
  const rootResolved = resolve(root)
  const resolved = resolve(rootResolved, userPath)
  // Windows 反斜杠：startsWith(root + '/') 恒 false → 用 sep
  return resolved === rootResolved || resolved.startsWith(rootResolved + sep) ? resolved : null
}

function runCmd(cmd, args, opts = {}) {
  const timeout = opts.timeout || 30000
  // R14：spawnWithGroup 进程组杀——超时杀孙进程，防孤儿
  return spawnWithGroup(cmd, args, {
    cwd: opts.cwd || process.cwd(),
    env: opts.env,
    timeout,
    maxBuffer: 4 * 1024 * 1024,
    shell: opts.shell,
  }).then(({ code, stdout, stderr, killed }) => ({
    stdout,
    stderr,
    exitCode: typeof code === 'number' ? code : -1,
    timeout: killed,
    error: killed ? `Command timed out after ${timeout}ms` : undefined,
  })).catch((e) => ({
    stdout: '', stderr: '', exitCode: -1, timeout: false,
    error: e?.code === 'ENOENT' ? `Command not found: ${cmd}` : (e.message || String(e)),
  }))
}

function parseStackTraces(output) {
  const traces = []
  const lines = output.split('\n')
  const jsRe = /^\s+at\s+(.+?)\s*\((.+?):(\d+):(\d+)\)$/
  const pyRe = /^\s*File\s+"(.+?)",\s+line\s+(\d+)(?:,\s+in\s+(.+))?$/
  const goRe = /^\s+(.+?)\((.+?):(\d+)\)/
  const rsRe = /^\s+at\s+(.+?):(\d+):(\d+)/

  for (const line of lines) {
    let m
    if ((m = line.match(jsRe))) {
      traces.push({ lang: 'js', func: m[1], file: m[2], line: parseInt(m[3]), col: parseInt(m[4]) })
    } else if ((m = line.match(pyRe))) {
      traces.push({ lang: 'py', file: m[1], line: parseInt(m[2]), func: m[3] || '' })
    } else if ((m = line.match(goRe))) {
      traces.push({ lang: 'go', func: m[1], file: m[2], line: parseInt(m[3]) })
    } else if ((m = line.match(rsRe))) {
      traces.push({ lang: 'rs', func: '', file: m[1], line: parseInt(m[2]), col: parseInt(m[3]) })
    }
  }
  return traces
}

function extractErrorType(stderr, stdout, exitCode) {
  // r41-fix: 干净退出（exit 0）= 成功，输出文本再像失败也不分类——/FAILED/i 无词边界会命中
  // "0 failed" 总结行，全绿测试因此被误判 TestFailure（exitCode 检查原只在 RuntimeError 分支）
  if (exitCode === 0) return null
  const combined = stderr + '\n' + stdout
  if (/SyntaxError/i.test(combined)) return 'SyntaxError'
  if (/TypeError/i.test(combined)) return 'TypeError'
  if (/ReferenceError/i.test(combined)) return 'ReferenceError'
  if (/AssertionError|assertion failed/i.test(combined)) return 'AssertionError'
  if (/TimeoutError/i.test(combined)) return 'TimeoutError'
  if (/EACCES|EPERM/i.test(combined)) return 'PermissionError'
  if (/ENOENT/i.test(combined)) return 'NotFoundError'
  if (/EADDRINUSE/i.test(combined)) return 'PortInUseError'
  if (/ECONNREFUSED/i.test(combined)) return 'ConnectionRefused'
  if (/Segmentation fault|SIGSEGV/i.test(combined)) return 'SegFault'
  if (/panic/i.test(combined)) return 'Panic'
  if (/npm ERR|packages failed/i.test(combined)) return 'NpmError'
  if (/Lint|ESLint/i.test(combined) && /error/i.test(combined)) return 'LintError'
  if (/Test failed|FAILED|tests failed/i.test(combined)) return 'TestFailure'
  return exitCode !== 0 ? 'RuntimeError' : null
}

const SUGGESTIONS = {
  SyntaxError: '检查代码中的语法错误，确保括号/引号匹配、关键字正确',
  TypeError: '检查变量类型，确认函数调用参数和返回值类型匹配',
  ReferenceError: '检查变量是否在作用域内声明，拼写是否正确',
  AssertionError: '检查测试断言逻辑，确认实际值是否符合预期',
  TimeoutError: '检查是否有死循环或异步操作未完成，增加超时或优化性能',
  PermissionError: '检查文件/网络权限，确保有足够访问权限',
  NotFoundError: '检查文件路径、模块名、API端点是否正确',
  PortInUseError: '检查端口是否被占用，更换端口或终止占用进程',
  ConnectionRefused: '检查服务是否已启动，地址和端口配置是否正确',
  LintError: '运行 linter 修复格式和代码规范问题',
  TestFailure: '检查测试输出，确认失败断言的详细信息',
  NpmError: '检查 package.json 和 node_modules，尝试 npm ci 重装依赖',
  Panic: '检查可能导致 panic 的 nil 指针、越界访问、类型断言',
  SegFault: '检查内存越界访问或大型递归调用',
}

export function analyzeError(output) {
  const stderr = output?.stderr || ''
  const stdout = output?.stdout || ''
  const exitCode = output?.exitCode ?? -1
  // r23-fix: execFile 超时 kill 无 'TimeoutError' 字样 → 用 timeout 标志直接映射
  const errorType = output?.timeout ? 'TimeoutError' : extractErrorType(stderr, stdout, exitCode)
  const traces = parseStackTraces(stderr + '\n' + stdout)
  const errorLines = stderr.split('\n').filter(l => l.trim()).slice(-20)
  const firstErrorLine = errorLines.find(l => /error|Error|FAIL|panic|Exception|Traceback/i.test(l)) || errorLines[0] || ''
  return {
    error_type: errorType,
    exit_code: exitCode,
    first_error: firstErrorLine.slice(0, 200),
    stack_traces: traces.slice(0, 15),
    error_lines: errorLines.length,
    suggested_action: SUGGESTIONS[errorType] || `检查错误输出，定位问题根因（退出码: ${exitCode}）`,
  }
}

// r23-fix2: 统一响应——截断标记 + cwd + 原始长度（LLM 需要知道输出是否被截断）
const OUT_LIMIT = 6000
function buildResponse(result, extra) {
  return {
    ...extra,
    exit_code: result.exitCode,
    timeout: result.timeout,
    cwd: extra.cwd,
    stdout: result.stdout.slice(0, OUT_LIMIT),
    stderr: result.stderr.slice(0, OUT_LIMIT),
    truncated: { stdout: result.stdout.length > OUT_LIMIT, stderr: result.stderr.length > OUT_LIMIT },
    stdout_full_length: result.stdout.length,
    stderr_full_length: result.stderr.length,
    ...analyzeError(result),
  }
}

export async function handle(args, context) {
  const workspaceDir = args?.workspace_dir
  if (!workspaceDir) {
    return { error: 'missing_parameter', message: 'workspace_dir is required' }
  }
  // r10e：cwd 可选参数（相对 workspace_dir）——脚本必须在子目录（如 0FTYcloud/）跑时不再绕路径
  let runCwd = workspaceDir
  if (args?.cwd != null) {
    if (typeof args.cwd !== 'string') {
      return { error: 'invalid_input', message: 'cwd must be a string', suggestion: 'Provide a subdirectory path relative to workspace_dir.' }
    }
    const resolvedCwd = guardPath(workspaceDir, args.cwd)
    if (!resolvedCwd || !existsSync(resolvedCwd)) {
      return { error: 'cwd_not_found', message: `cwd not found inside workspace_dir: ${args.cwd}` }
    }
    runCwd = resolvedCwd
  }
  // r23-fix2: 下限 1000ms——LLM 常把秒当参数传，timeout=1 会 1ms 秒超时
  const timeout = Math.min(Math.max(parseInt(args?.timeout) || 30000, 1000), 120000)

  // script 模式：按扩展名选运行时 + 自动分析
  if (args?.script) {
    const filePath = guardPath(workspaceDir, args.script)
    if (!filePath) {
      return { error: 'path_escape', message: `Path escapes workspace_dir: ${args.script}` }
    }
    if (!existsSync(filePath)) {
      return { error: 'file_not_found', message: `Script not found: ${args.script}` }
    }
    const ext = extname(args.script)
    let run
    // r23-fix: 全部补 cwd=workspace_dir（原版只对 command/test 传了 cwd，脚本内相对路径读不到）
    if (['.js', '.mjs', '.cjs'].includes(ext)) run = runCmd(process.execPath, [filePath], { cwd: runCwd, timeout })
    else if (ext === '.py') run = runCmd(getPythonCmd(), [filePath], { cwd: runCwd, timeout })
    else if (ext === '.go') run = runCmd('go', ['run', filePath], { cwd: runCwd, timeout })
    else if (ext === '.rs') {
      // r23-fix: 原固定 /tmp/debug_runner_${pid} 并发互相覆盖 → 唯一临时目录，运行后清理
      const binDir = mkdtempSync(join(tmpdir(), 'dr-rust-'))
      const bin = join(binDir, `run-${process.pid}-${randomUUID().slice(0, 8)}`) + (process.platform === 'win32' ? '.exe' : '')
      const compiled = await runCmd('rustc', ['--edition', '2021', '-o', bin, filePath], { cwd: runCwd, timeout })
      if (compiled.exitCode !== 0) {
        rmSync(binDir, { recursive: true, force: true })
        return { mode: 'script', script: args.script, ...compiled, ...analyzeError(compiled) }
      }
      const execResult = await runCmd(bin, [], { cwd: runCwd, timeout })
      rmSync(binDir, { recursive: true, force: true })
      run = Promise.resolve(execResult)
    } else if (ext === '.sh') run = runCmd('bash', [filePath], { cwd: runCwd, timeout })
    else {
      return { error: 'unsupported_extension', message: `Unsupported extension: ${ext} (support js/mjs/cjs/py/go/rs/sh)` }
    }
    const result = await run
    return buildResponse(result, { mode: 'script', script: args.script, cwd: runCwd, next_step: analyzeError(result).error_type ? analyzeError(result).suggested_action : 'Script ran successfully.' })
  }

  // command 模式：bash -c 执行，保留引号语义（split 会拆碎引号导致 SyntaxError）
  // Windows 无 bash：cmd.exe /d /s /c + shell:true 原样传串（数组 spawn 的 argv 引号转义会破坏引号组）
  if (args?.command) {
    const isWin = process.platform === 'win32'
    const result = await runCmd(isWin ? 'cmd.exe' : 'bash', isWin ? ['/d', '/s', '/c', args.command] : ['-c', args.command], { cwd: runCwd, timeout, shell: isWin })
    return buildResponse(result, { mode: 'command', command: args.command, cwd: runCwd, next_step: analyzeError(result).error_type ? analyzeError(result).suggested_action : 'Command ran successfully.' })
  }

  // test 模式
  if (args?.test) {
    const isWin = process.platform === 'win32'
    const result = await runCmd(isWin ? 'cmd.exe' : 'bash', isWin ? ['/d', '/s', '/c', args.test] : ['-c', args.test], { cwd: runCwd, timeout, shell: isWin })
    return buildResponse(result, { mode: 'test', command: args.test, cwd: runCwd, next_step: analyzeError(result).error_type ? analyzeError(result).suggested_action : 'Tests passed.' })
  }

  return { error: 'missing_parameter', message: 'Provide command, script, or test to run' }
}
