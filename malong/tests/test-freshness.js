// test-freshness.js — R19 staleness 下沉服务层回归
// 查询出口（getSymbols/getImpactAnalysis/getCallers 等）在文件修改后自动重抽：
// ① 修改文件 → 查询 → 读到新符号 + getFileMtime 更新（服务层保鲜）
// ② 守卫：../ 路径经内部调用链不触发自动索引（guarded）
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

const WS = join(tmpdir(), 'opencode', 'ob-fresh')
const SOCK = join(tmpdir(), 'opencode', 'ob-fresh.sock')
try { rmSync(WS, { recursive: true, force: true }) } catch {}
mkdirSync(join(WS, 'src'), { recursive: true })
const APP = join(WS, 'src', 'app.js')
writeFileSync(APP, 'export function alpha() { return 1 }\n')

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
await svc.indexBatch([APP], WS)

// ① 修改文件后查询 → 自动重抽（getSymbols 读到新符号）
{
  writeFileSync(APP, 'export function alpha() { return 1 }\nexport function beta() { return 2 }\n')
  const syms = await svc.getSymbols('src/app.js')
  const names = syms.map(s => s.name)
  assert(names.includes('beta'), `getSymbols 自动保鲜读到新增符号 beta（得 ${names.join(',')}）`)
  const mtime = svc.getFileMtime('src/app.js')
  assert(mtime > 0, `getFileMtime 已更新（${mtime}）`)
}

// ② getCallers 接线（filePath 形态）
{
  writeFileSync(APP, 'export function alpha() { return 1 }\nexport function beta() { return 2 }\nexport function gamma() { beta() }\n')
  const callers = await svc.getCallers('beta', { filePath: 'src/app.js' })
  assert(Array.isArray(callers), `getCallers 接线后正常返回`)
  const f = await svc.getCallers('beta')
  assert(Array.isArray(f), `getCallers 无 filePath 全库分支不受影响`)
}

// ③ 守卫：../ 路径不触发自动索引（guarded）
{
  const r = await svc.ensureFreshFile('../etc/passwd')
  assert(r.guarded === true, `ensureFreshFile ../ 返回 guarded（不索引）`)
  const abs = await svc.ensureFreshFile(APP)
  assert(abs.auto_indexed === false || abs.auto_indexed === true, `ensureFreshFile 正常路径返回 auto_indexed 布尔`)
}

// ④ getImpactAnalysis 接线（缓存投毒不回归）
{
  const ia = await svc.getImpactAnalysis('src/app.js', { symbol: 'beta' })
  assert(Array.isArray(ia.callers), `getImpactAnalysis 接线后正常（callers=${ia.callers.length}）`)
}

// ④b R19-②：服务层查询出口附加 freshness（对象出口挂字段、数组出口挂属性）——handler 透出链的输入源
{
  writeFileSync(APP, 'export function alpha() { return 1 }\nexport function beta() { return 2 }\nexport function gamma() { beta() }\nexport function delta() { return 4 }\n')
  const syms = await svc.getSymbols('src/app.js')
  assert(syms.freshness?.auto_indexed === true, `④b getSymbols 数组出口挂 freshness 属性（${JSON.stringify(syms.freshness)}）`)
  const refs = await svc.getReferences('beta', 'src/app.js')
  assert(refs.freshness === undefined, `④b 重抽后 getReferences 幂等不挂 freshness（${JSON.stringify(refs.freshness)}）`)
  const ia = await svc.getImpactAnalysis('src/app.js', { symbol: 'beta' })
  assert(Array.isArray(ia.callers), `④b getImpactAnalysis 接线后正常`)
  assert(ia.freshness === undefined, `④b 无重抽时不挂 freshness（幂等）`)
}

// ⑤ getFileOutline 接线
{
  const outline = await svc.getFileOutline('src/app.js')
  assert(outline && Array.isArray(outline.outline) && outline.outline.length >= 1, `getFileOutline 接线后正常（outline=${outline?.outline?.length}）`)
}

try { rmSync(WS, { recursive: true, force: true }) } catch {}
console.log(`== test-freshness: ${pass} passed, ${fail} failed ==`)
process.exit(fail > 0 ? 1 : 0)