// test-m2-m3-check-attempt-identity.js — M2/M3（0.5.14 专家 Windows 复核余口）
// 现场（专家 mixed-trace）：同一任务先跑 check-A（带 request_id，scope-A/30000 成功），
// 再开 check-B（无 request_id，scope-B/120000，async），取消 B 后：
//   M2 cancel 回执 known=scope-A/30000（scope_source=operation）——范围被更早的检查抢占；
//   M3 status/resume 仍投影 done（next_action=null + mechanical_requirements_met=true），
//      同时 effect_unknown=true——完成合同与「效果待核」冲突，LLM 容易据此提前交还。
// 本测试锁定：
//   ① 取消以**被取消的 job** 为权威（四组交错：有 id→无 id、无 id→有 id、两次无 id、两个不同 id）；
//   ② cancel/status/resume/read 对同一尝试给同一范围，旧记录保留但不抢占；
//   ③ A 成功 → B 取消后不得 done；B 运行中不得 done；B 同 scope 成功重验后按明确规则恢复 done；
//   ④ 进程重启（清空内存注册表）后投影仍一致。
// 真实父子进程 + 真实 handler，不用 mock。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import os from 'node:os'
import { execFileSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP = join(os.tmpdir(), 'opencode', 'm2m3-check-attempts')
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
const WS = join(TMP, 'ws')
process.env.MALONG_STATE_DIR = join(TMP, 'state')
process.env.MALONG_ENTRY_STATE = '1'

let pass = 0, fail = 0
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  FAIL:', msg) } }
const brief = (v) => JSON.stringify(v ?? null).slice(0, 320)

// 每个 scope 用自己的 package.json + slow.js：记录 cwd/pid，quick.flag 存在时立即 0 退出。
const SCOPES = ['scope-a', 'scope-b', 'scope-c', 'scope-d', 'scope-e', 'scope-f', 'scope-g', 'scope-h', 'scope-i', 'scope-j', 'scope-k', 'scope-l', 'scope-m', 'scope-n', 'scope-o', 'scope-p']
for (const s of SCOPES) {
  mkdirSync(join(WS, s), { recursive: true })
  writeFileSync(join(WS, s, 'slow.js'), `
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const here = __dirname
fs.writeFileSync(path.join(here, 'ran-cwd.txt'), process.cwd())
fs.writeFileSync(path.join(here, 'parent.pid'), String(process.pid))
if (fs.existsSync(path.join(here, 'quick.flag'))) process.exit(0)
if (fs.existsSync(path.join(here, 'fail.flag'))) process.exit(1)
const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore' })
fs.writeFileSync(path.join(here, 'child.pid'), String(child.pid))
setTimeout(() => process.exit(0), 60000)
`)
  writeFileSync(join(WS, s, 'package.json'), JSON.stringify({ name: s, private: true, scripts: { test: 'node slow.js' } }, null, 2))
}
writeFileSync(join(WS, 'a.txt'), 'alpha\n')
// ⑧ 根范围检查（无 workdir）需要一个工作区根 package.json + slow.js：验证「根结果不自动覆盖子目录」。
writeFileSync(join(WS, 'slow.js'), "const fs = require('node:fs')\nconst path = require('node:path')\nif (fs.existsSync(path.join(__dirname, 'quick.flag'))) process.exit(0)\nif (fs.existsSync(path.join(__dirname, 'fail.flag'))) process.exit(1)\n")
writeFileSync(join(WS, 'package.json'), JSON.stringify({ name: 'ws-root', private: true, scripts: { test: 'node slow.js' } }, null, 2))
const setQuickRoot = () => writeFileSync(join(WS, 'quick.flag'), '1')

const shared = await import(pathToFileURL(join(__dirname, '..', 'tools', 'entry-shared.js')).href)
const check = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-code-check', 'handler.js')).href)
const control = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-code-control', 'handler.js')).href)
const readMod = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-code-read', 'handler.js')).href)
const jobs = await import(pathToFileURL(join(__dirname, '..', 'workflow', 'jobs.js')).href)
const effState = await import(pathToFileURL(join(__dirname, '..', 'workflow', 'effective-state.js')).href)

const F = 'a.txt'
const CONTENT = 'alpha\n'
const h = (s) => `sha256:${shared.sha256Hex(s)}`
function mkTask(id) {
  const t = {
    task_id: id, revision: 1, route: 'change', goal: 'change alpha', node: 'check', lifecycle: 'active', result_kind: 'partial',
    goal_revision: 1,
    materials: [{ read_ref: 'read_1', locator: { file_path: F }, canonical_path: F, file_version: { hash: h(CONTENT) }, symbol_version: null }],
    operations: [{ operation_id: 'op_patch_' + id, kind: 'patch', request_id: null, state: 'succeeded', file: F, result_file_hash: h(CONTENT), result_kind: 'partial' }],
    evidence: [], candidates: [{ file_path: F, name: 'alpha' }], workspace_dir: WS,
  }
  shared.putTask(WS, t, { type: 'task_created', task: t })
  return t
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
async function waitFor(fn, ms = 30000, step = 100) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(step) }
  return false
}
const readPid = (scope, name) => { try { return parseInt(readFileSync(join(WS, scope, name), 'utf-8').trim()) } catch { return 0 } }
const clearQuick = (scope) => rmSync(join(WS, scope, 'quick.flag'), { force: true })
const setQuick = (scope) => writeFileSync(join(WS, scope, 'quick.flag'), '1')

