// test-invoke-outlet-crash.js — 出口（无 task）崩溃窗口 + 预览幂等矩阵（0.5.13 复审修复）
// 覆盖复验建议矩阵中此前无测试的格：
//   #1 有 task + 预览(dry_run) + 同 id 重试 → 幂等复读、零落盘
//   #2 无 task + 预览 + 同 id 重试         → 出口账本幂等复读、零落盘
//   #5 有 task + 命令失败 + 同 id          → operation_succeeded=false，重放判 request_unresolved
//   #8 占位后进程崩溃（无 task）           → prepared 无终态 → request_unresolved，且零副作用
//   #8b 孤儿 claim（占位前崩溃）           → 持有者 pid 已死：不得永久 in_flight（接管后只执行一次）
//   #8c 存活持有者                         → 仍判 in_flight（修复不得打松互斥）
//   #8d 空白/损坏 claim                    → 新鲜保守判在途，过期才接管
// 说明：本文件不 spawn 真实进程。#8 的崩溃态由「直接写账本/claim 文件」精确复刻（真实文件、真实判据）；
//      真 SIGKILL 由 test-invoke-claim-race.js（跨进程并发）与 test-ac27-crash-window.js（task 分支）覆盖。
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, utimesSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  FAIL: ' + msg) } }

const TMP = join(os.tmpdir(), 'opencode', 'invoke-outlet-crash')
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
mkdirSync(join(TMP, 'src'), { recursive: true })
process.env.MALONG_STATE_DIR = join(TMP, 'state')
writeFileSync(join(TMP, 'src', 'a.js'), 'export function a() { return 1 }')

const imp = (p) => import(pathToFileURL(p).href)
const brief = (v) => JSON.stringify(v ?? null).slice(0, 200)
const NL = String.fromCharCode(10)

function mockIndex() {
  return {
    async initWorkspace() {}, async indexBatch() { return [] },
    markIndexDirty() {},
    async findDefinitions() { return [] }, async searchSymbols() { return [] },
    findSymbolsInFile() { return [] }, async getFileOutline() { return { outline: [] } },
    async getSymbolsAtLine() { return [] }, getSymbolByStableId() { return null },
    getFileByPath(f) { return { path: f, index_state: 'fresh' } },
  }
}
const ctx = { codeIndexService: mockIndex(), getWorkspaceDir: (w) => w }

const shared = await imp(join(__dirname, '..', 'tools', 'entry-shared.js'))
const store = await imp(join(__dirname, '..', 'tools', 'entry-store.js'))
const ledger = await imp(join(__dirname, '..', 'tools', 'outlet-ledger.js'))
const inv = (await imp(join(__dirname, '..', 'tools', 'tool-invoke-capability', 'handler.js'))).handle
const taskMod = await imp(join(__dirname, '..', 'tools', 'tool-code-task', 'handler.js'))

async function mkTask(goal) {
  const r = await taskMod.handle({ workspace_dir: TMP, goal }, ctx)
  return r?.task?.task_id || null
}

// claim 文件路径按实现的命名契约复算（request_id 先 sha256 取前 32 hex，拼 wsHash）——
// 仅测试需要直接读/改写占位文件以复刻崩溃现场；产品路径不导出该内部函数。
function claimFileFor(requestId) {
  const h = createHash('sha256').update(String(requestId)).digest('hex').slice(0, 32)
  return join(process.env.MALONG_STATE_DIR, 'outlet-claims', store.wsHash(TMP) + '-' + h + '.claim')
}
// 写一个「只追加一行」的脚本，避免 shell 引号差异
// 注意：源码里必须是转义序列 \n（反斜杠+n），不能用真实换行——真实换行会截断字符串字面量。
const ESC_N = String.fromCharCode(92) + 'n'
function appendScript(name, counter) {
  return 'require("node:fs").appendFileSync(require("node:path").join(__dirname, "' + counter + '"), "x' + ESC_N + '")' + NL
}

// ── #1 有 task + 预览 + 同 id ──
{
  const t = await mkTask('outlet crash: task preview idempotency')
  assert(!!t, '#1 建任务（得 ' + brief(t) + '）')
  const A = { create: true, locator: { file_path: 'src/preview-task.js' }, content: 'export const pv = 1' + NL, dry_run: true }
  const r1 = await inv({ workspace_dir: TMP, name: 'write_symbol', task_id: t, request_id: 'rid-prev-task', args: A }, ctx)
  assert(r1?.ok === true && r1?.delegated === true, '#1 首次预览委派（得 ' + brief({ e: r1?.error, d: r1?.delegated }) + '）')
  assert(r1?.result?.dry_run === true, '#1 结果确为预览（得 ' + brief(r1?.result?.dry_run) + '）')
  const r2 = await inv({ workspace_dir: TMP, name: 'write_symbol', task_id: t, request_id: 'rid-prev-task', args: A }, ctx)
  assert(r2?.ok === true && r2?.deduplicated === true && r2?.delegated === false, '#1 同 id 同载荷 → 幂等复读不重放（得 ' + brief({ e: r2?.error, d: r2?.delegated, ded: r2?.deduplicated }) + '）')
  assert(existsSync(join(TMP, 'src', 'preview-task.js')) === false, '#1 预览两次都零落盘')
  const r3 = await inv({ workspace_dir: TMP, name: 'write_symbol', task_id: t, request_id: 'rid-prev-task', args: { ...A, content: 'export const pv = 2' + NL } }, ctx)
  assert(r3?.error === 'request_conflict', '#1 同 id 异载荷 → request_conflict（得 ' + brief(r3?.error) + '）')
}

