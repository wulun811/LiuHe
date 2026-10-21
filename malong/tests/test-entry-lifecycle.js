// test-entry-lifecycle.js — 批1（LH-001/LH-008/LH-011）失败路径测试
// 覆盖：cancel 终态写守卫（5 写入口全拒 + 文件/生命周期不变）、succeeded 操作 dedup 复读、
//       reopen 显式恢复（在途拒绝/重复拒绝/恢复后可写）、next_action 取出即可调用、
//       read_symbol budget effective/floor 回传。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP = join(os.tmpdir(), 'opencode', 'entry-lifecycle-test')
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
const WS = join(TMP, 'ws')
mkdirSync(join(WS, 'src'), { recursive: true })
process.env.MALONG_STATE_DIR = join(TMP, 'state')
process.env.MALONG_ENTRY_STATE = '1'

let pass = 0, fail = 0
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  FAIL:', msg) } }

const imp = (p) => import(pathToFileURL(p).href)
const shared = await imp(join(__dirname, '..', 'tools', 'entry-shared.js'))
const store = await imp(join(__dirname, '..', 'tools', 'entry-store.js'))
const patch = await imp(join(__dirname, '..', 'tools', 'tool-code-patch', 'handler.js'))
const batch = await imp(join(__dirname, '..', 'tools', 'tool-code-batch', 'handler.js'))
const check = await imp(join(__dirname, '..', 'tools', 'tool-code-check', 'handler.js'))
const maintain = await imp(join(__dirname, '..', 'tools', 'tool-code-maintain', 'handler.js'))
const worktree = await imp(join(__dirname, '..', 'tools', 'tool-code-worktree', 'handler.js'))
const control = await imp(join(__dirname, '..', 'tools', 'tool-code-control', 'handler.js'))
const readMod = await imp(join(__dirname, '..', 'tools', 'tool-code-read', 'handler.js'))
const statusMod = await imp(join(__dirname, '..', 'tools', 'tool-code-status', 'handler.js'))
const readSymbol = await imp(join(__dirname, '..', 'tools', 'tool-read-symbol', 'handler.js'))

const ctx = { codeIndexService: null, langParserService: null }
const NL = String.fromCharCode(10)
const F = 'src/a.txt'
const ORIG = ['alpha', 'beta', 'gamma', ''].join(NL)
writeFileSync(join(WS, F), ORIG)
const h = (s) => 'sha256:' + shared.sha256Hex(s)
const diskHash = () => h(readFileSync(join(WS, F), 'utf-8'))
const material = { read_ref: 'read_1', locator: { file_path: F }, canonical_path: F, file_version: { hash: h(ORIG) }, symbol_version: null }
const PATCH = { old_string: 'beta', new_string: 'BETA' }

function mkTask(id, extra) {
  const t = { task_id: id, revision: 1, route: 'change', lifecycle: 'active', node: 'read', materials: [material], operations: [], evidence: [], workspace_dir: WS, ...(extra || {}) }
  shared.putTask(WS, t, { type: 'task_created', task: t })
  return t
}

// ── 1. cancel 终态：5 写入口全拒，无副作用 ──
mkTask('t_guard')
const before = readFileSync(join(WS, F), 'utf-8')
let r = await control.handle({ workspace_dir: WS, task_id: 't_guard', action: 'cancel', reason: 'guard test' })
assert(r.ok === true && r.observation.cancelled === true, '前置：cancel 成功')
const hashAfterCancel = diskHash()

r = await patch.handle({ workspace_dir: WS, task_id: 't_guard', read_ref: 'read_1', edit_mode: 'patch', patch: PATCH }, ctx)
assert(r.ok === false && r.error === 'task_cancelled', 'cancel 后 code_patch(preview) 拒（得 ' + r.error + '）')
assert(/reopen/.test(r.suggestion || ''), 'code_patch 拒绝给出 reopen 指引（得 ' + r.suggestion + '）')

r = await batch.handle({ workspace_dir: WS, task_id: 't_guard', request_id: 'rq_b1', writes: [{ read_ref: 'read_1', edit_mode: 'patch', patch: PATCH }] }, ctx)
assert(r.ok === false && r.error === 'task_cancelled', 'cancel 后 code_batch 拒（得 ' + r.error + '）')

