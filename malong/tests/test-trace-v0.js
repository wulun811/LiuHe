// test-trace-v0.js — TRACE v0（专家 0.6.1 §4）：本地元数据轨迹
//
// 专家硬约束逐条转成断言：
//   ① MALONG_TRACE 默认 off：不建文件、不写盘（零行为变化）
//   ② errors 模式：只留失败/未验证/started
//   ③ all 模式：正常调用也留
//   ④ 只记元数据——绝不出现 args / 源码 / 绝对路径 / token / key / 提示词
//   ⑤ phase=started + finished：崩溃时「有开始无结果」可判定
//   ⑥ reported_success 不得自动变成 verified
//   ⑦ 轮转可读回（历史不丢）
//   ⑧ 写失败不改变工具结果（traceEvent 永不抛）
//   ⑨ 单文件字节上限 + 档数上限（有界）
//   ⑩ health(stats).trace 暴露 write_failed 计数与模式
//   ⑪ 轨迹里没有 MCP 工具 schema 改动（工具数不变）
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, statSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) pass++
  else { fail++; console.error('  FAIL:', msg) }
}

const saved = { trace: process.env.MALONG_TRACE, state: process.env.MALONG_STATE_DIR, home: process.env.HOME }
const created = []
function freshState(tag) {
  const dir = mkdtempSync(join(tmpdir(), `lh-trace-${tag}-`))
  created.push(dir)
  process.env.MALONG_STATE_DIR = dir
  process.env.HOME = dir
  return dir
}

// 轨迹文件的实际位置：<stateDir>/trace/（2026-10-30 起）。
// 测试不要硬编码根目录——否则路径一改，断言就在错的地方读不到文件而“碰巧”通过/直接崩。
const traceDirOf = (dir) => join(dir, 'trace')
const mainTraceOf = (dir) => join(traceDirOf(dir), 'malong-trace.jsonl')
const readMain = (dir) => readFileSync(mainTraceOf(dir), 'utf-8')

// 每个模式要重新 import（模块读 env 是运行期求值，但计数器是模块级，分开验更清楚）
async function loadTrace() {
  const url = pathToFileURL(join(root, 'trace.js')).href + `?t=${Math.random()}`
  return import(url)
}

