// test-output-budget.js — 输出预算控制（Y002-S4）
// 覆盖：impact_analysis max_results/context_mode 透传 + max_callers 兼容别名 +
//       真实 getImpactAnalysis context_mode 三态（none/snippet/full）+
//       references kind 过滤（通用名噪声治理）
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}
const imp = (p) => import(pathToFileURL(p).href)

// ── ① handler 透传：max_results → maxCallers；0=不限；max_callers 兼容别名 ──
{
  const calls = []
  const mockIdx = {
    initWorkspace: async () => {},
    getImpactAnalysis: async (file, opts) => { calls.push(opts); return { callers: [], caller_count: { direct: 0, test: 0 }, risk_level: 'low' } },
  }
  const ctx = { codeIndexService: mockIdx, getWorkspaceDir: (w) => w }
  const impact = await imp(join(__dirname, '..', 'tools', 'tool-impact-analysis', 'handler.js'))
  const ws = join(tmpdir(), 'opencode', 'ob-ws1')
  mkdirSync(ws, { recursive: true })
  writeFileSync(join(ws, 'code-index.db'), '')

  await impact.handle({ workspace_dir: ws, file: 'a.js', symbol: 'foo', max_results: 5 }, ctx)
  assert(calls[0]?.maxCallers === 5, `① max_results=5 → maxCallers=5（得 ${calls[0]?.maxCallers}）`)
  await impact.handle({ workspace_dir: ws, file: 'a.js', symbol: 'foo', max_results: 0 }, ctx)
  assert(calls[1]?.maxCallers === 0, `① max_results=0 → 不限（得 ${calls[1]?.maxCallers}）`)
  await impact.handle({ workspace_dir: ws, file: 'a.js', symbol: 'foo', max_callers: 9 }, ctx)
  assert(calls[2]?.maxCallers === 9, `① max_callers 兼容别名（得 ${calls[2]?.maxCallers}）`)
  await impact.handle({ workspace_dir: ws, file: 'a.js', symbol: 'foo' }, ctx)
  assert(calls[3]?.maxCallers === 20, `① 默认 20（得 ${calls[3]?.maxCallers}）`)
  try { rmSync(ws, { recursive: true, force: true }) } catch {}
}

// ── ② context_mode 透传：none|snippet|full + 非法值回退 snippet ──
{
  const calls = []
  const mockIdx = {
    initWorkspace: async () => {},
    getImpactAnalysis: async (file, opts) => { calls.push(opts); return { callers: [], caller_count: { direct: 0, test: 0 }, risk_level: 'low' } },
  }
  const ctx = { codeIndexService: mockIdx, getWorkspaceDir: (w) => w }
  const impact = await imp(join(__dirname, '..', 'tools', 'tool-impact-analysis', 'handler.js'))
  const ws = join(tmpdir(), 'opencode', 'ob-ws2')
  mkdirSync(ws, { recursive: true })
  writeFileSync(join(ws, 'code-index.db'), '')

  await impact.handle({ workspace_dir: ws, file: 'a.js', symbol: 'foo', context_mode: 'none' }, ctx)
  assert(calls[0]?.contextMode === 'none', `② none 透传（得 ${calls[0]?.contextMode}）`)
  await impact.handle({ workspace_dir: ws, file: 'a.js', symbol: 'foo', context_mode: 'full' }, ctx)
  assert(calls[1]?.contextMode === 'full', `② full 透传（得 ${calls[1]?.contextMode}）`)
  await impact.handle({ workspace_dir: ws, file: 'a.js', symbol: 'foo' }, ctx)
  assert(calls[2]?.contextMode === 'snippet', `② 默认 snippet（得 ${calls[2]?.contextMode}）`)
  await impact.handle({ workspace_dir: ws, file: 'a.js', symbol: 'foo', context_mode: 'huge' }, ctx)
  assert(calls[3]?.contextMode === 'snippet', `② 非法值回退 snippet（得 ${calls[3]?.contextMode}）`)
  try { rmSync(ws, { recursive: true, force: true }) } catch {}
}

