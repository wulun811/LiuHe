// test-s2-check.js — S2.1b 校验路径（code_check）失败/边界路径
// 覆盖：默认预览不执行、run=true 执行并记证据、通过→validated、失败→partial、
//       跳过（无 test 脚本）不作为通过、无 patch 不 validated、request_id 去重、W4 证据事件重放、鉴权错误。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP = join(os.tmpdir(), 'opencode', 's2-check-test')
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
process.env.MALONG_STATE_DIR = join(TMP, 'state')
process.env.MALONG_ENTRY_STATE = '1'

let pass = 0, fail = 0
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  FAIL:', msg) } }

const shared = await import(pathToFileURL(join(__dirname, '..', 'tools', 'entry-shared.js')).href)
const store = await import(pathToFileURL(join(__dirname, '..', 'tools', 'entry-store.js')).href)
const check = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-code-check', 'handler.js')).href)
const vp = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-verify-pipeline', 'handler.js')).href)
const ctx = {}

function mkWs(name, testScript) {
  const ws = join(TMP, name)
  mkdirSync(join(ws, 'tests'), { recursive: true })
  if (testScript !== null) {
    writeFileSync(join(ws, 'package.json'), JSON.stringify({ name, scripts: { test: testScript } }))
    const failCase = testScript.includes('fail')
    writeFileSync(join(ws, 'tests', failCase ? 'fail.test.js' : 't.test.js'), failCase ? "console.error('boom tail marker')\nprocess.exit(1)\n" : "console.log('1 passing')\n")
  } else {
    writeFileSync(join(ws, 'package.json'), JSON.stringify({ name }))
  }
  return ws
}
const snapPath = (ws, id) => join(process.env.MALONG_STATE_DIR, 'entry-tasks', store.wsHash(ws), `${id}.json`)
function mkTask(ws, id, { operations = [], result_kind, evidence = [], index_scope } = {}) {
  const t = { task_id: id, revision: 1, route: 'change', lifecycle: 'active', node: 'edit', materials: [], operations, evidence, workspace_dir: ws, ...(result_kind ? { result_kind } : {}), ...(index_scope ? { index_scope } : {}) }
  shared.putTask(ws, t, { type: 'task_created', task: t })
  return t
}
const patchOp = (id) => ({ operation_id: id, request_id: null, kind: 'patch', state: 'succeeded', file: 'a.txt', result_kind: 'partial' })

const WS = mkWs('ws', 'node tests/t.test.js')          // 通过
const WSF = mkWs('wsf', 'node tests/fail.test.js')      // 失败
const WSS = mkWs('wss', null)                           // 无 test 脚本 → skipped

// ── 预览：不执行、不记证据 ──
mkTask(WS, 'task_p', { operations: [patchOp('op_p1')], result_kind: 'partial' })
let r = await check.handle({ workspace_dir: WS, task_id: 'task_p', checks: ['test'] }, ctx)
assert(r.ok === true && r.observation?.effect === 'preview' && r.observation?.dry_run === true, '缺省 run → 预览')
assert(r.next_action?.tool === 'code_check' && r.next_action.args?.run === true && r.next_action.args?.task_id === 'task_p', '预览已含可调用 next_action（run=true；得 ' + JSON.stringify(r.next_action) + '）')
assert(store.getTask(WS, 'task_p').evidence.length === 0, '预览不记证据')
// dogfood ②b：async 无 run → 仍是预览，且 note 明示 async 被忽略（不再静默）
r = await check.handle({ workspace_dir: WS, task_id: 'task_p', checks: ['test'], async: true }, ctx)
assert(r.ok === true && r.observation?.effect === 'preview' && r.observation?.dry_run === true, 'async 无 run → 仍是 preview（不执行）')
assert(/ignored/i.test(r.observation?.note || ''), `async 无 run → note 明示被忽略（得 ${r.observation?.note}）`)

