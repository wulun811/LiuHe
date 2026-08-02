// test-dogfood-r15.js — 第 15 轮：第二轮 UX 报告炸出的 5 个问题回归
// P0 单文件 indexFile 重抽清空跨文件 ref 绑定（FK ON DELETE SET NULL 后不重 resolve）
// P1 .malong/.ai-transactions 备份目录被 walkAndIndex 索引进项目
// P2 rename_symbol 别名绑定文件裸 token 连坐（process.env 是 Node 全局）
// P3a CJS 解构别名缺 per-local import ref（references 掉 text_fallback 标 "reference"）
// P3b write_symbol 两处文案（insert_after_symbol 提示 / FILE_CHANGED 建议）
// 依赖：malong-parse 服务在跑。起真实 code-index（mock core + parse-client 做 langParser）+ 直接调 handler。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import Database from 'better-sqlite3'

const __dirname = dirname(fileURLToPath(import.meta.url))
const imp = (p) => import(pathToFileURL(p).href)
const MALONG_DIR = join(__dirname, '..')

let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}

const WS = '/tmp/opencode/r15-ws'
const DATA = '/tmp/opencode/r15-data'
const SOCK = '/tmp/opencode/r15-code-index.sock'

rmSync(WS, { recursive: true, force: true })
rmSync(DATA, { recursive: true, force: true })
for (const d of [WS, DATA]) mkdirSync(d, { recursive: true })

// 夹具：CJS 解构别名 + Node 全局 process.env 混用（P2 的连坐场景）+ ESM 引用
writeFileSync(`${WS}/lib.js`, `function process(data, attempt) {\n  return { ok: true }\n}\nmodule.exports = { process }\n`)
writeFileSync(`${WS}/app.js`, `const { process: libProcess } = require('./lib.js');\nconst MAX_RETRIES = 3;\nfunction getConfig() { return process.env.API_KEY || 'default'; }\nfunction handle(data) {\n  let result = libProcess(data, 1)\n  return result\n}\nmodule.exports = { handle, getConfig }\n`)
writeFileSync(`${WS}/esm-lib.mjs`, `export function helper() { return 1 }\n`)
writeFileSync(`${WS}/esm-app.mjs`, `import { helper } from './esm-lib.mjs';\nexport function run() { return helper() }\n`)
// P1 夹具：写管线的 journal / 碰撞备份（修复前会被 watcher/walk 索引进项目）
mkdirSync(`${WS}/.malong/journal/txn_x/backup`, { recursive: true })
mkdirSync(`${WS}/.ai-transactions/txn_y/backup`, { recursive: true })
writeFileSync(`${WS}/.malong/journal/txn_x/backup/lib.js`, `function process(data) { return data }\n`)
writeFileSync(`${WS}/.ai-transactions/txn_y/backup/app.js`, `const { process: p } = require('./lib.js');\n`)

const libJs = join(WS, 'lib.js')
const appJs = join(WS, 'app.js')
const esmLibJs = join(WS, 'esm-lib.mjs')
const esmAppJs = join(WS, 'esm-app.mjs')

const pc = await imp(join(MALONG_DIR, 'parse-client.js'))
await pc.init({ log: () => {} })
const connected = await pc.connect()
assert(connected, 'parse-client 连接到 malong-parse')

const { default: codeIndex } = await imp(join(MALONG_DIR, 'code-index.js'))
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
await svc.indexBatch([libJs, appJs, esmLibJs, esmAppJs], WS)

const db2 = new Database(join(DATA, 'code-index.db'))
db2.pragma('busy_timeout=5000')
const q = (sql, ...p) => db2.prepare(sql).get(...p)
const qa = (sql, ...p) => db2.prepare(sql).all(...p)

// ── P0：单文件重抽后跨文件 ref 绑定必须存活 ──
const libProcessRef = q("SELECT r.id, r.target_symbol_id FROM refs r JOIN files f ON r.source_file_id=f.id WHERE f.path='app.js' AND r.target_name='libProcess' AND r.kind='call'")
const libSym = q("SELECT name, file_id FROM symbols WHERE id = ?", libProcessRef.target_symbol_id)
assert(libSym.name === 'process', `P0 初始：别名 call ref 绑定到 process（得 ${JSON.stringify(libSym)}）`)

