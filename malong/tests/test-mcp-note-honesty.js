// test-mcp-note-honesty.js — 超时预报必须与真实结果一致（B7）
//
// 背景：DSH 实录 2026-11-02 回报的真实 evidence（ev_1081bc2e）：
//   kind: typecheck, result: passed, ran: true, exit_code: 0, duration_ms: 3932
//   actual.notice: "MCP request has a 120s hard timeout: 1 stages × 110s budget = 110s,
//                   will definitely time out. ..."
//
// **3.9 秒成功跑完，预报说"必然超时"**。DSH 把它记为"文案小噪音"，我不这么看：
// 预报与结果自相矛盾时，调用方下次看到 failed 会先怀疑是不是又被这条文案骗了——
// 这正是"工具跑不动"被报成"被测对象坏了"的同形问题（D-204/D-215 那一类）。
//
// 根因：判据是 `wanted.length * timeout > 100s`，而单阶段 timeout 已被上钳到 110s，
// 于是 **1 × 110s > 100s 恒成立** → 单阶段必然误报。是判据错，不是文案问题。
//
// 判据：
//   ① 单阶段（无论 timeout 传多大）→ 不得出现"必然超时"预报（钳位后不可能超）
//   ② 多阶段叠超 100s → 必须预报（这正是它存在的意义，不能改坏）
//   ③ background 模式 → 不预报（本来就不占 MCP 请求槽）
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP = join(os.tmpdir(), 'opencode', 'mcp-note-honesty')
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
process.env.MALONG_STATE_DIR = join(TMP, 'state')
process.env.MALONG_ENTRY_STATE = '1'

let pass = 0, fail = 0
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  FAIL:', msg) } }
const imp = (p) => import(pathToFileURL(join(__dirname, '..', p)).href)

const vp = await imp('tools/tool-verify-pipeline/handler.js')

function mkWs(name, pkg) {
  const ws = join(TMP, name)
  mkdirSync(ws, { recursive: true })
  writeFileSync(join(ws, 'package.json'), JSON.stringify(pkg))
  return ws
}
// 极短的假脚本：验证的是"预报是否与预算自洽"，不需要真跑久
const FAST_PKG = {
  name: 'x', version: '1.0.0',
  scripts: { lint: 'node -e "process.exit(0)"' },
}

// ── ① 单阶段 + 传超大 timeout → 不得预报"必然超时"（钳位后不可能超）──
{
  const ws = mkWs('single', FAST_PKG)
  const r = await vp.handle({ workspace_dir: ws, stages: 'lint', timeout: 300000 }, {})
  assert(!r.error, `① 单阶段应正常执行（得 ${r.error || 'ok'}）`)
  assert(!r.mcp_note, `① 单阶段不得出现"必然超时"预报（得 ${JSON.stringify(r.mcp_note)}）`)
  // 单阶段 timeout 仍应被钳到 110s（这个行为不能一起改坏）
  assert(r.timeout_ms === 110000, `① 单阶段 timeout 仍钳到 110000（得 ${r.timeout_ms}）`)
}

// ── ② 多阶段叠超 100s → 必须预报（这条不能改坏）──
{
  const ws = mkWs('multi', {
    name: 'x', version: '1.0.0',
    scripts: { lint: 'node -e "process.exit(0)"', typecheck: 'node -e "process.exit(0)"', test: 'node -e "process.exit(0)"' },
  })
  const r = await vp.handle({ workspace_dir: ws, stages: 'lint,typecheck,test', timeout: 300000 }, {})
  assert(!r.error, '② 多阶段应正常执行')
  assert(typeof r.mcp_note === 'string' && /120s hard timeout/.test(r.mcp_note),
    `② 多阶段叠超 100s 必须预报（得 ${JSON.stringify(r.mcp_note)}）`)
  assert(/3 stages/.test(r.mcp_note), `② 预报应说明是 3 阶段叠加（得 ${r.mcp_note}）`)
}

// ── ③ 两阶段叠超 → 也要预报（不是只有三阶段才报）──
{
  const ws = mkWs('two', {
    name: 'x', version: '1.0.0',
    scripts: { lint: 'node -e "process.exit(0)"', typecheck: 'node -e "process.exit(0)"' },
  })
  const r = await vp.handle({ workspace_dir: ws, stages: 'lint,typecheck', timeout: 300000 }, {})
  assert(!r.error, '③ 两阶段应正常执行')
  assert(typeof r.mcp_note === 'string', `③ 2 × 110s = 220s 超预算，必须预报（得 ${JSON.stringify(r.mcp_note)}）`)
}

// ── ④ background 模式 → 不预报（不占 MCP 请求槽）──
{
  const ws = mkWs('bg', {
    name: 'x', version: '1.0.0',
    scripts: { lint: 'node -e "process.exit(0)"', typecheck: 'node -e "process.exit(0)"', test: 'node -e "process.exit(0)"' },
  })
  const r = await vp.handle({ workspace_dir: ws, stages: 'lint,typecheck,test', timeout: 300000 }, { background: true })
  assert(!r.mcp_note, `④ background 不得预报（得 ${JSON.stringify(r.mcp_note)}）`)
}

// ── ⑤ 单阶段传小 timeout（远小于预算）→ 本就该静默 ──
{
  const ws = mkWs('small', FAST_PKG)
  const r = await vp.handle({ workspace_dir: ws, stages: 'lint', timeout: 5000 }, {})
  assert(!r.mcp_note, '⑤ 单阶段小 timeout 不得预报')
}

// ── ⑥ 证据必须能区分「被超时杀」与「自己退出 1」（B7）──
//    DSH 最初那条 failed 证据：duration_ms=105860、exit_code=1、**actual 里没有 timed_out**。
//    旧实现只在 stage.timed_out 为真时写 timed_out，于是 killed 但 timed_out 未置位的路径
//    在证据里什么都不留——调用方只能猜"是超时还是真失败"。
//    killed 与 timed_out 必须分别出现在 actual 里。
{
  const ws = mkWs('dist', {
    name: 'x', version: '1.0.0',
    scripts: { lint: 'node -e "process.exit(1)"' },
  })
  const r = await vp.handle({ workspace_dir: ws, stages: 'lint', timeout: 30000 }, {})
  const st = r?.results?.lint
  assert(st && st.killed !== true, '⑥ 真失败不是 killed（得 ' + JSON.stringify(st && st.killed) + '）')
  assert(st && st.timed_out == null, '⑥ 真失败不置 timed_out（得 ' + JSON.stringify(st && st.timed_out) + '）')
  assert(st && st.exitCode === 1, '⑥ 真失败 exitCode=1（得 ' + JSON.stringify(st && st.exitCode) + '）')
}

// ── ⑦ 真超时：killed 与 timed_out 都要置位，且带 timeout_ms ──
{
  const ws = mkWs('realto', {
    name: 'x', version: '1.0.0',
    scripts: { lint: 'node -e "setTimeout(()=>{}, 60000)"' },
  })
  const r = await vp.handle({ workspace_dir: ws, stages: 'lint', timeout: 1500 }, {})
  const st = r?.results?.lint
  assert(st && st.killed === true, '⑦ 超时应 killed=true（得 ' + JSON.stringify(st && st.killed) + '）')
  assert(st && st.timed_out && st.timed_out.timeout_ms === 1500,
    '⑦ 超时应带 timed_out.timeout_ms（得 ' + JSON.stringify(st && st.timed_out) + '）')
  assert(st && st.passed === false, '⑦ 超时不算通过')
}

rmSync(TMP, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)

