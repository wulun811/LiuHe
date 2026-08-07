// test-r7-like.js — R7（P1）searchSymbols LIKE 通配符转义回归
// query 含 `_`/`%` 时必须按字面量匹配（对齐 getReferences），不得全表命中。
import { join, dirname } from 'node:path'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0
let fail = 0
function assert(cond, msg) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`) }
  else { fail++; console.log(`  ✗ ${msg}`) }
}
const imp = (p) => import(pathToFileURL(p).href)

const WS = join(tmpdir(), 'opencode', 'ob-r7-like')
const SOCK = join(tmpdir(), 'opencode', 'ob-r7-like.sock')
try { rmSync(WS, { recursive: true, force: true }) } catch {}
mkdirSync(join(WS, 'src'), { recursive: true })
writeFileSync(join(WS, 'src/app.js'), [
  'export function foo_bar() { return 1 }',
  'export function fooXbar() { return 2 }',
  'export function plain_bar() { return 3 }',
  'export function under_score_only() { return 4 }',
].join('\n') + '\n')

const pc = await imp(join(__dirname, '..', 'parse-client.js'))
await pc.init({ log: () => {} })
try { await pc.connect() } catch {}
const { default: codeIndex } = await imp(join(__dirname, '..', 'code-index.js'))
const langParser = {
  extractAllAsync: (s, e, f, ws) => pc.extractAll(s, e, f, ws),
  hasErrorsAsync: (s, e, f, ws) => pc.hasErrors(s, e, f, ws),
  batchExtractAsync: (f, ws) => pc.batchExtract(f, ws),
}
const services = { langParser }
const core = {
  services,
  getService: (n) => services[n],
  registerService: (n, svc) => { services[n] = svc },
  getWorkspaceDir: () => WS,
  log: () => {},
  emit: () => {},
  get: (k, def) => k === 'codeIndex.udsPath' ? SOCK : def,
}
await codeIndex.init(core)
const svc = services.codeIndex
await svc.initWorkspace(WS)
await svc.indexBatch([join(WS, 'src/app.js')], WS)

// ① query='_' 只匹配含字面下划线的符号（不转义则 %_% 全表命中）
const under = (await svc.searchSymbols('_')).map(r => r.name)
assert(under.length === 3, `query=_ 命中 3 个含字面下划线符号（得 ${under.length}：${under.join(',')}），非全表 4`)
assert(under.includes('foo_bar') && under.includes('plain_bar') && under.includes('under_score_only'), `query=_ 精确命中含 _ 符号`)
assert(!under.includes('fooXbar'), `query=_ 不含无下划线符号 fooXbar`)

// ② query='%' 按字面量：无符号名含 % → 0 命中（不转义则全表）
const pct = (await svc.searchSymbols('%')).length
assert(pct === 0, `query=% 字面量 0 命中（得 ${pct}）`)

// ③ 正常子串语义不回归：query='bar' 命中所有含 bar 子串
const bar = (await svc.searchSymbols('bar')).map(r => r.name)
assert(bar.length === 3, `query=bar 命中 3（foo_bar/fooXbar/plain_bar，得 ${bar.length}）`)

// ④ query='foo_' 前缀 + 字面下划线
const fooUnder = (await svc.searchSymbols('foo_')).map(r => r.name)
assert(fooUnder.length === 1 && fooUnder[0] === 'foo_bar', `query=foo_ 只命中 foo_bar（得 ${fooUnder.join(',')}）`)

try { rmSync(WS, { recursive: true, force: true }) } catch {} // Windows: db 句柄占用 EBUSY，best-effort
console.log(`== test-r7-like: ${pass} passed, ${fail} failed ==`)
process.exit(fail > 0 ? 1 : 0)