// 码龙 — 验证流水线 (v1b)
// lint → test 自动管线，输出结构化结果
// 详见：通天计划 §六 码龙

// P4.3.1: 失败事件采集 — 每次失败发射标准化 failure 事件

import { execFile } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'malong-verify-pipeline'
export const version = '0.2.0'

const DEFAULT_TIMEOUT = 30000

let _core

function findPkgJson(dir) {
  let current = dir
  for (let i = 0; i < 10; i++) {
    const p = join(current, 'package.json')
    if (existsSync(p)) return p
    const next = join(current, '..')
    if (next === current) return null
    current = next
  }
  return null
}

function detectScripts(dir) {
  const pkgPath = findPkgJson(dir)
  if (!pkgPath) return { lint: false, test: false, typecheck: false }
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    const scripts = pkg.scripts || {}
    return {
      lint: !!(scripts.lint || scripts['lint:fix']),
      test: !!(scripts.test || scripts.ci),
      typecheck: !!(scripts.typecheck || scripts['tsc']),
    }
  } catch {
    return { lint: false, test: false, typecheck: false }
  }
}

function splitCommand(cmd) {
  const parts = []
  let current = '', inQuote = false, quoteChar = ''
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    if (inQuote) {
      if (ch === quoteChar) { inQuote = false; continue }
      current += ch
    } else if (ch === '"' || ch === "'") {
      inQuote = true
      quoteChar = ch
    } else if (ch === ' ') {
      if (current) { parts.push(current); current = '' }
    } else {
      current += ch
    }
  }
  if (current) parts.push(current)
  return parts
}

function detectPkgManager(dir) {
  const pkgPath = findPkgJson(dir)
  if (!pkgPath) return 'node'
  const base = join(pkgPath, '..')
  if (existsSync(join(base, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(base, 'yarn.lock'))) return 'yarn'
  return 'npm'
}

function exec(cmd, args, cwd, timeout) {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { cwd, timeout, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        exitCode: typeof err?.code === 'number' ? err.code : (err ? 1 : 0),
        signal: err?.signal ?? null,
        stdout: (stdout || '').trim(),
        stderr: (stderr || '').trim(),
        error: err && err.code === undefined ? err.message : null,
      })
    })
  })
}

function _filterStackTrace(stderr) {
  const lines = (stderr || '').split('\n')
  const filtered = lines.filter(l => !l.includes('node_modules') && !l.includes('internal/') && !l.includes('node:internal'))
  let len = 0
  for (let i = 0; i < filtered.length; i++) {
    len += filtered[i].length + 1
    if (len > 2000) return filtered.slice(0, i).join('\n')
  }
  return filtered.join('\n')
}

function _classifyError(exitCode, stderr, stdout) {
  const text = (stderr + '\n' + stdout).toLowerCase()
  if (text.includes('syntaxerror') || text.includes('unexpected token')) return 'parse_error'
  if (text.includes('typeerror')) return 'type_error'
  if (text.includes('referenceerror')) return 'ref_error'
  if (text.includes('timeout') || text.includes('etimedout')) return 'timeout'
  if (text.includes('assertion') || text.includes('assert')) return 'assertion_error'
  if (text.includes('missing') || text.includes('cannot find')) return 'dependency_error'
  if (exitCode !== 0) return 'runtime_error'
  return 'unknown'
}

function _emitFailure(type, result, detail = {}) {
  if (!_core?.emit) return
  const failure = {
    type,
    exitCode: result.exitCode,
    error: _filterStackTrace(result.stderr || result.stdout || ''),
    classification: _classifyError(result.exitCode, result.stderr, result.stdout),
    stdout: (result.stdout || '').slice(0, 500),
    file: detail.file || null,
    line: detail.line || null,
    timestamp: Date.now(),
  }
  _core.emit('verify.failure', failure)
  const guiyuan = _core?.getService('guiyuan')
  if (guiyuan?.recordFailure) {
    guiyuan.recordFailure(failure).catch(e => _core?.log('error', `[verify-pipeline] recordFailure: ${e.message}`))
  }
}

function parseLintOutput(stdout, stderr) {
  const combined = stdout + '\n' + stderr
  // Check if eslint is available
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
  let passed = 0, failed = 0, total = 0
  for (const line of lines) {
    const passMatch = line.match(/(\d+)\s+pass(?:ing|ed)/i)
    const failMatch = line.match(/(\d+)\s+fail(?:ing|ed)/i)
    const totalMatch = line.match(/tests?\s+(\d+)/i)
    if (passMatch) passed = parseInt(passMatch[1])
    if (failMatch) failed = parseInt(failMatch[1])
    if (totalMatch && !passMatch && !failMatch) total = parseInt(totalMatch[1])
  }
  if (passed === 0 && failed === 0) {
    // Try simpler heuristic
    const failLines = lines.filter(l => l.includes('FAIL') || l.includes('failed') || l.includes('✗'))
    const passLines = lines.filter(l => l.includes('PASS') || l.includes('passed') || l.includes('✓') || l.includes('ok'))
    if (passLines.length > 0 || failLines.length > 0) {
      passed = passLines.length
      failed = failLines.length
    }
  }
  return { passed, failed, total: passed + failed }
}

