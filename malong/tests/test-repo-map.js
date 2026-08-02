// test-repo-map.js — Repo Map 生成器（r34：此前 repo-map.js 224 行零测试）
// 用临时 code-index.db（与 code-index.js SCHEMA 一致）+ mock core 端到端测 generate/
// generateFocused/缓存/未索引路径
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import { createDb } from '../db-adapter.js'
import * as repoMap from '../repo-map.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}

const WS = join(os.tmpdir(), 'opencode', 'repo-map-test-ws')
rmSync(WS, { recursive: true, force: true })
mkdirSync(WS, { recursive: true })

// ── 建 code-index.db（schema 对齐 code-index.js）──
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
const fA = insFile.run('src/auth.js').lastInsertRowid
const fB = insFile.run('src/util/helper.py').lastInsertRowid
const fC = insFile.run('tests/test_auth.js').lastInsertRowid
for (const [fid, rows] of [
  [fA, [['login', 'function', 1], ['User', 'class', 10], ['DB', 'variable', 5]]],
  [fB, [['helper_fn', 'function', 3]]],
  [fC, [['test_login', 'function', 1]]],
]) {
  for (const [name, type, line] of rows) insSym.run(fid, name, type, line)
}
db.close()

// ── mock core ──
const registered = {}
const core = {
  getWorkspaceDir: (p) => p,
  registerService: (name, svc) => { registered[name] = svc },
  getService: () => null,
  log: () => {},
}
await repoMap.init(core)
await repoMap.start()
const svc = registered.repoMap
assert(!!svc, 'init 注册 repoMap 服务')

// ── generate：完整地图 ──
const r1 = await svc.generate(WS)
assert(!r1.error, `generate 成功（${JSON.stringify(r1.error)}）`)
assert(r1.files === 3, `generate 统计 3 个文件（实际 ${r1.files}）`)
assert(r1.tokens > 0, 'generate 返回 token 估算')
assert(r1.map.includes('auth.js'), '地图含 src/auth.js')
assert(r1.map.includes('login'), '地图含 login 符号')
assert(r1.map.includes('User'), '地图含 User 类')
assert(r1.map.includes('helper_fn'), '地图含 helper.py 符号')
assert(r1.map.includes('test_login'), '地图含测试文件符号')
assert(r1.map.includes('fn login:1'), '符号行渲染 fn login:1')
assert(r1.map.includes('cls User:10'), '类渲染 cls User:10')
assert(r1.map.includes('var DB:5'), '变量渲染 var DB:5')
assert(r1.map.startsWith(basename(WS) + '/') || r1.map.includes(basename(WS) + '/'), '地图根为 workspace 名')
assert(r1.map.includes('└──') || r1.map.includes('├──'), '地图使用树形渲染')

// ── getSummary 缓存 ──
const s1 = svc.getSummary()
assert(s1 && s1.files === 3 && s1.cached === true, 'getSummary 返回缓存（cached=true）')
assert(s1.map === r1.map, '缓存 map 与生成一致')
const s2 = svc.invalidate()
assert(s2 === true, 'invalidate 返回 true')
const s3 = svc.getSummary()
assert(s3 === null, 'invalidate 后 getSummary 为 null')

// ── generateFocused：relevantEntities 过滤 ──
const f1 = await svc.generateFocused(WS, { relevantEntities: ['login', 'User'] })
assert(!f1.error, 'generateFocused 成功')
assert(f1.map.includes('login') && f1.map.includes('User'), '过滤后保留目标实体')
assert(!f1.map.includes('helper_fn'), '过滤后排除非目标实体')
assert(!f1.map.includes('test_login'), '过滤后排除其他文件实体')

// ── generateFocused：relevantFiles 过滤（绝对路径）──
const f2 = await svc.generateFocused(WS, { relevantFiles: [join(WS, 'src/auth.js')] })
assert(f2.map.includes('auth.js'), 'relevantFiles 绝对路径保留目标文件')
assert(!f2.map.includes('helper.py'), 'relevantFiles 排除其他文件')
assert(!f2.map.includes('test_auth.js'), 'relevantFiles 排除测试文件')

// ── generateFocused：relevantFiles 相对路径 ──
const f3 = await svc.generateFocused(WS, { relevantFiles: ['src/auth.js'] })
assert(f3.map.includes('login'), '相对路径 relevantFiles 生效')

// ── 历史库带 basename 前缀路径归一化 ──
const WS2 = join(WS, 'subproj')
mkdirSync(WS2, { recursive: true })
const db2 = await createDb(join(WS2, 'code-index.db'))
db2.exec(`CREATE TABLE files (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT UNIQUE NOT NULL, repo TEXT NOT NULL DEFAULT '');
CREATE TABLE symbols (id INTEGER PRIMARY KEY AUTOINCREMENT, file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE, name TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('function','class','variable','method','export','import','interface','type')), signature TEXT DEFAULT '', start_line INTEGER NOT NULL, end_line INTEGER NOT NULL DEFAULT 0, parent_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL);`)
const f = db2.prepare('INSERT INTO files (path) VALUES (?)').run('subproj/src/main.js').lastInsertRowid
db2.prepare('INSERT INTO symbols (file_id, name, type, start_line) VALUES (?, ?, ?, ?)').run(f, 'mainFn', 'function', 1)
db2.close()
const g1 = await svc.generate(WS2)
assert(g1.files === 1, `带前缀历史库归一化后 1 个文件（实际 ${g1.files}）`)
assert(g1.map.includes('mainFn'), '带前缀历史库符号可见')
assert(!g1.map.includes('subproj/subproj'), '前缀未重复')

// ── 未索引 workspace ──
const EMPTY = join(WS, 'empty-dir')
mkdirSync(EMPTY, { recursive: true })
const e1 = await svc.generate(EMPTY)
assert(e1.error === 'workspace_not_indexed', `未索引返回 workspace_not_indexed（实际 ${e1.error}）`)
assert(String(e1.suggestion).includes('reindex'), '未索引返回 reindex 建议')

// ── stop 清缓存 ──
await repoMap.stop()
assert(svc.getSummary() === null, 'stop 后缓存清空')

rmSync(WS, { recursive: true, force: true })
console.log(`== test-repo-map: ${pass} passed, ${fail} failed ==`)
if (fail > 0) process.exit(1)
