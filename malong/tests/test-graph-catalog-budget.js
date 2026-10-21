// test-graph-catalog-budget.js — graph 目录预算锁（WP08R-2；P2-切片2 更新为 12 工具）。
// 背景：tools/list 目录每轮随上下文重发（WP08R 实测 21,242B ≈ 5.8K token/轮；P1 实测目录税≈总 prompt 26%）。
// 本测试锁定「展示层预算」：12 工具 description + inputSchema(JSON) 合计 ≤13,200B，单工具 ≤1,700B。
// 2026-10-12（G1/ADR-018）有意变更：实测 12,783B 已超原 11,200B 锁——其中 code_query 自 P2-切片2 的 830B 漂移到 ~2.5KB（历次扩展未同步预算锁，且本测试当时不在 npm test 链）。
//   本次：显式上调预算到 13,200B（含 ADR-018 发现分支 +~400B）并把本测试接入 npm test 链，防继续静默漂移；单工具上限 1,700B 暂留（code_query 2,554B 超限已记录，留存后续压缩债务）。
// 同时锁「压缩不得改协议面」：顶层参数名集合与 required 冻结；关键行为词必须仍在（防压缩丢语义）。
// 失败路径自检：catalogBytes/paramDiff 对合成的超预算/丢参数样本必须给出拒绝判定。
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TOOLS_DIR = join(__dirname, '..', 'tools')

let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}

const GRAPH_TOOLS = ['code_task', 'code_read', 'code_status', 'code_query', 'code_audit', 'code_batch', 'code_check', 'code_control', 'code_maintain', 'code_patch', 'code_worktree', 'edit_transaction', 'invoke_capability']
// 2026-10-12（G2-A/ADR-019）有意变更：新增 search/tests/validate 真委派分支 + 假替代修正。
//   code_query 2,554→3,091B（enum/allOf/描述/新参数 new_content）；总额 13,632→14,169B。
//   本次上调总额到 14,500B（含 G2-B..E options/写安全参数预留 ~300B）并把 code_query 例外上调到 3,300B。
// 2026-10-12（G2-B/ADR-019 D2）二次上调：+options 透传参数（code_query 3,091→3,279B；总额 14,169→14,357B）。
// 2026-10-12（G2-D/ADR-019 D3）三次上调：写安全参数显式化（code_patch 1,570B / code_batch 1,757B；总额 15,355B），并为 G2-C/E 预留 ~300B。
// 2026-10-12（G2-C/ADR-019 D2）四次上调：code_audit +options 透传（1,283B；总额 15,604B）。
// 2026-10-17（0.5.10 审核修复 R01/R02）五次上调：invoke_capability manifest 显性化出口合同
//   （终态守卫+操作账本；request_id 幂等/冲突）——总额 15,857→16,053B（+196B；单工具 1,045B，仍 ≤1,700B）。
//   上调到 16,400B（预留 ~350B 供 Graph 出口后续扩展；再超即显式审，不静默漂移）。
// 2026-10-18（H03 快速出口文案）六次上调：code_query 描述补「无 task 快出口 + 写路径衔接」（3,296→3,472B）；
//   单工具例外 3,300→3,500B。
// 2026-10-18（R5 Git 副作用预告）七次上调：code_worktree 描述写清 apply 会提交并更新当前分支（+225B；总额 16,454B）；
//   总额上调到 16,800B（近上限，再超即再显式审，不静默漂移）。
const BUDGET_TOTAL = 16800
// 单工具上限例外（显式债务，不得静默）：code_query 多 mode 扩展 + H03 快速出口说明；code_batch 多 item 形状 + 安全参数。
const BUDGET_PER_TOOL_EXCEPTIONS = { code_query: 3500, code_batch: 1800 }
const BUDGET_PER_TOOL = 1700

// 冻结的协议面（2026-10-10 压缩后现值；后续改动必须显式更新本清单 + 同步测试）
// F5（2026-10-18 Windows 复核）有意变更：code_query(map) 公开 page/dir（地图分页与目录下钻）——参数面新增两个，
// 已压缩描述保持单工具预算 ≤3500B；冻结清单同步。
const FROZEN = {
  code_task: { params: ['goal', 'request_id', 'route', 'search_terms', 'target', 'workspace_dir'], required: ['workspace_dir', 'goal'] },
  code_read: { params: ['budget_hint', 'expected_state_revision', 'locator', 'mode', 'read_ref', 'task_id', 'workspace_dir'], required: ['workspace_dir', 'task_id'] },
  code_status: { params: ['task_id', 'workspace_dir'], required: ['workspace_dir'] },
  code_query: { params: ['budget_hint', 'category', 'cursor', 'depth', 'dir', 'file', 'kind', 'limit', 'line', 'max_tokens', 'mode', 'name', 'new_content', 'options', 'page', 'page_size', 'query', 'rich', 'symbol', 'workspace_dir'], required: ['workspace_dir', 'mode'] },
  code_audit: { params: ['action', 'checks', 'expected_state_revision', 'files', 'fingerprint', 'max_findings', 'options', 'reason', 'scope', 'task_id', 'workspace_dir'], required: ['workspace_dir', 'task_id'] },
  code_batch: { params: ['allow_unsafe_no_base', 'dry_run', 'expected_state_revision', 'policy', 'read_ref', 'request_id', 'safety', 'task_id', 'workspace_dir', 'writes'], required: ['workspace_dir', 'task_id', 'writes'] },
  code_check: { params: ['async', 'checks', 'expected_state_revision', 'request_id', 'run', 'task_id', 'timeout', 'verifier', 'workdir', 'workspace_dir'], required: ['workspace_dir', 'task_id'] },
  code_control: { params: ['action', 'expected_state_revision', 'goal', 'job_id', 'reason', 'ref', 'route', 'task_id', 'wait_ms', 'workspace_dir'], required: ['workspace_dir', 'task_id', 'action'] },
  code_maintain: { params: ['action', 'dry_run', 'expected_state_revision', 'files', 'max_candidates', 'max_per_file', 'proposals', 'request_id', 'task_id', 'workspace_dir'], required: ['workspace_dir', 'task_id'] },
  code_patch: { params: ['allow_unsafe_no_base', 'boundary', 'content', 'create', 'dry_run', 'edit_mode', 'expected_state_revision', 'locator', 'patch', 'preserve_decorators', 'read_ref', 'request_id', 'safety', 'task_id', 'workspace_dir'], required: ['workspace_dir', 'task_id'] },
  code_worktree: { params: ['action', 'changes', 'dry_run', 'expected_state_revision', 'message', 'request_id', 'task_id', 'timeout', 'verify_cmd', 'workspace_dir'], required: ['workspace_dir', 'task_id'] },
  edit_transaction: { params: ['action', 'atomic', 'content', 'create', 'dry_run', 'edits', 'expect_sha', 'file', 'file_edits', 'files', 'lines', 'name', 'seq', 'total', 'txn_id', 'workspace_dir'], required: ['workspace_dir', 'action'] },
  invoke_capability: { params: ['args', 'name', 'request_id', 'task_id', 'workspace_dir'], required: ['workspace_dir', 'name'] },
}

