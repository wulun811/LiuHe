// outlet-ledger.js — 保底出口（invoke_capability）无 task 副作用的请求账本（R02，0.5.10 审核修复；N02，0.5.11 复审修复）。
// 合同：同 request_id + 同载荷 → 幂等复读（不重复副作用）；同 id 异载荷 → request_conflict。
// 范围：仅「无 task_id 且带 request_id 的副作用委派」；task 场景走任务账本（operations），不进本账本。
// 存储（R1，0.5.14 复审修复）：$MALONG_STATE_DIR/outlet-requests/<wsHash>/<reqHash>.json —— 每 request_id
//   一个独立记录文件（原子写），写只触及自己的记录；保留策略按目录 mtime FIFO 封顶。
//   F1（0.5.14 Windows 复核修复）：回收只淘汰「安全终态」——在途 prepared（持有存活 claim）绝不淘汰，
//   未收口凭证（owner 已死的 prepared / indeterminate / delegate_failed）压缩为恢复占位，绝不静默删除。
//   R1 背景：旧实现单本 JSON（<wsHash>.json）整体 read-modify-write——两个进程用不同 request_id 并发写时
//   各自「读旧本 → 改 → 覆盖整本」，后写者用旧快照丢掉先写者条目（实测：A 完成、B 覆盖、A 原样重试二次执行）。
//   旧格式仍可读（lookup 回退到单本 JSON，只读兼容、不原地迁移）；新写入一律走独立记录。
// N02（0.5.11 复审修复）：账本不再只记「成功」——执行前先占位（state=prepared + claim 独占文件），
//   成功/失败/不确定一律落终态。重试同 request_id 时：succeeded → 幂等复读；其余状态 → request_unresolved（不盲目重放）。
//   遗留窗口（如实声明）：占位前崩溃 = 从未执行（可重试）；占位后崩溃 = 记 prepared 且无终态 → 重试判 unresolved（可人工清理）。
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { getStateDir } from '../host-config.js'
import { wsHash } from './entry-store.js'

const MAX_ENTRIES = 500
const ROOT = 'outlet-requests'
const CLAIM_ROOT = 'outlet-claims'

// request_id 是调用方输入（可含路径字符）——入文件名前一律哈希，不做原样拼接
function requestHash(requestId) {
  return createHash('sha256').update(String(requestId)).digest('hex').slice(0, 32)
}

// 每 request_id 独立记录的落点（导出仅供测试/诊断）
export function ledgerRecordPath(workspaceDir, requestId) {
  return join(getStateDir(), ROOT, wsHash(workspaceDir), requestHash(requestId) + '.json')
}

// 旧单本格式（0.5.13 及以前）——只读回退，兼容历史条目
function legacyLedgerPath(workspaceDir) {
  return join(getStateDir(), ROOT, wsHash(workspaceDir) + '.json')
}

function claimPath(workspaceDir, requestId) {
  return join(getStateDir(), CLAIM_ROOT, wsHash(workspaceDir) + '-' + requestHash(requestId) + '.claim')
}

// N05（0.5.13 复审修复）：持有者存活判定——旧实现见 EEXIST 就判在途，进程在「open 成功、写 prepared 前」
// 被 kill 会留下 pid 已死的孤儿 claim，该 request_id 永久卡死（消息还指向一个不存在的 pid）。
// 判据与 write-journal.journalWriterAlive 对齐：kill(pid,0) 判活（ESRCH=已死、EPERM=存活但无权限）。
// 无可用 pid（空/半写/损坏文件）时退化为年龄判据：新鲜 → 保守判在途；超过阈值 → 视为遗留占位。
const STALE_CLAIM_MS = 60 * 1000   // 无可判 pid 的占位超过此年龄视为遗留
const STALE_LOCK_MS = 10 * 1000    // 接管锁自身崩溃遗留的阈值（防永久卡住接管）

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null
  try { process.kill(pid, 0); return true } catch (e) { return e?.code === 'EPERM' ? true : false }
}

// 返回 'alive'（在途）| 'dead'（持有者已死）| 'fresh'（无 pid 但刚写入，保守）| 'stale'（无 pid 且过期）
function claimHolderState(p, info) {
  const alive = pidAlive(Number(info && info.pid))
  if (alive !== null) return alive ? 'alive' : 'dead'
  let ageMs
  try { ageMs = Date.now() - statSync(p).mtimeMs } catch { return 'fresh' }
  return ageMs > STALE_CLAIM_MS ? 'stale' : 'fresh'
}

