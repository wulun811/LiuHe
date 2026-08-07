// eval-e2e.js — 端到端任务评测集（Y002-S6/C3，v1：5 个确定性任务）
// 用真实开源项目（六合工具集自身代码复制到临时 workspace）跑真实重构任务，
// 指标：first_pass_success / no_unresolved_refs / tool_calls / duration。
// 确定性评测（无 LLM）：任务都是可验证的机械性重构。
// 输出：docs/Y-优化/eval-e2e-results.json + 控制台汇总
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MALONG = join(__dirname, '..')
const RESULTS_PATH = join(__dirname, '..', '..', 'docs', 'Y-优化', 'eval-e2e-results.json')

const imp = (p) => import(pathToFileURL(p).href)
const pc = await imp(join(MALONG, 'parse-client.js'))
await pc.init({ log: () => {} })
await pc.connect()

const { default: codeIndex } = await imp(join(MALONG, 'code-index.js'))
const langParser = {
  extractAllAsync: (s, e, f) => pc.extractAll(s, e, f),
  extractReferencesAsync: (s, e) => pc.extractReferences(s, e),
  hasErrorsAsync: (s, e, f) => pc.hasErrors(s, e, f),
  batchExtractAsync: (f) => pc.batchExtract(f),
}
const services = { langParser }

const WS = join(tmpdir(), 'opencode', 'eval-e2e-ws')
const DATA = join(tmpdir(), 'opencode', 'eval-e2e-data')
const SOCK = join(tmpdir(), 'opencode', `eval-e2e-${process.pid}.sock`)
rmSync(WS, { recursive: true, force: true })
rmSync(DATA, { recursive: true, force: true })
mkdirSync(join(DATA), { recursive: true })

const core = {
  services,
  getService: (n) => services[n],
  registerService: (n, svc) => { services[n] = svc },
  getWorkspaceDir: () => DATA,
  log: () => {},
  emit: () => {},
  get: (key, def) => key === 'codeIndex.udsPath' ? SOCK : def,
}
await codeIndex.init(core)
const svc = services.codeIndex
const ctx = { codeIndexService: svc, getWorkspaceDir: () => DATA }

// 任务：复制真实源文件到临时 workspace（真实项目素材）
function setupFixture() {
  rmSync(WS, { recursive: true, force: true })
  mkdirSync(WS, { recursive: true })
  // 从工具集复制真实的、相互调用的文件对
  for (const f of ['hash-utils.js', 'write-edit.js', 'staleness.js']) {
    const src = join(MALONG, f)
    if (existsSync(src)) cpSync(src, join(WS, f))
  }
  cpSync(join(MALONG, 'writer-registry.js'), join(WS, 'writer-registry.js'))
  return ['hash-utils.js', 'write-edit.js', 'staleness.js', 'writer-registry.js']
}

const tasks = []
let taskId = 0
async function runTask(name, fn) {
  taskId++
  const files = setupFixture()
  await svc.initWorkspace(WS)
  const t0 = Date.now()
  const steps = []
  try {
    const result = await fn({ files, steps })
    const duration = Date.now() - t0
    tasks.push({ task: name, success: true, first_pass: result.firstPass, tool_calls: steps.length, duration_ms: duration, steps })
  } catch (e) {
    tasks.push({ task: name, success: false, first_pass: false, error: e.message, tool_calls: steps.length, duration_ms: Date.now() - t0, steps })
  }
}

// ── 任务 1：rename_symbol 真实重构（hash-utils.js 的 sha256 → hashSha256，全仓改名） ──
await runTask('rename_symbol_cross_file', async ({ files, steps }) => {
  await svc.indexBatch(files.map(f => join(WS, f)), WS)
  const rename = await imp(join(MALONG, 'tools', 'tool-rename-symbol', 'handler.js'))
  steps.push('impact_analysis')
  const impact = await svc.getImpactAnalysis('hash-utils.js', { symbol: 'sha256' })
  const r = await rename.handle({ workspace_dir: WS, symbol: 'sha256', new_name: 'hashSha256', file: 'hash-utils.js', dry_run: false }, ctx)
  steps.push('rename_symbol')
  const body = readFileSync(join(WS, 'hash-utils.js'), 'utf-8')
  const allRefs = files.map(f => readFileSync(join(WS, f), 'utf-8')).join('\n')
  const renamed = allRefs.includes('hashSha256')
  const noOld = !allRefs.split('\n').filter(l => l.includes('sha256') && !l.includes('hashSha256') && !l.trim().startsWith('//') && !l.includes('import')).some(l => /\bsha256\b/.test(l))
  return { firstPass: renamed && impact.callers.length >= 0 && r?.status !== 'error' && !r?.error, steps, renamed, oldResidue: !noOld }
})

// ── 任务 2：fix_imports 未使用 import 检出 + transaction_ready ──
await runTask('fix_imports_unused', async ({ files, steps }) => {
  await svc.indexBatch(files.map(f => join(WS, f)), WS)
  const fix = await imp(join(MALONG, 'tools', 'tool-fix-imports', 'handler.js'))
  writeFileSync(join(WS, 'app.js'), "import { sha256 } from './hash-utils.js'\nimport { bodyHash } from './hash-utils.js'\n\nexport function go(v) {\n  return sha256(v)\n}\n")
  await svc.indexFile(join(WS, 'app.js'), WS)
  const r = await fix.handle({ workspace_dir: WS, file: 'app.js', auto_fix: false }, ctx)
  steps.push('fix_imports')
  const unused = r.issues?.filter(i => i.type === 'unused_import') || []
  const hasBodyHash = unused.some(i => (i.unused || []).includes('bodyHash') || i.symbol === 'bodyHash')
  const txnReady = Array.isArray(r.transaction_ready) && r.transaction_ready.length > 0
  return { firstPass: hasBodyHash && txnReady, steps, found: unused.map(i => i.unused || i.symbol) }
})

