// test-r54-p2.js — 第七轮审计 P2 修复锁定（边界/低危）
// 覆盖：test_bridge node 目录 scope、security-review dotenv 空格密钥、exception-guard 注释三引号、
//       edit-sandbox 尾斜杠、verify-pipeline test 无脚本 skipped、active-todos scope .. 拒绝。
import { join, dirname } from 'node:path'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MALONG = dirname(__dirname)
const imp = (p) => import(pathToFileURL(p).href)

let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++; console.log(`  \u2713 ${msg}`) } else { fail++; console.error(`  \u2717 FAIL: ${msg}`) }
}
const tmp = (tag) => {
  const ws = join(os.tmpdir(), 'opencode', `r54-p2-${tag}-${process.pid}`)
  try { rmSync(ws, { recursive: true, force: true }) } catch {}
  mkdirSync(ws, { recursive: true })
  return ws
}

// ── test_bridge：node 目录 scope → unsupported + hint ──
console.log('\u2500\u2500 test_bridge node \u76ee\u5f55 scope \u2500\u2500')
{
  const { handle } = await imp(join(MALONG, 'tools/tool-test-bridge/handler.js'))
  const ws = tmp('tbridge')
  mkdirSync(join(ws, 'tests'), { recursive: true })
  writeFileSync(join(ws, 'tests', 'a.test.js'), 'console.log("x")\n')
  let r = await handle({ action: 'run', workspace_dir: ws, framework: 'node', scope: 'tests' }, {})
  assert(r.error === 'unsupported_framework' && /test file scope/.test(r.message || ''), `node \u76ee\u5f55 scope \u5e94 unsupported+hint\uff08\u5f97 ${r.error}\uff09`)
  try { rmSync(ws, { recursive: true, force: true }) } catch {}
}

// ── security-review：dotenv 引号含空格密钥 ──
console.log('\u2500\u2500 security-review dotenv \u7a7a\u683c\u5bc6\u94a5 \u2500\u2500')
{
  const { handle } = await imp(join(MALONG, 'tools/tool-security-review/handler.js'))
  const ws = tmp('dotenv')
  writeFileSync(join(ws, '.env'), 'API_SECRET="my secret value here"\n')
  const r = await handle({ workspace_dir: ws, file: '.env' }, {})
  assert((r.findings || []).some(f => f.id === 'dotenv-secret'), `\u5f15\u53f7\u542b\u7a7a\u683c\u5bc6\u94a5\u5e94\u88ab\u68c0\u51fa\uff08\u5f97 ${JSON.stringify((r.findings || []).map(f => f.id))}\uff09`)
  try { rmSync(ws, { recursive: true, force: true }) } catch {}
}

// ── exception-guard：行尾注释内三引号不干扰 raise 检测 ──
console.log('\u2500\u2500 exception-guard \u6ce8\u91ca\u4e09\u5f15\u53f7 \u2500\u2500')
{
  const { handle } = await imp(join(MALONG, 'tools/tool-exception-guard/handler.js'))
  const ws = tmp('excguard')
  // 行尾注释里的 """ 不应把状态机置 inString，其后的 raise 仍应被检出
  writeFileSync(join(ws, 'a.py'), 'x = 1  # TODO: """\nraise ValueError("bad")\n')
  const r = await handle({ workspace_dir: ws, file: 'a.py' }, {})
  const checked = r.summary?.raises_checked ?? 0
  assert(checked >= 1, `\u6ce8\u91ca\u540e\u7684 raise \u5e94\u88ab\u68c0\u51fa\uff08raises_checked=${checked}\uff09`)
  try { rmSync(ws, { recursive: true, force: true }) } catch {}
}

// ── edit-sandbox：尾斜杠 workspace 不误拒 ──
console.log('\u2500\u2500 edit-sandbox \u5c3e\u659c\u6760 \u2500\u2500')
{
  const { handle } = await imp(join(MALONG, 'tools/tool-edit-sandbox/handler.js'))
  const ws = tmp('sandbox')
  writeFileSync(join(ws, 'a.js'), 'const a = 1\n')
  const r = await handle({ workspace_dir: ws + '/', file: 'a.js', new_content: 'const a = 2\n' }, {})
  assert(!r.error, `\u5c3e\u659c\u6760 + \u5408\u6cd5 file \u4e0d\u5e94\u8bef\u62a5\u9003\u9038\uff08\u5f97 ${r.error}:${r.message}\uff09`)
}

// ── verify-pipeline：无 test 脚本 → skipped 而非空过 ──
console.log('\u2500\u2500 verify-pipeline test \u65e0\u811a\u672c skipped \u2500\u2500')
{
  const { handle } = await imp(join(MALONG, 'tools/tool-verify-pipeline/handler.js'))
  const ws = tmp('vpipeline')
  writeFileSync(join(ws, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }))
  const r = await handle({ workspace_dir: ws, stages: 'test' }, {})
  const testStage = (r.stages || []).find(s => s.stage === 'test') || r.test || r
  const skipped = testStage?.skipped === true || r.skipped === true || (r.results && r.results.test && r.results.test.skipped)
  assert(skipped || r.error, `\u65e0 test \u811a\u672c\u5e94 skipped\u800c\u975e\u5047 passed\uff08\u5f97 ${JSON.stringify(testStage || r).slice(0, 120)}\uff09`)
  try { rmSync(ws, { recursive: true, force: true }) } catch {}
}

// ── active-todos：scope .. 拒绝 ──
console.log('\u2500\u2500 active-todos scope .. \u62d2\u7edd \u2500\u2500')
{
  const { handle } = await imp(join(MALONG, 'tools/tool-active-todos/handler.js'))
  const ws = tmp('todos')
  const r = await handle({ workspace_dir: ws, scope: '../../etc' }, {})
  assert(r.error === 'invalid_input', `scope .. \u5e94 invalid_input\uff08\u5f97 ${r.error}\uff09`)
  try { rmSync(ws, { recursive: true, force: true }) } catch {}
}

console.log(`\n=== test-r54-p2: ${pass} passed, ${fail} failed ===`)
process.exit(fail > 0 ? 1 : 0)