try {
  // ── ① 默认 off：零副作用 ──
  {
    delete process.env.MALONG_TRACE
    const dir = freshState('off')
    const tr = await loadTrace()
    assert(tr.getTraceMode() === 'off', `① 默认模式为 off（得 ${tr.getTraceMode()}）`)
    const r1 = tr.traceStarted({ tool: 'code_read', callId: 'c-1' })
    const r2 = tr.traceFinished({ tool: 'code_read', callId: 'c-1', summary: { outcome: 'ok' } })
    assert(r1.written === false && r1.reason === 'off', `① started 不写（得 ${JSON.stringify(r1)}）`)
    assert(r2.written === false, '① finished 不写')
    const files = readdirSync(dir).filter(f => f.includes('trace'))
    assert(files.length === 0, `① off 时不创建任何轨迹文件（得 ${JSON.stringify(files)}）`)
    // off 时 stats 明确说「没采集」，不能让 0 看起来像「采集了没数据」
    const st = tr.traceStats()
    assert(st.mode === 'off' && st.enabled === false, '① stats 报告 off')
    assert(/off/.test(st.note), `① stats note 明确说明未采集（得 ${st.note}）`)
  }

  // ── ② errors 模式：只留失败 / 未验证 / started ──
  {
    process.env.MALONG_TRACE = 'errors'
    const dir = freshState('errors')
    const tr = await loadTrace()
    tr.traceStarted({ tool: 'code_read', callId: 'c-ok' })
    tr.traceFinished({ tool: 'code_read', callId: 'c-ok', phase: 'finished', summary: { outcome: 'ok', effect: 'read_only', state_commit: 'not_attempted', verification: 'verified' } })
    tr.traceStarted({ tool: 'code_patch', callId: 'c-bad' })
    tr.traceFinished({ tool: 'code_patch', callId: 'c-bad', phase: 'finished', summary: { outcome: 'version_conflict', effect: 'not_applied', state_commit: 'not_attempted', verification: 'not_run', error_code: 'VERSION_CONFLICT' } })
    const raw = readMain(dir).trim().split('\n').map(l => JSON.parse(l))
    const finished = raw.filter(r => r.phase !== 'started')
    assert(raw.some(r => r.phase === 'started'), '② started 事件保留（崩溃窗必需）')
    assert(finished.length === 1, `② 只有失败那条 finished 落盘（得 ${finished.length} 条：${JSON.stringify(finished.map(f => f.outcome))}）`)
    assert(finished[0].error_code === 'VERSION_CONFLICT', '② 失败条带 error_code')
    assert(!raw.some(r => r.call_id === 'c-ok' && r.phase !== 'started'), '② 成功的 finished 不留')
  }

  // ── ③ all 模式：正常调用也留 ──
  {
    process.env.MALONG_TRACE = 'all'
    const dir = freshState('all')
    const tr = await loadTrace()
    tr.traceStarted({ tool: 'code_read', callId: 'c-all' })
    tr.traceFinished({ tool: 'code_read', callId: 'c-all', phase: 'finished', latencyMs: 12, summary: { outcome: 'ok', effect: 'read_only', state_commit: 'not_attempted', verification: 'verified' } })
    const raw = readMain(dir).trim().split('\n').map(l => JSON.parse(l))
    assert(raw.length === 2, `③ all 模式 started+finished 都留（得 ${raw.length}）`)
    const fin = raw.find(r => r.phase === 'finished')
    assert(fin.latency_ms === 12, '③ 延迟被记录')
  }

  // ── ④ 只记元数据：真跑一次带敏感内容的调用，检查轨迹里没有内容 ──
  {
    process.env.MALONG_TRACE = 'all'
    const dir = freshState('nodata')
    const tr = await loadTrace()
    tr.traceStarted({ tool: 'code_patch', callId: 'c-secret' })
    tr.traceFinished({
      tool: 'code_patch', callId: 'c-secret', phase: 'finished',
      summary: { outcome: 'error', effect: 'not_applied', state_commit: 'not_attempted', verification: 'not_run', error_code: 'E_X' },
    })
    const raw = readMain(dir)
    // 轨迹里不该有的东西
    assert(!raw.includes('/home/'), '④ 无绝对路径')
    assert(!raw.includes('\\Users\\'), '④ 无 Windows 绝对路径')
    assert(!raw.includes('sk-'), '④ 无 key')
    assert(!raw.includes('Bearer'), '④ 无 token')
    assert(!raw.includes('old_string'), '④ 无补丁内容')
    assert(!raw.includes('function '), '④ 无源码片段')
    // 该有的
    const one = JSON.parse(raw.trim().split('\n')[0])
    assert(one.v === 1, '④ 版本化事件格式 v=1')
    assert(typeof one.ts === 'string' && !Number.isNaN(Date.parse(one.ts)), '④ ISO 时间戳')
    assert('call_id' in one && 'tool' in one && 'phase' in one, '④ 必需字段齐备')
  }

  // ── ⑤ 崩溃窗：只有 started 没有 finished → triage 能判定 ──
  {
    process.env.MALONG_TRACE = 'all'
    const dir = freshState('crash')
    const tr = await loadTrace()
    tr.traceStarted({ tool: 'code_patch', callId: 'c-crash' })
    // 故意不写 finished（模拟进程被杀）
    const entries = tr.readTraceEntries()
    const startedOnly = entries.filter(e => e.call_id === 'c-crash')
    assert(startedOnly.length === 1 && startedOnly[0].phase === 'started', '⑤ 崩溃窗留下 started')
  }

  // ── ⑥ success 不得自动变成 verified ──
  {
    const tr = await loadTrace()
    const s1 = tr.summarizeToolResult({ status: 'ok' })
    assert(s1.verification === 'not_run', `⑥ 仅 success 时 verification=not_run（得 ${s1.verification}）`)
    const s2 = tr.summarizeToolResult({ status: 'ok', readback_verified: true })
    assert(s2.verification === 'verified', '⑥ 显式 readback_verified 才算 verified')
    const s3 = tr.summarizeToolResult({ status: 'ok', readback_verified: false })
    assert(s3.verification === 'failed', `⑥ readback_verified=false → failed（得 ${s3.verification}）`)
    // effect 不得从 status 猜
    const s4 = tr.summarizeToolResult({ status: 'ok' })
    assert(s4.effect === 'unknown', `⑥ 未声明 effect 时为 unknown（得 ${s4.effect}）`)
    // 白名单：未知 outcome 不得原样落盘（可能是任意文本）
    const s5 = tr.summarizeToolResult({ status: 'some personalised文案 with /home/chen/x.js' })
    assert(s5.outcome === 'ok' || s5.outcome === 'error' || s5.outcome === 'unknown', `⑥ 未知 status 收敛到安全枚举（得 ${s5.outcome}）`)
  }

  // ── ⑦ 轮转可读回 ──
  {
    process.env.MALONG_TRACE = 'all'
    const dir = freshState('rotate')
    mkdirSync(traceDirOf(dir), { recursive: true })
    // 直接造一个超阈值的轨迹文件，再写一条触发轮转
    const main = mainTraceOf(dir)
    const big = JSON.stringify({ v: 1, ts: new Date().toISOString(), tool: 'bulk', phase: 'started', call_id: 'old' }) + '\n'
    writeFileSync(main, big.repeat(Math.ceil((5 * 1024 * 1024) / big.length)))
    const tr = await loadTrace()
    tr.traceStarted({ tool: 'new_tool', callId: 'c-new' })
    const assert1 = existsSync(main + '.1')
    assert(assert1, '⑦ 超阈值触发轮转 .1')
    const entries = tr.readTraceEntries({ limit: 10 })
    assert(entries.some(e => e.call_id === 'c-new'), '⑦ 新条目可读')
    assert(entries.some(e => e.call_id === 'old'), '⑦ 轮转档历史可读回')
  }

  // ── ⑰ 文件集口径：只认主文件 + 1..MAX_ROTATIONS 档，其余一律不算轨迹 ──
  // 背景（2026-10-30 统一读取）：readTraceEntries 只读 .1/.2/.3，而 trace-triage
  // 自己写了第二份读取（startsWith(BASE+'.')），于是同一份目录两边读到的条数不同：
  // 越界的 .4、外来的 .1.bak 都被 triage 当成轨迹。现在收敛到 readTraceEntries 一个入口，
  // 这里把“哪些文件算轨迹”钉成合同。
  {
    const dir = freshState('fileset')
    const tr = await loadTrace()
    process.env.MALONG_TRACE = 'all'
    const rec = (tool) => JSON.stringify({ v: 1, ts: new Date().toISOString(), tool, phase: 'started' }) + '\n'
    writeFileSync(join(dir, 'malong-trace.jsonl'), rec('t_main'))
    writeFileSync(join(dir, 'malong-trace.jsonl.1'), rec('t_rot1'))
    writeFileSync(join(dir, 'malong-trace.jsonl.2'), rec('t_rot2'))
    // 这两个都不该被当成轨迹：越界档 / 外来后缀
    writeFileSync(join(dir, 'malong-trace.jsonl.4'), rec('t_beyond'))
    writeFileSync(join(dir, 'malong-trace.jsonl.1.bak'), rec('t_stray'))

    const tools = tr.readTraceEntries({ limit: 100 }).map(e => e.tool)
    assert(tools.includes('t_main'), '⑰ 主文件被读到')
    assert(tools.includes('t_rot1') && tools.includes('t_rot2'), '⑰ 合法轮转档 .1/.2 被读到')
    assert(!tools.includes('t_beyond'), '⑰ 越界档 .4 不算轨迹（不因磁盘上碰巧存在就读）')
    assert(!tools.includes('t_stray'), '⑰ 外来后缀 .1.bak 不算轨迹')
    assert(tools.length === 3, `⑰ 文件集恰好 3 条（得 ${tools.length}：${tools.join(',')}）`)

    // 时间顺序：老 → 新（.2 最老，主文件最新）
    assert(tools[0] === 't_rot2' && tools[tools.length - 1] === 't_main', `⑰ 按 老→新 排列（得 ${tools.join(',')}）`)

    // includeRotated:false 只读主文件
    const mainOnly = tr.readTraceEntries({ limit: 100, includeRotated: false }).map(e => e.tool)
    assert(mainOnly.length === 1 && mainOnly[0] === 't_main', `⑰ includeRotated:false 只读主文件（得 ${mainOnly.join(',')}）`)

    // 元信息要能说清“读了哪些、丢了几条坏行”——客户端要能拿它对齐口径
    if (typeof tr.readTraceEntriesDetailed === 'function') {
      const d = tr.readTraceEntriesDetailed({ limit: 100 })
      assert(Array.isArray(d.files) && d.files.length === 3, `⑰ 元信息列出 3 个文件（得 ${JSON.stringify(d.files)}）`)
      assert(d.files.some(f => f.file === 'malong-trace.jsonl'), '⑰ 元信息含主文件')
      assert(typeof d.parsed === 'number' && d.parsed === 3, `⑰ 元信息 parsed=3（得 ${d.parsed}）`)
      assert(typeof d.malformed_lines === 'number', '⑰ 元信息含坏行计数')
    } else {
      assert(false, '⑰ 应导出 readTraceEntriesDetailed（元信息入口，避免客户端再写一份）')
    }
  }

  // ── ⑱ 坏行：跳过并计数，不影响其余行 ──
  {
    const dir = freshState('badlines')
    const tr = await loadTrace()
    process.env.MALONG_TRACE = 'all'
    writeFileSync(join(dir, 'malong-trace.jsonl'),
      JSON.stringify({ v: 1, ts: new Date().toISOString(), tool: 'good1', phase: 'started' }) + '\n' +
      '{ not json at all\n' +
      '\n' +
      JSON.stringify({ v: 1, ts: new Date().toISOString(), tool: 'good2', phase: 'started' }) + '\n')
    const d = tr.readTraceEntriesDetailed({ limit: 100 })
    assert(d.entries.length === 2, `⑱ 坏行跳过、好行保留（得 ${d.entries.length}）`)
    assert(d.malformed_lines === 1, `⑱ 坏行被计数（得 ${d.malformed_lines}）`)
  }

  // ── ⑲ 时间窗过滤属于聚合层的职责，读取层只给 since 参数 ──
  {
    const dir = freshState('since')
    const tr = await loadTrace()
    process.env.MALONG_TRACE = 'all'
    const now = Date.now()
    writeFileSync(join(dir, 'malong-trace.jsonl'),
      JSON.stringify({ v: 1, ts: new Date(now - 30 * 86400_000).toISOString(), tool: 'old', phase: 'started' }) + '\n' +
      JSON.stringify({ v: 1, ts: new Date(now - 1000).toISOString(), tool: 'new', phase: 'started' }) + '\n')
    const all = tr.readTraceEntriesDetailed({ limit: 100 })
    assert(all.entries.length === 2, `⑲ 不过滤时两条都在（得 ${all.entries.length}）`)
    const recent = tr.readTraceEntriesDetailed({ limit: 100, sinceMs: now - 7 * 86400_000 })
    assert(recent.entries.length === 1, `⑲ sinceMs 只留近期（得 ${recent.entries.length}）`)
    assert(recent.entries[0]?.tool === 'new', '⑲ 留下的是新那条')
  }

  // ── ⑳ 轨迹必须写在自己的子目录里，不得与用户的状态文件混放 ──
  // 背景（用户在 2026-10-30 明确要求）：原来轨迹直接写在 stateDir 根下，跟
  // code-index/workspaces/entry-tasks/malong-feedback.jsonl 摆在同一层。
  // 两个后果：① 用户的产物目录被轨迹污染；② 想“清掉轨迹”就容易写成宽匹配
  // rm 而误删别的状态文件。现在固定到 <stateDir>/trace/ 下。
  {
    const dir = freshState('ownsubdir')
    const tr = await loadTrace()
    process.env.MALONG_TRACE = 'all'
    tr.traceStarted({ tool: 'subdir_probe', callId: 'c-sub' })
    assert(existsSync(join(dir, 'trace')), '⑳ 轨迹目录 <stateDir>/trace/ 被创建')
    assert(existsSync(join(dir, 'trace', 'malong-trace.jsonl')), '⑳ 轨迹文件在 trace/ 子目录内')
    assert(!existsSync(join(dir, 'malong-trace.jsonl')), '⑳ 不得再写 stateDir 根目录（旧位置）')
    // 计数器也要进子目录，不能默认躺在 stateDir 根（否则“删轨迹”仍会漏删/误删）
    assert(!existsSync(join(dir, 'malong-trace-counters.json')), '⑳ 计数器不得留在 stateDir 根（旧位置）')
  }

  // ── ㉑ off 时连 trace/ 目录都不建（零 IO 不变）──
  {
    const dir = freshState('offnodir')
    process.env.MALONG_TRACE = 'off'
    const tr = await loadTrace()
    tr.traceStarted({ tool: 'off_probe', callId: 'c-off' })
    tr.traceFinished({ tool: 'off_probe', callId: 'c-off', latencyMs: 1, summary: { outcome: 'ok' } })
    const s = tr.traceStats()
    assert(s.mode === 'off' && s.files === 0, '㉑ off 时 files=0')
    assert(!existsSync(join(dir, 'trace')), '㉑ off 时连 trace/ 目录都不创建（零 IO）')
  }

  // ── ㉒ 旧位置的历史轨迹：读得到、并且能在开启时搬进新目录 ──
  {
    const dir = freshState('legacy')
    const tr = await loadTrace()
    // 用户上一版留下的旧文件（在 stateDir 根）
    const legacy = JSON.stringify({ v: 1, ts: new Date().toISOString(), tool: 'legacy_tool', phase: 'started' }) + '\n'
    writeFileSync(join(dir, 'malong-trace.jsonl'), legacy)
    writeFileSync(join(dir, 'malong-trace.jsonl.1'), JSON.stringify({ v: 1, ts: new Date().toISOString(), tool: 'legacy_rot', phase: 'started' }) + '\n')

    // ① 只读（不开启）：历史仍读得到，且不制造新文件
    process.env.MALONG_TRACE = 'off'
    const beforeTools = tr.readTraceEntriesDetailed({ limit: 100 }).entries.map(e => e.tool).sort()
    assert(beforeTools.includes('legacy_tool') && beforeTools.includes('legacy_rot'), `㉒ off 时旧位置历史仍可读（得 ${beforeTools.join(',')}）`)
    assert(!existsSync(join(dir, 'trace')), '㉒ off 读取旧文件不创建 trace/ 目录')

    // ② 开启后写入 → 旧文件被搬进 trace/，不丢历史
    process.env.MALONG_TRACE = 'all'
    tr.traceStarted({ tool: 'new_after_migrate', callId: 'c-mig' })
    const afterTools = tr.readTraceEntriesDetailed({ limit: 200 }).entries.map(e => e.tool)
    assert(afterTools.includes('new_after_migrate'), '㉒ 新写入正常')
    assert(afterTools.includes('legacy_tool'), '㉒ 迁移后旧历史不丢')
    assert(afterTools.includes('legacy_rot'), '㉒ 迁移后旧轮转档不丢')
    assert(!existsSync(join(dir, 'malong-trace.jsonl')), '㉒ 旧位置文件已移走（不再双写）')
    assert(existsSync(join(dir, 'trace', 'malong-trace.jsonl')), '㉒ 新位置有主文件')
  }

  // ── ㉔ 迁移失败不得砸坏写入：trace/ 位置被一个文件占着 ──
  // 现实场景：用户手动改过目录结构、或权限/磁盘异常。
  // 硬约束（专家 §5-C）：轨迹的任何 IO 失败都不得改变工具结果。
  {
    const dir = freshState('migfail')
    const tr = await loadTrace()
    process.env.MALONG_TRACE = 'all'
    // 旧位置有历史，但新目录位置被普通文件占住，mkdir 必失败
    writeFileSync(join(dir, 'malong-trace.jsonl'), JSON.stringify({ v: 1, ts: new Date().toISOString(), tool: 'legacy_keep', phase: 'started' }) + '\n')
    writeFileSync(join(dir, 'trace'), 'not a directory')

    let threw = null
    let r
    try { r = tr.traceStarted({ tool: 'blocked_probe', callId: 'c-blocked' }) } catch (e) { threw = e }
    assert(threw === null, `㉔ 写入路径不得抛异常（实际抛了 ${threw && threw.message}）`)
    assert(r && r.written === false, `㉔ 写不进去时如实报 written=false（得 ${JSON.stringify(r)}）`)
    // 旧历史不得被“迁移成功”的假象掩盖，也不能丢
    assert(existsSync(join(dir, 'malong-trace.jsonl')), '㉔ 迁移失败时旧文件仍在原处（不丢历史）')
    const st = tr.traceStats()
    assert(st.write_failed >= 1, `㉔ 写失败被计数（得 ${st.write_failed}）`)
    assert(Array.isArray(st.legacy_files) && st.legacy_files.includes('malong-trace.jsonl'), `㉔ 统计里点名旧位置残留（得 ${JSON.stringify(st.legacy_files)}）`)
  }

  // ── ㉕ 新目录只剩轮转档、旧位置还有主文件：必须整目录读新的，不得混读 ──
  // 跨目录拼数据会让“同一次会话”的记录被拆到两个目录，聚合统计也就不成立了。
  {
    const dir = freshState('dirmix')
    const tr = await loadTrace()
    process.env.MALONG_TRACE = 'all'
    mkdirSync(traceDirOf(dir), { recursive: true })
    writeFileSync(join(traceDirOf(dir), 'malong-trace.jsonl.1'), JSON.stringify({ v: 1, ts: new Date().toISOString(), tool: 'new_rot', phase: 'started' }) + '\n')
    writeFileSync(join(dir, 'malong-trace.jsonl'), JSON.stringify({ v: 1, ts: new Date().toISOString(), tool: 'old_main', phase: 'started' }) + '\n')
    const got = tr.readTraceEntriesDetailed({ limit: 50 })
    const tools = got.entries.map(e => e.tool)
    assert(tools.includes('new_rot'), `㉕ 新目录轮转档被读到（得 ${tools.join(',')}）`)
    assert(!tools.includes('old_main'), '㉕ 不得把旧位置主文件混进来（否则同一会话被拆成两个目录）')
    assert(got.legacy_files.includes('malong-trace.jsonl'), '㉕ 混放情形仍提示旧位置残留')
  }

  // ── ㉖ 统计必须报出真实目录，否则用户按提示找不到文件 ──
  {
    const dir = freshState('statdir')
    const tr = await loadTrace()
    process.env.MALONG_TRACE = 'all'
    tr.traceStarted({ tool: 'dir_probe', callId: 'c-dir' })
    const st = tr.traceStats()
    assert(st.dir === traceDirOf(dir), `㉖ 统计报 <stateDir>/trace（得 ${st.dir}）`)
    assert(st.files === 1, `㉖ 统计只数新目录里的文件（得 ${st.files}）`)
  }

  // ── ⑨ 有界：档数不超上限 ──
  {
    const dir = freshState('bounded')
    const tr = await loadTrace()
    // 造出 3 个历史档 + 主文件
    for (let i = 1; i <= 3; i++) writeFileSync(join(dir, `malong-trace.jsonl.${i}`), '{"v":1}\n')
    writeFileSync(join(dir, 'malong-trace.jsonl'), JSON.stringify({ v: 1, ts: new Date().toISOString(), tool: 'x', phase: 'started' }).repeat(1) + '\n')
    const st = tr.traceStats()
    assert(st.max_rotations === 3, `⑨ 档数上限 3（得 ${st.max_rotations}）`)
    assert(st.max_bytes_per_file === 4 * 1024 * 1024, `⑨ 单文件上限 4MB（得 ${st.max_bytes_per_file}）`)
    assert(st.files <= 4, `⑨ 文件数有界（得 ${st.files}）`)
  }

  // ── ⑧ 写失败不改变工具结果 + 计数可见 ──
  {
    const dir = freshState('writefail')
    // 让轨迹路径变成目录 → append 必失败
    mkdirSync(join(dir, 'malong-trace.jsonl'), { recursive: true })
    writeFileSync(join(dir, 'malong-trace.jsonl', 'block'), 'x')
    const tr = await loadTrace()
    let threw = false
    let r
    try { r = tr.traceStarted({ tool: 'code_read', callId: 'c-fail' }) } catch { threw = true }
    assert(!threw, '⑧ traceEvent 不得抛异常（写日志失败不能改变工具结果）')
    assert(r && r.written === false, `⑧ 失败时 written=false（得 ${JSON.stringify(r)}）`)
    const st = tr.traceStats()
    assert(st.write_failed >= 1, `⑧ write_failed 计数可见（得 ${st.write_failed}）`)
    assert(typeof st.last_error === 'string', '⑧ last_error 有界可见')
  }

  // ── ⑭ 写类工具的三态提取：effect/state_commit 在 observation 层（试用实测形状）──
  // 背景：2026-10-30 真机试用发现，所有写类工具（code_patch/code_batch/code_maintain）
  // 把 effect/committed/receipt 放在 result.observation 下，顶层没有。旧实现只查
  // result.effect ?? result.receipt?.effect → 写路径全部退化为 unknown，
  // 于是「写入但未验证」这个核心信号恒为 0（假绿）。
  {
    const tr = await loadTrace()
    // 实采形状（code_patch 真实返回）：顶层无 effect，observation 下有
    const realWrite = {
      ok: true, result_kind: 'partial',
      observation: { effect: 'workspace_write', committed: true, result_kind: 'partial' },
    }
    let s = tr.summarizeToolResult(realWrite)
    assert(s.effect === 'workspace_write', `⑭ 写路径 effect 取到（得 ${s.effect}）`)
    assert(s.state_commit === 'committed', `⑭ committed:true → state_commit=committed（得 ${s.state_commit}）`)
    assert(s.verification === 'not_run', '⑭ 写成功不得自动变成 verified')

    // committed:false → not_attempted（不能用 committed 一词冒充成功）
    s = tr.summarizeToolResult({ observation: { effect: 'workspace_write', committed: false } })
    assert(s.state_commit === 'not_attempted', `⑭ committed:false → not_attempted（得 ${s.state_commit}）`)

    // 顶层优先：顶层与 observation 冲突时以顶层为准
    s = tr.summarizeToolResult({ effect: 'read_only', observation: { effect: 'workspace_write' } })
    assert(s.effect === 'read_only', `⑭ 顶层 effect 优先（得 ${s.effect}）`)

    // 脏值不得透传（白名单）
    s = tr.summarizeToolResult({ observation: { effect: '/home/chen/evil', state_commit: 'yes' } })
    assert(s.effect === 'unknown', `⑭ 非白名单 effect 收敛为 unknown（得 ${s.effect}）`)

    // 只读工具：保持 unknown，不臆造 read_only
    s = tr.summarizeToolResult({ ok: true, observation: { summary: 'x' } })
    assert(s.effect === 'unknown' && s.state_commit === 'unknown', '⑭ 只读工具不臆造 effect/state_commit')

    // 但「工具明说自己只读」是依据，不是臆造（2026-11-01 P3 首次开采集实测：
    // code_query 返回 boundaries.read_only=true，却被记成 effect=unknown——
    // 于是 13 个只读工具在轨迹里整列失效）
    s = tr.summarizeToolResult({ ok: true, boundaries: { read_only: true }, count: 0 })
    assert(s.effect === 'read_only', `⑭ boundaries.read_only=true → read_only（得 ${s.effect}）`)
    s = tr.summarizeToolResult({ ok: true, observation: { boundaries: { read_only: true } } })
    assert(s.effect === 'read_only', `⑭ observation.boundaries.read_only=true 也认（得 ${s.effect}）`)
    s = tr.summarizeToolResult({ effect: 'workspace_write', boundaries: { read_only: true } })
    assert(s.effect === 'workspace_write', `⑭ 显式 effect 优先于只读声明（得 ${s.effect}）`)
    s = tr.summarizeToolResult({ ok: true, boundaries: { read_only: false } })
    assert(s.effect === 'unknown', `⑭ read_only 声明不为 true 时不得臆造（得 ${s.effect}）`)

    // readback_verified 在 observation 层也要认到
    s = tr.summarizeToolResult({ observation: { readback_verified: true, effect: 'workspace_write' } })
    assert(s.verification === 'verified', `⑭ observation.readback_verified=true → verified（得 ${s.verification}）`)
    s = tr.summarizeToolResult({ observation: { readback_verified: false } })
    assert(s.verification === 'failed', `⑭ observation.readback_verified=false → failed（得 ${s.verification}）`)
  }

  // ── ⑮ dropped 必须是真计数，不能是恒 0 的死字段 ──
  // 背景（2026-10-30 自用试用）：`dropped` 与 `COUNTER_FILE` 声明了却从无写入点，
  // 于是 health(stats).trace.dropped 永远是 0。这比没有这个字段更坏——
  // 它会让人以为「从不丢事件」。本轮把写入失败的丢弃真正计上并持久化。
  {
    const tr = await loadTrace()
    const dir = freshState('dropcount')
    process.env.MALONG_TRACE = 'all'
    // 先记下基准值（前面的 ⑧ 段已经触发过写失败，计数器会跨段累计，不能假设为 0）
    const base = tr.traceStats()
    // 让主轨迹路径变成目录 → 每次 append 都失败
    mkdirSync(join(dir, 'malong-trace.jsonl'), { recursive: true })
    tr.traceStarted({ tool: 'drop_probe_a', callId: 'c-d1' })
    tr.traceStarted({ tool: 'drop_probe_b', callId: 'c-d2' })
    const st1 = tr.traceStats()
    assert(st1.dropped >= base.dropped + 2, `⑮ 两次写失败 → dropped 增 2（基准 ${base.dropped}，得 ${st1.dropped}）`)
    assert(st1.write_failed >= base.write_failed + 2, `⑮ write_failed 同步计数（基准 ${base.write_failed}，得 ${st1.write_failed}）`)
    // dropped 必须真的跟 write_failed 连动，不能是恒 0 或恒等于某个定值
    assert(st1.dropped > 0, '⑮ dropped 不再是死字段')
    assert(st1.dropped === st1.write_failed || st1.dropped <= st1.write_failed, `⑮ dropped 不应超过写入失败数（dropped=${st1.dropped}, write_failed=${st1.write_failed}）`)
  }

  // ── ⑯ 计数要落盘：换进程还能看到（否则重启就归零，"从不丢"的错觉重来）──
  {
    const { writeFileSync } = await import('node:fs')
    const dir = freshState('counterpersist')
    process.env.MALONG_TRACE = 'all'
    mkdirSync(mainTraceOf(dir), { recursive: true })
    const tr = await loadTrace()
    tr.traceStarted({ tool: 'persist_probe', callId: 'c-p1' })
    // 计数器文件应已落盘（名字固定，内容含累计值）
    const cf = join(traceDirOf(dir), 'malong-trace-counters.json')
    assert(existsSync(cf), '⑯ 计数器文件落盘（重启后不归零）')
    if (existsSync(cf)) {
      const raw = JSON.parse(readFileSync(cf, 'utf8'))
      assert(typeof raw.write_failed === 'number' && raw.write_failed >= 1, `⑯ 落盘内容含 write_failed（得 ${JSON.stringify(raw)}）`)
    }
  }

  // ── ⑫ next_action 只取工具名（不得带 args/note/绝对路径）──
  {
    const tr = await loadTrace()
    // 三种已知形态都能取到工具名
    assert(tr.extractSuggestedTool({ next_action: { tool: 'code_read', args: { workspace_dir: '/home/chen/x' } } }) === 'code_read', '⑫ top-level next_action 取到工具名')
    assert(tr.extractSuggestedTool({ extra: { next_action: { tool: 'code_batch', args: { writes: [] } } } }) === 'code_batch', '⑫ extra.next_action 取到工具名')
    assert(tr.extractSuggestedTool({ navigation: { next_action: { tool: 'read_symbol', params: {} } } }) === 'read_symbol', '⑫ navigation.next_action 取到工具名')
    // 只给 next_step 纯文本 → 不得猜出工具名（自由文本里可能有路径）
    assert(tr.extractSuggestedTool({ next_step: 'Read /home/chen/x/a.js then edit' }) === null, '⑫ 只有自由文本 next_step 时不提取（防路径泄漏）')
    // 非法/恶意 tool 值一律不取
    assert(tr.extractSuggestedTool({ next_action: { tool: '/home/chen/evil' } }) === null, '⑫ tool 值含路径 → 拒绝')
    assert(tr.extractSuggestedTool({ next_action: { tool: 'code_read; rm -rf /' } }) === null, '⑫ tool 值含命令 → 拒绝')
    assert(tr.extractSuggestedTool({ next_action: null }) === null, '⑫ null 不报错')
    assert(tr.extractSuggestedTool(null) === null, '⑫ 非对象不报错')
  }

  // ── ⑬ 按天数保留：超龄轮转档被清，未超龄保留 ──
  {
    process.env.MALONG_TRACE = 'all'
    const dir = freshState('age')
    const tr = await loadTrace()
    const { utimesSync } = await import('node:fs')
    const ancient = new Date(Date.now() - 20 * 86400_000)
    const recent = new Date(Date.now() - 2 * 86400_000)
    mkdirSync(traceDirOf(dir), { recursive: true })
    writeFileSync(join(traceDirOf(dir), 'malong-trace.jsonl.1'), '{"v":1}\n')
    utimesSync(join(traceDirOf(dir), 'malong-trace.jsonl.1'), ancient, ancient)
    writeFileSync(join(traceDirOf(dir), 'malong-trace.jsonl.2'), '{"v":1}\n')
    utimesSync(join(traceDirOf(dir), 'malong-trace.jsonl.2'), recent, recent)
    // 触发一次写入（rotateIfNeeded 会顺带做过期清理）
    tr.traceStarted({ tool: 'age_probe', callId: 'c-age' })
    assert(!existsSync(join(traceDirOf(dir), 'malong-trace.jsonl.1')), '㉓ 20 天前的轮转档被清（保留期 14 天）')
    assert(existsSync(join(traceDirOf(dir), 'malong-trace.jsonl.2')), '㉓ 2 天前的轮转档保留')
  }

  // ── ⑯ session 不再恒为 null（R16m）：没有会话 env 时按调用首尾时间近似 ──
  {
    process.env.MALONG_TRACE = 'all'
    const dir = freshState('sess')
    const tr = await loadTrace()
    // 宿主没给任何会话变量（opencode 实测就是这种情况：session 恒 null）
    const savedEnv = {
      oc: process.env.OPENCODE_SESSION, mc: process.env.MCP_SESSION_ID, si: process.env.SESSION_ID,
    }
    delete process.env.OPENCODE_SESSION
    delete process.env.MCP_SESSION_ID
    delete process.env.SESSION_ID
    try {
      // ① 显式传入的会话（宿主认得时）优先级最高，且仍是短哈希不落原文
      const byEnv = tr.ephemeralSessionId({ OPENCODE_SESSION: 'ses_abc123' })
      assert(typeof byEnv === 'string' && byEnv.startsWith('ephemeral-') && !byEnv.includes('abc123'),
        `⑯ 显式会话做短哈希、不落原文（得 ${byEnv}）`)
      assert(byEnv === tr.ephemeralSessionId({ MCP_SESSION_ID: 'ses_abc123' }),
        '⑯ OPENCODE_SESSION / MCP_SESSION_ID 同一原文得同一标识')

      // ② 没有任何会话变量 → 按“进程身份”兜底，且不再是 null
      // R16n（2026-11-02 审查发现）：原先按“小时桶”派生是错的。实测本机 6 个
      // mcp-server 进程分属 6 个**不同 workspace**（/home/chen、0bore、NAI2、
      // 1FTY-llm、mail、ANT-FTY），同一小时内启动就拿到同一个 sess- 标识，
      // 于是 triage 把跨 workspace 的调用当成“同一条链”——口径收紧反而制造新误报。
      const procId = tr.deriveSessionId({ pid: 1234, startMs: 1793585000123 })
      assert(typeof procId === 'string' && /^sess-[0-9a-f]{8}$/.test(procId),
        `⑯ 无会话变量时按进程派生 sess-xxxxxxxx（得 ${procId}）`)
      assert(procId === tr.deriveSessionId({ pid: 1234, startMs: 1793585000123 }),
        '⑯ 同进程同启动时刻 → 同一标识（稳定，不随机）')
      assert(procId !== tr.deriveSessionId({ pid: 5678, startMs: 1793585000123 }),
        '⑯ 同小时启动的不同进程必须不同（核心回归：跨 workspace 不得混为一谈）')
      assert(procId !== tr.deriveSessionId({ pid: 1234, startMs: 1793589999999 }),
        '⑯ 同 pid 重启后必须不同（重启 = 新会话段）')
      // 什么参数都不给也不得抛错、不得返回 null
      const noArg = tr.deriveSessionId()
      assert(typeof noArg === 'string' && /^sess-[0-9a-f]{8}$/.test(noArg), `⑯ 无参数也不得为 null（得 ${noArg}）`)
      assert(typeof tr.deriveSessionId({ pid: 'abc', startMs: 'not-a-date' }) === 'string',
        '⑯ 非法 pid / 时间戳不得抛错')

      // ③ 真写入：无 env 时 started/finished 的 session 必须是同一个 derived 值
      tr.traceStarted({ tool: 'code_read', callId: 'c-sess' })
      tr.traceFinished({ tool: 'code_read', callId: 'c-sess', latencyMs: 5, summary: { outcome: 'ok' } })
      const lines = readMain(dir).trim().split('\n').map(l => JSON.parse(l))
      const st = lines.find(l => l.phase === 'started')
      const fi = lines.find(l => l.phase === 'finished')
      assert(st && fi, '⑯ started/finished 都在（前置）')
      assert(st && st.session && st.session !== null, `⑯ 有会话变量缺失时 session 不得为 null（得 ${st && st.session}）`)
      assert(st && fi && st.session === fi.session, '⑯ 同一调用链的 started/finished 会话一致')
      assert(st && /^sess-[0-9a-f]{8}$/.test(String(st.session)), `⑯ 兜底会话形态 sess-xxxxxxxx（得 ${st && st.session}）`)

      // ④ 同一进程重复加载模块，session 不得变（R16n 修正）
      // 旧实现用「模块加载时刻」当进程启动时刻，于是模块被重新加载时
      // （缓存带 query / 热更新 / 测试动态 import）同一进程会算出多个 session，
      // 本属同一段的调用被拆开，聚合就错了一半。
      // 用公开 API 验（各写一条轨迹、比盘上的 session），不给生产模块加测试专用导出。
      const sdir = freshState('sessstable')
      process.env.MALONG_TRACE = 'all'
      const m1 = await loadTrace()
      m1.traceStarted({ tool: 'code_read', callId: 'c-mod1' })
      await new Promise(r => setTimeout(r, 1100))   // 刻意跨过 1 秒，排除取整巧合
      const m2 = await loadTrace()
      m2.traceStarted({ tool: 'code_read', callId: 'c-mod2' })
      const recs = readMain(sdir).trim().split('\n').map(l => JSON.parse(l))
      const byId = (id) => recs.find(r => r.call_id === id)?.session
      assert(byId('c-mod1') && byId('c-mod2'), `⑯ 两次写入都在盘上（前置；得 ${recs.length} 条）`)
      assert(byId('c-mod1') === byId('c-mod2'),
        `⑯ 同一进程重新加载模块后 session 不变（得 ${byId('c-mod1')} vs ${byId('c-mod2')}）`)
    } finally {
      if (savedEnv.oc !== undefined) process.env.OPENCODE_SESSION = savedEnv.oc
      if (savedEnv.mc !== undefined) process.env.MCP_SESSION_ID = savedEnv.mc
      if (savedEnv.si !== undefined) process.env.SESSION_ID = savedEnv.si
    }
  }

  // ── ⑪ 工具数不变（轨迹不新增 MCP 工具）──
  {
    const reg = await import(pathToFileURL(join(root, 'tool-registry.js')).href)
    const R = reg.default
    const r = new R(join(root, 'tools'), { usagePath: join(tmpdir(), `trace-tools-${process.pid}.jsonl`) })
    await r.loadAll?.()
    const snapPath = join(root, 'contracts', 'classic-44.contract.json')
    if (existsSync(snapPath)) {
      const snap = JSON.parse(readFileSync(snapPath, 'utf-8'))
      const names = Object.keys(snap.tools || {})
      assert(names.length === 44, `⑪ 冻结合同仍 44 工具（得 ${names.length}）`)
      assert(!names.includes('trace'), '⑪ 轨迹没有变成 MCP 工具')
    }
  }
} finally {
  if (saved.trace === undefined) delete process.env.MALONG_TRACE
  else process.env.MALONG_TRACE = saved.trace
  if (saved.state === undefined) delete process.env.MALONG_STATE_DIR
  else process.env.MALONG_STATE_DIR = saved.state
  if (saved.home === undefined) delete process.env.HOME
  else process.env.HOME = saved.home
  for (const d of created) { try { rmSync(d, { recursive: true, force: true }) } catch {} }
}

console.log(`\n== test-trace-v0: ${pass} passed, ${fail} failed ==`)
if (fail > 0) process.exitCode = 1
