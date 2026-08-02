// test-dogfood-r30.js — 第 30 轮：测试盲区补齐——edit_transaction / diff_facts / trace_symbol
// 三个工具此前仅 stress-test 冒烟、零功能断言（r30 审查发现）。
// 依赖：malong-parse 服务在跑。起真实 code-index（mock core + parse-client 做 langParser）+ 直接调 handler。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const imp = (p) => import(pathToFileURL(p).href)
const MALONG_DIR = join(__dirname, '..')

let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}

const WS = join(tmpdir(), 'opencode', 'r30-ws')
const DATA = join(tmpdir(), 'opencode', 'r30-data')
const SOCK = join(tmpdir(), 'opencode', 'r30-code-index.sock')

rmSync(WS, { recursive: true, force: true })
rmSync(DATA, { recursive: true, force: true })
for (const d of [WS, DATA]) mkdirSync(d, { recursive: true })

// 夹具：常量 + 引用 + 硬编码副本（trace_symbol 目标）；可编辑文件（edit_transaction 目标）
writeFileSync(`${WS}/constants.js`, `const MAX_RETRIES = 3;\nconst OTHER = 7;\nmodule.exports = { MAX_RETRIES, OTHER }\n`)
writeFileSync(`${WS}/app.js`, `const { MAX_RETRIES } = require('./constants.js');\nfunction work() {\n  for (let i = 0; i < MAX_RETRIES; i++) {}\n  for (let j = 0; j < 3; j++) {}\n  return MAX_RETRIES + 1\n}\nmodule.exports = { work }\n`)

const pc = await imp(join(MALONG_DIR, 'parse-client.js'))
await pc.init({ log: () => {} })
const connected = await pc.connect()
assert(connected, 'parse-client 连接到 malong-parse')

const { default: codeIndex } = await imp(join(MALONG_DIR, 'code-index.js'))
const langParser = {
  extractAllAsync: (source, ext, filePath) => pc.extractAll(source, ext, filePath),
  extractReferencesAsync: (source, ext) => pc.extractReferences(source, ext),
  batchExtractAsync: (files) => pc.batchExtract(files),
}
const services = { langParser }
const core = {
  services,
  getService: (n) => services[n],
  registerService: (n, svc) => { services[n] = svc },
  getWorkspaceDir: () => DATA,
  log: () => {},
  emit: () => {},
  get: (key, def) => key === 'codeIndex.udsPath' ? SOCK : (key === 'codeIndex.udsToken' ? '' : def),
}
await codeIndex.init(core)
const svc = services.codeIndex
svc.initWorkspace(WS)
await svc.indexBatch([join(WS, 'constants.js'), join(WS, 'app.js')], WS)

// ── ① trace_symbol：值提取 + 引用 + 硬编码副本 ──
const trace = await imp(join(MALONG_DIR, 'tools', 'tool-trace-symbol', 'handler.js'))
const traceRes = await trace.handle({ workspace_dir: WS, symbol: 'MAX_RETRIES', file: 'constants.js', include_literals: true }, { codeIndexService: svc, getWorkspaceDir: () => DATA })
assert(traceRes.value === 3, `① trace_symbol 提取常量值=3（得 ${traceRes.value}）`)
assert(Array.isArray(traceRes.direct_references) && traceRes.direct_references.length >= 2, `① 引用数>=2（app.js 两处 MAX_RETRIES 得 ${traceRes.direct_references?.length}）`)
assert(traceRes.suspected_literals?.some(l => l.line === 4), `① 硬编码副本 3 被标 suspected（得 ${JSON.stringify(traceRes.suspected_literals)}）`)

// ── ② edit_transaction：begin → edit → commit 生效 ──
const et = await imp(join(MALONG_DIR, 'tools', 'tool-edit-transaction', 'handler.js'))
const begin1 = await et.handle({ workspace_dir: WS, action: 'begin', name: 'r30t1' }, {})
assert(begin1.status === 'ok' && begin1.txnId, `② begin 返回 txnId（得 ${JSON.stringify(begin1)}）`)
const edit1 = await et.handle({ workspace_dir: WS, action: 'edit', txn_id: begin1.txnId, file: 'app.js', edits: [{ old_string: 'function work()', new_string: 'function work2()' }] }, {})
assert(edit1.status === 'staged' && edit1.edits_applied === 1, `② edit 暂存成功（得 ${JSON.stringify(edit1)}）`)
assert(readFileSync(join(WS, 'app.js'), 'utf-8').includes('function work2()'), '② 编辑已写入文件（work2 存在）')
const commit1 = await et.handle({ workspace_dir: WS, action: 'commit', txn_id: begin1.txnId }, {})
assert(commit1.status === 'ok' || commit1.status === 'committed', `② commit 成功（得 ${JSON.stringify(commit1)}）`)
assert(readFileSync(join(WS, 'app.js'), 'utf-8').includes('function work2()'), '② commit 后修改保留')

// ── ③ edit_transaction：begin → edit → rollback 恢复 ──
const begin2 = await et.handle({ workspace_dir: WS, action: 'begin', name: 'r30t2' }, {})
const edit2 = await et.handle({ workspace_dir: WS, action: 'edit', txn_id: begin2.txnId, file: 'app.js', edits: [{ old_string: 'function work2()', new_string: 'function work3()' }] }, {})
assert(edit2.status === 'staged', `③ 第二次编辑暂存（得 ${JSON.stringify(edit2)}）`)
assert(readFileSync(join(WS, 'app.js'), 'utf-8').includes('function work3()'), '③ work3 已写入')
const rollback2 = await et.handle({ workspace_dir: WS, action: 'rollback', txn_id: begin2.txnId }, {})
assert(rollback2.status === 'ok' || rollback2.status === 'rolled_back', `③ rollback 成功（得 ${JSON.stringify(rollback2)}）`)
const afterRb = readFileSync(join(WS, 'app.js'), 'utf-8')
assert(afterRb.includes('function work2()') && !afterRb.includes('function work3()'), '③ rollback 恢复 work2 且无 work3')

// ── ④ diff_facts：对已提交 txn 报告符号变化 ──
const df = await imp(join(MALONG_DIR, 'tools', 'tool-diff-facts', 'handler.js'))
const dfRes = await df.handle({ workspace_dir: WS, since: `txn:${begin1.txnId}` }, { langParserService: langParser, codeIndexService: svc, getWorkspaceDir: () => DATA })
assert(dfRes.txn_id === begin1.txnId, `④ diff_facts 命中 txn（得 ${dfRes.txn_id}）`)
assert(Array.isArray(dfRes.files_changed) && dfRes.files_changed.length >= 1, `④ files_changed 报告 app.js（得 ${JSON.stringify(dfRes.files_changed)}）`)
console.log('DF-RESULT:', JSON.stringify(dfRes.symbols_changed))
assert(dfRes.symbols_changed?.some(s => s.symbol === 'work'), `④ symbols_changed 识别 work→work2 变更（得 ${JSON.stringify(dfRes.symbols_changed?.map(s => s.symbol))}）`)

console.log(`\n== test-dogfood-r30: ${pass} passed, ${fail} failed ==`)
process.exit(fail > 0 ? 1 : 0)
