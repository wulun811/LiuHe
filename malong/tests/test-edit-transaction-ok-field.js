// test-edit-transaction-ok-field.js — edit_transaction 的成功回包必须带 ok:true
//
// 真实缺陷（2026-11-05 自用试用实测）：
//   edit_transaction 是 13 个工具里【唯一】不走 envelope() 的，成功回包只有 status，
//   没有 ok 字段。实测：
//     action=edit        → {"status":"staged", ...}          ok=undefined
//     action=commit      → {"files_changed":2, ...}          ok=undefined
//     action=undo_commit → {"status":"undone", ...}          ok=undefined
//   统一按 `ok === true` 判断的调用方（agent / dsh / 验收脚本）会把成功当失败。
//
// 判据：所有成功动作都必须 ok:true；失败动作必须 ok:false 且带 error。
// 这是纯增量补齐——既有字段一个都不能少。

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MALONG = join(__dirname, '..')
const TMP = join(process.env.TMPDIR || '/tmp', 'opencode', 'test-txn-ok-' + process.pid)
const WS = join(TMP, 'ws')
const STATE = join(TMP, 'state')

let pass = 0, fail = 0
const assert = (c, m) => { if (c) pass++; else { fail++; console.error('  FAIL: ' + m) } }

rmSync(TMP, { recursive: true, force: true })
mkdirSync(join(WS, 'src'), { recursive: true })
mkdirSync(STATE, { recursive: true })
writeFileSync(join(WS, 'src', 'a.js'), 'export const x = 1\n', 'utf-8')
writeFileSync(join(WS, 'src', 'b.js'), 'export const y = 2\n', 'utf-8')

const env = {
  ...process.env, MALONG_STATE_DIR: STATE,
  MALONG_TRACE: '', MALONG_SEARCH_LOG: '', MALONG_DEV_COLLECT: '',
}
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
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'txn', version: '1' } })
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n')

  const begin = await call('edit_transaction', { workspace_dir: WS, action: 'begin', name: 'okcase' })
  assert(begin.ok === true, `① begin 必须 ok:true（得 ${JSON.stringify(begin.ok)}）`)
  const txnId = begin.txnId
  assert(!!txnId, `① begin 必须给 txnId（得 ${JSON.stringify(txnId)}）`)

  const e1 = await call('edit_transaction', { workspace_dir: WS, action: 'edit', txn_id: txnId, file: 'src/a.js', edits: [{ old_string: 'x = 1', new_string: 'x = 11' }] })
  assert(e1.ok === true, `② edit 必须 ok:true（得 ${JSON.stringify(e1.ok)}）；既有字段 status 也须保留（得 ${JSON.stringify(e1.status)}）`)
  assert(e1.status === 'staged', `② edit 既有 status 字段不得丢（得 ${JSON.stringify(e1.status)}）`)

  const e2 = await call('edit_transaction', { workspace_dir: WS, action: 'edit', txn_id: txnId, file: 'src/b.js', edits: [{ old_string: 'y = 2', new_string: 'y = 22' }] })
  assert(e2.ok === true, `② edit 第二个文件也必须 ok:true（得 ${JSON.stringify(e2.ok)}）`)

  const commit = await call('edit_transaction', { workspace_dir: WS, action: 'commit', txn_id: txnId })
  assert(commit.ok === true, `③ commit 必须 ok:true（得 ${JSON.stringify(commit.ok)}）`)
  assert(typeof commit.files_changed === 'number', `③ commit 既有字段不得丢（得 ${JSON.stringify(commit.files_changed)}）`)
  assert(readFileSync(join(WS, 'src', 'a.js'), 'utf-8').includes('x = 11'), '③ 提交后磁盘是新内容')

  const undo = await call('edit_transaction', { workspace_dir: WS, action: 'undo_commit', txn_id: txnId })
  assert(undo.ok === true, `④ undo_commit 必须 ok:true（得 ${JSON.stringify(undo.ok)}）`)
  assert(undo.status === 'undone', `④ undo 既有 status 不得丢（得 ${JSON.stringify(undo.status)}）`)
  assert(readFileSync(join(WS, 'src', 'a.js'), 'utf-8') === 'export const x = 1\n', '④ 撤销必须真的还原字节')
  assert(readFileSync(join(WS, 'src', 'b.js'), 'utf-8') === 'export const y = 2\n', '④ 第二个文件也必须还原')

  // ⑤ 失败路径必须 ok:false（不能被上面的补齐逻辑吞掉）
  const bad = await call('edit_transaction', { workspace_dir: WS, action: 'edit', txn_id: 'no-such-txn', file: 'src/a.js', edits: [{ old_string: 'z', new_string: 'w' }] })
  assert(bad.ok === false, `⑤ 失败动作必须 ok:false（得 ${JSON.stringify(bad.ok)}）`)
  assert(!!bad.error, `⑤ 失败动作必须带 error（得 ${JSON.stringify(bad.error)}）`)

  const badAction = await call('edit_transaction', { workspace_dir: WS, action: 'not_an_action' })
  assert(badAction.ok === false, `⑤ 非法 action 也必须 ok:false（得 ${JSON.stringify(badAction.ok)}）`)
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
