// test-parse-retry.js — dogfood ③：in-flight 断连（daemon 忙拒/重启）→ 幂等解析请求单次重试
// 假守护：连接#1 收首帧后吐 1 字节再 destroy（非零数据关闭 → 1s 快速重连路径）；连接#2 正常应答。
// 通过 MALONG_SOCKET 隔离，不碰真实 daemon。
import { createServer } from 'node:net'
import { rmSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const IS_WIN = process.platform === 'win32'
// macOS CI 干净环境无 /tmp/opencode，且 macOS 对不存在父目录 bind 报 EACCES（非 ENOENT）
const SOCK = join(os.tmpdir(), 'opencode', 'parse-retry-fake.sock')
if (!IS_WIN) {
  try { mkdirSync(dirname(SOCK), { recursive: true }) } catch {}
  try { rmSync(SOCK, { force: true }) } catch {}
  try { rmSync(`${SOCK}.token`, { force: true }) } catch {}
  process.env.MALONG_SOCKET = SOCK // 必须在 import parse-client 前设置（模块加载期读 env）
}

let pass = 0, fail = 0
const assert = (c, m) => { if (c) pass++; else { fail++; console.error('  FAIL:', m) } }

let connections = 0
const methods = []
const server = createServer((sock) => {
  connections++
  const n = connections
  let buf = Buffer.alloc(0)
  sock.on('error', () => {})
  sock.on('data', (c) => {
    buf = Buffer.concat([buf, c])
    while (buf.length >= 4) {
      const total = buf.readUInt32BE(0)
      if (buf.length < 4 + total) break
      const payload = buf.subarray(4, 4 + total)
      buf = buf.subarray(4 + total)
      let msg = null
      try { msg = JSON.parse(payload.toString()) } catch {
        try { // 双段帧：前 4 字节 header 长度
          const hl = payload.readUInt32BE(0)
          msg = JSON.parse(payload.subarray(4, 4 + hl).toString())
        } catch {}
      }
      if (!msg) { methods.push('unparsed'); continue }
      methods.push(msg.method)
      if (n === 1) {
        sock.write(Buffer.from([0x00])) // 半帧残留 → _receivedAnyData=true（1s 快速重连）
        sock.destroy()
      } else {
        const body = Buffer.from(JSON.stringify({ id: msg.id, result: { intent: 'ok', retried: n } }))
        const head = Buffer.alloc(4)
        head.writeUInt32BE(body.length, 0)
        sock.write(Buffer.concat([head, body]))
      }
    }
  })
})
// Windows（第三轮复验 EACCES 修复）：parse-client 无 UDS，走 TCP 127.0.0.1:MALONG_PORT（模块加载期读 env）
// ——先 listen(0) 取实际端口、设 env、再 import，避免与真实 daemon 31001 冲突
if (IS_WIN) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  process.env.MALONG_PORT = String(server.address().port)
} else {
  await new Promise((r) => server.listen(SOCK, r))
}

const pc = await import(pathToFileURL(join(__dirname, '..', 'parse-client.js')).href)
await pc.init({ log: () => {} })
const ok = await pc.connect()
assert(ok === true, '初始连接建立')

let r = null
let err = null
const t0 = Date.now()
try { r = await pc.classifyMessage('const x = 1') } catch (e) { err = e }
const dt = Date.now() - t0

assert(err === null && r?.retried === 2, `断连后单次重试成功（得 r=${JSON.stringify(r)}, err=${err?.message}）`)
assert(connections >= 2, `发生重连（connections=${connections}）`)
assert(methods.filter(m => m === 'classify_message').length === 2, `classify_message 恰好重发一次（得 ${methods.filter(m => m === 'classify_message').length} 次）`)
assert(dt >= 800 && dt < 6000, `等重连后重试（${dt}ms）`)

await pc.disconnect()
server.close()
try { rmSync(SOCK, { force: true }) } catch {}
console.log(`\n=== test-parse-retry: ${pass} passed, ${fail} failed ===`)
process.exit(fail > 0 ? 1 : 0)
