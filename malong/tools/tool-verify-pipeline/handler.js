// verify_pipeline — 项目验证管线（B13 缺口一）
// detectScripts（package.json 探测 lint/test/typecheck）→ 逐 stage execFile 执行 → 结构化结果。
// 移植自 0AIT/0通天/plugins/verify-pipeline.js（v0.2.0），去掉服务注册/事件发射，纯 handler。
// 工具内返回错误对象，不 throw。

import { spawnWithGroup } from '../../spawn-guard.js'
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { join, relative, isAbsolute, resolve, sep } from 'node:path'
// 0.5.25：Python 项目探测（pytest）——Python 仓没有 npm test 脚本也能跑验证
import { resolvePythonProject } from '../python-project.js'

// r41: 执行类工具必须真实文件系统——getWorkspaceDir 沙箱映射只适用于索引 db 查找
//（MCP 环境下映射目录只有 code-index.db，npm 命令/文件读取会全部落空）
function isInsideWorkspace(ws, abs) {
  const rel = relative(ws, abs)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

// r58: 默认 120s → 30s——旧默认单 stage 就撞 MCP 120s 硬超时（全链必超时）；30s/阶段 × 3 = 90s 留余量，可显式传 timeout 加大
const DEFAULT_TIMEOUT = 30000
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
    // live 审查 I1：current 已在 workspace 根且无 package.json → 终止。旧实现只拦「下一跳==stopDir」，
    // workdir===workspace 根时会继续向上爬到祖先目录并执行 workspace 外脚本
    if (stopResolved && resolve(current) === stopResolved) return null
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

// N04：读 package.json 的 scripts 原文（脚本分支做「工具可用性」结构化判定用）
function readPkgScripts(dir, stopDir) {
  const pkgPath = findPkgJson(dir, stopDir)
  if (!pkgPath) return null
  try { return JSON.parse(readFileSync(pkgPath, 'utf-8')).scripts || {} } catch { return null }
}

function detectPkgManager(dir, stopDir) {
  const pkgPath = findPkgJson(dir, stopDir)
  if (!pkgPath) return 'npm'
  const base = join(pkgPath, '..')
  if (existsSync(join(base, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(base, 'yarn.lock'))) return 'yarn'
  return 'npm'
}

async function execStage(cmd, args, cwd, timeout, signal = null) {
  // R14：spawnWithGroup 进程组杀——npm 的孙脚本（lint/test 子进程）超时一并清，防孤儿
  // r45: stdio stdin='ignore'（spawnWithGroup 默认）——从 stdin 读的命令不再挂起
  // S3.2：signal 透传——job 取消时杀进程组（T13）
  const res = await spawnWithGroup(cmd, args, { cwd, timeout, maxBuffer: 1024 * 1024, signal }).catch((e) => ({ code: undefined, stdout: '', stderr: '', killed: false, error: e }))
  return {
    exitCode: res.code !== null && typeof res.code === 'number' ? res.code : 1,
    killed: res.killed,
    timed_out: res.killed ? { timeout_ms: timeout } : null,
    stdout: (res.stdout || '').trim(),
    stderr: (res.stderr || '').trim(),
    // live 审查 I2：ENOENT/EACCES 等带 code 的 spawn 错误此前被丢弃 → 缺工具被误分类 failed 且无诊断；
    // classifyStage 见 stage.error → unavailable
    error: res.error ? (res.error.message || String(res.error)) : null,
    ...(res.error && res.error.code ? { error_code: res.error.code } : {}),
    // R07（0.5.10 审核修复）：cmd.exe 包装下缺命令无 ENOENT 语义——exit 9009 归成结构化 error_code（Windows 假 failed 同源）
    ...(!res.error && res.code === 9009 ? { error: 'command not found (cmd.exe exit 9009)', error_code: 'ENOENT' } : {}),
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

// WP08R-4（c1b 实拍）：无项目 lint 脚本 + eslint 兜底不可用 = 环境缺工具，不是代码缺陷。
// 导出纯函数供失败路径测试（真跑输出样本：npx canceled due to missing packages）。
export function lintUnavailableReason(hasScript, ok, stderr, stdout) {
  if (hasScript || ok) return null
  const s = String(stderr || '') + '\n' + String(stdout || '')
  if (/npx canceled due to missing packages/i.test(s)) return 'eslint package not resolvable by npx --no-install; no project lint script'
  if (/command not found|not recognized|无法识别/.test(s) && /eslint/i.test(s)) return 'eslint binary not found; no project lint script'
  return null
}

function parseTestOutput(stdout, stderr) {
  const combined = stdout + '\n' + stderr
  const lines = combined.split('\n')
  let passed = 0, failed = 0
  for (const line of lines) {
    // pytest/jest/vitest: "N passed" / "N failed"（数字在前）
    const passMatch = line.match(/(\d+)\s+pass(?:ing|ed)/i)
    const failMatch = line.match(/(\d+)\s+fail(?:ing|ed)/i)
    if (passMatch) passed = parseInt(passMatch[1])
    if (failMatch) failed = parseInt(failMatch[1])
    // node --test TAP: "# pass N" / "# fail N"（数字在后）。dogfood-050 修复：
    // 旧实现主正则不匹配 TAP，兜底按含 "ok" 子串的行数统计（"not ok"/"token"/"async_hooks" 全算通过 → 9/0/9 假计数）
    const tapPass = line.match(/^#\s*pass\s+(\d+)\b/i)
    const tapFail = line.match(/^#\s*fail\s+(\d+)\b/i)
    if (tapPass) passed = parseInt(tapPass[1])
    if (tapFail) failed = parseInt(tapFail[1])
  }
  if (passed === 0 && failed === 0) {
    // 0.5.25：pytest 进度字符兜底——项目的 pytest 配置常自带 addopts="-q"，叠加我们命令行上的 -q
    // 变成 -qq → 汇总行（"N passed"）被隐藏 → 明明跑完却报「0 tests（不计入通过）」。
    // 进度行每个用例一个字符：. 通过 / s 跳过 / F 失败 / E 错误 / x X xfail-xpass / P 带警告通过
    const progLines = lines.filter(l => /\[\s*\d+%\]\s*$/.test(l) || /^\s*[.sFExXPu]+\s*(\[\s*\d+%\])?\s*$/.test(l))
    if (progLines.length) {
      const text = progLines.join('')
      const tally = (ch) => (text.match(new RegExp('\\' + ch, 'g')) || []).length
      const p = tally('.') + tally('P')
      const f = tally('F') + tally('E')
      if (p > 0 || f > 0) {
        passed = p
        failed = f
      }
    }
  }
  if (passed === 0 && failed === 0) {
    // 兜底仅认：行首锚定 TAP 用例行 / PASS|FAIL 词 / ✓|✗ 标记——裸 'ok' 子串已禁用
    const failLines = lines.filter(l => /^\s*not ok\b/.test(l) || /\bFAIL(?:ED)?\b/.test(l) || l.includes('✗'))
    const passLines = lines.filter(l => /^\s*ok\b/.test(l) || /\bPASS(?:ED)?\b/.test(l) || l.includes('✓'))
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

// R07（0.5.10 审核修复）：typecheck 命令解析——不再裸跑缺命令（Windows cmd 包装会把「命令不存在」变成假 failed）。
// 本地 tsc → npx --no-install；无 tsconfig 或最终缺包 → 结果层判 unavailable（skipped），不冒充代码失败。
function resolveTypecheck(dir) {
  const isWin = process.platform === 'win32'
  const local = [
    join(dir, 'node_modules', '.bin', isWin ? 'tsc.cmd' : 'tsc'),
    join(dir, 'node_modules', 'typescript', 'bin', 'tsc'),
  ].find((p) => existsSync(p))
  if (local) return { cmd: local, args: ['--noEmit'] }
  if (!existsSync(join(dir, 'tsconfig.json'))) {
    return { unavailable: true, reason: 'no_tsconfig', notice: 'No tsconfig.json and no typecheck script — nothing to type-check (project/environment limitation, not a code defect).' }
  }
  return { cmd: 'npx', args: ['--no-install', 'tsc', '--noEmit'] }
}

// R07：typecheck 不可用分类（纯函数，供失败路径测试）——区分「工具缺失/无配置」（skipped/unavailable）与真实类型错误（failed）。
export function typecheckUnavailableReason(result, platform = process.platform) {
  if (!result) return null
  // N04c：exit=0 的阶段已经跑通，任何「缺件」文本都不足以改判 unavailable。
  // 复合脚本有 fallback 时（`missing || node --check x`）sh 仍会打印 not found，但脚本整体成功。
  if (result.exitCode === 0) return null
  const s = String(result.stdout || '') + '\n' + String(result.stderr || '') + '\n' + String(result.error || '')
  if (result.error_code === 'ENOENT') return 'tsc_not_found'
  if (typeof result.error === 'string' && /ENOENT/.test(result.error)) return 'tsc_not_found'
  if (/npx canceled due to missing packages/i.test(s)) return 'tsc_not_found'
  if (/This is not the tsc command you are looking for/i.test(s)) return 'tsc_not_found'
  if (/(不是内部或外部命令|无法识别|not recognized|command not found)/.test(s) && /\b(tsc|npx)\b/i.test(s)) return 'tsc_not_found'
  // N04b：POSIX shell 缺命令结构（npm 包装后裸 ENOENT/9009 语义丢失的对应物）——dash: sh: 1: <tool>: not found；
  // bash: bash: line 1: <tool>: command not found；busybox: sh: <tool>: not found。有真实 TS 诊断时优先真实失败（不吞）。
  const posixMiss = /(?:^|\n)\s*(?:\S*\/)?(?:sh|dash|ash|bash)\s*:\s*(?:line\s+)?(?:\d+\s*:\s*)?([^:\n]+?)\s*:\s*(?:command\s+)?not found\b/.exec(s)
  // N04c：shell 缺命令只是「有一条命令没跑成」；脚本里若还有真实检查产出（TS 诊断/语法错/运行时栈/
  // Node 错误码），说明后续命令确实执行并失败——必须报 failed，不能吞成 unavailable。
  // 判定顺序保持「结构化事实优先」：只有缺命令是唯一失败信号时才归环境缺件。
  const realFailure = /error TS\d+|\bSyntaxError\b|\bERR_[A-Z_]+\b|^[ \t]+at .+:\d+:\d+|Cannot find module\b/m.test(s)
  // R2（0.5.14 复审修复）：cmd.exe 缺命令结构——'<tool>' is not recognized as an internal or external
  // command / '<tool>' 不是内部或外部命令。旧实现只在文本里再看到 tsc/npx 时才归缺件，
  // Windows 复合脚本（cd sub && no-such-tool --noEmit）里缺普通命令被误报成代码 fail（原测试 113/1）。
  // GBK 乱码态（中文 Windows 输出按 UTF-8 解码）里引号内 ASCII 工具名仍是可提取信号；该分支只在 win32 生效。
  const cmdMiss = /(?:^|\n)\s*'([^'\r\n]+)'\s*(?:is not recognized as an internal or external command\b|不是内部或外部命令|不是內部或外部命令)/.exec(s)
  const cmdMojibake = (!cmdMiss && platform === 'win32' && result.exitCode !== 0)
    ? /(?:^|\n)\s*'([^'\r\n]+)'\s*\uFFFD{2,}/.exec(s)
    : null
  const cmdHit = cmdMiss || cmdMojibake
  if (cmdHit && !realFailure) {
    const tool = cmdHit[1].trim().split(/[\\/]/).pop()
    return /^tsc(\.cmd)?$/i.test(tool) ? 'tsc_not_found' : 'script_tool_not_found'
  }
  if (posixMiss && !realFailure) {
    const tool = posixMiss[1].trim().split('/').pop()
    return /tsc$/i.test(tool) ? 'tsc_not_found' : 'script_tool_not_found'
  }
  if (/TS18003/.test(s)) return 'no_tsconfig'
  if (result.exitCode !== 0 && /Usage:|tsc \[options\]/i.test(s) && !/error TS\d+/i.test(s)) return 'no_tsconfig'
  return null
}

// ── N04（0.5.11 复审修复）：包脚本分支的工具可用性取结构化事实，不靠文本分类 ──
// 背景：项目 typecheck 脚本写成 `tsc --noEmit` 时，Windows 上 npm 包装后 exitCode=1、stderr 是本地化乱码，
// 裸 cmd 的 9009/ENOENT 语义已经丢失；纯文本分类器识别不到 → 缺工具被误报 failed（G3 记 FAIL）。
// 做法：失败时解析脚本体的首个可执行 token，直接查它在本机是否可解析；解析不到 = 环境缺件（unavailable），
// 解析得到 = 保持 failed（真实诊断）。这是「结构化事实」而非「把任意非零都改成 unavailable」。
export function firstScriptToken(script) {
  let s = String(script || '').trim()
  // 剥掉前置 env 赋值（FOO=1 bar=2 cmd）与常见 shell 前缀
  s = s.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, '')
  const m = /^("[^"]+"|'[^']+'|\S+)/.exec(s)
  if (!m) return null
  let tok = m[1].replace(/^["']|["']$/g, '')
  // npx/yarn/pnpm 的包装：取其后第一个非选项 token 作为真实工具
  if (/^(npx|pnpx|bunx)(\.cmd)?$/i.test(tok)) {
    const rest = s.slice(m[0].length).trim().split(/\s+/).filter(Boolean)
    const next = rest.find((x) => !x.startsWith('-'))
    return next ? next.replace(/^["']|["']$/g, '') : tok
  }
  return tok
}

// cmd内建命令由shell执行，不需要PATH中存在同名exe。
const CMD_BUILTINS = new Set([
  'assoc', 'break', 'call', 'cd', 'chdir', 'cls', 'color', 'copy', 'date', 'del',
  'dir', 'echo', 'endlocal', 'erase', 'exit', 'for', 'ftype', 'goto', 'if', 'md',
  'mkdir', 'mklink', 'move', 'path', 'pause', 'popd', 'prompt', 'pushd', 'rd',
  'rem', 'ren', 'rename', 'rmdir', 'set', 'setlocal', 'shift', 'start', 'time',
  'title', 'type', 'ver', 'verify', 'vol',
])

// 命令 token 的可解析性：cmd内建 → 显式路径 → 项目 .bin 与 PATH（含 PATHEXT）。
export function isCommandResolvable(cmd, dir, env = process.env, io = {}) {
  if (!cmd) return null
  const exists = io.exists || existsSync
  const joinPath = io.join || join
  const isWin = io.platform ? io.platform() === 'win32' : process.platform === 'win32'
  if (isWin) {
    cmd = cmd.replace(/^@/, '')
    if (CMD_BUILTINS.has(cmd.toLowerCase())) return true
  }
  if (/[\\/]/.test(cmd)) return exists(isAbsolute(cmd) ? cmd : joinPath(dir, cmd))
  const exts = isWin
    ? ((env.PATHEXT !== undefined ? env.PATHEXT : '.COM;.EXE;.BAT;.CMD') || '').split(';').filter(Boolean)
    : ['']
  const hasExt = /\.[^\\/]+$/.test(cmd)
  const bases = [joinPath(dir, 'node_modules', '.bin')]
  const sep = isWin ? ';' : ':'
  for (const d of ((env.PATH !== undefined ? env.PATH : process.env.PATH) || '').split(sep)) {
    if (d) bases.push(d)
  }
  for (const d of bases) {
    if (hasExt) { if (exists(joinPath(d, cmd))) return true; continue }
    for (const e of exts) if (exists(joinPath(d, cmd + e))) return true
  }
  return false
}

// 包脚本分支的缺件判定（纯函数）：只在 exit!=0 且脚本首个工具在本机解析不到时返回 unavailable
export function scriptToolUnavailableReason(script, exitCode, dir, env = process.env, io = {}) {
  if (!script || exitCode === 0) return null
  const isWin = io.platform ? io.platform() === 'win32' : process.platform === 'win32'
  // 复合命令可能有fallback、变量展开或shell控制流。首命令缺失不能证明整段脚本不可运行。
  // 对这类脚本交还真实runner判定；普通裸tsc缺失的结构化检查保持不变（缺件由结果层结构分类兜住）。
  // N04b：同类守卫扩至 POSIX——cmd 元字符 [&|<>^()%!]；POSIX 元字符含 ; ( ) 换行 反引号 $。
  const meta = isWin ? /[&|<>^()%!]/ : /[&|<>;()\n`$]/
  if (meta.test(script)) return null
  const tok = firstScriptToken(script)
  const resolvable = isCommandResolvable(tok, dir, env, io)
  if (resolvable === false) {
    const kind = /\btsc$|\btsc\.cmd$/i.test(String(tok)) ? 'tsc_not_found' : 'script_tool_not_found'
    return { reason: kind, cmd: tok }
  }
  return null
}

// 0.5.25：Python 测试目标探测——工作区（或其子目录）里有 pytest 项目时，给出解释器 + 运行目录。
function detectPythonTestTarget(workdir, stopDir) {
  try {
    const root = stopDir ? resolve(stopDir) : resolve(workdir)
    const rel = workdir && workdir.startsWith(root) ? workdir.slice(root.length).replace(/^[\\/]+/, '') : '.'
    const r = resolvePythonProject({ workspaceDir: root, scope: rel || '.' })
    if (!r.pytest_project) return { detected: false }
    return {
      detected: true,
      python: r.python,
      python_source: r.python_source,
      fallback_to_system: r.fallback_to_system,
      cwd: r.project_root || workdir,
    }
  } catch { return { detected: false } }
}

async function runStage(stage, dir, timeout, stopDir, signal = null) {
  const t0 = Date.now()
  const scripts = detectScripts(dir, stopDir)
  const pm = detectPkgManager(dir, stopDir)
  let cmd, args, result
  // 0.5.25：stage 实际执行目录（Python 项目跑在项目根而非工作区根）
  let stageCwd = dir
  if (stage === 'lint') {
    // 优先跑项目 lint 脚本（契约：detectScripts 探测 → 对应脚本），无脚本用 eslint 兜底
    if (scripts.lint) { cmd = pm; args = ['run', scripts.lint] }
    // r54(P2): --no-install——无 eslint 项目首次 npx 会联网下载（对齐 tsc-check r46）
    else { cmd = 'npx'; args = ['--no-install', 'eslint', '.'] }
  } else if (stage === 'test') {
    if (scripts.test) { cmd = pm; args = ['run', scripts.test] }
    else {
      // 0.5.25：Python 项目也能验——没有 npm test 脚本时探测 pytest 项目，用项目 venv 的解释器跑
      // （旧实现一律 skipped「No test script in package.json」→ Python 仓的 code_check 永远验不了）
      const pyT = detectPythonTestTarget(dir, stopDir)
      if (pyT.detected) {
        cmd = pyT.python
        args = ['-m', 'pytest', '-q']
        stageCwd = pyT.cwd
      } else {
        // r54(P2): 无 test 脚本时 `node --check`(无文件参数) 在 stdin ignore 下恒 exit 0 → 假 passed。
        // 返回 skipped 而非空过，避免「验证了但什么都没验证」
        return {
          ran: false,
          passed: null,
          skipped: true,
          duration_ms: Date.now() - t0,
          command: null,
          cwd: dir,
          notice: 'No test script in package.json and no pytest project detected; nothing to run. Add a "test" script, or make the workspace a Python project (pyproject.toml/pytest.ini).',
        }
      }
    }
  } else if (stage === 'typecheck') {
    // N04（0.5.11 复审修复）：脚本分支先取结构化事实——脚本里调用的工具本机解析不到 = 环境缺件，
    // 不跑一次再说「代码检查失败」（Windows 上 npm 包装会吞掉 9009/ENOENT，文本分类不可靠）
    if (scripts.typecheck) {
      const scriptBody = (readPkgScripts(dir, stopDir) || {})[scripts.typecheck]
      const miss = scriptToolUnavailableReason(scriptBody, 1, dir)
      if (miss) {
        return {
          ran: false, passed: null, skipped: true, unavailable: miss.reason,
          duration_ms: Date.now() - t0, command: null, cwd: dir,
          notice: 'typecheck unavailable: script "' + scripts.typecheck + '" runs "' + miss.cmd + '", which is not resolvable here (environment/tooling limitation, not a code defect).',
        }
      }
      cmd = pm; args = ['run', scripts.typecheck]
    } else {
      // R07（0.5.10 审核修复）：命令解析先行——缺工具/缺配置 → 结构化 skipped/unavailable（不冒充 failed）；真编译错误仍由 exit!=0 判 failed
      const resolved = resolveTypecheck(dir)
      if (resolved.unavailable) {
        return {
          ran: false, passed: null, skipped: true, unavailable: resolved.reason,
          duration_ms: Date.now() - t0, command: null, cwd: dir, notice: resolved.notice,
        }
      }
      cmd = resolved.cmd; args = resolved.args
    }
  } else if (stage === 'syntax') {
    // r45: 逐个文件 node --check（带文件参数 + stdin ignore，不挂起）；上限 50 文件、失败累积 10 个即止
    const files = collectJsFiles(dir, 50)
    // R2（0.5.14 复审修复）：零目标不是通过——checked=0 必须 skipped/not-run，不得报 passed（原 093：checked=0 仍 ran=true/passed=true/status=pass）
    if (files.length === 0) {
      return {
        ran: false, passed: null, skipped: true, checked: 0, unavailable: 'no_files',
        duration_ms: Date.now() - t0, command: 'node --check', cwd: dir,
        notice: 'No .js/.mjs/.cjs files found in workdir — nothing was checked (not a pass).',
      }
    }
    const failed = []
    for (const f of files) {
      const r = await execStage('node', ['--check', f], dir, timeout, signal)
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
      command: 'node --check',
      cwd: dir,
      checked: files.length,
      failed,
      ...(files.length === 0 ? { notice: 'No .js/.mjs/.cjs files found in workdir' } : {}),
    }
  }
  result = await execStage(cmd, args, stageCwd, timeout, signal)
  const duration_ms = Date.now() - t0
  const ok = result.exitCode === 0
  const base = {
    ran: true,
    passed: ok,
    duration_ms,
    exitCode: result.exitCode,
    // LH-010：可执行解析回传——stage 失败时调用方能知道「到底跑了什么/在哪跑」，不再只能猜
    command: [cmd, ...args].join(' '),
    cwd: stageCwd,
    stdout: result.stdout.slice(0, MAX_OUTPUT),
    stderr: result.stderr.slice(0, MAX_OUTPUT),
    // r10d：超时被杀显式透传（execStage 已标注，runStage 不能丢）
    ...(result.killed ? { killed: true, timed_out: result.timed_out } : {}),
    ...(result.error ? { error: result.error } : {}),
    // 第二轮审查修复（I2 残留）：error_code 必须透传（旧只 spread error，ENOENT 诊断码丢失）
    ...(result.error_code ? { error_code: result.error_code } : {}),
  }
  // R07（0.5.10 审核修复）：typecheck 结果层分类——缺包/无配置横幅 → skipped/unavailable（样本见 typecheckUnavailableReason）
  if (stage === 'typecheck') {
    const unavail = typecheckUnavailableReason(result)
    if (unavail) {
      return { ...base, passed: null, skipped: true, unavailable: unavail, notice: 'typecheck unavailable: ' + unavail + ' (environment/tooling limitation, not a code defect).' }
    }
  }
  if (stage === 'lint') {
    const lintErrors = !ok ? parseLintOutput(result.stdout, result.stderr) : []
    const unavail = lintUnavailableReason(scripts.lint !== false && scripts.lint != null, ok, result.stderr, result.stdout)
    if (unavail) {
      // R2：环境缺件（无 lint 脚本且 eslint 不可用）不是代码失败——skipped/unavailable 入汇总（旧实现拖整体 fail）
      return { ...base, passed: null, skipped: true, unavailable: 'lint_not_found', error: unavail, errors: lintErrors, errorCount: lintErrors ? lintErrors.length : 0, notice: 'No lint script in package.json and eslint is not installed — environment limitation, not a code defect.' }
    }
    return { ...base, errors: lintErrors, errorCount: lintErrors ? lintErrors.length : 0 }
  }
  if (stage === 'test') {
    const stats = parseTestOutput(result.stdout, result.stderr)
    // G3/§7.4：exit 0 但 0 个测试（无匹配/空运行）不算通过 —— skipped 而非 green
    if (ok && stats.total === 0) {
      return { ...base, passed: null, skipped: true, no_tests: true, passedCount: 0, failedCount: 0, total: 0, notice: 'Test command exited 0 but reported 0 tests (no match); not counted as a pass.' }
    }
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
  // dogfood ②c：background（async job，不占 MCP 请求槽）放宽到 600s，长套件可跑
  const isBackground = context?.background === true
  const cap = isBackground ? 600_000 : 110_000
  if (timeout > cap) timeout = cap

  const detected = detectScripts(workdir, root)
  // 0.5.25：Python 项目没有 npm 脚本，但有 pytest 入口——test 阶段要能被选中
  const pythonTarget = detectPythonTestTarget(workdir, root)
  const stagesArg = args?.stages
  const wanted = stagesArg
    ? String(stagesArg).split(',').map(s => s.trim().toLowerCase()).filter(s => ['lint', 'test', 'typecheck'].includes(s))
    : ['lint', 'typecheck', 'test'].filter(s => detected[s] || (s === 'test' && pythonTarget.detected))
  // r45: stages 显式传了但全部不可识别 → 报错而非静默兜底跑 syntax（此前 stages='lint:fix' 会被过滤成空 → 意外触发挂起路径）
  if (stagesArg && wanted.length === 0) {
    return makeError('invalid_input', `Unknown stage(s): ${String(stagesArg)}`, 'Valid stages: lint, test, typecheck (comma-separated).')
  }

  const results = {}
  const signal = context?.signal || null
  for (const stage of wanted) {
    results[stage] = await runStage(stage, workdir, timeout, root, signal)
  }
  if (Object.keys(results).length === 0) {
    results.syntax = await runStage('syntax', workdir, timeout, root, signal)
  }
  // R2（0.5.14 复审修复）：汇总语义四值化——不做「全跳过 = pass」的假绿（原 091/093：全未执行也报 pass）：
  //   pass    = 全部阶段真实执行且通过（无未执行项）
  //   partial = 有阶段真实通过，但存在未执行/未验证阶段（完整性受限，未测项不计通过）
  //   not_run = 没有任何阶段真实执行（全部 skipped/unavailable/零目标）
  //   fail    = 任一阶段真实失败（含超时；真实失败优先）
  const stageStates = Object.entries(results).map(([k, r]) => {
    const state = !r ? 'skipped'
      : r.ran === true ? (r.passed === true ? 'passed' : (r.passed === false ? 'failed' : 'skipped'))
      : r.passed === true ? 'passed'
      : r.passed === false ? 'failed'
      : 'skipped'
    return { stage: k, state, reason: state === 'skipped' ? (r?.unavailable || (r?.no_tests ? 'no_tests' : r?.skipped ? 'skipped' : 'no_verdict')) : null }
  })
  const passedStages = stageStates.filter(x => x.state === 'passed').map(x => x.stage)
  const failedStages = stageStates.filter(x => x.state === 'failed').map(x => x.stage)
  const unexecuted = stageStates.filter(x => x.state === 'skipped').map(x => x.stage + ':' + x.reason)
  const status = failedStages.length > 0 ? 'fail'
    : passedStages.length === 0 ? 'not_run'
    : unexecuted.length === 0 ? 'pass'
    : 'partial'
  const verification = {
    status,
    executed: passedStages.length + failedStages.length,
    passed: passedStages.length,
    failed: failedStages.length,
    skipped: unexecuted.length,
    complete: status === 'pass',
    ...(status === 'pass' ? {} : {
      reason: status === 'fail'
        ? 'stage(s) failed: ' + failedStages.join(', ')
        : status === 'not_run'
          ? 'nothing executed: ' + (unexecuted.join(', ') || 'no stages requested')
          : 'partial: passed ' + passedStages.join(', ') + '; not executed ' + unexecuted.join(', '),
    }),
  }
  // r10e(F3)：MCP 请求超时 120s 硬限制——多阶段全链（lint+test+typecheck × timeout）超预算时预警，
  // 否则工具超时后服务端仍继续跑、占满 semaphore 槽导致其他工具排队 60s 超时（实测 verify_pipeline 全链 3-4 分钟）
  const totalBudgetMs = wanted.length * timeout
  const mcp_note = (!isBackground && totalBudgetMs > 100_000)
    ? `MCP request has a 120s hard timeout: ${wanted.length} stages × ${Math.round(timeout / 1000)}s budget = ${Math.round(totalBudgetMs / 1000)}s, will definitely time out. Suggest stages=lint single-stage, or use test_bridge(action="run") to batch by file scope.`
    : null
  return {
    status,
    verification,
    results,
    timeout_ms: timeout,
    ...(mcp_note ? { mcp_note } : {}),
    scripts: { lint: !!detected.lint, test: !!detected.test, typecheck: !!detected.typecheck },
    workdir,
    summary: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, { passed: v.passed, duration_ms: v.duration_ms }])),
  }
}
