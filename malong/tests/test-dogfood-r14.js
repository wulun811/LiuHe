// test-dogfood-r14.js — 第 14 轮：全工具试用炸出的 4 个问题修复回归
// ① CJS require 盲区（dep_graph/gatekeeper）② test_bridge run_error 透出 ③ sweep scope 单文件
// ④ impact_analysis 别名导入反查（CJS 解构 { process: libProcess }）
// 依赖：malong-parse 服务在跑。起真实 code-index（mock core + parse-client 做 langParser）+ 直接调 handler。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { createDb } from '../db-adapter.js'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const imp = (p) => import(pathToFileURL(p).href)
const MALONG_DIR = join(__dirname, '..')

let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}

const WS = join(tmpdir(), 'opencode', 'r14-ws')
const DATA = join(tmpdir(), 'opencode', 'r14-data')
const SOCK = join(tmpdir(), 'opencode', 'r14-code-index.sock')

rmSync(WS, { recursive: true, force: true })
rmSync(DATA, { recursive: true, force: true })
for (const d of [WS, DATA]) mkdirSync(d, { recursive: true })

// ①④ 夹具：CJS 解构别名 + 普通 require + 注释/字符串里的假 require
writeFileSync(`${WS}/lib.js`, `function process(data, attempt) {\n  return { ok: true, value: data.value * (attempt + 1) }\n}\nmodule.exports = { process }\n`)
writeFileSync(`${WS}/app.js`, `const { process: libProcess } = require('./lib.js');\nconst MAX_RETRIES = 3;\n// const fake = require('not-real')\nconst str = "require('also-not-real')"\nfunction handle(data) {\n  let result = null\n  for (let i = 0; i < MAX_RETRIES; i++) {\n    result = libProcess(data, i)\n    if (result.ok) break\n  }\n  return result\n}\nmodule.exports = { handle }\n`)
writeFileSync(`${WS}/test_app.js`, `const { handle } = require('./app.js');\nfunction testIt() { return handle({ value: 2 }) }\nmodule.exports = { testIt }\n`)
writeFileSync(`${WS}/plain.js`, `const os = require('os')\nconst path = require('node:path')\nmodule.exports = { os, path }\n`)
mkdirSync(`${WS}/src`, { recursive: true })
writeFileSync(`${WS}/src/util.js`, `function helper() { return 'used' }\nfunction unusedHelper() { return 'dead' }\nmodule.exports = { helper }\n`)
writeFileSync(`${WS}/app2.js`, `const { helper } = require('./src/util.js');\nfunction orphanFn() { return 42 }\nmodule.exports = { run: () => helper() }\n`)
writeFileSync(`${WS}/registry.js`, `function registeredFn() { return 'via-object' }\nfunction deadFn() { return 'truly dead' }\ncore.registerService('demo', { run: registeredFn })\n`)
const libJs = join(WS, 'lib.js')
const appJs = join(WS, 'app.js')
const testAppJs = join(WS, 'test_app.js')
const plainJs = join(WS, 'plain.js')

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
await svc.initWorkspace(WS)
await svc.indexBatch([libJs, appJs, testAppJs, plainJs, join(WS, 'src', 'util.js'), join(WS, 'app2.js'), join(WS, 'registry.js')], WS)

const db2 = await createDb(join(DATA, 'code-index.db'))
db2.pragma('busy_timeout=5000')

// ── ① CJS require 产生 import refs（dep_graph 数据源）──
const appImports = db2.prepare("SELECT r.target_name, r.call_expr, r.line FROM refs r JOIN files f ON r.source_file_id=f.id WHERE f.path='app.js' AND r.kind='import'").all()
assert(appImports.some(i => i.target_name === './lib.js'), `① app.js 有 require('./lib.js') import ref（得 ${JSON.stringify(appImports.map(i => i.target_name))}）`)
const aliasRow = appImports.find(i => i.target_name === './lib.js')
assert(aliasRow && aliasRow.call_expr === '{"libProcess":"process"}', `① import ref 的 call_expr 存别名映射（得 ${aliasRow && aliasRow.call_expr}）`)
const plainImports = db2.prepare("SELECT r.target_name FROM refs r JOIN files f ON r.source_file_id=f.id WHERE f.path='plain.js' AND r.kind='import'").all()
assert(plainImports.length === 2, `① plain.js 两条 require 都有 import ref（得 ${plainImports.length}）`)
assert(plainImports.every(i => i.target_name !== 'not-real' && i.target_name !== 'also-not-real'), '① 注释/字符串里的 require 不产生 import ref')

