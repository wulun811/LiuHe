// 重连期间请求排队测试
import { execSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const IS_WIN = process.platform === 'win32'
const UID = IS_WIN ? 0 : (process.getuid?.() ?? 0)
const SOCKET = `/tmp/malong-parse-${UID}.sock`
const PID_FILE = `/tmp/malong-parse-${UID}.pid`

// R22-㉓：候选链绝对路径（同 test-kill-recover/test-variable-refs 模式）——裸 malong-parse 依赖 PATH，
// CI 只构建 target/debug 未装 PATH → setsid 重启起不来。
const BIN_CANDIDATES = [
  process.env.MALONG_PARSE_BIN,
  join(__dirname, '..', '..', 'malong-parse', 'target', 'debug', 'malong-parse'),
  join(__dirname, '..', '..', 'malong-parse', 'target', 'release', 'malong-parse'),
  join(os.homedir(), '.local', 'bin', 'malong-parse'),
  '/tmp/opencode/s3-bin/malong-parse',
].filter(Boolean)
const BIN = BIN_CANDIDATES.find(p => existsSync(p))
if (!BIN) {
  console.error(`  FAIL: malong-parse binary not found (tried: ${BIN_CANDIDATES.join(' | ')})`)
  process.exit(1)
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
    execSync(`setsid ${BIN} &`, { stdio: 'ignore' })
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
    console.log('  ⚠  Windows：进程生命周期语义（kill/setsid/pid-file）为 Unix 专用，跳过')
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
  execSync(`setsid ${BIN} &`, { stdio: 'ignore' })

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
