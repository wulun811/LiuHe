#!/usr/bin/env node
// trace-triage.mjs — TRACE v0 只读聚合（专家 0.6.1 §4.2）
//
// 不联网、不写盘、不调 LLM、不起服务。只做一件事：
// 把本地 malong-trace.jsonl（含轮转档）聚合成专家点名的那几个信号。
//
// 用法：
//   node scripts/trace-triage.mjs                # 默认读 $MALONG_STATE_DIR 或 ~/.config/malong
//   node scripts/trace-triage.mjs --limit 2000
//   node scripts/trace-triage.mjs --days 7       # 只看最近 N 天（默认 14，与保留期一致）
//   node scripts/trace-triage.mjs --json         # 机器可读
// 目录解析全部交给 trace.js（getStateDir/traceDir），本脚本不再自己解析 env
import { readTraceEntriesDetailed, traceDir } from '../trace.js'
// P3：检索 MISS 由 search-log.js 提供，读取口径同样只有一份（readSearchMisses）
import { readSearchMisses, searchLogStats } from '../search-log.js'

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const limitIdx = args.indexOf('--limit')
const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) || 2000 : 2000
const daysIdx = args.indexOf('--days')
const days = daysIdx >= 0 ? Number(args[daysIdx + 1]) || 14 : 14
const sinceMs = Date.now() - days * 86400_000
const wantSearch = args.includes('--search')

// 报告目录由读取入口决定（trace.js 的 readTraceEntriesDetailed 会告诉实际读的是哪个）
// 此处不得自己推路径，否则“读旧位置、报新位置”就是假绿。

// 读取统一走 trace.js 的 readTraceEntriesDetailed——本脚本不得再写第二份读取。
// 2026-10-30：此前这里自己实现了一套（startsWith(BASE+'.') 认文件），与权威读取已经
// 读出不同结果：越界的 .4、外来的 .1.bak 都被当成了轨迹。同一份目录两边条数不一致，
// 任何基于它的结论都不可信。现在口径只有一份（见 trace.js 注释与 test-trace-v0 ⑰）。
function readAll() {
  return readTraceEntriesDetailed({ limit, includeRotated: true, sinceMs })
}


// 检索 MISS 聚合：只回答「哪类查询零命中」，不回答「命中率」（有命中的查询不在日志里）
function analyzeSearch() {
  const stats = searchLogStats()
  const { entries, total, bad_lines, files } = readSearchMisses({ limit: 5000, sinceMs })
  const byReason = {}
  const byAscii = { ascii: 0, cjk_only: 0 }
  const byHyp = { with_hypotheses: 0, without: 0 }
  const queries = new Map()
  for (const e of entries) {
    byReason[e.reason] = (byReason[e.reason] || 0) + 1
    if (e.has_ascii) byAscii.ascii++
    else byAscii.cjk_only++
    if ((e.search_terms || 0) > 0) byHyp.with_hypotheses++
    else byHyp.without++
    const q = String(e.query || '').slice(0, 120)
    queries.set(q, (queries.get(q) || 0) + 1)
  }
  const top = [...queries.entries()].sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1)).slice(0, 10)
  return {
    mode: stats.mode,
    collecting: stats.enabled,
    note: stats.note,
    files,
    total,
    in_window: entries.length,
    bad_lines,
    by_reason: byReason,
    by_ascii: byAscii,
    by_hypotheses: byHyp,
    top_queries: top.map(([query, count]) => ({ query, count })),
  }
}

function printSearch(s) {
  console.log('\n检索 MISS（MALONG_SEARCH_LOG=' + s.mode + '）')
  if (!s.collecting) {
    console.log('  ' + s.note)
    return
  }
  console.log('  files: ' + (s.files.join(' ') || '(none)') + '  entries: ' + s.total + '（窗口内 ' + s.in_window + '）  bad_lines: ' + s.bad_lines)
  console.log('  纯中文（无 ASCII 标识符）: ' + s.by_ascii.cjk_only + '   含标识符: ' + s.by_ascii.ascii)
  console.log('  没给 search_terms: ' + s.by_hypotheses.without + '   给了假设词: ' + s.by_hypotheses.with_hypotheses)
  const reasons = Object.entries(s.by_reason).map(([k, v]) => k + ':' + v).join('  ')
  if (reasons) console.log('  reason: ' + reasons)
  if (s.top_queries.length) {
    console.log('  高频 MISS：')
    for (const q of s.top_queries) console.log('    ' + q.count + '× ' + q.query)
  }
  console.log('  口径: 只在代码 0 命中时记录；有命中的查询不在表里，所以这里不能算命中率。')
}