// 接管过期占位：用独占接管锁串行化，避免两个进程同时判过期后各自建一个新占位（互斥被打松）。
// 返回 true = 已删除过期占位，调用方可重试 open('wx')；false = 有并发接管者/仍存活，按在途处理。
function takeOverStaleClaim(p) {
  const lock = p + '.takeover'
  let fd
  try {
    mkdirSync(dirname(p), { recursive: true })
    fd = openSync(lock, 'wx')
  } catch (e) {
    if (!e || e.code !== 'EEXIST') return false
    let ageMs
    try { ageMs = Date.now() - statSync(lock).mtimeMs } catch { return false }
    if (ageMs <= STALE_LOCK_MS) return false
    try { unlinkSync(lock) } catch { return false }
    try { fd = openSync(lock, 'wx') } catch { return false }
  }
  try {
    // 持锁复核：仍非存活/新鲜才删（防误删别人刚建立的新占位）
    let info = null
    try { info = JSON.parse(readFileSync(p, 'utf-8')) } catch { info = null }
    const holder = claimHolderState(p, info)
    if (holder === 'alive' || holder === 'fresh') return false
    try { unlinkSync(p) } catch { return false }
    return true
  } finally {
    try { closeSync(fd) } catch {}
    try { unlinkSync(lock) } catch {}
  }
}

// 执行前独占占位（O_EXCL）：跨进程同 request_id 并发时只有一个能拿到 claim，其余判 in_flight。
// 返回 { ok:true } 或 { ok:false, reason, pid?, since?, stale_taken? }。
export function ledgerClaim(workspaceDir, requestId) {
  if (!requestId) return { ok: false, reason: 'missing_request_id' }
  const p = claimPath(workspaceDir, requestId)
  // 最多两轮：首轮 EEXIST 且判定为遗留 → 接管后第二轮 open 成功
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(dirname(p), { recursive: true })
      const fd = openSync(p, 'wx')
      try { writeFileSync(fd, JSON.stringify({ request_id: requestId, pid: process.pid, ts: new Date().toISOString() })) } finally { closeSync(fd) }
      return { ok: true }
    } catch (e) {
      if (!e || e.code !== 'EEXIST') return { ok: false, reason: 'claim_error', error: String(e && e.message ? e.message : e) }
      let info = null
      try { info = JSON.parse(readFileSync(p, 'utf-8')) } catch { info = null }
      const holder = claimHolderState(p, info)
      if (holder === 'alive' || holder === 'fresh') {
        return { ok: false, reason: 'in_flight', pid: info && info.pid ? info.pid : null, since: info && info.ts ? info.ts : null }
      }
      // 持有者已死 / 占位过期：接管（仍失败 = 并发接管进行中，保守判在途）
      if (!takeOverStaleClaim(p)) {
        return { ok: false, reason: 'in_flight', pid: info && info.pid ? info.pid : null, since: info && info.ts ? info.ts : null, takeover: 'contended' }
      }
    }
  }
  return { ok: false, reason: 'claim_error', error: 'claim contention after takeover of ' + requestId }
}

// 终态落账后释放占位（失败不影响账本语义：重试先查账本，再查 claim）
export function ledgerRelease(workspaceDir, requestId) {
  if (!requestId) return false
  try { unlinkSync(claimPath(workspaceDir, requestId)); return true } catch { return false }
}

function readJsonObject(p) {
  try {
    const data = JSON.parse(readFileSync(p, 'utf-8'))
    return (data && typeof data === 'object' && !Array.isArray(data)) ? data : null
  } catch { return null }
}

// 读：先查本 request_id 的独立记录；没有再回退旧单本格式（只读兼容，不迁移）
export function ledgerLookup(workspaceDir, request_id) {
  if (!request_id) return null
  const own = readJsonObject(ledgerRecordPath(workspaceDir, request_id))
  if (own) return own
  const legacy = readJsonObject(legacyLedgerPath(workspaceDir))
  const hit = legacy ? legacy[request_id] : null
  return hit && typeof hit === 'object' ? hit : null
}

// ── F1（0.5.14 Windows 复核修复）：回收必须保护「是否已执行仍不确定」的凭证 ──
// 旧实现按 mtime 无差别淘汰最旧：在途 prepared（owner 仍持 claim）被第 500 个其它请求挤掉后，owner 崩溃 →
// 原 request_id 重试查不到任何记录 → 盲目重放，已发生的副作用再来一次（专家实测 counter 由一行变两行）。
// 分档：① 安全终态（成功 / 被调工具表达的真实失败）→ 可淘汰；② claim 持有者存活/新鲜 → 绝不淘汰；
// ③ 其余（owner 已死的 prepared、未收口 indeterminate、delegate_failed）→ 压缩为恢复占位（保留
// request_id/payload_hash/state 事实，体积有界），重试仍判 unresolved。不靠扩大上限，也不静默删证据。
const SAFE_TERMINAL_STATES = new Set(['succeeded', 'failed'])
const UNSAFE_FAILURE_CODES = new Set(['delegate_failed']) // 委派中途抛出 = 副作用可能部分落地

