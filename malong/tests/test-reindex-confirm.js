// test-reindex-confirm — r10d：maxFiles 落实为索引上限 + 超阈值二次确认（confirm_token）
// 覆盖：阈值内直接索引 / 超阈值 needs_review + token + 时间估算 / 错误 token 拒绝 /
//       正确 token 全量索引 / maxFiles 截断警告 / blocking 路径
import { join, dirname } from 'node:path'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MALONG = join(__dirname, '..')
const { handle } = await import(pathToFileURL(join(MALONG, 'tools/tool-reindex/handler.js')).href)

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
    // 测试可配：null=旧行为（undefined，handler 回退全量）/ [] = 增量 0 变化 / 数组 = 实际重抽结果
    indexBatchReturn: null,
    async initWorkspace(ws) { svc._currentWorkspace = ws },
    async indexBatch(files, ws, cb) {
      svc.lastBatch = files.slice()
      svc.lastIndexed = { workspace_dir: ws, files: files.length, symbols: files.length, refs: 0 }
      if (cb) cb(files.length, files.length)
      return svc.indexBatchReturn
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
  try { rmSync(ws, { recursive: true, force: true }) } catch {}
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
  try { rmSync(ws, { recursive: true, force: true }) } catch {}
}

console.log('── ③ 错误/过期 token 拒绝 ──')
{
  const ws = mkws(7)
  const svc = mockService()
  await handle({ workspace_dir: ws, threshold: 3 }, { codeIndexService: svc, log: () => {} })
  const r = await handle({ workspace_dir: ws, threshold: 3, confirm: 'deadbeef' }, { codeIndexService: svc, log: () => {} })
  assert(r.status === 'needs_review' && r.confirm_error === 'invalid_or_expired_confirm_token', `伪造 token 拒绝（得 ${r.confirm_error}）`)
  assert(svc.lastBatch === null, '伪造 token 不触发索引')
  try { rmSync(ws, { recursive: true, force: true }) } catch {}
}

console.log('── ④ 正确 token → blocking 全量索引 ──')
{
  const ws = mkws(7)
  const svc = mockService()
  const first = await handle({ workspace_dir: ws, threshold: 3 }, { codeIndexService: svc, log: () => {} })
  const r = await handle({ workspace_dir: ws, threshold: 3, confirm: first.confirm_token, blocking: true }, { codeIndexService: svc, log: () => {} })
  assert(r.status === 'completed' && r.files_indexed === 7, `确认后全量索引（得 ${r.status}/${r.files_indexed}）`)
  assert(!r.warning, '未截断无警告')
  try { rmSync(ws, { recursive: true, force: true }) } catch {}
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
  try { rmSync(ws, { recursive: true, force: true }) } catch {}
}

console.log('── ⑦ 二次 reindex：无变化 → already_fresh 提醒（防 LLM 反复建索引）──')
{
  const ws = mkws(3)
  const svc = mockService()
  svc.indexBatchReturn = []
  const r = await handle({ workspace_dir: ws, threshold: 3, blocking: true }, { codeIndexService: svc, log: () => {} })
  assert(r.status === 'completed' && r.already_fresh === true, `无变化时 already_fresh 明确（得 ${r.status}/${r.already_fresh}）`)
  assert(r.files_indexed === 0 && r.unchanged_skipped === 3, `files_indexed 是真实重抽数 0，unchanged_skipped=3（得 ${r.files_indexed}/${r.unchanged_skipped}）`)
  assert(typeof r.note === 'string' && r.note.includes('already up to date'), `note 提醒无需再建索引（得 ${(r.note || '').slice(0, 40)}...）`)
  try { rmSync(ws, { recursive: true, force: true }) } catch {}
}

console.log('── ⑧ 修改 1 个文件后 → 增量只重抽变化文件，不误报 fresh ──')
{
  const ws = mkws(3)
  const svc = mockService()
  svc.indexBatchReturn = [{ path: 'a0.js' }]
  const r = await handle({ workspace_dir: ws, threshold: 3, blocking: true }, { codeIndexService: svc, log: () => {} })
  assert(r.status === 'completed' && r.already_fresh === false, `有变化时不误报 already_fresh（得 ${r.already_fresh}）`)
  assert(r.files_indexed === 1 && r.unchanged_skipped === 2, `增量只重抽变化文件（得 ${r.files_indexed}/${r.unchanged_skipped}）`)
  try { rmSync(ws, { recursive: true, force: true }) } catch {}
}

console.log('── ⑨ 非 blocking：note 明确增量语义 ──')
{
  const ws = mkws(3)
  const svc = mockService()
  const r = await handle({ workspace_dir: ws, threshold: 3 }, { codeIndexService: svc, log: () => {} })
  assert(r.status === 'started' && typeof r.note === 'string' && r.note.includes('Incremental'), `非 blocking note 明确增量（得 ${(r.note || '').slice(0, 40)}...）`)
  try { rmSync(ws, { recursive: true, force: true }) } catch {}
}

console.log('── ⑥ maxFiles 非数字 → 安全回退默认 ──')
{
  const ws = mkws(3)
  const svc = mockService()
  const r = await handle({ workspace_dir: ws, threshold: 1, maxFiles: 'abc', blocking: true }, { codeIndexService: svc, log: () => {} })
  assert(r.status === 'needs_review' && typeof r.confirm_token === 'string', `maxFiles 非法不崩（得 ${r.status}）`)
  const r2 = await handle({ workspace_dir: ws, threshold: 1, maxFiles: 'abc', confirm: r.confirm_token, blocking: true }, { codeIndexService: svc, log: () => {} })
  assert(r2.status === 'completed' && r2.files_indexed === 3, `非法 maxFiles 回退默认索引全部（得 ${r2.status}/${r2.files_indexed}）`)
  try { rmSync(ws, { recursive: true, force: true }) } catch {}
}

console.log('── ⑩ 超阈值 + 已索引（fresh）→ 免确认 completed；force=true 仍确认 ──')
{
  const ws = mkws(7)
  const svc = mockService()
  const first = await handle({ workspace_dir: ws, threshold: 3 }, { codeIndexService: svc, log: () => {} })
  await handle({ workspace_dir: ws, threshold: 3, confirm: first.confirm_token, blocking: true }, { codeIndexService: svc, log: () => {} })
  // lastIndexed 已存在且 workspace_dir 匹配 → 超阈值 fresh 免确认
  const r = await handle({ workspace_dir: ws, threshold: 3 }, { codeIndexService: svc, log: () => {} })
  assert(r.status === 'completed' && r.already_fresh === true, `超阈值 fresh 免确认（得 ${r.status}/${r.already_fresh}）`)
  assert(!r.confirm_required && r.files_indexed === 0, `fresh 不要求确认且不重索引（confirm_required=${r.confirm_required} files_indexed=${r.files_indexed}）`)
  assert(svc.lastBatch && svc.lastBatch.length === 7, 'fresh 时不触发新的 indexBatch（复用上次索引）')
  // force=true 仍走确认（用户想强制重索引）
  const rf = await handle({ workspace_dir: ws, threshold: 3, force: true }, { codeIndexService: svc, log: () => {} })
  assert(rf.status === 'needs_review', `force=true 仍 needs_review（得 ${rf.status}）`)
  try { rmSync(ws, { recursive: true, force: true }) } catch {}
}

console.log(`\n=== test-reindex-confirm: ${passed} passed, ${failed} failed ===`)
process.exit(failed > 0 ? 1 : 0)
