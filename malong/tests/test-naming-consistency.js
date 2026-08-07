// test-naming-consistency.js — 命名一致性（Y001-S3 补测）
// 覆盖：风格检测（snake dominant）/ 风格不一致建议 / 语义动词不一致（阈值 2x）/ 框架豁免 /
//       CONSTANT_CASE 跳过 / 无索引 / 语言校验 / 参数校验 / 项目符号不足 note
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import Database from 'better-sqlite3'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}
const { handle } = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-naming-consistency', 'handler.js')).href)

const ws = join(os.tmpdir(), 'opencode', 'nc-test-ws')
try { rmSync(ws, { recursive: true, force: true }) } catch {}
mkdirSync(ws, { recursive: true })
const dbPath = join(ws, 'code-index.db')

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT UNIQUE NOT NULL,
  repo TEXT NOT NULL DEFAULT '',
  size INTEGER DEFAULT 0,
  mtime INTEGER DEFAULT 0,
  indexed_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS symbols (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  signature TEXT DEFAULT '',
  start_line INTEGER NOT NULL,
  end_line INTEGER DEFAULT 0,
  parent_id INTEGER
);
`
function seed(rows) {
  const db = new Database(dbPath)
  db.exec('DROP TABLE IF EXISTS symbols; DROP TABLE IF EXISTS files;')
  db.exec(SCHEMA)
  db.prepare('INSERT INTO files (path) VALUES (?)').run('src/app.py')
  const ins = db.prepare('INSERT INTO symbols (file_id, name, type, start_line) VALUES (1, ?, ?, 1)')
  for (const [name, type] of rows) ins.run(name, type)
  db.close()
}

const ctx = { getWorkspaceDir: () => ws }

// ── ① snake 主导项目 + snake 新符号 → 无风格 issue ──
{
  seed([['fetch_user', 'function'], ['save_user', 'function'], ['delete_user', 'function'], ['parse_name', 'function'], ['load_all', 'function']])
  const r = await handle({ workspace_dir: ws, file: 'src/new.py', new_symbols: ['get_user'] }, ctx)
  assert(r.project_style.dominant === 'snake_case', `① dominant snake_case（得 ${r.project_style.dominant}）`)
  assert(r.issues.length === 0, `① snake 符号无 issue（得 ${JSON.stringify(r.issues)}）`)
}

// ── ② camelCase 新符号 → style_inconsistency + snake 化建议 ──
{
  seed([['fetch_user', 'function'], ['save_user', 'function'], ['delete_user', 'function'], ['parse_name', 'function'], ['load_all', 'function']])
  const r = await handle({ workspace_dir: ws, file: 'src/new.py', new_symbols: ['getUser'] }, ctx)
  assert(r.issues.length === 1 && r.issues[0].issue === 'style_inconsistency', `② 风格不一致检出（得 ${JSON.stringify(r.issues.map(i => i.issue))}）`)
  assert(r.issues[0].suggestion === 'get_user', `② 建议 snake 化（得 ${r.issues[0].suggestion}）`)
}

// ── ③ 语义动词不一致：项目用 fetch（3+ 次）检查 get → semantic_inconsistency（阈值 2x） ──
{
  seed([['fetch_user', 'function'], ['fetch_order', 'function'], ['fetch_item', 'function'], ['save_user', 'function'], ['delete_user', 'function']])
  const r = await handle({ workspace_dir: ws, file: 'src/new.py', new_symbols: ['get_profile'] }, ctx)
  const sem = r.issues.filter(i => i.issue === 'semantic_inconsistency')
  assert(sem.length === 1 && sem[0].suggestion === 'fetch_profile', `③ fetch 3 次 vs get 0 → 建议 fetch_profile（得 ${JSON.stringify(r.issues.map(i => i.suggestion))}）`)
  assert(sem[0].strength === 1, `③ strength 计算（得 ${sem[0].strength}）`)
}

// ── ④ 项目里 get 也用得多（2+）→ 不报（不满足 2x 阈值） ──
{
  seed([['fetch_user', 'function'], ['fetch_order', 'function'], ['fetch_item', 'function'], ['get_user', 'function'], ['get_order', 'function'], ['save_user', 'function'], ['delete_user', 'function']])
  const r = await handle({ workspace_dir: ws, file: 'src/new.py', new_symbols: ['get_profile'] }, ctx)
  const sem = r.issues.filter(i => i.issue === 'semantic_inconsistency')
  assert(sem.length === 0, `④ get 2 次不满足 2x → 不报（得 ${JSON.stringify(r.issues)}）`)
}

// ── ⑤ 框架惯用豁免 + CONSTANT_CASE 跳过 ──
{
  seed([['fetch_user', 'function'], ['save_user', 'function'], ['delete_user', 'function'], ['parse_name', 'function'], ['load_all', 'function']])
  const r = await handle({ workspace_dir: ws, file: 'src/new.py', new_symbols: ['main', 'MAX_RETRY'] }, ctx)
  assert(r.issues.length === 0, `⑤ main/MAX_RETRY 豁免（得 ${JSON.stringify(r.issues)}）`)
}

// ── ⑥ 错误与边界 ──
{
  const noIndex = await handle({ workspace_dir: ws, file: 'x.py', new_symbols: ['a'] }, { getWorkspaceDir: () => join(os.tmpdir(), 'opencode', 'nc-noindex') })
  assert(noIndex.error_code === 'INDEX_STALE', '⑥ 无索引 → INDEX_STALE')
  const badLang = await handle({ workspace_dir: ws, file: 'x.php', new_symbols: ['a'] }, ctx)
  assert(badLang.error_code === 'INVALID_INPUT' && badLang.supported, '⑥ 不支持语言')
  const notArr = await handle({ workspace_dir: ws, file: 'x.py', new_symbols: 'get_user' }, ctx)
  assert(notArr.error_code === 'INVALID_INPUT', '⑥ new_symbols 非数组')
  const noSymbols = await handle({ workspace_dir: ws, file: 'x.py', new_symbols: [] }, ctx)
  assert(noSymbols.note && noSymbols.note.includes('no symbols'), '⑥ 空 new_symbols note')
  const emptyProject = await handle({ workspace_dir: ws, file: 'x.rs', new_symbols: ['foo'] }, ctx)
  assert(emptyProject.note && emptyProject.note.includes('insufficient'), `⑥ 项目无该语言符号 note（得 ${emptyProject.note}）`)
}

try { rmSync(ws, { recursive: true, force: true }) } catch {}

console.log(`== test-naming-consistency: ${pass} passed, ${fail} failed ==`)
if (fail > 0) process.exit(1)
