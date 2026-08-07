// test-debug-runner.js — debug_runner 错误分类（r41）
// 覆盖：exit 0 永不判失败（"0 failed" 总结行误报回归）/ 非零退出按文本分类 /
//       timeout 优先 / handle 端到端（全绿命令不再被标 TestFailure）
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}
const { analyzeError, handle } = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-debug-runner', 'handler.js')).href)

// ── ① exit 0 永不判失败（即使输出含 "failed"/FAILED/Error 字样）──
{
  const r = analyzeError({ stdout: '77 passed, 0 failed\n== test-journal-prune: 21 passed, 0 failed ==\n', stderr: '[code-index] incremental logs', exitCode: 0 })
  assert(r.error_type === null, `① exit 0 + "0 failed" 不判失败（得 ${r.error_type}）`)
  assert(r.exit_code === 0, '① exit_code 透传 0')
  const r2 = analyzeError({ stdout: 'FAILED: all good though', stderr: '', exitCode: 0 })
  assert(r2.error_type === null, '① exit 0 + FAILED 字样仍不判失败（exit 优先）')
  const r3 = analyzeError({ stdout: 'SyntaxError: whatever', stderr: '', exitCode: 0 })
  assert(r3.error_type === null, '① exit 0 + SyntaxError 文本也不分类（干净退出=成功）')
}

// ── ② 非零退出按文本分类 ──
{
  const r = analyzeError({ stdout: 'tests failed', stderr: '', exitCode: 1 })
  assert(r.error_type === 'TestFailure', `② exit 1 + tests failed → TestFailure（得 ${r.error_type}）`)
  const r2 = analyzeError({ stdout: 'x', stderr: 'SyntaxError: unexpected token', exitCode: 2 })
  assert(r2.error_type === 'SyntaxError', `② exit 2 + SyntaxError → SyntaxError（得 ${r2.error_type}）`)
  const r3 = analyzeError({ stdout: '', stderr: 'AssertionError: 1 != 2', exitCode: 1 })
  assert(r3.error_type === 'AssertionError', `② AssertionError 分类（得 ${r3.error_type}）`)
  const r4 = analyzeError({ stdout: 'clean', stderr: '', exitCode: 3 })
  assert(r4.error_type === 'RuntimeError', `② 非零退出无匹配文本 → RuntimeError（得 ${r4.error_type}）`)
}

// ── ③ timeout 优先于 exit code ──
{
  const r = analyzeError({ stdout: '', stderr: '', exitCode: 0, timeout: true })
  assert(r.error_type === 'TimeoutError', '③ timeout 标志优先映射 TimeoutError')
}

// ── ④ handle 端到端：全绿命令不再被标 TestFailure（r41 复现回归） ──
{
  const ws = join(os.tmpdir(), 'opencode', 'dr-test-ws')
  mkdirSync(ws, { recursive: true })
  const isWin = process.platform === 'win32'
  // Windows 无 bash：用 cmd 内建等价命令（echo/& 重定向语义一致）
  const res = await handle({ command: isWin ? "echo 77 passed, 0 failed & echo [code-index] noise 1>&2" : "echo '77 passed, 0 failed'; echo '[code-index] noise' >&2", workspace_dir: ws }, {})
  assert(res.exit_code === 0, `④ 端到端 exit_code 0（得 ${res.exit_code}）`)
  assert(res.error_type === null, `④ 端到端全绿不再判失败（得 ${res.error_type}）`)
  assert(res.next_step === 'Command ran successfully.', '④ next_step 为成功文案')
  let bad
  if (isWin) {
    // cmd 下 node -e 引号会被 cmd 剥掉外双引号 → JS 里剩字符串字面量（exit 0 不分类）
    // script 模式走 process.execPath 参数化 spawn，无引号歧义
    writeFileSync(join(ws, 'boom.js'), "throw new TypeError('boom')\n")
    bad = await handle({ script: 'boom.js', workspace_dir: ws }, {})
    rmSync(join(ws, 'boom.js'), { force: true })
  } else {
    bad = await handle({ command: "node -e \"throw new TypeError('boom')\"", workspace_dir: ws }, {})
  }
  assert(bad.exit_code !== 0 && bad.error_type === 'TypeError', `④ 真失败仍正确分类 TypeError（得 ${bad.error_type}）`)
  try { rmSync(ws, { recursive: true, force: true }) } catch {}
}

// ── ⑤ r10e：cwd 参数——子目录脚本不必 cd 绕路径 ──
{
  const ws = join(os.tmpdir(), 'opencode', 'dr-cwd-ws')
  mkdirSync(join(ws, '0FTYcloud'), { recursive: true })
  const pwdCmd = process.platform === 'win32' ? 'echo %cd%' : 'pwd'
  const root = await handle({ command: pwdCmd, workspace_dir: ws }, {})
  assert(root.stdout.trim() === ws, `⑤ 默认 cwd=workspace_dir（得 ${root.stdout.trim()}）`)
  const sub = await handle({ command: pwdCmd, workspace_dir: ws, cwd: '0FTYcloud' }, {})
  assert(sub.stdout.trim() === join(ws, '0FTYcloud'), `⑤ cwd=0FTYcloud 生效（得 ${sub.stdout.trim()}）`)
  const esc = await handle({ command: 'pwd', workspace_dir: ws, cwd: '../outside' }, {})
  assert(esc.error === 'cwd_not_found', `⑤ 越界 cwd 拒绝（得 ${esc.error}）`)
  const notStr = await handle({ command: 'pwd', workspace_dir: ws, cwd: 42 }, {})
  assert(notStr.error === 'invalid_input', `⑤ 非字符串 cwd 拒绝（得 ${notStr.error}）`)
  try { rmSync(ws, { recursive: true, force: true }) } catch {}
}

console.log(`== test-debug-runner: ${pass} passed, ${fail} failed ==`)
if (fail > 0) process.exit(1)
