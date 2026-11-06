// test-txn-edit-multi-hint.js — edit_transaction 也要有批量劝导
//
// 真实缺陷（2026-11-05 真机轨迹复盘）：
//   同样的「一处一处改」问题，code_patch 从第 2 次起就给 batch_hint
//   （"submit them ALL in ONE code_batch"），code_batch 本身就是批量入口；
//   而 edit_transaction 明明有 edit_multi（一次装多文件），却**从不提示**。
//
//   轨迹证据：edit_transaction 208 次调用中 begin 58 / commit 66 / 真 edit 仅 63，
//   骨架占 51%(A池)~64%(B池)；最长一段 23 连击里靠 action=edit 一个文件一个文件地改。
//   最需要提醒的入口反而没有提醒 —— 这是横向不一致，不是用法问题。
//
// 判据：
//   ① 第 1 个文件 stage 后不得出现 batch_hint（别变成噪声）
//   ② 第 2 个文件起必须给出 batch_hint，且点名 action=edit_multi
//   ③ 提示必须给出可直接照做的形状（file_edits）
//   ④ 既有字段一律不得因新增提示而丢失（status/effect/written_to_disk/txn_id）

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MALONG = join(__dirname, '..')
const TMP = join(process.env.TMPDIR || '/tmp', 'opencode', 'test-emh-' + process.pid)
const WS = join(TMP, 'ws')
const STATE = join(TMP, 'state')

let pass = 0, fail = 0
const assert = (c, m) => { if (c) pass++; else { fail++; console.error('  FAIL: ' + m) } }

rmSync(TMP, { recursive: true, force: true })
mkdirSync(join(WS, 'src'), { recursive: true })
mkdirSync(STATE, { recursive: true })
writeFileSync(join(WS, 'src', 'a.js'), 'export const x = 1\n', 'utf-8')
writeFileSync(join(WS, 'src', 'b.js'), 'export const p = 1\n', 'utf-8')

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
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'emh', version: '1' } })
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n')

  const b = await call('edit_transaction', { workspace_dir: WS, action: 'begin', name: 'multi' })
  const txnId = b.txnId

  // ① 第一个文件：不得有 batch_hint
  const e1 = await call('edit_transaction', { workspace_dir: WS, action: 'edit', txn_id: txnId, file: 'src/a.js', edits: [{ old_string: 'x = 1', new_string: 'x = 9' }] })
  assert(e1.ok === true, `① 首次 edit 须成功（得 ${JSON.stringify(e1.error || e1.status)}）`)
  assert(!e1.batch_hint, `① 只 stage 了 1 个文件时不得给 batch_hint（得 ${JSON.stringify(e1.batch_hint)}）——否则是噪声`)

  // ② 第二个文件：必须给 batch_hint 且点名 edit_multi
  const e2 = await call('edit_transaction', { workspace_dir: WS, action: 'edit', txn_id: txnId, file: 'src/b.js', edits: [{ old_string: 'p = 1', new_string: 'p = 9' }] })
  assert(e2.ok === true, `② 第二次 edit 须成功（得 ${JSON.stringify(e2.error || e2.status)}）`)
  assert(!!e2.batch_hint, '② 第 2 个文件起必须给 batch_hint（原缺陷：edit_transaction 从不提 edit_multi）')
  const bh = String(e2.batch_hint || '')
  assert(/edit_multi/.test(bh), `② 提示必须点名 action=edit_multi（得 ${bh.slice(0, 160)}）`)
  assert(/file_edits/.test(bh), `③ 提示必须给出可直接照做的形状 file_edits（得 ${bh.slice(0, 160)}）`)

  // ④ 既有字段不得丢
  assert(e2.status === 'staged', `④ 既有 status 字段不得丢（得 ${JSON.stringify(e2.status)}）`)
  assert(e2.txn_id === txnId, `④ 既有 txn_id 不得丢（得 ${JSON.stringify(e2.txn_id)}）`)
  assert(e2.effect === 'workspace_write', `④ 既有 effect 不得丢（得 ${JSON.stringify(e2.effect)}）`)
  assert(e2.written_to_disk === true, `④ 既有 written_to_disk 不得丢（得 ${JSON.stringify(e2.written_to_disk)}）`)
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