async function startAsync(taskId, scope, opts = {}) {
  clearQuick(scope)
  rmSync(join(WS, scope, 'parent.pid'), { force: true })
  rmSync(join(WS, scope, 'child.pid'), { force: true })
  const args = {
    workspace_dir: WS, task_id: taskId, checks: opts.checks || ['test'], workdir: scope,
    timeout: opts.timeout || 120000, verifier: 'exit', run: true, async: true,
    ...(opts.request_id ? { request_id: opts.request_id } : {}),
  }
  const r = await check.handle(args, {})
  assert(r.ok === true && r.job_id, `${scope}: async 受理（得 ${brief({ ok: r.ok, job: r.job_id, err: r.error })}）`)
  assert(await waitFor(() => readPid(scope, 'child.pid') > 0), `${scope}: 真实子进程已启动`)
  return { jobId: r.job_id, pPid: readPid(scope, 'parent.pid'), cPid: readPid(scope, 'child.pid') }
}
async function cancelAndAssert(taskId, scope, run, expectSource) {
  const c = await control.handle({ workspace_dir: WS, task_id: taskId, action: 'cancel_job', job_id: run.jobId, wait_ms: 8000 })
  assert(c.ok === true && c.observation.cancelled === true, `${scope}: 取消确认（得 ${brief(c.observation)}）`)
  const rev = (c.observation.effect_review || [])[0] || {}
  assert(rev.job_id === run.jobId, `${scope}: effect_review 指向被取消的 job（得 ${brief(rev.job_id)}）`)
  assert(rev.known?.workdir === scope, `${scope}: 取消回执范围是被取消的 job（旧实现会被更早检查抢占；得 ${brief(rev.known)}）`)
  assert(rev.known?.timeout === 120000 && rev.known?.checks?.[0] === 'test' && rev.known?.verifier === 'exit', `${scope}: timeout/checks/verifier 同源（得 ${brief(rev.known)}）`)
  assert(rev.known?.scope_source === expectSource, `${scope}: scope_source=${expectSource}（得 ${brief(rev.known?.scope_source)}）`)
  assert(await waitFor(() => (!run.pPid || !alive(run.pPid)) && (!run.cPid || !alive(run.cPid)), 15000), `${scope}: 取消后父子进程都已结束`)
  return c
}