// ── 任务 3：edit_transaction 全链（begin→edit→diff_facts→commit→undo） ──
await runTask('edit_transaction_workflow', async ({ files, steps }) => {
  await svc.indexBatch(files.map(f => join(WS, f)), WS)
  const et = await imp(join(MALONG, 'tools', 'tool-edit-transaction', 'handler.js'))
  const df = await imp(join(MALONG, 'tools', 'tool-diff-facts', 'handler.js'))
  const target = 'write-edit.js'
  const before = readFileSync(join(WS, target), 'utf-8')
  const b = await et.handle({ workspace_dir: WS, action: 'begin', name: 'e2e' }, ctx)
  steps.push('begin')
  // 构造真实编辑：找一段必然存在的代码
  const marker = before.split('\n').find(l => l.includes('export function') || l.includes('export async function'))
  const oldStr = marker.split('(')[0]
  const e2 = await et.handle({ workspace_dir: WS, action: 'edit', txn_id: b.txnId, file: target, edits: [{ old_string: oldStr, new_string: oldStr + ' /* e2e */' }] }, ctx)
  steps.push('edit')
  const d = await df.handle({ workspace_dir: WS, since: `txn:${b.txnId}` }, ctx)
  steps.push('diff_facts')
  const cm = await et.handle({ workspace_dir: WS, action: 'commit', txn_id: b.txnId }, ctx)
  steps.push('commit')
  const after = readFileSync(join(WS, target), 'utf-8')
  const changed = after.includes('/* e2e */')
  const un = await et.handle({ workspace_dir: WS, action: 'undo_commit', txn_id: b.txnId }, ctx)
  steps.push('undo_commit')
  const restored = readFileSync(join(WS, target), 'utf-8') === before
  return { firstPass: e2?.status === 'staged' && d?.txn_id === b.txnId && cm?.status === 'committed' && changed && un?.status === 'undone' && restored, steps, changed, restored }
})

// ── 任务 4：trace_symbol 常量值 + 引用 + 硬编码副本 ──
await runTask('trace_symbol_value_refs', async ({ files, steps }) => {
  writeFileSync(join(WS, 'constants.js'), 'export const MAX_EVAL_RETRIES = 3;\n')
  writeFileSync(join(WS, 'consumer.js'), "import { MAX_EVAL_RETRIES } from './constants.js'\n\nexport function loop() {\n  for (let i = 0; i < MAX_EVAL_RETRIES; i++) {}\n  return 3\n}\n")
  await svc.indexFile(join(WS, 'constants.js'), WS)
  await svc.indexFile(join(WS, 'consumer.js'), WS)
  const trace = await imp(join(MALONG, 'tools', 'tool-trace-symbol', 'handler.js'))
  steps.push('trace_symbol')
  const r = await trace.handle({ workspace_dir: WS, symbol: 'MAX_EVAL_RETRIES', file: 'constants.js', include_literals: true }, ctx)
  const refs = Array.isArray(r.direct_references) ? r.direct_references : []
  const crossFileRef = refs.filter(x => (x.file || '').includes('consumer.js')).length >= 2
  return { firstPass: crossFileRef, steps, value: r.value, refs: refs.length, hc: r.hardcoded_copies?.length || 0 }
})

// ── 任务 5：sweep_dead_code 检出未用导出（used 被另一文件引用） ──
await runTask('sweep_dead_code', async ({ files, steps }) => {
  writeFileSync(join(WS, 'orphan.js'), 'export function usedFn() { return 1 }\nexport function deadFn() { return 2 }\n')
  writeFileSync(join(WS, 'caller.js'), "import { usedFn } from './orphan.js'\n\nexport function callIt() {\n  return usedFn()\n}\n")
  await svc.indexFile(join(WS, 'orphan.js'), WS)
  await svc.indexFile(join(WS, 'caller.js'), WS)
  const sweep = await imp(join(MALONG, 'tools', 'tool-dead-code-sweeper', 'handler.js'))
  steps.push('sweep_dead_code')
  const r = await sweep.handle({ workspace_dir: WS, scope: 'orphan.js', include_files: true }, ctx)
  const all = JSON.stringify(r.dead_code || [])
  return { firstPass: /deadFn/.test(all) && !/usedFn/.test(all), steps, hits: (r.dead_code || []).length, found: (r.dead_code || []).map(d => d.name) }
})

// ── 汇总 ──
const ok = tasks.filter(t => t.success).length
const firstPass = tasks.filter(t => t.first_pass).length
const summary = {
  date: '2026-08-03',
  total_tasks: tasks.length,
  success: ok,
  first_pass_success: firstPass,
  tasks,
}
mkdirSync(dirname(RESULTS_PATH), { recursive: true })
writeFileSync(RESULTS_PATH, JSON.stringify(summary, null, 2) + '\n')
console.log(`== eval-e2e: ${firstPass}/${tasks.length} first-pass success, ${ok}/${tasks.length} completed ==`)
for (const t of tasks) {
  console.log(`  ${t.success ? '✅' : '❌'} ${t.task}: ${t.first_pass ? 'first_pass' : t.error || 'FAIL'} (${t.tool_calls} calls, ${t.duration_ms}ms)`)
}
process.exit(0)
