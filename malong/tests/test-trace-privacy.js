// test-trace-privacy.js — R16B-PRIV01（专家 2026-10-31 r16b 复审 P1）
//
// 缺陷（真 MCP JSON-RPC / stdio 复现）：mcp-server.js 用
//   const reqId = `${id}_${name}_${Date.now()}`; const _traceCallId = `c-${reqId}`
// 把客户端 JSON-RPC 请求 id 原文拼进轨迹 call_id 落盘。把请求 id 设成密钥形态字符串，
// 轨迹里就真的出现该字符串——「绝不存请求原文字段」的承诺没覆盖 ID。
//
// 本文件钉住：
//   ① 单元层：call_id / parent_call_id 里的密钥形态与路径形态输入不得落盘
//   ② 单元层：自由文本 error_code 不得原文落盘（结构化安全码仍保留）
//   ③ 单元层：tool 名非标识符形态 → 归一为 unknown；未知字段不进轨迹
//   ④ 端到端：真起 server 走 stdio，客户端请求 id = 哨兵密钥 → 轨迹里没有它
//   ⑤ 端到端：脱敏后仍能内部关联——同一次调用的 started/finished 共享同一不透明 call_id
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) pass++
  else { fail++; console.error('  FAIL:', msg) }
}

const SENTINEL = 'sk-0123456789abcdef0123456789abcdef'
const SENTINEL2 = 'sk-feedfacefeedfacefeedfacefeedface'
const created = []
const saved = { state: process.env.MALONG_STATE_DIR, trace: process.env.MALONG_TRACE, home: process.env.HOME }

const traceDirOf = (dir) => join(dir, 'trace')
const mainTraceOf = (dir) => join(traceDirOf(dir), 'malong-trace.jsonl')

async function loadTrace(stateDir) {
  process.env.MALONG_STATE_DIR = stateDir
  process.env.HOME = stateDir
  process.env.MALONG_TRACE = 'all'
  nameCounter++
  return import(pathToFileURL(join(root, 'trace.js')).href + '?p=' + nameCounter)
}
let nameCounter = 0