// ── ① A 带 id 成功（scope-a/30000）→ B 无 id 取消（scope-b/120000）──
{
  const id = 'm2_1'
  mkTask(id)
  setQuick('scope-a')
  const a = await check.handle({ workspace_dir: WS, task_id: id, request_id: 'check-A1', checks: ['test'], workdir: 'scope-a', timeout: 30000, verifier: 'exit', run: true }, {})
  assert(a.ok === true && a.observation?.result_kind === 'validated', `① A 带 id 成功 → validated（得 ${brief({ ok: a.ok, k: a.observation?.result_kind })}）`)
  rmSync(join(WS, 'scope-a', 'quick.flag'), { force: true })

  const run = await startAsync(id, 'scope-b')
  await cancelAndAssert(id, 'scope-b', run, 'job')

  // status/resume/read 同一事实、同一范围（M3：不得 done）
  const st = await control.handle({ workspace_dir: WS, task_id: id, action: 'status' })
  const rs = await control.handle({ workspace_dir: WS, task_id: id, action: 'resume' })
  const rd = await readMod.handle({ workspace_dir: WS, task_id: id, locator: { file_path: F } }, { codeIndexService: null })
  for (const [name, r] of [['status', st], ['resume', rs], ['read', rd]]) {
    assert(r.ok === true, `① ${name}: 出口可用`)
    assert(r.observation?.progress !== 'done', `① ${name}: A 成功 + B 取消后不投影 done（M3；得 ${brief(r.observation?.progress)}）`)
    assert(r.next_action && r.next_action.tool === 'code_check', `① ${name}: next_action 指同 scope 重验（得 ${brief(r.next_action)}）`)
    assert(r.next_action?.args?.workdir === 'scope-b', `① ${name}: 重验范围是 B（不得回到 A/仓库根；得 ${brief(r.next_action?.args)}）`)
    assert(r.next_action?.args?.timeout === 120000 && r.next_action?.args?.checks?.[0] === 'test', `① ${name}: 复用 B 的 timeout/checks`)
    assert(r.next_action?.optional === true && r.next_action?.effect_judgment === 'host_required', `① ${name}: optional + host_required（可选重验，非强制完成）`)
    assert(!r.mechanical_requirements_met, `① ${name}: 不报机械完成（得 ${brief(r.mechanical_requirements_met)}）`)
  }
  assert((st.observation.effect_review || []).some(x => x.known?.workdir === 'scope-b'), `① status: effect_review 含 B 范围（得 ${brief(st.observation.effect_review)}）`)
  // ④ 重启一致性（未决状态下）：清空内存注册表（模拟 MCP 重启）后磁盘 job 仍 cancelled，
  // 投影不得因「A 的历史成功」翻转成 done，也不得丢掉 B 的范围。
  jobs._clearRegistry()
  const stR = await control.handle({ workspace_dir: WS, task_id: id, action: 'status' })
  assert(stR.observation?.progress !== 'done' && stR.next_action?.args?.workdir === 'scope-b', `④ 重启后仍保持未决 + 同一 scope（得 ${brief({ p: stR.observation?.progress, a: stR.next_action?.args })}）`)
  assert((stR.observation?.effect_review || []).some(x => x.known?.workdir === 'scope-b'), `④ 重启后 effect_review 仍含 B 范围（得 ${brief(stR.observation?.effect_review)}）`)
  // 旧记录保留：A 的 check op 与证据仍在，不被改写
  const t = shared.getTask(WS, id)
  assert((t.operations || []).some(o => o.request_id === 'check-A1' && o.state === 'succeeded'), '① A 的 operation 未被改写（历史保留）')

  // ①续：B 同 scope 成功重验 → 不确定性收口，恢复既有完成规则
  setQuick('scope-b')
  const re = await check.handle({ workspace_dir: WS, task_id: id, checks: ['test'], workdir: 'scope-b', timeout: 120000, verifier: 'exit', run: true }, {})
  assert(re.ok === true && re.observation?.result_kind === 'validated', `① B 同 scope 重验成功 → validated（得 ${brief({ ok: re.ok, k: re.observation?.result_kind })}）`)
  const st2 = await control.handle({ workspace_dir: WS, task_id: id, action: 'status' })
  assert(st2.observation?.progress === 'done' && st2.mechanical_requirements_met === true, `① 重验出确定结果后恢复 done（得 ${brief({ p: st2.observation?.progress, m: st2.mechanical_requirements_met })}）`)
  assert(st2.next_action === null, `① 重验后无未决动作（得 ${brief(st2.next_action)}）`)

  // ④ 重启一致性：清空内存注册表后磁盘 job 仍是 cancelled，投影不得翻转
  jobs._clearRegistry()
  const st3 = await control.handle({ workspace_dir: WS, task_id: id, action: 'status' })
  assert(st3.observation?.progress === 'done' && st3.next_action === null, `④ 重启后已收口状态一致（得 ${brief({ p: st3.observation?.progress, na: st3.next_action })}）`)
}

// ── ② A 无 id 成功（scope-a/30000）→ B 带 id 取消（scope-c）──
{
  const id = 'm2_2'
  mkTask(id)
  setQuick('scope-a')
  const a = await check.handle({ workspace_dir: WS, task_id: id, checks: ['test'], workdir: 'scope-a', timeout: 30000, verifier: 'exit', run: true }, {})
  assert(a.ok === true && a.observation?.result_kind === 'validated', `② A 无 id 成功 → validated`)
  rmSync(join(WS, 'scope-a', 'quick.flag'), { force: true })
  const run = await startAsync(id, 'scope-c', { request_id: 'check-B2' })
  await cancelAndAssert(id, 'scope-c', run, 'operation')
  const rs = await control.handle({ workspace_dir: WS, task_id: id, action: 'resume' })
  assert(rs.next_action?.args?.workdir === 'scope-c', `② resume 复用 B 范围（得 ${brief(rs.next_action?.args)}）`)
  assert(rs.observation?.progress !== 'done', `② 不因 A 成功报 done（得 ${brief(rs.observation?.progress)}）`)
  // 未决标志指向 B 的 operation，而不是 A
  assert(rs.next_action?.note?.includes('check-B2') || /stopped/i.test(rs.next_action?.note || ''), `② note 说明被停止的尝试（得 ${brief(rs.next_action?.note)}）`)
}

