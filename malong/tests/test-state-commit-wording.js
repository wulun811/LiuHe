// test-state-commit-wording.js — 2026-11-05 发布前真机走查
//
// F36 只修了 code_check：没传 request_id 时仍提示「用同一个 request_id 重试」。
// 同一句文案还在 code_patch / code_batch / code_maintain / code_worktree 的
// state_commit_pending 出口（summary 与 makeError 两处），调用方没有 request_id 可传。
//
// 判据：有 request_id → 可以说 same request_id；没有 → 明确说「重新跑 <tool>」，
// 且建议里不得再出现 same request_id。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP = join(os.tmpdir(), 'opencode', 'state-commit-wording-test')
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
const WS = join(TMP, 'ws')
mkdirSync(WS, { recursive: true })
process.env.MALONG_STATE_DIR = join(TMP, 'state')
writeFileSync(join(WS, 'a.js'), 'a\n')

let pass = 0, fail = 0
const assert = (cond, msg) => { if (cond) pass++; else { fail++; console.error('  FAIL:', msg) } }
const imp = (p) => import(pathToFileURL(p).href)
const shared = await imp(join(__dirname, '..', 'tools', 'entry-shared.js'))
const patch = await imp(join(__dirname, '..', 'tools', 'tool-code-patch', 'handler.js'))
const batch = await imp(join(__dirname, '..', 'tools', 'tool-code-batch', 'handler.js'))
const maintain = await imp(join(__dirname, '..', 'tools', 'tool-code-maintain', 'handler.js'))

const TOOLS = ['code_patch', 'code_batch', 'code_maintain', 'code_worktree']

// ── ① 纯文案函数：有/无 request_id 两条路 ──
for (const tool of TOOLS) {
  const withRid = shared.stateCommitPendingText(tool, 'X applied', 'REVISION_CONFLICT', 'req_1')
  assert(/same request_id/.test(withRid.summary), `① ${tool} 有 rid summary 提 same request_id（得 ${JSON.stringify(withRid.summary)}）`)
  assert(/same request_id/.test(withRid.message), `① ${tool} 有 rid message 提 same request_id（得 ${JSON.stringify(withRid.message)}）`)
  assert(/same request_id/.test(withRid.suggestion), `① ${tool} 有 rid suggestion 提 same request_id（得 ${JSON.stringify(withRid.suggestion)}）`)

  const noRid = shared.stateCommitPendingText(tool, 'X applied', 'REVISION_CONFLICT', null)
  const all = [noRid.summary, noRid.message, noRid.suggestion].join(' ')
  assert(!/same request_id/.test(all), `① ${tool} 无 rid 不得提 same request_id（得 ${JSON.stringify(all)}）`)
  assert(noRid.summary.includes(`re-run ${tool}`), `① ${tool} 无 rid summary 指向 re-run（得 ${JSON.stringify(noRid.summary)}）`)
  assert(noRid.message.includes(`re-run ${tool}`), `① ${tool} 无 rid message 指向 re-run（得 ${JSON.stringify(noRid.message)}）`)
  assert(noRid.suggestion.includes(`Re-run ${tool}`), `① ${tool} 无 rid suggestion 指向 Re-run（得 ${JSON.stringify(noRid.suggestion)}）`)
}

// ── ② 真走 reconcile 的 CAS 失败出口：patch / batch / maintain ──
{
  const task = {
    task_id: 'task_wording', revision: 1, route: 'change', lifecycle: 'active',
    node: 'edit', goal: 'wording', goal_revision: 1,
    materials: [], operations: [], evidence: [], workspace_dir: WS,
  }
  shared.putTask(WS, task, { type: 'task_created', task })
  const hash = shared.fileHash(WS, 'a.js')

  const cases = [
    ['code_patch', () => patch.reconcileOperation(WS, task.task_id, 0, {
      operation_id: 'op_w', file: 'a.js', intended_file_hash: hash, request_id: null, state: 'prepared',
    }, 'change', 'active')],
    ['code_batch', () => batch.reconcileBatch(WS, task.task_id, 0, {
      operation_id: 'op_b', files: ['a.js'], pre_hashes: { 'a.js': null }, intended_hashes: { 'a.js': hash }, request_id: null, state: 'prepared',
    }, 'change', 'active')],
    ['code_maintain', () => maintain.reconcileMaintain(WS, task.task_id, 0, {
      operation_id: 'op_m', files: ['a.js'], pre_hashes: { 'a.js': null }, intended_hashes: { 'a.js': hash }, request_id: null, state: 'prepared',
    }, 'change', 'active')],
  ]

  for (const [tool, run] of cases) {
    const r = run()
    assert(r.ok === false && r.error === 'state_commit_pending', `② ${tool} CAS 失败 → state_commit_pending（得 ${JSON.stringify({ ok: r.ok, e: r.error, m: r.message })}）`)
    assert(r.message.includes('no request_id was supplied'), `② ${tool} 无 rid message 说清没传（得 ${JSON.stringify(r.message)}）`)
    assert(!r.message.includes('same request_id'), `② ${tool} 无 rid message 不得提 same request_id（得 ${JSON.stringify(r.message)}）`)
    assert(r.suggestion.includes(`Re-run ${tool}`), `② ${tool} 建议 re-run（得 ${JSON.stringify(r.suggestion)}）`)
  }

  const withRid = patch.reconcileOperation(WS, task.task_id, 0, {
    operation_id: 'op_w2', file: 'a.js', intended_file_hash: hash, request_id: 'req_1', state: 'prepared',
  }, 'change', 'active')
  assert(withRid.message.includes('same request_id'), `② 有 rid 仍提示 same request_id（得 ${JSON.stringify(withRid.message)}）`)
}

// ── ③ 接线守卫：四个 handler 必须调用共享文案，旧的无条件句子不得残留 ──
{
  const files = [
    ['code_patch', 'tool-code-patch'],
    ['code_batch', 'tool-code-batch'],
    ['code_maintain', 'tool-code-maintain'],
    ['code_worktree', 'tool-code-worktree'],
  ]
  for (const [tool, dir] of files) {
    const src = readFileSync(join(__dirname, '..', 'tools', dir, 'handler.js'), 'utf-8')
    assert(src.includes('stateCommitPendingText('), `③ ${tool} 使用共享文案函数`)
    assert(!src.includes('retry with the same request_id to finalize'), `③ ${tool} 不得残留无条件 same request_id 文案`)
  }
}

try { rmSync(TMP, { recursive: true, force: true }) } catch {}
console.log('== test-state-commit-wording: ' + pass + ' passed, ' + fail + ' failed ==')
process.exit(fail > 0 ? 1 : 0)
