// test-decl-ranges.js — LH-003：多行声明符号范围端到端（隔离 daemon，不碰 live）
// 覆盖 JS/TS/Java/Go/Rust/Python 的变量/let/assignment 多行初始化器 range。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { existsSync, rmSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import os from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import net from 'node:net'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  FAIL:', msg) } }

const IS_WIN = process.platform === 'win32'
const TEST_BIN_CANDIDATES = [
  process.env.MALONG_PARSE_BIN,
  join(__dirname, '..', '..', 'malong-parse', 'target', 'debug', IS_WIN ? 'malong-parse.exe' : 'malong-parse'),
  join(__dirname, '..', '..', 'malong-parse', 'target', 'release', IS_WIN ? 'malong-parse.exe' : 'malong-parse'),
  join(os.homedir(), '.local', 'bin', IS_WIN ? 'malong-parse.exe' : 'malong-parse'),
].filter(Boolean)
const TEST_BIN = TEST_BIN_CANDIDATES.find(p => existsSync(p))
if (!TEST_BIN) {
  console.error('  FAIL: test daemon binary not found (tried: ' + TEST_BIN_CANDIDATES.join(' | ') + ')')
  process.exit(1)
}
const TEST_PORT = 31000 + (process.pid % 20000)
const SOCK = IS_WIN ? '' : join(os.tmpdir(), 'opencode', 'decl-ranges-' + process.pid + '.sock')
if (IS_WIN) process.env.MALONG_PORT = String(TEST_PORT)
else process.env.MALONG_SOCKET = SOCK
process.env.MALONG_PARSE_BIN = TEST_BIN
// 诊断（专家复核 §五：原版全链第 128 个命令 test-decl-ranges 报 daemon not ready，且无现场）：
// daemon 的 stdout/stderr 落盘；失败时打印退出码/socket|端口/等待时长/是否重拉/日志尾部，不靠猜。
const DIAG_DIR = join(os.tmpdir(), 'opencode')
try { mkdirSync(DIAG_DIR, { recursive: true }) } catch {}
const DIAG_LOG = join(DIAG_DIR, 'decl-ranges-daemon-' + process.pid + '.log')
let diagFd = null
try { diagFd = openSync(DIAG_LOG, 'a') } catch {}
const spawnDaemon = () => {
  let child
  try {
    child = spawn(TEST_BIN, [], { stdio: ['ignore', diagFd == null ? 'ignore' : diagFd, diagFd == null ? 'ignore' : diagFd], detached: true, windowsHide: true })
  } catch (e) {
    console.error('  FAIL: daemon spawn threw: ' + (e && e.message))
    process.exit(1)
  }
  child.unref()
  return child
}
let daemon = spawnDaemon()
const tryConnect = () => new Promise((resolve) => {
  const s = net.connect(TEST_PORT, '127.0.0.1')
  s.once('connect', () => { s.destroy(); resolve(true) })
  s.once('error', () => resolve(false))
})
const isReady = async () => IS_WIN ? await tryConnect() : existsSync(SOCK)
const daemonStarted = Date.now()
let respawned = false
// 等待上限 20s（原 6s）：慢机/Windows 冷启动不误报；进程早退时立即重拉一次并留证据
for (let i = 0; i < 80 && !(await isReady()); i++) {
  if (!respawned && daemon.exitCode != null) {
    respawned = true
    daemon = spawnDaemon()
  }
  await new Promise(r => setTimeout(r, 250))
}
if (!(await isReady())) {
  let tail = ''
  try { tail = readFileSync(DIAG_LOG, 'utf8').split(String.fromCharCode(10)).slice(-20).join(String.fromCharCode(10)) } catch {}
  console.error('  FAIL: test daemon not ready after ' + (Date.now() - daemonStarted) + 'ms')
  console.error('    bin=' + TEST_BIN + ' pid=' + (daemon.pid || null) + ' exit=' + (daemon.exitCode != null ? daemon.exitCode : 'running') + (daemon.signalCode ? ' signal=' + daemon.signalCode : ''))
  console.error('    ' + (IS_WIN ? 'port=' + TEST_PORT : 'socket=' + SOCK + ' exists=' + existsSync(SOCK)))
  console.error('    respawned=' + respawned + ' log=' + DIAG_LOG)
  if (tail) console.error('    daemon log tail:' + String.fromCharCode(10) + tail)
  process.exit(1)
}

const pc = await import(pathToFileURL(join(__dirname, '..', 'parse-client.js')).href)
await pc.connect()
const rangeOf = (symbols, name) => {
  const s = symbols.find(x => x.name === name)
  return s ? [s.startLine, s.endLine] : null
}

// ── 1. JS：对象/数组/箭头/多声明 ──
{
  const src = [
    'const cfg = {', '  a: 1,', '  b: 2,', '};',
    'let arr = [', '  1,', '  2,', '];',
    'const fnValue = () => {', '  return 1;', '};',
    'const a = 1, b = 2;', '',
  ].join(String.fromCharCode(10))
  const r = await pc.extractAll(src, '.js')
  assert(JSON.stringify(rangeOf(r.symbols, 'cfg')) === '[1,4]', 'JS cfg 多行对象范围 [1,4]（得 ' + JSON.stringify(rangeOf(r.symbols, 'cfg')) + '）')
  assert(JSON.stringify(rangeOf(r.symbols, 'arr')) === '[5,8]', 'JS arr 多行数组范围 [5,8]（得 ' + JSON.stringify(rangeOf(r.symbols, 'arr')) + '）')
  assert(JSON.stringify(rangeOf(r.symbols, 'fnValue')) === '[9,11]', 'JS 箭头函数体范围 [9,11]（得 ' + JSON.stringify(rangeOf(r.symbols, 'fnValue')) + '）')
  assert(JSON.stringify(rangeOf(r.symbols, 'a')) === '[12,12]' && JSON.stringify(rangeOf(r.symbols, 'b')) === '[12,12]', 'JS 多声明各自范围 [12,12]（得 ' + JSON.stringify([rangeOf(r.symbols, 'a'), rangeOf(r.symbols, 'b')]) + '）')
  const rs = await pc.extractSymbols(src, '.js')
  assert(JSON.stringify(rangeOf(rs.symbols, 'cfg')) === '[1,4]', 'JS extract_symbols 同范围（得 ' + JSON.stringify(rangeOf(rs.symbols, 'cfg')) + '）')
  const slice = src.split(String.fromCharCode(10)).slice(0, 4).join(String.fromCharCode(10))
  assert(slice.trimEnd().endsWith('};'), '范围切片覆盖完整声明（写路径同范围前提）')
}

