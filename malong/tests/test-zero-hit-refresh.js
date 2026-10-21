// test-zero-hit-refresh.js — 零命中自愈回归（dogfood-050 P1 修复）
// 旧行为：symbol_search / references 只在「有结果」或「带 fileArg」时保鲜——
// 查询上次索引之后新加的符号会假空且自锁（references 还误称 authoritative）。
// 现在：无 fileArg 路径统一调用 refreshStaleFiles（有界扫描/刷新）后重查一次——
// 不仅零命中自愈，也覆盖 watcher 防抖窗口内「有命中但漏新结果」。
// 覆盖：① 刷新后重查命中 ② 索引本就新鲜不乱 reindex ③ 刷新抛错优雅降级
//       ④ references 同链路 ⑤ 带 fileArg 不触发（已有 ensureFreshFile） ⑥ 刷新后仍零 → 文案说明
//       ⑦/⑧ 有命中 + 陈旧 → 刷新后补全新结果
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}
const { handle: searchHandle } = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-symbol-search', 'handler.js')).href)
const { handle: refsHandle } = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-references', 'handler.js')).href)

const ws = join(os.tmpdir(), 'opencode', 'zero-hit-refresh-ws')
try { rmSync(ws, { recursive: true, force: true }) } catch {}
mkdirSync(ws, { recursive: true })
writeFileSync(join(ws, 'code-index.db'), '')
const ctxS = (svc) => ({ codeIndexService: { initWorkspace() {}, ...svc }, getWorkspaceDir: () => ws })

// ── ① symbol_search：首查 0 → 刷新 1 陈新文件 → 重查命中 + refreshed_stale ──
{
  let searchCalls = 0
  const svc = {
    async searchSymbols() { searchCalls++; return searchCalls === 1 ? [] : [{ name: 'brandNew', type: 'function', file: 'src/a.js', line: 1, end_line: 2 }] },
    async refreshStaleFiles() { return { scanned: 10, stale: 1, refreshed: 1, truncated: false } },
  }
  const r = await searchHandle({ workspace_dir: ws, query: 'brandNew' }, ctxS(svc))
  assert(r.count === 1, `① 刷新后重查命中（得 ${r.count}）`)
  assert(r.refreshed_stale === 1, `① refreshed_stale=1（得 ${r.refreshed_stale}）`)
  assert(searchCalls === 2, `① searchSymbols 共 2 次（得 ${searchCalls}）`)
}

// ── ② symbol_search：刷新 0（索引新鲜）→ 保留原建议（不误称已刷新、不瞎 reindex）──
{
  const svc = {
    async searchSymbols() { return [] },
    async refreshStaleFiles() { return { scanned: 10, stale: 0, refreshed: 0, truncated: false } },
  }
  const r = await searchHandle({ workspace_dir: ws, query: 'nope' }, ctxS(svc))
  assert(r.count === 0 && !r.refreshed_stale, '② 零刷新零命中（无 refreshed_stale）')
  assert(/Only call reindex/.test(r.suggestion || ''), `② 保留原建议（得 ${r.suggestion}）`)
}

// ── ③ symbol_search：refreshStaleFiles 抛错 → 优雅降级为普通零命中 ──
{
  const svc = {
    async searchSymbols() { return [] },
    async refreshStaleFiles() { throw new Error('boom') },
  }
  const r = await searchHandle({ workspace_dir: ws, query: 'nope' }, ctxS(svc))
  assert(r.count === 0 && typeof r.suggestion === 'string', '③ 刷新异常降级不崩')
}

// ── ④ references：零命中 → 刷新后重查命中 ──
{
  let refCalls = 0
  const svc = {
    async getReferences() { refCalls++; return refCalls === 1 ? [] : [{ path: 'src/a.js', kind: 'call', target_name: 'freshRef', line: 3 }] },
    async refreshStaleFiles() { return { scanned: 5, stale: 1, refreshed: 1, truncated: false } },
  }
  const r = await refsHandle({ workspace_dir: ws, symbol: 'freshRef' }, ctxS(svc))
  assert(r.count === 1, `④ 刷新后重查命中（得 ${r.count}）`)
  assert(r.refreshed_stale === 1, `④ refreshed_stale=1（得 ${r.refreshed_stale}）`)
  assert(refCalls === 2, `④ getReferences 共 2 次（得 ${refCalls}）`)
}

