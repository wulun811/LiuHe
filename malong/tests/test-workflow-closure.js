// test-workflow-closure.js — LLM 工作流闭环（Y002-S2）
// 覆盖：写路径 next_step 闭环（diff_facts → test_bridge → debug_runner）/
//       diff_facts TXN_NOT_FOUND 可执行 suggestion（43% 错误率根因）/
//       inspect staleness 警告（stale 文件 → warning；未索引自动重抽）
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}
const imp = (p) => import(pathToFileURL(p).href)
const et = await imp(join(__dirname, '..', 'tools', 'tool-edit-transaction', 'handler.js'))
const diff = await imp(join(__dirname, '..', 'tools', 'tool-diff-facts', 'handler.js'))
const wr = await imp(join(__dirname, '..', 'write-runtime.js'))
const inspect = await imp(join(__dirname, '..', 'tools', 'tool-inspect', 'handler.js'))
const { sha256 } = await imp(join(__dirname, '..', 'hash-utils.js'))

const ws = join(os.tmpdir(), 'opencode', 'wfc-test-ws')
rmSync(ws, { recursive: true, force: true })
mkdirSync(ws, { recursive: true })
const ctx = {}

// ── ① edit_transaction commit → next_step 闭环链（含 txn_id 参数） ──
{
  const f = 'a.py'
  writeFileSync(join(ws, f), 'def old():\n    return 1\n')
  const b = await et.handle({ workspace_dir: ws, action: 'begin', name: 'wf1' }, ctx)
  await et.handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: f, edits: [{ old_string: 'return 1', new_string: 'return 2' }] }, ctx)
  const cm = await et.handle({ workspace_dir: ws, action: 'commit', txn_id: b.txnId }, ctx)
  assert(cm.status === 'committed', `① commit 成功（得 ${cm.status}）`)
  assert(typeof cm.next_step === 'string' && cm.next_step.includes('diff_facts') && cm.next_step.includes('test_bridge') && cm.next_step.includes('debug_runner'), `① commit next_step 闭环链（得 ${cm.next_step}）`)
  assert(cm.next_step.includes(`txn:${b.txnId}`), `① 闭环带 txn_id 参数（得 ${cm.next_step}）`)
}

// ── ② diff_facts TXN_NOT_FOUND → available_txns + workflow（43% 错误率根因修复） ──
{
  const r = await diff.handle({ workspace_dir: ws, since: 'txn:definitely-not-exist' }, ctx)
  assert(r.error_code === 'TXN_NOT_FOUND', `② 错误码 TXN_NOT_FOUND（得 ${r.error_code}）`)
  assert(Array.isArray(r.available_txns) && r.available_txns.length >= 1, `② 列出可用事务（得 ${JSON.stringify(r.available_txns)}）`)
  assert(typeof r.suggestion === 'string' && r.suggestion.includes('use an existing transaction'), `② suggestion 指向现有事务（得 ${r.suggestion}）`)
  assert(typeof r.workflow === 'string' && r.workflow.includes('diff_facts') && r.workflow.includes('test_bridge'), `② workflow 闭环字段（得 ${r.workflow}）`)
  const ok = await diff.handle({ workspace_dir: ws, since: `txn:${r.available_txns[0]}` }, ctx)
  assert(!ok.error_code && ok.txn_id === r.available_txns[0], `② suggestion 的事务真实可用（得 ${ok.txn_id}）`)
}

// ── ③ writeSymbol 成功 → next_step 闭环（write-journal 路径，diff_facts 条件性） ──
{
  const f = 'b.py'
  writeFileSync(join(ws, f), 'def foo():\n    return 1\n')
  const baseHash = `sha256:${sha256(readFileSync(join(ws, f), 'utf-8'))}`
  const r = await wr.writeSymbol({
    workspace_dir: ws,
    locator: { file_path: f },
    edit_mode: 'patch',
    patch: { old_string: 'return 1', new_string: 'return 3' },
    base_version: { file: { hash: baseHash } },
  }, {})
  assert(r.success === true, `③ writeSymbol 成功（得 ${r.success} ${r.error?.code || ''}）`)
  assert(typeof r.next_step === 'string' && r.next_step.includes('test_bridge') && r.next_step.includes('debug_runner'), `③ writeSymbol next_step 闭环（得 ${r.next_step}）`)
  assert(r.next_step.includes('edit_transaction'), `③ 提及 edit_transaction 事务才走 diff_facts（得 ${r.next_step}）`)
}