// ① dep_graph（getModuleDependencies）能看到 CJS 依赖
const deps = await svc.getModuleDependencies('app.js', { depth: 2 })
assert(deps.directImports.length === 1 && deps.directImports[0].module === './lib.js', `① dep_graph 返回 CJS 直接依赖（得 ${JSON.stringify(deps.directImports)}）`)
const plainDeps = await svc.getModuleDependencies('plain.js', { depth: 2 })
assert(plainDeps.directImports.length === 2, `① dep_graph 对普通 require 同样生效（得 ${plainDeps.directImports.length}）`)

// ④ 别名反查：lib.js::process 的调用者必须包含 app.js 的 libProcess 调用
const impact = await svc.getImpactAnalysis('lib.js', { symbol: 'process' })
assert(impact.callers.some(c => c.file === 'app.js' && c.line === 8 && c.function === 'handle'), `④ impact_analysis 反查到别名调用者 app.js:8（得 ${JSON.stringify(impact.callers.map(c => c.file + ':' + c.line))}）`)

// ④ 别名 ref 重绑定：libProcess call ref 指向 lib.js::process
const libProcessRef = db2.prepare("SELECT r.target_symbol_id FROM refs r JOIN files f ON r.source_file_id=f.id WHERE f.path='app.js' AND r.target_name='libProcess' AND r.kind='call'").get()
const libProcessSym = db2.prepare("SELECT name, file_id FROM symbols WHERE id = ?").get(libProcessRef.target_symbol_id)
const libJsFileId = db2.prepare("SELECT id FROM files WHERE path='lib.js'").get().id
assert(libProcessSym && libProcessSym.name === 'process' && libProcessSym.file_id === libJsFileId, `④ 别名 call ref 重绑定到 lib.js::process（得 ${JSON.stringify(libProcessSym)}）`)

// ② dependency_gatekeeper：CJS 文件 imports_checked >= 1
const gk = await imp(join(MALONG_DIR, 'tools', 'tool-dependency-gatekeeper', 'handler.js'))
const gkRes = await gk.handle({ workspace_dir: WS, file: 'app.js' }, { langParserService: langParser })
assert(gkRes.imports_checked === 1, `② gatekeeper 识别 CJS require（imports_checked=${gkRes.imports_checked}，应=1）`)
const gkResPlain = await gk.handle({ workspace_dir: WS, file: 'plain.js' }, { langParserService: langParser })
assert(gkResPlain.imports_checked === 2, `② gatekeeper 对 plain.js 两条 require 都识别（得 ${gkResPlain.imports_checked}）`)

// ② test_bridge run_error：workspace 无 jest → exit 1 + 无结果 → run_error 必须透出
const tb = await imp(join(MALONG_DIR, 'tools', 'tool-test-bridge', 'handler.js'))
const tbRes = await tb.handle({ action: 'run', workspace_dir: WS, scope: 'test_app.js', framework: 'jest', timeout: 10 }, {})
assert(tbRes.exit_code !== 0, `② test_bridge 无 jest 时 exit != 0（得 ${tbRes.exit_code}）`)
assert(typeof tbRes.run_error === 'string' && tbRes.run_error.length > 0, `② run_error 透出原始输出（得 ${String(tbRes.run_error).slice(0, 60)}...）`)

