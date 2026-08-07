// host-config.js — MCP 宿主中立状态目录（r37：去 opencode 专用化）
// MCP 协议本身通用（JSON-RPC 2.0 + stdio），任何 MCP 客户端可连；
// 本文件统一托管「宿主相关的数据位置」——默认 ~/.config/malong，
// 可用 MALONG_STATE_DIR 环境变量覆盖（测试/沙盒定向）。
// 兼容：0.3.36 及更早版本的统计/反馈数据写在 ~/.config/opencode/，
// readStateFile 读取时自动回退旧路径（写入只写新目录，旧数据不丢）。
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'

// r35-fix 同款：Windows 上 homedir() 忽略 HOME（读 USERPROFILE），HOME 优先
// 注意：函数内动态求值（模块级常量会在 HOME 变更/测试定向后失效）
// Y001 债务3：导出供 readUsageStats 双路径聚合（旧副本数据仍计入）
export function getLegacyDir() {
  return join(process.env.HOME || homedir(), '.config', 'opencode')
}

export function getStateDir() {
  return process.env.MALONG_STATE_DIR || join(process.env.HOME || homedir(), '.config', 'malong')
}

export function ensureStateDir() {
  const dir = getStateDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

// 新路径（写入方用）
export function resolveStateFile(name) {
  return join(getStateDir(), name)
}

// 读取兼容旧版：新路径不存在时回退 ~/.config/opencode/ 下的同名文件
export function readStateFile(name) {
  const p = resolveStateFile(name)
  if (existsSync(p)) return p
  const legacy = join(getLegacyDir(), name)
  return existsSync(legacy) ? legacy : p
}

// 会话 ID：通用探测各 MCP 宿主注入的 env（opencode 注入 OPENCODE_SESSION；空串无副作用）
export function getSessionId() {
  return process.env.OPENCODE_SESSION || process.env.MCP_SESSION_ID || process.env.SESSION_ID || ''
}
