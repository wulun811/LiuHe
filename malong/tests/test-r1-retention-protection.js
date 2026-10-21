// test-r1-retention-protection.js — F1（0.5.14 Windows 复核）/ P1：保留回收不得删除在途或未收口的执行凭证
// 专家现场：B 已执行 request_id（副作用已落盘、账本只有 prepared、owner 存活并持有 claim），
// A 完成 500 个其它 request_id 的请求 → 旧 pruneRecords 按 mtime 无差别淘汰最旧，把 B 的 prepared 挤掉；
// 真实终止 B 后，用原 id/原载荷重试 → 找不到任何记录 → 盲目重放，副作用第二次（counter 一行变两行）。
// 本测试锁定：① 在途（claim 存活）记录不被淘汰；② 未收口凭证压缩为恢复占位而非删除（保留 state/payload_hash）；
// ③ 安全终态仍按 FIFO 封顶淘汰、delegate_failed 例外；④ 真进程 owner 被 SIGKILL 后同 id 重试 = unresolved 且零新增副作用。
// 说明：④ 用真进程 + 真 SIGKILL + 真出口 handler（不伪造文件行为）；现场是「已执行」的复刻（counter 先写一行）。
import { join, dirname } from 'node:path'
import { mkdirSync, writeFileSync, readFileSync, appendFileSync, rmSync, existsSync, readdirSync, utimesSync } from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  FAIL: ' + msg) } }
const brief = (v) => JSON.stringify(v ?? null).slice(0, 220)
const NL = String.fromCharCode(10)

const TMP = join(os.tmpdir(), 'opencode', 'r1-retention-protection')
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
mkdirSync(join(TMP, 'src'), { recursive: true })
writeFileSync(join(TMP, 'src', 'a.js'), 'export function a() { return 1 }')
writeFileSync(join(TMP, 'append.cjs'), 'require("node:fs").appendFileSync(require("node:path").join(__dirname, "counter.txt"), "x\\n"); console.log("done")\n')

const imp = (p) => import(pathToFileURL(p).href)
const shared = await imp(join(__dirname, '..', 'tools', 'entry-shared.js'))
const store = await imp(join(__dirname, '..', 'tools', 'entry-store.js'))
const ledger = await imp(join(__dirname, '..', 'tools', 'outlet-ledger.js'))
const inv = (await imp(join(__dirname, '..', 'tools', 'tool-invoke-capability', 'handler.js'))).handle

function mockIndex() {
  return {
    async initWorkspace() {}, async indexBatch() { return [] }, markIndexDirty() {},
    async findDefinitions() { return [] }, async searchSymbols() { return [] },
    findSymbolsInFile() { return [] }, async getFileOutline() { return { outline: [] } },
    async getSymbolsAtLine() { return [] }, getSymbolByStableId() { return null },
    getFileByPath(f) { return { path: f, index_state: 'fresh' } },
  }
}
const ctx = { codeIndexService: mockIndex(), getWorkspaceDir: (w) => w }

function useState(name) {
  process.env.MALONG_STATE_DIR = join(TMP, 'states', name)
  mkdirSync(process.env.MALONG_STATE_DIR, { recursive: true })
}
const recDir = () => join(process.env.MALONG_STATE_DIR, 'outlet-requests', store.wsHash(TMP))
function claimFileFor(requestId) {
  const h = createHash('sha256').update(String(requestId)).digest('hex').slice(0, 32)
  return join(process.env.MALONG_STATE_DIR, 'outlet-claims', store.wsHash(TMP) + '-' + h + '.claim')
}
// 写 claim 占位文件（复刻崩溃现场/存活 owner）；目录可能尚未建（全新 state）
function writeClaim(requestId, pid, ageMs) {
  const p = claimFileFor(requestId)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify({ request_id: requestId, pid, ts: new Date(Date.now() - (ageMs || 0)).toISOString() }))
}
function recordFiles() { try { return readdirSync(recDir()).filter(f => f.endsWith('.json')) } catch { return [] } }
// 可淘汰池计数：只数安全终态（成功 / 被调工具表达的真实失败）——在途与恢复占位不占额度
function terminalCount() {
  return recordFiles().filter(f => {
    try {
      const r = JSON.parse(readFileSync(join(recDir(), f), 'utf8'))
      if (r.pruned === true) return false
      return r.state === 'succeeded' || (r.state === 'failed' && r.error_code !== 'delegate_failed')
    } catch { return false }
  }).length
}
function placeholderCount() {
  return recordFiles().filter(f => { try { return JSON.parse(readFileSync(join(recDir(), f), 'utf8')).pruned === true } catch { return false } }).length
}
function fill(n, prefix) {
  for (let i = 0; i < n; i++) ledger.ledgerRecord(TMP, { request_id: prefix + '-' + i, tool: 'x', payload_hash: 'h', effects: ['command'], state: 'succeeded', ok: true })
}
function age(rid, ms) { try { const d = new Date(Date.now() - ms); utimesSync(ledger.ledgerRecordPath(TMP, rid), d, d) } catch {} }
const counterVal = () => (existsSync(join(TMP, 'counter.txt')) ? readFileSync(join(TMP, 'counter.txt'), 'utf8') : '')

