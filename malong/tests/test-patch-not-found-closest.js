// test-patch-not-found-closest.js — patch 类失败必须指出「你大概想改哪一行」
//
// 真实不一致（2026-11-05 真机手感实测）：
//   同一个失败（old_string 打错一个字），三个写入口给出完全不同的信息质量：
//     · edit_transaction → failed_edits[] + closest_match{line, similarity, snippet}
//     · code_patch       → 只有 "old_string not found in file"
//     · code_batch       → 只有 "old_string not found in file" + item_index
//
//   findClosestMatch 本来就是 error-codes.js 的公共函数（edit_transaction 已用），
//   write-runtime 的 patch 路径只是没接上。轨迹里 PATCH_OLD_STRING_NOT_FOUND
//   两池共 11 次（code_batch 8 / code_patch 3），每一次都只能重读整文件重猜。
//
// 判据：
//   ① code_patch 失败必须带 closest_match，且指向正确行
//   ② code_batch 失败必须带 closest_match（且保留 item_index）
//   ③ closest_match 必须能直接用于修正（snippet 含真实源码）
//   ④ 原子性不破：batch 失败时整批不落盘
//   ⑤ 不得改变错误码本身（仍是 PATCH_OLD_STRING_NOT_FOUND）

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MALONG = join(__dirname, '..')
const TMP = join(process.env.TMPDIR || '/tmp', 'opencode', 'test-closest-' + process.pid)
const WS = join(TMP, 'ws')
const STATE = join(TMP, 'state')

let pass = 0, fail = 0
const assert = (c, m) => { if (c) pass++; else { fail++; console.error('  FAIL: ' + m) } }

const SRC = 'export function alpha(a) {\n  return a + 1\n}\n\nexport const beta = 2\n'
rmSync(TMP, { recursive: true, force: true })
mkdirSync(join(WS, 'src'), { recursive: true })
mkdirSync(STATE, { recursive: true })
writeFileSync(join(WS, 'src', 'a.js'), SRC, 'utf-8')

const env = { ...process.env, MALONG_STATE_DIR: STATE, MALONG_TRACE: '', MALONG_SEARCH_LOG: '', MALONG_DEV_COLLECT: '', MALONG_INTERFACE: 'graph', MALONG_ENTRY_STATE: '1' }
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
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'cl', version: '1' } })
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n')

  const t = await call('code_task', { workspace_dir: WS, goal: '改 alpha' })
  const tid = t.task.task_id
  const rd = await call('code_read', { workspace_dir: WS, task_id: tid, locator: { file_path: 'src/a.js' } })

  // ① code_patch
  const ap = await call('code_patch', {
    workspace_dir: WS, task_id: tid, read_ref: rd.read_ref,
    patch: { old_string: 'return a + 1X', new_string: 'return a + 2' }, dry_run: false,
  })
  assert(ap.ok === false, `① 必须失败（得 ok=${ap.ok}）`)
  assert(ap.code === 'PATCH_OLD_STRING_NOT_FOUND', `⑤ 错误码不变（得 ${ap.code}）`)
  assert(ap.closest_match && typeof ap.closest_match === 'object',
    `① code_patch 必须带 closest_match（得 ${JSON.stringify(ap.closest_match)}）——原缺陷：只回一句 not found`)
  assert(ap.closest_match?.line === 2,
    `① closest_match.line 必须指向真实行 2（得 ${ap.closest_match?.line}）`)
  assert(String(ap.closest_match?.snippet || '').includes('return a + 1'),
    `③ snippet 必须含真实源码供直接修正（得 ${JSON.stringify(ap.closest_match?.snippet)}）`)

  // ② code_batch（item 0 合法，item 1 打错）
  const bp = await call('code_batch', {
    workspace_dir: WS, task_id: tid, dry_run: false, writes: [
      { read_ref: rd.read_ref, patch: { old_string: 'export const beta = 2', new_string: 'export const beta = 3' } },
      { read_ref: rd.read_ref, patch: { old_string: 'return a + 1X', new_string: 'return a + 9' } },
    ],
  })
  assert(bp.ok === false, `② batch 必须失败（得 ok=${bp.ok}）`)
  assert(bp.code === 'PATCH_OLD_STRING_NOT_FOUND', `⑤ batch 错误码不变（得 ${bp.code}）`)
  assert(bp.item_index === 1, `② 必须仍保留 item_index（得 ${bp.item_index}）`)
  assert(bp.closest_match && bp.closest_match.line === 2,
    `② code_batch 也必须带 closest_match（得 ${JSON.stringify(bp.closest_match)}）`)

  // ④ 原子性：整批不得落盘
  assert(readFileSync(join(WS, 'src', 'a.js'), 'utf-8') === SRC,
    '④ batch 失败必须整批不落盘（原子性不得为提示信息让路）')
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