// ── 通过 → validated ──
r = await check.handle({ workspace_dir: WS, task_id: 'task_p', checks: ['test'], run: true, request_id: 'ck_1' }, ctx)
assert(r.ok === true && r.observation?.evidence?.[0]?.result === 'passed', `通过 → evidence passed（得 ${r.observation?.evidence?.[0]?.result}）`)
assert(r.observation?.evidence?.[0]?.source === 'verify_pipeline' && r.observation.evidence[0].provenance?.tool === 'verify_pipeline', 'T21 证据溯源 = verify_pipeline（委派）')
assert(r.observation?.result_kind === 'validated', `通过+有 patch → validated（得 ${r.observation?.result_kind}）`)
assert(store.getTask(WS, 'task_p').result_kind === 'validated', '持久化 result_kind=validated')
assert(r.next_action === null && r.progress === 'done' && r.mechanical_requirements_met === true && r.goal_judgment === 'host_required', '14-B AC03 validated → done 空动作 + host_required（得 ' + JSON.stringify({ na: r.next_action, p: r.progress, j: r.goal_judgment }) + '）')
assert(/validated/i.test(r.next_step || '') && /host_required/i.test(r.next_step || ''), '14-B AC03 done 说明仅工具侧完成（得 ' + (r.next_step || '').slice(0, 80) + '）')

// ── T18：扫描截断 → 证据 limitation（截断 ≠ 全量已查）──
mkTask(WS, 'task_trunc', { operations: [patchOp('op_t1')], result_kind: 'partial', index_scope: { files_scanned: 5000, files_indexed: 5000, truncated: true } })
r = await check.handle({ workspace_dir: WS, task_id: 'task_trunc', checks: ['test'], run: true, request_id: 'ck_trunc' }, ctx)
assert(r.ok === true && r.observation.evidence[0].actual?.truncated === true, 'T18 截断标记入证据 actual')
assert(r.observation.evidence[0].limitations.some(l => l.includes('truncated')), 'T18 截断 limitation')

// ── 去重：同 request_id 返回缓存证据 ──
const r2 = await check.handle({ workspace_dir: WS, task_id: 'task_p', checks: ['test'], run: true, request_id: 'ck_1' }, ctx)
assert(r2.ok === true && r2.observation?.deduplicated === true && r2.observation?.evidence?.length === 1, '同 id 去重返回证据')
assert(r2.next_action === null && r2.goal_judgment === 'host_required', '14-B AC03 dedup envelope 同 done 合同（得 ' + JSON.stringify({ na: r2.next_action, j: r2.goal_judgment }) + '）')

// ── 失败 → partial（有 patch 未通过）──
mkTask(WSF, 'task_f', { operations: [patchOp('op_f1')], result_kind: 'partial' })
r = await check.handle({ workspace_dir: WSF, task_id: 'task_f', checks: ['test'], run: true, request_id: 'ck_f' }, ctx)
assert(r.observation?.evidence?.[0]?.result === 'failed', `失败 → evidence failed（得 ${r.observation?.evidence?.[0]?.result}）`)
assert(typeof r.observation?.evidence?.[0]?.actual?.stderr_tail === 'string' && r.observation.evidence[0].actual.stderr_tail.includes('boom tail marker'), `Q3 失败证据含 stderr_tail（得 ${JSON.stringify(r.observation?.evidence?.[0]?.actual?.stderr_tail)}）`)
assert(r.observation?.result_kind === 'partial', `失败 → partial（得 ${r.observation?.result_kind}）`)
assert(r.next_action?.tool === 'code_patch' && /did not pass/.test(r.next_action.note || ''), '8-补 失败 → next_action 指回 code_patch 修复（得 ' + JSON.stringify(r.next_action) + '）')

