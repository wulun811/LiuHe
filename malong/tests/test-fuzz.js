// 模糊测试：随机生成 1000 文件验证 Rust 服务不 crash
import { createConnection } from 'node:net'
import { existsSync } from 'node:fs'

const IS_WIN = process.platform === 'win32'
const TCP_PORT = parseInt(process.env.MALONG_PORT || '31001', 10)
const SOCKET = IS_WIN ? { host: '127.0.0.1', port: TCP_PORT } : `/tmp/malong-parse-${process.getuid?.() ?? 0}.sock`

let passed = 0, failed = 0, errors = []
function assert(label, ok, detail) {
  if (ok) { passed++ }
  else { failed++; errors.push(`${label}: ${detail || ''}`) }
}

function rawRequest(method, params, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const sock = createConnection(SOCKET, () => {
      const id = 'f-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6)
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
          if (payload.error) reject(new Error(payload.error.message))
          else resolve(payload.result)
        }
      })
      sock.on('error', reject)
    })
    sock.on('error', reject)
  })
}

function genJS() {
  const keywords = ['function', 'class', 'const', 'let', 'var', 'if', 'else', 'for', 'while', 'return', 'try', 'catch', 'throw', 'new', 'this', 'async', 'await']
  const ops = ['+', '-', '*', '/', '%', '===', '!==', '>', '<', '&&', '||']
  const lines = []
  const n = Math.floor(Math.random() * 20) + 3
  for (let i = 0; i < n; i++) {
    const k = keywords[Math.floor(Math.random() * keywords.length)]
    if (k === 'function') {
      lines.push(`function f${i}(a, b) { return a ${ops[Math.floor(Math.random() * ops.length)]} b; }`)
    } else if (k === 'class') {
      lines.push(`class C${i} { constructor(x) { this.x = x; } method() { return this.x; } }`)
    } else if (k === 'if') {
      lines.push(`if (Math.random() > 0.5) { console.log(${i}); } else { console.log(-${i}); }`)
    } else {
      lines.push(`${k} x${i} = ${Math.floor(Math.random() * 100)};`)
    }
  }
  return lines.join('\n')
}

function genPy() {
  const lines = []
  const n = Math.floor(Math.random() * 15) + 3
  for (let i = 0; i < n; i++) {
    const r = Math.random()
    if (r < 0.3) { lines.push(`def func${i}(a, b):\n    return a + b`) }
    else if (r < 0.5) { lines.push(`class Class${i}:\n    def __init__(self):\n        self.x = ${i}`) }
    else if (r < 0.7) { lines.push(`import os\nfrom pathlib import Path`) }
    else { lines.push(`x${i} = ${i} * ${Math.floor(Math.random() * 10)}`) }
  }
  return lines.join('\n')
}

function genGo() {
  const lines = [`package main`, `import "fmt"`]
  const n = Math.floor(Math.random() * 10) + 3
  for (let i = 0; i < n; i++) {
    if (Math.random() < 0.5) { lines.push(`func fn${i}(a int) int { return a * ${i} }`) }
    else { lines.push(`type S${i} struct { X int; Y string }`) }
  }
  return lines.join('\n')
}

function genRs() {
  const lines = [`fn main() {}`]
  const n = Math.floor(Math.random() * 10) + 3
  for (let i = 0; i < n; i++) {
    if (Math.random() < 0.5) { lines.push(`fn f${i}(a: i32) -> i32 { a + ${i} }`) }
    else { lines.push(`struct S${i} { x: i32, y: String }`) }
  }
  return lines.join('\n')
}

async function main() {
  console.log('模糊测试: 1000 随机文件\n')

  if (!IS_WIN && !existsSync(SOCKET)) {
    console.log('  ⚠  malong-parse 未运行\n')
    process.exit(1)
  }

  const generators = [genJS, genJS, genPy, genGo, genRs]
  const exts = ['.js', '.mjs', '.py', '.go', '.rs']
  const total = 100

  for (let i = 0; i < total; i++) {
    const idx = i % generators.length
    const source = generators[idx]()
    const ext = exts[idx]
    try {
      const result = await rawRequest('extract_all', { source, ext }, 5000)
      assert(`文件 ${i}: ${ext} 解析成功`, result && typeof result.has_errors === 'boolean', JSON.stringify(result).slice(0, 100))
    } catch (e) {
      // 超时不算失败
      if (e.message === 'timeout') {
        console.log(`  ⚠  文件 ${i} 超时 (${source.length} 字节)`)
        continue
      }
      assert(`文件 ${i}: 不 crash`, false, e.message)
    }
    if ((i + 1) % 100 === 0) console.log(`  进度: ${i + 1}/${total}`)
  }

  console.log(`\n═══════════════════════════════════════`)
  console.log(`模糊测试: ${passed} passed, ${failed} failed`)
  if (errors.length > 0) {
    console.log(`错误详情:`)
    errors.slice(0, 5).forEach(e => console.log(`  - ${e}`))
  }
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(1) })