// ── ③ 两次都无 id（scope-d 先成功后取消？改为：先取消 D、再取消 E，最新 E 权威）──
{
  const id = 'm2_3'
  mkTask(id)
  const run1 = await startAsync(id, 'scope-d')
  await cancelAndAssert(id, 'scope-d', run1, 'job')
  const run2 = await startAsync(id, 'scope-e')
  await cancelAndAssert(id, 'scope-e', run2, 'job')
  const st = await control.handle({ workspace_dir: WS, task_id: id, action: 'status' })
  const reviews = st.observation?.effect_review || []
  assert(reviews.some(x => x.known?.workdir === 'scope-d') && reviews.some(x => x.known?.workdir === 'scope-e'), `③ 两条停止尝试都在核对清单（得 ${brief(reviews.map(x => x.known?.workdir))}）`)
  const na = st.next_action
  assert(na?.args?.workdir === 'scope-e', `③ 下一步按最新尝试 scope-e（得 ${brief(na?.args)}）`)
}

// ── ⑤ 两个不同 id：B 取消后 cancel/status 一致指向 B，A 记录保留 ──
{
  const id = 'm2_5'
  mkTask(id)
  setQuick('scope-f')
  const a = await check.handle({ workspace_dir: WS, task_id: id, request_id: 'check-A5', checks: ['test'], workdir: 'scope-f', timeout: 30000, verifier: 'exit', run: true }, {})
  assert(a.ok === true, `⑤ A5 成功`)
  rmSync(join(WS, 'scope-f', 'quick.flag'), { force: true })
  const run = await startAsync(id, 'scope-b', { request_id: 'check-B5' })
  await cancelAndAssert(id, 'scope-b', run, 'operation')
  const st = await control.handle({ workspace_dir: WS, task_id: id, action: 'status' })
  assert(st.next_action?.args?.workdir === 'scope-b', `⑤ status 下一步是 B 范围（得 ${brief(st.next_action?.args)}）`)
  const t = shared.getTask(WS, id)
  const a5 = (t.operations || []).find(o => o.request_id === 'check-A5')
  assert(a5 && a5.workdir === 'scope-f' && a5.state === 'succeeded', `⑤ A5 记录保留原范围（得 ${brief(a5 && { w: a5.workdir, s: a5.state })}）`)
}

// ── ⑥ B 运行中不是 done（未取消前）──
{
  const id = 'm2_6'
  mkTask(id)
  setQuick('scope-a')
  await check.handle({ workspace_dir: WS, task_id: id, request_id: 'check-A6', checks: ['test'], workdir: 'scope-a', timeout: 30000, verifier: 'exit', run: true }, {})
  rmSync(join(WS, 'scope-a', 'quick.flag'), { force: true })
  const run = await startAsync(id, 'scope-d')
  const st = await control.handle({ workspace_dir: WS, task_id: id, action: 'status' })
  assert(st.observation?.progress === 'in_flight', `⑥ B 运行中 → in_flight（得 ${brief(st.observation?.progress)}）`)
  assert(st.next_action?.progress === 'waiting' && st.next_action?.args?.job_id === run.jobId, `⑥ waiting + job 身份（得 ${brief(st.next_action)}）`)
  await control.handle({ workspace_dir: WS, task_id: id, action: 'cancel_job', job_id: run.jobId, wait_ms: 8000 })
}

// ── S1/S2 闭环（2026-10-19 专家 Windows 复核三）：覆盖必须范围可比较 ──
// 独立子进程查询（真实进程重启，非仅清内存注册表）：与主进程同一 MALONG_STATE_DIR/WS。
const sharedUrl = pathToFileURL(join(__dirname, '..', 'tools', 'entry-shared.js')).href
const controlUrl = pathToFileURL(join(__dirname, '..', 'tools', 'tool-code-control', 'handler.js')).href
function statusInChild(id) {
  const code = `
    process.env.MALONG_ENTRY_STATE = '1'
    ;(async () => {
      const control = await import(${JSON.stringify(controlUrl)})
      const r = await control.handle({ workspace_dir: ${JSON.stringify(WS)}, task_id: ${JSON.stringify(id)}, action: 'status' })
      const o = r.observation || {}
      process.stdout.write(JSON.stringify({ progress: o.progress, next: r.next_action, effect_unknown: o.effect_unknown || false, effect_review: (o.effect_review || []).map(x => x && x.known && x.known.workdir) }))
    })().catch(e => { console.error(String(e && e.stack || e)); process.exit(3) })
  `
  const out = execFileSync(process.execPath, ['-e', code], { encoding: 'utf-8', timeout: 90000 })
  return JSON.parse(out.trim().split('\n').pop())
}

