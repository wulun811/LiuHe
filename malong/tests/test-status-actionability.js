// test-status-actionability.js — F25/F27/F29（2026-11-05 极限风暴）
//
// 真机实测：
//  ① code_status 在「上次检查 FAILED」时，next_action 说“修完再跑”，next_step 却说
//     “validation is optional”，且 allowed_actions 不含 code_patch——自相矛盾；
//  ② understand 路由的 next_action 指回 code_status 自身，照做原地打转；
//  ③ mode=search 只给 search_terms 时报 "search requires query"，没有告诉调用方 query 才是必填。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP = join(os.tmpdir(), 'opencode', 'status-actionability-test')
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
const WS = join(TMP, 'ws')
mkdirSync(WS, { recursive: true })
writeFileSync(join(WS, 'a.js'), 'export function add(a, b) { return a + b }\n')
process.env.MALONG_STATE_DIR = join(TMP, 'state')
process.env.MALONG_ENTRY_STATE = '1'

let pass = 0, fail = 0
const assert = (cond, msg) => { if (cond) pass++; else { fail++; console.error('  FAIL:', msg) } }
const imp = (p) => import(pathToFileURL(p).href)
const shared = await imp(join(__dirname, '..', 'tools', 'entry-shared.js'))
const status = await imp(join(__dirname, '..', 'tools', 'tool-code-status', 'handler.js'))
const query = await imp(join(__dirname, '..', 'tools', 'tool-code-query', 'handler.js'))

function putTask(id, extra) {
  const t = {
    task_id: id, revision: 1, route: 'change', lifecycle: 'active', node: 'check',
    goal: 'storm status', goal_revision: 1, materials: [], operations: [], evidence: [],
    workspace_dir: WS, ...extra,
  }
  shared.putTask(WS, t, { type: 'task_created', task: t })
  return t
}

// ── ① 上次检查 FAILED：状态文案必须一致，且推荐 code_patch ──
{
  putTask('task_failed', {
    result_kind: 'partial',
    operations: [{ operation_id: 'op_patch', kind: 'patch', state: 'succeeded', file: 'a.js' }],
    evidence: [{ evidence_id: 'ev_fail', kind: 'test', result: 'failed', depends_on: [{ file: 'a.js', hash: 'sha256:x' }] }],
  })
  const r = await status.handle({ workspace_dir: WS, task_id: 'task_failed' })
  assert(r.ok === true, '① status ok（得 ' + JSON.stringify(r.error || r.ok) + '）')
  const ns = String(r.next_step || '')
  assert(/FAILED/.test(ns), '① next_step 必须说 FAILED（得 ' + JSON.stringify(ns) + '）')
  assert(!/optional/i.test(ns), '① 失败态不得再说 validation is optional（得 ' + JSON.stringify(ns) + '）')
  assert((r.allowed_actions || []).includes('code_patch'), '① allowed_actions 必须含 code_patch（得 ' + JSON.stringify(r.allowed_actions) + '）')
}

// ── ② understand：next_action 必须实际推进（读候选，而不是再次 status）──
{
  putTask('task_understand', {
    route: 'understand', node: 'orient', result_kind: null,
    candidates: [
      { name: 'doc-hit', kind: 'content', locator: { file_path: 'README.md' }, rank_reason: 'content_hit' },
      { name: 'add', kind: 'function', locator: { file_path: 'a.js', name: 'add', symbol_id: 'js:a.js::add#function' }, rank_reason: 'exact_name' },
    ],
  })
  const r = await status.handle({ workspace_dir: WS, task_id: 'task_understand' })
  const na = r.next_action || {}
  assert(na.tool !== 'code_status', '② next_action 不得指回 code_status（得 ' + JSON.stringify(na.tool) + '）')
  assert(na.tool === 'code_read', '② next_action 应为 code_read（得 ' + JSON.stringify(na.tool) + '）')
  assert(na.args?.locator?.name === 'add', '② 读函数候选，跳过 content 命中（得 ' + JSON.stringify(na.args?.locator) + '）')
  assert(na.args?.locator?.symbol_id === 'js:a.js::add#function', '② locator 必须带 symbol_id（得 ' + JSON.stringify(na.args?.locator) + '）')
}

// ── ③ search 缺 query：错误必须说明 search_terms 不能替代 query ──
{
  const r = await query.handle({ workspace_dir: '/x', mode: 'search', search_terms: ['add'] }, {})
  assert(r.ok === false && r.error === 'missing_parameter', '③ search 缺 query 仍应报错（得 ' + JSON.stringify(r.error) + '）')
  assert(/search_terms are optional/.test(String(r.suggestion || '')), '③ suggestion 必须说明 search_terms 不能替代 query（得 ' + JSON.stringify(r.suggestion) + '）')
}

try { rmSync(TMP, { recursive: true, force: true }) } catch {}
console.log('== test-status-actionability: ' + pass + ' passed, ' + fail + ' failed ==')
process.exit(fail > 0 ? 1 : 0)
