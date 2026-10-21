// test-s4-maintain.js — S4.3 maintain（code_maintain）提案 + 统一写路径失败/边界路径
// 覆盖：proposeImportFixes 归集/skipped、selectProposals 指纹筛选、plan 默认不落盘、
//       apply 需 dry_run=false、跨文件统一写 + operation(succeeded) + 证据、request_id 去重/异载荷拒绝、
//       patch old_string 未命中失败、无 scope、action 非法、鉴权/版本/revision 错误。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP = join(os.tmpdir(), 'opencode', 's4-maintain-test')
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
const WS = join(TMP, 'ws')
mkdirSync(join(WS, 'src'), { recursive: true })
process.env.MALONG_STATE_DIR = join(TMP, 'state')
process.env.MALONG_ENTRY_STATE = '1'

let pass = 0, fail = 0
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  FAIL:', msg) } }

const shared = await import(pathToFileURL(join(__dirname, '..', 'tools', 'entry-shared.js')).href)
const maintain = await import(pathToFileURL(join(__dirname, '..', 'workflow', 'maintain.js')).href)
const handler = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-code-maintain', 'handler.js')).href)

// ── WP08R-5 P6：写错误 read_symbol 归一 + next_action 可执行化（mapWriteError 共用的共享件）──
assert(shared.normalizeReadToolText('File changed externally; re-read (read_symbol) and retry') === 'File changed externally; re-read (code_read) and retry', 'read_symbol 文本归一 code_read')
const naX = shared.executableNextAction({ tool: 'read_symbol', params: { locator: { file_path: 'a.js' } } }, { workspace_dir: 'WSX', task_id: 'TX' })
assert(naX.tool === 'code_read' && naX.args.workspace_dir === 'WSX' && naX.args.task_id === 'TX' && naX.args.locator?.file_path === 'a.js', `next_action 可执行化（得 ${JSON.stringify(naX)}）`)

const H = (s) => `sha256:${shared.sha256Hex(s)}`
const read = (f) => readFileSync(join(WS, f), 'utf-8')

// ── stub 分析器：按文件给 transaction_ready（模拟 fix_imports 只读输出）──
let ANALYZE_MAP = {}
let THROW_FILES = new Set()
async function analyzeStub({ file }) {
  if (THROW_FILES.has(file)) throw new Error('boom')
  const v = ANALYZE_MAP[file]
  if (!v) return { file, issues: [] }
  return v
}
const ctx = { codeIndexService: null, langParserService: null, maintainAnalyze: analyzeStub }

function mkTask(id, materials, operations = [], extra = {}) {
  const t = { task_id: id, revision: 1, route: 'maintain', lifecycle: 'active', node: 'read', materials, operations, workspace_dir: WS, ...extra }
  shared.putTask(WS, t, { type: 'task_created', task: t })
  return t
}
const material = (ref, file, content) => ({ read_ref: ref, locator: { file_path: file }, canonical_path: file, file_version: { hash: H(content) }, symbol_version: null })

// ── 0. 测试文件 ──
const PY = 'src/f.py', MULTI = 'src/multi.js', CLEAN = 'src/clean.js', RS = 'src/rust.rs', BOOM = 'src/boom.js', STALE = 'src/stale.py', NOSCOPE = 'src/none.py'
writeFileSync(join(WS, PY), 'x = 1\ny = 2\n')
writeFileSync(join(WS, MULTI), 'a\nb\nc\n')
writeFileSync(join(WS, CLEAN), 'z\n')
writeFileSync(join(WS, RS), 'fn main() {}\n')
writeFileSync(join(WS, BOOM), 'q\n')
writeFileSync(join(WS, STALE), 'hello\n')
writeFileSync(join(WS, NOSCOPE), 'w\n')

// ── 1. proposeImportFixes：归集 transaction_ready / skipped 分类 ──
ANALYZE_MAP = {
  [PY]: { file: PY, issues: [{ type: 'undefined_symbol' }], transaction_ready: [{ file: PY, old_string: 'x = 1\n', new_string: 'import os\nx = 1\n' }] },
  [CLEAN]: { file: CLEAN, issues: [] },
  [RS]: { file: RS, supported: false, issues: [] },
}
THROW_FILES = new Set([BOOM])
let an = await maintain.proposeImportFixes({ workspaceDir: WS, files: [PY, CLEAN, RS, BOOM], analyze: analyzeStub })
assert(an.proposals.length === 1 && an.proposals[0].file === PY, '归集 1 条 patch 提案')
assert(typeof an.proposals[0].fingerprint === 'string' && an.proposals[0].fingerprint.startsWith('fp_'), '提案带 fingerprint')
assert(an.skipped.find(s => s.file === CLEAN && s.reason === 'clean'), 'clean 文件 → skipped/clean')
assert(an.skipped.find(s => s.file === RS && s.reason === 'language_not_supported'), 'unsupported → skipped')
assert(an.skipped.find(s => s.file === BOOM && s.reason === 'analyzer_failed'), '分析器异常 → skipped/analyzer_failed')
assert(an.issuesByFile[PY] && an.issuesByFile[PY][0] === 'undefined_symbol', 'issuesByFile 记录问题类型')