r = await check.handle({ workspace_dir: WS, task_id: 't_guard', checks: ['test'], run: true, request_id: 'rq_c1' }, ctx)
assert(r.ok === false && r.error === 'task_cancelled', 'cancel 后 code_check(run) 拒（得 ' + r.error + '）')
r = await check.handle({ workspace_dir: WS, task_id: 't_guard', checks: ['test'] }, ctx)
assert(r.ok === false && r.error === 'task_cancelled', 'cancel 后 code_check(preview) 拒（得 ' + r.error + '）')

r = await maintain.handle({ workspace_dir: WS, task_id: 't_guard', action: 'plan' }, ctx)
assert(r.ok === false && r.error === 'task_cancelled', 'cancel 后 code_maintain(plan) 拒（得 ' + r.error + '）')
r = await maintain.handle({ workspace_dir: WS, task_id: 't_guard', action: 'apply', dry_run: false, request_id: 'rq_m1' }, ctx)
assert(r.ok === false && r.error === 'task_cancelled', 'cancel 后 code_maintain(apply) 拒（得 ' + r.error + '）')

r = await worktree.handle({ workspace_dir: WS, task_id: 't_guard', action: 'preview', changes: [{ path: F, new_content: 'x' }] }, ctx)
assert(r.ok === false && r.error === 'task_cancelled', 'cancel 后 code_worktree(preview) 拒（得 ' + r.error + '）')
r = await worktree.handle({ workspace_dir: WS, task_id: 't_guard', action: 'status' }, ctx)
assert(r.ok === false && r.error === 'task_cancelled', 'cancel 后 code_worktree(status) 拒（得 ' + r.error + '）')

assert(readFileSync(join(WS, F), 'utf-8') === before && diskHash() === hashAfterCancel, '写守卫：文件哈希不变')
const tg = store.getTask(WS, 't_guard')
assert(tg.lifecycle === 'cancelled', '写守卫：生命周期保持 cancelled')
assert((tg.operations || []).length === 0, '写守卫：无新操作记录')

// ── 2. succeeded 操作 dedup 复读：cancel 后同 request_id 同载荷仍可核对 ──
mkTask('t_dedup')
r = await patch.handle({ workspace_dir: WS, task_id: 't_dedup', read_ref: 'read_1', edit_mode: 'patch', patch: PATCH, dry_run: false, request_id: 'rq_dedup' }, ctx)
assert(r.ok === true && r.observation.committed === true, '前置：apply 成功（得 ' + (r.error || r.observation?.summary) + '）')
await control.handle({ workspace_dir: WS, task_id: 't_dedup', action: 'cancel' })
const afterApply = readFileSync(join(WS, F), 'utf-8')
r = await patch.handle({ workspace_dir: WS, task_id: 't_dedup', read_ref: 'read_1', edit_mode: 'patch', patch: PATCH, dry_run: false, request_id: 'rq_dedup' }, ctx)
assert(r.ok === true && r.observation.deduplicated === true, 'cancel 后 dedup 复读放行（得 ' + (r.error || r.observation?.summary) + '）')
assert(r.task.lifecycle === 'cancelled', 'dedup 复读透出真实 lifecycle（得 ' + r.task.lifecycle + '）')
assert(readFileSync(join(WS, F), 'utf-8') === afterApply, 'dedup 复读不写文件')

// cancelled 任务 code_read：可读内容但不落材料/不发 read_ref/不翻 node，next_action 指向 reopen
r = await readMod.handle({ workspace_dir: WS, task_id: 't_dedup', locator: { file_path: F } }, ctx)
assert(r.ok === true && !r.read_ref && (r.observation.read_refs || []).length === 0, 'cancelled 任务 code_read 不发放 read_ref（得 ' + JSON.stringify({ read_ref: r.read_ref, error: r.error }) + '）')
assert(r.next_action && r.next_action.tool === 'code_control' && r.next_action.args.action === 'reopen', 'cancelled 任务 code_read next_action 指向 reopen')
const td = store.getTask(WS, 't_dedup')
assert(td.node === 'cancelled' && (td.materials || []).length === 1, 'cancelled 任务 code_read 不改 node/不落材料')
writeFileSync(join(WS, F), ORIG)

