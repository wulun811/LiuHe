// test-patch-no-fake-success.js — old_string 不存在时不得报假成功
//
// 真实缺陷（2026-11-05 自用试用，R21 产物实测）：
//   code_patch({patch: {old_string: 'NOT_THERE_XYZ', new_string: 'x'}, dry_run: false})
//   → ok=true, observation.committed=true, effect="workspace_write",
//     summary="Applied edit to src/app.js (already present)"
//   → 但磁盘一个字节都没改。
//
// 根因：already_applied 幂等判据是「new_string 在文件里出现过」。
// 单字符 new_string（'x'、'}'、'e'）在全文件必然命中 → 任何 old_string 拼错都变成
// 「已应用」，回执还写 committed:true。用户以为改完了，实际没改。
//
// 判据：old_string 不存在时，
//   · new_string 无辨识度（单字符/短串）→ 必须 PATCH_OLD_STRING_NOT_FOUND，且不得报 committed
//   · new_string 有辨识度（真实已就位）→ 仍可 already_applied（幂等不能被破坏）

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MALONG = join(__dirname, '..')
const TMP = join(process.env.TMPDIR || '/tmp', 'opencode', 'test-fake-success-' + process.pid)
const WS = join(TMP, 'ws')
const STATE = join(TMP, 'state')

let pass = 0, fail = 0
const assert = (c, m) => { if (c) pass++; else { fail++; console.error('  FAIL: ' + m) } }

rmSync(TMP, { recursive: true, force: true })
mkdirSync(join(WS, 'src'), { recursive: true })
mkdirSync(STATE, { recursive: true })

const FILE = 'src/app.js'
const ORIG = [
  'export function greet(name) {',
  '  return "hi " + name',
  '}',
  '',
  'export const VERSION = "1.0.0"',
  '',
].join('\n')
writeFileSync(join(WS, FILE), ORIG, 'utf-8')

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
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fs', version: '1' } })
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n')

  const task = await call('code_task', { workspace_dir: WS, goal: '改 greet' })
  const tid = task?.task?.task_id
  const rd = await call('code_read', { workspace_dir: WS, task_id: tid, locator: { file_path: FILE } })

  // ① 单字符 new_string + 不存在的 old_string → 必须报错，绝不假成功
  {
    const before = readFileSync(join(WS, FILE), 'utf-8')
    const r = await call('code_patch', {
      workspace_dir: WS, task_id: tid, read_ref: rd.read_ref,
      patch: { old_string: 'NOT_THERE_XYZ', new_string: 'x' }, dry_run: false,
    })
    const after = readFileSync(join(WS, FILE), 'utf-8')
    assert(r.ok === false,
      `① old_string 不存在 + new_string 是单字符 'x' 必须失败（得 ok=${r.ok} error=${r.error || '-'}）`)
    assert(r.error === 'PATCH_OLD_STRING_NOT_FOUND' || r.code === 'PATCH_OLD_STRING_NOT_FOUND',
      `① 必须报 PATCH_OLD_STRING_NOT_FOUND（得 ${r.error || r.code || '-'}）`)
    assert(after === before, '① 磁盘必须一个字节都没改')
    const obs = r.observation || {}
    assert(obs.committed !== true,
      `① 失败时不得声称 committed:true（得 ${JSON.stringify(obs.committed)}）——这是"假成功"的核心危害`)
    assert(!/already present|already applied/i.test(String(obs.summary || '')),
      `① 不得把未发生的写入说成 already applied（得 ${String(obs.summary || '').slice(0, 80)}）`)
  }

  // ② 无辨识度的短串（'}'）同样不得假成功
  {
    const r = await call('code_patch', {
      workspace_dir: WS, task_id: tid, read_ref: rd.read_ref,
      patch: { old_string: 'NOT_THERE_ABC', new_string: '}' }, dry_run: false,
    })
    assert(r.ok === false, `② new_string='}' 属无辨识度，必须失败（得 ok=${r.ok}）`)
  }

  // ②b code_batch 走的是另一条路径（组预检），必须同样不放行
  // 自用实测：单写路径修好后 code_batch 仍然假成功 → 判据必须两处共用
  {
    const before = readFileSync(join(WS, FILE), 'utf-8')
    const rd2 = await call('code_read', { workspace_dir: WS, task_id: tid, locator: { file_path: FILE } })
    const r = await call('code_batch', {
      workspace_dir: WS, task_id: tid,
      writes: [{ read_ref: rd2.read_ref, patch: { old_string: 'NOT_THERE_BATCH', new_string: 'x' } }],
      dry_run: false,
    })
    const after = readFileSync(join(WS, FILE), 'utf-8')
    assert(after === before, '②b batch 未写入时磁盘不得变')
    const obs = r.observation || {}
    // 允许幂等 no-op（有 no_effect 明确标记），但不允许「committed:true」这种自相矛盾的回执
    const honest = r.ok === false || obs.no_effect === true
    assert(honest, `②b batch 对无辨识度 new_string 必须报错或标 no_effect（得 ok=${r.ok} no_effect=${obs.no_effect}）`)
    if (obs.no_effect === true) {
      assert(obs.committed !== true,
        `②b 标了 no_effect 就不得再写 committed:true（得 ${JSON.stringify(obs.committed)}）——"什么都没提交"与"已提交"不能同时成立`)
    }
  }

  // ③ 真幂等不能被破坏：先真写，再用同一个 old_string 重试 → already_applied 且磁盘不变
  {
    const w1 = await call('code_patch', {
      workspace_dir: WS, task_id: tid, read_ref: rd.read_ref,
      patch: { old_string: '"hi " + name', new_string: '"hello " + name' }, dry_run: false,
    })
    assert(w1.ok === true, `③ 首次真写必须成功（得 ok=${w1.ok} error=${w1.error || '-'}）`)
    assert(readFileSync(join(WS, FILE), 'utf-8').includes('hello'), '③ 磁盘必须真的写到 hello')

    const rd2 = await call('code_read', { workspace_dir: WS, task_id: tid, locator: { file_path: FILE } })
    const before2 = readFileSync(join(WS, FILE), 'utf-8')
    const w2 = await call('code_patch', {
      workspace_dir: WS, task_id: tid, read_ref: rd2.read_ref,
      patch: { old_string: '"hi " + name', new_string: '"hello " + name' }, dry_run: false,
    })
    const after2 = readFileSync(join(WS, FILE), 'utf-8')
    assert(w2.ok === true, `③ 幂等重试必须 ok=true（得 ${w2.ok}）`)
    assert(after2 === before2, '③ 幂等重试不得再改磁盘')
  }
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
