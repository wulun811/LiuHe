// test-handler-smoke.js — 零测试 handler 全覆盖（r34）
// 7 个此前无任何测试引用的 handler：feedback / gc / health / naming-consistency /
// reindex / repo-map / write-symbols——直调 handle() 断言参数校验、错误路径与轻量成功路径
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import { createDb } from '../db-adapter.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}

const TMP = join(os.tmpdir(), 'opencode', 'handler-smoke-test')
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
mkdirSync(TMP, { recursive: true })
const WS = join(TMP, 'ws')
mkdirSync(join(WS, 'src'), { recursive: true })
writeFileSync(join(WS, 'src', 'auth.js'), 'function fooBar() {}\nclass User {}\nconst dbConn = 1')

const imp = (p) => import(pathToFileURL(p).href)

// ══════════ tool-feedback ══════════
{
  const fb = await imp(join(__dirname, '..', 'tools', 'tool-feedback', 'handler.js'))
  const noIssue = await fb.handle({ tool: 'x' }, {})
  assert(noIssue.error === 'missing_parameter', 'feedback 缺 issue 返回 missing_parameter')

  const oldHome = process.env.HOME
  process.env.HOME = TMP
  const ok = await fb.handle({ tool: 'test_tool', issue: 'smoke test', note: 'n', error_code: 'E1' }, {})
  process.env.HOME = oldHome
  assert(ok.status === 'recorded' && ok.path, 'feedback 有 issue 返回 recorded+path')
  const lines = readFileSync(ok.path, 'utf-8').trim().split('\n').map(l => JSON.parse(l))
  assert(lines.length === 1 && lines[0].issue === 'smoke test', 'feedback 条目落盘且含 issue')
  assert(lines[0].tool === 'test_tool' && lines[0].error_code === 'E1', 'feedback 条目含 tool/error_code')
}

// ══════════ tool-gc ══════════
{
  const gc = await imp(join(__dirname, '..', 'tools', 'tool-gc', 'handler.js'))
  const r = await gc.handle({}, {})
  assert(r.error === 'gc_not_available', 'gc 无 --expose-gc 返回 gc_not_available')
  assert(r.memory?.heap_used_mb >= 0, 'gc 错误路径带 memory 结构')
}

// ══════════ tool-health ══════════
{
  const h = await imp(join(__dirname, '..', 'tools', 'tool-health', 'handler.js'))
  const noSvc = await h.handle({ action: 'check' }, {})
  assert(noSvc.error === 'service_unavailable', 'health 无 runHealthCheck 返回 service_unavailable')

  const mockHealth = { status: 'ok', checks: [{ status: 'PASS', name: 'heap' }], heap_used_mb: 100, requests_served: 7 }
  const ctx = { runHealthCheck: async () => mockHealth, stateDir: TMP }
  const r = await h.handle({ action: 'check' }, ctx)
  assert(r.status === 'ok' && r.checks?.[0]?.status === 'PASS', `health check 路径透传 runHealthCheck 结果（${JSON.stringify(r)}）`)
}

// ══════════ tool-naming-consistency ══════════
{
  const nc = await imp(join(__dirname, '..', 'tools', 'tool-naming-consistency', 'handler.js'))
  const noWs = await nc.handle({}, {})
  assert(noWs.error_code === 'INVALID_INPUT', 'naming 缺 workspace_dir 返回 INVALID_INPUT')
  const noFile = await nc.handle({ workspace_dir: WS }, {})
  assert(noFile.error_code === 'INVALID_INPUT', 'naming 缺 file 返回 INVALID_INPUT')
  const blocked = await nc.handle({ workspace_dir: WS, file: '../../etc/passwd' }, {})
  assert(blocked.error_code === 'PATH_BLOCKED', 'naming 穿越路径返回 PATH_BLOCKED')

  const db = await createDb(join(WS, 'code-index.db'))
  db.exec(`CREATE TABLE files (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT UNIQUE NOT NULL, repo TEXT NOT NULL DEFAULT '');
CREATE TABLE symbols (id INTEGER PRIMARY KEY AUTOINCREMENT, file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE, name TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('function','class','variable','method','export','import','interface','type')), signature TEXT DEFAULT '', start_line INTEGER NOT NULL, end_line INTEGER NOT NULL DEFAULT 0, parent_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL);`)
  const fid = db.prepare('INSERT INTO files (path) VALUES (?)').run('src/auth.js').lastInsertRowid
  db.prepare('INSERT INTO symbols (file_id, name, type, start_line) VALUES (?,?,?,?)').run(fid, 'foo_bar', 'function', 1)
  db.prepare('INSERT INTO symbols (file_id, name, type, start_line) VALUES (?,?,?,?)').run(fid, 'another_fn', 'function', 2)
  db.close()

  const ctx = { getWorkspaceDir: (p) => p }
  const good = await nc.handle({ workspace_dir: WS, file: 'src/auth.js', new_symbols: ['proper_name'], lang: 'javascript' }, ctx)
  assert(!good.error && Array.isArray(good.issues), `naming 成功路径返回 issues 数组（${JSON.stringify(good.error)}）`)
  const style = await nc.handle({ workspace_dir: WS, file: 'src/auth.js', new_symbols: ['camelWrong'], lang: 'javascript' }, ctx)
  const styleIssue = Array.isArray(style.issues) && style.issues.find(i => String(i.symbol || i.name) === 'camelWrong')
  assert(styleIssue, `naming 检出风格不一致符号（${JSON.stringify(style).slice(0, 200)}）`)
}