// 关键行为词（必须在压缩后仍可见，防语义流失）
const KEY_PHRASES = {
  code_task: ['code_batch', 'code_check'],
  code_read: ['budget_hint'],
  code_status: ['task_id'],
  code_query: ['outline', 'references', 'capabilities', 'validate'],
  code_audit: ['checks'],
  code_batch: ['locator.file_path', 'dry_run'],
  code_check: ['test/typecheck/lint'],
  code_control: ['resume'],
  code_maintain: ['plan'],
  code_patch: ['locator.file_path', 'read_ref'],
  code_worktree: ['apply'],
  edit_transaction: ['rollback', 'edit_batch'],
  invoke_capability: ['delegates once'],
}

export function catalogBytes(m) {
  return Buffer.byteLength(m.description || '', 'utf8') + Buffer.byteLength(JSON.stringify(m.inputSchema || {}), 'utf8')
}

export function paramDiff(m, frozen) {
  const props = Object.keys(m.inputSchema?.properties || {}).sort()
  const req = (m.inputSchema?.required || []).slice().sort()
  const missing = frozen.params.filter((p) => !props.includes(p))
  const extra = props.filter((p) => !frozen.params.includes(p))
  const reqMissing = frozen.required.filter((p) => !req.includes(p))
  return { missing, extra, reqMissing }
}

const manifests = {}
let total = 0
for (const name of GRAPH_TOOLS) {
  const m = JSON.parse(readFileSync(join(TOOLS_DIR, `tool-${name.replace(/_/g, '-')}`, 'manifest.json'), 'utf-8'))
  manifests[name] = m
  const bytes = catalogBytes(m)
  total += bytes
  const cap = BUDGET_PER_TOOL_EXCEPTIONS[name] || BUDGET_PER_TOOL
  assert(bytes <= cap, `${name}: 单工具预算 ≤${cap}B（实际 ${bytes}）`)
  const diff = paramDiff(m, FROZEN[name])
  assert(diff.missing.length === 0 && diff.extra.length === 0, `${name}: 顶层参数与冻结清单一致（缺 ${diff.missing.join(',') || '无'} / 多 ${diff.extra.join(',') || '无'}）`)
  assert(diff.reqMissing.length === 0, `${name}: required 未缩水（缺 ${diff.reqMissing.join(',') || '无'}）`)
  const desc = m.description || ''
  assert(desc.trim().length > 0, `${name}: description 非空`)
  for (const phrase of KEY_PHRASES[name]) assert(desc.includes(phrase), `${name}: description 含关键行为词「${phrase}」`)
  const props = m.inputSchema?.properties || {}
  for (const [p, pv] of Object.entries(props)) assert((pv.description || '').trim().length > 0, `${name}.${p}: 顶层参数描述非空`)
}
assert(total <= BUDGET_TOTAL, `13 工具目录总预算 ≤${BUDGET_TOTAL}B（实际 ${total}）`)

// 失败路径自检：校验函数必须能拒绝坏样本（防测试本身假绿）
const padded = structuredClone(manifests.code_status)
padded.description = 'x'.repeat(2000)
assert(catalogBytes(padded) > BUDGET_PER_TOOL, '失败路径：超预算样本被 catalogBytes 判超（自检）')
const dropped = structuredClone(manifests.code_batch)
delete dropped.inputSchema.properties.writes
const dropDiff = paramDiff(dropped, FROZEN.code_batch)
assert(dropDiff.missing.includes('writes'), '失败路径：删参数样本被 paramDiff 命中（自检）')
const narrowed = structuredClone(manifests.code_control)
narrowed.inputSchema.required = ['workspace_dir']
assert(paramDiff(narrowed, FROZEN.code_control).reqMissing.includes('action'), '失败路径：缩水 required 被 paramDiff 命中（自检）')
const phraseGone = structuredClone(manifests.edit_transaction)
phraseGone.description = 'no keywords here'
assert(!KEY_PHRASES.edit_transaction.every((p) => phraseGone.description.includes(p)), '失败路径：丢失行为词被 key-phrase 检查命中（自检）')

console.log(`\n=== test-graph-catalog-budget: ${pass} passed, ${fail} failed（13 工具合计 ${total}B / 预算 ${BUDGET_TOTAL}B）===`)
process.exit(fail > 0 ? 1 : 0)