// ── 2. selectProposals：指纹筛选；空 → 全选 ──
ANALYZE_MAP = {
  [MULTI]: {
    file: MULTI, issues: [{ type: 'undefined_symbol' }],
    transaction_ready: [
      { file: MULTI, old_string: 'a\n', new_string: 'A\n' },
      { file: MULTI, old_string: 'b\n', new_string: 'B\n' },
    ],
  },
}
an = await maintain.proposeImportFixes({ workspaceDir: WS, files: [MULTI], analyze: analyzeStub })
assert(an.proposals.length === 2, '同文件两条提案')
const fpA = an.proposals[0].fingerprint, fpB = an.proposals[1].fingerprint
assert(maintain.selectProposals(an.proposals, [fpA]).length === 1, '按指纹筛选 1 条')
assert(maintain.selectProposals(an.proposals, []).length === 2, '空筛选 → 全选')
assert(maintain.selectProposals(an.proposals, ['fp_nope']).length === 0, '未知指纹 → 0 条')

// ── 3. plan 默认：预览不落盘，无操作 ──
ANALYZE_MAP = { [PY]: { file: PY, issues: [{ type: 'undefined_symbol' }], transaction_ready: [{ file: PY, old_string: 'x = 1\n', new_string: 'import os\nx = 1\n' }] } }
mkTask('task_plan', [material('rpy', PY, 'x = 1\ny = 2\n')])
let r = await handler.handle({ workspace_dir: WS, task_id: 'task_plan' }, ctx)
assert(r.ok === true && r.observation?.effect === 'preview' && r.observation?.dry_run === true, '默认 action=plan → 预览')
assert(r.observation?.proposals?.length === 1 && r.observation?.rule_version === 'fiximports-patch-v1', 'plan 返回提案 + 规则版本')
assert(read(PY) === 'x = 1\ny = 2\n', 'plan 不落盘')
assert(shared.getTask(WS, 'task_plan').operations.length === 0, 'plan 不记操作')

// ── 4. apply 未显式 dry_run=false → 仍预览（保守双确认）──
r = await handler.handle({ workspace_dir: WS, task_id: 'task_plan', action: 'apply' }, ctx)
assert(r.ok === true && r.observation?.dry_run === true, 'action=apply 但 dry_run 缺省 → 仍预览')

// ── 5. apply dry_run=false：跨文件统一写 + operation + 证据 ──
ANALYZE_MAP = {
  [PY]: { file: PY, issues: [{ type: 'undefined_symbol' }], transaction_ready: [{ file: PY, old_string: 'x = 1\n', new_string: 'import os\nx = 1\n' }] },
  [MULTI]: {
    file: MULTI, issues: [{ type: 'undefined_symbol' }],
    transaction_ready: [
      { file: MULTI, old_string: 'a\n', new_string: 'A\n' },
      { file: MULTI, old_string: 'b\n', new_string: 'B\n' },
    ],
  },
}
mkTask('task_apply', [material('rpy', PY, 'x = 1\ny = 2\n'), material('rmu', MULTI, 'a\nb\nc\n')])
r = await handler.handle({ workspace_dir: WS, task_id: 'task_apply', action: 'apply', dry_run: false, request_id: 'rq_apply' }, ctx)
assert(r.ok === true && r.observation?.committed === true, 'apply 提交')
assert(read(PY) === 'import os\nx = 1\ny = 2\n', 'PY 导入补丁已写')
assert(read(MULTI) === 'A\nB\nc\n', 'MULTI 两条补丁均已写')
assert(r.observation.operation?.state === 'succeeded' && r.observation.operation.kind === 'maintain', 'operation 记 maintain succeeded')
assert(r.observation.evidence?.kind === 'maintain:import_fix' && r.observation.evidence.rule_version === 'fiximports-patch-v1', '证据 maintain:import_fix + 规则版本')
assert(r.observation.evidence.depends_on?.some(d => d.file === PY), '证据依赖写后文件版本')
assert(r.observation.evidence.source === 'fix_imports' && r.observation.evidence.provenance?.tool === 'fix_imports', 'T21 证据溯源 = fix_imports（委派）')
const tApply = shared.getTask(WS, 'task_apply')
assert(tApply.evidence.some(e => e.kind === 'maintain:import_fix'), '任务证据已持久化（可重放）')
assert(tApply.result_kind === 'partial', 'result_kind=partial（未校验，不谎称 validated）')

// ── 6. request_id 去重：同 id + 同载荷 → 幂等 ──
r = await handler.handle({ workspace_dir: WS, task_id: 'task_apply', action: 'apply', dry_run: false, request_id: 'rq_apply' }, ctx)
assert(r.ok === true && r.observation?.deduplicated === true, '同 id 同载荷 → dedup')

// ── 7. 同 request_id 异载荷（子集不同）→ 拒绝 ──
r = await handler.handle({ workspace_dir: WS, task_id: 'task_apply', action: 'apply', dry_run: false, request_id: 'rq_apply', proposals: [fpB] }, ctx)
assert(r.error === 'request_conflict', `同 id 异载荷 → request_conflict（得 ${r.error}）`)