try {
  // ── ①②③ 单元层：写入边界归一化 ──
  {
    const base = mkdtempSync(join(tmpdir(), 'lh-trace-priv-unit-'))
    created.push(base)
    const tr = await loadTrace(base)
    tr.traceStarted({ tool: 'code_read', callId: SENTINEL })
    tr.traceFinished({
      tool: '../../etc/passwd', callId: SENTINEL, parentCallId: SENTINEL2,
      phase: 'finished', latencyMs: 3,
      summary: { outcome: 'error', effect: 'unknown', state_commit: 'unknown', verification: 'not_run', error_code: SENTINEL2 },
      nextAction: 'code_read',
    })
    // 未知字段（未来给 args 加字段时的泄漏面）
    tr.traceEvent({ phase: 'finished', tool: 'code_read', call_id: 'c-ok', raw_args: { path: '/home/x', token: SENTINEL } })

    const p = mainTraceOf(base)
    assert(existsSync(p), '① 轨迹文件已生成（前置）')
    const raw = existsSync(p) ? readFileSync(p, 'utf-8') : ''
    assert(!raw.includes(SENTINEL), '① 客户端形态 call_id 没被落盘')
    assert(!raw.includes(SENTINEL2), '② 自由文本 error_code 没被落盘')
    assert(!raw.includes('/home/'), '① 路径形态输入没被落盘（tool 归一）')
    assert(!raw.includes('raw_args'), '③ 未知字段不进轨迹（白名单）')
    assert(!raw.includes('/home/x'), '③ 未知字段里的内容也没进轨迹')

    const recs = raw.trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
    const started = recs.find(r => r.phase === 'started')
    assert(started && started.call_id === null, '① 非法 call_id 归一为 null（得 ' + JSON.stringify(started && started.call_id) + '）')
    const fin = recs.find(r => r.phase === 'finished' && r.tool === 'unknown')
    assert(fin, '③ 非标识符 tool 归一为 unknown')
    assert(fin && fin.parent_call_id === null, '① 非法 parent_call_id 归一为 null')
    assert(fin && !fin.error_code, '② 非法 error_code 被丢弃而不是原文保留（得 ' + JSON.stringify(fin && fin.error_code) + '）')
  }

  // ── ② 结构化安全码仍保留（脱敏不能把有用信息一起删掉） ──
  {
    const base = mkdtempSync(join(tmpdir(), 'lh-trace-priv-code-'))
    created.push(base)
    const tr = await loadTrace(base)
    tr.traceFinished({
      tool: 'code_patch', callId: 'c-abc123', phase: 'finished', latencyMs: 1,
      summary: { outcome: 'version_conflict', effect: 'not_applied', state_commit: 'not_attempted', verification: 'not_run', error_code: 'VERSION_CONFLICT' },
    })
    const rec = JSON.parse(readFileSync(mainTraceOf(base), 'utf-8').trim())
    assert(rec.error_code === 'VERSION_CONFLICT', '② 安全错误码原样保留（得 ' + JSON.stringify(rec.error_code) + '）')
    assert(rec.call_id === 'c-abc123', '① 合法不透明 call_id 保留（得 ' + JSON.stringify(rec.call_id) + '）')
  }

  // ── ④⑤ 端到端：真 MCP 请求 id 里的哨兵不得进轨迹；关联能力仍可用 ──
  {
    const base = mkdtempSync(join(tmpdir(), 'lh-trace-priv-e2e-'))
    created.push(base)
    const ws = join(base, 'ws')
    mkdirSync(ws, { recursive: true })
    writeFileSync(join(ws, 'a.js'), 'const a = 1;\n')
    const env = {
      ...process.env,
      MALONG_STATE_DIR: base,
      HOME: base,
      MALONG_TRACE: 'all',
      MALONG_SKIP_STATE_MIGRATION: '1',
    }
    const child = spawn(process.execPath, [join(root, 'mcp-server.js')], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let buf = ''
    const pending = new Map()
    child.stdout.on('data', (d) => {
      buf += d.toString()
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const lineStr = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!lineStr) continue
        let msg
        try { msg = JSON.parse(lineStr) } catch { continue }
        const key = msg.id
        if (key != null && pending.has(String(key))) {
          const { resolve } = pending.get(String(key))
          pending.delete(String(key))
          resolve(msg)
        }
      }
    })
    function rpc(id, method, params) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout: ' + method)), 60000)
        pending.set(String(id), { resolve: (m) => { clearTimeout(timer); resolve(m) } })
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      })
    }
    try {
      let ready = false
      for (let i = 0; i < 60 && !ready; i++) {
        try {
          const init = await rpc(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'trace-priv', version: '1' } })
          if (init && init.result) {
            const list = await rpc(2, 'tools/list', {})
            if (list && list.result && list.result.tools && list.result.tools.length) ready = true
          }
        } catch { /* retry */ }
      }
      assert(ready, '④ server 就绪（前置）')
      // 客户端请求 id 就是哨兵本身
      await rpc(SENTINEL, 'tools/call', { name: 'code_read', arguments: { workspace_dir: ws, locator: { file_path: 'a.js' } } })
      await new Promise(r => setTimeout(r, 500))
      const p = mainTraceOf(base)
      assert(existsSync(p), '④ all 模式产生轨迹（前置）')
      const raw = existsSync(p) ? readFileSync(p, 'utf-8') : ''
      assert(!raw.includes(SENTINEL), '④ 客户端请求 id 原文没进轨迹')
      assert(!raw.includes('sk-'), '④ 轨迹里没有密钥形态字符串')
      const recs = raw.trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
      const st = recs.find(r => r.phase === 'started' && r.tool === 'code_read')
      const fi = recs.find(r => r.phase === 'finished' && r.tool === 'code_read')
      assert(st && fi, '⑤ started/finished 都在（前置）')
      assert(st && typeof st.call_id === 'string' && /^c-[A-Za-z0-9_-]+$/.test(st.call_id), '⑤ 写入的是不透明 call_id（得 ' + JSON.stringify(st && st.call_id) + '）')
      assert(st && fi && st.call_id === fi.call_id, '⑤ 脱敏后仍能内部关联（started === finished）')
    } finally {
      try { child.kill('SIGKILL') } catch {}
      await new Promise(r => setTimeout(r, 300))
    }
  }
} finally {
  process.env.MALONG_STATE_DIR = saved.state
  process.env.HOME = saved.home
  if (saved.trace === undefined) delete process.env.MALONG_TRACE
  else process.env.MALONG_TRACE = saved.trace
  for (const d of created) { try { rmSync(d, { recursive: true, force: true }) } catch {} }
}

console.log('\n== test-trace-privacy: ' + pass + ' passed, ' + fail + ' failed ==')
if (fail > 0) process.exitCode = 1