// ── 残留②：超时 → failed（非 unknown），证据含 timed_out + limitation（先红后绿）──
const WSTO = mkWs('wsto', 'node -e "setTimeout(()=>{}, 30000)"')
mkTask(WSTO, 'task_to', { operations: [patchOp('op_to1')], result_kind: 'partial' })
r = await check.handle({ workspace_dir: WSTO, task_id: 'task_to', checks: ['test'], run: true, request_id: 'ck_to', timeout: 1 }, ctx)
assert(r.ok === true && r.observation?.evidence?.[0]?.result === 'failed', `超时 → failed（得 ${r.observation?.evidence?.[0]?.result}）`)
assert(r.observation?.evidence?.[0]?.actual?.timed_out === true, `超时证据 actual.timed_out=true（得 ${JSON.stringify(r.observation?.evidence?.[0]?.actual)}）`)
assert(r.observation?.evidence?.[0]?.limitations?.some(l => /timed out/i.test(l)), `超时 limitation 明示（得 ${JSON.stringify(r.observation?.evidence?.[0]?.limitations)}）`)
assert(r.observation?.result_kind === 'partial', `超时不 validated（得 ${r.observation?.result_kind}）`)

// ── 跳过（无 test 脚本）不做通过 ──
mkTask(WSS, 'task_s', { operations: [patchOp('op_s1')], result_kind: 'partial' })
r = await check.handle({ workspace_dir: WSS, task_id: 'task_s', checks: ['test'], run: true, request_id: 'ck_s' }, ctx)
assert(r.observation?.evidence?.[0]?.result === 'skipped', `空运行 → skipped（得 ${r.observation?.evidence?.[0]?.result}）`)
assert(r.observation?.result_kind === 'partial', `skipped 不 validated（得 ${r.observation?.result_kind}）`)
// WP08R-3 A1：环境性未验证分流——不指回 code_patch（旧版误导模型去改没问题的代码）
assert(r.next_action === null, `环境性 skipped → next_action=null（得 ${JSON.stringify(r.next_action)}）`)
assert(/environment limitation, not a code defect/.test(r.next_step || ''), `环境性 skipped → next_step 明示非代码缺陷（得 ${r.next_step}）`)

// ── exit 0 但 0 测试 → skipped，不 validated（G3/§7.4）──
const WSZ = join(TMP, 'wsz'); mkdirSync(WSZ, { recursive: true })
writeFileSync(join(WSZ, 'package.json'), JSON.stringify({ name: 'wsz', scripts: { test: 'node -e "process.exit(0)"' } }))
mkTask(WSZ, 'task_z', { operations: [patchOp('op_z')], result_kind: 'partial' })
r = await check.handle({ workspace_dir: WSZ, task_id: 'task_z', checks: ['test'], run: true, request_id: 'ck_z' }, ctx)
assert(r.observation?.evidence?.[0]?.result === 'skipped', `exit0 但 0 测试 → skipped（得 ${r.observation?.evidence?.[0]?.result}）`)
assert(r.observation?.result_kind !== 'validated', `0 测试不算绿（得 ${r.observation?.result_kind}）`)
// WP08R-3 W4-C F1：ran+exit0 但无协议 → 教 verifier:'exit'（可执行 next_action），不是"无可运行检查"
assert(r.next_action?.tool === 'code_check' && r.next_action?.args?.verifier === 'exit' && r.next_action?.args?.run === true, `exit0 无协议 → next_action 教 verifier=exit（得 ${JSON.stringify(r.next_action)}）`)
assert(/protocol\/declaration gap, not a code defect/.test(r.next_step || ''), `exit0 无协议 → next_step 明示协议缺口非代码缺陷（得 ${r.next_step}）`)
const rz2 = await check.handle({ workspace_dir: WSZ, task_id: 'task_z', checks: ['test'], run: true, request_id: 'ck_z2', verifier: 'exit' }, ctx)
assert(rz2.observation?.evidence?.[0]?.result === 'passed' && rz2.observation?.result_kind === 'validated', `verifier=exit 声明后 exit0 → passed/validated（得 ${rz2.observation?.evidence?.[0]?.result}/${rz2.observation?.result_kind}）`)