// ③ sweep_dead_code 单文件 scope：只扫目标文件
const sweep = await imp(join(MALONG_DIR, 'tools', 'tool-dead-code-sweeper', 'handler.js'))
const sweepRes = await sweep.handle({ workspace_dir: WS, scope: 'lib.js' }, { codeIndexService: svc, getWorkspaceDir: () => DATA })
assert(sweepRes.scanned_files === 1, `③ scope=lib.js 只扫 1 个文件（得 ${sweepRes.scanned_files}）`)
const sweepWhole = await sweep.handle({ workspace_dir: WS, scope: '.' }, { codeIndexService: svc, getWorkspaceDir: () => DATA })
assert(sweepWhole.scanned_files === 7, `③ scope=. 扫全部 7 个文件（得 ${sweepWhole.scanned_files}）`)
assert(sweepWhole.dead_code.some(d => d.type === 'unused_function' && d.name === 'testIt'), `③ 全仓扫描照常报 unused_function（${JSON.stringify(sweepWhole.summary)}）`)

// ③'' r10d：DB 层返回 constructor（JS new 调用 refs 记类名）时 handler 必须豁免（MAGIC_METHODS）
const sweepCons = await sweep.handle({ workspace_dir: WS, scope: 'lib.js' }, {
  codeIndexService: {
    ...svc,
    detectDeadCode: async () => [
      { name: 'constructor', type: 'method', file: 'lib.js', start_line: 1 },
      { name: 'realDeadFn', type: 'function', file: 'lib.js', start_line: 3 },
    ],
  },
  getWorkspaceDir: () => DATA,
})
assert(!sweepCons.dead_code.some(d => d.name === 'constructor'), `③'' constructor 豁免（得 ${JSON.stringify(sweepCons.dead_code.map(d => d.name))}）`)
assert(sweepCons.dead_code.some(d => d.name === 'realDeadFn'), `③'' 真死代码仍报`)

// ③''' r10d：isPropertyAccessed 属性访问豁免语义（code-index 层，直接 import 导出函数）
const { isPropertyAccessed } = await imp(join(MALONG_DIR, 'code-index.js'))
const ga = join(WS, 'getter-use.js')
writeFileSync(ga, `const p = svc.indexProgress\nthis.lastIndexed = 1\n`)
assert(isPropertyAccessed('indexProgress', ga), `③''' svc.indexProgress 属性读豁免`)
assert(isPropertyAccessed('lastIndexed', ga), `③''' this.lastIndexed 赋值豁免`)
assert(!isPropertyAccessed('getCallGraph', ga), `③''' 无属性访问不豁免`)

// ③' r29：目录 scope 时 DB 层结果限定在 scope 内——旧实现把整仓 unused_function 混进来
const sweepDir = await sweep.handle({ workspace_dir: WS, scope: 'src' }, { codeIndexService: svc, getWorkspaceDir: () => DATA })
assert(sweepDir.scanned_files === 1, `③' scope=src 只扫 1 个文件（得 ${sweepDir.scanned_files}）`)
assert(sweepDir.dead_code.every(d => d.file.startsWith('src/')), `③' scope=src 结果全在 src/ 内（得 ${JSON.stringify(sweepDir.dead_code.map(d => d.file))}）`)
assert(!sweepDir.dead_code.some(d => d.name === 'orphanFn'), `③' scope=src 不含 scope 外 app2.js::orphanFn（得 ${JSON.stringify(sweepDir.dead_code.map(d => d.name))}）`)

// ③'' r29：register 对象字面量属性值引用不算死代码（refs 只记调用/import，detectDeadCode 显式豁免）
assert(!sweepWhole.dead_code.some(d => d.name === 'registeredFn'), `③'' registeredFn 被对象字面量引用不算死代码（得 ${JSON.stringify(sweepWhole.dead_code.map(d => d.name))}）`)
assert(sweepWhole.dead_code.some(d => d.name === 'deadFn'), `③'' 真死函数 deadFn 照常报（得 ${JSON.stringify(sweepWhole.dead_code.map(d => d.name))}）`)

console.log(`\n== test-dogfood-r14: ${pass} passed, ${fail} failed ==`)
process.exit(fail > 0 ? 1 : 0)
