// 重连期间请求排队测试
import { execSync, spawn } from 'node:child_process'
import { readFileSync, existsSync, readlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const IS_WIN = process.platform === 'win32'
const UID = IS_WIN ? 0 : (process.getuid?.() ?? 0)
const SOCKET = `/tmp/malong-parse-${UID}.sock`
const PID_FILE = `/tmp/malong-parse-${UID}.pid`

// R22-㉓：候选链绝对路径（同 test-kill-recover/test-variable-refs 模式）——裸 malong-parse 依赖 PATH，
// CI 只构建 target/debug 未装 PATH → setsid 重启起不来。macOS 无 setsid → 用 spawn detached 跨平台。
// 2026-10-18：次序改为「env → ~/.local/bin → release → debug」+ 沿用线上 daemon 自己的二进制（/proc/pid/exe）。
// 旧次序把 repo debug 放第二，全链会把线上 release daemon 换成 debug 构建并留在线上
// （实测：线上 health 变成 "predates identity fields"）。
const BIN_NAME = IS_WIN ? 'malong-parse.exe' : 'malong-parse'
const BIN_CANDIDATES = [
  process.env.MALONG_PARSE_BIN,
  join(os.homedir(), '.local', 'bin', BIN_NAME),
  join(__dirname, '..', '..', 'malong-parse', 'target', 'release', BIN_NAME),
  join(__dirname, '..', '..', 'malong-parse', 'target', 'debug', BIN_NAME),
  join(os.tmpdir(), 'opencode', 's3-bin', BIN_NAME),
].filter(Boolean)
const BIN = BIN_CANDIDATES.find(p => existsSync(p))
// 重启时沿用线上 daemon 实际的二进制（main 里从 /proc/<pid>/exe 解析）
let LIVE_BIN = null
const restartBin = () => LIVE_BIN || BIN
// Windows 整测试跳过（main 内 exit 0），顶层不因缺二进制报错
if (!BIN && !IS_WIN) {
  console.error(`  FAIL: malong-parse binary not found (tried: ${BIN_CANDIDATES.join(' | ')})`)
  process.exit(1)
}

function startDaemon() {
  const child = spawn(restartBin(), [], { stdio: 'ignore', detached: true })
  child.unref()
}

let passed = 0, failed = 0
function assert(label, ok, detail) {
  if (ok) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; console.log(`  ✗ ${label}: ${detail || ''}`) }
}

function ensureService() {
  // 检查进程是否运行
  let pid = 0
  try {
    pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim())
    execSync(`kill -0 ${pid} 2>/dev/null`)
  } catch {
    // 进程不存在，启动
    try { execSync(`rm -f ${SOCKET} ${PID_FILE}`) } catch {}
    startDaemon()
    // 等待 socket
    for (let i = 0; i < 20; i++) {
      if (existsSync(SOCKET)) break
      execSync('sleep 0.1')
    }
  }
}

async function main() {
  console.log('重连期间请求排队测试\n')

  if (process.platform === 'win32') {
    console.log('  ⚠ NOT_RUN: Windows 进程生命周期语义（kill/setsid/pid-file）为 Unix 专用，整文件跳过')
    process.exit(0)
  }

  // 确保服务运行
  ensureService()

  // 导入 parse-client
  const pc = await import('../parse-client.js')
  await pc.init({ log: () => {} })
  
  // 连接
  const ok = await pc.connect()
  assert('初始连接成功', ok)
  if (!ok) process.exit(1)

  // 读取当前 PID
  const pidBefore = parseInt(readFileSync(PID_FILE, 'utf-8').trim())
  console.log(`  当前 PID: ${pidBefore}`)
  // 重启用线上 daemon 自己的二进制（不得降级到 repo debug）
  try {
    const live = readlinkSync(`/proc/${pidBefore}/exe`)
    if (live && existsSync(live)) LIVE_BIN = live
  } catch {}
  console.log(`  重启将沿用: ${restartBin()}`)

  // kill 进程
  console.log('  kill -9 进程 ...')
  execSync(`kill -9 ${pidBefore}`)
  
  // 等待连接断开（socket close 事件触发）
  await new Promise(r => setTimeout(r, 200))

  // 发送请求（此时应该排队等待重连）
  const t0 = performance.now()
  const requests = []
  for (let i = 0; i < 3; i++) {
    requests.push(
      pc.extractAll(`function test${i}() {}`, '.js')
        .then(r => ({ success: true }))
        .catch(e => ({ success: false, error: e.message }))
    )
  }

  // 立即重启进程（让请求进入等待状态）
  console.log('  重启进程 ...')
  try { execSync(`rm -f ${SOCKET}`) } catch {}
  startDaemon()

  // 等待所有请求完成
  const results = await Promise.all(requests)
  const elapsed = performance.now() - t0

  console.log(`  所有请求完成，耗时 ${elapsed.toFixed(0)}ms`)

  const successCount = results.filter(r => r.success).length
  
  assert(`请求排队等待重连 (${elapsed.toFixed(0)}ms)`, elapsed > 500 && elapsed < 8000)
  assert(`${successCount}/3 个请求成功`, successCount === 3, `success=${successCount}`)

  await pc.disconnect()

  console.log(`\n═══════════════════════════════════════`)
  console.log(`重连排队测试: ${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(1) })
