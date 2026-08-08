// kill -9 恢复测试（简化版）
import { createConnection } from 'node:net'
import { existsSync, readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const IS_WIN = process.platform === 'win32'
const UID = IS_WIN ? 0 : (process.getuid?.() ?? 0)
const SOCKET = `/tmp/malong-parse-${UID}.sock`
const PID_FILE = `/tmp/malong-parse-${UID}.pid`

// R22-㉓（ubuntu/mac CI 实测）：setsid malong-parse 依赖 PATH——CI 只构建 target/debug 未装 PATH → 新进程没起来。
// 候选链：env 覆盖 → 仓库 debug（CI 构建）→ release → ~/.local/bin → 本地 tmp 习惯路径（同 test-variable-refs 模式）。
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

// stale socket 假绿（CI 实测）：kill -9 后 socket 文件残留，existsSync 立即通过但无人监听。
// 等待条件必须是真连接成功，不能只查文件存在。
const canConnect = () => new Promise((resolve) => {
  const sock = createConnection(SOCKET, () => { sock.destroy(); resolve(true) })
  sock.on('error', () => resolve(false))
  setTimeout(() => { sock.destroy(); resolve(false) }, 3000)
})

let passed = 0, failed = 0
function assert(label, ok, detail) {
  if (ok) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; console.log(`  ✗ ${label}: ${detail || ''}`) }
}

async function main() {
  console.log('kill -9 恢复测试\n')

  if (process.platform === 'win32') {
    console.log('  ⚠  Windows：进程生命周期语义（kill/setsid/pid-file）为 Unix 专用，跳过')
    process.exit(0)
  }

  // 读取当前 PID
  const pidBefore = parseInt(readFileSync(PID_FILE, 'utf-8').trim())
  console.log(`  当前 PID: ${pidBefore}`)

  // kill -9
  console.log('  kill -9 ...')
  execSync(`kill -9 ${pidBefore}`)
  await new Promise(r => setTimeout(r, 1000))

  // 验证进程已死
  try {
    execSync(`kill -0 ${pidBefore} 2>/dev/null`)
    assert('进程已终止', false, 'still alive')
  } catch {
    assert('进程已终止', true)
  }

  // 手动重启进程——用候选链绝对路径，不依赖 PATH
  console.log(`  重启进程 (${BIN}) ...`)
  const t0 = performance.now()
  execSync(`setsid ${BIN} &`, { stdio: 'ignore' })
  
  // 等待 socket 出现且真连接成功（stale socket 文件残留不算——R22-㉓ CI 实测假绿）
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 200))
    if (existsSync(SOCKET) && await canConnect()) break
  }
  const elapsed = performance.now() - t0

  assert(`socket 恢复 < 6s (${elapsed.toFixed(0)}ms)`, elapsed < 6000)

  // 验证新 PID
  const pidAfter = parseInt(readFileSync(PID_FILE, 'utf-8').trim())
  assert(`新进程启动 (PID: ${pidAfter})`, pidAfter !== pidBefore)

  // 验证服务可用
  const ok = await new Promise((resolve) => {
    const sock = createConnection(SOCKET, () => {
      sock.destroy()
      resolve(true)
    })
    sock.on('error', () => resolve(false))
    setTimeout(() => { sock.destroy(); resolve(false) }, 3000)
  })
  assert('服务可连接', ok)

  console.log(`\n═══════════════════════════════════════`)
  console.log(`kill -9 恢复测试: ${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(1) })
