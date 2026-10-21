// test-boundary-guards.js — 第二轮审查：handler 类型/未知 action 边界守卫
// 旧实现：非字符串参数进入 path.join/SQLite bind/正则裸抛 → MCP -32603 崩调用；health/feedback 未知 action 静默降级
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP = join(os.tmpdir(), 'opencode', 'boundary-guards-test')
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
process.env.MALONG_STATE_DIR = join(TMP, 'state')
const WSD = join(TMP, 'wsdir')
mkdirSync(WSD, { recursive: true })
writeFileSync(join(WSD, 'code-index.db'), 'x')
const WS = join(TMP, 'ws')
mkdirSync(WS, { recursive: true })

let pass = 0, fail = 0
const assert = (c, m) => { if (c) pass++; else { fail++; console.error('  FAIL:', m) } }
const imp = (rel) => import(pathToFileURL(join(__dirname, '..', rel)).href)

const svc = {
  initWorkspace: async () => {},
  ensureFreshFile: async () => ({}),
  resolveFileArg: () => ({ ok: true, path: 'a.js' }),
  getReferences: async () => [],
  getImpactAnalysis: async () => ({}),
  searchSymbols: async () => [],
}
const ctx = {
  getWorkspaceDir: () => WSD,
  getService: () => null,
  log: () => {},
  codeIndexService: svc,
  repoMapService: { generate: async () => ({}), generateFocused: async () => ({}) },
}

async function expectGuard(mod, args, tag, expected = 'invalid_input', extra = {}) {
  try {
    const r = await mod.handle(args, { ...ctx, ...extra })
    assert(r && r.error === expected, `${tag} → ${expected}（得 ${JSON.stringify(r?.error || r?.status || r)}）`)
  } catch (e) {
    assert(false, `${tag} 裸抛：${e.message}`)
  }
}

await expectGuard(await imp('tools/tool-trace-symbol/handler.js'), { workspace_dir: WS, symbol: {}, file: 'a.js' }, 'trace_symbol 非串 symbol')
await expectGuard(await imp('tools/tool-test-bridge/handler.js'), { workspace_dir: 123, action: 'run' }, 'test_bridge 非串 workspace_dir')
await expectGuard(await imp('tools/tool-naming-consistency/handler.js'), { workspace_dir: WS, file: 'a.js', new_symbols: [1] }, 'naming_consistency 非串元素')
await expectGuard(await imp('tools/tool-mock-syncer/handler.js'), { workspace_dir: WS, file: 1, function: 'f' }, 'mock_syncer 非串 file')
await expectGuard(await imp('tools/tool-repo-map/handler.js'), { workspace_dir: 123 }, 'repo_map 非串 workspace_dir')
await expectGuard(await imp('tools/tool-outline-reader/handler.js'), { workspace_dir: 123 }, 'read_outline 非串 workspace_dir')
await expectGuard(await imp('tools/tool-patch-parser/handler.js'), { workspace_dir: 123, text: 'x' }, 'patch_parser 非串 workspace_dir')
await expectGuard(await imp('tools/tool-edit-collision-guard/handler.js'), { workspace_dir: 123, file: 'a.js', action: 'check' }, 'collision_guard 非串 workspace_dir')
await expectGuard(await imp('tools/tool-dead-code-sweeper/handler.js'), { workspace_dir: 123 }, 'dead_code 非串 workspace_dir')
await expectGuard(await imp('tools/tool-impact-analysis/handler.js'), { workspace_dir: WS, file: 'a.js', symbol: {} }, 'impact_analysis 非串 symbol')
await expectGuard(await imp('tools/tool-references/handler.js'), { workspace_dir: WS, symbol: {} }, 'references 非串 symbol')
await expectGuard(await imp('tools/tool-call-chain/handler.js'), { workspace_dir: WS, file: 'a.js', symbol: {} }, 'call_chain 非串 symbol')
await expectGuard(await imp('tools/tool-health/handler.js'), { action: 'cleaup' }, 'health 未知 action', 'invalid_input', { runHealthCheck: async () => ({ status: 'ok', checks: [] }), stateDir: TMP })
await expectGuard(await imp('tools/tool-feedback/handler.js'), { action: 'bogus' }, 'feedback 未知 action')
await expectGuard(await imp('tools/tool-symbol-search/handler.js'), { workspace_dir: WS, query: {} }, 'symbol_search 非串 query', 'invalid_input', { getWorkspaceDir: () => WSD })

console.log(`\n=== test-boundary-guards: ${pass} passed, ${fail} failed ===`)
process.exit(fail > 0 ? 1 : 0)