function analyze(entries) {
  const byCall = new Map()
  for (const e of entries) {
    const k = e.call_id || `anon-${Math.random()}`
    if (!byCall.has(k)) byCall.set(k, { started: null, finished: null, tool: e.tool })
    const slot = byCall.get(k)
    if (e.phase === 'started') slot.started = e
    else slot.finished = e
    if (!slot.tool && e.tool) slot.tool = e.tool
  }

  const unfinished = []               // 有开始、无结果（真实崩溃窗）
  const versionConflictRetry = []     // 版本冲突后没重读就继续写
  const repeatedNoop = []             // 同一工具短时间内反复失败
  const suggestedNotFollowed = []     // 给了 next_action 但没调用
  const unverifiedWrites = []         // 写了但 verification=not_run

  const ordered = [...byCall.values()].sort((a, b) => {
    const ta = a.started?.ts || a.finished?.ts || ''
    const tb = b.started?.ts || b.finished?.ts || ''
    return ta.localeCompare(tb)
  })

  for (let i = 0; i < ordered.length; i++) {
    const c = ordered[i]
    if (c.started && !c.finished) unfinished.push({ tool: c.tool, ts: c.started.ts })
    const fin = c.finished
    if (!fin) continue
    if (fin.outcome === 'version_conflict' || fin.error_code === 'VERSION_CONFLICT') {
      const next = ordered[i + 1]
      const nextTool = next?.tool || next?.finished?.tool
      if (nextTool && nextTool !== 'code_read' && nextTool !== 'read_symbol' && nextTool !== 'code_query') {
        versionConflictRetry.push({ tool: fin.tool, next_tool: nextTool, ts: fin.ts })
      }
    }
    if (fin.effect === 'workspace_write' && fin.verification === 'not_run') {
      unverifiedWrites.push({ tool: fin.tool, ts: fin.ts, state_commit: fin.state_commit })
    }
    if (fin.next_action) {
      // 末条不得计入：后面根本没有「下一条」可比，把「无后续」当「未采纳」会让
      // 每个会话/时间窗都固定多记 1 条假阳性（实测 3 条调用报 2 条，其中 1 条就是这么来的）。
      //
      // R16m/R16n（2026-11-02）口径收紧：只有「同一会话 + 时间邻接」才算“这条建议的下一次调用”。
      // 旧口径把整窗里任意一条都当后继，自用实测 20/33——那个数字既不是“建议差”也不是
      // “用户不听话”，而是“我同时开了好几条线程，下一条本来就不是它”。
      //
      // R16n 修正：不能拿**全局**下一条去比 session。两个 workspace 交错时，
      // A 会话的下一条总是 B 会话 → 永远判不了 → 变成漏报（真未采纳永远看不见）。
      // 正确做法：先按 session 分组，在**同 session 内**取时间上的下一条。
      const SAME_CHAIN_MS = 120_000
      const sessOf = (x) => x?.finished?.session ?? x?.started?.session ?? null
      const finSess = fin.session ?? null
      // 同会话内的后继：session 缺失时退回全局顺序（兼容旧数据，行为与 R16m 一致）
      let next = null
      if (finSess == null) {
        next = ordered[i + 1] || null
      } else {
        for (let j = i + 1; j < ordered.length; j++) {
          if (sessOf(ordered[j]) === finSess) { next = ordered[j]; break }
        }
      }
      const nextTool = next?.tool || next?.finished?.tool
      const tFin = Date.parse(fin.ts || '')
      const tNext = Date.parse(next?.started?.ts || next?.finished?.ts || '')
      const adjacent = Number.isFinite(tFin) && Number.isFinite(tNext) && Math.abs(tNext - tFin) <= SAME_CHAIN_MS
      if (!next) { /* 无后续可对照 → 不判定，也不计入 */ }
      else if (!adjacent) { /* 跨时段 → 不是同一条链，不判定 */ }
      else if (nextTool !== fin.next_action) {
        suggestedNotFollowed.push({ tool: fin.tool, suggested: fin.next_action, actual: nextTool || null, ts: fin.ts })
      }
    }
  }

  // 同一工具 60s 内连续失败 ≥ 3 次
  let run = []
  for (const c of ordered) {
    const f = c.finished
    if (!f) continue
    const failed = f.outcome && f.outcome !== 'ok' && f.outcome !== 'success'
    if (!failed) { run = []; continue }
    run.push(f)
    if (run.length >= 3) {
      const first = Date.parse(run[0].ts)
      const last = Date.parse(run[run.length - 1].ts)
      if (Number.isFinite(first) && Number.isFinite(last) && last - first <= 60_000) {
        repeatedNoop.push({ tool: f.tool, count: run.length, window_ms: last - first })
        run = []
      }
    }
  }

  const totals = { calls: ordered.length, started: 0, finished: 0, unfinished: 0, errors: 0, writes: 0 }
  const byTool = {}
  for (const c of ordered) {
    if (c.started) totals.started++
    const f = c.finished
    if (f) {
      totals.finished++
      const t = (byTool[f.tool] ||= { calls: 0, errors: 0, writes: 0, unverified: 0 })
      t.calls++
      if (f.outcome && f.outcome !== 'ok' && f.outcome !== 'success') { totals.errors++; t.errors++ }
      if (f.effect === 'workspace_write') { totals.writes++; t.writes++ }
      if (f.effect === 'workspace_write' && f.verification === 'not_run') t.unverified++
    }
  }
  totals.unfinished = unfinished.length

  return {
    totals,
    by_tool: byTool,
    signals: {
      // 专家 §4.2 点名的六个复盘口径。
      // R21-F07（2026-11-05 自用试用实测）：旧实现只留 slice(0,20) 的样本数组，
      // 打印时用 .length —— 超过 20 就恒显示 20，读的人会以为「刚好 20 次」。
      // 实测两个池的 suggested_next_action_not_taken 都是 20（其实是上限），
      // 真实值分别是 20+ 与 20+，根本无法区分严重程度。
      // 现在每组保持【数组形状不变】（向后兼容既有调用方），
      // 另在顶层 counts 给出真实总数——数组仍是样本（最多 20 条）。
      unfinished_calls: unfinished.slice(0, 20),
      version_conflict_without_reread: versionConflictRetry.slice(0, 20),
      repeated_failed_calls_within_60s: repeatedNoop.slice(0, 20),
      writes_not_verified: unverifiedWrites.slice(0, 20),
      suggested_next_action_not_taken: suggestedNotFollowed.slice(0, 20),
    },
    counts: {
      // R21-F07：真实总数。以前只打印数组长度，超过 20 一律显示 20，
      // 实测两个池都是「20」，看不出实际是 66 与 192 的差别。
      unfinished_calls: unfinished.length,
      version_conflict_without_reread: versionConflictRetry.length,
      repeated_failed_calls_within_60s: repeatedNoop.length,
      writes_not_verified: unverifiedWrites.length,
      suggested_next_action_not_taken: suggestedNotFollowed.length,
    },
    note: 'READ-ONLY aggregate. No args/source/paths are recorded in traces, so this cannot leak code content.',
  }
}

