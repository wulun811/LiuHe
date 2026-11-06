#!/usr/bin/env node
// acceptance-mcp-slice.mjs — 发布验收最小纵切（专家 R16q §5.3）
//
// 把「装好的产物」当黑盒，走完整条链路并逐项记录真实结果：
//   MCP initialize → tools/list → workspace 定位与索引 → 读取 → 编辑
//   → 版本冲突（必须被拒）→ 状态回执 → 事务 Undo（必须真的还原字节）
//
// 刻意不做的事：
//   - 不碰 ~/.config/malong（用临时 MALONG_STATE_DIR）
//   - 不信任回执自述：Undo 后直接读磁盘字节比对
//
// 用法：
//   node scripts/acceptance-mcp-slice.mjs --server <mcp-server.js> \
//        [--parse-bin <malong-parse>] [--workdir <尚不存在的目录>] [--json]
// 退出码：0 全通过 / 1 有断言失败 / 2 环境问题或 --workdir 被拒。
//
// --workdir 语义（R20-F01）：只能指向【事先不存在】的路径。脚本会删除自己创建的
// 测试根目录，因此永不接管、永不删除既有目录；省略则用 mkdtemp 建唯一临时目录。

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { prepareWorkdirOrExit } from './acceptance-workdir.mjs'

const argv = process.argv.slice(2)
const arg = (k, d) => {
  const i = argv.indexOf(k)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}
const SERVER = arg('--server')
const PARSE_BIN = arg('--parse-bin')
const AS_JSON = argv.includes('--json')
if (!SERVER || !existsSync(SERVER)) {
  console.error('缺少 --server <mcp-server.js>（文件不存在）')
  process.exit(2)
}

// R20-F01：拒绝接管既有目录（旧实现直接 rmSync 用户传入的 --workdir，会误删真实目录）
const prepared = prepareWorkdirOrExit(arg('--workdir'), 'accept-slice-')
if (!prepared.ok) process.exit(prepared.code)
const ROOT = prepared.root
const WS = join(ROOT, 'workspace')
const STATE = join(ROOT, 'state')
mkdirSync(join(WS, 'src'), { recursive: true })
mkdirSync(STATE, { recursive: true })

const fileRel = 'src/demo.js'
const fileAbs = join(WS, fileRel)
const original = [
  '// 验收夹具：一个顶层声明 + 一个顶层 try 内的声明（验证块级声明边界）',
  'export function demoFn(x) {',
  '  return x + 1',
  '}',
  '',
  'try {',
  '  const insideTry = 42',
  '  console.log(insideTry)',
  '} catch (e) {',
  '  console.error(e)',
  '}',
  '',
].join('\n')
writeFileSync(fileAbs, original, 'utf-8')

const steps = []
function record(name, ok, detail) {
  steps.push({ step: name, ok: !!ok, detail })
  if (!AS_JSON) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const env = {
  ...process.env,
  MALONG_STATE_DIR: STATE,
  MALONG_TRACE: '',
  MALONG_SEARCH_LOG: '',
  MALONG_DEV_COLLECT: '',
}
if (PARSE_BIN) env.MALONG_PARSE_BIN = PARSE_BIN

const child = spawn(process.execPath, [SERVER], { cwd: WS, env, stdio: ['pipe', 'pipe', 'pipe'] })
let stderrBuf = ''
child.stderr.on('data', (d) => { stderrBuf += d.toString() })

const rl = createInterface({ input: child.stdout })
let nextId = 1
const pending = new Map()

// R20-F02：进程退出/错误必须立刻结算所有在途 RPC。
// 旧实现只靠 180s 定时器：服务被杀后调用方会挂满整个超时窗口。
let childExit = null
function settleAllPending(reason) {
  for (const [, p] of pending) p.reject(new Error(reason))
  pending.clear()
}
child.on('exit', (code, signal) => {
  childExit = { code, signal }
  settleAllPending(`server exited (code=${code}, signal=${signal})`)
})
child.on('error', (e) => {
  childExit = { code: null, signal: null, error: e.message }
  settleAllPending('server spawn error: ' + e.message)
})
rl.on('line', (line) => {
  const s = line.trim()
  if (!s) return
  let msg
  try { msg = JSON.parse(s) } catch { return }
  if (msg.id != null && pending.has(msg.id)) {
    const { resolve: res, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? reject(Object.assign(new Error(msg.error.message || 'rpc error'), { code: msg.error.code, data: msg.error.data })) : res(msg.result)
  }
})

function rpc(method, params, timeoutMs = 180000) {
  const id = nextId++
  const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params })
  return new Promise((res, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`timeout after ${timeoutMs}ms: ${method}`))
    }, timeoutMs)
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); res(v) },
      reject: (e) => { clearTimeout(timer); reject(e) },
    })
    if (childExit) {
      pending.delete(id)
      clearTimeout(timer)
      reject(new Error('server already exited: ' + JSON.stringify(childExit)))
      return
    }
    try {
      child.stdin.write(payload + '\n')
    } catch (e) {
      pending.delete(id)
      clearTimeout(timer)
      reject(e)
    }
  })
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
}

