// test-s4-audit.js — S4.2 code_audit（审查 + 保守死代码 + 误报台账，G4）
// 覆盖：run 采集证据（含 rule_version）、零命中不证明安全（limitation）、死代码 auto_remove=false、
//        accept 记台账带理由、再 run 该发现被抑制、ledger 列表、参数/闭集/串线错误。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP = join(os.tmpdir(), 'opencode', 's4-audit-test')
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
const WS = join(TMP, 'ws'); mkdirSync(WS, { recursive: true })
process.env.MALONG_STATE_DIR = join(TMP, 'state')
process.env.MALONG_ENTRY_STATE = '1'

let pass = 0, fail = 0
const assert = (c, m) => { if (c) pass++; else { fail++; console.error('  FAIL:', m) } }
const imp = (p) => import(pathToFileURL(p).href)

const store = await imp(join(__dirname, '..', 'tools', 'entry-store.js'))
const audit = await imp(join(__dirname, '..', 'tools', 'tool-code-audit', 'handler.js'))

writeFileSync(join(WS, 'package.json'), JSON.stringify({ name: 'x' }))
writeFileSync(join(WS, 'foo_bar.js'), 'export function do_thing(a) { return a }\nexport function unused_fn() { return 1 }\n')
const tid = 'task_a'
const task = { task_id: tid, revision: 1, lifecycle: 'active', route: 'review', node: 'read', workspace_dir: WS, materials: [{ read_ref: 'read_1', canonical_path: 'foo_bar.js', locator: { file_path: 'foo_bar.js' } }], operations: [], evidence: [], index_scope: { files_scanned: 5000, files_indexed: 5000, truncated: true } }
store.putTask(WS, task, { type: 'task_created', task })

// ── run：采集证据 ──
let r = await audit.handle({ workspace_dir: WS, task_id: tid, checks: ['code_review', 'security_review', 'dead_code'] }, {})
assert(r.ok === true, 'code_audit run 成功')
assert(r.observation.counts.active >= 1, `发现 code_review issues（得 ${r.observation.counts.active}）`)
assert(r.observation.safe_to_remove === false, 'safe_to_remove 恒 false（G4 不自动删）')
assert(r.awaiting_decision === true && r.next_action?.tool === 'code_control', '13-C findings → awaiting_decision + next_action 交还（得 ' + JSON.stringify(r.next_action || null) + '）')
const cv = r.observation.findings.find(f => f.check === 'code_review' && f.message.includes('snake_case'))
assert(cv && cv.rule_version === 'shape-v2' && typeof cv.fingerprint === 'string', '发现带 rule_version + fingerprint')
const ev = r.observation.evidence
assert(ev.length === 3 && ev.every(e => e.rule_version), '三类证据均带 rule_version')
const dcEv = ev.find(e => e.kind === 'audit:dead_code')
assert(dcEv.limitations.some(l => l.includes('auto-remove disabled')), '死代码证据标注不自动删')
const srEv = ev.find(e => e.kind === 'audit:security_review')
assert(srEv.result === 'passed' && srEv.limitations.some(l => l.includes('does not prove absence')), '零命中→passed 但带「不证明安全」限制（G4）')
assert(ev.every(e => e.source && e.provenance && e.provenance.via === 'delegate'), 'T21 证据溯源（source+provenance）')
assert(dcEv.source === 'sweep_dead_code', 'T21 dead_code 溯源到 sweep_dead_code')
assert(ev.every(e => e.actual?.scope_truncated === true), 'T18 截断标记入审计证据 actual')
assert(ev.every(e => e.limitations.some(l => l.includes('truncated'))), 'T18 截断 limitation 入审计证据')
assert(store.getTask(WS, tid).evidence.length === 3, '证据持久化')
assert(ev.every(e => e.goal_revision === 1), '14-A AC30 审查证据记录 goal_revision（得 ' + JSON.stringify(ev.map(e => e.goal_revision)) + '）')

