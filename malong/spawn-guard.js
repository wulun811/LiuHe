// spawn-guard.js — R14：进程组超时杀（4 spawn 工具统一）
// 裸 execFile timeout 只杀直接子进程，孙进程（npm/go run/npx/mvn/gradle）变孤儿。
// detached:true 创建新进程组 → 超时 kill(-pid) 杀全组；3s 宽限后 SIGKILL。
// Linux 进程组语义（Windows 无，本项目 linux）。
import { spawn } from 'node:child_process'

export async function spawnWithGroup(cmd, args, opts = {}) {
  const { timeout, cwd, env, maxBuffer = 4 * 1024 * 1024, stdin = 'ignore' } = opts
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args || [], {
      cwd: cwd || process.cwd(),
      env: { ...process.env, ...(env || {}) },
      stdio: [stdin, 'pipe', 'pipe'],
      detached: true,
    })
    let stdout = ''
    let stderr = ''
    let killed = false
    let truncated = false
    let settled = false

    const killGroup = (sig) => {
      try { process.kill(-child.pid, sig) } catch {}
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