// ── ⑦ S1：A 带 id 成功 → B 无 id 取消（scope-b）→ C 异范围（scope-g）成功不得清除 B ──
{
  const id = 'm2_7'
  mkTask(id)
  setQuick('scope-a')
  const a = await check.handle({ workspace_dir: WS, task_id: id, request_id: 'check-A7', checks: ['test'], workdir: 'scope-a', timeout: 30000, verifier: 'exit', run: true }, {})
  assert(a.ok === true && a.observation?.result_kind === 'validated', `⑦ A 带 id 成功 → validated（得 ${brief(a.observation?.result_kind)}）`)
  rmSync(join(WS, 'scope-a', 'quick.flag'), { force: true })
  const run = await startAsync(id, 'scope-b')
  await cancelAndAssert(id, 'scope-b', run, 'job')
  setQuick('scope-g')
  const c = await check.handle({ workspace_dir: WS, task_id: id, checks: ['test'], workdir: 'scope-g', timeout: 30000, verifier: 'exit', run: true }, {})
  assert(c.ok === true && c.observation?.result_kind === 'validated', `⑦ C 异范围成功 → validated（得 ${brief(c.observation?.result_kind)}）`)
  const st = await control.handle({ workspace_dir: WS, task_id: id, action: 'status' })
  const proj = effState.projectEffectiveState(WS, shared.getTask(WS, id))
  assert(st.observation?.progress !== 'done', `⑦ C 异范围成功不清除 B 的未决（得 ${brief(st.observation?.progress)}）`)
  assert(st.next_action?.args?.workdir === 'scope-b', `⑦ 下一步仍指 B 范围（得 ${brief(st.next_action?.args)}）`)
  assert(proj.unresolved_check && proj.unresolved_check.attempt_id === run.jobId, `⑦ 未决尝试是 B 的 job（得 ${brief(proj.unresolved_check)}）`)
  assert((st.observation?.effect_review || []).some(x => x.known?.workdir === 'scope-b'), `⑦ effect_review 含 B 且未被丢失（得 ${brief(st.observation?.effect_review)}）`)
  assert(!(proj.resolved_checks || []).some(x => x.job_id === run.jobId), `⑦ B 未被异范围 C 收口（resolved_checks 不含 B）`)
  // 四出口一致：resume/read 与 status 同口径（不得因 C 成功而 done）
  const rs = await control.handle({ workspace_dir: WS, task_id: id, action: 'resume' })
  const rd = await readMod.handle({ workspace_dir: WS, task_id: id, locator: { file_path: F } }, { codeIndexService: null })
  for (const [name, r] of [['resume', rs], ['read', rd]]) {
    assert(r.observation?.progress !== 'done', `⑦ ${name}: 异范围 C 不投影 done（得 ${brief(r.observation?.progress)}）`)
    assert(r.next_action?.args?.workdir === 'scope-b', `⑦ ${name}: 下一步仍指 scope-b（得 ${brief(r.next_action?.args)}）`)
  }
}

// ── ⑧ S1：根范围成功不自动覆盖子目录停止尝试（跨目录须显式契约）──
{
  const id = 'm2_8'
  mkTask(id)
  const run = await startAsync(id, 'scope-h')
  await cancelAndAssert(id, 'scope-h', run, 'job')
  setQuickRoot()
  const root = await check.handle({ workspace_dir: WS, task_id: id, checks: ['test'], timeout: 30000, verifier: 'exit', run: true }, {})
  assert(root.ok === true && root.observation?.result_kind === 'validated', `⑧ 根范围成功 → validated（得 ${brief(root.observation?.result_kind)}）`)
  const proj = effState.projectEffectiveState(WS, shared.getTask(WS, id))
  assert(proj.unresolved_check && proj.unresolved_check.scope?.workdir === 'scope-h', `⑧ 根结果不覆盖子目录（未决仍是 scope-h；得 ${brief(proj.unresolved_check)}）`)
  assert(proj.resolved_checks == null, `⑧ 无停止尝试被根范围收口（得 ${brief(proj.resolved_checks)}）`)
}

