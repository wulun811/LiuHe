// test-embedded.js — P6 embedded reader（§7 读侧去壳）
// 验证：图查询纯 SQLite + 正文快路径 + INDEX_STALE 诚实 + 路径安全；不 import parse-client
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const imp = (p) => import(pathToFileURL(p).href)
const MALONG_DIR = join(__dirname, '..')
const TOOLS_DIR = join(MALONG_DIR, 'tools')

let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}

const WS = '/tmp/opencode/embedded-ws'
const DATA = '/tmp/opencode/embedded-data'
const SOCK = '/tmp/opencode/embedded.sock'

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

def helper(x):
    return x + 1
`)
writeFileSync(`${WS}/src/main.py`, `from service import Service

def run():
    svc = Service()
    return svc.increment()

def invoke():
    return helper(42)
`)

// ── 用完整 code-index 建索引（含 refs） ──
const pc = await imp(join(MALONG_DIR, 'parse-client.js'))
await pc.init({ log: () => {} })
await pc.connect()
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
svc.initWorkspace(WS)
await svc.indexBatch([`${WS}/src/service.py`, `${WS}/src/main.py`], WS)
svc.resolveCrossFileRefs()

// ── embedded reader：独立进程语义（新实例，只读 db） ──
const { EmbeddedReader } = await imp(join(MALONG_DIR, 'embedded-reader.js'))
const dbPath = join(DATA, 'code-index.db')
const reader = new EmbeddedReader(dbPath, WS)

console.log('── 图查询 ──')
const found = reader.findSymbols('increment')
assert(found.length === 1 && found[0].file_path === 'src/service.py', `findSymbols 命中（得 ${JSON.stringify(found.map(f => f.file_path))}）`)
const svcSym = reader.getSymbolByStableId(found[0].stable_id)
assert(!!svcSym, `getSymbolByStableId 命中`)
const callers = reader.getCallers(svcSym.id)
assert(!callers.some(c => c.file === 'src/main.py' && c.caller_func === 'run'), `成员调用 svc.increment() 不跨文件绑（r21 决策，得 ${JSON.stringify(callers.map(c => c.file + ':' + c.caller_func))}）`)
const helperSym = reader.getSymbolByStableId(reader.findSymbols('helper')[0].stable_id)
const bareCallers = reader.getCallers(helperSym.id)
assert(bareCallers.some(c => c.file === 'src/main.py' && c.caller_func === 'invoke'), `裸调用跨文件命中（${JSON.stringify(bareCallers.map(c => c.file + ':' + c.caller_func))}）`)
const runSym = reader.getSymbolByStableId(reader.findSymbols('run')[0].stable_id)
const callees = reader.getCallees(runSym.id)
assert(callees.length >= 1, `getCallees 命中（${callees.length}）`)
const outline = reader.getOutline('src/service.py')
assert(outline.length === 2 && outline[0].name === 'Service' && outline[0].children?.length === 2, `getOutline 嵌套树（${JSON.stringify(outline.map(o => o.name + ':' + (o.children?.length || 0)))}）`)

console.log('── 正文快路径 ──')
const r1 = reader.readSymbol({ file_path: 'src/service.py', symbol_id: found[0].stable_id })
assert(!r1.error && r1.symbol?.text?.includes('self.calls += 1'), `readSymbol 正文快路径（range 切片）`)
assert(r1.version?.file?.hash?.startsWith('sha256:') && r1.version?.symbol?.body_hash, `version 对象返回`)
const r2 = reader.readSymbol({ file_path: 'src/service.py', name: 'increment' })
assert(!r2.error && r2.symbol?.text?.includes('increment'), `name 定位`)
const rAmb = reader.readSymbol({ file_path: 'src/service.py', name: '__init__' })
assert(!rAmb.error, `唯一符号正常读`)
const rRange = reader.readSymbol({ file_path: 'src/main.py', line_range: [1, 3] })
assert(!rRange.error && rRange.symbol?.text?.includes('from service'), `line_range 降级读`)

console.log('── INDEX_STALE 诚实（附录 D：不装对） ──')
writeFileSync(`${WS}/src/service.py`, readFileSync(`${WS}/src/service.py`, 'utf-8') + '\n# external touch\n')
console.log('  touch done, status:', JSON.stringify(reader.getFileStatus('src/service.py')))
const rStale = reader.readSymbol({ file_path: 'src/service.py', symbol_id: found[0].stable_id })
console.log('  readSymbol result:', JSON.stringify({ error: rStale.error, status: rStale.index_status, hasText: !!rStale.symbol?.text }))
console.log('  debug status:', JSON.stringify(reader.getFileStatus('src/service.py')))
assert(rStale.error === 'INDEX_STALE', `mtime 变 → INDEX_STALE（得 ${rStale.error} ${JSON.stringify(rStale.index_status)}）`)
const rStale2 = reader.readSymbol({ file_path: 'src/not_indexed.py' })
assert(rStale2.error === 'INDEX_STALE', `未索引 → INDEX_STALE`)

console.log('── 路径安全 ──')
const rEsc = reader.readSymbol({ file_path: '../../etc/passwd' })
assert(rEsc.error === 'PATH_BLOCKED', `../../ 穿越 → PATH_BLOCKED（得 ${rEsc.error}）`)

console.log('── 无 parse 依赖 ──')
const src = readFileSync(join(MALONG_DIR, 'embedded-reader.js'), 'utf-8')
const importLines = src.split('\n').filter(l => l.trim().startsWith('import '))
assert(importLines.some(l => l.includes('better-sqlite3')) && !importLines.some(l => l.includes('parse-client')), `纯 SQLite 依赖，无 parse-client`)
assert(src.includes('readonly'), `readonly 打开 db`)

reader.close()
console.log(`\n=== test-embedded: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
