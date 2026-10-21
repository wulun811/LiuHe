// test-n2-async-cancel-scope.js — N2（0.5.14 Windows 复核余口）
// 场景：后台检查（async=true）取消后，「进程已停、效果未核」的同一事实必须在
//       cancel_job / code_status / code_control(resume) 三处可见，且恢复建议复用原
//       checks/workdir/timeout/verifier（无公开 request_id 也不丢），原样执行不落到仓库根。
// 覆盖：不带 request_id 与带 request_id 两条真实父子进程取消对照。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP = join(os.tmpdir(), 'opencode', 'n2-async-cancel-test')
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
const WS = join(TMP, 'ws')
const WORK = join(WS, 'acceptance-process')
mkdirSync(WORK, { recursive: true })
process.env.MALONG_STATE_DIR = join(TMP, 'state')
process.env.MALONG_ENTRY_STATE = '1'

let pass = 0, fail = 0
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  FAIL:', msg) } }

// 慢测试脚本：记录 cwd + 自身/子进程 pid，子进程真实存活；快速标志存在时立即 0 退出。
writeFileSync(join(WORK, 'slow.js'), `
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const here = __dirname
fs.writeFileSync(path.join(here, 'ran-cwd.txt'), process.cwd())
fs.writeFileSync(path.join(here, 'parent.pid'), String(process.pid))
if (fs.existsSync(path.join(here, 'quick.flag'))) process.exit(0)
const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore' })
fs.writeFileSync(path.join(here, 'child.pid'), String(child.pid))
setTimeout(() => process.exit(0), 60000)
`)
writeFileSync(join(WORK, 'package.json'), JSON.stringify({ name: 'n2-work', private: true, scripts: { test: 'node slow.js' } }, null, 2))
writeFileSync(join(WS, 'a.txt'), 'alpha\n')

const shared = await import(pathToFileURL(join(__dirname, '..', 'tools', 'entry-shared.js')).href)
const check = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-code-check', 'handler.js')).href)
const control = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-code-control', 'handler.js')).href)
const jobs = await import(pathToFileURL(join(__dirname, '..', 'workflow', 'jobs.js')).href)