// ── ① 在途（claim 持有者存活）：跨保留上限绝不被淘汰 ──
useState('live')
{
  const c = ledger.ledgerClaim(TMP, 'f1-live')
  assert(c.ok === true, '① 取得占位（得 ' + brief(c) + '）')
  writeClaim('f1-live', process.pid, 0)
  ledger.ledgerRecord(TMP, { request_id: 'f1-live', tool: 'debug_runner', payload_hash: 'h-live', effects: ['command'], state: 'prepared', ok: null })
  age('f1-live', 3600e3)
  fill(600, 'livefill')
  const hit = ledger.ledgerLookup(TMP, 'f1-live')
  assert(!!hit, '① 在途 prepared 跨保留上限仍存在（旧实现被淘汰）')
  assert(hit.state === 'prepared' && hit.pruned !== true && hit.payload_hash === 'h-live', '① 在途记录原样保留（得 ' + brief(hit) + '）')
  assert(terminalCount() <= 500, '① 可淘汰池仍封顶 500（得 ' + terminalCount() + '；在途记录额外保护）')
  ledger.ledgerRelease(TMP, 'f1-live')
}

// ── ② owner 已死的 prepared：压缩为恢复占位（保留事实），不静默删除 ──
useState('dead')
{
  ledger.ledgerRecord(TMP, { request_id: 'f1-dead', tool: 'debug_runner', payload_hash: 'h-dead', effects: ['command'], state: 'prepared', ok: null })
  writeClaim('f1-dead', 999999, 3600e3)
  age('f1-dead', 7200e3)
  fill(600, 'deadfill')
  const hit = ledger.ledgerLookup(TMP, 'f1-dead')
  assert(!!hit, '② 未收口凭证跨上限仍可查（不静默删除）')
  assert(hit.pruned === true && hit.state === 'prepared' && hit.payload_hash === 'h-dead', '② 压缩为恢复占位且保留 state/payload_hash（得 ' + brief(hit) + '）')
  assert(JSON.stringify(hit).length < 700, '② 恢复占位体积有界（得 ' + JSON.stringify(hit).length + ' 字节）')
  assert(terminalCount() <= 500, '② 可淘汰池仍封顶 500（得 ' + terminalCount() + '）')
}

// ── ③ 安全终态仍按 FIFO 封顶淘汰；delegate_failed（副作用可能部分落地）例外 ──
useState('terminal')
{
  ledger.ledgerRecord(TMP, { request_id: 'f1-term-fail', tool: 'debug_runner', payload_hash: 'h-tf', effects: ['command'], state: 'failed', ok: false, error_code: 'exit_code:7' })
  age('f1-term-fail', 7200e3)
  ledger.ledgerRecord(TMP, { request_id: 'f1-threw', tool: 'write_symbol', payload_hash: 'h-th', effects: ['workspace_write'], state: 'failed', ok: false, error_code: 'delegate_failed' })
  age('f1-threw', 7200e3)
  fill(600, 'termfill')
  assert(ledger.ledgerLookup(TMP, 'f1-term-fail') === null, '③ 明确失败（exit_code）仍按 FIFO 淘汰（得 ' + brief(ledger.ledgerLookup(TMP, 'f1-term-fail')) + '）')
  const th = ledger.ledgerLookup(TMP, 'f1-threw')
  assert(!!th && th.pruned === true && th.state === 'failed', '③ delegate_failed 压缩保留（得 ' + brief(th) + '）')
}