// ── ⑨ S2：B 带 request_id 取消 → B 同范围成功重验 → 必须收口（旧 indeterminate op 不卡完成）──
{
  const id = 'm2_9'
  mkTask(id)
  setQuick('scope-a')
  const a = await check.handle({ workspace_dir: WS, task_id: id, checks: ['test'], workdir: 'scope-a', timeout: 30000, verifier: 'exit', run: true }, {})
  assert(a.ok === true, `⑨ A 无 id 成功`)
  rmSync(join(WS, 'scope-a', 'quick.flag'), { force: true })
  const run = await startAsync(id, 'scope-i', { request_id: 'check-B9' })
  await cancelAndAssert(id, 'scope-i', run, 'operation')
  const st0 = await control.handle({ workspace_dir: WS, task_id: id, action: 'status' })
  assert(st0.observation?.progress !== 'done' && st0.next_action?.args?.workdir === 'scope-i', `⑨ 取消后未决在 scope-i（得 ${brief({ p: st0.observation?.progress, a: st0.next_action?.args })}）`)
  setQuick('scope-i')
  const re = await check.handle({ workspace_dir: WS, task_id: id, request_id: 'check-B9r', checks: ['test'], workdir: 'scope-i', timeout: 120000, verifier: 'exit', run: true }, {})
  assert(re.ok === true && re.observation?.result_kind === 'validated', `⑨ 同范围成功重验 → validated（得 ${brief({ ok: re.ok, k: re.observation?.result_kind, err: re.error })}）`)
  const st1 = await control.handle({ workspace_dir: WS, task_id: id, action: 'status' })
  const proj1 = effState.projectEffectiveState(WS, shared.getTask(WS, id))
  assert(st1.observation?.progress === 'done', `⑨ 带 id 的同范围重验收口（S2；得 ${brief(st1.observation?.progress)}）`)
  assert(st1.mechanical_requirements_met === true && st1.next_action === null, `⑨ 收口后 done 空动作（得 ${brief({ m: st1.mechanical_requirements_met, na: st1.next_action })}）`)
  assert(st1.observation?.effect_unknown !== true && (st1.observation?.effect_review || []).length === 0, `⑨ 收口后不再报 effect_unknown（得 ${brief({ u: st1.observation?.effect_unknown })}）`)
  assert(proj1.unresolved_check == null && (proj1.resolved_checks || []).length >= 1, `⑨ resolved_checks 记录收口（得 ${brief({ u: proj1.unresolved_check, r: proj1.resolved_checks?.length })}）`)
  assert(proj1.in_flight === null, `⑨ 旧 indeterminate op 不再算在途（得 ${brief(proj1.in_flight)}）`)
  // 四出口一致：check/resume/read 与 status 同口径（同一份覆盖事实）
  assert(re.next_action === null, `⑨ check 出口同口径 done 空动作（得 ${brief(re.next_action)}）`)
  const rs1 = await control.handle({ workspace_dir: WS, task_id: id, action: 'resume' })
  const rd1 = await readMod.handle({ workspace_dir: WS, task_id: id, locator: { file_path: F } }, { codeIndexService: null })
  for (const [name, r] of [['resume', rs1], ['read', rd1]]) {
    assert(r.observation?.progress === 'done' && r.next_action === null, `⑨ ${name}: 收口后一致 done（得 ${brief({ p: r.observation?.progress, na: r.next_action })}）`)
  }
}

// ── ⑩ S2：B 同范围重验失败 → 按既有失败规则转 partial（不留在 indeterminate）──
{
  const id = 'm2_10'
  mkTask(id)
  const run = await startAsync(id, 'scope-j', { request_id: 'check-B10' })
  await cancelAndAssert(id, 'scope-j', run, 'operation')
  writeFileSync(join(WS, 'scope-j', 'fail.flag'), '1')
  const re = await check.handle({ workspace_dir: WS, task_id: id, request_id: 'check-B10r', checks: ['test'], workdir: 'scope-j', timeout: 120000, verifier: 'exit', run: true }, {})
  assert(re.ok === true && re.observation?.result_kind === 'partial', `⑩ 同范围重验失败 → partial（得 ${brief({ ok: re.ok, k: re.observation?.result_kind })}）`)
  rmSync(join(WS, 'scope-j', 'fail.flag'), { force: true })
  const proj = effState.projectEffectiveState(WS, shared.getTask(WS, id))
  assert(proj.progress === 'partial' && proj.unresolved_check == null, `⑩ 失败重验收口为 partial（得 ${brief({ p: proj.progress, u: proj.unresolved_check })}）`)
  const st = await control.handle({ workspace_dir: WS, task_id: id, action: 'status' })
  assert(st.next_action?.tool === 'code_check', `⑩ 下一步是修复后重跑（得 ${brief(st.next_action)}）`)
}

