// test-txn-begin-uncommitted.js — begin 不得静默新建空事务
//
// 真实缺陷（2026-11-05 真机轨迹复盘）：
//   edit_transaction 共 208 次调用，begin 58 次 / commit 66 次 / 真 edit 只 63 次
//   —— 事务骨架占 51%(A池) / 64%(B池)。最长一段 23 连击里
//   4 次 begin + 4 次 commit，只有 9 次真编辑。
//
//   实测成因：连续 begin 不报错、不复用、也不提示，
//   前一个未提交事务就那么挂成孤儿（listTransactions 里多份可查）。
//   调用方看不到「你已经有一个开着的事务」，于是每改一处就再开一个。
//
// 判据：
//   ① 首个 begin 干净（没有 uncommitted_transactions 噪声）
//   ② 第二个 begin 必须**明确列出**未提交事务，并给出复用路径
//   ③ 提示里必须出现可操作的 action（edit / edit_multi / commit / rollback）
//   ④ 仍然允许新建（append-only 语义不变）——不得变成硬拒绝
//   ⑤ 已 commit 的事务不算「未提交」，不得再被列出

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MALONG = join(__dirname, '..')
const TMP = join(process.env.TMPDIR || '/tmp', 'opencode', 'test-txn-begin-' + process.pid)
const WS = join(TMP, 'ws')
const STATE = join(TMP, 'state')

let pass = 0, fail = 0
const assert = (c, m) => { if (c) pass++; else { fail++; console.error('  FAIL: ' + m) } }

rmSync(TMP, { recursive: true, force: true })
mkdirSync(join(WS, 'src'), { recursive: true })
mkdirSync(STATE, { recursive: true })
writeFileSync(join(WS, 'src', 'a.js'), 'export const x = 1\n', 'utf-8')

const env = { ...process.env, MALONG_STATE_DIR: STATE, MALONG_TRACE: '', MALONG_SEARCH_LOG: '', MALONG_DEV_COLLECT: '' }
if (process.env.MALONG_PARSE_BIN) env.MALONG_PARSE_BIN = process.env.MALONG_PARSE_BIN

const child = spawn(process.execPath, [join(MALONG, 'mcp-server.js')], { cwd: WS, env, stdio: ['pipe', 'pipe', 'pipe'] })
let stderr = ''
child.stderr.on('data', (d) => { stderr += d.toString() })
const rl = createInterface({ input: child.stdout })
let nextId = 1
const pending = new Map()
rl.on('line', (l) => {
  const s = l.trim(); if (!s) return
  let m; try { m = JSON.parse(s) } catch { return }
  if (m.id != null && pending.has(m.id)) { const f = pending.get(m.id); pending.delete(m.id); f(m) }
})
const rpc = (method, params) => new Promise((res, rej) => {
  const i = nextId++
  const t = setTimeout(() => { pending.delete(i); rej(new Error('timeout ' + method)) }, 120000)
  pending.set(i, (m) => { clearTimeout(t); res(m) })
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n')
})
const call = async (name, args) => {
  const r = await rpc('tools/call', { name, arguments: args })
  const t = (r.result?.content || []).find((c) => c.type === 'text')
  let p; try { p = JSON.parse(t?.text || '') } catch { p = { raw: t?.text } }
  return p
}

try {
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'tb', version: '1' } })
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n')

  // ① 第一个 begin：干净
  const b1 = await call('edit_transaction', { workspace_dir: WS, action: 'begin', name: 'first' })
  assert(b1.ok === true, `① 首个 begin 必须成功（得 ok=${b1.ok}）`)
  assert(!b1.uncommitted_transactions || b1.uncommitted_transactions.length === 0,
    `① 全新工作区首个 begin 不得报未提交事务（得 ${JSON.stringify(b1.uncommitted_transactions)}）`)
  const txn1 = b1.txnId

  // ② 第二个 begin：必须列出未提交事务
  const b2 = await call('edit_transaction', { workspace_dir: WS, action: 'begin', name: 'second' })
  assert(b2.ok === true, `② 第二个 begin 仍须成功（不硬拒绝；得 ok=${b2.ok}）`)
  const un = b2.uncommitted_transactions || []
  assert(un.length >= 1, `② 必须报出未提交事务（得 ${JSON.stringify(un)}）——静默新建空事务是原缺陷`)
  assert(un.some(t => t.txn_id === txn1),
    `② 列出的必须包含真正的上一个事务 ${txn1}（得 ${JSON.stringify(un.map(t => t.txn_id))}）`)

  // ③ 提示必须可操作
  const note = String(b2.note || '')
  assert(/edit_multi/.test(note),
    `③ 提示必须指出 edit_multi 可一次装多个文件（得 ${note.slice(0, 160)}）`)
  assert(/commit/.test(note) && /rollback/.test(note),
    `③ 提示必须说明 commit / rollback 两个收口动作（得 ${note.slice(0, 160)}）`)

  // ④ 仍允许新建（append-only 不变）
  assert(b2.txnId && b2.txnId !== txn1, `④ 仍应创建新事务、且 id 不同（得 ${b2.txnId}）`)

  // ⑤ commit 过的不算未提交
  const e1 = await call('edit_transaction', { workspace_dir: WS, action: 'edit', txns: undefined, txn_id: txn1, file: 'src/a.js', edits: [{ old_string: 'x = 1', new_string: 'x = 2' }] })
  assert(e1.ok === true, `⑤ 前置：edit 须成功（得 ${JSON.stringify(e1.error || e1.status)}）`)
  const c1 = await call('edit_transaction', { workspace_dir: WS, action: 'commit', txn_id: txn1 })
  assert(c1.ok === true, `⑤ 前置：commit 须成功（得 ${JSON.stringify(c1.error || c1.status)}）`)

  const b3 = await call('edit_transaction', { workspace_dir: WS, action: 'begin', name: 'third' })
  const un3 = b3.uncommitted_transactions || []
  assert(!un3.some(t => t.txn_id === txn1),
    `⑤ 已 commit 的事务不得再列为未提交（得 ${JSON.stringify(un3.map(t => t.txn_id))}）`)
  assert(un3.some(t => t.txn_id === b2.txnId),
    `⑤ 但真正开着的那一个仍要列出（得 ${JSON.stringify(un3.map(t => t.txn_id))}，应为 ${b2.txnId}）`)
} catch (e) {
  fail++
  console.error('  执行异常: ' + e.message + '\n' + stderr.split('\n').slice(-4).join('\n'))
} finally {
  try { child.kill('SIGTERM') } catch {}
  await new Promise((r) => setTimeout(r, 900))
  try { child.kill('SIGKILL') } catch {}
  await new Promise((r) => setTimeout(r, 300))
  try { rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }) } catch {}
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