// ── 8. patch old_string 未命中 → 写失败，操作记 failed ──
ANALYZE_MAP = { [STALE]: { file: STALE, issues: [{ type: 'undefined_symbol' }], transaction_ready: [{ file: STALE, old_string: 'NOT_THERE\n', new_string: 'zzz\n' }] } }
mkTask('task_stale', [material('rst', STALE, 'hello\n')])
r = await handler.handle({ workspace_dir: WS, task_id: 'task_stale', action: 'apply', dry_run: false, request_id: 'rq_stale' }, ctx)
assert(r.ok === false && /PATCH_OLD_STRING_NOT_FOUND|old_string_not_found/i.test(r.error + ' ' + (r.message || '')), `未命中 → 写失败（得 ${r.error}）`)
assert(read(STALE) === 'hello\n', '失败不改文件')
assert(shared.getTask(WS, 'task_stale').operations.every(o => o.state !== 'succeeded'), '失败不产生 succeeded 操作')

// ── 9. 无 scope（task 无材料、无 files）→ invalid_input ──
mkTask('task_noscope', [])
r = await handler.handle({ workspace_dir: WS, task_id: 'task_noscope' }, ctx)
assert(r.error === 'invalid_input', '无 scope → invalid_input')

// ── 10. apply 且 0 条可用 → invalid_input ──
ANALYZE_MAP = { [CLEAN]: { file: CLEAN, issues: [] } }
mkTask('task_zero', [material('rc', CLEAN, 'z\n')])
r = await handler.handle({ workspace_dir: WS, task_id: 'task_zero', action: 'apply', dry_run: false }, ctx)
assert(r.error === 'invalid_input', 'apply 无可应用提案 → invalid_input')

// ── 11. action 非法 ──
r = await handler.handle({ workspace_dir: WS, task_id: 'task_plan', action: 'bogus' }, ctx)
assert(r.error === 'invalid_input', '非法 action → invalid_input')

// ── 12. 鉴权/参数/版本/revision ──
assert((await handler.handle({ task_id: 'task_plan' }, ctx)).error === 'missing_parameter', '缺 workspace_dir → missing_parameter')
assert((await handler.handle({ workspace_dir: join(TMP, 'nope'), task_id: 'x' }, ctx)).error === 'invalid_input', 'workspace 不存在 → invalid_input')
assert((await handler.handle({ workspace_dir: WS }, ctx)).error === 'missing_parameter', '缺 task_id → missing_parameter')
assert((await handler.handle({ workspace_dir: WS, task_id: 'ghost' }, ctx)).error === 'task_not_found', '未知 task → task_not_found')
mkdirSync(join(TMP, 'other'), { recursive: true })
assert((await handler.handle({ workspace_dir: join(TMP, 'other'), task_id: 'task_plan' }, ctx)).error === 'task_not_found', '跨 workspace → task_not_found（命名空间隔离）')
mkTask('task_ver', [material('rpy', PY, 'x = 1\ny = 2\n')], [], { schema_version: 2 })
assert((await handler.handle({ workspace_dir: WS, task_id: 'task_ver' }, ctx)).error === 'task_version_unsupported', '更新版本 → task_version_unsupported')
assert((await handler.handle({ workspace_dir: WS, task_id: 'task_plan', expected_state_revision: 99 }, ctx)).error === 'revision_conflict', 'revision 冲突 → revision_conflict')
// ── 13. 第二轮审查：reconcileMaintain 收口 CAS 失败 → state_commit_pending（不谎报 committed）──
{
  const RB = 'src/rb.js'
  writeFileSync(join(WS, RB), 'k\n')
  mkTask('task_rb', [material('rrb', RB, 'k\n')])
  const op = { operation_id: 'op_rb', request_id: 'rq_rb', kind: 'maintain', state: 'prepared', files: [RB], pre_hashes: { [RB]: H('z\n') }, intended_hashes: { [RB]: H('k\n') }, created: 'seed' }
  const conflicted = handler.reconcileMaintain(WS, 'task_rb', 99999, op, 'maintain')
  assert(conflicted.error === 'state_commit_pending', `reconcileMaintain CAS 冲突 → state_commit_pending（得 ${JSON.stringify(conflicted.error)}）`)
}

// ── G2-E（ADR-019 D2）：max_candidates 透传到 fix_imports 分析器（stub 捕获）──
{
  let seenMaxCand = null
  const stub2 = async ({ file, max_candidates }) => { seenMaxCand = max_candidates; return ANALYZE_MAP[file] || { file, issues: [] } }
  const rMC = await handler.handle({ workspace_dir: WS, task_id: 'task_plan', action: 'plan', files: [PY], max_candidates: 3 }, { ...ctx, maintainAnalyze: stub2 })
  assert(rMC.ok === true && seenMaxCand === 3, `G2-E max_candidates 透传（得 ${JSON.stringify({ ok: rMC.ok, seenMaxCand })}）`)
}

console.log(`\n=== test-s4-maintain: ${pass} passed, ${fail} failed ===`)
process.exit(fail > 0 ? 1 : 0)