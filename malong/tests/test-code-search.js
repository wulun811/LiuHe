// test-code-search.js — B13 缺口五：code_search 意图分类多路搜索
// 覆盖：契约（缺 query）/ 未索引 / 真实索引后 whereUsed 意图识别 /
//       符号搜索 findFunction / limit 钳制 / service_unavailable
import { join, dirname } from 'node:path'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}

const WS = join(os.tmpdir(), 'opencode', 'b13-cs-ws')
const SOCK = join(os.tmpdir(), 'opencode', 'b13-cs.sock')
try { rmSync(WS, { recursive: true, force: true }) } catch {}
mkdirSync(join(WS, 'src'), { recursive: true })
writeFileSync(join(WS, 'src/app.js'), [
  'export function hot() { return 1 }',
  'export function c1() { hot() }',
  'export function c2() { hot() }',
  // R7：含下划线符号——code_search 的 search 意图 token 化保留 `_`，
  // searchSymbols 转义后按字面量匹配，防全表命中
  'export function snake_case_fn() { return 3 }',
].join('\n') + '\n')
writeFileSync(join(WS, 'src/other.js'), 'export function unrelated() { return 2 }\n')

const pc = await import(pathToFileURL(join(__dirname, '..', 'parse-client.js')).href)
await pc.init({ log: () => {} })
try { await pc.connect() } catch {}
const { default: codeIndex } = await import(pathToFileURL(join(__dirname, '..', 'code-index.js')).href)
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
await svc.indexBatch([join(WS, 'src/app.js'), join(WS, 'src/other.js')], WS)

// 注册 code-search 服务（模拟 mcp-server 的 init 注入）
const codeSearchMod = await import(pathToFileURL(join(__dirname, '..', 'code-search.js')).href)
await codeSearchMod.init(core)
const codeSearchService = services.codeSearch

const { handle } = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-code-search', 'handler.js')).href)
const ctx = { codeSearchService, getWorkspaceDir: () => WS }

// ① 契约：缺 query
{
  const r = await handle({ workspace_dir: WS }, ctx)
  assert(r.error === 'missing_parameter', `① 缺 query → missing_parameter（得 ${r.error}）`)
}
// ② 未索引工作区
{
  const empty = join(WS, 'empty')
  mkdirSync(empty, { recursive: true })
  const r = await handle({ workspace_dir: empty, query: 'hot' }, { codeSearchService, getWorkspaceDir: () => empty })
  assert(r.error === 'workspace_not_indexed', `② workspace_not_indexed（得 ${r.error}）`)
}
// ③ whereUsed 意图识别
{
  const r = await handle({ workspace_dir: WS, query: 'where is hot used?' }, ctx)
  assert(r.intent === 'whereUsed', `③ intent=whereUsed（得 ${r.intent}）`)
  assert(r.count >= 2, `③ hot 至少 2 处调用（得 ${r.count}）`)
  const hasCaller = r.results.some(x => x.type === 'caller' && x.name === 'hot')
  assert(hasCaller, `③ 有 caller 类型结果（得 ${JSON.stringify(r.results.map(x => x.type))}）`)
}
// ④ 符号搜索 findFunction
{
  const r = await handle({ workspace_dir: WS, query: 'find function hot' }, ctx)
  assert(r.intent === 'findFunction' || r.intent === 'search', `④ intent 识别（得 ${r.intent}）`)
  assert(r.results.some(x => x.name === 'hot'), `④ 结果含 hot`)
}
// ⑤ limit 钳制
{
  const r = await handle({ workspace_dir: WS, query: 'hot', limit: 1 }, ctx)
  assert(r.results.length <= 1, `⑤ limit=1 生效（得 ${r.results.length}）`)
}
// ⑥ service_unavailable
{
  const r = await handle({ workspace_dir: WS, query: 'hot' }, { getWorkspaceDir: () => WS })
  assert(r.error === 'service_unavailable', `⑥ service_unavailable（得 ${r.error}）`)
}
// ⑦ R7: code_search 含 `_` token 回归——search 意图 token 化保留 `_`，
// searchSymbols 转义后按字面量匹配，不得全表命中
{
  const r = await handle({ workspace_dir: WS, query: 'snake_case_fn' }, ctx)
  const symNames = (r.results || []).filter(x => x.name).map(x => x.name)
  assert(symNames.includes('snake_case_fn'), `⑦ _ token 字面量命中蛇形名（得 ${symNames.join(',')}）`)
  const leaked = symNames.filter(n => !['snake_case_fn'].includes(n))
  assert(leaked.length === 0, `⑦ 无全表误命中（leaked=${leaked.join(',') || '无'}）`)
}
{
  const r = await handle({ workspace_dir: WS, query: 'snake  case' }, ctx)
  const symNames = (r.results || []).filter(x => x.name).map(x => x.name)
  const leaked = symNames.filter(n => !['snake_case_fn'].includes(n))
  assert(leaked.length === 0, `⑦ 分 token 后仍无全表误命中（leaked=${leaked.join(',') || '无'}）`)
}

try { rmSync(WS, { recursive: true, force: true }) } catch {} // Windows：db 连接未关闭时删除被占用文件报 EBUSY——best-effort，路径固定开头会重建
console.log(`== test-code-search: ${pass} passed, ${fail} failed ==`)
process.exit(fail > 0 ? 1 : 0)