// ── WP08R-4：lint 兜底不可用 = unavailable（c1b 实拍：无 lint 脚本 + npx 无法解析 eslint → 旧版误报 failed）──
assert(vp.lintUnavailableReason(false, false, 'npm error npx canceled due to missing packages and no YES option: ["eslint@10.12.0"]', '') !== null, 'npx canceled 样本 → unavailable 理由（得 null）')
assert(vp.lintUnavailableReason(false, false, 'sh: eslint: command not found', '') !== null, 'eslint command not found 样本 → unavailable 理由（得 null）')
assert(vp.lintUnavailableReason('lint', false, 'npx canceled due to missing packages', '') === null, '有项目 lint 脚本时真失败不吞（得非 null）')
assert(vp.lintUnavailableReason(false, true, '', '') === null, 'lint 通过不走 unavailable（防御）')
const WSL = join(TMP, 'wsl'); mkdirSync(WSL, { recursive: true })
writeFileSync(join(WSL, 'package.json'), JSON.stringify({ name: 'wsl', private: true }))
mkTask(WSL, 'task_l', { operations: [patchOp('op_l')], result_kind: 'partial' })
r = await check.handle({ workspace_dir: WSL, task_id: 'task_l', checks: ['lint'], run: true, request_id: 'ck_l' }, ctx)
assert(r.observation?.evidence?.[0]?.result === 'unavailable', `无 lint 脚本且 eslint 不可解析 → unavailable（得 ${r.observation?.evidence?.[0]?.result}）`)
assert(r.next_action === null && /environment limitation/.test(r.next_step || ''), `全 unavailable → next_action=null 环境限制（得 ${JSON.stringify(r.next_action)}）`)
writeFileSync(join(WSL, 'package.json'), JSON.stringify({ name: 'wsl', private: true, scripts: { lint: 'node -e "process.exit(1)"' } }))
mkTask(WSL, 'task_l2', { operations: [patchOp('op_l2')], result_kind: 'partial' })
r = await check.handle({ workspace_dir: WSL, task_id: 'task_l2', checks: ['lint'], run: true, request_id: 'ck_l2' }, ctx)
assert(r.observation?.evidence?.[0]?.result === 'failed', `有 lint 脚本且真失败 → failed（不得吞成 unavailable，得 ${r.observation?.evidence?.[0]?.result}）`)

// ── WP08R-3 A1：部分可跑（passed+skipped，无 failed）→ next_action=null 不误指修复 ──
mkTask(WS, 'task_mix', { operations: [patchOp('op_mix')], result_kind: 'partial' })
r = await check.handle({ workspace_dir: WS, task_id: 'task_mix', checks: ['test', 'typecheck'], run: true, request_id: 'ck_mix' }, ctx)
assert(r.observation?.evidence?.length === 2, `混合检查 → 两条证据（得 ${r.observation?.evidence?.length}）`)
assert(r.observation?.evidence?.some(e => e.result === 'passed') && r.observation?.evidence?.some(e => e.result === 'skipped' || e.result === 'unavailable'), `混合检查 → passed+skipped（得 ${JSON.stringify((r.observation?.evidence || []).map(e => e.kind + ':' + e.result))}）`)
assert(r.next_action === null, `部分可跑无失败 → next_action=null（得 ${JSON.stringify(r.next_action)}）`)
assert(/Partially verified/.test(r.next_step || ''), `部分可跑 → next_step 列明细（得 ${r.next_step}）`)

// ── batch 成功写 → validated（回归修复：此前只认 patch）──
const batchOp = (id) => ({ operation_id: id, request_id: null, kind: 'batch', state: 'succeeded', files: ['a.txt'], result_hashes: {}, result_kind: 'partial' })
mkTask(WS, 'task_b', { operations: [batchOp('op_b')], result_kind: 'partial' })
r = await check.handle({ workspace_dir: WS, task_id: 'task_b', checks: ['test'], run: true, request_id: 'ck_b' }, ctx)
assert(r.observation?.result_kind === 'validated', `batch+通过 → validated（得 ${r.observation?.result_kind}）`)

