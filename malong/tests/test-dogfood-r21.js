// r21：_resolveCrossFileRefs 只绑裸调用——成员调用（obj.slice()/byFile.get()）不跨文件绑同名符号
// + r22：裸调用跨文件同名绑定且无 import 边 → 标 ambiguous
// 场景：app.js 调 helper.run()（成员），other.js 有裸函数 run()——成员调用不得绑到它
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { createDb } from '../db-adapter.js'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const imp = (p) => import(pathToFileURL(p).href)
const MALONG_DIR = join(__dirname, '..')
const WS = join(tmpdir(), 'opencode', 'r21-ws')
const DATA = join(tmpdir(), 'opencode', 'r21-data')
const SOCK = join(tmpdir(), 'opencode', 'r21-code-index.sock')

try { rmSync(WS, { recursive: true, force: true }) } catch {}
try { rmSync(DATA, { recursive: true, force: true }) } catch {}
for (const d of [WS, DATA]) mkdirSync(d, { recursive: true })

let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`) }
  else { fail++; console.log(`  ✗ ${msg}`) }
}

// ① app.js：成员调用 helper.run + 裸调用 process；② other.js：同名裸函数 run
writeFileSync(`${WS}/app.js`, `const helper = { run: (x) => x * 2 }\nexport function process(data) {\n  return helper.run(data)\n}\nexport function query() {\n  return process(2)\n}\n`)
writeFileSync(`${WS}/other.js`, `export function run() {\n  return 42\n}\n`)

const pc = await imp(join(MALONG_DIR, 'parse-client.js'))
await pc.init({ log: () => {} })
await pc.connect()

const { default: codeIndex } = await imp(join(MALONG_DIR, 'code-index.js'))
const langParser = {
  extractAllAsync: (source, ext, filePath, ws) => pc.extractAll(source, ext, filePath, ws),
  extractReferencesAsync: (source, ext) => pc.extractReferences(source, ext),
  batchExtractAsync: (files, ws) => pc.batchExtract(files, ws),
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
await svc.indexBatch([`${WS}/app.js`, `${WS}/other.js`], WS)
svc.resolveCrossFileRefs()

const db = await createDb(join(DATA, 'code-index.db'), { readonly: true })
const appFile = db.prepare('SELECT id FROM files WHERE path = ?').get('app.js')

// ② 成员调用 run 不得绑定到 other.js 的裸函数 run
const runRefs = db.prepare("SELECT r.target_symbol_id, r.call_expr FROM refs r WHERE r.source_file_id = ? AND r.target_name = 'run'").all(appFile.id)
assert(runRefs.length >= 1, `app.js 有 run 调用 ref（${runRefs.length} 条）`)
for (const r of runRefs) {
  assert(r.target_symbol_id === null, `成员调用 run（call_expr="${r.call_expr}"）不跨文件绑定（得 ${r.target_symbol_id}）`)
}

// ③ 裸调用 process 绑定到自身符号
const processRef = db.prepare("SELECT r.target_symbol_id FROM refs r WHERE r.source_file_id = ? AND r.target_name = 'process'").get(appFile.id)
const processSym = processRef?.target_symbol_id
  ? db.prepare('SELECT name, file_id FROM symbols WHERE id = ?').get(processRef.target_symbol_id)
  : null
assert(processSym && processSym.name === 'process', `裸调用 process 绑到自身（得 ${JSON.stringify(processSym)}）`)

// ④ r22：裸调用跨文件同名但无 import 边 → 标 ambiguous；有 import 边 → 不标
// app3.js 裸调用 foo()（本文件无定义），lib2.js 有裸函数 foo()，app3 未 import 它
writeFileSync(`${WS}/app3.js`, `export function go() {\n  return foo(1)\n}\n`)
writeFileSync(`${WS}/lib2.js`, `export function foo(x) {\n  return x * 2\n}\n`)
await svc.indexBatch([`${WS}/app3.js`, `${WS}/lib2.js`], WS)
svc.resolveCrossFileRefs()

const goImpact = await svc.getImpactAnalysis('app3.js', { symbol: 'go' })
const fooCallee = (goImpact.callees || []).find(c => c.function === 'foo')
assert(fooCallee, `getImpactAnalysis(go) 含 foo 调用（得 ${JSON.stringify((goImpact.callees || []).map(c => c.function))}）`)
assert(fooCallee.ambiguous === true, `app3 未 import foo 却跨文件同名绑定 → ambiguous=true（得 ${fooCallee.ambiguous}, callee_file=${fooCallee.callee_file}）`)

// ⑤ r22：有 import 边的裸调用不标 ambiguous
// app4.js import { bar } from './lib3.js' 后裸调用 bar()
writeFileSync(`${WS}/lib3.js`, `export function bar(x) {\n  return x + 1\n}\n`)
writeFileSync(`${WS}/app4.js`, `import { bar } from './lib3.js'\nexport function useBar() {\n  return bar(1)\n}\n`)
await svc.indexBatch([`${WS}/lib3.js`, `${WS}/app4.js`], WS)
svc.resolveCrossFileRefs()

const useBarImpact = await svc.getImpactAnalysis('app4.js', { symbol: 'useBar' })
const barCallee = (useBarImpact.callees || []).find(c => c.function === 'bar')
assert(barCallee, `getImpactAnalysis(useBar) 含 bar 调用（得 ${JSON.stringify((useBarImpact.callees || []).map(c => c.function))}）`)
assert(barCallee.ambiguous === false, `app4 import 了 bar → ambiguous=false（得 ${barCallee.ambiguous}, callee_file=${barCallee.callee_file}）`)

// ⑥ dogfood-r5（DSH 反馈 2026-10-13）：分片解析须让出事件循环——防大仓 reindex 的 resolve 段
// 同步阻塞（实测 ~110s 冻结事件循环）→ parse-client 心跳停发 → daemon 断链 → write EPIPE。
// 构造「未定义符号」裸调用（永不 resolve，稳定留在 unbound 集），yieldEvery=1 强制每片让出。
writeFileSync(WS + '/yc.js', 'export function g() { return zzUndef1(1) + zzUndef2(2) + zzUndef3(3) }')
await svc.indexBatch([WS + '/yc.js'], WS)
let _yielded = false
setImmediate(() => { _yielded = true })
await codeIndex._resolveCrossFileRefs({ yieldEvery: 1 })
assert(_yielded, '分片解析期间 setImmediate 让出事件循环（yieldEvery=1，防同步长阻塞 → EPIPE）')

db.close()
await pc.close?.()

console.log(`\n== test-dogfood-r21: ${pass} passed, ${fail} failed ==`)
try { rmSync(WS, { recursive: true, force: true }) } catch {}
try { rmSync(DATA, { recursive: true, force: true }) } catch {}
process.exit(fail > 0 ? 1 : 0)