await svc.indexFile(libJs, WS) // 模拟写完 lib.js 后的单文件重抽
const afterReindex = q("SELECT target_symbol_id FROM refs WHERE id = ?", libProcessRef.id)
const afterSym = afterReindex.target_symbol_id ? q("SELECT name, file_id FROM symbols WHERE id = ?", afterReindex.target_symbol_id) : null
assert(afterReindex.target_symbol_id && afterSym.name === 'process', `P0 单文件重抽后别名 ref 绑定存活且指向 process（id ${libProcessRef.target_symbol_id}→${afterReindex.target_symbol_id}，得 ${JSON.stringify(afterSym)}）`)

// P0-ESM：esm-app 的 helper call ref 同样存活
const esmCallRef = q("SELECT r.id, r.target_symbol_id FROM refs r JOIN files f ON r.source_file_id=f.id WHERE f.path='esm-app.mjs' AND r.target_name='helper' AND r.kind='call'")
assert(esmCallRef && esmCallRef.target_symbol_id, 'P0 初始：ESM helper call ref 已绑定')
await svc.indexFile(esmLibJs, WS)
const esmAfter = q("SELECT target_symbol_id FROM refs WHERE id = ?", esmCallRef.id)
const esmAfterSym = esmAfter.target_symbol_id ? q("SELECT name FROM symbols WHERE id = ?", esmAfter.target_symbol_id) : null
assert(esmAfter.target_symbol_id && esmAfterSym.name === 'helper', `P0 单文件重抽后 ESM ref 绑定存活（id ${esmCallRef.target_symbol_id}→${esmAfter.target_symbol_id}）`)

// P0-新文件：单文件路径新建的导入文件，别名 ref 也要被绑定
writeFileSync(`${WS}/new.js`, `const { process: p2 } = require('./lib.js');\nmodule.exports = { get: () => p2({ a: 1 }, 0) }\n`)
await svc.indexFile(join(WS, 'new.js'), WS)
const p2Ref = q("SELECT r.id, r.target_symbol_id FROM refs r JOIN files f ON r.source_file_id=f.id WHERE f.path='new.js' AND r.target_name='p2' AND r.kind='call'")
const p2Sym = p2Ref.target_symbol_id ? q("SELECT name, file_id FROM symbols WHERE id = ?", p2Ref.target_symbol_id) : null
assert(p2Sym && p2Sym.name === 'process', `P0 新文件单文件路径别名 ref 同样重绑定（得 ${JSON.stringify(p2Sym)}）`)

// ── P1：.malong / .ai-transactions 不进索引 ──
const fc = await imp(join(MALONG_DIR, 'file-collector.js'))
assert(fc.DEFAULT_IGNORE_DIRS.has('.malong') && fc.DEFAULT_IGNORE_DIRS.has('.ai-transactions'), 'P1 忽略清单含 .malong/.ai-transactions')
await svc.indexProject(WS, { timeout: 60000 })
const backupRows = qa("SELECT path FROM files WHERE path LIKE '.malong/%' OR path LIKE '.ai-transactions/%'")
assert(backupRows.length === 0, `P1 walkAndIndex 不索引备份目录（得 ${backupRows.map(r => r.path).join(',') || '无'}）`)

// ── P2：rename_symbol 别名绑定文件只改 import 行 ──
const rename = await imp(join(MALONG_DIR, 'tools', 'tool-rename-symbol', 'handler.js'))
const renameRes = await rename.handle(
  { workspace_dir: WS, file: 'lib.js', symbol: 'process', new_name: 'retryProcess', dry_run: true },
  { codeIndexService: svc, getWorkspaceDir: () => DATA },
)
const appEdits = renameRes.edits_per_file.find(e => e.file === 'app.js')
assert(appEdits, `P2 rename 预览含 app.js（得 ${JSON.stringify(renameRes.edits_per_file.map(e => e.file))}）`)
const appLines = appEdits ? appEdits.edits.map(e => e.line) : []
assert(appLines.includes(1) && !appLines.includes(3), `P2 app.js 只改 import 行 1，不改 process.env 行 3（得行 ${JSON.stringify(appLines)}）`)
const appEdit1 = appEdits.edits.find(e => e.line === 1)
assert(appEdit1 && appEdit1.new.includes('retryProcess: libProcess'), `P2 import 行正确改模块侧名（得 ${appEdit1 && appEdit1.new}）`)
const libEdits = renameRes.edits_per_file.find(e => e.file === 'lib.js')
assert(libEdits && libEdits.edits.some(e => e.new.includes('function retryProcess')), `P2 定义文件正常改名（${libEdits && libEdits.edits.length} 处）`)

