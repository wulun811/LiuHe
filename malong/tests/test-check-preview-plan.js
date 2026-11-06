// test-check-preview-plan.js — F1 + F3：预览必须给出真实命令；索引进度不得被读成「没有索引」
//
// 来源：2026-10-29 我自己当用户试用（review/semantic-perception-v1/05-G2C-SELF-TRIAL.md）。
//
// F1：code_check(run=false) 只回 "Preview: 1 check(s) [test] requested"，**不给实际命令行**。
//     本仓规定全链测试必须进 4G 内存围栏（否则 OOM 会杀用户终端），所以无法在运行前知道
//     它跑的是单文件还是整条 10 分钟链 → 守纪律的 LLM 无法使用 code_check(run=true)。
//     修法：预览返回 would_run[{kind, will_run, command, cwd}]，不执行。
//
// F3：code_task 返回 index.files_indexed=0，但索引其实是最新的（后续 index_status=fresh）。
//     files_indexed 是「本次写入的文件数」，被读成「索引里有几个文件」→ 0 被读成「没建索引」，
//     进而怀疑后续所有结果。修法：加 index_state（indexed / fresh_noop）+ 显式别名。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP = join(os.tmpdir(), 'opencode', 'f1f3-preview-test')
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
process.env.MALONG_STATE_DIR = join(TMP, 'state')
process.env.MALONG_ENTRY_STATE = '1'

let pass = 0, fail = 0
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  FAIL:', msg) } }

const M = join(__dirname, '..')
const vp = await import(pathToFileURL(join(M, 'tools', 'tool-verify-pipeline', 'handler.js')).href)
const shared = await import(pathToFileURL(join(M, 'tools', 'entry-shared.js')).href)
const check = await import(pathToFileURL(join(M, 'tools', 'tool-code-check', 'handler.js')).href)

function mkWs(name, pkg) {
  const ws = join(TMP, name)
  mkdirSync(ws, { recursive: true })
  if (pkg) writeFileSync(join(ws, 'package.json'), JSON.stringify(pkg))
  return ws
}
function mkTask(ws, id) {
  const t = { task_id: id, revision: 1, route: 'change', lifecycle: 'active', node: 'edit', materials: [], operations: [], evidence: [], workspace_dir: ws }
  shared.putTask(ws, t, { type: 'task_created', task: t })
  return t
}

// ── F1-a：有 test 脚本 → 预览必须给出 `npm run test` ──
{
  const ws = mkWs('npm', { name: 'npm', scripts: { test: 'node tests/t.test.js' } })
  assert(typeof vp.previewStagePlan === 'function', 'F1-a previewStagePlan 必须导出')
  if (typeof vp.previewStagePlan === 'function') {
    const plan = vp.previewStagePlan(ws, ws, ['test'])
    assert(Array.isArray(plan) && plan.length === 1, `F1-a 返回 1 条计划（得 ${JSON.stringify(plan)}）`)
    assert(plan[0]?.will_run === true, `F1-a will_run=true（得 ${JSON.stringify(plan[0])}）`)
    assert(/npm run test$/.test(String(plan[0]?.command)), `F1-a command 必须是 "npm run test"（得 ${JSON.stringify(plan[0]?.command)}）`)
  }
}

// ── F1-b：无 test 脚本且非 pytest → will_run=false 且给出原因（不得静默跳过）──
{
  const ws = mkWs('notest', { name: 'notest', scripts: {} })
  if (typeof vp.previewStagePlan === 'function') {
    const plan = vp.previewStagePlan(ws, ws, ['test'])
    assert(plan[0]?.will_run === false, `F1-b will_run=false（得 ${JSON.stringify(plan[0])}）`)
    assert(plan[0]?.reason === 'no_test_target', `F1-b reason=no_test_target（得 ${JSON.stringify(plan[0]?.reason)}）`)
    assert(typeof plan[0]?.notice === 'string' && plan[0].notice.length > 0, 'F1-b 必须给 notice（说明没有东西可跑）')
  }
}

// ── F1-c：typecheck 无 tsconfig → will_run=false + 原因 ──
{
  const ws = mkWs('notsc', { name: 'notsc', scripts: {} })
  if (typeof vp.previewStagePlan === 'function') {
    const plan = vp.previewStagePlan(ws, ws, ['typecheck'])
    assert(plan[0]?.will_run === false, `F1-c will_run=false（得 ${JSON.stringify(plan[0])}）`)
    assert(typeof plan[0]?.reason === 'string' && plan[0].reason.length > 0, 'F1-c 必须给不可执行原因')
  }
}

// ── F1-d：code_check 预览必须把 would_run 带出来（否则调用方还是不知道跑什么）──
{
  const ws = mkWs('handler', { name: 'handler', scripts: { test: 'node tests/t.test.js' } })
  mkdirSync(join(ws, 'tests'), { recursive: true })
  writeFileSync(join(ws, 'tests', 't.test.js'), "console.log('1 passing')\n")
  const t = mkTask(ws, 'task_f1d')
  const r = await check.handle({ workspace_dir: ws, task_id: t.task_id, checks: ['test'], run: false }, {})
  const obs = r?.observation || {}
  assert(obs.effect === 'preview', `F1-d effect=preview（得 ${JSON.stringify(obs.effect)}）`)
  assert(Array.isArray(obs.would_run) && obs.would_run.length === 1,
    `F1-d 预览必须带 would_run（得 ${JSON.stringify(Object.keys(obs))}）`)
  assert(/npm run test$/.test(String(obs.would_run?.[0]?.command)),
    `F1-d would_run[0].command 必须是真实命令（得 ${JSON.stringify(obs.would_run?.[0]?.command)}）`)
  assert(/run test/.test(String(obs.summary)),
    `F1-d summary 也要点出命令（得 ${JSON.stringify(obs.summary)}）`)
}

// ── F3：索引已最新时必须是 fresh_noop，不是「0 个文件」──
{
  const ws = mkWs('idx', { name: 'idx', scripts: {} })
  writeFileSync(join(ws, 'a.js'), 'export const a = 1\n')
  const noopSvc = { initWorkspace: async () => {}, indexBatch: async () => [] }
  const r1 = await shared.ensureIndexed(noopSvc, ws)
  assert(r1.index_state === 'fresh_noop', `F3-a 无变更 → index_state=fresh_noop（得 ${JSON.stringify(r1.index_state)}）`)
  assert(r1.files_indexed_this_run === 0, `F3-a files_indexed_this_run=0（得 ${JSON.stringify(r1.files_indexed_this_run)}）`)
  assert(typeof r1.index_state_note === 'string' && /already|up to date|fresh/i.test(r1.index_state_note),
    `F3-a 必须给出说明，避免把 0 读成「没有索引」（得 ${JSON.stringify(r1.index_state_note)}）`)

  const idxSvc = { initWorkspace: async () => {}, indexBatch: async () => ['a.js'] }
  const r2 = await shared.ensureIndexed(idxSvc, ws)
  assert(r2.index_state === 'indexed', `F3-b 有变更 → index_state=indexed（得 ${JSON.stringify(r2.index_state)}）`)
  assert(r2.files_indexed_this_run === 1, `F3-b files_indexed_this_run=1（得 ${JSON.stringify(r2.files_indexed_this_run)}）`)
}

try { rmSync(TMP, { recursive: true, force: true }) } catch {}
console.log(`== test-check-preview-plan: ${pass} passed, ${fail} failed ==`)
process.exit(fail > 0 ? 1 : 0)
