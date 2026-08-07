// spawn-guard.js — R14：进程组超时杀（4 spawn 工具统一）
// 裸 execFile timeout 只杀直接子进程，孙进程（npm/go run/npx/mvn/gradle）变孤儿。
// detached:true 创建新进程组 → 超时 kill(-pid) 杀全组；3s 宽限后 SIGKILL。
// Windows：无 POSIX 进程组——shell:true 让 npm.cmd 等 shim 可执行，超时 taskkill /T 杀整树
// （注释由 Linux 项目历史继承，现平台分支已就位）
import { spawn, execFileSync } from 'node:child_process'

// Windows：命令名（无分隔符）可能是 npm.cmd 等 shim——CreateProcess 不能直接跑 .cmd，
// 交 cmd.exe /d /s /c 解析（PATH 查找 shim）；拼串时含空格/引号参数加双引号（cmd 内 "" 转义）。
// 带路径的 exe（如 C:\Program Files\nodejs\node.exe）返回 null → 数组 spawn，无引号问题。
function winCmd(cmd, args) {
  // 带路径的 exe（node.exe 等）与 cmd.exe 本体：数组 spawn 即可
  if (/[\\/]/.test(cmd) || /^cmd(\.exe)?$/i.test(cmd)) return null
  const q = (a) => /[\s"]/.test(a) ? `"${String(a).replace(/"/g, '""')}"` : String(a)
  return { cmd: 'cmd.exe', args: ['/d', '/s', '/c', [cmd, ...(args || [])].map(q).join(' ')] }
}

export async function spawnWithGroup(cmd, args, opts = {}) {
  const { timeout, cwd, env, maxBuffer = 4 * 1024 * 1024, stdin = 'ignore', shell = false } = opts
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
      env: { ...process.env, ...(env || {}) },
      stdio: [stdin, 'pipe', 'pipe'],
      shell,
      // Windows：无 POSIX 进程组——detached 会让 cmd 内 .cmd 输出丢句柄，超时杀用 taskkill /T
      detached: !isWin,
    })
    let stdout = ''
    let stderr = ''
    let killed = false
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
      reject(e)
    })
    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      if (killTimer) clearTimeout(killTimer)
      resolve({ code, signal, stdout, stderr, killed, truncated })
    })
  })
}