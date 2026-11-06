// test-trace-triage.js — scripts/trace-triage.mjs 只读聚合的口径正确性
//
// 背景（2026-10-30 真机试用）：triage 此前完全没有测试，试用中发现两条口径缺陷，
// 都是「统计数字看起来正常但实际无意义」这一类：
//   ① 末条调用永远被算成「建议 next_action 未被采纳」——后面没有下一条可比，
//      把「无后续」当「未采纳」，每个会话/时间窗固定多报 1 条假阳性。
//   ② 写路径 effect/state_commit 恒为 unknown（trace.js 形状坑，已在他处修），
//      导致「写入但未验证」恒为 0——本测试用真实写路径形状锁住该信号。
//
// 本测试只 spawn 那个只读脚本，不写轨迹、不联网、不起服务。

import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(ROOT, 'scripts', 'trace-triage.mjs')

let passed = 0
let failed = 0
function assert(cond, msg) {
  if (cond) { passed++ } else { failed++; console.error(`FAIL: ${msg}`) }
}

// 轨迹在 <stateDir>/trace/ 下（2026-10-30 起）。
// 测试必须往“真实写入位置”造数据：继续写 stateDir 根只能测到迁移回退路径。
const traceDirOf = (dir) => join(dir, 'trace')
function ensureTraceDir(dir) {
  mkdirSync(traceDirOf(dir), { recursive: true })
  return traceDirOf(dir)
}

const now = Date.now()
const iso = (offsetMs) => new Date(now - offsetMs).toISOString()

