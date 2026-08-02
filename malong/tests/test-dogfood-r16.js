// test-dogfood-r16.js — 第 16 轮：file 参数防线（共用守卫 resolveFileArg）
// 事故回归：LLM 把 workspace 根目录传成 file → references 静默掉 text_fallback
// 覆盖：DIR_AS_FILE / FILE_NOT_FOUND / FILE_NOT_INDEXED / 绝对路径归一化 / file_error 透传
// 依赖：malong-parse 服务在跑。起真实 code-index（mock core + parse-client 做 langParser）+ 直接调 handler。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { createDb } from '../db-adapter.js'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const imp = (p) => import(pathToFileURL(p).href)
const MALONG_DIR = join(__dirname, '..')

let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}

const WS = join(tmpdir(), 'opencode', 'r16-ws')
const DATA = join(tmpdir(), 'opencode', 'r16-data')
const SOCK = join(tmpdir(), 'opencode', 'r16-code-index.sock')

rmSync(WS, { recursive: true, force: true })
rmSync(DATA, { recursive: true, force: true })
for (const d of [WS, DATA]) mkdirSync(d, { recursive: true })

writeFileSync(`${WS}/lib.js`, `function process(data, attempt) {\n  return { ok: true }\n}\nmodule.exports = { process }\n`)
writeFileSync(`${WS}/app.js`, `const { process: libProcess } = require('./lib.js');\nfunction handle(data) { return libProcess(data, 1) }\nmodule.exports = { handle }\n`)

const libJs = join(WS, 'lib.js')
const appJs = join(WS, 'app.js')

const pc = await imp(join(MALONG_DIR, 'parse-client.js'))
await pc.init({ log: () => {} })
assert(await pc.connect(), 'parse-client 连接到 malong-parse')

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
await svc.indexBatch([libJs, appJs], WS)

const ctx = { codeIndexService: svc, getWorkspaceDir: () => DATA }
const refs = await imp(join(MALONG_DIR, 'tools', 'tool-references', 'handler.js'))
const impact = await imp(join(MALONG_DIR, 'tools', 'tool-impact-analysis', 'handler.js'))
const depGraph = await imp(join(MALONG_DIR, 'tools', 'tool-dep-graph', 'handler.js'))
const inspect = await imp(join(MALONG_DIR, 'tools', 'tool-inspect', 'handler.js'))
const findTests = await imp(join(MALONG_DIR, 'tools', 'tool-find-tests', 'handler.js'))
const rename = await imp(join(MALONG_DIR, 'tools', 'tool-rename-symbol', 'handler.js'))
const callChain = await imp(join(MALONG_DIR, 'tools', 'tool-call-chain', 'handler.js'))
const outline = await imp(join(MALONG_DIR, 'tools', 'tool-outline-reader', 'handler.js'))

// ── 共用守卫服务层直测 ──
const r1 = svc.resolveFileArg(WS) // 目录
assert(!r1.ok && r1.error.code === 'DIR_AS_FILE' && r1.error.suggestion.includes('omit the file parameter'), `守卫① 目录 → DIR_AS_FILE（得 ${r1.error.code}）`)
const r2 = svc.resolveFileArg('nope.js')
assert(!r2.ok && r2.error.code === 'FILE_NOT_FOUND' && r2.error.suggestion.includes('glob'), `守卫② 不存在 → FILE_NOT_FOUND（得 ${r2.error.code}）`)
const r3 = svc.resolveFileArg(appJs) // 绝对路径
assert(r3.ok && r3.path === 'app.js', `守卫③ 绝对路径归一化 → app.js（得 ${r3.path}）`)
const r4 = svc.resolveFileArg('./app.js')
assert(r4.ok && r4.path === 'app.js', `守卫④ ./ 前缀归一化（得 ${r4.path}）`)
const r5 = svc.resolveFileArg(`${WS}/` )
assert(!r5.ok && r5.error.code === 'DIR_AS_FILE', `守卫⑤ 尾斜杠目录 → DIR_AS_FILE（得 ${r5.error.code}）`)

// ── 事故回归：file=workspace 根目录 → 结构化错误，绝不 text_fallback ──
const refDir = await refs.handle({ workspace_dir: WS, symbol: 'process', file: WS }, ctx)
assert(refDir.error === 'DIR_AS_FILE' && refDir.search_method !== 'text_fallback', `references 事故回归：目录 → DIR_AS_FILE 错误（得 ${refDir.error || '无错误'}）`)

