// test-journal-prune.js — journal 终态事务超 TTL 自动节流清扫（r40）
// 覆盖：终态过龄删 / 新鲜留 / staged+created+needs_review 永不删 / 无时间戳走 mtime 兜底 /
//       dryRun 只报不删（无副作用） / 节流跳过 + force 绕过 / maxAgeHours 可配置 / 空目录 no-op
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, rmSync, existsSync, utimesSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}
const { pruneJournals } = await import(pathToFileURL(join(__dirname, '..', 'write-journal.js')).href)

const TMP = join(os.tmpdir(), 'opencode', 'journal-prune-test')
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })

const OLD = new Date(Date.now() - 48 * 3600 * 1000).toISOString()   // 48h 前，超 24h 默认 TTL
const FRESH = new Date().toISOString()

function mkJournal(ws, txnId, stateObj) {
  const dir = join(ws, '.malong', 'journal', txnId)
  mkdirSync(join(dir, 'backup'), { recursive: true })
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ txn_id: txnId, ...stateObj }))
  return dir
}
function jroot(ws) { return join(ws, '.malong', 'journal') }

// ── ① 终态过龄删 / 新鲜留 ──
{
  const ws = join(TMP, 'ws1'); mkdirSync(ws, { recursive: true })
  mkJournal(ws, 'txn_old_committed', { state: 'committed', committed_at: OLD })
  mkJournal(ws, 'txn_fresh_committed', { state: 'committed', committed_at: FRESH })
  const r = pruneJournals(ws, { force: true })
  assert(!existsSync(join(jroot(ws), 'txn_old_committed')), '① 过龄 committed 被删')
  assert(existsSync(join(jroot(ws), 'txn_fresh_committed')), '① 新鲜 committed 保留')
  assert(r.pruned === 1 && r.kept === 1, `① 计数 pruned=1 kept=1（得 ${r.pruned}/${r.kept}）`)
}

// ── ② 保护态永不删（即使过龄）：staged / created / needs_review ──
{
  const ws = join(TMP, 'ws2'); mkdirSync(ws, { recursive: true })
  mkJournal(ws, 'txn_staged', { state: 'staged', committed_at: OLD })
  mkJournal(ws, 'txn_created', { state: 'created', created_at: OLD })
  mkJournal(ws, 'txn_review', { state: 'needs_review', needs_review_at: OLD })
  const r = pruneJournals(ws, { force: true })
  assert(existsSync(join(jroot(ws), 'txn_staged')), '② 过龄 staged 永不删（在途/崩溃恢复候选）')
  assert(existsSync(join(jroot(ws), 'txn_created')), '② 过龄 created 永不删')
  assert(existsSync(join(jroot(ws), 'txn_review')), '② 过龄 needs_review 永不删（待人工核对）')
  assert(r.pruned === 0 && r.kept === 3, `② 全保护 pruned=0 kept=3（得 ${r.pruned}/${r.kept}）`)
}

// ── ③ 其余终态过龄同样清 + 无时间戳走 mtime 兜底 ──
{
  const ws = join(TMP, 'ws3'); mkdirSync(ws, { recursive: true })
  const oldDate = new Date(Date.now() - 48 * 3600 * 1000)
  mkJournal(ws, 'txn_abandoned', { state: 'abandoned', abandoned_at: OLD })
  mkJournal(ws, 'txn_rolled', { state: 'rolled_back', rolled_back_at: OLD })
  // 真实 failed journal 无 failed_at（recoverJournals 只写 reason）→ 靠目录 mtime 兜底，回拨 mtime 到过龄
  const failedDir = mkJournal(ws, 'txn_failed', { state: 'failed', reason: 'simulated' })
  utimesSync(failedDir, oldDate, oldDate)
  const r = pruneJournals(ws, { force: true })
  assert(r.pruned === 3, `③ failed/abandoned/rolled_back 过龄全清（得 ${r.pruned}）`)
  assert(!existsSync(join(jroot(ws), 'txn_failed')), '③ 无时间戳 failed 走 mtime 兜底被删')
  assert(!existsSync(join(jroot(ws), 'txn_rolled')), '③ 带时间戳 rolled_back 被删')
}

// ── ④ dryRun 只报不删（且无副作用：不写 marker） ──
{
  const ws = join(TMP, 'ws4'); mkdirSync(ws, { recursive: true })
  mkJournal(ws, 'txn_dry', { state: 'committed', committed_at: OLD })
  const dry = pruneJournals(ws, { dryRun: true })
  assert(dry.pruned === 1 && dry.dry_run === true, '④ dryRun 报告 pruned=1')
  assert(existsSync(join(jroot(ws), 'txn_dry')), '④ dryRun 不真删')
  assert(!existsSync(join(jroot(ws), '.last_prune')), '④ dryRun 不写 marker（无副作用）')
}

// ── ⑤ 节流：实扫写 marker → 区间内再调跳过 → force 绕过 ──
{
  const ws = join(TMP, 'ws5'); mkdirSync(ws, { recursive: true })
  mkJournal(ws, 'txn_a', { state: 'committed', committed_at: OLD })
  const first = pruneJournals(ws, { force: true })
  assert(first.skipped_throttle === false && existsSync(join(jroot(ws), '.last_prune')), '⑤ 实扫写 marker')
  mkJournal(ws, 'txn_b', { state: 'committed', committed_at: OLD })
  const second = pruneJournals(ws)
  assert(second.skipped_throttle === true && second.pruned === 0, '⑤ 区间内（1h）再调节流跳过')
  assert(existsSync(join(jroot(ws), 'txn_b')), '⑤ 节流跳过时不删')
  const forced = pruneJournals(ws, { force: true })
  assert(forced.skipped_throttle === false && forced.pruned === 1, '⑤ force 绕过节流真删 txn_b')
}

// ── ⑥ maxAgeHours 可配置：缩短 TTL 后较新事务也算过龄 ──
{
  const ws = join(TMP, 'ws6'); mkdirSync(ws, { recursive: true })
  const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString()
  mkJournal(ws, 'txn_2h', { state: 'committed', committed_at: twoHoursAgo })
  const keep = pruneJournals(ws, { force: true, maxAgeHours: 24 })
  assert(keep.kept === 1 && keep.pruned === 0, '⑥ 2h 前 < 24h TTL → 保留')
  const drop = pruneJournals(ws, { force: true, maxAgeHours: 1 })
  assert(drop.pruned === 1, '⑥ maxAgeHours=1 时 2h 前算过龄 → 删')
}

// ── ⑦ 空 / 缺失 journal 根 → no-op 安全 ──
{
  const wsEmpty = join(TMP, 'ws7-empty'); mkdirSync(wsEmpty, { recursive: true })
  const r1 = pruneJournals(wsEmpty, { force: true })
  assert(r1.pruned === 0 && r1.skipped_throttle === false, '⑦ 无 journal 目录 no-op')
  const r2 = pruneJournals(join(TMP, 'no-such-ws-xyz'), { force: true })
  assert(r2.pruned === 0, '⑦ workspace 不存在 no-op 不抛')
}

rmSync(TMP, { recursive: true, force: true })
console.log(`== test-journal-prune: ${pass} passed, ${fail} failed ==`)
if (fail > 0) process.exit(1)
