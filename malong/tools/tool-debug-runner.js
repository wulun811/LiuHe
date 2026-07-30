import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, extname, resolve } from 'node:path'

export const name = 'tool-debug-runner'
export const version = '0.1.0'

let _core

function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const timeout = opts.timeout || 30000
    const child = spawn(cmd, args || [], {
      cwd: opts.cwd || process.cwd(),
      env: { ...process.env, ...(opts.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: opts.shell || false,
    })
    let stdout = '', stderr = '', timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, timeout)

    child.stdout.on('data', (d) => { stdout += d.toString() })
    child.stderr.on('data', (d) => { stderr += d.toString() })

    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ stdout, stderr, exitCode: code ?? -1, timeout: timedOut, cmd, args })
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ stdout, stderr, exitCode: -1, timeout: timedOut, error: err.message, cmd, args })
    })
  })
}

function parseStackTraces(output) {
  const traces = []
  const lines = output.split('\n')

  const jsRe = /^\s+at\s+(.+?)\s*\((.+?):(\d+):(\d+)\)$/
  const pyRe = /^\s*File\s+"(.+?)",\s+line\s+(\d+)(?:,\s+in\s+(.+))?$/
  const goRe = /^\s+(.+?)\((.+?):(\d+)\)/
  const rsRe = /^\s+at\s+(.+?):(\d+):(\d+)/

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    let m

    if (m = line.match(jsRe)) {
      traces.push({ lang: 'js', func: m[1], file: m[2], line: parseInt(m[3]), col: parseInt(m[4]), raw: line })
    } else if (m = line.match(pyRe)) {
      traces.push({ lang: 'py', file: m[1], line: parseInt(m[2]), func: m[3] || '', raw: line })
    } else if (m = line.match(goRe)) {
      traces.push({ lang: 'go', func: m[1], file: m[2], line: parseInt(m[3]), raw: line })
    } else if (m = line.match(rsRe)) {
      traces.push({ lang: 'rs', func: '', file: m[1], line: parseInt(m[2]), col: parseInt(m[3]), raw: line })
    }
  }
  return traces
}

function extractErrorType(stderr, stdout, exitCode) {
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

export { runCmd as runCommand, parseStackTraces, extractErrorType }

export async function init(core) {
  _core = core
  core.registerService('debugRunner', {
    async runCommand(cmd, args, opts) {
      return runCmd(cmd, args, opts)
    },

    async runScript(filePath, opts) {
      if (!existsSync(filePath)) return { error: `File not found: ${filePath}` }
      const ext = extname(filePath)
      let cmd, args
      if (ext === '.js' || ext === '.mjs') { cmd = process.execPath; args = [filePath] }
      else if (ext === '.py') { cmd = 'python3'; args = [filePath] }
      else if (ext === '.go') { cmd = 'go'; args = ['run', filePath] }
      else if (ext === '.rs') { cmd = 'rustc'; args = ['--edition', '2021', '-o', '/tmp/debug_runner_bin', filePath]; const r = await runCmd(cmd, args, opts); if (r.exitCode !== 0) return r; return runCmd('/tmp/debug_runner_bin', [], opts) }
      else if (ext === '.sh') { cmd = 'bash'; args = [filePath] }
      else return { error: `Unsupported extension: ${ext}` }
      return runCmd(cmd, args, opts)
    },

    async runTest(dir, testCmd) {
      const cmds = testCmd ? [testCmd] : (existsSync(join(dir, 'package.json')) ? ['npm', 'test'] : [])
      if (!cmds.length) return { error: 'No test command configured' }
      return runCmd(cmds[0], cmds.slice(1), { cwd: dir, timeout: 60000 })
    },

    async analyzeError(output, opts) {
      const stderr = output?.stderr || ''
      const stdout = output?.stdout || ''
      const exitCode = output?.exitCode ?? -1
      const errorType = extractErrorType(stderr, stdout, exitCode)
      const traces = parseStackTraces(stderr + '\n' + stdout)
      const errorLines = (stderr || '').split('\n').filter(l => l.trim()).slice(-20)
      const firstErrorLine = errorLines.find(l => /error|Error|FAIL|panic|Exception|Traceback/i.test(l)) || errorLines[0] || ''

      return {
        errorType,
        exitCode,
        firstError: firstErrorLine.slice(0, 200),
        stackTraces: traces.slice(0, 15),
        errorLinesCount: errorLines.length,
        suggestedAction: opts?.suggestAction !== false ? this._suggestAction(errorType, exitCode, traces) : null,
      }
    },

    _suggestAction(errorType, exitCode, traces) {
      const map = {
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
      }
      return map[errorType] || `检查错误输出，定位问题根因（退出码: ${exitCode}）`
    },

    async debug(filePath, opts) {
      const runResult = await this.runScript(filePath, opts)
      const analysis = await this.analyzeError(runResult, opts)
      return { ...runResult, ...analysis }
    },
  })

  core.registerCapability('debug-runner.run', {
    description: 'Run a command and analyze errors',
    handler: ({ cmd, args, opts }) => this.runCommand(cmd, args, { ...opts, suggestAction: false }),
    owner: 'malong',
  })
}
