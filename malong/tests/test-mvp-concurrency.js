// test-mvp-concurrency.js — 附录 F 测试手段①：并发 harness（TOCTOU / 锁 / 死锁）
// 场景：
//   1) 同文件同符号并发写 → 恰好一个成功，另一个 SYMBOL_CHANGED（无静默覆盖）
//   2) 同文件不同符号并发写 → 无数据丢失（第二个 FILE_CHANGED_SYMBOL_STABLE 或串行重试成功）
//   3) 锁超时 → FILE_LOCKED（持锁 >2s）
//   4) 读写 TOCTOU：并发 read+write，读到的永远是完整旧版或完整新版（原子 rename，无撕裂）
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, writeFileSync, readFileSync, rmSync, openSync, closeSync, writeSync, unlinkSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MALONG_DIR = join(__dirname, '..')
const TOOLS_DIR = join(MALONG_DIR, 'tools')

let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}

const WS = '/tmp/opencode/mvp-conc-ws'
const DATA = '/tmp/opencode/mvp-conc-data'
const SOCK = '/tmp/opencode/mvp-conc.sock'

rmSync(WS, { recursive: true, force: true })
rmSync(DATA, { recursive: true, force: true })
mkdirSync(`${WS}/src`, { recursive: true })
mkdirSync(DATA, { recursive: true })

writeFileSync(`${WS}/src/service.py`, `class Service:
    def __init__(self):
        self.calls = 0

    def increment(self):
        self.calls += 1
        return self.calls

    def decrement(self):
        self.calls -= 1
        return self.calls

    def reset(self):
        self.calls = 0

    def peek(self):
        return self.calls
`)

const pc = await import(join(MALONG_DIR, 'parse-client.js'))
await pc.init({ log: () => {} })
const connected = await pc.connect()
assert(connected, 'parse-client 连接 malong-parse')

const { default: codeIndex } = await import(join(MALONG_DIR, 'code-index.js'))
const langParser = {
  extractAllAsync: (source, ext, filePath) => pc.extractAll(source, ext, filePath),
  hasErrorsAsync: (source, ext, filePath) => pc.hasErrors(source, ext, filePath),
  batchExtractAsync: (files) => pc.batchExtract(files),
}
const services = { langParser }
const core = {
  services,
  getService: (n) => services[n],
  registerService: (n, svc) => { services[n] = svc },
  getWorkspaceDir: () => DATA,
  log: () => {},
  emit: () => {},
  get: (key, def) => key === 'codeIndex.udsPath' ? SOCK : (key === 'codeIndex.udsToken' ? '' : def),
}
await codeIndex.init(core)
const svc = services.codeIndex
svc.initWorkspace(WS)
await svc.indexBatch([`${WS}/src/service.py`], WS)
svc.resolveCrossFileRefs()

const { writeSymbol } = await import(join(MALONG_DIR, 'write-runtime.js'))
const { acquireLock } = await import(join(MALONG_DIR, 'write-runtime.js'))
const wctx = { codeIndexService: svc, getWorkspaceDir: () => DATA, langParserService: langParser }
const readHandler = (await import(join(TOOLS_DIR, 'tool-read-symbol', 'handler.js'))).handle
const rctx = { codeIndexService: svc, getWorkspaceDir: () => DATA }

async function currentVersion(filePath) {
  const r = await readHandler({ workspace_dir: WS, locator: { file_path: filePath } }, rctx)
  return r.version
}

// ── 场景 1：同文件同符号并发写 → 恰好一个成功 ──
console.log('── 场景 1: 同符号并发写 ──')
const targetSym = svc.findSymbolsInFile('src/service.py', 'increment')[0]
const v0 = await currentVersion('src/service.py')
const argsA = { workspace_dir: WS, locator: { symbol_id: targetSym.stable_id }, base_version: v0, content: '    def increment(self):\n        self.calls += 2\n        return self.calls\n' }
const argsB = { workspace_dir: WS, locator: { symbol_id: targetSym.stable_id }, base_version: v0, content: '    def increment(self):\n        self.calls += 100\n        return self.calls\n' }
const [ra, rb] = await Promise.all([writeSymbol(argsA, wctx), writeSymbol(argsB, wctx)])
const okA = ra.success === true, okB = rb.success === true
assert(okA !== okB, `同符号并发：恰好一个成功（A=${okA} B=${okB}）`)
assert((okA ? rb : ra).error?.conflict_type === 'SYMBOL_CHANGED', `另一个报 SYMBOL_CHANGED（得 ${(okA ? rb : ra).error?.conflict_type}）`)
const after1 = readFileSync(`${WS}/src/service.py`, 'utf-8')
assert(after1.includes('+= 2') !== after1.includes('+= 100'), `无静默覆盖：文件恰含一个写入（+=2:${after1.includes('+= 2')} +=100:${after1.includes('+= 100')}）`)