const { files, entries, malformed_lines: bad, legacy_files: legacy, dir: readDir } = readAll()
// 报告的目录必须是**真的读了哪个目录**，不是“应该写哪个目录”。
// 真机试用（2026-10-30）：只有旧位置有数据时，表头照样报 <stateDir>/trace，
// 用户照着表头去 ls 那个目录一无所获，却看到报告里有数据——
// 这比不报路径更坏：它把人指向一个空目录。现在直接照抄读取入口的结果。
const stateDir = readDir || traceDir()
// 旧位置相关提示，分两种情形，都不能省：
//  a) 本次统计就是读的旧位置 → 不说明的话，用户不知道数据为什么不在 trace/ 里
//  b) 读的是新位置、但旧位置还有残留 → 不说明的话，报告“少了一截”也看不出来
const onLegacy = stateDir !== traceDir()
const legacyNote = [
  onLegacy
    ? `\n注意：本次统计读的是旧位置 ${stateDir}（轨迹尚未迁入 ${traceDir()}/）。`
      + `\n     开启 MALONG_TRACE 跑一次任意工具调用，旧历史会自动搬进新目录。`
    : '',
  Array.isArray(legacy) && legacy.length > 0
    ? `\n注意：旧位置还有 ${legacy.length} 个轨迹文件（${legacy.join(', ')}）未计入本次统计。`
      + `\n     开启 MALONG_TRACE 跑一次任意工具调用即会自动搬入 ${traceDir()}/。`
    : '',
].filter(Boolean).join('')
if (entries.length === 0) {
  const out = {
    ok: true,
    state_dir: stateDir,
    mode: process.env.MALONG_TRACE || 'off',
    files,
    legacy_files: legacy,
    entries: 0,
    ...(wantSearch ? { search_misses: analyzeSearch() } : {}),
    message: process.env.MALONG_TRACE && process.env.MALONG_TRACE !== 'off'
      ? 'Tracing is on but no events yet — run some tool calls first.'
      : 'Tracing is off (default). Set MALONG_TRACE=errors|all, restart the MCP host, then use the tools.',
  }
  console.log(asJson ? JSON.stringify(out, null, 2) : `${out.message}\nstate_dir: ${stateDir}${legacyNote}`)
  // 没有任何轨迹时也要能把「只有 MISS 日志」的情况看清楚
  if (!asJson && wantSearch) printSearch(out.search_misses)
  process.exit(0)
}
const report = { ok: true, state_dir: stateDir, files, legacy_files: legacy, parsed: entries.length, malformed_lines: bad, ...analyze(entries) }
if (wantSearch) report.search_misses = analyzeSearch()
// 专家 r16b 复审 §4.4：errors 模式对成功调用只记 started、不记 finished，
// 所以「孤儿 started」不能直接当成崩溃。口径必须写在输出里，而不是只写在指南里。
report.mode_caveat = 'errors 模式只保留失败的 finished；成功调用也会留下孤儿 started，因此「有开始无结果」不等于崩溃。判崩溃请用 MALONG_TRACE=all，或确认同 call_id 确实没有任何 finished。'