// ── #2 无 task + 预览 + 同 id ──
{
  const A = { create: true, locator: { file_path: 'src/preview-notask.js' }, content: 'export const pv2 = 1' + NL, dry_run: true }
  const r1 = await inv({ workspace_dir: TMP, name: 'write_symbol', request_id: 'rid-prev-notask', args: A }, ctx)
  assert(r1?.ok === true && r1?.delegated === true, '#2 首次预览委派（得 ' + brief({ e: r1?.error, d: r1?.delegated }) + '）')
  assert(r1?.operation_succeeded === true, '#2 预览成功 → operation_succeeded=true（得 ' + brief(r1?.operation_succeeded) + '）')
  const r2 = await inv({ workspace_dir: TMP, name: 'write_symbol', request_id: 'rid-prev-notask', args: A }, ctx)
  assert(r2?.ok === true && r2?.deduplicated === true && r2?.delegated === false, '#2 出口账本幂等复读（得 ' + brief({ e: r2?.error, d: r2?.delegated, ded: r2?.deduplicated }) + '）')
  assert(existsSync(join(TMP, 'src', 'preview-notask.js')) === false, '#2 预览两次都零落盘')
}

// ── #5 有 task + 命令失败 + 同 id ──
{
  const t = await mkTask('outlet crash: task command failure idempotency')
  const F = { command: 'node -e "process.exit(7)"' }
  const f1 = await inv({ workspace_dir: TMP, name: 'debug_runner', task_id: t, request_id: 'rid-cmd-fail', args: F }, ctx)
  assert(f1?.ok === true && f1?.delegated === true && f1?.operation_succeeded === false, '#5 首次命令失败 → operation_succeeded=false（得 ' + brief({ e: f1?.error, os: f1?.operation_succeeded }) + '）')
  assert(f1?.operation?.state === 'failed', '#5 任务账落 failed 终态（得 ' + brief(f1?.operation?.state) + '）')
  const f2 = await inv({ workspace_dir: TMP, name: 'debug_runner', task_id: t, request_id: 'rid-cmd-fail', args: F }, ctx)
  assert(f2?.error === 'request_unresolved', '#5 失败态同 id 重放被拒（得 ' + brief(f2?.error) + '）')
  assert(f2?.delegated !== true, '#5 重放未再委派')
}

// ── #8 占位后崩溃（无 task）：prepared 无终态 → unresolved，零副作用 ──
{
  const counter = join(TMP, 'counter8.txt')
  writeFileSync(counter, '')
  writeFileSync(join(TMP, 'append8.cjs'), appendScript('append8', 'counter8.txt'))
  const S = { script: 'append8.cjs' }
  const payload_hash = shared.payloadHash({ capability: 'debug_runner', args: S })
  ledger.ledgerRecord(TMP, { request_id: 'rid-crash-8', tool: 'debug_runner', payload_hash, effects: ['command'], state: 'prepared', ok: null, created: new Date().toISOString() })
  ledger.ledgerClaim(TMP, 'rid-crash-8') // 崩溃残留的占位（持有者已死）
  const cf = claimFileFor('rid-crash-8')
  assert(!!cf && existsSync(cf), '#8 残留 claim 文件就位')
  writeFileSync(cf, JSON.stringify({ request_id: 'rid-crash-8', pid: 999999, ts: new Date(Date.now() - 3600e3).toISOString() }))
  const r = await inv({ workspace_dir: TMP, name: 'debug_runner', request_id: 'rid-crash-8', args: S }, ctx)
  assert(r?.error === 'request_unresolved', '#8 prepared 无终态 → request_unresolved（得 ' + brief({ e: r?.error, d: r?.delegated }) + '）')
  assert(readFileSync(counter, 'utf-8') === '', '#8 崩溃窗口内不产生副作用')
  assert(ledger.ledgerLookup(TMP, 'rid-crash-8')?.state === 'prepared', '#8 账本仍记 prepared（不被重放改判）')
  ledger.ledgerRelease(TMP, 'rid-crash-8')
}

