// test-check-parallel-commit.js — F36（2026-11-05 极限风暴）
//
// 真机实测：同一任务上并行发 code_audit + code_check，检查跑完后任务 revision 已被
// audit 推高，code_check 的 CAS 一次失败就丢弃已完成的检查，并提示「用同一个 request_id
// 重试」——但调用方根本没传 request_id。
// 修复：检查是追加式证据，CAS 冲突时重取 revision 合并，最多 3 次。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP = join(os.tmpdir(), 'opencode', 'check-parallel-commit-test')
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
const WS = join(TMP, 'ws')
mkdirSync(WS, { recursive: true })
writeFileSync(join(WS, 'package.json'), JSON.stringify({
  name: 'parallel-check', version: '1.0.0',
  scripts: { test: 'node -e "setTimeout(function(){}, 800)"' },
}))
process.env.MALONG_STATE_DIR = join(TMP, 'state')
process.env.MALONG_ENTRY_STATE = '1'

let pass = 0, fail = 0
const assert = (cond, msg) => { if (cond) pass++; else { fail++; console.error('  FAIL:', msg) } }
const imp = (p) => import(pathToFileURL(p).href)
const shared = await imp(join(__dirname, '..', 'tools', 'entry-shared.js'))
const check = await imp(join(__dirname, '..', 'tools', 'tool-code-check', 'handler.js'))

const task = {
  task_id: 'task_parallel_check', revision: 1, route: 'change', lifecycle: 'active',
  node: 'edit', goal: 'parallel check', goal_revision: 1,
  materials: [], operations: [], evidence: [], workspace_dir: WS,
}
shared.putTask(WS, task, { type: 'task_created', task })

// 两个同步检查同时起跑：都必须成功，且两条证据都要落进任务。
const args = { workspace_dir: WS, task_id: task.task_id, checks: ['test'], run: true, timeout: 30 }
const [r1, r2] = await Promise.all([check.handle({ ...args }, {}), check.handle({ ...args }, {})])

assert(r1.ok === true, '并发检查 #1 ok:true（得 ' + JSON.stringify({ ok: r1.ok, error: r1.error, msg: r1.message }) + '）')
assert(r2.ok === true, '并发检查 #2 ok:true（得 ' + JSON.stringify({ ok: r2.ok, error: r2.error, msg: r2.message }) + '）')
assert(r1.error !== 'state_commit_pending', '并发检查 #1 不得 state_commit_pending（得 ' + JSON.stringify(r1.error) + '）')
assert(r2.error !== 'state_commit_pending', '并发检查 #2 不得 state_commit_pending（得 ' + JSON.stringify(r2.error) + '）')
const fresh = shared.getTask(WS, task.task_id)
const tests = (fresh?.evidence || []).filter(e => e.kind === 'test')
assert(tests.length === 2, '两次检查的证据都必须落盘（得 ' + tests.length + ' 条）')
assert((fresh?.operations || []).filter(o => o.kind === 'check').length === 2, '两条 check 操作都必须落盘（得 ' + (fresh?.operations || []).filter(o => o.kind === 'check').length + '）')

try { rmSync(TMP, { recursive: true, force: true }) } catch {}
console.log('== test-check-parallel-commit: ' + pass + ' passed, ' + fail + ' failed ==')
process.exit(fail > 0 ? 1 : 0)