// ── 3. reopen：显式恢复 + 重复拒绝 + 在途拒绝 + 恢复后可写 ──
r = await control.handle({ workspace_dir: WS, task_id: 't_guard', action: 'reopen', reason: 'continue' })
assert(r.ok === true && r.observation.reopened === true && r.task.lifecycle === 'active', 'reopen 恢复 active（得 ' + (r.error || r.observation?.summary) + '）')
assert(store.getTask(WS, 't_guard').node === 'read', 'reopen 恢复 cancel 前 node=read（得 ' + store.getTask(WS, 't_guard').node + '）')
r = await control.handle({ workspace_dir: WS, task_id: 't_guard', action: 'reopen' })
assert(r.ok === false && r.error === 'not_cancelled', 'active 上 reopen 拒绝（得 ' + r.error + '）')
assert(store.getTask(WS, 't_guard').lifecycle === 'active', '重复 reopen 不改状态')

const tPre = mkTask('t_pre', { operations: [{ operation_id: 'op_pre', kind: 'patch', state: 'prepared', file: F, request_id: 'rq_pre', payload_hash: 'sha256:x' }] })
shared.updateTaskCas(WS, 't_pre', tPre.revision, (t) => {
  t.lifecycle = 'cancelled'
  t.node = 'cancelled'
  return { type: 'lifecycle', data: { lifecycle: 'cancelled' } }
})
r = await control.handle({ workspace_dir: WS, task_id: 't_pre', action: 'reopen' })
assert(r.observation?.reopened !== true && (r.observation?.blocked_by || []).length === 1, '在途任务 reopen 拒绝并列出 blocked_by（得 ' + JSON.stringify(r.observation || r.error) + '）')
assert(store.getTask(WS, 't_pre').lifecycle === 'cancelled', '在途 reopen 不改状态')

r = await patch.handle({ workspace_dir: WS, task_id: 't_guard', read_ref: 'read_1', edit_mode: 'patch', patch: PATCH, dry_run: false, request_id: 'rq_after_reopen' }, ctx)
assert(r.ok === true && r.observation.committed === true, 'reopen 后恢复可写（得 ' + (r.error || r.observation?.summary) + '）')
assert(r.next_action?.tool === 'code_check' && r.next_action.args?.run === true, '13-C patch apply → next_action=code_check(run=true)（得 ' + JSON.stringify(r.next_action || null) + '）')
writeFileSync(join(WS, F), ORIG)

// ── 3b. 7-B（2026-10-07 专家复测 P2）：reopen 必须进公开参数枚举（handler 有、manifest 缺）──
{
  const manifest = JSON.parse(readFileSync(join(__dirname, '..', 'tools', 'tool-code-control', 'manifest.json'), 'utf-8'))
  const enumActions = manifest.inputSchema?.properties?.action?.enum || []
  const actions = control.ACTIONS || []
  assert(actions.length > 0, '7-B handler 导出 ACTIONS（供 manifest 互锁）')
  for (const a of actions) assert(enumActions.includes(a), '7-B manifest action 枚举含 handler 动作 ' + a + '（得 ' + JSON.stringify(enumActions) + '）')
  assert(enumActions.includes('reopen'), '7-B manifest action 枚举含 reopen')
  assert(/reopen/.test(manifest.description || ''), '7-B manifest description 提及 reopen（得 ' + String(manifest.description).slice(0, 80) + '）')
}

// ── 4. next_action 取出即可调用（LH-008）──
mkTask('t_next')
r = await patch.handle({ workspace_dir: WS, task_id: 't_next', read_ref: 'read_1', edit_mode: 'patch', patch: PATCH }, ctx)
assert(r.ok === true && r.observation.dry_run === true, '前置：patch 预览')
const na = r.next_action
assert(na && na.tool === 'code_patch' && na.args && na.args.dry_run === false && na.args.read_ref === 'read_1', 'patch 预览回传结构化 next_action（得 ' + JSON.stringify(na) + '）')
assert(na && na.args && na.args.patch && na.args.patch.old_string === 'beta' && na.args.patch.new_string === 'BETA', 'next_action 带完整 edit 载荷（LH-008：照做不再 missing_parameter）')
if (na && na.args) {
  const rr = await patch.handle({ ...na.args, request_id: 'rq_replay' }, ctx)
  assert(rr.ok === true && rr.observation.committed === true, 'next_action.args 回放成功（得 ' + (rr.error || rr.observation?.summary) + '）')
  writeFileSync(join(WS, F), ORIG)
}