// ── #8b 孤儿 claim（占位前崩溃）：持有者 pid 已死 → 必须可接管，不得永久 in_flight ──
{
  const counter = join(TMP, 'counter8b.txt')
  writeFileSync(counter, '')
  writeFileSync(join(TMP, 'append8b.cjs'), appendScript('append8b', 'counter8b.txt'))
  const S = { script: 'append8b.cjs' }
  const claim = ledger.ledgerClaim(TMP, 'rid-crash-8b')
  assert(claim?.ok === true, '#8b 先取得占位（得 ' + brief(claim) + '）')
  const cf = claimFileFor('rid-crash-8b')
  // 模拟：open 成功后进程被 SIGKILL —— claim 残留、pid 已死、账本从未写入 prepared
  writeFileSync(cf, JSON.stringify({ request_id: 'rid-crash-8b', pid: 999999, ts: new Date(Date.now() - 3600e3).toISOString() }))
  assert(ledger.ledgerLookup(TMP, 'rid-crash-8b') === null, '#8b 账本无记录（占位前崩溃 = 从未执行）')
  const r = await inv({ workspace_dir: TMP, name: 'debug_runner', request_id: 'rid-crash-8b', args: S }, ctx)
  assert(r?.error !== 'request_unresolved', '#8b 死 pid 的孤儿 claim 不得永久判 in_flight（得 ' + brief({ e: r?.error, m: r?.message }) + '）')
  assert(r?.ok === true && r?.delegated === true, '#8b 应接管孤儿 claim 并真正执行（得 ' + brief({ e: r?.error, d: r?.delegated }) + '）')
  assert(readFileSync(counter, 'utf-8') === 'x' + NL, '#8b 副作用发生且只发生一次（得 ' + brief(readFileSync(counter, 'utf-8')) + '）')
  const r2 = await inv({ workspace_dir: TMP, name: 'debug_runner', request_id: 'rid-crash-8b', args: S }, ctx)
  assert(r2?.deduplicated === true && r2?.delegated === false, '#8b 接管后同 id 复读仍幂等（得 ' + brief({ ded: r2?.deduplicated, d: r2?.delegated }) + '）')
  assert(readFileSync(counter, 'utf-8') === 'x' + NL, '#8b 复读不产生第二次副作用')
}

// ── #8c 存活持有者的 claim 不得被抢占（互斥语义不许被修复打松）──
{
  const counter = join(TMP, 'counter8c.txt')
  writeFileSync(counter, '')
  writeFileSync(join(TMP, 'append8c.cjs'), appendScript('append8c', 'counter8c.txt'))
  ledger.ledgerClaim(TMP, 'rid-live-8c')
  const cf = claimFileFor('rid-live-8c')
  writeFileSync(cf, JSON.stringify({ request_id: 'rid-live-8c', pid: process.pid, ts: new Date().toISOString() }))
  const r = await inv({ workspace_dir: TMP, name: 'debug_runner', request_id: 'rid-live-8c', args: { script: 'append8c.cjs' } }, ctx)
  assert(r?.error === 'request_unresolved', '#8c 存活持有者 → 仍判 in_flight（得 ' + brief({ e: r?.error }) + '）')
  assert(/in flight|in_flight/i.test(String(r?.message || '')), '#8c 消息说明持有者仍在途（得 ' + brief(r?.message) + '）')
  assert(readFileSync(counter, 'utf-8') === '', '#8c 抢占失败时零副作用')
  ledger.ledgerRelease(TMP, 'rid-live-8c')
}

// ── #8d 空白/损坏 claim：新鲜保守判在途，过期才接管 ──
{
  const counter = join(TMP, 'counter8d.txt')
  writeFileSync(counter, '')
  writeFileSync(join(TMP, 'append8d.cjs'), appendScript('append8d', 'counter8d.txt'))
  ledger.ledgerClaim(TMP, 'rid-empty-8d')
  const cf = claimFileFor('rid-empty-8d')
  writeFileSync(cf, '')   // 复刻 open→write 之间被读到的空文件
  const fresh = await inv({ workspace_dir: TMP, name: 'debug_runner', request_id: 'rid-empty-8d', args: { script: 'append8d.cjs' } }, ctx)
  assert(fresh?.error === 'request_unresolved', '#8d 新鲜的空白 claim → 保守判在途（得 ' + brief({ e: fresh?.error }) + '）')
  assert(readFileSync(counter, 'utf-8') === '', '#8d 保守判在途时零副作用')
  const old = new Date(Date.now() - 10 * 60 * 1000)
  utimesSync(cf, old, old)
  const stale = await inv({ workspace_dir: TMP, name: 'debug_runner', request_id: 'rid-empty-8d', args: { script: 'append8d.cjs' } }, ctx)
  assert(stale?.ok === true && stale?.delegated === true, '#8d 过期空白 claim → 接管执行（得 ' + brief({ e: stale?.error, d: stale?.delegated }) + '）')
  assert(readFileSync(counter, 'utf-8') === 'x' + NL, '#8d 接管后副作用发生一次')
}

console.log('== test-invoke-outlet-crash: ' + pass + ' passed, ' + fail + ' failed ==')
if (fail > 0) process.exit(1)