// ── 场景 2：同文件不同符号并发写 → 无数据丢失 ──
console.log('── 场景 2: 不同符号并发写 ──')
const decrementSym = svc.findSymbolsInFile('src/service.py', 'decrement')[0]
const v1 = await currentVersion('src/service.py')
const a2 = { workspace_dir: WS, locator: { symbol_id: targetSym.stable_id }, base_version: v1, content: '    def increment(self):\n        return self.calls + 2\n' }
const b2 = { workspace_dir: WS, locator: { symbol_id: decrementSym.stable_id }, base_version: v1, content: '    def decrement(self):\n        return self.calls - 2\n' }
const [ra2, rb2] = await Promise.all([writeSymbol(a2, wctx), writeSymbol(b2, wctx)])
const after2 = readFileSync(`${WS}/src/service.py`, 'utf-8')
assert(ra2.success === true, `写 A 成功（得 ${ra2.error?.code || 'ok'}）`)
if (rb2.success) {
  assert(after2.includes('calls + 2') && after2.includes('calls - 2'), `都成功时两处写入都在`)
} else {
  const code = rb2.error?.conflict_type
  assert(code === 'FILE_CHANGED_SYMBOL_STABLE' || code === 'SYMBOL_CHANGED', `B 冲突时状态合法（得 ${code}）`)
  assert(after2.includes('calls + 2'), `A 的写入保留（无静默丢失）`)
}

// ── 场景 3：锁超时 → FILE_LOCKED ──
console.log('── 场景 3: 锁超时 ──')
const absPath = `${WS}/src/service.py`
const v2 = await currentVersion('src/service.py')
const held = await acquireLock(absPath)
assert(held && !held.locked, '手动持锁成功')
const rLock = await writeSymbol({ workspace_dir: WS, locator: { symbol_id: decrementSym.stable_id }, content: 'x', base_version: v2 }, wctx)
assert(rLock.error?.code === 'FILE_LOCKED', `持锁 2s 内被拒 → FILE_LOCKED（得 ${rLock.error?.code}）`)
held.release()
await new Promise(r => setTimeout(r, 60))
const rUnlock = await writeSymbol({ workspace_dir: WS, locator: { symbol_id: decrementSym.stable_id }, content: '    def decrement(self):\n        return self.calls - 3\n', base_version: v2 }, wctx)
assert(rUnlock.success === true, `释放后恢复可写（得 ${rUnlock.error?.code || 'ok'}）`)

// ── 场景 4：读写 TOCTOU — 原子性 + 大文件降级（附录 E：>1MB 不索引，file-level 版本检测） ──
console.log('── 场景 4: 读写 TOCTOU 原子性 + 大文件降级 ──')
const bigRead = (await import(join(TOOLS_DIR, 'tool-read-symbol', 'handler.js'))).handle
const BIG = `${WS}/src/big.js`
// >1MB 大文件：47k 行注释填充（Rust FILE_TOO_LARGE 拒索引 → 走 patch + file-level 降级）
const filler = '// filler line for size\n'.repeat(47000)
const V0_LINE = 47002
const bigContent = 'const data = [];\n' + filler + 'const v0 = 0; data.push(0);\n' + 'module.exports = data;\n'
writeFileSync(BIG, bigContent)
const bigBytes = readFileSync(BIG).length
assert(bigBytes > 1024 * 1024, `大文件 >1MB（实际 ${(bigBytes / 1024 / 1024).toFixed(2)}MB）`)

