// test-f5-map-pagination.js — F5（0.5.14 Windows 复核）/ P2：紧凑地图分页/下钻/公开参数/预算合同
// 现场：code_query(mode="map") 有紧凑首屏，但 generateCompact 固定 page=1 且丢弃 page/total_pages/next_page；
// code_query 再投影时也没有这些字段，top_entries 固定 slice(0,12)；公开 schema 没有 page/dir；
// repo_map 的 handler 接收 page/page_size/prefix 但 manifest 没声明（实现接受、模型看不见）。
// 本测试锁定：① 默认折叠深层测试/夹具（不烧首屏预算）且给下钻路径；② page/page_size/prefix/dir 贯穿并返回
// 真实分页字段；③ navigation 动作可原样执行（下一页/下钻）；④ 末页明确无下一页；⑤ 预算截断与「还有下一页」分开，
// 且截断提示计入 max_tokens 预算；⑥ dir 越界/不存在显式拒绝；⑦ code_query(map) 投影不丢分页语义。
// 说明：本文件用真实 code-index.db + 真实 repoMap 服务 + 真实 code_query 入口（非纯函数替身）。
import { join, dirname, basename } from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { createDb } from '../db-adapter.js'
import * as repoMap from '../repo-map.js'
import { handle as codeQuery } from '../tools/tool-code-query/handler.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  FAIL: ' + msg) } }
const brief = (v) => JSON.stringify(v ?? null).slice(0, 300)

const WS = join(os.tmpdir(), 'opencode', 'f5-map-pagination')
try { rmSync(WS, { recursive: true, force: true }) } catch {}
mkdirSync(WS, { recursive: true })

// ── 真 code-index.db：40 个顶层模块（多页） + src/tools/tests(fixtures) ──
const FILES = []
for (let i = 0; i < 40; i++) FILES.push(['mod' + String(i).padStart(2, '0') + '/mod' + i + '.js', [['modFn' + i, 'function', 1]]])
FILES.push(['src/alpha.js', [['alphaFn', 'function', 1]]])
FILES.push(['src/beta.js', [['betaFn', 'function', 2]]])
FILES.push(['tools/tool-a.js', [['toolA', 'function', 1]]])
FILES.push(['tests/unit/a.test.js', [['testA', 'function', 1]]])
for (const n of ['a', 'b', 'c', 'd', 'e']) FILES.push(['tests/fixtures/fixture_' + n + '.rs', [['Command', 'class', 3]]])
// M1（2026-10-19 专家 Windows 复核）：子目录多页范围——用于验证 next_page 不丢 dir（原样执行不回根）
for (let i = 0; i < 13; i++) FILES.push(['many/f' + String(i).padStart(2, '0') + '.js', [['manyFn' + i, 'function', 1]]])

const db = await createDb(join(WS, 'code-index.db'))
db.exec(`
CREATE TABLE files (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT UNIQUE NOT NULL, repo TEXT NOT NULL DEFAULT '');
CREATE TABLE symbols (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('function','class','variable','method','export','import','interface','type')),
  signature TEXT DEFAULT '',
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL DEFAULT 0,
  parent_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL
);
`)
const insFile = db.prepare('INSERT INTO files (path) VALUES (?)')
const insSym = db.prepare('INSERT INTO symbols (file_id, name, type, start_line) VALUES (?, ?, ?, ?)')
for (const [p, syms] of FILES) {
  const id = insFile.run(p).lastInsertRowid
  for (const [n, t, l] of syms) insSym.run(id, n, t, l)
}
db.close()
// 真实目录（dir 下钻的边界校验读盘：越界/不存在必须能区分）
for (const [p] of FILES) mkdirSync(join(WS, dirname(p)), { recursive: true })

// ── 真 repoMap 服务（mock core 只做注册/getWorkspaceDir）──
const registered = {}
const core = {
  getWorkspaceDir: (p) => p,
  registerService: (name, svc) => { registered[name] = svc },
  getService: () => null,
  log: () => {},
}
await repoMap.init(core)
const svc = registered.repoMap
const ctx = { repoMapService: svc, codeIndexService: { async initWorkspace() {}, async indexBatch() { return [] } } }