function recordState(rec) {
  if (!rec || typeof rec !== 'object') return 'unknown'
  if (typeof rec.state === 'string' && rec.state) return rec.state
  return rec.ok === true ? 'succeeded' : 'indeterminate'
}

function isSafeEvictable(rec) {
  const st = recordState(rec)
  if (!SAFE_TERMINAL_STATES.has(st)) return false
  if (st === 'failed' && UNSAFE_FAILURE_CODES.has(String(rec.error_code || ''))) return false
  return true
}

function isRecoveryPlaceholder(rec) { return !!rec && rec.pruned === true }

// 在途判定：claim 存在且持有者存活/新鲜（无 pid 的半写占位按年龄保守判在途）→ 不许淘汰
function claimHeldLive(workspaceDir, requestId) {
  if (!requestId) return false
  const p = claimPath(workspaceDir, requestId)
  let info = null
  let exists = true
  try { info = JSON.parse(readFileSync(p, 'utf-8')) } catch (e) { exists = !!e && e.code !== 'ENOENT' }
  if (!exists) return false
  const holder = claimHolderState(p, info)
  return holder === 'alive' || holder === 'fresh'
}

// 压缩为恢复占位：保留「这个 request_id 可能已执行过」的事实，供重试判 unresolved（不冒充成功/失败）
function writeRecoveryPlaceholder(dir, rec) {
  const reqId = rec.request_id
  if (!reqId) return false
  const p = join(dir, requestHash(reqId) + '.json')
  const stub = {
    request_id: reqId,
    ...(rec.tool ? { tool: rec.tool } : {}),
    ...(rec.payload_hash ? { payload_hash: rec.payload_hash } : {}),
    ...(Array.isArray(rec.effects) && rec.effects.length ? { effects: rec.effects } : {}),
    state: recordState(rec),
    pruned: true,
    pruned_at: new Date().toISOString(),
    ...(rec.created ? { created: rec.created } : {}),
    note: 'Retention: this request_id never reached a safe terminal state (state=' + recordState(rec) + ') — the full record was compacted but the fact that it may have executed is kept: same-id replay stays closed (request_unresolved).',
  }
  try {
    const tmp = p + '.tmp-' + process.pid
    writeFileSync(tmp, JSON.stringify(stub))
    renameSync(tmp, p)
    return true
  } catch { return false }
}

// 保留策略（F1）：先护住在途与未收口凭证，再对最旧的安全终态做 FIFO 淘汰（并发淘汰天然幂等：删不到即忽略）
function pruneRecords(workspaceDir, dir) {
  let names
  try { names = readdirSync(dir).filter(f => f.endsWith('.json')) } catch { return }
  if (names.length <= MAX_ENTRIES) return
  const entries = []
  for (const f of names) {
    let m = 0
    try { m = statSync(join(dir, f)).mtimeMs } catch {}
    entries.push({ f, m, rec: readJsonObject(join(dir, f)) })
  }
  entries.sort((a, b) => b.m - a.m) // 新 → 旧：先留最新的一批（额度内），超出的才处理（旧的最先被处理）
  let kept = 0
  for (const e of entries) {
    if (isRecoveryPlaceholder(e.rec)) continue            // 已压缩的恢复占位：体积有界，不计入留存额度
    if (!e.rec) { try { unlinkSync(join(dir, e.f)) } catch {} ; continue }   // 损坏/不可读：无凭证价值
    if (claimHeldLive(workspaceDir, e.rec.request_id)) { kept++; continue }  // 在途：绝不淘汰
    if (kept < MAX_ENTRIES) { kept++; continue }
    if (isSafeEvictable(e.rec)) { try { unlinkSync(join(dir, e.f)) } catch {} ; continue }
    writeRecoveryPlaceholder(dir, e.rec)                  // 未收口：压缩保留，不静默删除
  }
}

// 每 request_id 独立记录：写只触及自己的文件（tmp+rename 原子替换）——不同 id 并发写互不丢账（R1）
export function ledgerRecord(workspaceDir, record) {
  if (!record || !record.request_id) return null
  const p = ledgerRecordPath(workspaceDir, record.request_id)
  const prev = readJsonObject(p) || {}
  // 首次占位的 created 不可被后续终态覆盖（审计需要「何时开始」）
  const next = {
    ...prev, ...record,
    created: prev.created || record.created || new Date().toISOString(),
    updated: new Date().toISOString(),
  }
  mkdirSync(dirname(p), { recursive: true })
  const tmp = p + '.tmp-' + process.pid
  writeFileSync(tmp, JSON.stringify(next))
  renameSync(tmp, p)
  pruneRecords(workspaceDir, dirname(p))
  return next
}
