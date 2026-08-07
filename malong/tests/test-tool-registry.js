// test-tool-registry.js — 工具注册中心（r34：此前 tool-registry.js 224 行零测试）
// 覆盖：loadAll 各坏形态校验 / 重复名覆盖 / 真实 tools 目录完整性 / callTool 成功与异常 /
//       usage 记录（注入临时路径，不污染真实 usage）/ extractMetrics 指标提取
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, utimesSync } from 'node:fs'
import os from 'node:os'
import ToolRegistry, { extractMetrics } from '../tool-registry.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}

const TMP = join(os.tmpdir(), 'opencode', 'tool-registry-test')
rmSync(TMP, { recursive: true, force: true })
mkdirSync(join(TMP, 'tools'), { recursive: true })

// ── 构造各种形态的工具目录 ──
const GOOD = join(TMP, 'tools', 'tool-good')
mkdirSync(GOOD, { recursive: true })
writeFileSync(join(GOOD, 'manifest.json'), JSON.stringify({
  name: 'good_tool', description: 'a good tool', handler: 'handler.js',
  inputSchema: { type: 'object', properties: {} },
}))
writeFileSync(join(GOOD, 'handler.js'), 'export async function handle(args, ctx) { return { ok: true, echo: args?.x } }')

const GOOD2 = join(TMP, 'tools', 'tool-good2')
mkdirSync(GOOD2, { recursive: true })
writeFileSync(join(GOOD2, 'manifest.json'), JSON.stringify({
  name: 'good_tool', description: 'duplicate name', handler: 'handler.js',
  inputSchema: { type: 'object' },
}))
writeFileSync(join(GOOD2, 'handler.js'), 'export async function handle() { return { from: "dupe" } }')

const NONAME = join(TMP, 'tools', 'tool-noname')
mkdirSync(NONAME, { recursive: true })
writeFileSync(join(NONAME, 'manifest.json'), JSON.stringify({ description: 'no name', handler: 'h.js' }))
writeFileSync(join(NONAME, 'h.js'), 'export async function handle() { return {} }')

const NOHANDLER = join(TMP, 'tools', 'tool-nohandler')
mkdirSync(NOHANDLER, { recursive: true })
writeFileSync(join(NOHANDLER, 'manifest.json'), JSON.stringify({ name: 'nohandler_tool' }))

const MISSINGFILE = join(TMP, 'tools', 'tool-missingfile')
mkdirSync(MISSINGFILE, { recursive: true })
writeFileSync(join(MISSINGFILE, 'manifest.json'), JSON.stringify({ name: 'missingfile_tool', handler: 'nope.js' }))

const BADEXPORT = join(TMP, 'tools', 'tool-badexport')
mkdirSync(BADEXPORT, { recursive: true })
writeFileSync(join(BADEXPORT, 'manifest.json'), JSON.stringify({ name: 'badexport_tool', handler: 'handler.js' }))
writeFileSync(join(BADEXPORT, 'handler.js'), 'export const nothing = 42')

const CRASH = join(TMP, 'tools', 'tool-crash')
mkdirSync(CRASH, { recursive: true })
writeFileSync(join(CRASH, 'manifest.json'), JSON.stringify({ name: 'crash_tool', handler: 'handler.js' }))
writeFileSync(join(CRASH, 'handler.js'), 'export async function handle() { throw new Error("boom") }')

const BADDEP = join(TMP, 'tools', 'tool-baddep')
mkdirSync(BADDEP, { recursive: true })
writeFileSync(join(BADDEP, 'manifest.json'), JSON.stringify({
  name: 'baddep_tool', handler: 'handler.js', dependencies: ['reindex', 'no_such_tool'],
}))
writeFileSync(join(BADDEP, 'handler.js'), 'export async function handle() { return { ok: true } }')