// ── ⑤ references：带 fileArg 不触发刷新（已有 ensureFreshFile 路径）──
{
  let refreshCalls = 0
  const svc = {
    resolveFileArg(fp) { return { ok: true, path: fp } },
    async ensureFreshFile() {},
    async getReferences() { return [] },
    async refreshStaleFiles() { refreshCalls++; return { refreshed: 0 } },
  }
  const r = await refsHandle({ workspace_dir: ws, symbol: 'x', file: 'src/a.js' }, ctxS(svc))
  assert(refreshCalls === 0, `⑤ 带 fileArg 不触发刷新（得 ${refreshCalls}）`)
  assert(typeof r.suggestion === 'string' && r.suggestion.length > 0, '⑤ 仍给建议')
}

// ── ⑥ references：刷新过但真零引用 → 文案说明已刷新（不再误称 authoritative）──
{
  const svc = {
    async getReferences() { return [] },
    async refreshStaleFiles() { return { scanned: 3, stale: 1, refreshed: 1, truncated: false } },
  }
  const r = await refsHandle({ workspace_dir: ws, symbol: 'ghost' }, ctxS(svc))
  assert(r.refreshed_stale === 1, `⑥ refreshed_stale=1（得 ${r.refreshed_stale}）`)
  assert(/after refreshing 1 stale/.test(r.suggestion || ''), `⑥ 文案说明已刷新（得 ${r.suggestion}）`)
  assert(!/This is authoritative/.test(r.suggestion || ''), '⑥ 刷新后不再误称 authoritative')
}

// ── ⑦ symbol_search：有命中但索引陈旧 → 刷新后补全新结果（防抖窗口竞态）──
{
  let searchCalls = 0
  const svc = {
    async searchSymbols() {
      searchCalls++
      return searchCalls === 1
        ? [{ name: 'oldHit', type: 'function', file: 'src/a.js', line: 1, end_line: 2 }]
        : [{ name: 'oldHit', type: 'function', file: 'src/a.js', line: 1, end_line: 2 }, { name: 'oldHitNew', type: 'function', file: 'src/a.js', line: 9, end_line: 10 }]
    },
    async refreshStaleFiles() { return { scanned: 10, stale: 1, refreshed: 1, truncated: false } },
  }
  const r = await searchHandle({ workspace_dir: ws, query: 'oldHit' }, ctxS(svc))
  assert(r.count === 2, `⑦ 有命中 + 陈旧 → 刷新后补全新结果（得 ${r.count}）`)
  assert(r.refreshed_stale === 1, `⑦ refreshed_stale=1（得 ${r.refreshed_stale}）`)
  assert(searchCalls === 2, `⑦ searchSymbols 再查一次（得 ${searchCalls}）`)
}

// ── ⑧ references：有命中 + 陈旧 → 刷新后补全新引用 ──
{
  let refCalls = 0
  const svc = {
    async getReferences() {
      refCalls++
      return refCalls === 1
        ? [{ path: 'src/a.js', kind: 'call', target_name: 'hot', line: 3 }]
        : [{ path: 'src/a.js', kind: 'call', target_name: 'hot', line: 3 }, { path: 'src/b.js', kind: 'call', target_name: 'hot', line: 7 }]
    },
    async refreshStaleFiles() { return { scanned: 5, stale: 1, refreshed: 1, truncated: false } },
  }
  const r = await refsHandle({ workspace_dir: ws, symbol: 'hot' }, ctxS(svc))
  assert(r.count === 2, `⑧ 有命中 + 陈旧 → 刷新后补全新引用（得 ${r.count}）`)
  assert(r.refreshed_stale === 1, `⑧ refreshed_stale=1（得 ${r.refreshed_stale}）`)
  assert(refCalls === 2, `⑧ getReferences 再查一次（得 ${refCalls}）`)
}

console.log(`== test-zero-hit-refresh: ${pass} passed, ${fail} failed ==`)
process.exit(fail ? 1 : 0)