function register(core) {
  core.registerService('verifyPipeline', {
    async runLint(dir = process.cwd(), { timeout = DEFAULT_TIMEOUT } = {}) {
      const result = await exec('npx', ['eslint', '.'], dir, timeout)
      const lintErrors = result.exitCode !== 0 ? parseLintOutput(result.stdout, result.stderr) : []
      if (result.exitCode !== 0) _emitFailure('lint', result, { file: dir })
      return {
        status: result.exitCode === 0 ? 'pass' : 'fail',
        exitCode: result.exitCode,
        errors: lintErrors,
        errorCount: lintErrors ? lintErrors.length : 0,
        stdout: result.stdout.slice(0, 2000),
        stderr: result.stderr.slice(0, 2000),
      }
    },

    async runTest(dir = process.cwd(), { timeout = DEFAULT_TIMEOUT, testCommand = null } = {}) {
      const scripts = detectScripts(dir)
      const pm = testCommand ? null : detectPkgManager(dir)
      // P2：testCommand 是完整命令串（"npm run test -- --watch"），execFile 需要拆成可执行文件 + args；
      // 旧实现 cmd=testCommand 且 args=splitCommand(testCommand) → ENOENT 恒失败
      const cmd = testCommand ? splitCommand(testCommand)[0] : (testCommand ? null : (scripts.test ? (pm || 'npm') : 'node'))
      const args = testCommand ? splitCommand(testCommand).slice(1) : ['test']
      const result = await exec(cmd, args, dir, timeout)
      const testStats = parseTestOutput(result.stdout, result.stderr)
      if (result.exitCode !== 0) _emitFailure('test', result)
      return {
        status: result.exitCode === 0 ? 'pass' : 'fail',
        exitCode: result.exitCode,
        passed: testStats.passed,
        failed: testStats.failed,
        total: testStats.total || undefined,
        stdout: result.stdout.slice(0, 3000),
        stderr: result.stderr.slice(0, 2000),
      }
    },

    async runCommand(command, dir = process.cwd(), { timeout = DEFAULT_TIMEOUT } = {}) {
      const parts = splitCommand(command)
      const cmd = parts[0]
      const args = parts.slice(1)
      const result = await exec(cmd, args, dir, timeout)
      if (result.exitCode !== 0) _emitFailure('build', result)
      return {
        status: result.exitCode === 0 ? 'pass' : 'fail',
        exitCode: result.exitCode,
        stdout: (result.stdout || '').slice(0, 4000),
        stderr: (result.stderr || '').slice(0, 2000),
        error: result.error,
      }
    },

    async runAll(dir = process.cwd(), { timeout = DEFAULT_TIMEOUT } = {}) {
      const scripts = detectScripts(dir)
      const results = {}
      if (scripts.lint) results.lint = await this.runLint(dir, { timeout })
      if (scripts.test) results.test = await this.runTest(dir, { timeout })
      if (Object.keys(results).length === 0) {
        // P2：node --check 不带文件参数检查的是空 stdin → 空脚本合法 → 恒 pass（虚假结论）。
        // 改成对目录下实际 .js 文件逐个检查
        const jsFiles = []
        const walk = (d) => {
          for (const e of readdirSync(d, { withFileTypes: true })) {
            if (e.name.startsWith('.') || e.name === 'node_modules') continue
            const p = join(d, e.name)
            if (e.isDirectory()) walk(p)
            else if (e.name.endsWith('.js')) jsFiles.push(p)
          }
        }
        try { walk(dir) } catch {}
        if (jsFiles.length > 0) {
          let failCount = 0
          for (const f of jsFiles.slice(0, 50)) {
            const r = await this.runCommand(`node --check ${JSON.stringify(f)}`, dir, { timeout })
            if (r.exitCode !== 0) { failCount++; results.syntax = r; break }
          }
          if (!results.syntax) {
            results.syntax = { status: 'pass', exitCode: 0, checked_files: jsFiles.slice(0, 50).length }
          }
        } else {
          results.syntax = { status: 'skip', reason: 'no js files found' }
        }
      }
      return {
        status: Object.values(results).every(r => r.status === 'pass') ? 'pass' : 'fail',
        results,
        scripts,
      }
    },

    detectScripts(dir) {
      return detectScripts(dir)
    },

    async syntaxCheck(filePath, { timeout = 10000 } = {}) {
      const result = await exec('node', ['--check', filePath], process.cwd(), timeout)
      if (result.exitCode === 0) return { status: 'pass', errors: null }
      return { status: 'fail', errors: [{ message: result.stderr.split('\n')[0] || 'syntax error' }] }
    },
  })
}

export async function init(core) {
  _core = core
  register(core)
}

export async function start() {
  _core.log('info', '[verify-pipeline] ready')
}

export async function stop() {
  _core = null
}