function runTriage(dir, extraArgs = ['--json', '--days', '14']) {
  const r = spawnSync(process.execPath, [SCRIPT, ...extraArgs], {
    env: { ...process.env, MALONG_STATE_DIR: dir, MALONG_TRACE: 'all' },
    encoding: 'utf8',
  })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

function withTrace(records, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'triage-'))
  try {
    writeFileSync(join(ensureTraceDir(dir), 'malong-trace.jsonl'), records.map(r => JSON.stringify(r)).join('\n') + '\n')
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ── ① 末条不得被算成「建议未采纳」（核心回归）──
{
  // 三条调用：task→read→patch。前两条各自的后继都符合/不符合建议，末条无后继。
  // 期望：只有「read 建议 code_status 实际调 code_patch」这 1 条真实未采纳。
  const records = [
    { v: 1, ts: iso(30000), tool: 'code_task', phase: 'started', call_id: 'c1' },
    { v: 1, ts: iso(29000), tool: 'code_task', phase: 'finished', call_id: 'c1', latency_ms: 10, outcome: 'ok', effect: 'unknown', state_commit: 'unknown', verification: 'not_run', next_action: 'code_read' },
    { v: 1, ts: iso(20000), tool: 'code_read', phase: 'started', call_id: 'c2' },
    { v: 1, ts: iso(19000), tool: 'code_read', phase: 'finished', call_id: 'c2', latency_ms: 10, outcome: 'ok', effect: 'unknown', state_commit: 'unknown', verification: 'not_run', next_action: 'code_status' },
    { v: 1, ts: iso(10000), tool: 'code_patch', phase: 'started', call_id: 'c3' },
    { v: 1, ts: iso(9000), tool: 'code_patch', phase: 'finished', call_id: 'c3', latency_ms: 10, outcome: 'ok', effect: 'workspace_write', state_commit: 'committed', verification: 'not_run', next_action: 'code_check' },
  ]
  withTrace(records, (dir) => {
    const { code, out, err } = runTriage(dir)
    assert(code === 0, `① triage 退出码 0（得 ${code}；stderr=${err.slice(0, 200)}）`)
    let j = null
    try { j = JSON.parse(out) } catch { /* 下面断言会报 */ }
    assert(j !== null, '① 输出为合法 JSON')
    if (!j) return
    // R21-F07：signals 改为 { count, items } —— count 是真实总数，items 是最多 20 条样本
    const sig = j.signals?.suggested_next_action_not_taken || {}
    const notTaken = Array.isArray(sig) ? sig : (sig.items || [])
    const notTakenCount = Array.isArray(sig) ? sig.length : (sig.count ?? -1)
    assert(notTakenCount === 1, `① 只报 1 条真实未采纳（末条不计；实得 count=${notTakenCount}：${JSON.stringify(sig)}）`)
    assert(notTaken.length === 1, `① items 也应为 1 条（实得 ${notTaken.length}）`)
    assert(notTaken[0]?.tool === 'code_read', `① 命中的是中间那条 code_read（实得 ${notTaken[0]?.tool}）`)
    assert(!notTaken.some(x => x.tool === 'code_patch'), '① 末条 code_patch 不得被计入')
  })
}

// ── ①b R21-F07：「未采纳」超过 20 条时必须报真实总数，不能被 slice 截成 20 ──
// 背景：旧实现只留 slice(0,20) 样本，打印用 .length → 超过 20 恒显示 20。
// 自用实测两个池都显示 20，真实值却是 66 与 192，严重程度完全看不出来。
{
  const N = 25
  const records = []
  // 造 25 组「建议 code_status、实际 code_patch」的相邻调用
  for (let i = 0; i < N; i++) {
    const base = 100000 - i * 1000
    records.push({ v: 1, ts: iso(base), tool: 'code_read', phase: 'started', call_id: 's' + i })
    records.push({ v: 1, ts: iso(base - 100), tool: 'code_read', phase: 'finished', call_id: 's' + i, latency_ms: 5, outcome: 'ok', effect: 'unknown', state_commit: 'unknown', verification: 'not_run', next_action: 'code_status' })
    records.push({ v: 1, ts: iso(base - 200), tool: 'code_patch', phase: 'started', call_id: 'p' + i })
    records.push({ v: 1, ts: iso(base - 300), tool: 'code_patch', phase: 'finished', call_id: 'p' + i, latency_ms: 5, outcome: 'ok', effect: 'workspace_write', state_commit: 'committed', verification: 'not_run' })
  }
  withTrace(records, (dir) => {
    const { out } = runTriage(dir)
    const j = JSON.parse(out)
    const items = j.signals?.suggested_next_action_not_taken || []
    const counts = j.counts || {}
    assert(items.length === 20, `①b 样本最多 20 条（得 ${items.length}）`)
    assert(counts.suggested_next_action_not_taken >= 20,
      `①b counts 必须给出真实总数（得 ${counts.suggested_next_action_not_taken}）`)
    assert(counts.suggested_next_action_not_taken > items.length,
      `①b 真实总数必须能超过样本上限——否则「20」会冒充真实值（count=${counts.suggested_next_action_not_taken}, items=${items.length}）`)
  })
}

// ── ② 单条调用（无任何后继）不得产生任何「未采纳」──
{
  const records = [
    { v: 1, ts: iso(1000), tool: 'code_read', phase: 'started', call_id: 'c1' },
    { v: 1, ts: iso(900), tool: 'code_read', phase: 'finished', call_id: 'c1', latency_ms: 5, outcome: 'ok', effect: 'unknown', state_commit: 'unknown', verification: 'not_run', next_action: 'code_status' },
  ]
  withTrace(records, (dir) => {
    const { out } = runTriage(dir)
    const j = JSON.parse(out)
    const sig2 = j.signals?.suggested_next_action_not_taken || {}
    const c2 = Array.isArray(sig2) ? sig2.length : (sig2.count ?? -1)
    assert(c2 === 0, `② 单条调用不报「未采纳」（无后续可对照；实得 count=${c2}）`)
  })
}

// ── ③ 建议被采纳时不得误报 ──
{
  const records = [
    { v: 1, ts: iso(2000), tool: 'code_task', phase: 'started', call_id: 'c1' },
    { v: 1, ts: iso(1900), tool: 'code_task', phase: 'finished', call_id: 'c1', latency_ms: 5, outcome: 'ok', effect: 'unknown', state_commit: 'unknown', verification: 'not_run', next_action: 'code_read' },
    { v: 1, ts: iso(1000), tool: 'code_read', phase: 'started', call_id: 'c2' },
    { v: 1, ts: iso(900), tool: 'code_read', phase: 'finished', call_id: 'c2', latency_ms: 5, outcome: 'ok', effect: 'unknown', state_commit: 'unknown', verification: 'not_run', next_action: null },
  ]
  withTrace(records, (dir) => {
    const { out } = runTriage(dir)
    const j = JSON.parse(out)
    assert((j.signals?.suggested_next_action_not_taken || []).length === 0, '③ 采纳了建议（下一条就是 code_read）不误报')
  })
}

// ── ④ 「写入但未验证」信号必须能真出数（曾是恒 0 的假绿）──
{
  const records = [
    { v: 1, ts: iso(2000), tool: 'code_patch', phase: 'started', call_id: 'c1' },
    { v: 1, ts: iso(1900), tool: 'code_patch', phase: 'finished', call_id: 'c1', latency_ms: 5, outcome: 'ok', effect: 'workspace_write', state_commit: 'committed', verification: 'not_run', next_action: null },
  ]
  withTrace(records, (dir) => {
    const { out } = runTriage(dir)
    const j = JSON.parse(out)
    const w = j.signals?.writes_not_verified || []
    assert(w.length === 1, `④ 写入未验证能统计到（实得 ${w.length}）`)
    assert(j.totals?.writes === 1, `④ totals.writes 计为 1（实得 ${j.totals?.writes}）`)
  })
}

// ── ⑤ 已验证的写入不得算作「未验证」──
{
  const records = [
    { v: 1, ts: iso(2000), tool: 'code_patch', phase: 'started', call_id: 'c1' },
    { v: 1, ts: iso(1900), tool: 'code_patch', phase: 'finished', call_id: 'c1', latency_ms: 5, outcome: 'ok', effect: 'workspace_write', state_commit: 'committed', verification: 'verified', next_action: null },
  ]
  withTrace(records, (dir) => {
    const { out } = runTriage(dir)
    const j = JSON.parse(out)
    assert((j.signals?.writes_not_verified || []).length === 0, '⑤ verification=verified 不算未验证')
  })
}

// ── ⑥ 崩溃窗：只有 started 没有 finished ──
{
  const records = [
    { v: 1, ts: iso(2000), tool: 'reindex', phase: 'started', call_id: 'c1' },
  ]
  withTrace(records, (dir) => {
    const { out } = runTriage(dir)
    const j = JSON.parse(out)
    assert((j.signals?.unfinished_calls || []).length === 1, '⑥ 有开始无结果能被识别')
    assert(typeof j.mode_caveat === 'string' && j.mode_caveat.includes('不等于崩溃'), '⑥ 输出显式声明 errors 模式口径（孤儿 started ≠ 崩溃）')
  })
}

// ── ⑦ 版本冲突后未重读就继续 ──
{
  const records = [
    { v: 1, ts: iso(2000), tool: 'code_patch', phase: 'started', call_id: 'c1' },
    { v: 1, ts: iso(1900), tool: 'code_patch', phase: 'finished', call_id: 'c1', latency_ms: 5, outcome: 'version_conflict', effect: 'not_applied', state_commit: 'not_attempted', verification: 'not_run', error_code: 'VERSION_CONFLICT', next_action: null },
    { v: 1, ts: iso(1000), tool: 'code_patch', phase: 'started', call_id: 'c2' },
    { v: 1, ts: iso(900), tool: 'code_patch', phase: 'finished', call_id: 'c2', latency_ms: 5, outcome: 'ok', effect: 'workspace_write', state_commit: 'committed', verification: 'not_run', next_action: null },
  ]
  withTrace(records, (dir) => {
    const { out } = runTriage(dir)
    const j = JSON.parse(out)
    assert((j.signals?.version_conflict_without_reread || []).length === 1, '⑦ 冲突后直接再写能被识别')
  })
}

// ── ⑧ 冲突后先重读 → 不算 ──
{
  const records = [
    { v: 1, ts: iso(2000), tool: 'code_patch', phase: 'started', call_id: 'c1' },
    { v: 1, ts: iso(1900), tool: 'code_patch', phase: 'finished', call_id: 'c1', latency_ms: 5, outcome: 'version_conflict', effect: 'not_applied', state_commit: 'not_attempted', verification: 'not_run', error_code: 'VERSION_CONFLICT', next_action: null },
    { v: 1, ts: iso(1000), tool: 'code_read', phase: 'started', call_id: 'c2' },
    { v: 1, ts: iso(900), tool: 'code_read', phase: 'finished', call_id: 'c2', latency_ms: 5, outcome: 'ok', effect: 'unknown', state_commit: 'unknown', verification: 'not_run', next_action: null },
  ]
  withTrace(records, (dir) => {
    const { out } = runTriage(dir)
    const j = JSON.parse(out)
    assert((j.signals?.version_conflict_without_reread || []).length === 0, '⑧ 冲突后先重读不算违规')
  })
}

// ── ⑨ --days 时间窗过滤 ──
{
  const records = [
    { v: 1, ts: new Date(now - 30 * 86400_000).toISOString(), tool: 'reindex', phase: 'started', call_id: 'c-old' },
    { v: 1, ts: iso(1000), tool: 'reindex', phase: 'started', call_id: 'c-new' },
  ]
  withTrace(records, (dir) => {
    const narrow = JSON.parse(runTriage(dir, ['--json', '--days', '7']).out)
    const wide = JSON.parse(runTriage(dir, ['--json', '--days', '60']).out)
    assert(narrow.parsed === 1, `⑨ 7 天窗口只读到 1 条（实得 ${narrow.parsed}）`)
    assert(wide.parsed === 2, `⑨ 60 天窗口读到 2 条（实得 ${wide.parsed}）`)
    assert(narrow.signals.unfinished_calls.length === 1, '⑨ 窄窗口只留新记录')
    assert(wide.signals.unfinished_calls.length === 2, '⑨ 宽窗口两条都在')
  })
}

// ── ⑩ 坏行不炸：坏 JSON 行跳过并计数 ──
{
  const dir = mkdtempSync(join(tmpdir(), 'triage-'))
  try {
    writeFileSync(join(ensureTraceDir(dir), 'malong-trace.jsonl'),
      JSON.stringify({ v: 1, ts: iso(1000), tool: 'reindex', phase: 'started', call_id: 'c1' }) + '\n' +
      '{ this is not json\n' +
      '\n')
    const { code, out } = runTriage(dir)
    assert(code === 0, '⑩ 坏行不导致非零退出')
    const j = JSON.parse(out)
    assert(j.malformed_lines === 1, `⑩ 坏行被计数（实得 ${j.malformed_lines}）`)
    assert(j.parsed === 1, `⑩ 好行仍被解析（实得 ${j.parsed}）`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ── ⑪ 空目录：明确说「没有数据」，不能让 0 看起来像「采集了没数据」──
{
  const dir = mkdtempSync(join(tmpdir(), 'triage-'))
  try {
    const { code, out } = runTriage(dir)
    assert(code === 0, '⑪ 空目录退出码 0')
    const j = JSON.parse(out)
    assert(j.entries === 0, '⑪ entries=0')
    assert(typeof j.message === 'string' && j.message.length > 0, '⑪ 给出明确说明而不是静默 0')
    assert(!j.signals, '⑪ 无数据时不出 signals（避免 0 被当结论）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ── ⑫ 只读：跑完轨迹文件字节不得变化 ──
{
  const records = [
    { v: 1, ts: iso(1000), tool: 'reindex', phase: 'started', call_id: 'c1' },
  ]
  withTrace(records, (dir) => {
    const f = join(traceDirOf(dir), 'malong-trace.jsonl')
    const before = readFileSync(f, 'utf8')
    runTriage(dir)
    const after = readFileSync(f, 'utf8')
    assert(before === after, '⑫ triage 不修改轨迹文件（只读）')
  })
}

// ── ⑬ 文件集口径必须与 trace.js 权威读取一致（不得再分叉）──
// 2026-10-30：triage 曾自己实现文件发现（startsWith(BASE+'.')），把越界档 .4 与
// 外来后缀 .1.bak 也当成轨迹，同一份目录两边条数不同。现在必须走 readTraceEntriesDetailed。
{
  const dir = mkdtempSync(join(tmpdir(), 'triage-'))
  try {
    const rec = (tool) => JSON.stringify({ v: 1, ts: new Date().toISOString(), tool, phase: 'started' }) + '\n'
    const td = ensureTraceDir(dir)
    writeFileSync(join(td, 'malong-trace.jsonl'), rec('t_main'))
    writeFileSync(join(td, 'malong-trace.jsonl.1'), rec('t_rot1'))
    writeFileSync(join(td, 'malong-trace.jsonl.4'), rec('t_beyond'))       // 越界档：不算
    writeFileSync(join(td, 'malong-trace.jsonl.1.bak'), rec('t_stray'))   // 外来后缀：不算

    const { code, out } = runTriage(dir, ['--json', '--days', '3650'])
    assert(code === 0, '⑬ triage 退出码 0')
    const j = JSON.parse(out)
    assert(j.parsed === 2, `⑬ 只认主文件 + 合法轮转档（实得 ${j.parsed}：${(j.files || []).map(f => f.file).join(',')}）`)
    const names = (j.files || []).map(f => f.file)
    assert(names.includes('malong-trace.jsonl') && names.includes('malong-trace.jsonl.1'), '⑬ 含主文件与 .1')
    assert(!names.some(n => n.endsWith('.bak')), '⑬ 不得把 .bak 当轨迹')
    assert(!names.some(n => /\.[4-9]$/.test(n)), '⑬ 不得把越界档当轨迹')

    // 与权威读取逐条对齐：条数与文件集都要一样
    const { readTraceEntriesDetailed } = await import(pathToFileURL(join(ROOT, 'trace.js')).href)
    const prev = process.env.MALONG_STATE_DIR
    process.env.MALONG_STATE_DIR = dir
    const authoritative = readTraceEntriesDetailed({ limit: 2000, includeRotated: true, sinceMs: Date.now() - 3650 * 86400_000 })
    if (prev === undefined) delete process.env.MALONG_STATE_DIR; else process.env.MALONG_STATE_DIR = prev
    assert(j.parsed === authoritative.parsed, `⑬ 与权威读取条数一致（triage ${j.parsed} vs ${authoritative.parsed}）`)
    // 文件集也要逐项对齐（不只看条数：错把空文件算进来会让条数碰巧相等）
    const triageFiles = (j.files || []).map(f => f.file).sort().join(',')
    const authFiles = authoritative.files.map(f => f.file).sort().join(',')
    assert(triageFiles === authFiles, `⑬ 文件集逐项一致（triage [${triageFiles}] vs [${authFiles}]）`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ── ⑭ 旧位置残留必须点名，不得静默丢掉（升级后的历史消失是假绿）──
// 背景：轨迹 2026-10-30 搬到 <stateDir>/trace/。用户在旧版跑出的数据还在
// stateDir 根。triage 只读、不搬家，但它必须把“这些没算进来”说出来，
// 否则用户看到的是一份“很干净但少了一截”的报告。
{
  const dir = mkdtempSync(join(tmpdir(), 'triage-'))
  try {
    // 新位置有当前数据
    writeFileSync(join(ensureTraceDir(dir), 'malong-trace.jsonl'),
      JSON.stringify({ v: 1, ts: iso(1000), tool: 'reindex', phase: 'started', call_id: 'c-new' }) + '\n')
    // 旧位置还有升级前的历史
    writeFileSync(join(dir, 'malong-trace.jsonl.1'),
      JSON.stringify({ v: 1, ts: iso(3600_000), tool: 'chunk', phase: 'started', call_id: 'c-old' }) + '\n')

    const { code, out } = runTriage(dir)
    assert(code === 0, '⑭ 退出码 0')
    const j = JSON.parse(out)
    assert(Array.isArray(j.legacy_files) && j.legacy_files.includes('malong-trace.jsonl.1'), `⑭ 报告里点名旧位置文件名（得 ${JSON.stringify(j.legacy_files)}）`)
    assert(j.parsed === 1, `⑭ 旧位置不计入本次统计（得 ${j.parsed}）`)

    // 人读输出也要看得到，不能只给 JSON
    const human = runTriage(dir, ['--days', '14'])
    assert(/旧位置/.test(human.out), '⑭ 人读输出含旧位置提示')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ── ⑮ 报的目录必须是“真的读了哪个目录”，不是“应该写哪个目录”──
// 真机试用（2026-10-30）：只有旧位置有数据时，表头照样报 <stateDir>/trace。
// 用户照着表头去 ls 那个目录一无所获，却看到报告里有数据——
// 这比不报路径更坏：它把人指向一个空目录。
{
  const dir = mkdtempSync(join(tmpdir(), 'triage-'))
  try {
    // 只有旧位置有数据，trace/ 根本不存在
    writeFileSync(join(dir, 'malong-trace.jsonl'),
      JSON.stringify({ v: 1, ts: iso(1000), tool: 'reindex', phase: 'started', call_id: 'c-old' }) + '\n')

    const { code, out } = runTriage(dir, ['--json', '--days', '3650'])
    assert(code === 0, '⑮ 退出码 0')
    const j = JSON.parse(out)
    assert(j.parsed === 1, `⑮ 旧位置数据被读到（得 ${j.parsed}）`)
    assert(j.state_dir === dir, `⑮ state_dir 必须报实际读的目录（期望 ${dir}，实得 ${j.state_dir}）`)

    const human = runTriage(dir, ['--days', '3650'])
    // 只看表头那一行：提示文字里提到 trace/ 是正常的（它在告诉用户该去哪），
    // 但“本次统计目录 = ?”这个断言必须精确到表头，否则宽匹配会误判。
    const header = human.out.split('\n').find(l => l.startsWith('trace-triage')) || ''
    assert(header.includes(dir) && !header.includes(dir + '/trace'), `⑮ 表头报实际读的目录（得 ${header}）`)
    assert(/旧位置/.test(human.out), '⑮ 读旧位置时要说明这回事')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ── ⑯ 建议采纳只看「同一调用链 + 时间邻接」（R16m 口径收紧）──
// 旧口径：整窗里任何一条不按建议走都算一次未采纳。自用实测 20/33 —— 那个数字既不是
// “工具建议差”，也不是“我不听话”，而是“我同时开了好几条线程，下一条本来就不是它”。
// 新口径：session 相同 + 下一条在 120s 内，才算“同一调用链的下一次”。
{
  const mk = (ts, tool, callId, nextAction, session) => ({
    v: 1, ts, tool, call_id: callId, session, phase: 'finished', latency_ms: 10,
    outcome: 'ok', effect: 'unknown', state_commit: 'unknown', verification: 'not_run',
    next_action: nextAction,
  })

  // ④ 不同会话不该互相算：A 会话建议 code_read，但下一条是 B 会话的 code_patch
  {
    const records = [
      mk(iso(30000), 'code_task', 'a1', 'code_read', 'sess-aaaaaaaa'),
      mk(iso(29000), 'code_patch', 'b1', null, 'sess-bbbbbbbb'),
      mk(iso(20000), 'code_read', 'b2', null, 'sess-bbbbbbbb'),
    ]
    withTrace(records, (dir) => {
      const j = JSON.parse(runTriage(dir).out)
      const notTaken = j.signals?.suggested_next_action_not_taken || []
      assert(notTaken.length === 0, `④ 跨会话不误报（实得 ${notTaken.length}：${JSON.stringify(notTaken)}）`)
    })
  }

  // ⑤ 同会话但隔了 2 小时 → 不是“同一调用链的下一条”，不判
  {
    const records = [
      mk(iso(3 * 3600_000), 'code_task', 'a1', 'code_read', 'sess-aaaaaaaa'),
      mk(iso(1 * 3600_000), 'code_patch', 'a2', null, 'sess-aaaaaaaa'),
    ]
    withTrace(records, (dir) => {
      const j = JSON.parse(runTriage(dir).out)
      assert((j.signals?.suggested_next_action_not_taken || []).length === 0,
        '⑤ 同会话但超时间窗不判「未采纳」')
    })
  }

  // ⑥ 同会话 + 时间邻接 + 下一条不是建议 → 应当计数（收紧后仍要留下真信号）
  {
    const records = [
      mk(iso(20000), 'code_read', 'a1', 'code_status', 'sess-aaaaaaaa'),
      mk(iso(19000), 'code_patch', 'a2', null, 'sess-aaaaaaaa'),
    ]
    withTrace(records, (dir) => {
      const j = JSON.parse(runTriage(dir).out)
      const notTaken = j.signals?.suggested_next_action_not_taken || []
      assert(notTaken.length === 1, `⑥ 同链邻接的真未采纳仍计数（实得 ${notTaken.length}）`)
    })
  }
}

// ── ⑦ 交叉会话：真信号不得因为“全局相邻是别人”而丢掉（R16n 审查发现）──
// 旧实现在全局时间序上取 ordered[i+1] 再比 session，于是两个 workspace 交错时，
// A 会话的下一条总是 B 会话 → sameSession=false → 永远不判定。结果是**漏报**
// （真未采纳永远看不见），而不是误报——同样不能用。
// 正确口径：“同一调用链内的下一次” = **同 session 的下一条**，不是全局下一条。
{
  const mk3 = (ts, tool, callId, nextAction, session) => ({
    v: 1, ts, tool, call_id: callId, session, phase: 'finished', latency_ms: 10,
    outcome: 'ok', effect: 'unknown', state_commit: 'unknown', verification: 'not_run',
    next_action: nextAction,
  })
  // 时间顺序（旧→新）：a1(A 会话，建议 code_status) → b1(B 会话) → a2(A 会话，实际 code_patch)
  const records = [
    mk3(iso(30000), 'code_read', 'g-a1', 'code_status', 'sess-aaaaaaaa'),
    mk3(iso(20000), 'code_patch', 'g-b1', null, 'sess-bbbbbbbb'),
    mk3(iso(10000), 'code_patch', 'g-a2', null, 'sess-aaaaaaaa'),
  ]
  withTrace(records, (dir) => {
    const j = JSON.parse(runTriage(dir).out)
    const notTaken = j.signals?.suggested_next_action_not_taken || []
    assert(notTaken.length === 1,
      `⑦ 交叉会话时同会话的下一条仍要计入（实得 ${notTaken.length}：${JSON.stringify(notTaken)}）`)
    assert(notTaken[0]?.actual === 'code_patch', `⑦ 计入的是同会话那条（得 ${notTaken[0]?.actual}）`)
  })

  // 反向：两个会话各自内部都按建议走的时候，一条都不计
  const clean = [
    mk3(iso(40000), 'code_read', 'h-a1', 'code_read', 'sess-aaaaaaaa'),
    mk3(iso(30000), 'code_read', 'h-a2', null, 'sess-aaaaaaaa'),
    mk3(iso(20000), 'code_task', 'h-b1', 'code_read', 'sess-bbbbbbbb'),
    mk3(iso(10000), 'code_read', 'h-b2', null, 'sess-bbbbbbbb'),
  ]
  withTrace(clean, (dir) => {
    const j = JSON.parse(runTriage(dir).out)
    assert((j.signals?.suggested_next_action_not_taken || []).length === 0,
      '⑦ 各会话内部按建议走 → 一个都不计')
  })
}

console.log(`\n== test-trace-triage: ${passed} passed, ${failed} failed ==`)
process.exit(failed === 0 ? 0 : 1)
