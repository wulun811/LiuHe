// test-test-bridge-run.js — test_bridge run 真实执行（r42 异步化回归）
// 覆盖：pytest pass+fail 计数 / stdout+stderr 合并（2>&1 剥离后语义等价）/
//       exitCode 透传 / 失败时 raw_hint 不丢失
import { join, dirname } from 'node:path'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}

const WS = join(os.tmpdir(), 'opencode', 'b13-tb-run-ws')
try { rmSync(WS, { recursive: true, force: true }) } catch {}
mkdirSync(WS, { recursive: true })
writeFileSync(join(WS, 'pytest.ini'), '')
writeFileSync(join(WS, 'test_demo.py'), [
  'def test_ok():',
  '    assert 1 + 1 == 2',
  '',
  'def test_bad():',
  '    import sys',
  '    print("stderr line to stderr", file=sys.stderr)',
  '    assert 1 == 2',
  '',
].join('\n'))

const { handle } = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-test-bridge', 'handler.js')).href)

// ① run pytest：pass/fail 计数正确（异步 execFile 通路）
{
  const r = await handle({ action: 'run', workspace_dir: WS, framework: 'pytest', scope: '.', timeout: 60 }, {})
  assert(r.summary?.passed === 1, `① passed=1（得 ${r.summary?.passed}）`)
  assert(r.summary?.failed === 1, `① failed=1（得 ${r.summary?.failed}）`)
  assert(r.summary?.total === 2, `① total=2（得 ${r.summary?.total}）`)
  assert(r.exit_code !== 0, `① 失败 → exit_code 非 0（得 ${r.exit_code}）`)
}
// ② 失败信息透出（r42 合并语义下 stdout+stderr 都被 parser 消费，与 execSync 等价）
{
  const r = await handle({ action: 'run', workspace_dir: WS, framework: 'pytest', scope: '.', timeout: 60 }, {})
  assert(Array.isArray(r.failures) && r.failures.length === 1, `② failures 数组 length=1（得 ${JSON.stringify(r.failures?.length)}）`)
  assert(r.failures?.[0]?.test === 'test_bad', `② failures 定位到 test_bad（得 ${r.failures?.[0]?.test}）`)
  assert(r.results?.some(x => x.file === 'test_demo.py' && x.status === 'failed'), `② results 含 test_demo.py::failed（得 ${JSON.stringify(r.results?.map(x => x.file + ':' + x.status))}）`)
  assert(r.run_error === undefined, `② 有解析结果 → run_error 不占用（得 ${r.run_error}）`)
}
// ③ 全绿项目 exit_code=0
{
  const green = join(WS, 'green')
  mkdirSync(green, { recursive: true })
  writeFileSync(join(green, 'pytest.ini'), '')
  writeFileSync(join(green, 'test_green.py'), 'def test_g(): assert True\n')
  const r = await handle({ action: 'run', workspace_dir: green, framework: 'pytest', scope: '.', timeout: 60 }, {})
  assert(r.exit_code === 0, `③ 全绿 exit_code=0（得 ${r.exit_code}）`)
  assert(r.summary?.passed === 1, `③ passed=1（得 ${r.summary?.passed}）`)
}
// ④ r48: framework="node"（纯 node 脚本项目，文件 scope）
{
  const nd = join(WS, 'nd')
  mkdirSync(nd, { recursive: true })
  writeFileSync(join(nd, 'node_test.js'), 'console.log("node test ran")\nprocess.exit(0)\n')
  const r = await handle({ action: 'run', workspace_dir: nd, framework: 'node', scope: 'node_test.js', timeout: 60 }, {})
  assert(r.exit_code === 0, `④ node framework 文件 scope exit_code=0（得 ${r.exit_code}）`)
  assert(r.run_error === undefined, `④ 无 run_error（得 ${r.run_error}）`)
  // r51: node + '.' → unsupported + 引导 hint（此前跑 `node tests` 报莫名 MODULE_NOT_FOUND）
  const rDot = await handle({ action: 'run', workspace_dir: nd, framework: 'node', scope: '.', timeout: 60 }, {})
  assert(rDot.error === 'unsupported_framework' && rDot.message.includes('verify_pipeline'), `④b node + '.' → unsupported+hint（得 ${rDot.error}/${rDot.message?.slice(0, 60)}）`)
  // r10e(F2)：中文路径 scope 放行；注入字符仍拒
  const rZh = await handle({ action: 'run', workspace_dir: nd, framework: 'node', scope: '子目录/node_test.js', timeout: 60 }, {})
  assert(rZh.error !== 'invalid_input', `④c 中文 scope 放行（得 ${rZh.error || rZh.exit_code}）`)
  const rInj = await handle({ action: 'run', workspace_dir: nd, framework: 'node', scope: 'a.js; rm -rf /', timeout: 60 }, {})
  assert(rInj.error === 'invalid_input', `④d 注入字符仍拒（得 ${rInj.error}）`)
  // R22-⑦（拷打发现）：run 的 file 参数旧实现静默忽略；接入 scope 后恶意 file（../穿越）必须被 sanitizeScope 拦截
  const rFile = await handle({ action: 'run', workspace_dir: nd, framework: 'node', file: '../../../../etc/passwd', timeout: 60 }, {})
  assert(rFile.error === 'invalid_input', `④e 恶意 file 穿越拦截（得 ${rFile.error}）`)
  const rFileOk = await handle({ action: 'run', workspace_dir: nd, framework: 'node', file: 'node_test.js', timeout: 60 }, {})
  assert(rFileOk.exit_code === 0, `④f file 参数作为默认 scope 生效（得 ${rFileOk.exit_code}）`)
}