const USAGE = join(TMP, 'usage.jsonl')
const logs = []
const reg = new ToolRegistry(join(TMP, 'tools'), {
  log: (level, msg) => logs.push([level, msg]),
  usagePath: USAGE,
})

// ── loadAll 校验 ──
const loaded = await reg.loadAll()
assert(loaded === 4, `loadAll 只加载合法工具（good/good2/crash/baddep=4，实际 ${loaded}）`)

const errorLogs = logs.filter(([l]) => l === 'error')
assert(errorLogs.some(([_, m]) => m.includes('missing')), '缺 name 的 manifest 报 error')
assert(errorLogs.some(([_, m]) => m.includes("'handler' field")), '缺 handler 字段报 error')
assert(errorLogs.some(([_, m]) => m.includes('not found')), 'handler 文件不存在报 error')
assert(errorLogs.some(([_, m]) => m.includes('export')), '非 handle 导出报 error')
assert(logs.some(([l, m]) => l === 'warn' && m.includes('duplicate')), '重复工具名报 warn（覆盖）')

// r42: dependencies 声明式校验——缺失依赖 warn + dependencyIssues 记录
assert(logs.some(([l, m]) => l === 'warn' && m.includes('no_such_tool')), '缺失依赖报 warn（no_such_tool）')
assert(reg.dependencyIssues.some(i => i.tool === 'baddep_tool' && i.missing_dep === 'no_such_tool'), 'dependencyIssues 记录 baddep_tool→no_such_tool')
assert(reg.dependencyIssues.some(i => i.missing_dep === 'reindex'), 'reindex 在 fixture 中不存在 → 同样记录缺失')

assert(reg.getToolCount() === 3, 'getToolCount=3（good_tool 被重复名覆盖不新增 + crash + baddep，实际 '+reg.getToolCount()+'）')
assert(reg.hasTool('good_tool'), 'hasTool(good_tool)')
assert(!reg.hasTool('nohandler_tool'), 'hasTool(坏工具)=false')
assert(reg.getToolNames().includes('good_tool'), 'getToolNames 含 good_tool')
const list = reg.listTools()
assert(list.length === 3 && list.some(t => t.name === 'good_tool'), 'listTools 返回 3 个工具描述（实际 '+list.length+'）')
const goodDesc = list.find(t => t.name === 'good_tool')
assert(goodDesc.inputSchema && goodDesc.description, 'listTools 含 inputSchema/description')

// ── callTool 成功 + usage 记录 ──
const r = await reg.callTool('good_tool', { x: 1 }, {})
assert(r.from === 'dupe', 'callTool 走被覆盖的 handler（重复名最后者生效）')
const usageLines = readFileSync(USAGE, 'utf-8').trim().split('\n').map(l => JSON.parse(l))
assert(usageLines.length === 1, 'usage 记录 1 条')
assert(usageLines[0].tool === 'good_tool' && usageLines[0].success === true, 'usage 条目工具名+成功')
assert(usageLines[0].duration_ms >= 0, 'usage 记录耗时')

// ── callTool handler 抛异常 ──
let threw = false
try { await reg.callTool('crash_tool', {}, {}) } catch (e) { threw = e.message === 'boom' }
assert(threw, 'handler 抛错时 callTool 原样上抛')
const lines2 = readFileSync(USAGE, 'utf-8').trim().split('\n').map(l => JSON.parse(l))
const crashEntry = lines2.find(l => l.tool === 'crash_tool')
assert(crashEntry && crashEntry.success === false && crashEntry.status === 'crash', 'usage 记录 crash 状态')
assert(crashEntry.error_code.includes('boom'), 'usage 记录错误信息')

