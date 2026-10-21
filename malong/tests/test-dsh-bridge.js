// test-dsh-bridge.js — DSH 桥接适配：MALONG_STATE_DIR 注入 + 默认接口档（0.5.22）
// ① 桥接 spawn mcp-server 时必须把 stateDir 以 MALONG_STATE_DIR 传给子进程——新 server 只认该 env
//   （getStateDir()，默认 ~/.config/malong），--workspace 仅作旧状态迁移源；否则 DSH 状态会落进
//   宿主共享目录与 opencode 混用（dogfood-050 r5 DSH 适配）。
// ② 0.5.22：DSH 默认只暴露「六合线」（graph + 状态层 = 13 个工具），不再灌 classic 全量 44；
//   宿主显式设置 MALONG_INTERFACE 时以宿主为准（classic 全量 44 仍可达）。
// 依赖：malong-parse 服务在跑；真实 spawn mcp-server（同 test-mcp-server 模式）。
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const imp = (p) => import(pathToFileURL(p).href)
const MALONG_DIR = join(__dirname, '..')

let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}

const WS = join(tmpdir(), 'opencode', 'dsh-bridge-ws')
const STATE = join(tmpdir(), 'opencode', 'dsh-bridge-state')
try { rmSync(WS, { recursive: true, force: true }) } catch {}
try { rmSync(STATE, { recursive: true, force: true }) } catch {}
mkdirSync(WS, { recursive: true })
mkdirSync(STATE, { recursive: true })
writeFileSync(join(WS, 'lib.js'), 'function ping() { return 1 }\nmodule.exports = { ping }\n')

// 真 spawn mcp-server 的桥接：返回注册表与 dispose 句柄
async function runBridge(modulePath, label) {
  const registered = new Map()
  let disposeFn = null
  const ctx = {
    tools: { register: (def) => registered.set(def.name, def) },
    on: (evt, fn) => { if (evt === 'dispose') disposeFn = fn },
  }
  const bridge = modulePath.startsWith('file:') ? await import(modulePath) : await imp(modulePath)
  assert(typeof bridge.apply === 'function', label + '：bridge 导出 apply')
  let applyError = null
  try {
    await bridge.apply(ctx, {
      serverPath: join(MALONG_DIR, 'mcp-server.js'),
      stateDir: STATE,
      toolCallTimeoutMs: 120000,
    })
  } catch (e) { applyError = e }
  assert(!applyError, label + '：bridge apply 成功（' + (applyError ? applyError.message : 'ok') + '）')
  return { registered, dispose: disposeFn }
}

// ── ① 默认档：六合线（graph + 状态层）= 13 个工具 ──
{
  delete process.env.MALONG_INTERFACE
  delete process.env.MALONG_ENTRY_STATE
  const { registered, dispose } = await runBridge(join(MALONG_DIR, 'dsh', 'dsh-bridge.mjs'), '默认档')
  assert(registered.size === 13, '默认只暴露六合线 13 个工具（得 ' + registered.size + '）')
  assert(registered.has('malong__code_task'), 'malong__code_task 已注册')
  assert(registered.has('malong__code_read'), 'malong__code_read 已注册')
  assert(registered.has('malong__code_patch'), 'malong__code_patch 已注册')
  assert(!registered.has('malong__reindex'), 'classic-only 的 malong__reindex 默认不再暴露')
  assert(!registered.has('malong__read_symbol'), 'classic-only 的 malong__read_symbol 默认不再暴露')
  if (dispose) dispose()
}

// ── ② 宿主显式覆盖：MALONG_INTERFACE=classic → 全量 44 仍可达 ──
{
  process.env.MALONG_INTERFACE = 'classic'
  const url = pathToFileURL(join(MALONG_DIR, 'dsh', 'dsh-bridge.mjs')).href + '?classic=1'
  const { registered, dispose } = await runBridge(url, '宿主覆盖档')
  assert(registered.size >= 40, '宿主覆盖 classic → 全量工具可达（' + registered.size + '）')
  const reindex = registered.get('malong__reindex')
  assert(!!reindex, 'malong__reindex 已注册')

  if (reindex) {
    const result = await reindex.execute({ workspace_dir: WS, blocking: true }, { agent: { session: { header: { cwd: WS } } } })
    const payload = result && result.structuredContent ? result.structuredContent : {}
    assert(!(payload && payload.error), 'reindex 执行成功（' + JSON.stringify((payload && payload.error) || 'ok') + '）')

    const hash = createHash('md5').update(resolve(WS)).digest('hex').slice(0, 12)
    const dbPath = join(STATE, 'workspaces', hash, 'code-index.db')
    assert(existsSync(dbPath), 'MALONG_STATE_DIR 生效：状态写入桥接 stateDir（' + dbPath + '）')

    // 桥接把 workspace_dir 从 required 剥离（会话工作区自动注入）
    const schema = reindex.parameters || {}
    const req = Array.isArray(schema.required) ? schema.required : []
    assert(!req.includes('workspace_dir'), 'workspace_dir 已从 required 移除')
  }
  if (dispose) dispose()
  delete process.env.MALONG_INTERFACE
}

console.log('\n== test-dsh-bridge: ' + pass + ' passed, ' + fail + ' failed ==')
process.exit(fail > 0 ? 1 : 0)