// ── accept：误报台账记理由 ──
let a = await audit.handle({ workspace_dir: WS, task_id: tid, action: 'accept', fingerprint: cv.fingerprint }, {})
assert(a.error === 'missing_parameter', 'accept 缺 reason 拒绝')
a = await audit.handle({ workspace_dir: WS, task_id: tid, action: 'accept', fingerprint: cv.fingerprint, reason: 'documented naming convention for this legacy module' }, {})
assert(a.ok === true && a.observation.accepted === true, 'accept 记入台账')

// ── ledger 列表 ──
const led = await audit.handle({ workspace_dir: WS, task_id: tid, action: 'ledger' }, {})
assert(led.count === 1 && led.observation.ledger[0].fingerprint === cv.fingerprint, 'ledger 返回已接受条目')

// ── 再 run：该发现被抑制 ──
const r2 = await audit.handle({ workspace_dir: WS, task_id: tid, checks: ['code_review'] }, {})
const accepted = r2.observation.findings.find(f => f.fingerprint === cv.fingerprint)
assert(accepted && accepted.accepted === true && accepted.accepted_reason, '重跑该发现标 accepted 并带理由')
assert(r2.observation.counts.active === 2 && r2.observation.counts.accepted >= 1, `活跃数下降（active=${r2.observation.counts.active}, accepted=${r2.observation.counts.accepted}）`)

// ── 错误路径 ──
assert((await audit.handle({ workspace_dir: WS, task_id: tid, checks: ['nope'] }, {})).error === 'invalid_input', '未知 check 拒绝')
assert((await audit.handle({ workspace_dir: WS, task_id: 'no_such' }, {})).error === 'task_not_found', '未知 task 拒绝')
const other = join(TMP, 'other'); mkdirSync(other, { recursive: true })
assert((await audit.handle({ workspace_dir: other, task_id: tid }, {})).error === 'task_not_found', '跨 workspace（他处无此 task）拒绝')

// ── live 审查 J3：部分文件扫描失败 → limitation + actual.errored_files（不读作干净通过）──
writeFileSync(join(WS, 'clean.js'), 'export const ok = 1\n')
const rj = await audit.handle({ workspace_dir: WS, task_id: tid, checks: ['security_review'], files: ['does_not_exist.js', 'clean.js'] }, {})
const jev = rj.observation.evidence.find(e => e.kind === 'audit:security_review')
assert((jev?.actual?.errored_files || []).length === 1, `J3 errored_files 记录未扫描文件（得 ${JSON.stringify(jev?.actual)}）`)
assert(jev?.limitations?.some(l => l.includes('NOT scanned')), `J3 未扫描文件 limitation 明示（得 ${JSON.stringify(jev?.limitations)}）`)

// ── S1：复合后缀命名不误报（greeting.test.js 主体 kebab-case）──
{
  writeFileSync(join(WS, 'greeting.test.js'), 'export const a = 1\n')
  const tNaming = { task_id: 'task_naming', revision: 1, lifecycle: 'active', route: 'review', node: 'read', workspace_dir: WS, materials: [{ read_ref: 'read_1', canonical_path: 'greeting.test.js', locator: { file_path: 'greeting.test.js' } }], operations: [], evidence: [] }
  store.putTask(WS, tNaming, { type: 'task_created', task: tNaming })
  const rn = await audit.handle({ workspace_dir: WS, task_id: 'task_naming', checks: ['code_review'] }, {})
  assert(!rn.observation.findings.some(f => f.category === 'naming' && f.file === 'greeting.test.js'), `S1 测试文件命名不误报（得 ${JSON.stringify(rn.observation.findings.map(f => f.message))}）`)
}