const unwrap = (r) => {
  if (!r) return null
  if (r.structuredContent) return r.structuredContent
  const t = (r.content || []).find((c) => c.type === 'text')
  if (!t) return r
  try { return JSON.parse(t.text) } catch { return { raw: t.text } }
}

let tools = []
async function callTool(suffix, args) {
  const t = tools.find((x) => x.name === suffix) || tools.find((x) => x.name.endsWith(suffix))
  if (!t) throw new Error(`工具不存在：${suffix}（已加载 ${tools.length} 个）`)
  const r = await rpc('tools/call', { name: t.name, arguments: args })
  return { raw: r, data: unwrap(r), isError: !!r.isError }
}

try {
  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'liuhe-acceptance', version: '1.0.0' },
  })
  record('① initialize', !!init?.serverInfo, `${init?.serverInfo?.name} ${init?.serverInfo?.version} protocol=${init?.protocolVersion}`)
  notify('notifications/initialized', {})

  const tl = await rpc('tools/list', {})
  tools = tl?.tools || []
  record('② tools/list', tools.length >= 10, `${tools.length} tools`)

  const task = await callTool('code_task', {
    workspace_dir: WS,
    goal: '在 demoFn 里加一行自增，并说明这个文件有哪些符号',
    search_terms: ['demoFn', 'insideTry'],
  })
  const taskData = task.data || {}
  const taskId = taskData.task?.task_id || taskData.task_id
  record('③ 索引/定位', !!taskId, `task_id=${taskId} candidates=${(taskData.candidates || []).length} route=${taskData.task?.route}`)

  const read = await callTool('code_read', { workspace_dir: WS, task_id: taskId, locator: { file_path: fileRel } })
  const readRef = read.data?.read_ref
  const readText = JSON.stringify(read.data || {})
  const diskNow = readFileSync(fileAbs, 'utf-8')
  record('④ 读取', readText.includes('demoFn') && diskNow.includes('demoFn'), `${readText.length} bytes(json)`)

  let outlineOk = false, outlineDetail = ''
  for (let attempt = 1; attempt <= 4 && !outlineOk; attempt++) {
    try {
      const q = await callTool('code_query', { workspace_dir: WS, mode: 'outline', file: fileRel })
      const outline = q.data?.result?.outline || q.data?.outline || []
      const names = outline.map((n) => n.name)
      // insideTry 在顶层 try 里：R18 之前不进索引，这里必须真的出现（不只看 note 文案）
      outlineOk = names.includes('insideTry') && names.includes('demoFn')
      outlineDetail = `attempt=${attempt} outline=[${names.join(',')}] coverage=${q.data?.result?.outline_coverage}`
    } catch (e) {
      outlineDetail = `attempt=${attempt} outline 调用失败：` + e.message
    }
    if (!outlineOk) await new Promise((r) => setTimeout(r, 400))
  }
  record('④b outline 可见性', outlineOk, outlineDetail)

  const patch1 = await callTool('code_patch', {
    workspace_dir: WS,
    task_id: taskId,
    read_ref: readRef,
    patch: { old_string: '  return x + 1', new_string: '  return x + 1 // acceptance-marker' },
    dry_run: false,
    allow_unsafe_no_base: true,
  })
  const afterPatch = readFileSync(fileAbs, 'utf-8')
  const rev = patch1.data?.task?.revision ?? patch1.data?.target?.file_version?.revision ?? patch1.data?.state_revision
  record('⑤ 编辑', afterPatch.includes('acceptance-marker'), `read_ref=${readRef} state_revision=${rev ?? 'n/a'} ok=${patch1.data?.ok}`)

  let conflictOk = false, conflictDetail = ''
  for (const stale of [0, 1, (Number(rev) || 1) - 1]) {
    try {
      const bad = await callTool('code_patch', {
        workspace_dir: WS,
        task_id: taskId,
        read_ref: readRef,
        expected_state_revision: stale,
        patch: { old_string: 'acceptance-marker', new_string: 'should-not-apply' },
        dry_run: false,
        allow_unsafe_no_base: true,
      })
      const code = bad.data?.code || bad.data?.error || ''
      const msg = bad.data?.message || ''
      conflictDetail = `stale=${stale} → ok=${bad.data?.ok} code=${code} ${String(msg).slice(0, 80)}`
      if (bad.data?.ok === false && /conflict/i.test(code + ' ' + msg)) { conflictOk = true; break }
    } catch (e) {
      conflictDetail = `stale=${stale} → ${e.code || ''} ${e.message}`
      if (/CONFLICT/.test(String(e.code) + e.message)) { conflictOk = true; break }
    }
  }
  const afterConflict = readFileSync(fileAbs, 'utf-8')
  record('⑥ 版本冲突被拒', conflictOk && !afterConflict.includes('should-not-apply'), conflictDetail)

  const st = await callTool('code_status', { workspace_dir: WS, task_id: taskId })
  const stData = st.data || {}
  record('⑦ 状态回执', JSON.stringify(stData).length > 20, `keys=${Object.keys(stData).slice(0, 6).join(',')}`)

  let undoOk = false, undoDetail = ''
  try {
    const before = readFileSync(fileAbs, 'utf-8')
    const begin = await callTool('edit_transaction', { workspace_dir: WS, action: 'begin', name: 'acceptance-undo' })
    const txnId = begin.data?.txnId || begin.data?.txn_id || begin.data?.transaction?.txn_id
    await callTool('edit_transaction', {
      workspace_dir: WS, action: 'edit', txn_id: txnId, file: fileRel,
      edits: [{ old_string: 'acceptance-marker', new_string: 'UNDO-ME' }],
    })
    await callTool('edit_transaction', { workspace_dir: WS, action: 'commit', txn_id: txnId })
    const mid = readFileSync(fileAbs, 'utf-8')
    await callTool('edit_transaction', { workspace_dir: WS, action: 'undo_commit', txn_id: txnId })
    const after = readFileSync(fileAbs, 'utf-8')
    undoOk = mid.includes('UNDO-ME') && after === before
    undoDetail = `txn=${txnId} mid_written=${mid.includes('UNDO-ME')} restored=${after === before}`
  } catch (e) {
    undoDetail = '异常：' + (e.code ? e.code + ' ' : '') + e.message
  }
  record('⑧ 事务 Undo 还原字节', undoOk, undoDetail)
} catch (e) {
  record('执行异常', false, (e.code ? e.code + ' ' : '') + e.message)
} finally {
  try { child.stdin.end() } catch {}
  try { child.kill('SIGTERM') } catch {}
}

const failed = steps.filter((s) => !s.ok)
const exitCode = failed.length ? 1 : 0

if (AS_JSON) {
  console.log(JSON.stringify({
    server: SERVER,
    parse_bin: PARSE_BIN || null,
    workdir: ROOT,
    tools: tools.length,
    steps,
    failed: failed.length,
    exitCode,
    stderr_tail: stderrBuf.slice(-800),
  }, null, 2))
} else {
  console.log(`\n== acceptance: ${steps.length - failed.length}/${steps.length} passed ==`)
  if (failed.length) console.log('stderr tail:\n' + stderrBuf.slice(-800))
}
process.exit(exitCode)