// ── ⑪ 两个不同 scope 先后取消，只重验一个：另一个仍逐条未决 ──
{
  const id = 'm2_11'
  mkTask(id)
  const r1 = await startAsync(id, 'scope-d')
  await cancelAndAssert(id, 'scope-d', r1, 'job')
  const r2 = await startAsync(id, 'scope-e')
  await cancelAndAssert(id, 'scope-e', r2, 'job')
  const st2 = await control.handle({ workspace_dir: WS, task_id: id, action: 'status' })
  assert(st2.next_action?.args?.workdir === 'scope-e', `⑪ 两条未决时下一步指最新 scope-e（得 ${brief(st2.next_action?.args)}）`)
  assert(/remain unresolved/i.test(st2.next_action?.note || ''), `⑪ 两条未决时 note 说明逐条收口（得 ${brief(st2.next_action?.note)}）`)
  setQuick('scope-e')
  const re = await check.handle({ workspace_dir: WS, task_id: id, checks: ['test'], workdir: 'scope-e', timeout: 120000, verifier: 'exit', run: true }, {})
  assert(re.ok === true && re.observation?.result_kind === 'validated', `⑪ scope-e 重验成功`)
  const proj = effState.projectEffectiveState(WS, shared.getTask(WS, id))
  assert(proj.unresolved_check?.scope?.workdir === 'scope-d', `⑪ 只剩 scope-d 未决（逐条找后继；得 ${brief(proj.unresolved_check)}）`)
  assert((proj.unresolved_checks || []).length === 1, `⑪ 未决清单只 1 条（得 ${brief(proj.unresolved_checks?.length)}）`)
  assert((proj.resolved_checks || []).some(x => x.job_id === r2.jobId), `⑪ scope-e 记入 resolved_checks`)
  const st = await control.handle({ workspace_dir: WS, task_id: id, action: 'status' })
  assert(st.next_action?.args?.workdir === 'scope-d', `⑪ 下一步指未重验的 scope-d（得 ${brief(st.next_action?.args)}）`)
  assert(/workdir=scope-d/.test(st.next_action?.note || ''), `⑪ note 指未重验的 scope-d（得 ${brief(st.next_action?.note)}）`)
  const rev = st.observation?.effect_review || []
  assert(rev.some(x => x.known?.workdir === 'scope-d') && !rev.some(x => x.known?.workdir === 'scope-e'), `⑪ effect_review 只留未决的 scope-d（得 ${brief(rev.map(x => x.known?.workdir))}）`)
}

// ── ⑫ 真实进程重启（非仅清注册表）：独立子进程查询 ⑨（已收口）与 ⑪（未决）──
{
  const done = statusInChild('m2_9')
  assert(done.progress === 'done' && done.next === null, `⑫ 重启后 ⑨ 仍 done（得 ${brief(done)}）`)
  const pend = statusInChild('m2_11')
  assert(pend.progress === 'indeterminate' && pend.next?.args?.workdir === 'scope-d', `⑫ 重启后 ⑪ 仍指向 scope-d（得 ${brief(pend)}）`)
  assert(pend.effect_review.includes('scope-d') && !pend.effect_review.includes('scope-e'), `⑫ 重启后 effect_review 只含未决 scope-d（得 ${brief(pend.effect_review)}）`)
}

