// test-inspect.js — inspect 独立测试（R22-⑪：报告 P2 无独立测试）
// mock codeIndexService 覆盖：正常聚合 / 部分失败透传 / initWorkspace 抛错透出 /
// resolveFileArg 拦截 / include_* 开关 / 全关错误 / 空引用 fuzzy 建议
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MALONG = dirname(__dirname)
const imp = (p) => import(pathToFileURL(p).href)

let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++; console.log(`  \u2713 ${msg}`) } else { fail++; console.error(`  \u2717 FAIL: ${msg}`) }
}

const WS = join(os.tmpdir(), 'opencode', `inspect-test-${process.pid}`)
const DATA = join(os.tmpdir(), 'opencode', `inspect-data-${process.pid}`)
try { rmSync(WS, { recursive: true, force: true }) } catch {}
try { rmSync(DATA, { recursive: true, force: true }) } catch {}
mkdirSync(WS, { recursive: true })
mkdirSync(DATA, { recursive: true })
writeFileSync(join(DATA, 'code-index.db'), '')

const mkService = (overrides = {}) => ({
  resolveFileArg: (f) => ({ ok: true, path: f }),
  initWorkspace: async () => {},
  getSymbols: async () => [{ name: 'hello', type: 'function', start_line: 1, end_line: 3 }],
  getReferences: async () => [{ file: 'a.js', line: 5, kind: 'call' }],
  getCallers: async () => [{ caller_file: 'a.js' }],
  getCallees: async () => [{ target_name: 'x' }],
  searchSymbols: async () => [{ name: 'hello2', file: 'a.js', type: 'function' }],
  ...overrides,
})
const ctx = { codeIndexService: null, getWorkspaceDir: () => DATA }

console.log('\u2500\u2500 ① inspect \u6b63\u5e38\u805a\u5408 \u2500\u2500')
{
  const { handle } = await imp(join(MALONG, 'tools/tool-inspect/handler.js'))
  ctx.codeIndexService = mkService()
  const r = await handle({ workspace_dir: WS, symbol: 'hello', file: 'src/a.js' }, ctx)
  assert(r.outline?.functions?.length === 1 && r.outline.total_symbols === 1, `① outline 聚合（得 ${JSON.stringify(r.outline?.functions?.length)}）`)
  assert(r.references?.count === 1 && !r.references?.truncated, `① references 聚合`)
  assert(r.call_chain?.callers?.length === 1 && r.call_chain?.callees?.length === 1, `① call_chain 聚合`)
  assert(JSON.stringify(r.metadata?.sections_included) === JSON.stringify(['outline', 'references', 'call_chain']), `① sections 标注`)
}

console.log('\u2500\u2500 ② \u90e8\u5206\u5931\u8d25\u900f\u4f20 \u2500\u2500')
{
  const { handle } = await imp(join(MALONG, 'tools/tool-inspect/handler.js'))
  ctx.codeIndexService = mkService({ getReferences: async () => { throw new Error('refs exploded') } })
  const r = await handle({ workspace_dir: WS, symbol: 'hello', file: 'src/a.js' }, ctx)
  assert(r.outline !== null && r.call_chain !== null, `② 失败部分不拖垮其余`)
  assert(JSON.stringify(r.partial_failures || []).includes('refs exploded'), `② 失败 reason 透出（得 ${JSON.stringify(r.partial_failures)}）`)
  assert(r.references === undefined, `② 失败部分不设字段（得 ${JSON.stringify(r.references)}）`)
}

console.log('\u2500\u2500 ③ initWorkspace \u629b\u9519\u900f\u51fa \u2500\u2500')
{
  const { handle } = await imp(join(MALONG, 'tools/tool-inspect/handler.js'))
  ctx.codeIndexService = mkService({ initWorkspace: async () => { throw new Error('init boom') } })
  const r = await handle({ workspace_dir: WS, symbol: 'hello', file: 'src/a.js' }, ctx)
  assert(JSON.stringify(r.init_warning || '').includes('init boom'), `③ init_warning 透出（得 ${r.init_warning}）`)
}

console.log('\u2500\u2500 ④ resolveFileArg \u62e6\u622a + \u5168\u5173\u9519\u8bef \u2500\u2500')
{
  const { handle } = await imp(join(MALONG, 'tools/tool-inspect/handler.js'))
  ctx.codeIndexService = mkService({ resolveFileArg: () => ({ ok: false, error: { code: 'PATH_BLOCKED', message: 'blocked', suggestion: 'fix' } }) })
  const r = await handle({ workspace_dir: WS, symbol: 'hello', file: '../../x.js' }, ctx)
  assert(r.error === 'PATH_BLOCKED', `④ resolveFileArg 拦截透出（得 ${r.error}）`)
  ctx.codeIndexService = mkService()
  const r2 = await handle({ workspace_dir: WS, symbol: 'hello', file: 'a.js', include_outline: false, include_refs: false, include_chain: false }, ctx)
  assert(r2.error === 'invalid_input', `④ 全关 section 报 invalid_input`)
}

console.log('\u2500\u2500 ⑤ \u7a7a\u5f15\u7528 fuzzy \u5efa\u8bae \u2500\u2500')
{
  const { handle } = await imp(join(MALONG, 'tools/tool-inspect/handler.js'))
  ctx.codeIndexService = mkService({ getReferences: async () => [], getCallers: async () => [], getCallees: async () => [] })
  const r = await handle({ workspace_dir: WS, symbol: 'hello', file: 'src/a.js' }, ctx)
  assert(r.suggestions?.length === 1 && r.suggestions[0].name === 'hello2', `⑤ 空引用时 fuzzy 建议（得 ${JSON.stringify(r.suggestions)}）`)
}

try { rmSync(WS, { recursive: true, force: true }) } catch {}
try { rmSync(DATA, { recursive: true, force: true }) } catch {}

console.log(`\n=== test-inspect: ${pass} passed, ${fail} failed ===`)
process.exit(fail > 0 ? 1 : 0)