// ── P3a：CJS 解构别名补 per-local import ref（kind=import）──
const localImportRef = q("SELECT r.kind FROM refs r JOIN files f ON r.source_file_id=f.id WHERE f.path='app.js' AND r.target_name='libProcess' AND r.kind='import'")
assert(localImportRef, 'P3a app.js 有 libProcess 的 per-local import ref')
const refsTool = await imp(join(MALONG_DIR, 'tools', 'tool-references', 'handler.js'))
const refsRes = await refsTool.handle({ workspace_dir: WS, symbol: 'libProcess' }, { codeIndexService: svc, getWorkspaceDir: () => DATA })
assert(refsRes.search_method !== 'text_fallback' && refsRes.results.some(r => r.path === 'app.js' && r.kind === 'import' && r.line === 1), `P3a references(libProcess) 走 DB 且绑定行标 import（得 ${refsRes.search_method || 'db'} ${JSON.stringify(refsRes.results)}}）`)

// ── P3b-1：insert_after_symbol 对不存在符号返回 patch 提示 ──
const ws = await imp(join(MALONG_DIR, 'tools', 'tool-write-symbol', 'handler.js'))
const insertRes = await ws.handle(
  { workspace_dir: WS, file: 'app.js', locator: { file_path: 'app.js', name: 'nonexistent_fn', kind: 'function' }, edit_mode: 'insert_after_symbol', content: 'function nonexistent_fn() { return 1 }', patch: { old_string: 'x', new_string: 'x' }, base_version: { file: { hash: 'sha256:0' }, symbol: null } },
  { codeIndexService: svc, getWorkspaceDir: () => DATA },
)
assert(insertRes.error && insertRes.error.code === 'SYMBOL_NOT_FOUND', `P3b-1 insert_after_symbol 对不存在符号报 SYMBOL_NOT_FOUND（得 ${insertRes.error && insertRes.error.code}）`)
assert(insertRes.error.message.includes('edit_mode="patch"'), `P3b-1 错误信息带 patch 提示（得 ${insertRes.error.message}）`)

// ── P3b-2：patch 模式 FILE_CHANGED 建议文案 ──
const appContent = (await import('node:fs')).readFileSync(appJs, 'utf-8')
const curHash = await (await imp(join(MALONG_DIR, 'hash-utils.js'))).sha256(appContent)
const okWrite = await ws.handle(
  { workspace_dir: WS, file: 'app.js', locator: { file_path: 'app.js' }, edit_mode: 'patch', patch: { old_string: 'const MAX_RETRIES = 3;', new_string: 'const MAX_RETRIES = 3; // bump' }, base_version: { file: { hash: `sha256:${curHash}` }, symbol: null } },
  { codeIndexService: svc, getWorkspaceDir: () => DATA },
)
assert(okWrite.success, `P3b-2 基线写成功（得 ${JSON.stringify(okWrite.error || okWrite.success)}）`)
writeFileSync(appJs, appContent + '\n// external change\n') // 外部改文件
const staleWrite = await ws.handle(
  { workspace_dir: WS, file: 'app.js', locator: { file_path: 'app.js' }, edit_mode: 'patch', patch: { old_string: 'const MAX_RETRIES = 3;', new_string: 'const MAX_RETRIES = 4;' }, base_version: { file: { hash: `sha256:${curHash}` }, symbol: null } },
  { codeIndexService: svc, getWorkspaceDir: () => DATA },
)
assert(staleWrite.error && staleWrite.error.conflict_type === 'FILE_CHANGED', `P3b-2 外部修改后写 → FILE_CHANGED（得 ${staleWrite.error && staleWrite.error.conflict_type}）`)
assert(staleWrite.error.suggestion && staleWrite.error.suggestion.includes('File changed externally'), `P3b-2 FILE_CHANGED 建议文案指向重读（得 ${staleWrite.error.suggestion}）`)

console.log(`\n== test-dogfood-r15: ${pass} passed, ${fail} failed ==`)
process.exit(fail > 0 ? 1 : 0)
