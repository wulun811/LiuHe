// test-variable-refs.js — 变量引用追踪（Y002-S3，JS/TS spike）
// 覆盖：Rust daemon extract_variable_refs 输出 use/assign → code-index refs 表入库 →
//       references(symbol) 返回变量引用；同文件绑定 / 跨文件解析 / 属性访问不追踪 /
//       局部变量不追踪 / 调用名不重复
// 隔离：MALONG_SOCKET + MALONG_PARSE_BIN 指向测试 daemon（不碰 live 0AIT daemon）
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}

// ── 测试 daemon 隔离：独立 socket/端口 + 测试二进制（release 编译产物） ──
// parse-client 的 _startProcess 自 spawn 在 detached+ignore stdio 下偶发起不来，
// 测试自行 spawn 并等待就绪（pid 文件/socket 随 MALONG_SOCKET 隔离，不碰 live daemon）。
// Windows：daemon 走 TCP（MALONG_PORT），无 Unix socket——用随机端口 + TCP 探测就绪。
import { spawn } from 'node:child_process'
import net from 'node:net'
const IS_WIN = process.platform === 'win32'
const TEST_BIN = join(os.tmpdir(), 'opencode', 's3-bin', IS_WIN ? 'malong-parse.exe' : 'malong-parse')
if (!existsSync(TEST_BIN)) {
  // R22-④：链内静默跳过 = 绿灯假象（exit 0 零断言执行）。环境缺 daemon 必须显式失败
  console.error('  FAIL: test daemon binary not found at', TEST_BIN, '— install malong-parse (SKIP was silent-green)')
  process.exit(1)
}
const TEST_PORT = 31000 + (process.pid % 20000)
const SOCK = IS_WIN ? '' : join(os.tmpdir(), 'opencode', `s3-test-${process.pid}.sock`)
if (IS_WIN) process.env.MALONG_PORT = String(TEST_PORT)
else process.env.MALONG_SOCKET = SOCK
process.env.MALONG_PARSE_BIN = TEST_BIN
const daemon = spawn(TEST_BIN, [], { stdio: 'ignore', detached: true })
daemon.unref()
const tryConnect = () => new Promise((resolve) => {
  const s = net.connect(TEST_PORT, '127.0.0.1')
  s.once('connect', () => { s.destroy(); resolve(true) })
  s.once('error', () => resolve(false))
})
const isReady = async () => IS_WIN ? await tryConnect() : existsSync(SOCK)
for (let i = 0; i < 30 && !(await isReady()); i++) {
  await new Promise(r => setTimeout(r, 200))
}
if (!(await isReady())) {
  console.error('  FAIL: test daemon not ready (TCP', TEST_PORT, ')')
  process.exit(1)
}

const { CodeIndexService } = await import(pathToFileURL(join(__dirname, '..', 'code-index.js')).href)
const langParser = await import(pathToFileURL(join(__dirname, '..', 'lang-parser.js')).href)

const ws = join(os.tmpdir(), 'opencode', 'vr-test-ws')
const data = join(os.tmpdir(), 'opencode', 'vr-test-data')
const sock = join(os.tmpdir(), 'opencode', `vr-test-${process.pid}.sock`)
try { rmSync(ws, { recursive: true, force: true }) } catch {}
try { rmSync(data, { recursive: true, force: true }) } catch {}
for (const d of [ws, data]) mkdirSync(d, { recursive: true })

// code-index 初始化（对齐 test-dogfood-r30 模式）
const pc = await import(pathToFileURL(join(__dirname, '..', 'parse-client.js')).href)
await pc.init({ log: () => {} })
const { default: codeIndex } = await import(pathToFileURL(join(__dirname, '..', 'code-index.js')).href)
const lp = {
  extractAllAsync: (source, ext, filePath, ws) => pc.extractAll(source, ext, filePath, ws),
  extractReferencesAsync: (source, ext) => pc.extractReferences(source, ext),
  batchExtractAsync: (files, ws) => pc.batchExtract(files, ws),
}
const services = { langParser: lp }
const core = {
  services,
  getService: (n) => services[n],
  registerService: (n, svc) => { services[n] = svc },
  getWorkspaceDir: () => data,
  log: () => {},
  emit: () => {},
  get: (key, def) => key === 'codeIndex.udsPath' ? sock : (key === 'codeIndex.udsToken' ? '' : def),
}
await codeIndex.init(core)
const svc = services.codeIndex
await svc.initWorkspace(ws)