mkTask('t_read', { route: 'change' })
r = await readMod.handle({ workspace_dir: WS, task_id: 't_read', locator: { file_path: F } }, ctx)
assert(r.ok === true, '前置：code_read 成功（得 ' + (r.error || r.message) + '）')
assert(r.observation.budget && r.observation.budget.floor === 200 && r.observation.budget.effective >= 200, 'code_read 透传 budget.effective/floor（得 ' + JSON.stringify(r.observation?.budget) + '）')
assert(!/read-only/.test(r.next_step || ''), 'code_read 清除 S1 只读禁用文案')
assert(r.next_action && r.next_action.tool === 'code_patch' && r.next_action.args && r.next_action.args.read_ref === r.read_ref, 'code_read(change) next_action 指向 code_patch 预览')
assert(r.next_action.template === true && (r.next_action.required_args || []).length > 0, 'change 路由 next_action 显式标 template + required_args（不谎称可直接调用）')
if (r.next_action && r.next_action.args) {
  const rp = await patch.handle({ ...r.next_action.args, patch: PATCH, edit_mode: 'patch', request_id: 'rq_read_next' }, ctx)
  assert(rp.ok === true && rp.observation.effect === 'preview', 'code_read next_action 锚点补齐载荷后可调用（得 ' + (rp.error || rp.observation?.summary) + '）')
}

mkTask('t_review', { route: 'review' })
r = await readMod.handle({ workspace_dir: WS, task_id: 't_review', locator: { file_path: F } }, ctx)
assert(r.ok === true && r.next_action && r.next_action.tool === 'code_audit', 'code_read(review) next_action 指向 code_audit（得 ' + JSON.stringify(r.next_action || r.error) + '）')

// ── WP08R-2 G3：截断时 observation.warning 给替代路径（替代静默 truncated 标记）──
{
  writeFileSync(join(WS, 'src', 'long.txt'), Array.from({ length: 300 }, (_, i) => 'line ' + i).join('\n') + '\n')
  const rw = await readMod.handle({ workspace_dir: WS, task_id: 't_read', locator: { file_path: 'src/long.txt' }, budget_hint: 200 }, ctx)
  assert(rw.ok === true && rw.observation.truncated === true, '前置：长文件读被截断（得 ' + JSON.stringify(rw.observation?.budget) + '）')
  assert(/truncated/i.test(rw.observation.warning || '') && /budget_hint=0/.test(rw.observation.warning || ''), '截断 → warning 给替代路径（得 ' + (rw.observation.warning || 'missing') + '）')
  const rwFull = await readMod.handle({ workspace_dir: WS, task_id: 't_read', locator: { file_path: 'src/long.txt' }, budget_hint: 0 }, ctx)
  assert(rwFull.ok === true && rwFull.observation.truncated === false && rwFull.observation.warning === undefined, 'budget_hint=0 全读不带 warning（得 ' + JSON.stringify(rwFull.observation?.warning) + '）')
}