// ── ③ references kind 过滤：call-only 剔除 import/use 噪声 + kind_filtered 计数 ──
{
  const refsAll = [
    { path: 'a.js', kind: 'call', target_name: 'get', line: 1 },
    { path: 'b.js', kind: 'import', target_name: 'get', line: 1 },
    { path: 'c.js', kind: 'use', target_name: 'get', line: 3 },
    { path: 'd.js', kind: 'assign', target_name: 'get', line: 5 },
  ]
  const mockIdx = {
    initWorkspace: async () => {},
    getReferences: async () => refsAll,
  }
  const ctx = { codeIndexService: mockIdx, getWorkspaceDir: (w) => w }
  const refsHandler = await imp(join(__dirname, '..', 'tools', 'tool-references', 'handler.js'))
  const ws = join(tmpdir(), 'opencode', 'ob-ws3')
  mkdirSync(ws, { recursive: true })
  writeFileSync(join(ws, 'code-index.db'), '')

  const r1 = await refsHandler.handle({ workspace_dir: ws, symbol: 'get' }, ctx)
  assert(r1.count === 4, `③ 无 kind 参数返回全部（得 ${r1.count}）`)
  const r2 = await refsHandler.handle({ workspace_dir: ws, symbol: 'get', kind: 'call' }, ctx)
  assert(r2.count === 1 && r2.results[0].kind === 'call', `③ kind=call 过滤（得 ${r2.count} ${r2.results[0]?.kind}）`)
  assert(r2.kind_filtered?.dropped === 3, `③ kind_filtered.dropped=3（得 ${JSON.stringify(r2.kind_filtered)}）`)
  const r3 = await refsHandler.handle({ workspace_dir: ws, symbol: 'get', kind: 'call,use' }, ctx)
  assert(r3.count === 2, `③ kind 逗号组合（得 ${r3.count}）`)
  const r4 = await refsHandler.handle({ workspace_dir: ws, symbol: 'get', kind: 'bogus' }, ctx)
  assert(r4.count === 4 && r4.kind_filter_note, `③ 非法 kind → 提示且不误伤（得 ${r4.count} ${r4.kind_filter_note}）`)
  try { rmSync(ws, { recursive: true, force: true }) } catch {}
}

// ── ④ 真实 getImpactAnalysis context_mode 三态（真实索引 + live daemon） ──
{
  const WS = join(tmpdir(), 'opencode', 'ob-ws4')
  const SOCK = join(tmpdir(), 'opencode', 'ob-r24.sock')
  try { rmSync(WS, { recursive: true, force: true }) } catch {}
  mkdirSync(join(WS, 'src'), { recursive: true })
  writeFileSync(join(WS, 'src/app.js'), [
    'export function hot() { return 1 }',
    'export function c1() { hot() }',
    'export function c2() { hot() }',
    'export function c3() { hot() }',
    'export function c4() { hot() }',
    'export function c5() { hot() }',
    'export function c6() { hot() }',
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

  const base = await svc.getImpactAnalysis('src/app.js', { symbol: 'hot' })
  assert(base.callers.length >= 6, `④ 基线 6+ callers（得 ${base.callers.length}）`)
  assert(base.callers.every(c => typeof c.context === 'string' && c.context.length > 0), `④ snippet 默认带 context`)

  const limited = await svc.getImpactAnalysis('src/app.js', { symbol: 'hot', maxCallers: 2 })
  assert(limited.callers.length === 2 && limited.truncated === true, `④ maxCallers=2 截断 + truncated（得 ${limited.callers.length} ${limited.truncated}）`)

  const none = await svc.getImpactAnalysis('src/app.js', { symbol: 'hot', contextMode: 'none' })
  assert(none.callers.every(c => c.context === null), `④ context_mode=none → context null`)
  assert(none.callees.every(c => c.context === null), `④ context_mode=none → callees context null（Y002-S4 修复）`)

  const full = await svc.getImpactAnalysis('src/app.js', { symbol: 'hot', contextMode: 'full' })
  assert(full.callers.every(c => typeof c.context === 'string'), `④ context_mode=full → context 有值`)
  const snipLen = base.callers[0].context.length
  const fullLen = full.callers[0].context.length
  assert(fullLen >= snipLen, `④ full context ≥ snippet（${fullLen} ≥ ${snipLen}）`)

  const noneSnippet = await svc.getImpactAnalysis('src/app.js', { symbol: 'hot', contextMode: 'none', maxCallers: 2 })
  assert(noneSnippet.callees.every(c => c.context === null), `④ none+maxCallers → callees context 仍 null`)

  try { rmSync(WS, { recursive: true, force: true }) } catch {} // Windows: db 句柄占用 EBUSY，best-effort
}

console.log(`== test-output-budget: ${pass} passed, ${fail} failed ==`)
process.exit(fail > 0 ? 1 : 0)
