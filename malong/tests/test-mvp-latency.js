// test-mvp-latency.js — 附录 F 体验指标：小文件 read P95 <80ms / write P95 <150ms
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const imp = (p) => import(pathToFileURL(p).href)
const MALONG_DIR = join(__dirname, '..')
const TOOLS_DIR = join(MALONG_DIR, 'tools')

let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}

const WS = join(tmpdir(), 'opencode', 'mvp-lat-ws')
const DATA = join(tmpdir(), 'opencode', 'mvp-lat-data')
const SOCK = join(tmpdir(), 'opencode', 'mvp-lat.sock')

rmSync(WS, { recursive: true, force: true })
rmSync(DATA, { recursive: true, force: true })
mkdirSync(`${WS}/src`, { recursive: true })
mkdirSync(DATA, { recursive: true })

const src = []
src.push('class Service:')
src.push('    def __init__(self):')
src.push('        self.calls = 0')
for (let i = 0; i < 30; i++) {
  src.push(`    def op${i}(self, x):`)
  src.push(`        self.calls += ${i}`)
  src.push(`        return x + ${i}`)
}
writeFileSync(`${WS}/src/service.py`, src.join('\n') + '\n')

const pc = await imp(join(MALONG_DIR, 'parse-client.js'))
await pc.init({ log: () => {} })
const connected = await pc.connect()
assert(connected, 'parse-client 连接')

const { default: codeIndex } = await imp(join(MALONG_DIR, 'code-index.js'))
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
await svc.initWorkspace(WS)
await svc.indexBatch([`${WS}/src/service.py`], WS)
svc.resolveCrossFileRefs()

const { writeSymbol } = await imp(join(MALONG_DIR, 'write-runtime.js'))
const wctx = { codeIndexService: svc, getWorkspaceDir: () => DATA, langParserService: langParser }
const readHandler = (await imp(join(TOOLS_DIR, 'tool-read-symbol', 'handler.js'))).handle
const rctx = { codeIndexService: svc, getWorkspaceDir: () => DATA }

function p95(arr) {
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]
}

// ── read P95（预热 3 次后 50 次） ──
console.log('── read P95 ──')
const sym0 = svc.findSymbolsInFile('src/service.py', 'op15')[0]
for (let i = 0; i < 3; i++) await readHandler({ workspace_dir: WS, locator: { symbol_id: sym0.stable_id } }, rctx)
const readMs = []
for (let i = 0; i < 50; i++) {
  const t = Date.now()
  await readHandler({ workspace_dir: WS, locator: { symbol_id: sym0.stable_id } }, rctx)
  readMs.push(Date.now() - t)
}
const readP95 = p95(readMs)
const readMean = (readMs.reduce((a, b) => a + b, 0) / readMs.length).toFixed(1)
console.log(`  read: P95=${readP95}ms mean=${readMean}ms n=50`)
assert(readP95 < 80, `read P95 < 80ms（实际 ${readP95}ms，mean ${readMean}ms）`)

// ── write P95（30 个不同符号顺序写，含写后同步重抽） ──
console.log('── write P95 ──')
let base = (await readHandler({ workspace_dir: WS, locator: { file_path: 'src/service.py' } }, rctx)).version
const writeMs = []
for (let i = 0; i < 30; i++) {
  const sym = svc.findSymbolsInFile('src/service.py', `op${i}`)[0]
  const t = Date.now()
  const r = await writeSymbol({
    workspace_dir: WS, locator: { symbol_id: sym.stable_id }, base_version: base,
    content: `    def op${i}(self, x):\n        self.calls += ${i}\n        return x + ${i} + 1\n`,
  }, wctx)
  if (r.success) {
    writeMs.push(Date.now() - t)
    base = r.new_version
  } else if (i < 3) {
    console.log(`op${i} fail:`, r.error?.code, r.error?.conflict_type, r.error?.message?.slice(0, 120))
  }
}
assert(writeMs.length === 30, `30 次小文件写全部成功（${writeMs.length}/30）`)
const writeP95 = p95(writeMs)
const writeMean = (writeMs.reduce((a, b) => a + b, 0) / writeMs.length).toFixed(1)
console.log(`  write: P95=${writeP95}ms mean=${writeMean}ms n=30（含写后同步重抽）`)
assert(writeP95 < 150, `write P95 < 150ms（实际 ${writeP95}ms，mean ${writeMean}ms）`)

console.log(`\n=== test-mvp-latency: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
