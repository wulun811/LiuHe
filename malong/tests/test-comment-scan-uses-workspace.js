// test-comment-scan-uses-workspace.js — 注释扫描必须扫【源码目录】，不是索引 state 目录
//
// 2026-11-02 DSH 实测暴露：code_query(mode="search") 对中文查询恒返回
//   comment_search.reason = "query_has_no_searchable_tokens"
// 真实原因：handler 把 getWorkspaceDir(workspaceDir)（= <stateDir>/workspaces/<md5>，
// 里面只有 code-index.db）传给了 searchComments，walk() 永远找到 0 个源码文件。
// 该函数自 6dcb58d（2026-10-29）引入起就没扫过一行源码。
//
// 本测试的关键：ctx.getWorkspaceDir 必须返回【与源码目录不同】的 state 目录。
// 旧夹具（test-comment-scan-projection.js）写的是 `getWorkspaceDir: () => WS`，
// 把 state 目录指成了源码目录，正好把缺陷遮住 —— 那是假绿。
import { join, dirname } from 'node:path'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  FAIL:', msg) } }

const WS = join(os.tmpdir(), 'opencode', 'comment-ws-src')
const STATE = join(os.tmpdir(), 'opencode', 'comment-ws-state')
for (const d of [WS, STATE]) { try { rmSync(d, { recursive: true, force: true }) } catch {} }
mkdirSync(join(WS, 'src'), { recursive: true })
mkdirSync(STATE, { recursive: true })
writeFileSync(join(WS, 'src', 'gate.mjs'), [
  '// 解析器自检：检查回车换行混用',
  'export function gate() { return 1 }',
].join('\n') + '\n')
// handler 只检查 state 目录里的 db 是否存在
writeFileSync(join(STATE, 'code-index.db'), '')

const { handle } = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-code-search', 'handler.js')).href)

const ctx = {
  codeSearchService: { search: async (query) => ({ query, intent: 'search', results: [], partial_matches: [], token_coverage: null }) },
  getWorkspaceDir: () => STATE,   // ← 生产形状：state 目录 ≠ 源码目录
}

// ── ① 中文查询必须真的扫到源码里的注释 ──
{
  const r = await handle({ workspace_dir: WS, query: '解析器自检' }, ctx)
  assert(r.error === undefined, `① 不应报错（得 ${JSON.stringify(r.error)}）`)
  const s = r.comment_search || {}
  assert(s.performed === true, `① 中文查询必须标记已执行（得 ${JSON.stringify(s.performed)}）`)
  assert(s.corpus_files >= 1, `① 必须扫到源码文件（得 corpus_files=${JSON.stringify(s.corpus_files)}；扫 state 目录会恒为 0）`)
  assert(s.corpus_scanned === true, `① corpus_scanned=true（得 ${JSON.stringify(s.corpus_scanned)}）`)
  assert(s.reason === 'hits_found', `① 命中注释 → reason=hits_found（得 ${JSON.stringify(s.reason)}）`)
  const hits = r.comment_matches || []
  assert(hits.some((h) => String(h.file || '').replace(/\\/g, '/').endsWith('src/gate.mjs')),
    `① 命中必须来自源码目录（得 ${JSON.stringify(hits.map((h) => h.file))}）`)
}

// ── ② 带 search_terms 时注释命中不得丢失（别再走早退分支）──
{
  const r2 = await handle({ workspace_dir: WS, query: '解析器自检', search_terms: ['parserSelfCheck'] }, ctx)
  assert(Array.isArray(r2.comment_matches) && r2.comment_matches.length > 0,
    `② 带假设词时注释命中不得丢失（得 ${JSON.stringify(r2.comment_matches && r2.comment_matches.length)}）`)
}

try { rmSync(WS, { recursive: true, force: true }) } catch {}
try { rmSync(STATE, { recursive: true, force: true }) } catch {}
console.log(`== test-comment-scan-uses-workspace: ${pass} passed, ${fail} failed ==`)
process.exit(fail > 0 ? 1 : 0)
