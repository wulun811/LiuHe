// spawn-guard.js — R14：进程组超时杀（4 spawn 工具统一）
// 裸 execFile timeout 只杀直接子进程，孙进程（npm/go run/npx/mvn/gradle）变孤儿。
// detached:true 创建新进程组 → 超时 kill(-pid) 杀全组；3s 宽限后 SIGKILL。
// Windows：无 POSIX 进程组——shell:true 让 npm.cmd 等 shim 可执行，超时 taskkill /T 杀整树
// （注释由 Linux 项目历史继承，现平台分支已就位）
import { spawn, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

// R25（批17-A，第三轮 Windows 复验实测）：裸命令名解析——CreateProcess 只能直跑 .exe/.com；
// npm 等 .cmd/.bat shim 才必须经 cmd.exe。旧实现对一切裸名走 cmd，导致 `node -e "setInterval(()=>{},1000)"`
// 的 () 被 cmd 当命令分组/重定向解析 → SyntaxError、真实 job 活不到取消。
// 解析序仿 cmd/PATH：逐目录、逐 PATHEXT；命中 com/exe → 直跑；bat/cmd → shim；未命中 → null（保留旧 cmd 报错语义）。
function winCommandKind(cmd, io = {}) {
  const exists = io.exists || existsSync
  const joinPath = io.join || join
  const dirs = ((io.path !== undefined ? io.path : process.env.PATH) || '').split(';').filter(Boolean)
  const exts = ((io.pathext !== undefined ? io.pathext : process.env.PATHEXT) || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  const isShimExt = (e) => /^\.(cmd|bat)$/i.test(e)
  const hasExt = /\.[^\\/]+$/.test(cmd)
  for (const d of dirs) {
    if (hasExt) {
      if (exists(joinPath(d, cmd))) return isShimExt(cmd.slice(cmd.lastIndexOf('.'))) ? 'shim' : 'exe'
    } else {
      for (const e of exts) {
        if (exists(joinPath(d, cmd + e))) return isShimExt(e) ? 'shim' : 'exe'
      }
    }
  }
  return null
}

// cmd.exe 参数引用：仅安全字符集免引号；其余整体双引号 + 内部 " 双写；行尾 \\ 双写
// （否则被目标程序 CRT 解析为转义引号）。注：cmd 对引号内 %VAR% 仍展开（cmd 固有行为）；
// 原生 exe 已不走此路径，shim 参数罕含 %。
const CMD_SAFE_TOKEN = /^[A-Za-z0-9_\-.,:\\/=@#+~]+$/
function winQuote(a) {
  const s = String(a)
  if (CMD_SAFE_TOKEN.test(s)) return s
  let body = s.replace(/"/g, '""')
  if (/\\$/.test(body)) body = body.replace(/\\+$/, (m) => m + m)
  return `"${body}"`
}

function wrapWin(cmd, args) {
  return { cmd: 'cmd.exe', args: ['/d', '/s', '/c', [cmd, ...(args || [])].map(winQuote).join(' ')] }
}

function winCmd(cmd, args, io) {
  // cmd.exe 本体与带路径 exe：数组 spawn 即可；带路径 .cmd/.bat 无法 CreateProcess 直跑，cmd 包一层
  if (/^cmd(\.exe)?$/i.test(cmd)) return null
  if (/[\\/]/.test(cmd)) return /\.(cmd|bat)$/i.test(cmd) ? wrapWin(cmd, args) : null
  // 裸名：解析为 exe/com → 直跑（argv 语义完整）；shim 或未命中 → cmd 包一层
  return winCommandKind(cmd, io) === 'exe' ? null : wrapWin(cmd, args)
}

export { winCmd as _winCmd, winCommandKind as _winCommandKind, winQuote as _winQuote }

// live 复验（2026-10-07，批5后）：宿主门控变量默认不泄漏进子进程——graph/diagnostic 宿主下
// code_check→npm test 的子进程若继承 MALONG_INTERFACE，malong 自身 registry 门控会把测试
// 临时工具也隐藏（test-tool-registry 0/49 假失败）。执行类工具跑的是「项目命令」，语义应与
// CI/终端一致；调用方可用 opts.env 显式覆盖回填（opt-in）。
const HOST_GATE_ENV_KEYS = ['MALONG_INTERFACE', 'MALONG_ENTRY_STATE']
function scrubHostGateEnv(src) {
  const out = { ...src }
  for (const k of HOST_GATE_ENV_KEYS) delete out[k]
  return out
}

export async function spawnWithGroup(cmd, args, opts = {}) {
  const { timeout, cwd, env, maxBuffer = 4 * 1024 * 1024, stdin = 'ignore', shell = false, signal = null, windowsVerbatimArguments = false } = opts
  const isWin = process.platform === 'win32'
  let spawnCmd = cmd
  let spawnArgs = args || []
  if (isWin && !shell) {
    const shim = winCmd(cmd, args)
    if (shim) { spawnCmd = shim.cmd; spawnArgs = shim.args }
  }
  return new Promise((resolve, reject) => {
    const child = spawn(spawnCmd, spawnArgs, {
      cwd: cwd || process.cwd(),
      env: { ...scrubHostGateEnv(process.env), ...(env || {}) },
      stdio: [stdin, 'pipe', 'pipe'],
      shell,
      windowsHide: true,
      windowsVerbatimArguments: isWin && windowsVerbatimArguments,
      // Windows：无 POSIX 进程组——detached 会让 cmd 内 .cmd 输出丢句柄，超时杀用 taskkill /T
      detached: !isWin,
    })
    let stdout = ''
    let stderr = ''
    let killed = false
    let aborted = false
    let truncated = false
    let settled = false

    const killGroup = (sig) => {
      if (isWin) {
        // Windows 无进程组：taskkill /T 连孙进程整树强杀
        try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
      } else {
        try { process.kill(-child.pid, sig) } catch {}
      }
    }

    const killTimer = timeout ? setTimeout(() => {
      killed = true
      killGroup('SIGTERM')
      setTimeout(() => killGroup('SIGKILL'), 3000).unref()
    }, timeout) : null

    // S3.2：外部取消——job 管理传入 AbortSignal；abort 即杀进程组（3s 宽限后 SIGKILL）
    const onAbort = () => {
      aborted = true
      killGroup('SIGTERM')
      setTimeout(() => killGroup('SIGKILL'), 3000).unref()
    }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    const cleanupSignal = () => { if (signal) signal.removeEventListener('abort', onAbort) }

    child.stdout.on('data', (d) => {
      const s = d.toString()
      if (stdout.length >= maxBuffer) { truncated = true; return }
      stdout += s.slice(0, maxBuffer - stdout.length)
      if (stdout.length >= maxBuffer) truncated = true
    })
    child.stderr.on('data', (d) => {
      const s = d.toString()
      if (stderr.length >= maxBuffer) { truncated = true; return }
      stderr += s.slice(0, maxBuffer - stderr.length)
      if (stderr.length >= maxBuffer) truncated = true
    })

    child.on('error', (e) => {
      if (settled) return
      settled = true
      if (killTimer) clearTimeout(killTimer)
      cleanupSignal()
      reject(e)
    })
    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      if (killTimer) clearTimeout(killTimer)
      cleanupSignal()
      resolve({ code, signal, stdout, stderr, killed, aborted, truncated })
    })
  })
}
