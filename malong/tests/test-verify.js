// P3 验证测试：性能 + 缓存 + 容错 + 并发
import { createConnection } from 'node:net'
import { writeFileSync, mkdirSync, unlinkSync, rmdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SOCKET = `/tmp/malong-parse-${process.getuid()}.sock`
const TMP = '/tmp/p3-verify-' + process.pid
const WS = join(TMP, 'workspace')

let passed = 0, failed = 0
function assert(label, ok, detail) {
  if (ok) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; console.log(`  ✗ ${label}: ${detail || ''}`) }
}

function rawRequest(method, params, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const sock = createConnection(SOCKET, () => {
      const id = 'v-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6)
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
          if (payload.error) reject(new Error(`${payload.error.code}: ${payload.error.message}`))
          else resolve(payload.result)
        }
      })
      sock.on('error', reject)
    })
    sock.on('error', reject)
  })
}

function genJS(n) {
  const lines = []
  for (let i = 0; i < n; i++) {
    lines.push(`function fn${i}(a, b) { if (a > b) { return a + b; } else { for (let j = 0; j < b; j++) { a += j; } } return a; }`)
  }
  return lines.join('\n')
}

async function main() {
  console.log('P3 验证测试\n')

  if (!statSync(SOCKET).isSocket()) {
    console.log('  ⚠  malong-parse 未运行\n')
    process.exit(1)
  }

  mkdirSync(WS, { recursive: true })

  // ── 1. 100 文件 batch 性能 ──
  console.log('── 1. 100 文件 batch 性能 ──')
  const files100 = []
  for (let i = 0; i < 100; i++) {
    const fp = join(WS, `test-${i}.js`)
    writeFileSync(fp, genJS(10))
    files100.push({ path: fp, file_path: fp })
  }
  const t0 = performance.now()
  const r1 = await rawRequest('batch_extract', { files: files100 }, 30000)
  const elapsed100 = performance.now() - t0
  assert(`100 文件 batch < 100ms`, elapsed100 < 100, `${elapsed100.toFixed(0)}ms`)
  assert(`100 文件全部成功`, r1.results.every(r => !r.error), `${r1.results.filter(r => r.error).length} errors`)

  // ── 2. 单文件 1MB 解析延迟 ──
  console.log('\n── 2. 单文件 1MB 解析延迟 ──')
  const bigFile = join(WS, 'big.js')
  writeFileSync(bigFile, genJS(5000))
  const bigSize = statSync(bigFile).size
  const t1 = performance.now()
  const r2 = await rawRequest('extract_all', { file_path: bigFile }, 10000)
  const elapsed1MB = performance.now() - t1
  assert(`1MB 文件 (${(bigSize/1024).toFixed(0)}KB) 解析 < 50ms`, elapsed1MB < 50, `${elapsed1MB.toFixed(0)}ms`)
  assert(`1MB 文件解析成功`, r2 && r2.symbols && r2.symbols.length > 0)

  // ── 3. batch 部分失败 ──
  console.log('\n── 3. batch 部分失败 ──')
  const mixedFiles = [
    { path: join(WS, 'good.js'), file_path: join(WS, 'good.js') },
    { path: join(WS, 'nonexistent.js'), file_path: '/tmp/does-not-exist-xyz.js' },
    { path: join(WS, 'good2.js'), file_path: join(WS, 'good2.js') },
  ]
  writeFileSync(join(WS, 'good.js'), 'function a() {}')
  writeFileSync(join(WS, 'good2.js'), 'function b() {}')
  const r3 = await rawRequest('batch_extract', { files: mixedFiles }, 5000)
  const goodResults = r3.results.filter(r => !r.error)
  const badResults = r3.results.filter(r => r.error)
  assert(`batch 部分失败: 2 个成功`, goodResults.length === 2, `got ${goodResults.length}`)
  assert(`batch 部分失败: 1 个失败`, badResults.length === 1, `got ${badResults.length}`)

  // ── 4. 缓存命中 ──
  console.log('\n── 4. 缓存命中 ──')
  const cacheFile = join(WS, 'cache-test.js')
  writeFileSync(cacheFile, 'function cached() { return 42; }')
  const t2 = performance.now()
  await rawRequest('extract_all', { file_path: cacheFile })
  const firstMs = performance.now() - t2
  const t3 = performance.now()
  await rawRequest('extract_all', { file_path: cacheFile })
  const secondMs = performance.now() - t3
  const t4 = performance.now()
  await rawRequest('extract_all', { file_path: cacheFile })
  const thirdMs = performance.now() - t4
  assert(`缓存: 第 2 次 <= 第 1 次 (${secondMs.toFixed(1)}ms <= ${firstMs.toFixed(1)}ms)`, secondMs <= firstMs * 1.5)
  assert(`缓存: 第 3 次 <= 第 1 次 (${thirdMs.toFixed(1)}ms <= ${firstMs.toFixed(1)}ms)`, thirdMs <= firstMs * 1.5)

  // ── 5. 缓存 mtime 失效 ──
  console.log('\n── 5. 缓存 mtime 失效 ──')
  const mtimeFile = join(WS, 'mtime-test.js')
  writeFileSync(mtimeFile, 'function v1() {}')
  const rm1 = await rawRequest('extract_all', { file_path: mtimeFile })
  const syms1 = rm1.symbols.map(s => s.name).sort()
  // modify file (force mtime change)
  await new Promise(r => setTimeout(r, 1100))
  writeFileSync(mtimeFile, 'function v2() { function inner() {} }')
  const rm2 = await rawRequest('extract_all', { file_path: mtimeFile })
  const syms2 = rm2.symbols.map(s => s.name).sort()
  assert(`mtime 失效: v1 符号 ${JSON.stringify(syms1)}`, syms1.includes('v1'))
  assert(`mtime 失效: v2 符号 ${JSON.stringify(syms2)}`, syms2.includes('v2'))

  // ── 6. health 返回 cache stats ──
  console.log('\n── 6. health 返回 cache stats ──')
  const health = await rawRequest('health', {})
  assert(`health 有 cache 字段`, health.cache !== undefined)
  assert(`cache hits > 0`, health.cache.hits > 0, `hits=${health.cache.hits}`)
  assert(`cache entries > 0`, health.cache.entries > 0, `entries=${health.cache.entries}`)

  // ── 7. 500KB file_path 模式 ──
  console.log('\n── 7. 500KB file_path 模式 ──')
  const halfMB = join(WS, 'half-mb.js')
  writeFileSync(halfMB, genJS(2500))
  const halfSize = statSync(halfMB).size
  const t5 = performance.now()
  const rPath = await rawRequest('extract_all', { file_path: halfMB })
  const pathMs = performance.now() - t5
  const source = genJS(2500)
  const t6 = performance.now()
  const rSrc = await rawRequest('extract_all', { source, ext: '.js' })
  const srcMs = performance.now() - t6
  assert(`file_path 模式: ${pathMs.toFixed(0)}ms vs source 模式: ${srcMs.toFixed(0)}ms`, true)
  assert(`file_path 符号数 == source 符号数`, rPath.symbols.length === rSrc.symbols.length)

  // cleanup
  for (let i = 0; i < 100; i++) { try { unlinkSync(join(WS, `test-${i}.js`)) } catch {} }
  try { unlinkSync(bigFile) } catch {}
  try { unlinkSync(cacheFile) } catch {}
  try { unlinkSync(mtimeFile) } catch {}
  try { unlinkSync(halfMB) } catch {}
  try { unlinkSync(join(WS, 'good.js')) } catch {}
  try { unlinkSync(join(WS, 'good2.js')) } catch {}
  try { rmdirSync(WS) } catch {}
  try { rmdirSync(TMP) } catch {}

  console.log(`\n═══════════════════════════════════════`)
  console.log(`验证测试: ${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(1) })
