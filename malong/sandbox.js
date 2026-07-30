// 码龙 — 沙箱执行环境 (v1b)
// Docker → bwrap → 本地三级降级隔离
// 详见：通天计划 §六 码龙

import { execFile } from 'node:child_process'
import { mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'malong-sandbox'
export const version = '0.1.0'

const DOCKER_IMAGE = 'node:22-slim'
const DEFAULT_TIMEOUT = 30000

let _core, _mode = 'direct'

async function probeEnv() {
  // Check docker + image exists and can run
  try {
    const r = await exec('docker', ['run', '--rm', DOCKER_IMAGE, 'echo', 'probe'], process.cwd(), 15000)
    if (r.exitCode === 0) { _mode = 'docker'; return }
  } catch {}
  // Check bwrap can actually run
  try {
    const r = await exec('bwrap', ['--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib',
      '--ro-bind', '/bin', '/bin', '--proc', '/proc', '--dev', '/dev', '--die-with-parent',
      'sh', '-c', 'echo probe'], process.cwd(), 5000)
    if (r.exitCode === 0) { _mode = 'bwrap'; return }
  } catch {}
  _mode = 'direct'
}

function exec(cmd, args, cwd, timeout, env) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { cwd, timeout: timeout || DEFAULT_TIMEOUT, maxBuffer: 4 * 1024 * 1024, env: env ? { ...process.env, ...env } : undefined }, (err, stdout, stderr) => {
      resolve({
        exitCode: err?.code ?? (err ? 1 : 0),
        signal: err?.signal ?? null,
        stdout: (stdout || '').trim(),
        stderr: (stderr || '').trim(),
      })
    })
  })
}

function safePath(p) {
  try { return realpathSync(p) } catch { return p }
}

function register(core) {
  core.registerService('sandbox', {
    getMode() { return _mode },

    async exec(command, workDir = process.cwd(), { timeout = DEFAULT_TIMEOUT, env = {} } = {}) {
      const dir = safePath(workDir)
      const tmpDir = join(dir, '.tusunsun', 'sandbox-tmp')
      mkdirSync(tmpDir, { recursive: true })

      if (_mode === 'docker') {
        return this._dockerExec(command, dir, tmpDir, timeout, env)
      }
      if (_mode === 'bwrap') {
        return this._bwrapExec(command, dir, tmpDir, timeout, env)
      }
      return this._directExec(command, dir, timeout, env)
    },

    async _dockerExec(command, dir, tmpDir, timeout, env) {
      const envArgs = Object.entries(env).map(([k, v]) => ['-e', `${k}=${v}`]).flat()
      const result = await exec('docker', [
        'run', '--rm',
        '-v', `${dir}:/workspace:rw`,
        '-v', `${tmpDir}:/tmp:rw`,
        ...envArgs,
        DOCKER_IMAGE,
        'sh', '-c', `cd /workspace && ${command}`,
      ], process.cwd(), timeout)
      return result
    },

    async _bwrapExec(command, dir, tmpDir, timeout, env) {
      const envArgs = Object.entries(env).map(([k, v]) => ['--setenv', k, v]).flat()
      const result = await exec('bwrap', [
        '--ro-bind', '/usr', '/usr',
        '--ro-bind', '/lib', '/lib',
        '--ro-bind', '/lib64', '/lib64',
        '--ro-bind', '/bin', '/bin',
        '--ro-bind', '/etc', '/etc',
        '--tmpfs', '/home',
        '--tmpfs', '/tmp',
        '--proc', '/proc',
        '--dev', '/dev',
        '--die-with-parent',
        ...envArgs,
        '--bind', dir, dir,
        '--chdir', dir,
        'sh', '-c', command,
      ], dir, timeout)
      return result
    },

    async _directExec(command, dir, timeout, env) {
      return exec('sh', ['-c', command], dir, timeout, env)
    },

    async runLint(dir, { timeout = DEFAULT_TIMEOUT } = {}) {
      return this.exec(`npx eslint . --format json 2>/dev/null || true`, dir, { timeout })
    },

    async runTest(dir, { timeout = DEFAULT_TIMEOUT } = {}) {
      return this.exec('npm test 2>&1', dir, { timeout })
    },

    async runShell(command, dir, { timeout = DEFAULT_TIMEOUT } = {}) {
      return this.exec(command, dir, { timeout })
    },
  })
}

export async function init(core) {
  _core = core
  await probeEnv()
  core.log('info', `[sandbox] mode=${_mode}`)
  register(core)
}

export async function start() {
  _core.log('info', '[sandbox] ready')
}

export async function stop() {}
