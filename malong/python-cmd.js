// Python 解释器探测（Windows 上 python3 常为 MS Store 占位 stub；Linux/macOS 用 python3）
// 优先级：环境变量 MALONG_PYTHON > python3 > python；结果进程内缓存。
// 说明：runSyntaxCheck/debug-runner 等子进程调用统一走这里，避免各工具各自硬编码。

import { execFileSync } from 'node:child_process'

let _cached = undefined

export function getPythonCmd() {
  if (_cached !== undefined) return _cached
  const candidates = []
  if (process.env.MALONG_PYTHON) candidates.push(process.env.MALONG_PYTHON)
  candidates.push('python3', 'python')
  for (const cmd of candidates) {
    try {
      execFileSync(cmd, ['--version'], { stdio: 'pipe', timeout: 3000 })
      _cached = cmd
      return cmd
    } catch {
      // 占位 stub 或不存在 → 尝试下一个
    }
  }
  _cached = 'python3'
  return _cached
}