// ── ① Rust daemon 直接输出：use/assign 存在，属性/局部/调用名排除 ──
{
  const src = "const MAX_RETRY = 5;\nlet config = {};\n\nfunction useIt() {\n  if (count > MAX_RETRY) { return MAX_RETRY }\n  config = { a: 1 };\n  config.count = 2;\n  let local = 1;\n  return local + config.a;\n}\n"
  const refs = await lp.extractReferencesAsync(src, '.js')
  assert(refs.some(r => r.type === 'use' && r.name === 'MAX_RETRY'), `① MAX_RETRY use ref（得 ${JSON.stringify(refs.filter(r => r.name === 'MAX_RETRY'))}）`)
  assert(refs.some(r => r.type === 'assign' && r.name === 'config'), `① config assign ref（得 ${JSON.stringify(refs.filter(r => r.name === 'config'))}）`)
  assert(!refs.some(r => r.name === 'local'), `① 局部变量 local 不追踪（得 ${JSON.stringify(refs.filter(r => r.name === 'local'))}）`)
  assert(!refs.some(r => r.name === 'count'), `① 属性访问 count 不追踪（得 ${JSON.stringify(refs.filter(r => r.name === 'count'))}）`)
  assert(!refs.some(r => r.type === 'use' && r.name === 'useIt'), `① 调用名 useIt 不重复（得 ${JSON.stringify(refs.filter(r => r.name === 'useIt'))}）`)
}

// ── ② code-index 入库：use/assign → refs 表，同文件绑定 target_symbol_id ──
{
  const src = "const THRESHOLD = 10;\nfunction check(v) {\n  return v > THRESHOLD;\n}\n"
  const f = join(ws, 'a.js')
  writeFileSync(f, src)
  await svc.indexFile(f, ws)
  const refs = await svc.getReferences('THRESHOLD')
  assert(Array.isArray(refs) && refs.length >= 1, `② references(THRESHOLD) 有引用（得 ${JSON.stringify(refs)}）`)
  const useRef = refs.find(r => r.kind === 'use')
  assert(useRef && useRef.target_name === 'THRESHOLD', `② use ref 指向 THRESHOLD（得 ${JSON.stringify(useRef)}）`)
}

// ── ③ 跨文件：b.js 读 a.js 的常量 → 跨文件解析绑定 ──
{
  const srcA = "export const API_TIMEOUT = 3000;\n"
  const srcB = "import { API_TIMEOUT } from './a.js';\nfunction wait() {\n  return API_TIMEOUT * 2;\n}\n"
  writeFileSync(join(ws, 'a.js'), srcA)
  writeFileSync(join(ws, 'b.js'), srcB)
  await svc.indexFile(join(ws, 'a.js'), ws)
  await svc.indexFile(join(ws, 'b.js'), ws)
  const refs = await svc.getReferences('API_TIMEOUT')
  assert(Array.isArray(refs) && refs.some(r => r.kind === 'use' && r.target_name === 'API_TIMEOUT'), `③ 跨文件 use ref（得 ${JSON.stringify(refs)}）`)
  assert(refs.some(r => r.path && String(r.path).includes('b.js')), `③ use 源文件是 b.js（得 ${JSON.stringify(refs.map(r => r.path))}）`)
  const bUses = refs.filter(r => r.kind === 'use')
  assert(bUses.length === 1 && bUses[0].line === 3, `③ import 声明行不算 use，仅函数体 use（得 ${JSON.stringify(bUses)}）`)
}

// ── ④ 非 JS 语言不受影响（Python 无 use/assign 新行为，不回归） ──
{
  const src = "import os\nMAX = 5\n\ndef f():\n    return MAX\n"
  const refs = await lp.extractReferencesAsync(src, '.py')
  assert(!refs.some(r => r.type === 'use' || r.type === 'assign'), `④ Python 不产生 use/assign（得 ${JSON.stringify(refs.filter(r => r.type !== 'call' && r.type !== 'import'))}）`)
}

try { rmSync(ws, { recursive: true, force: true }) } catch {}
try { rmSync(SOCK, { force: true }) } catch {}
try { daemon.kill() } catch {}
console.log(`== test-variable-refs: ${pass} passed, ${fail} failed ==`)
process.exit(fail > 0 ? 1 : 0)
