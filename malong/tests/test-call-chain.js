// test-call-chain.js — 行级调用链（Y001-S3 补测）
// 覆盖：行→符号解析 / 显式 symbol 优先 / depth 钳制 / callees 去重截断 / test refs 过滤 /
//       misuse 警告 / checkRecentModifications 注入 clock（去 Date.now） / 错误路径
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}
const mod = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-call-chain', 'handler.js')).href)
const { handle, checkRecentModifications } = mod

const ws = join(os.tmpdir(), 'opencode', 'cc-test-ws')
try { rmSync(ws, { recursive: true, force: true }) } catch {}
mkdirSync(ws, { recursive: true })
writeFileSync(join(ws, 'code-index.db'), '')

function makeCtx(overrides = {}, wsDir = ws) {
  return {
    codeIndexService: {
      initWorkspace() {},
      resolveFileArg: (f) => ({ ok: true, path: f }),
      getSymbolsAtLine: (file, line) => [{ name: 'parseName', type: 'function', signature: 'parseName(x)' }],
      getImpactAnalysis: async () => ({
        target_symbol: 'parseName',
        risk_level: 'high',
        caller_count: { direct: 2, indirect: 1 },
        callers: [
          { file: 'src/a.js', line: 3, function: 'main', depth: 1 },
          { file: 'tests/a.test.js', line: 5, function: 'it', depth: 1, type: 'test' },
        ],
        callees: [
          { callee_file: 'lib/x.js', callee_line: 1, function: 'x', call_expr: 'x()' },
          { callee_file: 'lib/x.js', callee_line: 1, function: 'x' },
          { callee_file: 'lib/y.js', callee_line: 2, function: 'y' },
          { callee_file: 'lib/z.js', callee_line: 3, function: 'z' },
        ],
        truncated_callers: false,
      }),
      ...overrides,
    },
    getWorkspaceDir: () => wsDir,
  }
}

// ── ① 行→符号解析：file+line 无 symbol 时自动解析 ──
{
  let sawFile = null, sawLine = null
  const ctx = makeCtx({ getSymbolsAtLine: (file, line) => { sawFile = file; sawLine = line; return [{ name: 'parseName', type: 'function' }] } })
  const r = await handle({ workspace_dir: ws, file: 'src/app.js', line: 42 }, ctx)
  assert(sawFile === 'src/app.js' && sawLine === 42, `① 行→符号解析调用正确（得 ${sawFile}:${sawLine}）`)
  assert(r.target.symbol === 'parseName', `① target.symbol 自动解析（得 ${r.target.symbol}）`)
  assert(r.target.risk_level === 'high', `① risk_level 透传（得 ${r.target.risk_level}）`)
}

// ── ② 显式 symbol 优先于行解析 ──
{
  let resolved = false
  const ctx = makeCtx({ getSymbolsAtLine: () => { resolved = true; return [] } })
  await handle({ workspace_dir: ws, file: 'src/app.js', symbol: 'explicitFn', line: 42 }, ctx)
  assert(resolved === false, `② 显式 symbol 不触发行解析（得 resolved=${resolved}）`)
}

// ── ③ depth 钳制 + maxCallees 截断去重 ──
{
  const ctx = makeCtx()
  const r = await handle({ workspace_dir: ws, file: 'src/app.js', line: 1, depth: 99, max_callees: 2 }, ctx)
  assert(r.metadata?.total_callers === 3, `③ caller_count 聚合（得 ${r.metadata?.total_callers}）`)
  assert(r.callees.length === 2, `③ max_callees=2 截断（得 ${r.callees.length}）`)
  assert(r.callees[0].name === 'x' && r.callees[0].call_expr === 'x()', '③ 去重后保留首个 x 且带 call_expr')
  assert(r.truncated_callees === true, `③ truncated_callees 标记（得 ${r.truncated_callees}）`)
  let sawDepth = null
  const ctx2 = makeCtx({ getImpactAnalysis: async (file, opts) => { sawDepth = opts.depth; return { callers: [], callees: [] } } })
  await handle({ workspace_dir: ws, file: 'src/app.js', line: 1, depth: -3 }, ctx2)
  assert(sawDepth === 0, `③ depth=-3 钳制 0（得 ${sawDepth}）`)
  await handle({ workspace_dir: ws, file: 'src/app.js', line: 1, depth: 77 }, ctx2)
  assert(sawDepth === 10, `③ depth=77 钳制 10（得 ${sawDepth}）`)
}