const F = 'a.txt'
const CONTENT = 'alpha\n'
const h = (s) => `sha256:${shared.sha256Hex(s)}`
function mkTask(id) {
  const t = {
    task_id: id, revision: 1, route: 'change', goal: 'change alpha', node: 'check', lifecycle: 'active', result_kind: 'partial',
    materials: [{ read_ref: 'read_1', locator: { file_path: F }, canonical_path: F, file_version: { hash: h(CONTENT) }, symbol_version: null }],
    operations: [{ operation_id: 'op_patch', kind: 'patch', request_id: null, state: 'succeeded', file: F, result_file_hash: h(CONTENT), result_kind: 'partial' }],
    evidence: [{ evidence_id: 'e1', kind: 'test', result: 'passed', operation_id: 'op_patch', scope: null, actual: { ran: true, exit_code: 0, duration_ms: 5 }, limitations: [] }],
    candidates: [{ file_path: F, name: 'alpha' }], workspace_dir: WS,
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
function readPid(name) { try { return parseInt(readFileSync(join(WORK, name), 'utf-8').trim()) } catch { return 0 } }

// ── ① 不带 request_id：async 检查取消后恢复范围不漂移 ──
{
  mkTask('n2a')
  const r = await check.handle({
    workspace_dir: WS, task_id: 'n2a', checks: ['test'], workdir: 'acceptance-process',
    timeout: 120000, verifier: 'exit', run: true, async: true,
  }, {})
  assert(r.ok === true && r.job_id, '① async 检查被接受（得 ' + JSON.stringify({ ok: r.ok, job: r.job_id, err: r.error }) + '）')
  const jobId = r.job_id
  assert(await waitFor(() => readPid('parent.pid') > 0), '① 真实父进程已启动并记录 pid')
  const pPid = readPid('parent.pid')
  assert(await waitFor(() => readPid('child.pid') > 0), '① 真实子进程已启动并记录 pid')
  const cPid = readPid('child.pid')
  assert(existsSync(join(WORK, 'ran-cwd.txt')) && readCwdOk(), '① 检查在 acceptance-process 内执行（cwd 记录）')

  // job 记录里必须有请求范围快照（不依赖公开 request_id）
  const job = jobs.getJob(WS, jobId)
  assert(job && job.params && job.params.checks?.[0] === 'test' && job.params.workdir === 'acceptance-process', '① job 持久化 checks/workdir（得 ' + JSON.stringify(job?.params) + '）')
  assert(job.params.timeout === 120000 && job.params.verifier === 'exit', '① job 持久化 timeout/verifier')

  const c = await control.handle({ workspace_dir: WS, task_id: 'n2a', action: 'cancel_job', job_id: jobId, wait_ms: 8000 })
  assert(c.ok === true && c.observation.cancelled === true && c.observation.confirmed === true, '① 取消确认（进程已停）')
  assert(c.observation.effect_unknown === true && c.observation.effect_review?.length === 1, '① 取消返回 effect_review')
  const rev = c.observation.effect_review[0]
  assert(rev.known.checks?.[0] === 'test' && rev.known.workdir === 'acceptance-process', '① effect_review 保留原范围（得 ' + JSON.stringify(rev.known) + '）')
  assert(rev.known.timeout === 120000 && rev.known.verifier === 'exit', '① effect_review 保留 timeout/verifier')
  assert(rev.effect_judgment === 'host_required' && rev.stopped === true, '① effect_judgment=host_required + stopped')
  assert(/SAME scope/.test(rev.host_check) && /acceptance-process/.test(rev.host_check), '① host_check 指向同一 scope')
  assert(await waitFor(() => !alive(pPid) && !alive(cPid), 15000), '① 取消后父/子进程都已结束（pid ' + pPid + '/' + cPid + '）')

  // status / resume 看到同一事实
  const st = await control.handle({ workspace_dir: WS, task_id: 'n2a', action: 'status' })
  assert(st.ok === true && st.observation.effect_unknown === true, '① status 显示 effect_unknown')
  assert((st.observation.effect_review || []).some(x => x.job_id === jobId && x.known?.workdir === 'acceptance-process'), '① status 的 effect_review 含该 job 与原范围')
  const rs = await control.handle({ workspace_dir: WS, task_id: 'n2a', action: 'resume' })
  const na = rs.next_action
  assert(na && na.tool === 'code_check', '① resume 下一步是 code_check（得 ' + JSON.stringify(na && na.tool) + '）')
  assert(na.args.workdir === 'acceptance-process', '① resume 复用 workdir（旧实现落到仓库根；得 ' + JSON.stringify(na.args.workdir) + '）')
  assert(na.args.timeout === 120000 && na.args.verifier === 'exit' && na.args.checks?.[0] === 'test', '① resume 复用 timeout/verifier/checks')
  assert(na.effect_judgment === 'host_required' && na.optional === true, '① 停止≠回滚：交还宿主且重验标 optional')
  assert(/cancel ≠ rollback|stopped/i.test(na.note || ''), '① 文案明说停止≠回滚')

  // 原样执行恢复动作：快速标志 → 立即通过；检查仍必须落在 acceptance-process
  writeFileSync(join(WORK, 'quick.flag'), '1')
  rmSync(join(WORK, 'ran-cwd.txt'), { force: true })
  const re = await check.handle(na.args, {})
  assert(re.ok === true, '① 原样执行恢复动作成功（得 ' + JSON.stringify({ ok: re.ok, err: re.error, kind: re.result_kind }) + '）')
  assert(existsSync(join(WORK, 'ran-cwd.txt')), '① 恢复动作确实执行了子目录脚本')
  assert(readCwdOk(), '① 恢复动作未漂移到仓库根（cwd=' + (readCwd() || '') + '）')
}

// ── ② 带 request_id：取消后仍走 operation 记录，范围一致 ──
{
  mkTask('n2b')
  rmSync(join(WORK, 'quick.flag'), { force: true })
  rmSync(join(WORK, 'parent.pid'), { force: true })
  rmSync(join(WORK, 'child.pid'), { force: true })
  const r = await check.handle({
    workspace_dir: WS, task_id: 'n2b', request_id: 'req_n2b', checks: ['test'], workdir: 'acceptance-process',
    timeout: 120000, verifier: 'exit', run: true, async: true,
  }, {})
  assert(r.ok === true && r.job_id, '② 带 request_id 的 async 检查被接受')
  const jobId = r.job_id
  assert(await waitFor(() => readPid('child.pid') > 0), '② 子进程已启动')
  const pPid = readPid('parent.pid'); const cPid = readPid('child.pid')
  const c = await control.handle({ workspace_dir: WS, task_id: 'n2b', action: 'cancel_job', job_id: jobId, wait_ms: 8000 })
  assert(c.ok === true && c.observation.cancelled === true, '② 取消确认')
  const rev = c.observation.effect_review[0]
  assert(rev.known.workdir === 'acceptance-process' && rev.known.timeout === 120000 && rev.known.verifier === 'exit', '② effect_review 范围一致')
  assert(rev.known.scope_source === 'operation', '② 带 id 路径优先用 operation 记录（得 ' + JSON.stringify(rev.known.scope_source) + '）')
  assert(await waitFor(() => !alive(pPid) && !alive(cPid), 15000), '② 取消后父/子进程都已结束')
  const rs = await control.handle({ workspace_dir: WS, task_id: 'n2b', action: 'resume' })
  assert(rs.next_action?.args?.workdir === 'acceptance-process', '② resume 复用 workdir')
  assert(rs.next_action?.args?.timeout === 120000 && rs.next_action?.args?.verifier === 'exit', '② resume 复用 timeout/verifier')
}

function readCwd() { try { return readFileSync(join(WORK, 'ran-cwd.txt'), 'utf-8').trim() } catch { return '' } }
// macOS：os.tmpdir() 是 /var/...，子进程 process.cwd() 返回物理路径 /private/var/...
function readCwdOk() {
  const cwd = readCwd()
  if (!cwd) return false
  if (cwd === WORK) return true
  try { return cwd === realpathSync(WORK) } catch { return false }
}

console.log(`\n=== test-n2-async-cancel-scope: ${pass} passed, ${fail} failed ===`)
process.exit(fail === 0 ? 0 : 1)
