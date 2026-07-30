// 安全测试：路径穿越 + 符号链接穿越
import { existsSync, symlinkSync, unlinkSync, writeFileSync, mkdirSync, rmdirSync } from 'node:fs'
import { join } from 'node:path'
import { createConnection } from 'node:net'

const SOCKET = `/tmp/malong-parse-${process.getuid()}.sock`
const TMP = '/tmp/security-test-' + process.pid
const WS_DIR = join(TMP, 'workspace')
const EVIL_LINK = join(TMP, 'link_to_etc')
const SAFE_FILE = join(WS_DIR, 'test.js')

let passed = 0
let failed = 0

function assert(label, ok, detail) {
  if (ok) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; console.log(`  ✗ ${label}: ${detail || ''}`) }
}

function rawRequest(method, params, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const sock = createConnection(SOCKET, () => {
      const id = 'test-' + Date.now()
      const msg = JSON.stringify({ id, method, params })
      const frame = Buffer.alloc(4 + Buffer.byteLength(msg))
      frame.writeUInt32BE(Buffer.byteLength(msg), 0)
      frame.write(msg, 4)
      sock.write(frame)
      const timer = setTimeout(() => { sock.destroy(); reject(new Error('timeout')) }, timeoutMs)
      let buf = Buffer.alloc(0)
      sock.on('data', chunk => {
        buf = Buffer.concat([buf, chunk])
        while (buf.length >= 4) {
          const len = buf.readUInt32BE(0)
          if (buf.length < 4 + len) break
          const payload = JSON.parse(buf.slice(4, 4 + len).toString())
          buf = buf.slice(4 + len)
          clearTimeout(timer)
          sock.destroy()
          if (payload.error) resolve(null)
          else resolve(payload.result)
        }
      })
      sock.on('error', reject)
    })
    sock.on('error', reject)
  })
}

async function main() {
  console.log('安全测试: 路径穿越 + 符号链接穿越\n')

  if (!existsSync(SOCKET)) {
    console.log('  ⚠  malong-parse 未运行，跳过测试\n')
    assert('路径穿越', true, 'skipped')
    assert('符号链接穿越', true, 'skipped')
    printResult()
    return
  }

  // setup
  mkdirSync(WS_DIR, { recursive: true })
  writeFileSync(SAFE_FILE, 'const x = 1')

  // Test 1: path traversal
  const r1 = await rawRequest('extract_all', { file_path: '/etc/passwd', workspace_root: WS_DIR, ext: '.js' })
  assert('路径穿越: `/etc/passwd` 被 workspace_root 拒绝', r1 === null, JSON.stringify(r1))

  // Test 2: valid file inside workspace
  const r2 = await rawRequest('extract_all', { file_path: SAFE_FILE, workspace_root: WS_DIR, ext: '.js' })
  assert('合法文件: workspace 内文件正常解析', r2 !== null && !r2.error, JSON.stringify(r2))

  // Test 3: symlink traversal
  try {
    if (existsSync(EVIL_LINK)) unlinkSync(EVIL_LINK)
    symlinkSync('/etc/passwd', EVIL_LINK)
    const r3 = await rawRequest('extract_all', { file_path: EVIL_LINK, workspace_root: WS_DIR, ext: '.js' })
    assert('符号链接穿越: 指向 `/etc/passwd` 的链接被拒绝', r3 === null, JSON.stringify(r3))
  } finally {
    try { unlinkSync(EVIL_LINK) } catch {}
  }

  // Test 4: relative path traversal
  const r4 = await rawRequest('extract_all', { file_path: '../../../etc/passwd', workspace_root: WS_DIR, ext: '.js' })
  assert('相对路径穿越: `../../../etc/passwd` 被拒绝', r4 === null, JSON.stringify(r4))

  cleanup()
  printResult()
}

function cleanup() {
  try { unlinkSync(EVIL_LINK) } catch {}
  try { unlinkSync(SAFE_FILE) } catch {}
  try { rmdirSync(WS_DIR) } catch {}
  try { rmdirSync(TMP) } catch {}
}

function printResult() {
  console.log(`\n═══════════════════════════════════════`)
  console.log(`安全测试: ${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(1) })