// ── ④ 专家原现场：真进程持 claim → 跨上限 → 真 SIGKILL → 同 id 重试必须 unresolved 且零新增副作用 ──
useState('victim')
{
  writeFileSync(join(TMP, 'counter.txt'), '')
  const owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
  await new Promise(r => setTimeout(r, 300))
  const args = { script: 'append.cjs' }
  const payload_hash = shared.payloadHash({ capability: 'debug_runner', args })
  const c = ledger.ledgerClaim(TMP, 'f1-victim')
  assert(c.ok === true && Number.isInteger(owner.pid) && owner.pid > 0, '④ owner 进程存活并持有 claim')
  writeClaim('f1-victim', owner.pid, 0)
  ledger.ledgerRecord(TMP, { request_id: 'f1-victim', tool: 'debug_runner', payload_hash, effects: ['command'], state: 'prepared', ok: null })
  appendFileSync(join(TMP, 'counter.txt'), 'x' + NL)   // 副作用已发生（专家现场：脚本已向 counter 追加）
  fill(600, 'victimfill')
  const survived = ledger.ledgerLookup(TMP, 'f1-victim')
  assert(!!survived && survived.state === 'prepared' && survived.pruned !== true, '④ owner 存活期间 prepared 记录未被回收（得 ' + brief(survived) + '）')
  owner.kill('SIGKILL')
  await new Promise(r => owner.once('exit', r))
  const r1 = await inv({ workspace_dir: TMP, name: 'debug_runner', request_id: 'f1-victim', args }, ctx)
  assert(r1?.error === 'request_unresolved', '④ owner 被 SIGKILL 后同 id 重试 = request_unresolved（得 ' + brief({ e: r1?.error, d: r1?.delegated }) + '）')
  assert(r1?.delegated !== true, '④ 重试没有再委派')
  assert(counterVal() === 'x' + NL, '④ 副作用没有第二次（counter 仍一行；得 ' + brief(counterVal()) + '）')
  const r2 = await inv({ workspace_dir: TMP, name: 'debug_runner', request_id: 'f1-victim', args }, ctx)
  assert(r2?.error === 'request_unresolved', '④ 二次重试仍拒绝盲重放')
  assert(counterVal() === 'x' + NL, '④ 二次重试仍零新增副作用')
  const post = ledger.ledgerLookup(TMP, 'f1-victim')
  assert(!!post && post.state !== 'succeeded', '④ 凭证仍在且未被改判为成功（得 ' + brief(post) + '）')
}

// ── ⑤ 恢复占位仍能维持出口合同：同载荷 unresolved、异载荷 conflict、均零副作用 ──
useState('placeholder-contract')
{
  const base = counterVal()
  const args = { script: 'append.cjs' }
  const payload_hash = shared.payloadHash({ capability: 'debug_runner', args })
  ledger.ledgerRecord(TMP, { request_id: 'f1-ph', tool: 'debug_runner', payload_hash, effects: ['command'], state: 'indeterminate', ok: false })
  age('f1-ph', 7200e3)
  fill(600, 'phfill')
  const ph = ledger.ledgerLookup(TMP, 'f1-ph')
  assert(!!ph && ph.pruned === true && ph.state === 'indeterminate', '⑤ indeterminate（未收口）压缩为占位（得 ' + brief(ph) + '）')
  const rs = await inv({ workspace_dir: TMP, name: 'debug_runner', request_id: 'f1-ph', args }, ctx)
  assert(rs?.error === 'request_unresolved', '⑤ 占位下同 id 同载荷仍判 unresolved（得 ' + brief(rs?.error) + '）')
  const rc = await inv({ workspace_dir: TMP, name: 'debug_runner', request_id: 'f1-ph', args: { script: 'append.cjs', timeout: 31000 } }, ctx)
  assert(rc?.error === 'request_conflict', '⑤ 占位下同 id 异载荷仍判 conflict（得 ' + brief(rc?.error) + '）')
  assert(counterVal() === base, '⑤ 两次重试都未产生副作用')
}

console.log('== test-r1-retention-protection: ' + pass + ' passed, ' + fail + ' failed ==')
process.exit(fail > 0 ? 1 : 0)
