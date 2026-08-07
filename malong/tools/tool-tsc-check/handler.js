// tsc_check — TypeScript 编译检查（B13 缺口六）
// 优先工作区 node_modules/.bin/tsc，其次 npx tsc；两者皆缺返回工具内错误对象。
// 工具内返回错误对象，不 throw。

import { spawnWithGroup } from '../../spawn-guard.js'
import { existsSync, readdirSync } from 'node:fs'
import { join, relative, isAbsolute } from 'node:path'

// r41: 执行类工具必须真实文件系统（getWorkspaceDir 沙箱映射只有索引 db，tsc 无项目可跑）
function isInsideWorkspace(ws, abs) {
  const rel = relative(ws, abs)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function traceId() {
  return `trc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function makeError(code, message, suggestion) {
  return { error: code, message, ...(suggestion ? { suggestion } : {}), trace_id: traceId() }
}

// R22-⑥（试用发现）：无 TS 项目 workspace 上 tsc_not_found 建议装 typescript 是噪音——先探测是否有 TS 源
function hasTypeScriptSources(dir) {
  if (existsSync(join(dir, 'tsconfig.json'))) return true
  const stack = [dir]
  let found = false
  let scanned = 0
  while (stack.length && !found && scanned < 2000) {
    const cur = stack.pop()
    let items
    try { items = readdirSync(cur, { withFileTypes: true }) } catch { continue }
    for (const it of items) {
      if (it.name === 'node_modules' || it.name === '.git') continue
      const p = join(cur, it.name)
      if (it.isDirectory()) stack.push(p)
      else if (/\.(ts|tsx|mts|cts)$/.test(it.name)) { found = true; break }
      scanned++
    }
  }
  return found
}

function findTscBin(dir) {
  const candidates = [
    join(dir, 'node_modules', '.bin', 'tsc'),
    join(dir, 'node_modules', 'typescript', 'bin', 'tsc'),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
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
  // r43: 非字符串 dir 会让 join() 抛 TypeError（r23-fix3 同教训）——先返回错误对象
  // r44: != null 让 null 与 undefined 一致视为「缺省」（用 root），只拒真·非字符串值
  if (args?.dir != null && typeof args.dir !== 'string') {
    return makeError('invalid_input', 'dir must be a string', 'Provide a subdirectory path relative to workspace_dir.')
  }
  const targetDir = args?.dir ? join(root, args.dir) : root
  if (!isInsideWorkspace(root, targetDir)) {
    return makeError('path_blocked', `dir escapes workspace: ${targetDir}`, 'Provide a subdirectory relative to workspace_dir.')
  }
  let timeout = parseInt(args?.timeout)
  if (!Number.isFinite(timeout) || timeout <= 0) timeout = 60000
  // r11(H4)：上钳 110s——超大 timeout 会让工具跑满才返回，MCP 120s 已先行超时 → 僵尸占槽（debug-runner/git-worktree 已钳，此处收敛）
  if (timeout > 110_000) timeout = 110_000

  const tscBin = findTscBin(targetDir)
  const t0 = Date.now()
  // R14：spawnWithGroup 进程组杀——npx tsc 的孙进程超时一并清
  const exec = async (cmd, argsList) => {
    const res = await spawnWithGroup(cmd, argsList, { cwd: targetDir, timeout, maxBuffer: 4 * 1024 * 1024 }).catch((e) => ({ code: undefined, stdout: '', stderr: '', killed: false, error: e }))
    return {
      exitCode: typeof res.code === 'number' ? res.code : (res.error || res.killed ? 1 : 0),
      stdout: res.stdout || '',
      stderr: res.stderr || '',
      missing: res.error?.code === 'ENOENT',
    }
  }

  const run = tscBin
    ? exec(tscBin, ['--noEmit'])
    : exec('npx', ['--no-install', 'tsc', '--noEmit'])

  const r = await run
  const duration_ms = Date.now() - t0
  if (r.missing) {
    return makeError('tsc_not_found', 'tsc not found in workspace or via npx', hasTypeScriptSources(targetDir)
      ? 'Install typescript in the project (npm i -D typescript) or globally.'
      : 'No TypeScript sources (tsconfig.json or .ts/.tsx/.mts/.cts) found — nothing to check here; skip this tool or install typescript if you plan to add TS.')
  }

  // r46: npx 包缺失时 exit 0 + 误导 banner（"This is not the tsc command you are looking for"）→
  // 此前被判 pass 假阳性。识别 banner 显式返回 tsc_not_found。
  const npxMissing = /This is not the tsc command you are looking for/i.test(r.stdout + r.stderr)
  if (!tscBin && npxMissing) {
    return makeError('tsc_not_found', 'tsc not found in workspace or via npx (npx missing-package banner detected)', hasTypeScriptSources(targetDir)
      ? 'Install typescript in the project (npm i -D typescript) or globally.'
      : 'No TypeScript sources (tsconfig.json or .ts/.tsx/.mts/.cts) found — nothing to check here; skip this tool or install typescript if you plan to add TS.')
  }

  // 解析 TS 错误输出：file(line,col): error TSxxxx: message
  const errors = []
  const lines = (r.stdout + '\n' + r.stderr).split('\n')
  for (const line of lines) {
    const m = line.match(/^([^(\n]+)\((\d+)(?:,(\d+))?\):\s+(error|warning)\s+(TS\d+):\s+(.+)/)
    if (m) errors.push({ file: m[1], line: parseInt(m[2]), col: m[3] ? parseInt(m[3]) : null, severity: m[4], code: m[5], message: m[6] })
  }

  return {
    status: r.exitCode === 0 ? 'pass' : 'fail',
    exitCode: r.exitCode,
    errorCount: errors.length,
    errors: errors.slice(0, 200),
    duration_ms,
    stdout: r.stdout.slice(0, 4000),
    stderr: r.stderr.slice(0, 2000),
    next_step: r.exitCode === 0 ? 'Type-check passed.' : `Fix ${errors.length} type error(s) in the listed files.`,
  }
}
