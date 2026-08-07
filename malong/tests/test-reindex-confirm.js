// test-reindex-confirm — r10d：maxFiles 落实为索引上限 + 超阈值二次确认（confirm_token）
// 覆盖：阈值内直接索引 / 超阈值 needs_review + token + 时间估算 / 错误 token 拒绝 /
//       正确 token 全量索引 / maxFiles 截断警告 / blocking 路径
import { join, dirname } from 'node:path'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MALONG = join(__dirname, '..')
const { handle } = await import(join(MALONG, 'tools/tool-reindex/handler.js'))

let passed = 0, failed = 0
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ok: ${msg}`) }
  else { failed++; console.error(`  FAIL: ${msg}`) }
}

function mockService() {
  const svc = {
    _currentWorkspace: null,
    indexing: false,
    indexProgress: null,
    lastIndexed: null,
    lastBatch: null,
    async initWorkspace(ws) { svc._currentWorkspace = ws },
    async indexBatch(files, ws, cb) {
      svc.lastBatch = files.slice()
      svc.lastIndexed = { workspace_dir: ws, files: files.length, symbols: files.length, refs: 0 }
      if (cb) cb(files.length, files.length)
    },
    markAllDirty() { return 0 },
  }
  return svc
}

function mkws(n, prefix = 'a') {
  const ws = mkdtempSync(join(tmpdir(), `reindex-confirm-`))
  for (let i = 0; i < n; i++) writeFileSync(join(ws, `${prefix}${i}.js`), `export function f${i}() { return ${i} }\n`)
  return ws
}

console.log('── ① 阈值内直接索引（无 confirm 摩擦） ──')
{
  const ws = mkws(2)
  const svc = mockService()
  const r = await handle({ workspace_dir: ws, threshold: 3, blocking: true }, { codeIndexService: svc, log: () => {} })
  assert(r.status === 'completed' && r.files_indexed === 2, `小项目直接索引（得 ${r.status}/${r.files_indexed}）`)
  assert(!r.confirm_required, '阈值内不要求确认')
  rmSync(ws, { recursive: true, force: true })
}

console.log('── ② 超阈值 → needs_review + token + 时间估算 ──')
{
  const ws = mkws(7)
  const svc = mockService()
  const r = await handle({ workspace_dir: ws, threshold: 3 }, { codeIndexService: svc, log: () => {} })
  assert(r.status === 'needs_review' && r.done === false, '超阈值秒回 needs_review')
  assert(r.confirm_required === true && typeof r.confirm_token === 'string' && r.confirm_token.length >= 8, `confirm_required + 随机 token（得 ${r.confirm_token?.slice(0, 8)}...）`)
  assert(typeof r.estimated_time_seconds === 'number' && r.estimated_time_seconds > 0, `时间估算存在（${r.estimated_time_seconds}s）`)
  // r10e(F1)：量级回归——7 文件估算应 ≤ 固定开销+余量（旧 files/30 得 1s，可逃逸；上界卡死 30s 防拍脑袋系数回归）
  assert(r.estimated_time_seconds <= 30, `估算量级合理（7 文件得 ${r.estimated_time_seconds}s ≤ 30s）`)
  assert(typeof r.estimated_time_human === 'string' && r.estimated_time_human.startsWith('~'), `人类可读估算（${r.estimated_time_human}）`)
  assert(svc.lastBatch === null, '未确认时绝不索引')
  rmSync(ws, { recursive: true, force: true })
}

console.log('── ③ 错误/过期 token 拒绝 ──')
{
  const ws = mkws(7)
  const svc = mockService()
  await handle({ workspace_dir: ws, threshold: 3 }, { codeIndexService: svc, log: () => {} })
  const r = await handle({ workspace_dir: ws, threshold: 3, confirm: 'deadbeef' }, { codeIndexService: svc, log: () => {} })
  assert(r.status === 'needs_review' && r.confirm_error === 'invalid_or_expired_confirm_token', `伪造 token 拒绝（得 ${r.confirm_error}）`)
  assert(svc.lastBatch === null, '伪造 token 不触发索引')
  rmSync(ws, { recursive: true, force: true })
}

console.log('── ④ 正确 token → blocking 全量索引 ──')
{
  const ws = mkws(7)
  const svc = mockService()
  const first = await handle({ workspace_dir: ws, threshold: 3 }, { codeIndexService: svc, log: () => {} })
  const r = await handle({ workspace_dir: ws, threshold: 3, confirm: first.confirm_token, blocking: true }, { codeIndexService: svc, log: () => {} })
  assert(r.status === 'completed' && r.files_indexed === 7, `确认后全量索引（得 ${r.status}/${r.files_indexed}）`)
  assert(!r.warning, '未截断无警告')
  rmSync(ws, { recursive: true, force: true })
}

console.log('── ⑤ maxFiles 截断（索引上限语义）──')
{
  const ws = mkws(9)
  const svc = mockService()
  const first = await handle({ workspace_dir: ws, threshold: 3, maxFiles: 4 }, { codeIndexService: svc, log: () => {} })
  assert(first.indexing_plan.includes('maxFiles=4'), `plan 明确截断方案（得 ${first.indexing_plan.slice(0, 40)}...）`)
  const r = await handle({ workspace_dir: ws, threshold: 3, maxFiles: 4, confirm: first.confirm_token, blocking: true }, { codeIndexService: svc, log: () => {} })
  assert(r.status === 'completed' && r.files_indexed === 4, `仅索引前 maxFiles 个（得 ${r.files_indexed}）`)
  assert(r.warning && r.warning.includes('truncated'), `截断警告明确（得 ${(r.warning || '').slice(0, 40)}...）`)
  rmSync(ws, { recursive: true, force: true })
}

console.log('── ⑥ maxFiles 非数字 → 安全回退默认 ──')
{
  const ws = mkws(3)
  const svc = mockService()
  const r = await handle({ workspace_dir: ws, threshold: 1, maxFiles: 'abc', blocking: true }, { codeIndexService: svc, log: () => {} })
  assert(r.status === 'needs_review' && typeof r.confirm_token === 'string', `maxFiles 非法不崩（得 ${r.status}）`)
  const r2 = await handle({ workspace_dir: ws, threshold: 1, maxFiles: 'abc', confirm: r.confirm_token, blocking: true }, { codeIndexService: svc, log: () => {} })
  assert(r2.status === 'completed' && r2.files_indexed === 3, `非法 maxFiles 回退默认索引全部（得 ${r2.status}/${r2.files_indexed}）`)
  rmSync(ws, { recursive: true, force: true })
}

console.log(`\n=== test-reindex-confirm: ${passed} passed, ${failed} failed ===`)
process.exit(failed > 0 ? 1 : 0)
