// test-impact-cache.js — R1（P0）getImpactAnalysis 缓存投毒回归
// 三条返回路径均返回结构快照：命中（_fromCache=true shallow copy）、
// file_arg 错误（errRes copy）、miss（result copy）。handler 层 attachStalenessWarning
// 原地改写返回对象 → 不得污染驻留缓存。
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

const WS = join(tmpdir(), 'opencode', 'ob-impact-cache')
const SOCK = join(tmpdir(), 'opencode', 'ob-impact-cache.sock')
rmSync(WS, { recursive: true, force: true })
mkdirSync(join(WS, 'src'), { recursive: true })
writeFileSync(join(WS, 'src/app.js'), [
  'export function target() { return 1 }',
  'export function c1() { target() }',
  'export function c2() { target() }',
  'export function c3() { target() }',
].join('\n') + '\n')

const pc = await imp(join(__dirname, '..', 'parse-client.js'))
await pc.init({ log: () => {} })
try { await pc.connect() } catch {}
const { default: codeIndex } = await imp(join(__dirname, '..', 'code-index.js'))
const langParser = {
  extractAllAsync: (s, e, f) => pc.extractAll(s, e, f),
  hasErrorsAsync: (s, e, f) => pc.hasErrors(s, e, f),
  batchExtractAsync: (f) => pc.batchExtract(f),
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

// ① miss 路径返回快照：改写不服驻留缓存
{
  const r1 = await svc.getImpactAnalysis('src/app.js', { symbol: 'target' })
  assert(r1.callers.length === 3, `miss 3 callers（得 ${r1.callers.length}）`)
  r1.warning = 'POISON-miss'
  r1.callers.push({ fake: true })
  const r2 = await svc.getImpactAnalysis('src/app.js', { symbol: 'target' })
  assert(r2.warning === undefined, `改写 warning 不污染驻留缓存`)
  assert(r2.callers.length === 4, `浅拷贝假设：数组共享（handler 层不改数组，若未来改需升级 structuredClone）`)
  assert(r2._fromCache === true, `命中路径 _fromCache=true`)
}

// ② 命中路径返回快照：第二次返回值改写不污染第三次
{
  const r3 = await svc.getImpactAnalysis('src/app.js', { symbol: 'target' })
  assert(r3._fromCache === true, `再次命中 _fromCache=true`)
  r3.warning = 'POISON-hit'
  r3.suggestion = 'mutate'
  const r4 = await svc.getImpactAnalysis('src/app.js', { symbol: 'target' })
  assert(r4.warning === undefined && r4.suggestion === undefined, `命中后改写不污染驻留缓存`)
}

// ③ file_arg 错误路径返回快照
{
  const e1 = await svc.getImpactAnalysis('nonexistent.js', { symbol: 'x' })
  assert(e1.file_error !== undefined, `不存在文件返回 file_error`)
  e1.file_error = 'POISON-err'
  const e2 = await svc.getImpactAnalysis('nonexistent.js', { symbol: 'x' })
  assert(typeof e2.file_error === 'object' && e2.file_error !== 'POISON-err', `errRes 改写不污染驻留缓存`)
}

// ④ 不同参数独立缓存（不受污染路径影响）
{
  const a = await svc.getImpactAnalysis('src/app.js', { symbol: 'target', changeType: 'delete' })
  a.risk_level = 'POISON-delete'
  const b = await svc.getImpactAnalysis('src/app.js', { symbol: 'target', changeType: 'modify' })
  assert(b.risk_level !== 'POISON-delete', `不同 cacheKey 互不污染`)
}

rmSync(WS, { recursive: true, force: true })
console.log(`== test-impact-cache: ${pass} passed, ${fail} failed ==`)
process.exit(fail > 0 ? 1 : 0)