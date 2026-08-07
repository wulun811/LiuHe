// r24：专家意见落地 dogfood 测试
// ① impact_analysis risk_level → 分档 next_step（high 提示 sandbox_validate）
// ② outline-reader next_step 补 file 参数
// ③ write_symbols NO_BASE 报错带 next_action（与 742 行统一）
import { writeFileSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL, fileURLToPath } from 'node:url'

let passed = 0, failed = 0
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`) }
  else { failed++; console.log(`  ✗ FAIL: ${msg}`) }
}

const WS = mkdtempSync(join(tmpdir(), 'r24-'))
mkdirSync(join(WS, 'src'), { recursive: true })
writeFileSync(join(WS, 'src/app.js'), `
export function hot() { return 1 }
export function cold() { return 2 }
export function solo() { return 3 }
export function other7() { cold() }
export function other8() { cold() }
export function other1() { hot() }
export function other2() { hot() }
export function other3() { hot() }
export function other4() { hot() }
export function other5() { hot() }
export function other6() { hot() }
`.trim() + '\n')

// r11：MALONG 必须用 fileURLToPath 解码——旧 `new URL('..', import.meta.url).pathname` 返回 URL 编码
// 路径（中文目录 %E5%85%AD...），imp() 里 pathToFileURL 再编码一次 → ERR_MODULE_NOT_FOUND（双重编码）
const MALONG = fileURLToPath(new URL('..', import.meta.url))
const imp = (p) => import(pathToFileURL(p).href)
const impactHandler = (await imp(join(MALONG, 'tools/tool-impact-analysis/handler.js'))).handle
const outlineHandler = (await imp(join(MALONG, 'tools/tool-outline-reader/handler.js'))).handle
const { writeSymbols } = await imp(join(MALONG, 'write-runtime.js'))

const pc = await imp(join(MALONG, 'parse-client.js'))
await pc.init({ log: () => {} })
await pc.connect()

const { default: codeIndex } = await imp(join(MALONG, 'code-index.js'))
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
  getWorkspaceDir: () => WS,
  log: () => {},
  emit: () => {},
  get: (key, def) => key === 'codeIndex.udsPath' ? join(WS, 'r24.sock') : def,
}
await codeIndex.init(core)
const codeIndexService = services.codeIndex
await codeIndexService.initWorkspace(WS)
await codeIndexService.indexBatch([join(WS, 'src/app.js')], WS)
codeIndexService.resolveCrossFileRefs()

const ctx = { codeIndexService, getWorkspaceDir: () => WS }

// ── 1. impact_analysis risk 分档 next_step ──
console.log('── ① impact_analysis risk_level 分档 next_step ──')

// high：hot 有 6 个 direct caller（modify 阈值 ≥6）
const hi = await impactHandler({ workspace_dir: WS, file: 'src/app.js', symbol: 'hot' }, ctx)
assert(hi.risk_level === 'high', `risk_level=high（得 ${hi.risk_level}）`)
assert(/sandbox_validate/.test(hi.next_step || ''), `high → next_step 提示 sandbox_validate（${hi.next_step}）`)
assert(/6 direct/.test(hi.next_step || ''), `high → next_step 带 caller 计数`)

// low：solo 无 caller
const lo = await impactHandler({ workspace_dir: WS, file: 'src/app.js', symbol: 'solo' }, ctx)
assert(lo.risk_level === 'low', `risk_level=low（得 ${lo.risk_level}）`)
assert(!/sandbox_validate/.test(lo.next_step || ''), `low → next_step 不提示 sandbox_validate`)
assert(/test_bridge/.test(lo.next_step || ''), `low → next_step 保留 test_bridge 指引`)

// medium：delete 时 1 个 caller → medium
const md = await impactHandler({ workspace_dir: WS, file: 'src/app.js', symbol: 'cold', change_type: 'delete' }, ctx)
assert(md.risk_level === 'medium', `delete 1 caller → risk_level=medium（得 ${md.risk_level}）`)
assert(/Medium risk/.test(md.next_step || ''), `medium → next_step 提示 Medium risk`)

// medium：modify 时 2 个 caller → medium（threshold ≥2）
const md2 = await impactHandler({ workspace_dir: WS, file: 'src/app.js', symbol: 'cold' }, ctx)
assert(md2.risk_level === 'medium', `modify 2 caller → risk_level=medium（得 ${md2.risk_level}）`)
assert(/Medium risk/.test(md2.next_step || ''), `medium(modify) → next_step 提示 Medium risk`)

// ── 2. outline-reader next_step 带 file ──
console.log('── ② outline-reader next_step 带 file 参数 ──')
const o = await outlineHandler({ workspace_dir: WS, file: 'src/app.js', depth: 1 }, ctx)
assert(!o.error, `outline-reader 成功（${o.error || 'ok'}）`)
const next = o.next_step || ''
assert(/impact_analysis\(file="src\/app\.js"/.test(next), `next_step 带 file 参数（${next}）`)
assert(/symbol="hot"/.test(next), `next_step 带 symbol（${next}）`)

// ── 3. write_symbols NO_BASE 报错带 next_action ──
console.log('── ③ write_symbols NO_BASE 带 next_action ──')
const wsRes = await writeSymbols({
  workspace_dir: WS,
  writes: [{ file_path: 'src/app.js', locator: { name: 'cold' }, content: 'export function cold() { return 99 }' }],
}, ctx)
const noBaseErr = wsRes.failed || wsRes.results?.find?.(r => r.error) || wsRes
assert(noBaseErr.error?.code === 'VERSION_CONFLICT' || wsRes.success === false, `NO_BASE 冲突返回（${noBaseErr.error?.code || '?'}）`)
assert(noBaseErr.error?.next_action?.tool === 'read_symbol', `NO_BASE 报错带 next_action.read_symbol（${JSON.stringify(noBaseErr.error?.next_action) || 'missing'}）`)
assert(noBaseErr.error?.next_action?.params?.locator?.file_path === 'src/app.js', `next_action 带 locator.file_path`)

// 有 base_version 时正常写入（回归：不破坏正常路径）
const v = await (await imp(join(MALONG, 'tools/tool-read-symbol/handler.js'))).handle({ workspace_dir: WS, locator: { name: 'cold', file_path: 'src/app.js' } }, ctx)
assert(v.version && v.version.symbol, `read_symbol 拿到 version（${v.version?.symbol?.body_hash ? '有 hash' : '?'}）`)
const okRes = await writeSymbols({
  workspace_dir: WS,
  writes: [{ file_path: 'src/app.js', locator: { name: 'cold' }, content: 'export function cold() { return 99 }', base_version: v.version }],
}, ctx)
assert(okRes.success !== false, `带 base_version 正常写入（${okRes.success === true ? 'ok' : JSON.stringify(okRes.failed || okRes).slice(0, 120)}）`)

rmSync(WS, { recursive: true, force: true })

console.log(`\n== test-dogfood-r24: ${passed} passed, ${failed} failed ==`)
process.exit(failed > 0 ? 1 : 0)