// ── 4b. 8-B（2026-10-07 专家复测 §2）：状态感知 next_action/next_step（旧固定「S1 只读」文案）──
{
  // change + partial（已落盘未验证）→ code_check 优先于继续编辑
  mkTask('t_st_partial', { result_kind: 'partial' })
  r = await statusMod.handle({ workspace_dir: WS, task_id: 't_st_partial' })
  assert(r.ok === true && r.next_action?.tool === 'code_check', '8-B code_status partial → next_action code_check（得 ' + JSON.stringify(r.next_action || r.error) + '）')
  assert(!/read-only|S1/.test(r.next_step || ''), '8-B code_status 清除 S1 只读固定文案（得 ' + r.next_step + '）')
  assert(Array.isArray(r.allowed_actions) && r.allowed_actions.includes('code_check'), '8-B allowed_actions 含 next_action.tool（得 ' + JSON.stringify(r.allowed_actions) + '）')

  // change + validated → 复核为主（9-C：专家报告 P3——不再默认推回编辑）
  mkTask('t_st_valid', { result_kind: 'validated' })
  r = await statusMod.handle({ workspace_dir: WS, task_id: 't_st_valid' })
  assert(r.next_action === null && r.progress === 'done' && r.mechanical_requirements_met === true && r.goal_judgment === 'host_required', '14-B AC03 code_status validated → done 空动作 + host_required（得 ' + JSON.stringify({ na: r.next_action, p: r.progress }) + '）')

  // cancelled → reopen 指引 + allowed 含 code_control
  r = await statusMod.handle({ workspace_dir: WS, task_id: 't_dedup' })
  assert(r.next_action?.tool === 'code_control' && r.next_action.args?.action === 'reopen', '8-B cancelled code_status → next_action reopen（得 ' + JSON.stringify(r.next_action || r.error) + '）')
  assert(!/read-only|S1/.test(r.next_step || ''), '8-B cancelled next_step 无只读文案（得 ' + r.next_step + '）')
  assert(Array.isArray(r.allowed_actions) && r.allowed_actions.includes('code_control'), '8-B cancelled allowed_actions 含 code_control（得 ' + JSON.stringify(r.allowed_actions) + '）')

  // code_read change+partial 同样优先 code_check（与 code_status 共享生成器）
  mkTask('t_read_partial', { route: 'change', result_kind: 'partial' })
  r = await readMod.handle({ workspace_dir: WS, task_id: 't_read_partial', locator: { file_path: F } }, ctx)
  assert(r.ok === true && r.next_action?.tool === 'code_check', '8-B code_read change+partial → next_action code_check（得 ' + JSON.stringify(r.next_action || r.error) + '）')
}

// ── 5. read_symbol budget effective/floor（LH-011）──
r = await readSymbol.handle({ workspace_dir: WS, locator: { file_path: F } }, {})
assert(r.budget && r.budget.requested === 1200 && r.budget.effective === 1200 && r.budget.floor === 200, 'budget 默认 requested=effective=1200（得 ' + JSON.stringify(r.budget) + '）')
r = await readSymbol.handle({ workspace_dir: WS, locator: { file_path: F }, budget_hint: 5 }, {})
assert(r.budget && r.budget.requested === 5 && r.budget.effective === 200, 'budget_hint=5 → requested 保留原值、effective 抬到 floor=200（得 ' + JSON.stringify(r.budget) + '）')
r = await readSymbol.handle({ workspace_dir: WS, locator: { file_path: F }, budget_hint: 0 }, {})
assert(r.budget && r.budget.effective === 100000, 'budget_hint=0 → effective=100000（不截断）（得 ' + JSON.stringify(r.budget) + '）')
r = await readSymbol.handle({ workspace_dir: WS, locator: { file_path: F }, budget_hint: 999999 }, {})
assert(r.budget && r.budget.effective === 100000, 'budget_hint 超上限 → effective=100000（得 ' + JSON.stringify(r.budget) + '）')

// ── 5b. 7-B（专家复测 LH-011）：截断标记计入上限——used_estimate ≤ effective，不再 200+13 超限 ──
{
  writeFileSync(join(WS, 'src/long.txt'), 'x'.repeat(400))
  r = await readSymbol.handle({ workspace_dir: WS, locator: { file_path: 'src/long.txt' }, budget_hint: 200 }, {})
  assert(r.budget && r.budget.truncated === true, '7-B 长文截断触发（得 ' + JSON.stringify(r.budget) + '）')
  assert(r.budget.used_estimate <= r.budget.effective, '7-B used_estimate ≤ effective（标记计入上限；得 used=' + r.budget.used_estimate + ' effective=' + r.budget.effective + '）')
  assert(/truncated\]$/.test(r.symbol?.text || ''), '7-B 截断标记保留（得 ' + JSON.stringify((r.symbol?.text || '').slice(-20)) + '）')
  assert(r.budget.marker_overhead >= 10, '7-B 回传 marker_overhead（得 ' + JSON.stringify(r.budget.marker_overhead) + '）')
}

console.log('=== test-entry-lifecycle: ' + pass + ' passed, ' + fail + ' failed ===')
process.exit(fail > 0 ? 1 : 0)
