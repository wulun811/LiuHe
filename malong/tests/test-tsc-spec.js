// test-tsc-spec.js — B13 缺口六：tsc_check + spec_gen
// 覆盖：tsc_check 契约（缺 workspace）/ tsc 缺失返回工具内错误 / 有错误时解析结构 /
//       spec_gen 契约（缺 file）/ 未索引 / 真实索引后 exports+params 解析 /
//       service_unavailable
import { join, dirname } from 'node:path'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}

const WS = join(os.tmpdir(), 'opencode', 'b13-ts-ws')
const SOCK = join(os.tmpdir(), 'opencode', 'b13-ts.sock')
try { rmSync(WS, { recursive: true, force: true }) } catch {}
mkdirSync(join(WS, 'src'), { recursive: true })
writeFileSync(join(WS, 'src/app.js'), [
  'export function hot(a, b) { return a + b }',
  'export function c1() { hot(1, 2) }',
  'export class Widget {}',
].join('\n') + '\n')

// ── tsc_check ──
const tscMod = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-tsc-check', 'handler.js')).href)
const tscCtx = { getWorkspaceDir: (d) => d }

// ① 缺 workspace_dir
{
  const r = await tscMod.handle({}, tscCtx)
  assert(r.error === 'missing_parameter', `① tsc 缺 workspace_dir（得 ${r.error}）`)
}
// ② 无 tsc 环境 → 工具内错误（r46 收紧：此前 npx banner exit 0 被判 pass 假阳性，
// 宽容断言 `exitCode !== undefined` 放行了它——现在必须显式 tsc_not_found 或 fail）
{
  const r = await tscMod.handle({ workspace_dir: WS }, tscCtx)
  assert(r.error === 'tsc_not_found' || r.exitCode === 1, `② tsc 缺失必须显式失败（error=${r.error} exitCode=${r.exitCode}，不得 pass 假阳性）`)
}
// ②b R22-⑥（试用发现）：无 TS 源 workspace 的 tsc_not_found 建议不再噪音推装 typescript
{
  const r = await tscMod.handle({ workspace_dir: WS }, tscCtx)
  if (r.error === 'tsc_not_found' && r.suggestion) {
    assert(r.suggestion.includes('No TypeScript sources'), `②b 无 TS 源建议跳过（得 ${r.suggestion.slice(0, 60)}...）`)
  }
}
// ③ 目录不存在
{
  const r = await tscMod.handle({ workspace_dir: join(WS, 'nope') }, tscCtx)
  assert(r.error === 'workspace_not_found', `③ tsc workspace_not_found（得 ${r.error}）`)
}

// ── spec_gen ──
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
await svc.indexBatch([join(WS, 'src/app.js')], WS)

const specMod = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-spec-gen', 'handler.js')).href)
const specCtx = { codeIndexService: svc, getWorkspaceDir: () => WS }

// ④ 缺 file
{
  const r = await specMod.handle({ workspace_dir: WS }, specCtx)
  assert(r.error === 'missing_parameter', `④ spec 缺 file（得 ${r.error}）`)
}
// ⑤ 未索引工作区
{
  const empty = join(WS, 'empty')
  mkdirSync(empty, { recursive: true })
  const r = await specMod.handle({ workspace_dir: empty, file: 'x.js' }, { codeIndexService: svc, getWorkspaceDir: () => empty })
  assert(r.error === 'workspace_not_indexed', `⑤ spec workspace_not_indexed（得 ${r.error}）`)
}
// ⑥ 真实索引后：exports + params + examples
{
  const r = await specMod.handle({ workspace_dir: WS, file: 'src/app.js' }, specCtx)
  assert(r.spec?.export_count >= 3, `⑥ export_count ≥3（得 ${r.spec?.export_count}）`)
  const hot = r.spec.exports.find(e => e.name === 'hot')
  assert(!!hot && hot.kind === 'function', `⑥ 找到 hot function`)
  assert(Array.isArray(hot.params) && hot.params.length === 2, `⑥ hot 参数 2 个（得 ${JSON.stringify(hot.params)}）`)
  assert(r.spec.exports.some(e => e.name === 'Widget' && e.kind === 'class'), `⑥ Widget class 在列`)
  assert(Array.isArray(r.spec.examples) && r.spec.examples.length >= 1, `⑥ examples 非空`)
}
// ⑦ service_unavailable
{
  const r = await specMod.handle({ workspace_dir: WS, file: 'src/app.js' }, { getWorkspaceDir: () => WS })
  assert(r.error === 'service_unavailable', `⑦ spec service_unavailable（得 ${r.error}）`)
}
// ⑧ r52: MCP 场景（沙箱目录≠真实 workspace）params 不空 + 逃逸拦截
{
  const sandbox = join(WS, 'sandbox-db')
  mkdirSync(sandbox, { recursive: true })
  writeFileSync(join(sandbox, 'code-index.db'), 'x')
  const r = await specMod.handle({ workspace_dir: WS, file: 'src/app.js' }, { codeIndexService: svc, getWorkspaceDir: () => sandbox })
  const hot = r.spec?.exports?.find(e => e.name === 'hot')
  assert(Array.isArray(hot?.params) && hot.params.length === 2, `⑧ 沙箱≠真实时 params 仍解析（得 ${JSON.stringify(hot?.params)}）`)
  const esc = await specMod.handle({ workspace_dir: WS, file: '../escape.js' }, { codeIndexService: svc, getWorkspaceDir: () => sandbox })
  assert(esc.error === 'invalid_input', `⑧ 逃逸拦截（得 ${esc.error}）`)
}

try { rmSync(WS, { recursive: true, force: true }) } catch {} // Windows: db 句柄占用 EBUSY，best-effort
console.log(`== test-tsc-spec: ${pass} passed, ${fail} failed ==`)
process.exit(fail > 0 ? 1 : 0)
