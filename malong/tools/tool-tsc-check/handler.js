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

// 反馈修复（2026-08-16）：无根 tsconfig.json 的项目（拆 tsconfig.src/client/scanner.json）
// 跑 tsc --noEmit 会打印帮助文本并 exit 1 假 fail——自动发现 tsconfig.*.json 或接受显式 tsconfig 参数
const TSCONFIG_PRIORITY = ['tsconfig.src.json', 'tsconfig.client.json', 'tsconfig.scanner.json']

function pickTsconfig(dir) {
  if (existsSync(join(dir, 'tsconfig.json'))) return { project: null, source: 'root' }
  let names = []
  try {
    names = readdirSync(dir).filter((n) => /^tsconfig\..*\.json$/.test(n)).sort()
  } catch {}
  if (names.length === 0) return { project: null, source: 'none' }
  const nonBase = names.filter((n) => !n.includes('base'))
  if (nonBase.length === 0) return { project: names[0], source: 'base-only' }
  if (nonBase.length === 1) return { project: nonBase[0], source: 'single' }
  for (const p of TSCONFIG_PRIORITY) if (nonBase.includes(p)) return { project: p, source: 'priority' }
  return { project: nonBase[0], source: 'multi' }
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
  // Windows 上 npm 装的 typescript 其 .bin/tsc 是无扩展名 sh shim，无法直接 spawn
  // （CreateProcess ENOENT → 误报 tsc_not_found），优先 .cmd 真实入口
  const isWin = process.platform === 'win32'
  const candidates = [
    join(dir, 'node_modules', '.bin', isWin ? 'tsc.cmd' : 'tsc'),
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
  // 显式 tsconfig 参数（相对 workspace_dir）——覆盖自动发现
  if (args?.tsconfig != null && typeof args.tsconfig !== 'string') {
    return makeError('invalid_input', 'tsconfig must be a string', 'Provide a tsconfig path relative to workspace_dir (e.g. tsconfig.src.json).')
  }
  const explicitTsconfig = args?.tsconfig ? join(root, args.tsconfig) : null
  if (explicitTsconfig && !isInsideWorkspace(root, explicitTsconfig)) {
    return makeError('path_blocked', `tsconfig escapes workspace: ${explicitTsconfig}`, 'Provide a tsconfig path relative to workspace_dir.')
  }
  if (explicitTsconfig && !existsSync(explicitTsconfig)) {
    return makeError('no_tsconfig', `tsconfig not found: ${args.tsconfig}`, 'Provide an existing tsconfig path relative to workspace_dir, or omit it to auto-discover.')
  }
  let timeout = parseInt(args?.timeout)
  if (!Number.isFinite(timeout) || timeout <= 0) timeout = 60000
  // r11(H4)：上钳 110s——超大 timeout 会让工具跑满才返回，MCP 120s 已先行超时 → 僵尸占槽（debug-runner/git-worktree 已钳，此处收敛）
  if (timeout > 110_000) timeout = 110_000

  // 决定编译目标：根 tsconfig.json → 现状；无根时自动发现 tsconfig.*.json（--project）；
  // 一个都没有 → no_tsconfig 明确错误（而非 tsc 打印帮助文本 exit 1 的假 fail）
  const cfg = explicitTsconfig ? { project: args.tsconfig, source: 'explicit' } : pickTsconfig(targetDir)
  if (cfg.source === 'none') {
    const hasTS = hasTypeScriptSources(targetDir)
    return makeError('no_tsconfig',
      hasTS
        ? `No tsconfig.json found in ${targetDir} (TS sources present but no compiler config)`
        : `No tsconfig.json found in ${targetDir}`,
      hasTS
        ? 'tsc needs a tsconfig to know what to compile. Create a tsconfig.json, or pass tsconfig="<path>" to use one of your tsconfig.*.json files (e.g. tsconfig.src.json).'
        : 'No TypeScript sources (tsconfig.json or .ts/.tsx/.mts/.cts) found — nothing to check here; skip this tool or add TS + a tsconfig.')
  }
  const tscArgs = cfg.project ? ['--project', cfg.project, '--noEmit'] : ['--noEmit']

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
    ? exec(tscBin, tscArgs)
    : exec('npx', ['--no-install', 'tsc', ...tscArgs])

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

  // help 文本/空配置兜底：exit≠0 + 0 错误 + 帮助 banner 或 TS18003（No inputs）→ no_tsconfig
  // 而非假 fail（无根 tsconfig 时 tsc 打印帮助文本 exit 1，errorCount=0 曾误导）
  const errors = []
  const combined = r.stdout + r.stderr
  const helpBanner = /Usage:|--all\b|tsc \[options\]/i.test(combined)
  if (r.exitCode !== 0 && errors.length === 0 && (helpBanner || /TS18003/.test(combined))) {
    return makeError('no_tsconfig',
      `tsc could not resolve a usable compiler config in ${targetDir} (exit ${r.exitCode})`,
      cfg.project
        ? `Project config ${cfg.project} did not produce a check (empty inputs or bad path). Pass tsconfig="<path>" to target a specific config.`
        : 'No root tsconfig.json matched. Pass tsconfig="<path>" to use a tsconfig.*.json file (e.g. tsconfig.src.json).')
  }

  // 解析 TS 错误输出：file(line,col): error TSxxxx: message
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
