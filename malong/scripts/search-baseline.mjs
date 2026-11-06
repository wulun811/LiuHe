// search-baseline.mjs — 中文检索 P0 基线测量（专家 2026-10-31 方案 §9 P0）
//
// 目的：把「中文目标能不能被现有能力接住」量出来，而不是凭印象宣布。
// 原则：
//   · 走真实用户路径——真起 mcp-server，真发 JSON-RPC（不 mock 检索层）；
//   · 每个任务给「可接受目标集合」（路径子串），命中与否由集合判定，不由工具自评；
//   · 只读：不写工作区，不产生任务态，不改任何代码；
//   · 输出含「预期无目标」类任务：这类要求工具说清「没找到」，而不是硬推一个无关文件。
//
// 用法：
//   node scripts/search-baseline.mjs --workspace <abs> --tasks scripts/search-baseline-tasks.json --out /tmp/baseline.json
//   node scripts/search-baseline.mjs --workspace <abs> --tasks ... --markdown   # 直接出 Markdown 表
import { spawn } from 'node:child_process'
import { readFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

function arg(name, dflt) {
  const i = process.argv.indexOf(name)
  if (i < 0) return dflt
  return process.argv[i + 1] ?? dflt
}

const workspace = resolve(arg('--workspace', ROOT))
const tasksPath = resolve(arg('--tasks', join(__dirname, 'search-baseline-tasks.json')))
const outPath = arg('--out', null)
const asMarkdown = process.argv.includes('--markdown')

const tasks = JSON.parse(readFileSync(tasksPath, 'utf-8'))
const stateDir = mkdtempSync(join(tmpdir(), 'lh-baseline-'))
const created = [stateDir]

function startServer() {
  const env = {
    ...process.env,
    MALONG_STATE_DIR: stateDir,
    HOME: stateDir,
    MALONG_TRACE: 'off',
    // 对齐生产六合线档位（用户日常用 graph + entry-state）；classic 下 code_search/reindex 隐藏，
    // 拿 classic 当基线会测出“工具不存在”而不是“检索不准”。
    MALONG_INTERFACE: 'graph',
    MALONG_ENTRY_STATE: '1',
    MALONG_SKIP_STATE_MIGRATION: '1',
  }
  const child = spawn(process.execPath, [join(ROOT, 'mcp-server.js')], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  let buf = ''
  const pending = new Map()
  let stderr = ''
  child.stderr.on('data', (d) => { stderr += d.toString() })
  child.stdout.on('data', (d) => {
    buf += d.toString()
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      const key = String(msg.id)
      if (pending.has(key)) {
        const { resolve: done } = pending.get(key)
        pending.delete(key)
        done(msg)
      }
    }
  })
  let idc = 0
  function rpc(method, params) {
    const id = ++idc
    return new Promise((done, fail) => {
      const timer = setTimeout(() => fail(new Error('timeout: ' + method)), 180000)
      pending.set(String(id), { resolve: (m) => { clearTimeout(timer); done(m) } })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }
  return { child, rpc, stderrOf: () => stderr }
}

function parseToolResult(msg) {
  const text = msg?.result?.content?.[0]?.text
  if (typeof text !== 'string') return null
  try { return JSON.parse(text) } catch { return { raw: text } }
}

async function callTool(rpc, name, args) {
  const msg = await rpc('tools/call', { name, arguments: args })
  if (msg?.error) return { __error: msg.error }
  return parseToolResult(msg)
}

// 命中判定：候选里任一 file_path 含可接受子串即算命中（不要求排第一，但记录名次）
function judge(items, accept) {
  if (!accept || !accept.length) return null
  for (let i = 0; i < items.length; i++) {
    const p = items[i].file_path || items[i].file || ''
    for (const a of accept) if (p.includes(a)) return { hit: true, rank: i + 1, path: p }
  }
  return { hit: false, rank: null, path: null }
}

const { child, rpc, stderrOf } = startServer()
const report = { workspace, tasks: [], generated_at: new Date().toISOString() }
let ready = false

try {
  for (let i = 0; i < 60 && !ready; i++) {
    try {
      const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'search-baseline', version: '1' } })
      if (init?.result) {
        const list = await rpc('tools/list', {})
        if (list?.result?.tools?.length) ready = true
      }
    } catch { /* retry */ }
  }
  if (!ready) throw new Error('server not ready: ' + stderrOf().slice(-500))

  // 索引一次；后续任务复用（索引状态落在临时 stateDir，不污染用户环境）
  const rIdx = await callTool(rpc, 'reindex', { workspace_dir: workspace })
  report.index = rIdx?.__error ? { error: rIdx.__error } : { ok: true }

  for (const t of tasks) {
    const row = { id: t.id, goal: t.goal, expect: t.expect, accept: t.accept || null }
    const args = { workspace_dir: workspace, goal: t.goal }
    if (t.route) args.route = t.route
    const task = await callTool(rpc, 'code_task', args)
    if (task?.__error) {
      row.code_task_error = task.__error
    } else {
      const cands = (task?.observation?.candidates || []).slice(0, 20)
      row.route_source = task?.observation?.route_source || null
      row.route = task?.route || null
      row.top = cands.slice(0, 3).map(c => ({ name: c.name, file: c.file_path, reason: c.rank_reason }))
      row.code_task = judge(cands, t.accept)
      row.candidates_total = task?.observation?.candidates_total ?? cands.length
      row.observation_summary = String(task?.observation?.summary || '').slice(0, 400)
      row.next_action = task?.next_action
        ? { tool: task.next_action.tool, arg_keys: Object.keys(task.next_action.args || {}), note: task.next_action.note || null }
        : null
      row.content_scan = task?.observation?.content_scan
        ? { skipped: task.observation.content_scan.skipped, truncated: task.observation.content_scan.truncated }
        : null
      row.zero_hit_guidance = task?.observation?.zero_hit || null
    }

    // 六合线不暴露 code_search（ADR-017 白名单），用户真实入口是 code_query(mode="search")，
    // 它真委派给 code_search，字段与 code_search 相同。测错入口等于没测。
    const search = await callTool(rpc, 'code_query', { workspace_dir: workspace, mode: 'search', query: t.goal })
    const sr = search?.result || null
    if (!search || search.ok === false || !sr) {
      row.code_search_error = search?.error || search?.message || 'code_query(mode=search) returned no result'
    } else {
      const results = sr.results || []
      const others = [...(sr.partial_matches || []), ...(sr.comment_matches || []), ...(sr.doc_results || [])]
      row.code_search = {
        results: results.length,
        partial: (sr.partial_matches || []).length,
        comments: (sr.comment_matches || []).length,
        docs: (sr.doc_results || []).length,
        hit: judge([...results, ...others], t.accept),
        top: results.slice(0, 3).map(r => ({ name: r.name, file: r.file_path || r.file })),
        summary: sr.summary || null,
        next_step: sr.next_step || null,
      }
    }

    // 带扩展词的对照（P0 要看的是「现有 search_terms 能不能救回词面失配」）
    if (t.search_terms && t.search_terms.length) {
      const withTerms = await callTool(rpc, 'code_task', { workspace_dir: workspace, goal: t.goal, search_terms: t.search_terms })
      const cands = (withTerms?.observation?.candidates || []).slice(0, 20)
      row.with_search_terms = {
        terms: t.search_terms,
        hit: judge(cands, t.accept),
        top: cands.slice(0, 3).map(c => ({ name: c.name, file: c.file_path, reason: c.rank_reason })),
        next_action: withTerms?.next_action?.tool || null,
      }
      // P1：同一组假设词走 code_query(mode="search")，验证跨入口一致（命中应落在 expanded_matches）
      const sq = await callTool(rpc, 'code_query', { workspace_dir: workspace, mode: 'search', query: t.goal, search_terms: t.search_terms })
      const sr2 = sq?.result || null
      row.with_search_terms.search_entry = sr2
        ? {
          results: (sr2.results || []).length,
          expanded: (sr2.expanded_matches || []).length,
          hit: judge([...(sr2.results || []), ...(sr2.expanded_matches || [])], t.accept),
          source_labeled: (sr2.expanded_matches || []).every(h => h.match_source === 'expanded_term'),
        }
        : { error: sq?.error || 'no result' }
    }
    report.tasks.push(row)
  }
} finally {
  try { child.kill('SIGKILL') } catch { /* ignore */ }
  for (const d of created) { try { rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ } }
}