try { rmSync(WS, { recursive: true, force: true }) } catch {}

// ⑤ r10d：discover 三层覆盖——tests/ 目录但命名不合约定的测试文件经文本兜底扫出
{
  const dws = join(os.tmpdir(), 'opencode', 'b13-tb-discover-ws')
  try { rmSync(dws, { recursive: true, force: true }) } catch {}
  mkdirSync(join(dws, 'src'), { recursive: true })
  mkdirSync(join(dws, 'tests'), { recursive: true })
  writeFileSync(join(dws, 'src', 'health-check.js'), 'export function readUsageStats() { return 1 }\n')
  const before = await handle({ action: 'discover', workspace_dir: dws, file: 'src/health-check.js' }, {})
  assert(before.total === 0 && before.search_methods.includes('convention'), `⑤ 无测试文件 → 0（得 ${before.total}）`)
  writeFileSync(join(dws, 'tests', 'zz-custom.js'), 'import { readUsageStats } from \'../src/health-check.js\'\nit(\'finds me via text fallback\', () => { expect(readUsageStats()).toBe(1) })\n')
  const after = await handle({ action: 'discover', workspace_dir: dws, file: 'src/health-check.js' }, {})
  assert(after.total >= 1, `⑤ 文本兜底扫出非约定测试文件（得 ${after.total}）`)
  assert(after.tests.some(t => t.name === 'finds me via text fallback'), `⑤ 测试名正确（${JSON.stringify(after.tests.map(t => t.name))}）`)
  assert(after.search_methods.includes('import_graph/text_fallback'), `⑤ search_methods 标注 import 层（${JSON.stringify(after.search_methods)}）`)
  assert(after.tests.some(t => t.file === 'tests/zz-custom.js'), `⑤ 文件路径为实际测试文件`)
  try { rmSync(dws, { recursive: true, force: true }) } catch {}
}

// ⑥ r10e(F2)：裸 assert 风格兜底（malong 全量测试都是裸 assert 无 test() 包裹）+ 不存在文件错误透传
{
  const dws = join(os.tmpdir(), 'opencode', 'b13-tb-discover-ws2')
  try { rmSync(dws, { recursive: true, force: true }) } catch {}
  mkdirSync(join(dws, 'src'), { recursive: true })
  mkdirSync(join(dws, 'tests'), { recursive: true })
  writeFileSync(join(dws, 'src', 'util.js'), 'export const n = 1\n')
  writeFileSync(join(dws, 'tests', 'plain-assert.js'), 'import { n } from \'../src/util.js\'\nassert(n === 1, \'n is one\')\nassert(n > 0)\n')
  const r = await handle({ action: 'discover', workspace_dir: dws, file: 'src/util.js' }, {})
  assert(r.total >= 1, `⑥ 裸 assert 文件级兜底命中（得 ${r.total}）`)
  assert(r.tests.some(t => t.name === 'plain-assert' && t.line === 1), `⑥ 文件级条目名=basename（${JSON.stringify(r.tests)}）`)
  const missing = await handle({ action: 'discover', workspace_dir: dws, file: 'src/does-not-exist.js' }, {})
  assert(missing.total === 0, `⑥ 无 service 环境不触发守卫（得 ${missing.total}）`)
  const mockCtx = { codeIndexService: { resolveFileArg: () => ({ ok: false, error: { code: 'FILE_NOT_FOUND', message: 'No such file' } }) } }
  const missing2 = await handle({ action: 'discover', workspace_dir: dws, file: 'src/does-not-exist.js' }, mockCtx)
  assert(missing2.error === 'FILE_NOT_FOUND', `⑥ 有 service → 守卫错误透传（得 ${missing2.error || missing2.message}）`)
  try { rmSync(dws, { recursive: true, force: true }) } catch {}
}

console.log(`== test-test-bridge-run: ${pass} passed, ${fail} failed ==`)
if (fail > 0) process.exit(1)
