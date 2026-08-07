// test-symbol-search.js — 符号搜索 handler（Y001-S3 补测）
// 覆盖：limit 钳制（负/超大/NaN→30）/ 单字符警告 / 空结果建议 / 结果 next_step / 缺参与索引错误
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}
const { handle } = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-symbol-search', 'handler.js')).href)

const ws = join(os.tmpdir(), 'opencode', 'ss-test-ws')
rmSync(ws, { recursive: true, force: true })
mkdirSync(ws, { recursive: true })
writeFileSync(join(ws, 'code-index.db'), '')

function makeCtx(searchImpl) {
  return {
    codeIndexService: { initWorkspace() {}, searchSymbols: searchImpl },
    getWorkspaceDir: () => ws,
  }
}

// ── ① limit 钳制：负值 → 1（P2-B2 回归：SQL LIMIT -1 全表泄漏） ──
{
  let seenLimit = null
  const ctx = makeCtx(async (q, { limit }) => { seenLimit = limit; return [{ name: 'foo', type: 'function' }] })
  await handle({ workspace_dir: ws, query: 'foo', limit: -5 }, ctx)
  assert(seenLimit === 1, `① limit=-5 钳制到 1（得 ${seenLimit}）`)
}

// ── ② limit 钳制：超大 → 500；NaN → 30 ──
{
  let seenBig = null
  await handle({ workspace_dir: ws, query: 'foo', limit: 999999 }, makeCtx(async (q, { limit }) => { seenBig = limit; return [] }))
  assert(seenBig === 500, `② limit=999999 钳制到 500（得 ${seenBig}）`)
  let seenNaN = null
  await handle({ workspace_dir: ws, query: 'foo', limit: 'abc' }, makeCtx(async (q, { limit }) => { seenNaN = limit; return [] }))
  assert(seenNaN === 30, `② limit='abc'(NaN) 回落 30（得 ${seenNaN}）`)
}

// ── ③ 单字符查询警告 ──
{
  const r = await handle({ workspace_dir: ws, query: 'x' }, makeCtx(async () => []))
  assert(r.warning === 'single_char_query', `③ 单字符警告（得 ${r.warning}）`)
}

// ── ④ 空结果 suggestion + 有结果 next_step ──
{
  const empty = await handle({ workspace_dir: ws, query: 'nonexist' }, makeCtx(async () => []))
  assert(empty.count === 0 && empty.suggestion && empty.suggestion.includes('reindex'), '④ 空结果带 reindex 建议')
  const hit = await handle({ workspace_dir: ws, query: 'foo' }, makeCtx(async () => [{ name: 'fetchUser', type: 'function' }]))
  assert(hit.count === 1 && hit.next_step && hit.next_step.includes('impact_analysis'), '④ 有结果 next_step 指向 impact_analysis')
}

// ── ⑤ 参数与错误路径 ──
{
  const noWs = await handle({ query: 'foo' }, makeCtx(async () => []))
  assert(noWs.error === 'missing_parameter', '⑤ 缺 workspace_dir')
  const noQuery = await handle({ workspace_dir: ws }, makeCtx(async () => []))
  assert(noQuery.error === 'missing_parameter' && noQuery.message.includes('query'), '⑤ 缺 query')
  const noIndex = await handle({ workspace_dir: ws, query: 'foo' }, { codeIndexService: { initWorkspace() {}, searchSymbols: async () => [] }, getWorkspaceDir: () => join(os.tmpdir(), 'opencode', 'ss-noindex') })
  assert(noIndex.error === 'workspace_not_indexed', '⑤ 无索引 → workspace_not_indexed')
  const noSvc = await handle({ workspace_dir: ws, query: 'foo' }, { codeIndexService: null, getWorkspaceDir: () => ws })
  assert(noSvc.error === 'service_unavailable', '⑤ 无 service → service_unavailable')
}

rmSync(ws, { recursive: true, force: true })

console.log(`== test-symbol-search: ${pass} passed, ${fail} failed ==`)
if (fail > 0) process.exit(1)