// ── 汇总 ──
function tally(rows, pick) {
  let hit = 0, miss = 0, na = 0
  for (const r of rows) {
    const v = pick(r)
    if (v == null) na++
    else if (v.hit) hit++
    else miss++
  }
  return { hit, miss, na }
}
report.totals = {
  code_task: tally(report.tasks, r => r.code_task),
  code_search: tally(report.tasks, r => r.code_search?.hit),
  with_search_terms: tally(report.tasks, r => r.with_search_terms?.hit),
}

if (outPath) {
  const { writeFileSync } = await import('node:fs')
  writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n')
}

if (asMarkdown) {
  const rows = report.tasks.map(r => {
    const t = r.code_task
    const s = r.code_search
    const fmt = (v) => v == null ? '—' : (v.hit ? '命中 #' + v.rank : '未命中')
    return '| ' + r.id + ' | ' + r.goal + ' | ' + fmt(t) + ' | ' + (r.next_action ? r.next_action.tool : '—') + ' | '
      + (s ? fmt(s.hit) : '—') + ' | ' + (s ? s.comments + '/' + s.docs : '—') + ' | '
      + (r.with_search_terms ? fmt(r.with_search_terms.hit) : '—') + ' |'
  })
  console.log('| ID | 目标 | code_task | next_action | code_search | 注释/文档 | 带扩展词 |')
  console.log('|---|---|---|---|---|---|---|')
  for (const line of rows) console.log(line)
  console.log('')
  console.log('合计：code_task ' + JSON.stringify(report.totals.code_task)
    + '；code_search ' + JSON.stringify(report.totals.code_search)
    + '；带扩展词 ' + JSON.stringify(report.totals.with_search_terms))
} else if (!outPath) {
  console.log(JSON.stringify(report, null, 2))
}