// ── ④ test_references 过滤 ──
{
  const r = await handle({ workspace_dir: ws, file: 'src/app.js', line: 1 }, makeCtx())
  assert(r.test_references.length === 1 && r.test_references[0].file === 'tests/a.test.js', `④ test refs 过滤（得 ${JSON.stringify(r.test_references)}）`)
}

// ── ⑤ misuse 警告：有 symbol 无 line ──
{
  const r = await handle({ workspace_dir: ws, file: 'src/app.js', symbol: 'foo' }, makeCtx())
  assert(r.misuse_warning && r.misuse_warning.warning === 'likely_wrong_tool', `⑤ misuse 警告（得 ${JSON.stringify(r.misuse_warning)}）`)
}

// ── ⑥ checkRecentModifications 注入 clock（Y001-S3 去 Date.now） ──
{
  const now = 2000000000000
  const fresh = join(ws, 'src', 'fresh.js')
  mkdirSync(join(ws, 'src'), { recursive: true })
  writeFileSync(fresh, 'x')
  utimesSync(fresh, new Date(now - 2 * 60000), new Date(now - 2 * 60000))
  const old = join(ws, 'src', 'old.js')
  writeFileSync(old, 'x')
  utimesSync(old, new Date(now - 60 * 60000), new Date(now - 60 * 60000))
  const impact = { callers: [{ file: 'src/fresh.js' }], callees: [{ file: 'src/old.js' }] }
  const mods = checkRecentModifications(ws, impact, 5, now)
  assert(mods.length === 1 && mods[0].file === 'src/fresh.js' && mods[0].minutes_ago === 2, `⑥ 注入 now：仅 2 分钟前文件命中（得 ${JSON.stringify(mods)}）`)
  const modsAll = checkRecentModifications(ws, impact, 120, now)
  assert(modsAll.length === 2, `⑥ 阈值放大后两条都命中（得 ${modsAll.length}）`)
}

// ── ⑦ 错误路径 ──
{
  const noWs = await handle({ file: 'x.js', line: 1 }, makeCtx())
  assert(noWs.error === 'missing_parameter', '⑦ 缺 workspace_dir')
  const noFile = await handle({ workspace_dir: ws }, makeCtx())
  assert(noFile.error === 'missing_parameter' && noFile.message.includes('file'), '⑦ 缺 file')
  const badResolve = await handle({ workspace_dir: ws, file: 'bad.js', line: 1 }, makeCtx({ resolveFileArg: () => ({ ok: false, error: { code: 'FILE_NOT_FOUND', message: 'nf', suggestion: 'x' } }) }))
  assert(badResolve.error === 'FILE_NOT_FOUND', `⑦ resolveFileArg 失败归因（得 ${badResolve.error}）`)
  const noSymbol = await handle({ workspace_dir: ws, file: 'x.js' }, makeCtx({ getSymbolsAtLine: () => [] }))
  assert(noSymbol.error === 'missing_parameter', '⑦ 无法确定 symbol → missing_parameter')
  const noIndex = await handle({ workspace_dir: ws, file: 'x.js', line: 1 }, makeCtx({}, join(os.tmpdir(), 'opencode', 'cc-noindex')))
  assert(noIndex.error === 'workspace_not_indexed', '⑦ 无索引')
}

try { rmSync(ws, { recursive: true, force: true }) } catch {}

console.log(`== test-call-chain: ${pass} passed, ${fail} failed ==`)
if (fail > 0) process.exit(1)