// ── 2. TS ──
{
  const src = ['const tsCfg: Record<string, number> = {', '  a: 1,', '};', ''].join(String.fromCharCode(10))
  const r = await pc.extractAll(src, '.ts')
  assert(JSON.stringify(rangeOf(r.symbols, 'tsCfg')) === '[1,3]', 'TS 多行对象范围 [1,3]（得 ' + JSON.stringify(rangeOf(r.symbols, 'tsCfg')) + '）')
}

// ── 3. Java ──
{
  const src = [
    '', 'class A {', '    int single = 1;', '    String multi = "a"', '        + "b"', '        + "c";', '    void m() {}', '}', '',
  ].join(String.fromCharCode(10))
  const r = await pc.extractAll(src, '.java')
  assert(JSON.stringify(rangeOf(r.symbols, 'single')) === '[3,3]', 'Java 单行声明 [3,3]（得 ' + JSON.stringify(rangeOf(r.symbols, 'single')) + '）')
  assert(JSON.stringify(rangeOf(r.symbols, 'multi')) === '[4,6]', 'Java 多行初始化器 [4,6]（得 ' + JSON.stringify(rangeOf(r.symbols, 'multi')) + '）')
}

// ── 4. Go（var_spec + 短变量声明）──
{
  const src = [
    'var cfg = map[string]int{', '    "a": 1,', '    "b": 2,', '}', '',
    'func main() {', '    x, y := pair(', '        1,', '        2,', '    )', '    _ = x', '    _ = y', '}', '',
  ].join(String.fromCharCode(10))
  const r = await pc.extractAll(src, '.go')
  assert(JSON.stringify(rangeOf(r.symbols, 'cfg')) === '[1,4]', 'Go var 多行复合字面量 [1,4]（得 ' + JSON.stringify(rangeOf(r.symbols, 'cfg')) + '）')
  assert(JSON.stringify(rangeOf(r.symbols, 'x')) === '[7,10]' && JSON.stringify(rangeOf(r.symbols, 'y')) === '[7,10]', 'Go 短变量声明整语句范围 [7,10]（得 ' + JSON.stringify([rangeOf(r.symbols, 'x'), rangeOf(r.symbols, 'y')]) + '）')
}

// ── 5. Rust ──
{
  const src = ['fn main() {', '    let cfg = vec![', '        1,', '        2,', '    ];', '}', ''].join(String.fromCharCode(10))
  const r = await pc.extractAll(src, '.rs')
  assert(JSON.stringify(rangeOf(r.symbols, 'cfg')) === '[2,5]', 'Rust let 多行初始化器 [2,5]（得 ' + JSON.stringify(rangeOf(r.symbols, 'cfg')) + '）')
}

// ── 6. Python（确认：assignment 整节点本就不截断）──
{
  const src = ['CONFIG = {', '    "a": 1,', '    "b": 2,', '}', 'RESULT = compute(', '    1,', '    2,', ')', ''].join(String.fromCharCode(10))
  const r = await pc.extractAll(src, '.py')
  assert(JSON.stringify(rangeOf(r.symbols, 'CONFIG')) === '[1,4]', 'Python dict 赋值 [1,4]（得 ' + JSON.stringify(rangeOf(r.symbols, 'CONFIG')) + '）')
  assert(JSON.stringify(rangeOf(r.symbols, 'RESULT')) === '[5,8]', 'Python 调用赋值 [5,8]（得 ' + JSON.stringify(rangeOf(r.symbols, 'RESULT')) + '）')
}

console.log('=== test-decl-ranges: ' + pass + ' passed, ' + fail + ' failed ===')
// 复审债务修复（0.5.11）：本用例 spawn 的 daemon 是 detached —— 旧实现直接 process.exit 会遗留进程，
// 后续 cargo build 抢不到 exe（Windows exit101 拒绝访问，曾被误读为权限问题）。
// 收口：先断开客户端连接，再同步杀本进程启动的 daemon（只杀自己拉起的 PID，不碰 live 服务）。
function stopTestDaemon() {
  try { pc.disconnect?.() } catch {}
  try {
    if (IS_WIN) {
      // 无 POSIX 进程组：按 PID 精确杀（spawn 自本进程，detached 仅为脱离控制台）
      spawnSync('taskkill', ['/PID', String(daemon.pid), '/F'], { stdio: 'ignore' })
    } else {
      process.kill(daemon.pid, 'SIGTERM')
    }
  } catch { /* 已退出/无权限：不阻塞测试结论 */ }
  try { if (SOCK && existsSync(SOCK)) rmSync(SOCK, { force: true }) } catch {}
}
stopTestDaemon()
process.exit(fail > 0 ? 1 : 0)
