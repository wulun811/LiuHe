// test-esm-import-refs.js — 狗粮r3（P1）：ESM 具名/默认 import 必须产生 per-local import ref。
// 事故回归：references(symbol=仅被 import 未被调用的本地名) 曾零命中并误称 authoritative；
// impact(file).importers 漏该导入方。CJS 早有 per-local ref（r15），ESM 此前只挂模块行。
// 依赖：malong-parse 服务在跑。起真实 code-index（mock core）直测 index 层 + references/impact handler。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const imp = (p) => import(pathToFileURL(p).href)
const MALONG_DIR = join(__dirname, '..')

let pass = 0, fail = 0
function assert(cond, msg) { if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) } }

const ROOT = join(tmpdir(), 'opencode', 'esm-ref-ws')
const DATA = join(tmpdir(), 'opencode', 'esm-ref-data')
const SOCK = join(tmpdir(), 'opencode', 'esm-ref.sock')
try { rmSync(ROOT, { recursive: true, force: true }) } catch {}
try { rmSync(DATA, { recursive: true, force: true }) } catch {}
mkdirSync(ROOT, { recursive: true })
mkdirSync(DATA, { recursive: true })

writeFileSync(join(ROOT, 'lib.js'), [
  'export function alpha(x) { return x + 1 }',
  'export function beta(y) { return y + 2 }',
  'export default function gamma() { return 3 }',
].join('\n'))
writeFileSync(join(ROOT, 'app.js'), [
  "import { alpha, beta } from './lib.js'",
  "import gamma from './lib.js'",
  "import { readFileSync } from 'node:fs'",
  'export function run() { return alpha(1) }',
].join('\n'))

const pc = await imp(join(MALONG_DIR, 'parse-client.js'))
await pc.init({ log: () => {} })
assert(await pc.connect(), 'parse-client 连接到 malong-parse')

const { default: codeIndex } = await imp(join(MALONG_DIR, 'code-index.js'))
const langParser = {
  extractAllAsync: (source, ext, filePath, ws) => pc.extractAll(source, ext, filePath, ws),
  extractReferencesAsync: (source, ext) => pc.extractReferences(source, ext),
  batchExtractAsync: (files, ws) => pc.batchExtract(files, ws),
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
await svc.initWorkspace(ROOT)
await svc.indexBatch([join(ROOT, 'lib.js'), join(ROOT, 'app.js')], ROOT)

const ctx = { codeIndexService: svc, getWorkspaceDir: () => DATA }
const refs = await imp(join(MALONG_DIR, 'tools', 'tool-references', 'handler.js'))
const impact = await imp(join(MALONG_DIR, 'tools', 'tool-impact-analysis', 'handler.js'))

// ① references(仅 import 未调用的本地名 beta) → 命中 app.js import 行
const rBeta = await refs.handle({ workspace_dir: ROOT, symbol: 'beta' }, ctx)
assert(rBeta.error === undefined && (rBeta.results || []).some(r => r.kind === 'import' && r.path === 'app.js'), '① references(beta) 命中 import 绑定（得 ' + JSON.stringify(rBeta.results) + '）')

// ② references(gamma 默认导入本地名) → 命中 import
const rGamma = await refs.handle({ workspace_dir: ROOT, symbol: 'gamma' }, ctx)
assert(rGamma.error === undefined && (rGamma.results || []).some(r => r.kind === 'import'), '② references(gamma) 默认导入也绑定（得 ' + JSON.stringify(rGamma.results) + '）')

// ③ references(alpha) import 行去重恰好 1 且仍含 call
const rAlpha = await refs.handle({ workspace_dir: ROOT, symbol: 'alpha' }, ctx)
const aImports = (rAlpha.results || []).filter(r => r.kind === 'import')
assert(aImports.length === 1, '③ references(alpha) import 行恰好 1（去重，得 ' + aImports.length + '）')
assert((rAlpha.results || []).some(r => r.kind === 'call'), '③ references(alpha) 仍含 call 绑定')

// ④ impact(file=lib.js).importers 含 app.js（且同 (file,line) 不重复）
const impLib = await impact.handle({ workspace_dir: ROOT, file: 'lib.js' }, ctx)
const appImp = (impLib.importers || []).filter(i => i.file === 'app.js')
assert(appImp.length >= 1, '④ impact(lib.js).importers 含 app.js（得 ' + JSON.stringify(impLib.importers) + '）')
assert(new Set(appImp.map(i => i.line)).size === appImp.length, '④ importers 同一 (file,line) 不重复（得 ' + JSON.stringify(appImp) + '）')

// ⑤ impact(symbol=alpha).callers 仍正确定位 app.js 调用
const impAlpha = await impact.handle({ workspace_dir: ROOT, file: 'lib.js', symbol: 'alpha' }, ctx)
assert((impAlpha.callers || []).some(c => c.file === 'app.js'), '⑤ impact(alpha).callers 含 app.js 调用（得 ' + JSON.stringify(impAlpha.callers) + '）')

console.log('\n== test-esm-import-refs: ' + pass + ' passed, ' + fail + ' failed ==')
process.exit(fail > 0 ? 1 : 0)