if (asJson) {
  console.log(JSON.stringify(report, null, 2))
} else {
  const t = report.totals
  console.log(`trace-triage  (${report.state_dir})`)
  console.log(`files: ${files.map(f => `${f.file}(${f.entries})`).join(' ') || '(none)'}`)
  console.log(`calls ${t.calls}  started ${t.started}  finished ${t.finished}  unfinished ${t.unfinished}  errors ${t.errors}  writes ${t.writes}`)
  const s = report.signals
  const line = (k, v) => console.log(`  ${k}: ${v}`)
  // 打印真实总数（counts），样本超 20 时标注「样本列前 20」。
  // 不能再用 s.xxx.length —— 那是样本长度，超过 20 恒为 20（R21-F07）。
  const c = report.counts || {}
  const fmt = (key) => {
    const total = c[key] ?? (Array.isArray(s[key]) ? s[key].length : 0)
    const shown = Array.isArray(s[key]) ? s[key].length : 0
    return total > shown ? `${total}  （样本列前 ${shown}）` : String(total)
  }
  line('有开始无结果（崩溃窗）', fmt('unfinished_calls'))
  line('口径', 'errors 模式只保留失败的 finished；成功调用也会留孤儿 started —— 有开始无结果 ≠ 崩溃（判崩溃用 all 模式）')
  line('版本冲突后未重读就继续', fmt('version_conflict_without_reread'))
  line('60s 内同工具连续失败', fmt('repeated_failed_calls_within_60s'))
  line('写入但未验证', fmt('writes_not_verified'))
  line('建议 next_action 未被调用', fmt('suggested_next_action_not_taken'))
  console.log('\n(只读聚合；轨迹不含参数/源码/路径，因此不会泄露代码内容)')
  if (wantSearch) printSearch(report.search_misses)
  if (legacyNote) console.log(legacyNote)
}