// ── ⑬ P2（复核四 2026-10-19）：多条混合身份停止记录，恢复动作必须跟随真正未收口的 attempt ──
// 旧实现：flight.kind=indeterminate 分支先 return，用 lastCheckParams（最近一次任何检查）选范围；
// D(id) 取消 + E 重验后仍指 E；根对照成功后指根。覆盖事实正确，但消费者绕过了 proj.unresolved_check。
const combos = [
  { tag: 'D-id/E-no', dScope: 'scope-k', eScope: 'scope-l', dId: 'p2-D1', eId: null },
  { tag: 'D-no/E-id', dScope: 'scope-m', eScope: 'scope-n', dId: null, eId: 'p2-E2' },
  { tag: 'D-id/E-id', dScope: 'scope-o', eScope: 'scope-p', dId: 'p2-D3', eId: 'p2-E3' },
  { tag: 'D-no/E-no', dScope: 'scope-k', eScope: 'scope-l', dId: null, eId: null },
]
for (const cse of combos) {
  const id = 'm2_13_' + cse.tag.replace(/[^a-z0-9]+/gi, '_')
  mkTask(id)
  const d = await startAsync(id, cse.dScope, cse.dId ? { request_id: cse.dId } : {})
  await cancelAndAssert(id, cse.dScope, d, cse.dId ? 'operation' : 'job')
  const e = await startAsync(id, cse.eScope, cse.eId ? { request_id: cse.eId } : {})
  await cancelAndAssert(id, cse.eScope, e, cse.eId ? 'operation' : 'job')
  // 根范围对照成功：不得把下一步带到根
  setQuickRoot()
  const root = await check.handle({ workspace_dir: WS, task_id: id, checks: ['test'], timeout: 30000, verifier: 'exit', run: true }, {})
  assert(root.ok === true && root.observation?.result_kind === 'validated', `⑬${cse.tag} 根对照成功 → validated（得 ${brief(root.observation?.result_kind)}）`)
  const stRoot = await control.handle({ workspace_dir: WS, task_id: id, action: 'status' })
  assert(stRoot.next_action?.args?.workdir === cse.eScope, `⑬${cse.tag} 根成功后下一步仍指最新未决 ${cse.eScope}（得 ${brief(stRoot.next_action?.args)}）`)
  assert(stRoot.next_action?.unresolved_attempt?.attempt_id === e.jobId, `⑬${cse.tag} unresolved_attempt 与 effect_review 同一条（得 ${brief(stRoot.next_action?.unresolved_attempt)}）`)
  // 只重验 E：下一步必须指剩余的 D
  setQuick(cse.eScope)
  const re = await check.handle({ workspace_dir: WS, task_id: id, checks: ['test'], workdir: cse.eScope, timeout: 120000, verifier: 'exit', run: true }, {})
  assert(re.ok === true && re.observation?.result_kind === 'validated', `⑬${cse.tag} 只重验 E → validated（得 ${brief(re.observation?.result_kind)}）`)
  assert(re.next_action?.args?.workdir === cse.dScope, `⑬${cse.tag} check 出口下一步指剩余 D（得 ${brief(re.next_action?.args)}）`)
  const rs = await control.handle({ workspace_dir: WS, task_id: id, action: 'resume' })
  const st = await control.handle({ workspace_dir: WS, task_id: id, action: 'status' })
  const rd = await readMod.handle({ workspace_dir: WS, task_id: id, locator: { file_path: F } }, { codeIndexService: null })
  for (const [name, r] of [['status', st], ['resume', rs], ['read', rd]]) {
    assert(r.observation?.progress === 'indeterminate', `⑬${cse.tag} ${name}: 仍 indeterminate（得 ${brief(r.observation?.progress)}）`)
    assert(r.next_action?.args?.workdir === cse.dScope, `⑬${cse.tag} ${name}: 下一步指剩余 D ${cse.dScope}（得 ${brief(r.next_action?.args)}）`)
  }
  const rev = st.observation?.effect_review || []
  assert(rev.some(x => x.known?.workdir === cse.dScope) && !rev.some(x => x.known?.workdir === cse.eScope), `⑬${cse.tag} effect_review 只留 D（得 ${brief(rev.map(x => x.known?.workdir))}）`)
  if (cse === combos[0]) {
    const child = statusInChild(id)
    assert(child.next?.args?.workdir === cse.dScope, `⑬ 独立进程重启后仍指 D（得 ${brief(child.next?.args)}）`)
  }
  // 重验 D → 全部收口
  setQuick(cse.dScope)
  const fin = await check.handle({ workspace_dir: WS, task_id: id, checks: ['test'], workdir: cse.dScope, timeout: 120000, verifier: 'exit', run: true }, {})
  assert(fin.ok === true && fin.observation?.result_kind === 'validated', `⑬${cse.tag} 重验 D → validated（得 ${brief(fin.observation?.result_kind)}）`)
  const stFin = await control.handle({ workspace_dir: WS, task_id: id, action: 'status' })
  assert(stFin.observation?.progress === 'done' && stFin.next_action === null, `⑬${cse.tag} 全部收口 → done 空动作（得 ${brief({ p: stFin.observation?.progress, na: stFin.next_action })}）`)
}

console.log(`\n=== test-m2-m3-check-attempt-identity: ${pass} passed, ${fail} failed ===`)
process.exit(fail === 0 ? 0 : 1)