// ── LH-009（2026-10-07）：工作区型分析器证据必须覆盖「扫描范围」——未列入 files 的文件变化也要 stale ──
{
  const evidence = await imp(join(__dirname, '..', 'workflow', 'evidence.js'))
  const tidWs = 'task_ws_dep'
  const tWs = { task_id: tidWs, revision: 1, lifecycle: 'active', route: 'review', node: 'read', workspace_dir: WS, materials: [{ read_ref: 'read_1', canonical_path: 'foo_bar.js', locator: { file_path: 'foo_bar.js' } }], operations: [], evidence: [] }
  store.putTask(WS, tWs)
  const rw = await audit.handle({ workspace_dir: WS, task_id: tidWs, checks: ['dead_code'] }, {})
  const wev = rw.observation.evidence.find(e => e.kind === 'audit:dead_code')
  assert(wev.depends_on.some(d => d.scope !== undefined), '工作区型证据带 scope 依赖（得 ' + JSON.stringify(wev.depends_on) + '）')
  assert(wev.actual.scope && wev.actual.scope.kind === 'workspace' && wev.actual.scope.files >= 1, 'actual 透出工作区扫描范围（得 ' + JSON.stringify(wev.actual.scope) + '）')
  assert(!evidence.isEvidenceStale(WS, wev), '未变化 → 工作区证据不 stale')

  writeFileSync(join(WS, 'unrelated_outside.js'), 'export const un = 1\n')
  assert(evidence.isEvidenceStale(WS, wev), '未列入 files 的被扫文件变化 → 工作区证据 stale（LH-009 核心）')
  assert(evidence.staleEvidenceIds(WS, store.getTask(WS, tidWs)).includes(wev.evidence_id), 'staleEvidenceIds 纳入工作区证据')

  mkdirSync(join(WS, 'sub'), { recursive: true })
  writeFileSync(join(WS, 'sub', 'a.js'), 'export const subA = 1\n')
  const rs = await audit.handle({ workspace_dir: WS, task_id: tidWs, checks: ['dead_code'], scope: 'sub' }, {})
  const sev = rs.observation.evidence.find(e => e.kind === 'audit:dead_code')
  assert(sev.depends_on.some(d => d.scope === 'sub'), 'scope 限定证据记录 scope=sub（得 ' + JSON.stringify(sev.depends_on) + '）')
  assert(!evidence.isEvidenceStale(WS, sev), 'sub 未变 → 不 stale')
  writeFileSync(join(WS, 'outside2.js'), 'export const out2 = 1\n')
  assert(!evidence.isEvidenceStale(WS, sev), 'scope 外文件变化 → sub 证据不 stale')
  writeFileSync(join(WS, 'sub', 'a.js'), 'export const subA = 2\n')
  assert(evidence.isEvidenceStale(WS, sev), 'scope 内文件变化 → sub 证据 stale')
  assert(evidence.staleEvidenceIds(WS, store.getTask(WS, tidWs)).includes(sev.evidence_id), 'staleEvidenceIds 纳入 scope 证据')

  const rf = await audit.handle({ workspace_dir: WS, task_id: tidWs, checks: ['code_review'], files: ['foo_bar.js'] }, {})
  const fev = rf.observation.evidence.find(e => e.kind === 'audit:code_review')
  assert(fev.depends_on.every(d => d.file), '文件型证据只依赖 files（得 ' + JSON.stringify(fev.depends_on) + '）')
  writeFileSync(join(WS, 'another_unrelated.js'), 'export const x = 1\n')
  assert(!evidence.isEvidenceStale(WS, fev), '无关文件变化 → 文件型证据不连坐')
}

