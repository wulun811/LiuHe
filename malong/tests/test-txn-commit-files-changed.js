// test-txn-commit-files-changed.js — commit 回包的 files_changed 必须是真改过的文件数
//
// 真机实测（2026-11-05，重启 opencode 后自用）：
//   事务里 a.js 编辑成功、b.js 的 old_string 不存在 → 部分失败
//   commit 回包：files_changed: 2, files: ['src/a.js','src/b.js']
//   但 b.js 一个字节都没变（failed_edits 里已明说 not_found）
//
// 同一个回包内部就矛盾：stats / file_hashes 只含 a.js（它们按 new_hash 过滤），
// 只有 files_changed 与 files 把「事务登记过的文件」当成「改过的文件」。
// 这与 F07（把上限冒充成真实值）同一类：数字说的不是它声称的东西。
//
// 判据：
//   ① files_changed = 真改过的文件数（有 new_hash）
//   ② files 只列真改过的文件
//   ③ 新增 files_included = 事务登记的文件数（不丢信息，不混用）
//   ④ receipt.files 不得出现 intended_file_hash 为 null 的 'committed' 条目
//   ⑤ 全部失败 → files_changed 0、files 空，不得虚报

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MALONG = join(__dirname, '..')
const TMP = join(process.env.TMPDIR || '/tmp', 'opencode', 'test-txn-files-' + process.pid)
const WS = join(TMP, 'ws')
const STATE = join(TMP, 'state')

let pass = 0, fail = 0
const assert = (c, m) => { if (c) pass++; else { fail++; console.error('  FAIL: ' + m) } }

rmSync(TMP, { recursive: true, force: true })
mkdirSync(join(WS, 'src'), { recursive: true })
mkdirSync(STATE, { recursive: true })
writeFileSync(join(WS, 'src', 'a.js'), 'export const x = 1\n', 'utf-8')
writeFileSync(join(WS, 'src', 'b.js'), "export const greet = 'hi'\n", 'utf-8')

const env = {
  ...process.env, MALONG_STATE_DIR: STATE,
  MALONG_TRACE: '', MALONG_SEARCH_LOG: '', MALONG_DEV_COLLECT: '',
}
if (process.env.MALONG_PARSE_BIN) env.MALONG_PARSE_BIN = process.env.MALONG_PARSE_BIN

const child = spawn(process.execPath, [join(MALONG, 'mcp-server.js')], { cwd: WS, env, stdio: ['pipe', 'pipe', 'pipe'] })
child.stderr.on('data', () => {})
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
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'txn-files', version: '1' } })
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n')

  // ── ① 部分失败：a.js 成功、b.js 锚点不存在 ──
  {
    const begin = await call('edit_transaction', { workspace_dir: WS, action: 'begin', name: 'partial' })
    const txnId = begin.txnId
    assert(!!txnId, `① 前置：begin 给 txnId（得 ${JSON.stringify(begin)}）`)

    const e1 = await call('edit_transaction', { workspace_dir: WS, action: 'edit', txn_id: txnId, file: 'src/a.js', edits: [{ old_string: 'x = 1', new_string: 'x = 11' }] })
    assert(e1.ok === true, `① 前置：a.js 编辑成功（得 ${JSON.stringify(e1.ok)}）`)

    const e2 = await call('edit_transaction', { workspace_dir: WS, action: 'edit', txn_id: txnId, file: 'src/b.js', edits: [{ old_string: "greet = 'hello'", new_string: "greet = 'hello!'" }] })
    assert(e2.ok === false || (e2.files || []).some((f) => f.status === 'error'),
      `① 前置：b.js 必须失败（得 ${JSON.stringify(e2.ok)} / ${JSON.stringify((e2.files || []).map((f) => f.status))}）`)

    const commit = await call('edit_transaction', { workspace_dir: WS, action: 'commit', txn_id: txnId })
    assert(commit.ok === true, `① 前置：commit 成功（得 ${JSON.stringify(commit.error || commit.ok)}）`)

    assert(commit.files_changed === 1, `① files_changed 必须是真改过的文件数 1（得 ${JSON.stringify(commit.files_changed)}）`)
    assert(Array.isArray(commit.files) && commit.files.length === 1 && commit.files[0] === 'src/a.js',
      `② files 只列真改过的文件（得 ${JSON.stringify(commit.files)}）`)
    assert(commit.files_included === 2, `③ files_included 保留事务登记数 2（得 ${JSON.stringify(commit.files_included)}）`)

    const rfiles = commit.receipt?.files || []
    assert(rfiles.length === 1 && rfiles[0].file === 'src/a.js',
      `④ receipt.files 只列真改过的文件（得 ${JSON.stringify(rfiles.map((f) => f.file))}）`)
    const bogus = rfiles.filter((f) => f.status === 'committed' && (f.hashes?.intended ?? f.intended_file_hash) == null)
    assert(bogus.length === 0, `④ 不得出现「committed 但 intended 为 null」的幽灵条目（得 ${JSON.stringify(bogus)}）`)

    assert(readFileSync(join(WS, 'src', 'b.js'), 'utf-8') === "export const greet = 'hi'\n", '① b.js 必须原样未动')
    assert(readFileSync(join(WS, 'src', 'a.js'), 'utf-8').includes('x = 11'), '① a.js 必须真的改了')
  }

  // ── ⑤ 全失败：事务里没有任何真改动 → 不得虚报 ──
  {
    const begin = await call('edit_transaction', { workspace_dir: WS, action: 'begin', name: 'all-fail' })
    const txnId = begin.txnId
    await call('edit_transaction', { workspace_dir: WS, action: 'edit', txn_id: txnId, file: 'src/b.js', edits: [{ old_string: 'nope-nope', new_string: 'x' }] })
    const commit = await call('edit_transaction', { workspace_dir: WS, action: 'commit', txn_id: txnId })
    assert(commit.ok === true, `⑤ 前置：空改动事务 commit 成功（得 ${JSON.stringify(commit.error || commit.ok)}）`)
    assert(commit.files_changed === 0, `⑤ 全失败 → files_changed 0（得 ${JSON.stringify(commit.files_changed)}）`)
    assert(Array.isArray(commit.files) && commit.files.length === 0, `⑤ 全失败 → files 必须为空（得 ${JSON.stringify(commit.files)}）`)
    assert(commit.files_included === 1, `⑤ files_included 仍如实记录 1（得 ${JSON.stringify(commit.files_included)}）`)
  }
} finally {
  try { child.kill('SIGTERM') } catch {}
  // 先等子进程真退出，否则 MCP 还在写 state 目录，rm 会 ENOTEMPTY
  await new Promise((r) => { const t = setTimeout(r, 3000); child.once('exit', () => { clearTimeout(t); r() }) })
  try { rmSync(TMP, { recursive: true, force: true }) } catch {}
}

console.log(`\n=== test-txn-commit-files-changed: ${pass} passed, ${fail} failed ===`)
process.exit(fail > 0 ? 1 : 0)