// ── callTool 返回 error 字段 ──
const G3 = join(TMP, 'tools', 'tool-err')
mkdirSync(G3, { recursive: true })
writeFileSync(join(G3, 'manifest.json'), JSON.stringify({ name: 'err_tool', handler: 'handler.js' }))
writeFileSync(join(G3, 'handler.js'), 'export async function handle() { return { error: "denied", error_code: "E_DENIED" } }')
const reg2 = new ToolRegistry(join(TMP, 'tools'), { log: () => {}, usagePath: USAGE })
await reg2.loadAll()
const er = await reg2.callTool('err_tool', {}, {})
assert(er.error === 'denied', 'handler 返回 error 字段原样透传')
const lines3 = readFileSync(USAGE, 'utf-8').trim().split('\n').map(l => JSON.parse(l))
const errEntry = lines3.find(l => l.tool === 'err_tool')
assert(errEntry.status === 'error' && errEntry.error_code === 'E_DENIED', 'usage 记录 error 状态+错误码')

// ── callTool 不存在工具 ──
let notFound = false
try { await reg.callTool('ghost', {}, {}) } catch (e) { notFound = /not found/i.test(e.message) }
assert(notFound, '调用不存在工具抛 Tool not found')

// ── 真实 tools 目录完整性（注册防线）──
const realReg = new ToolRegistry(join(__dirname, '..', 'tools'), { log: () => {} })
const realLoaded = await realReg.loadAll()
assert(realLoaded === 44, `真实 tools 目录加载 44 个工具（B13 增 6，实际 ${realLoaded}）`)
const realNames = realReg.getToolNames()
for (const expect of ['read_symbol', 'write_symbol', 'edit_batch', 'edit_transaction', 'repo_map', 'sweep_dead_code', 'test_bridge', 'impact_analysis', 'call_chain', 'trace_symbol']) {
  assert(realNames.includes(expect), `真实工具表含 ${expect}`)
}

// ── extractMetrics 指标提取 ──
const mReadOutline = extractMetrics('read_outline', { lines: 100, tokens_estimate: 50 })
assert(mReadOutline?.tokens_saved === 100 * 12 - 50, 'read_outline tokens_saved 计算')
assert(extractMetrics('read_outline', { lines: 100 }) === undefined, '缺 tokens_estimate 不产指标')
const mRepoMap = extractMetrics('repo_map', { tokens: 1234 })
assert(mRepoMap?.tokens_served === 1234, 'repo_map tokens_served')
const mImpact = extractMetrics('impact_analysis', { caller_count: { direct: 3, indirect: 2 } })
assert(mImpact?.reads_saved === 5, 'impact_analysis reads_saved=direct+indirect')
const mTrans = extractMetrics('edit_transaction', { status: 'rolled_back' })
assert(mTrans?.rollbacks === 1, 'edit_transaction rollbacks')
assert(extractMetrics('edit_transaction', { status: 'committed' }) === undefined, '非 rolled_back 不产指标')
assert(extractMetrics('unknown_tool', { x: 1 }) === undefined, '未知工具不产指标')
assert(extractMetrics('health', { error: 'x' }) === undefined, 'error 结果不产指标')

// ── R13: ESM 热更新检测——改 handler mtime 后 callTool 结果带 note ──
{
  const before = await reg.callTool('good_tool', { x: 1 }, {})
  assert(before.note === undefined, 'R13: mtime 未变不带 note')
  const handlerFile = join(GOOD2, 'handler.js')
  const past = new Date(Date.now() - 60000)
  utimesSync(handlerFile, past, past)
  const after = await reg.callTool('good_tool', { x: 1 }, {})
  assert(after.note && String(after.note).includes('restart MCP'), `R13: mtime 变化贴 note（${String(after.note).slice(0, 50)}）`)
  assert(after.from === 'dupe', 'R13: note 附加不覆盖原结果')
  { const noErr = await reg.callTool('good_tool', { x: 1 }, {}); assert(noErr.note && noErr.from === 'dupe', 'R13: 二次调用仍检测到（ESM 缓存未热加载）') }
}

rmSync(TMP, { recursive: true, force: true })
console.log(`== test-tool-registry: ${pass} passed, ${fail} failed ==`)
if (fail > 0) process.exit(1)