// ══════════ tool-reindex ══════════
{
  const ri = await imp(join(__dirname, '..', 'tools', 'tool-reindex', 'handler.js'))
  const noSvc = await ri.handle({}, {})
  assert(noSvc.error_code === 'SERVICE_UNAVAILABLE', 'reindex 无 service 返回 SERVICE_UNAVAILABLE')
  const badDir = await ri.handle({ workspace_dir: join(TMP, 'nonexistent') }, { codeIndexService: {} })
  assert(badDir.error_code === 'INVALID_INPUT', 'reindex workspace_dir 不存在返回 INVALID_INPUT')

  const indexing = await ri.handle({}, { codeIndexService: { indexing: true, indexProgress: { indexed: 5, total: 10, workspaceDir: WS, startTime: Date.now() } } })
  assert(indexing.status === 'indexing' && indexing.progress_pct === 50, 'reindex 索引中返回 progress 50%')

  const done = await ri.handle({}, { codeIndexService: { indexing: false, lastIndexed: { workspace_dir: WS, files: 3, symbols: 10, refs: 2, completed_at: 'x' } } })
  assert(done.status === 'completed' && done.files_indexed === 3, 'reindex 已索引返回 completed')

  const fresh = await ri.handle({}, { codeIndexService: { indexing: false } })
  assert(fresh.status === 'not_started', 'reindex 从未索引返回 not_started')

  const realSvc = {
    initWorkspace: () => {},
    indexing: false,
    indexProgress: null,
    reindex: async (dir, opts) => ({ status: 'started', files: 2 }),
  }
  const started = await ri.handle({ workspace_dir: WS, maxFiles: 100 }, { codeIndexService: realSvc, log: () => {} })
  assert(started.status === 'started' || started.status === 'queued' || started.status === 'completed',
    `reindex 真实路径启动（${started.status}）`)
}

// ══════════ tool-repo-map ══════════
{
  const rm = await imp(join(__dirname, '..', 'tools', 'tool-repo-map', 'handler.js'))
  const noWs = await rm.handle({}, {})
  assert(noWs.error === 'missing_parameter', 'repo-map 缺 workspace_dir 返回 missing_parameter')
  const notIdx = await rm.handle({ workspace_dir: join(TMP, 'unindexed') }, { getWorkspaceDir: (p) => p, repoMapService: {} })
  assert(notIdx.error === 'workspace_not_indexed', 'repo-map 未索引返回 workspace_not_indexed')
  const noSvc = await rm.handle({ workspace_dir: WS }, { getWorkspaceDir: (p) => p })
  assert(noSvc.error === 'service_unavailable', 'repo-map 无 service 返回 service_unavailable')

  const mockService = { generate: async (root, opts) => ({ map: 'ws/\n└── src/\n    └── auth.js\n', files: 1, tokens: 10 }) }
  const ok = await rm.handle({ workspace_dir: WS }, { getWorkspaceDir: (p) => p, repoMapService: mockService })
  assert(ok.map && ok.map.includes('auth.js'), 'repo-map 成功路径返回 map')
  assert(ok.files === 1 && ok.tokens === 10, 'repo-map 返回 files/tokens')
}

// ══════════ tool-write-symbols ══════════
{
  const ws = await imp(join(__dirname, '..', 'tools', 'tool-write-symbols', 'handler.js'))
  const noWs = await ws.handle({}, {})
  assert(noWs.success === false && noWs.error?.code === 'missing_parameter', 'write-symbols 缺 workspace_dir 返回错误')
  const noLoc = await ws.handle({ workspace_dir: WS }, {})
  assert(noLoc.error?.code === 'missing_parameter', 'write-symbols 缺 locator 返回错误')
  const blocked = await ws.handle({ workspace_dir: WS, writes: [{ file_path: '../../x.js', content: 'x' }] }, {})
  assert(blocked.error?.code === 'PATH_BLOCKED', 'write-symbols 穿越路径返回 PATH_BLOCKED')
  const notFound = await ws.handle({ workspace_dir: WS, writes: [{ file_path: 'no/such.js', content: 'x' }] }, { getWorkspaceDir: (p) => p })
  assert(notFound.error?.code === 'FILE_NOT_FOUND', 'write-symbols 文件不存在返回 FILE_NOT_FOUND')
}

try { rmSync(TMP, { recursive: true, force: true }) } catch {}
console.log(`== test-handler-smoke: ${pass} passed, ${fail} failed ==`)
if (fail > 0) process.exit(1)