// ── references 绝对路径 file → 归一化后走 DB ──
const refAbs = await refs.handle({ workspace_dir: WS, symbol: 'process', file: appJs }, ctx)
assert(refAbs.error === undefined && refAbs.results.length > 0, `references 绝对路径 file 正常返回（count=${refAbs.count}）`)
assert(refAbs.results.some(r => r.kind === 'import'), `references 结果含 import 绑定（${JSON.stringify(refAbs.results.map(r => r.kind))}）`)

// ── references 不存在文件 → FILE_NOT_FOUND ──
const refNf = await refs.handle({ workspace_dir: WS, symbol: 'process', file: 'nope.js' }, ctx)
assert(refNf.error === 'FILE_NOT_FOUND', `references 不存在文件 → FILE_NOT_FOUND（得 ${refNf.error || '无错误'}）`)

// ── impact / dep_graph / call-chain：无效 file → file_error 字段 ──
const impNf = await impact.handle({ workspace_dir: WS, file: 'nope.js', symbol: 'process' }, ctx)
assert(impNf.file_error && impNf.file_error.code === 'FILE_NOT_FOUND', `impact 无效 file → file_error（得 ${JSON.stringify(impNf.file_error)}）`)
const depNf = await depGraph.handle({ workspace_dir: WS, file: 'nope.js' }, ctx)
assert(depNf.file_error && depNf.file_error.code === 'FILE_NOT_FOUND', `dep_graph 无效 file → file_error（得 ${JSON.stringify(depNf.file_error)}）`)
const chainNf = await callChain.handle({ workspace_dir: WS, file: 'nope.js', line: 1 }, ctx)
assert(chainNf.error === 'FILE_NOT_FOUND', `call_chain 无效 file → 守卫错误（得 ${chainNf.error || '无错误'}）`)
const impDir = await impact.handle({ workspace_dir: WS, file: WS, symbol: 'process' }, ctx)
assert(impDir.file_error && impDir.file_error.code === 'DIR_AS_FILE', `impact 目录 file → DIR_AS_FILE（得 ${JSON.stringify(impDir.file_error)}）`)

// ── inspect / find_tests / rename：无效 file → 结构化错误 ──
const insDir = await inspect.handle({ workspace_dir: WS, file: WS, symbol: 'process' }, ctx)
assert(insDir.error === 'DIR_AS_FILE', `inspect 目录 file → DIR_AS_FILE（得 ${insDir.error || '无错误'}）`)
const ftNf = await findTests.handle({ workspace_dir: WS, file: 'nope.js' }, ctx)
assert(ftNf.error === 'FILE_NOT_FOUND', `find_tests 不存在文件 → FILE_NOT_FOUND（得 ${ftNf.error || '无错误'}）`)
const ftDir = await findTests.handle({ workspace_dir: WS, file: WS }, ctx)
assert(ftDir.error === 'DIR_AS_FILE', `find_tests 目录 file → DIR_AS_FILE（得 ${ftDir.error || '无错误'}）`)
const rnNf = await rename.handle({ workspace_dir: WS, file: 'nope.js', symbol: 'process', new_name: 'retryProcess', dry_run: true }, ctx)
assert(rnNf.error === 'FILE_NOT_FOUND', `rename 不存在定义文件 → FILE_NOT_FOUND（得 ${rnNf.error || '无错误'}）`)

// ── 已有守卫不回归 ──
const outlineNf = await outline.handle({ workspace_dir: WS, file: 'nope.js' }, ctx)
assert(outlineNf.error === 'file_not_found', `outline 保持原守卫错误（得 ${outlineNf.error}）`)
const outlineAbs = await outline.handle({ workspace_dir: WS, file: appJs }, ctx)
assert(!outlineAbs.error && outlineAbs.outline?.length > 0, `outline 绝对路径归一化后正常（outline=${outlineAbs.outline && outlineAbs.outline.length}）`)
const refOk = await refs.handle({ workspace_dir: WS, symbol: 'process' }, ctx)
assert(refOk.search_method !== 'text_fallback' || refOk.results.length > 0, `references 无 file 全局搜索正常（count=${refOk.count}）`)

console.log(`\n== test-dogfood-r16: ${pass} passed, ${fail} failed ==`)
process.exit(fail > 0 ? 1 : 0)
