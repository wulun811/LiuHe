// test-task-next-action-executable.js — code_task 的 next_action 必须"照做就能成"
//
// 真实缺陷（2026-11-05 自用试用，R21 产物实测）：
//   goal="让 outline 支持 python" → next_action 指向 embedded-reader.js::outline
//     该候选 kind=content（注释里出现的词），不是符号 → 照做 code_read 得
//     SYMBOL_NOT_FOUND。
//   goal="把 trace 的默认值改一下" → next_action 指向 scripts/dev-collect.sh::MALONG_TRACE
//     该候选 kind=variable 但无 symbol_id（shell 解析不到）→ 照做得 AMBIGUOUS_SYMBOL。
//
// 判据：next_action 是 agent 唯一会照做的下一步，它必须是可执行的。
// 本测试对每个 goal 真的按 next_action 调用一次，只接受 ok=true 或
// 明确可恢复的失败（带可用 suggestion），不接受「指到读不出来的东西」。

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MALONG = join(__dirname, '..')
const TMP = join(process.env.TMPDIR || '/tmp', 'opencode', 'test-next-action-' + process.pid)
const WS = join(TMP, 'ws')
const STATE = join(TMP, 'state')

let pass = 0, fail = 0
const assert = (c, m) => { if (c) pass++; else { fail++; console.error('  FAIL: ' + m) } }

rmSync(TMP, { recursive: true, force: true })
mkdirSync(join(WS, 'src'), { recursive: true })
mkdirSync(STATE, { recursive: true })

// 夹具：一个真实函数 + 一段提到该词的注释 + 一个 shell 变量
writeFileSync(join(WS, 'src', 'impl.js'), [
  '// 本模块负责 outline 渲染（注释里出现的词不是符号）',
  'export function buildOutlineNode(x) { return { name: x } }',
  'export function computeOutlineLineFields(symbols, total) { return total }',
  '',
].join('\n'), 'utf-8')
writeFileSync(join(WS, 'src', 'other.js'), [
  '// outline 又一次出现在注释里',
  'export const unrelated = 1',
  '',
].join('\n'), 'utf-8')
// 夹具 C：注释词「zzguardedtoken」在该文件里没有任何同名符号——
// 只能作为 kind=content 候选出现，用来钉住「content 目标必须降级为读整文件」。
writeFileSync(join(WS, 'src', 'commentonly.js'), [
  '// 这里提到 zzguardedtoken 但没有任何叫它的符号',
  'export const plainValue = 1',
  '',
].join('\n'), 'utf-8')

mkdirSync(join(WS, 'scripts'), { recursive: true })
writeFileSync(join(WS, 'scripts', 'run.sh'), [
  '#!/usr/bin/env bash',
  'MALONG_TRACE=off',
  'run() { MALONG_TRACE=all; }',
  '',
].join('\n'), 'utf-8')

const SERVER = join(MALONG, 'mcp-server.js')
const env = {
  ...process.env,
  MALONG_STATE_DIR: STATE,
  MALONG_TRACE: '',
  MALONG_SEARCH_LOG: '',
  MALONG_DEV_COLLECT: '',
}
if (process.env.MALONG_PARSE_BIN) env.MALONG_PARSE_BIN = process.env.MALONG_PARSE_BIN

const child = spawn(process.execPath, [SERVER], { cwd: WS, env, stdio: ['pipe', 'pipe', 'pipe'] })
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
  const t = setTimeout(() => { pending.delete(i); rej(new Error('timeout ' + method)) }, 180000)
  pending.set(i, (m) => { clearTimeout(t); res(m) })
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n')
})
const call = async (name, args) => {
  const r = await rpc('tools/call', { name, arguments: args })
  const t = (r.result?.content || []).find((c) => c.type === 'text')
  let p; try { p = JSON.parse(t?.text || '') } catch { p = { raw: t?.text } }
  return p
}

async function boot() {
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'na', version: '1' } })
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n')
}

const GOALS = [
  '让 outline 支持 python',        // 注释命中陷阱（content_hit）
  '把 trace 的默认值改一下',        // shell 变量陷阱（无 symbol_id）
  '修改 buildOutlineNode 的返回结构', // 正常符号命中，必须仍然可执行
  'zzguardedtoken 用在哪里',        // 只有注释命中、文件内无同名符号
]

try {
  await boot()
  for (const goal of GOALS) {
    const t = await call('code_task', { workspace_dir: WS, goal })
    assert(t.ok === true, `[${goal}] code_task 应成功（得 ${JSON.stringify(t.error || t.ok)}）`)
    const na = t.next_action
    assert(na && na.tool, `[${goal}] 必须给出 next_action`)

    // next_action 若是 code_read，必须真的能读出来
    if (na && na.tool === 'code_read') {
      const args = { ...na.args }
      // 允许推荐方省略 task_id（由调用方补），但补上后必须能成功
      if (!args.task_id) args.task_id = t.task?.task_id
      const r = await call('code_read', args)
      const loc = JSON.stringify(args.locator || {})
      assert(r.ok === true,
        `[${goal}] next_action 指向 ${loc} 必须可读，实际 ok=${r.ok} error=${r.error || '-'}` +
        (r.ok === false ? '（推荐了一个读不出来的目标 = 把 agent 引向死路）' : ''))
    }

    // 无论推荐什么，都不能是 kind=content 的注释命中
    const cands = (t.observation?.candidates || [])
    const first = cands[0]
    if (first) {
      const ns = na?.args?.locator || {}
      const isContentTarget = first.kind === 'content' &&
        ns.file_path === first.file_path && ns.name === first.name
      assert(!isContentTarget,
        `[${goal}] 不得把 kind=content 的注释命中（${first.file_path}::${first.name}）推荐为读取目标`)
    }
  }
} catch (e) {
  fail++
  console.error('  执行异常: ' + e.message + '\n' + stderr.split('\n').slice(-5).join('\n'))
} finally {
  try { child.kill('SIGTERM') } catch {}
  // 等进程真的退出再删：索引写入还在进行时 rmSync 会 ENOTEMPTY
  await new Promise((r) => setTimeout(r, 1200))
  try { child.kill('SIGKILL') } catch {}
  await new Promise((r) => setTimeout(r, 300))
  try { rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }) } catch {}
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
