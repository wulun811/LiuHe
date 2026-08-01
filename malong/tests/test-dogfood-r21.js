// r21：_resolveCrossFileRefs 只绑裸调用——成员调用（obj.slice()/byFile.get()）不跨文件绑同名符号
// 场景：app.js 调 helper.run()（成员），other.js 有裸函数 run()——成员调用不得绑到它
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import Database from 'better-sqlite3'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MALONG_DIR = join(__dirname, '..')
const WS = '/tmp/opencode/r21-ws'
const DATA = '/tmp/opencode/r21-data'
const SOCK = '/tmp/opencode/r21-code-index.sock'

rmSync(WS, { recursive: true, force: true })
rmSync(DATA, { recursive: true, force: true })
for (const d of [WS, DATA]) mkdirSync(d, { recursive: true })

let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`) }
  else { fail++; console.log(`  ✗ ${msg}`) }
}

// ① app.js：成员调用 helper.run + 裸调用 process；② other.js：同名裸函数 run
writeFileSync(`${WS}/app.js`, `const helper = { run: (x) => x * 2 }\nexport function process(data) {\n  return helper.run(data)\n}\nexport function query() {\n  return process(2)\n}\n`)
writeFileSync(`${WS}/other.js`, `export function run() {\n  return 42\n}\n`)

const pc = await import(join(MALONG_DIR, 'parse-client.js'))
await pc.init({ log: () => {} })
await pc.connect()

const { default: codeIndex } = await import(join(MALONG_DIR, 'code-index.js'))
const langParser = {
  extractAllAsync: (source, ext, filePath) => pc.extractAll(source, ext, filePath),
  extractReferencesAsync: (source, ext) => pc.extractReferences(source, ext),
  batchExtractAsync: (files) => pc.batchExtract(files),
}
const services = { langParser }
const core = {
  services,
  getService: (n) => services[n],
  registerService: (n, svc) => { services[n] = svc },
  getWorkspaceDir: () => DATA,
  log: () => {},
  emit: () => {},
  get: (key, def) => key === 'codeIndex.udsPath' ? SOCK : (key === 'codeIndex.udsToken' ? '' : def),
}
await codeIndex.init(core)
const svc = services.codeIndex
svc.initWorkspace(WS)
await svc.indexBatch([`${WS}/app.js`, `${WS}/other.js`], WS)
svc.resolveCrossFileRefs()

const db = new Database(join(DATA, 'code-index.db'), { readonly: true })
const appFile = db.prepare('SELECT id FROM files WHERE path = ?').get('app.js')

// ② 成员调用 run 不得绑定到 other.js 的裸函数 run
const runRefs = db.prepare("SELECT r.target_symbol_id, r.call_expr FROM refs r WHERE r.source_file_id = ? AND r.target_name = 'run'").all(appFile.id)
assert(runRefs.length >= 1, `app.js 有 run 调用 ref（${runRefs.length} 条）`)
for (const r of runRefs) {
  assert(r.target_symbol_id === null, `成员调用 run（call_expr="${r.call_expr}"）不跨文件绑定（得 ${r.target_symbol_id}）`)
}

// ③ 裸调用 process 绑定到自身符号
const processRef = db.prepare("SELECT r.target_symbol_id FROM refs r WHERE r.source_file_id = ? AND r.target_name = 'process'").get(appFile.id)
const processSym = processRef?.target_symbol_id
  ? db.prepare('SELECT name, file_id FROM symbols WHERE id = ?').get(processRef.target_symbol_id)
  : null
assert(processSym && processSym.name === 'process', `裸调用 process 绑到自身（得 ${JSON.stringify(processSym)}）`)

db.close()
await pc.close?.()

console.log(`\n== test-dogfood-r21: ${pass} passed, ${fail} failed ==`)
rmSync(WS, { recursive: true, force: true })
rmSync(DATA, { recursive: true, force: true })
process.exit(fail > 0 ? 1 : 0)
