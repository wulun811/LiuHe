// test-batch-collector-chain.js — Windows 路径形态回归：collectFilesWithDirStats → indexBatch 全链路
// 根因：file-collector 产出正斜杠绝对路径（full.replace(/\\/g, '/')），
//       code-index 旧 statMap 查找用 join(repo, r.path)——win32 产反斜杠 → Map 键永 miss：
//       files.size 全 0（outline tokens_estimate 恒 0），content_hash 依赖「CWD==工作区根」的相对路径兜底。
// 本测试锁死全链路不变量：索引完成后 size > 0 且 content_hash 为 64 位 sha256。
// POSIX 上两形态天然一致（修复前后都过）；Windows 上修复前必失败——这正是它此前漏测的原因。
import { join, dirname } from 'node:path'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}

const WS = join(os.tmpdir(), 'opencode', 'batch-chain-ws')
const STATE = join(os.tmpdir(), 'opencode', 'batch-chain-state')
for (const d of [WS, STATE]) { try { rmSync(d, { recursive: true, force: true }) } catch {} }
mkdirSync(join(WS, 'src'), { recursive: true })
mkdirSync(STATE, { recursive: true })
writeFileSync(join(WS, 'src/app.js'), 'export function hot() {\n  return 41 + 1\n}\n')
writeFileSync(join(WS, 'src/util.js'), 'export function id(x) { return x }\n')

const pc = await import(pathToFileURL(join(__dirname, '..', 'parse-client.js')).href)
await pc.init({ log: () => {} })
try { await pc.connect() } catch {}
const { collectFilesWithDirStats } = await import(pathToFileURL(join(__dirname, '..', 'file-collector.js')).href)
const { default: codeIndex } = await import(pathToFileURL(join(__dirname, '..', 'code-index.js')).href)

const services = { langParser: {
  extractAllAsync: (s, e, f, ws) => pc.extractAll(s, e, f, ws),
  hasErrorsAsync: (s, e, f, ws) => pc.hasErrors(s, e, f, ws),
  batchExtractAsync: (f, ws) => pc.batchExtract(f, ws),
}}
const core = {
  services,
  getService: (n) => services[n],
  registerService: (n, svc) => { services[n] = svc },
  getWorkspaceDir: () => STATE,
  log: () => {},
  emit: () => {},
  get: (k, def) => def,
}
await codeIndex.init(core)
const svc = services.codeIndex
await svc.initWorkspace(WS)

// 关键：必须走真实收集器（正斜杠路径形态）。手工拼反斜杠路径会绕过 bug，测了个寂寞。
const { files } = collectFilesWithDirStats(WS, { maxFiles: 0, hardCap: 0 })
assert(files.length === 2, `collector found 2 files, got ${files.length}`)
const winSlash = process.platform === 'win32'
if (winSlash) {
  assert(files.every(f => !f.path.includes('\\')), 'collector paths use forward slashes (precondition of the regression)')
}

const r = await svc.indexBatch(files.map(f => f.path), WS)
assert(Array.isArray(r) && r.length === 2, `indexBatch indexed 2 files, got ${r.length}`)

const dbPath = join(STATE, 'code-index.db')
assert(existsSync(dbPath), `state DB exists at ${dbPath}`)
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)
const Database = require2('better-sqlite3')
const db = Database(dbPath, { readonly: true })
const rows = db.prepare('SELECT path, size, content_hash FROM files ORDER BY path').all()
db.close()
assert(rows.length === 2, `DB has 2 file rows, got ${rows.length}`)
for (const row of rows) {
  assert(row.size > 0, `${row.path}: size > 0 (got ${row.size})`)
  assert(typeof row.content_hash === 'string' && row.content_hash.length === 64, `${row.path}: content_hash is sha256 (len ${row.content_hash ? row.content_hash.length : 'null'})`)
}

try { rmSync(WS, { recursive: true, force: true }) } catch {}
try { rmSync(STATE, { recursive: true, force: true }) } catch {}
console.log(`pass=${pass} fail=${fail}`)
process.exit(fail ? 1 : 0)
