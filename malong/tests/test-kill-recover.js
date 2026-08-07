// kill -9 恢复测试（简化版）
import { createConnection } from 'node:net'
import { existsSync, readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

const IS_WIN = process.platform === 'win32'
const UID = IS_WIN ? 0 : (process.getuid?.() ?? 0)
const SOCKET = `/tmp/malong-parse-${UID}.sock`
const PID_FILE = `/tmp/malong-parse-${UID}.pid`

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

  // 手动重启进程
  console.log('  重启进程 ...')
  const t0 = performance.now()
  execSync(`setsid ${process.env.MALONG_PARSE_BIN || 'malong-parse'} &`, { stdio: 'ignore' })
  
  // 等待 socket 出现
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 200))
    if (existsSync(SOCKET)) break
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