let torn = 0, reads = 0, writes = 0, rejected = 0
let vBig = (await bigRead({ workspace_dir: WS, locator: { file_path: 'src/big.js', line_range: [1, 1] } }, rctx)).version
assert(!!vBig?.file?.hash, '大文件 file-level version 可读（无索引降级）')
for (let i = 0; i < 10; i++) {
  const oldLine = `const v0 = ${i}; data.push(${i});`
  const newLine = `const v0 = ${i + 1}; data.push(${i + 1});`
  const [wr, rr] = await Promise.all([
    writeSymbol({ workspace_dir: WS, locator: { file_path: 'src/big.js' }, edit_mode: 'patch', patch: { old_string: oldLine, new_string: newLine }, base_version: vBig }, wctx).catch(() => ({ success: false })),
    bigRead({ workspace_dir: WS, locator: { file_path: 'src/big.js', line_range: [V0_LINE, V0_LINE] } }, rctx).catch(() => ({ symbol: { text: 'ERR' } })),
  ])
  if (wr.success) { writes++; vBig = wr.new_version }
  else rejected++
  const txt = rr.symbol?.text || ''
  reads++
  const complete = txt.trim() === newLine.trim() || /const v0 = \d+; data.push\(\d+\);/.test(txt)
  if (!complete) torn++
}
assert(torn === 0, `10 轮并发读无撕裂（torn=${torn} reads=${reads} writes=${writes}）`)
assert(writes > 0, `大文件 patch 写可进行（writes=${writes} rejected=${rejected}）`)

// ② 大文件中间改必报冲突（file-level 版本检测，附录 E）
const extEdit = readFileSync(BIG, 'utf-8').replace('module.exports = data;', 'module.exports = data; // external edit')
writeFileSync(BIG, extEdit)
const lastLine = readFileSync(BIG, 'utf-8').split('\n').find(l => l.startsWith('const v0 ='))
const rConflict = await writeSymbol({ workspace_dir: WS, locator: { file_path: 'src/big.js' }, edit_mode: 'patch', patch: { old_string: lastLine, new_string: 'const v0 = 99; data.push(99);' }, base_version: vBig }, wctx)
assert(rConflict.success === false && (rConflict.error?.conflict_type === 'FILE_CHANGED' || rConflict.error?.conflict_type === 'SYMBOL_CHANGED'), `大文件中间改必报冲突（success=${rConflict.success} code=${rConflict.error?.code} type=${rConflict.error?.conflict_type} lastLine=${JSON.stringify(lastLine)} vBig=${vBig?.file?.hash?.slice(0, 20)}）`)
await new Promise(r => setTimeout(r, 1500))

// ── 死锁检测：N 个并发写互不相同文件 ──
console.log('── 场景 5: 多文件并发写无死锁 ──')
const fileArgs = []
const genPaths = []
for (let i = 0; i < 8; i++) {
  const f = `src/gen${i}.py`
  writeFileSync(`${WS}/${f}`, `def fn${i}(x):\n    return x + ${i}\n`)
  genPaths.push(`${WS}/${f}`)
}
await svc.indexBatch(genPaths, WS)
svc.resolveCrossFileRefs()
for (let i = 0; i < 8; i++) {
  const f = `src/gen${i}.py`
  const s = svc.findSymbolsInFile(f, `fn${i}`)[0]
  const v = await currentVersion(f)
  fileArgs.push({ workspace_dir: WS, locator: { symbol_id: s.stable_id }, base_version: v, content: `def fn${i}(x):\n    return x + ${i + 100}\n` })
}
const t0 = Date.now()
const results = await Promise.all(fileArgs.map(a => writeSymbol(a, wctx)))
const elapsed = Date.now() - t0
const okCount = results.filter(r => r.success).length
const failCodes = [...new Set(results.filter(r => !r.success).map(r => r.error?.code || r.error?.conflict_type))]
const failMsgs = [...new Set(results.filter(r => !r.success).map(r => r.error?.message))]
assert(okCount === 8, `8 文件并发写全部成功（${okCount}/8, ${elapsed}ms，无死锁，失败: ${JSON.stringify(failCodes)} msgs=${JSON.stringify(failMsgs)}）`)

console.log(`\n=== test-mvp-concurrency: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