// ── ① 默认紧凑首屏：折叠深层测试/夹具 + 分页字段 + 可执行 navigation ──
{
  const nav = await svc.generateCompact(WS, { workspaceDir: WS, maxTokens: 4000, pageSize: 100 })
  assert(!nav.error, '① generateCompact 成功（得 ' + brief(nav.error) + '）')
  assert(/tests\/  \(\d+ test\/fixture file\(s\) folded/.test(nav.map), '① 深层测试/夹具默认折叠成一行（得 ' + brief(nav.map.slice(0, 600)) + '）')
  assert(!/fixture_a\.rs/.test(nav.map), '① 折叠后夹具文件不出现在首屏（不烧预算）')
  assert(Array.isArray(nav.folded_dirs) && nav.folded_dirs.includes('tests'), '① folded_dirs 给出下钻路径（得 ' + brief(nav.folded_dirs) + '）')
  assert(nav.scope === basename(WS), '① scope 为当前范围（得 ' + brief(nav.scope) + '）')
  assert(nav.page === 1 && nav.page_size === 100, '① 页码/每页条数（得 ' + brief({ p: nav.page, ps: nav.page_size }) + '）')
  assert(Number.isInteger(nav.total_pages) && nav.total_pages >= 1, '① total_pages 为真实页数（得 ' + brief(nav.total_pages) + '）')
  assert(['estimated_tokens'].includes(nav.budget?.unit), '① 预算单位明确（得 ' + brief(nav.budget) + '）')
  assert(nav.budget.used <= nav.budget.limit, '① 预算内：声明用量不超过上限（得 ' + brief({ u: nav.budget.used, l: nav.budget.limit }) + '）')
  assert(nav.has_next_page === (nav.page < nav.total_pages), '① has_next_page 与页码一致')
  const acts = nav.navigation || []
  assert(acts.some(a => a.action === (nav.has_next_page ? 'next_page' : 'no_next_page')), '① 导航动作给出下一页或明确末页（得 ' + brief(acts.map(a => a.action)) + '）')
  assert(acts.some(a => a.action === 'drill_down' && a.args && a.args.dir === 'tests' && a.args.mode === 'map' && a.args.workspace_dir === WS), '① 下钻动作参数齐全可原样执行（得 ' + brief(acts) + '）')
  assert(!nav.next_page || acts.find(a => a.action === 'next_page').args.page === nav.next_page, '① next_page 字段与动作一致')
}

// ── ② page/page_size 真实生效（多页）──
{
  const p1 = await svc.generateCompact(WS, { workspaceDir: WS, maxTokens: 700, pageSize: 5 })
  assert(p1.total_pages > 1, '② pageSize=5 时多页（得 ' + brief({ tp: p1.total_pages, te: p1.total_entries }) + '）')
  assert(p1.next_page === 2 && p1.has_next_page === true, '② 第一页有下一页（得 ' + brief({ n: p1.next_page, h: p1.has_next_page }) + '）')
  const p2 = await svc.generateCompact(WS, { workspaceDir: WS, maxTokens: 700, pageSize: 5, page: 2 })
  assert(p2.page === 2 && p2.map !== p1.map, '② 第二页内容与第一页不同（翻页真实生效）')
  const last = await svc.generateCompact(WS, { workspaceDir: WS, maxTokens: 700, pageSize: 5, page: p1.total_pages })
  assert(last.has_next_page === false && last.next_page === undefined, '② 末页：没有下一页（得 ' + brief({ h: last.has_next_page, n: last.next_page }) + '）')
  assert((last.navigation || []).some(a => a.action === 'no_next_page'), '② 末页导航明确 no_next_page')
  const big = await svc.generateCompact(WS, { workspaceDir: WS, maxTokens: 700, pageSize: 40 })
  assert(big.total_pages < p1.total_pages, '② pageSize 参与装页（pageSize=40 页数更少；得 ' + brief({ a: big.total_pages, b: p1.total_pages }) + '）')
  const oor = await svc.generateCompact(WS, { workspaceDir: WS, maxTokens: 700, pageSize: 5, page: 99 })
  assert(oor.page_out_of_range === true && /total_pages=/.test(String(oor.suggestion || '')), '② 越界页显式提示（得 ' + brief({ o: oor.page_out_of_range, s: oor.suggestion }) + '）')
}

// ── ③ prefix 过滤 + 预算截断与「还有下一页」分开 ──
{
  const nav = await svc.generateCompact(WS, { workspaceDir: WS, maxTokens: 700, pageSize: 40, prefix: 's' })
  assert(nav.map.includes('src/') && !nav.map.includes('mod00/'), '③ prefix 过滤顶层条目（得 ' + brief(nav.map.slice(0, 200)) + '）')
  const tiny = await svc.generateCompact(WS, { workspaceDir: WS, maxTokens: 30, pageSize: 40 })
  assert(tiny.truncated_by_budget === true, '③ 小预算 → truncated_by_budget（得 ' + brief({ t: tiny.truncated, tb: tiny.truncated_by_budget }) + '）')
  assert(/truncated by the map text budget/.test(tiny.map), '③ 截断提示在文本里（得 ' + brief(tiny.map.slice(-160)) + '）')
  assert(tiny.tokens <= 30, '③ 截断提示计入预算：估算不超过 max_tokens（得 ' + brief({ t: tiny.tokens, l: tiny.budget?.limit }) + '）')
  assert(tiny.budget.used <= tiny.budget.limit, '③ budget.used 同口径（得 ' + brief(tiny.budget) + '）')
}

// ── ④ dir 下钻（真实范围切换）──
{
  const nav = await svc.generateCompact(join(WS, 'tests'), { workspaceDir: WS, maxTokens: 700, pageSize: 12, scope: 'tests', foldTests: false })
  assert(nav.map.includes('fixture_a.rs'), '④ dir 下钻后夹具可见（得 ' + brief(nav.map.slice(0, 300)) + '）')
  assert(nav.scope === 'tests', '④ scope 反映下钻范围（得 ' + brief(nav.scope) + '）')
  assert(nav.files > 0 && nav.files < 50, '④ 下钻范围只含子目录文件（得 ' + brief(nav.files) + '）')
}

// ── ⑤ code_query(mode="map") 公开入口：投影不丢分页语义 + navigation 可原样执行 ──
{
  const r1 = await codeQuery({ workspace_dir: WS, mode: 'map', page_size: 5, max_tokens: 700 }, ctx)
  assert(r1.ok === true, '⑤ code_query map 成功（得 ' + brief(r1.error || r1.message) + '）')
  const res1 = r1.result || {}
  assert(res1.page === 1 && res1.page_size === 5 && res1.total_pages > 1, '⑤ 投影含真实分页字段（得 ' + brief({ p: res1.page, ps: res1.page_size, tp: res1.total_pages }) + '）')
  assert(res1.budget && res1.budget.unit === 'estimated_tokens', '⑤ 投影含预算单位（得 ' + brief(res1.budget) + '）')
  assert(!('top_entries' in res1) || res1.top_entries.length + (res1.skeleton_omitted || 0) >= 1, '⑤ top_entries 为有界骨架（不再是固定 12 条切片）')
  const nextAct = (res1.navigation || []).find(a => a.action === 'next_page')
  assert(!!nextAct, '⑤ 给出可执行的 next_page 动作（得 ' + brief(res1.navigation) + '）')
  const r2 = await codeQuery(nextAct.args, ctx)
  const res2 = r2.result || {}
  assert(r2.ok === true && res2.page === 2, '⑤ 原样执行 next_page 动作成功（得 ' + brief({ ok: r2.ok, p: res2.page, e: r2.error }) + '）')
  assert(res2.map !== res1.map, '⑤ 原样翻页拿到不同内容')
  const drill = (res1.navigation || []).find(a => a.action === 'drill_down' && a.args.dir === 'tests')
  assert(!!drill, '⑤ 给出可执行的 drill_down 动作（得 ' + brief(res1.navigation) + '）')
  const r3 = await codeQuery(drill.args, ctx)
  const res3 = r3.result || {}
  assert(r3.ok === true && res3.scope === 'tests', '⑤ 原样执行下钻动作进入 tests 范围（得 ' + brief({ ok: r3.ok, s: res3.scope, e: r3.error }) + '）')
  const nested = (res3.navigation || []).find(a => a.action === 'drill_down' && a.args.dir === 'tests/fixtures')
  assert(!!nested, '⑤ 嵌套折叠给工作区相对路径的下钻动作（得 ' + brief(res3.navigation) + '）')
  const r4 = await codeQuery(nested.args, ctx)
  const res4 = r4.result || {}
  assert(r4.ok === true && /fixture_a\.rs/.test(String(res4.map || '')), '⑤ 原样执行嵌套下钻拿到夹具文件（得 ' + brief({ ok: r4.ok, e: r4.error, m: String(res4.map || '').slice(0, 160) }) + '）')
  const lastR = await codeQuery({ workspace_dir: WS, mode: 'map', page: res1.total_pages, page_size: 5 }, ctx)
  const resL = lastR.result || {}
  assert(resL.has_next_page === false && (resL.navigation || []).some(a => a.action === 'no_next_page'), '⑤ 末页经入口明确无下一页')
}

// ── ⑥ dir 边界：越界/不存在显式拒绝（不静默空图）──
{
  const esc = await codeQuery({ workspace_dir: WS, mode: 'map', dir: '../..' }, ctx)
  assert(esc.ok === false && esc.error === 'path_blocked', '⑥ dir 越界显式拒绝（得 ' + brief({ ok: esc.ok, e: esc.error }) + '）')
  const abs = await codeQuery({ workspace_dir: WS, mode: 'map', dir: '/etc' }, ctx)
  assert(abs.ok === false && abs.error === 'path_blocked', '⑥ 绝对越界路径拒绝（得 ' + brief({ ok: abs.ok, e: abs.error }) + '）')
  const nf = await codeQuery({ workspace_dir: WS, mode: 'map', dir: 'no-such-dir' }, ctx)
  assert(nf.ok === false && nf.error === 'dir_not_found', '⑥ 不存在目录显式拒绝（得 ' + brief({ ok: nf.ok, e: nf.error }) + '）')
  const okDrill = await codeQuery({ workspace_dir: WS, mode: 'map', dir: 'src' }, ctx)
  assert(okDrill.ok === true && (okDrill.result || {}).scope === 'src' && /alphaFn/.test(String((okDrill.result || {}).map || '')), '⑥ 合法相对 dir 正常下钻（得 ' + brief({ ok: okDrill.ok, s: (okDrill.result || {}).scope }) + '）')
}

// ── ⑦ N1（专家 011/048）：结构化骨架/折叠清单有界，整次响应不被外围结构主导 ──
{
  const r = await codeQuery({ workspace_dir: WS, mode: 'map', page_size: 5, max_tokens: 700 }, ctx)
  const res = r.result || {}
  const textLen = JSON.stringify(res, null, 2).length
  assert(Array.isArray(res.top_entries) && res.top_entries.length <= 12, '⑦ 结构化骨架有界（旧实现返回全部顶层条目；得 ' + (res.top_entries || []).length + '）')
  assert(res.skeleton_total === res.total_entries, '⑦ skeleton_total = 顶层条目总数（得 ' + brief({ st: res.skeleton_total, te: res.total_entries }) + '）')
  assert((res.skeleton_omitted || 0) === res.skeleton_total - res.top_entries.length, '⑦ skeleton_omitted 与窗口/总数一致（得 ' + brief({ o: res.skeleton_omitted, st: res.skeleton_total, w: res.top_entries.length }) + '）')
  assert((res.top_entries || []).some(s => s.detail === true), '⑦ 窗口仍含当前页条目（detail=true，不丢方位）')
  assert(Array.isArray(res.folded_dirs) && res.folded_dirs.length <= 20, '⑦ 折叠目录清单有界（得 ' + (res.folded_dirs || []).length + '）')
  assert(textLen < 12000, '⑦ tests 密集工作区整次响应 < 12000 字符（旧实现可被骨架主导；得 ' + textLen + '）')
  assert(res.budget?.used <= 700, '⑦ map 文本仍在 max_tokens 预算内（得 ' + brief(res.budget) + '）')
  assert((res.navigation || []).some(a => a.action === 'next_page' || a.action === 'no_next_page'), '⑦ 骨架收缩后导航动作仍可执行')
  // 小预算：骨架不把外围结构撑大（旧实现 top_entries 仍全量）
  const small = await codeQuery({ workspace_dir: WS, mode: 'map', page_size: 5, max_tokens: 30 }, ctx)
  const sres = small.result || {}
  const sLen = JSON.stringify(sres, null, 2).length
  assert(sLen < 12000 && (sres.top_entries || []).length <= 12, '⑦ 小预算响应同样有界（得 ' + sLen + ' 字符 / top ' + (sres.top_entries || []).length + '）')
}

// ── ⑧ M1（2026-10-19 专家 Windows 复核）：子目录 next_page 必须保留 dir ——
// 现场：code_query(mode="map", dir="malong/tests", page_size=5) 返回 scope=malong/tests、文案「Next page 2/34 of scope malong/tests」，
// 但 navigation.args 缺 dir；原样执行后 scope=repo、page=2（翻页跳回根目录）。
// 锁定：子目录 page1 → 原样 next_page → scope 不变、页内容不同、分页总数一致；
// 末页无下一页；小预算仍带 dir；多层目录带完整相对路径；根目录仍省略 dir（不写 dir: "." 之类噪声）。
{
  const r1 = await codeQuery({ workspace_dir: WS, mode: 'map', dir: 'many', page_size: 5, max_tokens: 700 }, ctx)
  assert(r1.ok === true, '⑧ 子目录 map 成功（得 ' + brief(r1.error) + '）')
  const res1 = r1.result || {}
  assert(res1.scope === 'many', '⑧ scope 为子目录（得 ' + brief(res1.scope) + '）')
  const next1 = (res1.navigation || []).find(a => a.action === 'next_page')
  assert(!!next1, '⑧ 子目录给出 next_page（得 ' + brief(res1.navigation) + '）')
  assert(next1 && next1.args?.dir === 'many', '⑧ next_page 带 dir=many（旧实现缺 dir；得 ' + brief(next1 && next1.args) + '）')
  assert(next1 && next1.args?.workspace_dir === WS && next1.args?.mode === 'map', '⑧ next_page 其余参数齐全可原样执行（得 ' + brief(next1 && next1.args) + '）')
  const r2 = await codeQuery(next1.args, ctx)
  const res2 = r2.result || {}
  assert(r2.ok === true, '⑧ 原样执行 next_page 成功（得 ' + brief(r2.error) + '）')
  assert(res2.scope === 'many', '⑧ 原样翻页后 scope 不变（旧实现跳回 repo；得 ' + brief(res2.scope) + '）')
  assert(res2.page === 2 && res2.total_pages === res1.total_pages, '⑧ 页号前进且分页总数一致（得 ' + brief({ p: res2.page, tp: res2.total_pages, tp1: res1.total_pages }) + '）')
  assert(res2.map !== res1.map, '⑧ 翻页拿到不同页内容')
  assert(!/^tests\//m.test(String(res2.map || '')), '⑧ 翻页内容仍是子目录范围（不混入根目录条目）')
  // 末页：明确 no_next_page，不伪造 dir
  const lastR = await codeQuery({ workspace_dir: WS, mode: 'map', dir: 'many', page: res1.total_pages, page_size: 5, max_tokens: 700 }, ctx)
  const resL = lastR.result || {}
  assert(resL.page === res1.total_pages && resL.has_next_page === false, '⑧ 子目录末页 has_next_page=false（得 ' + brief({ p: resL.page, h: resL.has_next_page }) + '）')
  assert((resL.navigation || []).some(a => a.action === 'no_next_page' && /scope many/.test(String(a.note || ''))), '⑧ 末页文案仍指向子目录范围（得 ' + brief(resL.navigation) + '）')
  // 小预算：导航同样带 dir（否则预算越小越容易跳根）
  const tiny = await codeQuery({ workspace_dir: WS, mode: 'map', dir: 'many', page_size: 5, max_tokens: 30 }, ctx)
  const tnext = ((tiny.result || {}).navigation || []).find(a => a.action === 'next_page')
  assert(!tnext || tnext.args?.dir === 'many', '⑧ 小预算 next_page 仍带 dir（得 ' + brief(tnext && tnext.args) + '）')
  // 多层目录：dir 写完整工作区相对路径
  const deep1 = await codeQuery({ workspace_dir: WS, mode: 'map', dir: 'tests/fixtures', page_size: 2, max_tokens: 700 }, ctx)
  const dres = deep1.result || {}
  assert(dres.scope === 'tests/fixtures', '⑧ 多层目录 scope 为完整相对路径（得 ' + brief(dres.scope) + '）')
  const dnext = (dres.navigation || []).find(a => a.action === 'next_page')
  assert(!dnext || dnext.args?.dir === 'tests/fixtures', '⑧ 多层目录 next_page 带完整 dir（得 ' + brief(dnext && dnext.args) + '）')
  // 根目录：不写 dir（缺省即根）
  const root1 = await codeQuery({ workspace_dir: WS, mode: 'map', page_size: 2, max_tokens: 700 }, ctx)
  const rnext = ((root1.result || {}).navigation || []).find(a => a.action === 'next_page')
  assert(!!rnext, '⑧ 根目录给出 next_page')
  assert(rnext && !('dir' in (rnext.args || {})), '⑧ 根目录 next_page 省略 dir（得 ' + brief(rnext && rnext.args) + '）')
}

console.log('\n=== test-f5-map-pagination: ' + pass + ' passed, ' + fail + ' failed ===')
process.exit(fail > 0 ? 1 : 0)