// ── 无 patch → 即便通过也不 validated ──
mkTask(WS, 'task_n', { operations: [], result_kind: 'analysis_only' })
r = await check.handle({ workspace_dir: WS, task_id: 'task_n', checks: ['test'], run: true, request_id: 'ck_n' }, ctx)
assert(r.observation?.evidence?.[0]?.result === 'passed' && r.observation?.result_kind === 'analysis_only', `无 patch → analysis_only（得 ${r.observation?.result_kind}）`)
assert(r.next_action?.tool === 'code_patch' && /no patch|analysis_only/i.test(r.next_action.note || ''), '8-补 analysis_only note 不误称未验证（得 ' + JSON.stringify(r.next_action) + '）')

// ── 8-补：async accepted envelope 挂 next_action（code_control job 轮询）──
const WSA = mkWs('wsa', 'node tests/t.test.js')
mkTask(WSA, 'task_a', { operations: [patchOp('op_a1')], result_kind: 'partial' })
r = await check.handle({ workspace_dir: WSA, task_id: 'task_a', checks: ['test'], run: true, async: true, request_id: 'ck_a' }, ctx)
assert(r.ok === true && r.observation?.accepted === true && !!r.observation?.job_id, '8-补 async accepted 前置（得 ' + JSON.stringify(r.observation || r.error) + '）')
assert(r.next_action?.tool === 'code_control' && r.next_action.args?.action === 'job' && r.next_action.args?.job_id === r.observation.job_id, '8-补 async accepted next_action 指向 job 轮询（得 ' + JSON.stringify(r.next_action) + '）')
{
  const control = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-code-control', 'handler.js')).href)
  for (let i = 0; i < 50; i++) {
    const j = await control.handle({ workspace_dir: WSA, task_id: 'task_a', action: 'job', job_id: r.observation.job_id })
    const st = j.observation?.job?.state
    if (st && !['running', 'cancelling'].includes(st)) break
    await new Promise(res => setTimeout(res, 100))
  }
}

// ── 参数/鉴权错误 ──
assert((await check.handle({ workspace_dir: WS, task_id: 'task_p', checks: ['nope'], run: true }, ctx)).error === 'invalid_input', '未知 kind')
assert((await check.handle({ workspace_dir: WS, task_id: 'task_p', checks: [] }, ctx)).error === 'missing_parameter', '空 checks')
assert((await check.handle({ workspace_dir: WS, task_id: 'ghost' }, ctx)).error === 'task_not_found', '未知 task')
assert((await check.handle({ workspace_dir: join(TMP, 'nope'), task_id: 'x' }, ctx)).error === 'invalid_input', 'workspace 不存在')

// ── W4：快照缺失 → 事件重建保留 evidence ──
rmSync(snapPath(WS, 'task_p'), { force: true })
assert(!existsSync(snapPath(WS, 'task_p')), 'W4 前置：快照已删')
const rebuilt = store.getTask(WS, 'task_p')
assert(rebuilt && Array.isArray(rebuilt.evidence) && rebuilt.evidence.length === 1, 'W4 事件重建保留 evidence')
assert(rebuilt.result_kind === 'validated' && rebuilt.evidence[0].result === 'passed', 'W4 result_kind/evidence 重放')

// ── G2-E（ADR-019）：workdir 透传到 verify-pipeline（tsc-check dir 等价；以证据 scope 取证）──
{
  const WS3 = mkWs('wdir', null)
  mkTask(WS3, 'task_wdir')
  const rw = await check.handle({ workspace_dir: WS3, task_id: 'task_wdir', checks: ['typecheck'], run: true, workdir: 'sub' }, ctx)
  const evW = (rw.observation?.evidence || [])[0]
  assert(rw.ok === true && evW && evW.scope === 'sub', 'G2-E workdir 传到 verify-pipeline（证据 scope=sub；得 ' + JSON.stringify({ scope: evW && evW.scope, result: evW && evW.result }) + '）')
}

console.log(`\n=== test-s2-check: ${pass} passed, ${fail} failed ===`)
process.exit(fail > 0 ? 1 : 0)