// ── ④ writeSymbols 成功 → next_step 闭环 ──
{
  const f = 'c.py'
  writeFileSync(join(ws, f), 'def bar():\n    return 1\n')
  const baseHash = `sha256:${sha256(readFileSync(join(ws, f), 'utf-8'))}`
  const r = await wr.writeSymbols({
    workspace_dir: ws,
    writes: [{ file_path: f, locator: { file_path: f }, edit_mode: 'patch', patch: { old_string: 'return 1', new_string: 'return 4' }, base_version: { file: { hash: baseHash } } }],
  }, {})
  assert(r.success === true, `④ writeSymbols 成功（得 ${r.success} ${r.error?.code || ''}）`)
  assert(typeof r.next_step === 'string' && r.next_step.includes('test_bridge') && r.next_step.includes('debug_runner'), `④ writeSymbols next_step 闭环（得 ${r.next_step}）`)
}

// ── ⑤ inspect staleness：文件 mtime 不一致 → auto_indexed（R19-② 服务层语义：getSymbols 内部 ensureFreshFile）──
{
  const f = 'd.py'
  writeFileSync(join(ws, f), 'def baz():\n    return 1\n')
  writeFileSync(join(ws, 'code-index.db'), '') // inspect 前置检查需要 db 文件存在
  let indexed = false
  const mockIdx = {
    initWorkspace: async () => {},
    getFileMtime: () => 0, // 未索引 → 触发 auto_index
    indexFile: async () => { indexed = true; return { symbols: 1 } },
    // R19-②：服务层统一入口——inspect 不再自己调 checkFileStaleness，保鲜由查询出口（getSymbols）承担
    getSymbols: async () => {
      indexed = true // 模拟服务层 ensureFreshFile 重抽
      const arr = [{ name: 'baz', type: 'function', start_line: 1, end_line: 2 }]
      arr.freshness = { auto_indexed: true }
      return arr
    },
    getReferences: async () => [],
    getCallers: async () => [],
    getCallees: async () => [],
    searchSymbols: async () => [],
    clearCachesForFile: () => {},
  }
  const ictx = { codeIndexService: mockIdx, getWorkspaceDir: (w) => w }
  const r = await inspect.handle({ workspace_dir: ws, symbol: 'baz', file: f }, ictx)
  assert(indexed === true, `⑤ 未索引文件触发自动重抽（getSymbols 服务层保鲜）`)
  assert(r.auto_indexed === true, `⑤ 响应标记 auto_indexed（得 ${r.auto_indexed}）`)
  assert(r.outline && r.outline.total_symbols === 1, `⑤ staleness 后正常返回 outline（得 ${JSON.stringify(r.outline)}）`)
}

// ── ⑥ inspect staleness：重抽失败 → 服务层静默降级（R19-②：不再有 index_stale warning）──
{
  const f = 'e.py'
  writeFileSync(join(ws, f), 'def qux():\n    return 1\n')
  const mockIdx = {
    initWorkspace: async () => {},
    getFileMtime: () => 0,
    indexFile: async () => null, // 重抽失败 → 服务层静默降级（auto_indexed:false）
    ensureFreshFile: async () => ({ auto_indexed: false }),
    getSymbols: async () => [{ name: 'qux', type: 'function', start_line: 1, end_line: 2 }],
    getReferences: async () => [],
    getCallers: async () => [],
    getCallees: async () => [],
    searchSymbols: async () => [],
    clearCachesForFile: () => {},
  }
  const ictx = { codeIndexService: mockIdx, getWorkspaceDir: (w) => w }
  const r = await inspect.handle({ workspace_dir: ws, symbol: 'qux', file: f }, ictx)
  assert(r.warning === undefined, `⑥ 重抽失败静默降级（无 warning，得 ${r.warning}）`)
  assert(r.outline && r.outline.total_symbols === 1, `⑥ 降级不影响正常返回（得 ${JSON.stringify(r.outline)}）`)
}

rmSync(ws, { recursive: true, force: true })
console.log(`== test-workflow-closure: ${pass} passed, ${fail} failed ==`)
if (fail > 0) process.exit(1)