// ── 14-B AC18：同 kind 异 scope 证据独立——后查文件不覆盖先查文件的范围证明 ──
{
  const statusMod = await imp(join(__dirname, '..', 'tools', 'tool-code-status', 'handler.js'))
  const tid18 = 'task_ac18'
  const t18 = { task_id: tid18, revision: 1, lifecycle: 'active', route: 'review', node: 'review', workspace_dir: WS, goal_revision: 1, materials: [{ read_ref: 'read_1', canonical_path: 'foo_bar.js', locator: { file_path: 'foo_bar.js' } }], operations: [], evidence: [] }
  store.putTask(WS, t18, { type: 'task_created', task: t18 })
  writeFileSync(join(WS, 'other_file.js'), 'export function other_fn(a) { return a }\n')
  const rf18 = await audit.handle({ workspace_dir: WS, task_id: tid18, checks: ['code_review'], files: ['foo_bar.js'] }, {})
  const ro18 = await audit.handle({ workspace_dir: WS, task_id: tid18, checks: ['code_review'], files: ['other_file.js'] }, {})
  assert(rf18.ok === true && ro18.ok === true, 'AC18 前置：两文件分别审查')
  let st18 = await statusMod.handle({ workspace_dir: WS, task_id: tid18 })
  const kinds18 = (st18.observation.evidence.latest || []).filter(e => e.kind === 'audit:code_review')
  assert(kinds18.length === 2, 'AC18 同 kind 异 scope 两份都可见（得 ' + JSON.stringify(kinds18) + '）')
  assert(st18.observation.evidence.stale_ids.length === 0, 'AC18 未漂移两份均 fresh')
  writeFileSync(join(WS, 'foo_bar.js'), 'export function do_thing(a) { return a }\nexport function unused_fn() { return 1 }\n// drift ac18\n')
  st18 = await statusMod.handle({ workspace_dir: WS, task_id: tid18 })
  assert(st18.observation.evidence.stale_ids.length === 1, 'AC18 仅相关一份过期（得 ' + JSON.stringify(st18.observation.evidence.stale_ids) + '）')
  assert((st18.observation.evidence.latest || []).filter(e => e.kind === 'audit:code_review').length === 2, 'AC18 过期后两份仍独立可见')
  assert(st18.observation.result_stale === true && st18.observation.stale_reason === 'file_change', 'AC18 整体 stale=file_change')
}

// ── G2-C（ADR-019 D2/§8.4）：code_audit options 透传到原分析器（source/include_files/拒绝路径）──
{
  const tidC = 'task_g2c'
  writeFileSync(join(WS, 'clean_file.js'), 'export function goodName(a) { return a }\n')
  const tC = { task_id: tidC, revision: 1, lifecycle: 'active', route: 'review', node: 'review', workspace_dir: WS, goal_revision: 1, materials: [{ read_ref: 'read_1', canonical_path: 'clean_file.js', locator: { file_path: 'clean_file.js' } }], operations: [], evidence: [] }
  store.putTask(WS, tC, { type: 'task_created', task: tC })
  let rC = await audit.handle({ workspace_dir: WS, task_id: tidC, checks: ['code_review'], options: { nope: 1 } }, {})
  assert(rC.error === 'invalid_input' && /unknown options/.test(rC.message || ''), 'G2-C 未知 option → invalid_input（得 ' + rC.message + '）')
  rC = await audit.handle({ workspace_dir: WS, task_id: tidC, checks: ['code_review'], options: { task_id: 'x' } }, {})
  assert(rC.error === 'invalid_input' && /protected key/.test(rC.message || ''), 'G2-C 受保护键 → invalid_input')
  rC = await audit.handle({ workspace_dir: WS, task_id: tidC, checks: ['code_review'], options: { source: 'export function bad_name() {}\n' } }, {})
  assert(rC.ok === true && rC.observation.counts.active >= 1, 'G2-C code_review source 内联扫描生效（得 active=' + (rC.observation && rC.observation.counts.active) + '）')
  assert(rC.observation.findings.some(f => f.file === 'inline') && !rC.observation.findings.some(f => f.file === 'clean_file.js'), 'G2-C source 命中来自 inline（未扫默认文件；得 ' + JSON.stringify(rC.observation.findings.map(f => f.file)) + '）')
  rC = await audit.handle({ workspace_dir: WS, task_id: tidC, checks: ['security_review'], options: { source: "const password = 'hunter2secret'\n" } }, {})
  assert(rC.ok === true && rC.observation.counts.active >= 1, 'G2-C security_review source 内联扫描生效（得 active=' + (rC.observation && rC.observation.counts.active) + '）')
  rC = await audit.handle({ workspace_dir: WS, task_id: tidC, checks: ['dead_code'], options: { include_files: true } }, {})
  assert(rC.ok === true, 'G2-C dead_code include_files 透传不破坏（ok=true）')
}

console.log(`\n=== test-s4-audit: ${pass} passed, ${fail} failed ===`)
process.exit(fail > 0 ? 1 : 0)