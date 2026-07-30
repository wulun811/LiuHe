// 码龙 — 环境管理工具 (v2 P2.8)
// 检测可用编译器/运行时/环境信息
// 详见：通天计划 §六

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { version as nodeVersion } from 'node:process'

export const name = 'tool-env'
export const version = '0.2.0'

let _core

function checkBinary(name, versionFlag = '--version') {
  try {
    const out = execFileSync(name, [versionFlag], { encoding: 'utf-8', timeout: 5000 })
    const lines = out.trim().split('\n')
    return { available: true, version: lines[0].trim() }
  } catch {
    return { available: false }
  }
}

function checkDependency(pkgName) {
  try {
    const resolved = import.meta.resolve(pkgName)
    return { available: true, resolved }
  } catch {
    return { available: false }
  }
}

export async function init(core) {
  _core = core
  core.registerService('envTool', {
    async detect() {
      const runtimes = {
        node: { available: true, version: nodeVersion },
        python3: checkBinary('python3'),
        go: checkBinary('go'),
        rustc: checkBinary('rustc'),
        cargo: checkBinary('cargo'),
        git: checkBinary('git'),
        docker: checkBinary('docker'),
        make: checkBinary('make'),
        gcc: checkBinary('gcc', '--version'),
        clang: checkBinary('clang', '--version'),
      }

      const deps = {
        'better-sqlite3': checkDependency('better-sqlite3'),
      }

      return { runtimes, deps, platform: process.platform, arch: process.arch, cwd: process.cwd() }
    },

    async checkRequired() {
      const env = await this.detect()
      const required = ['node', 'git']
      const missing = required.filter(r => !env.runtimes[r]?.available)
      return { ok: missing.length === 0, missing }
    },

    async checkRuntime(lang) {
      const env = await this.detect()
      const runtimeMap = { javascript: 'node', python: 'python3', go: 'go', rust: 'rustc' }
      const bin = runtimeMap[lang]
      if (!bin) return { supported: false, reason: `unknown language: ${lang}` }
      const info = env.runtimes[bin]
      return { supported: info.available, version: info.version || null }
    },

    async getProjectConfig(rootDir) {
      const pkgPath = join(rootDir, 'package.json')
      const pyprojectPath = join(rootDir, 'pyproject.toml')
      const cargoPath = join(rootDir, 'Cargo.toml')
      const goModPath = join(rootDir, 'go.mod')
      const result = { languages: [], configFiles: {} }
      if (existsSync(pkgPath)) {
        result.languages.push('javascript')
        result.configFiles.packageJson = pkgPath
      }
      if (existsSync(pyprojectPath)) {
        result.languages.push('python')
        result.configFiles.pyprojectToml = pyprojectPath
      }
      if (existsSync(cargoPath)) {
        result.languages.push('rust')
        result.configFiles.cargoToml = cargoPath
      }
      if (existsSync(goModPath)) {
        result.languages.push('go')
        result.configFiles.goMod = goModPath
      }
      return result
    },
  })
  core.log('info', '[tool-env] registered')
}

export async function start() {}
export async function stop() {}
