// test-parse-disconnect.js — live 审查 K3：disconnect 取消在途 connect（不复活僵尸连接）
// 假守护：accept 后永不响应；connect() 在途时立即 disconnect → 返回 false 且不置 connected。
import { createServer } from 'node:net'
import { rmSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import os from 'node:os'

// macOS CI 干净环境无 /tmp/opencode，且 macOS 对不存在父目录 bind 报 EACCES（非 ENOENT）
const SOCK = join(os.tmpdir(), 'opencode', 'parse-disc-fake.sock')
const IS_WIN = process.platform === 'win32'
if (!IS_WIN) {
  try { mkdirSync(dirname(SOCK), { recursive: true }) } catch {}
  try { rmSync(SOCK, { force: true }) } catch {}
  try { rmSync(`${SOCK}.token`, { force: true }) } catch {}
  process.env.MALONG_SOCKET = SOCK // 必须在 import parse-client 前设置（模块加载期读 env）
}

let pass = 0, fail = 0
const assert = (c, m) => { if (c) pass++; else { fail++; console.error('  FAIL:', m) } }

const server = createServer((sock) => {
  sock.on('error', () => {})
})
// Windows（第三轮复验 EACCES 修复）：parse-client 无 UDS，走 TCP 127.0.0.1:MALONG_PORT（模块加载期读 env）
// ——先 listen(0) 取实际端口、设 env、再 import，避免与真实 daemon 31001 冲突
if (IS_WIN) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  process.env.MALONG_PORT = String(server.address().port)
} else {
  await new Promise((r) => server.listen(SOCK, r))
}

const pc = await import(new URL('../parse-client.js', import.meta.url).href)
await pc.init({ log: () => {} })

const p = pc.connect()
await pc.disconnect() // 在途取消
const ok = await p
assert(ok === false, `disconnect 后在途 connect 返回 false（得 ${ok}）`)
assert(!/connected=yes/.test(pc.describeConfig()), `不复活僵尸连接（得 ${pc.describeConfig()}）`)
await new Promise((r) => setTimeout(r, 200))
assert(!/connected=yes/.test(pc.describeConfig()), '200ms 后仍未连接（迟到 connect 回调不得复活）')

server.close()
console.log(`== test-parse-disconnect: ${pass} passed, ${fail} failed ==`)
process.exit(fail > 0 ? 1 : 0)
