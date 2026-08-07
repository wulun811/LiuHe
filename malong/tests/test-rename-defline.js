// test-rename-defline.js — rename_symbol 定义行漏改回归（全工具冒烟 r12.5 发现）
// 场景：索引 refs 表只存 use/call 不存定义；文本扫描有 maxResults=100 上限——
// 当符号在定义文件之前已有 ≥100 处文本匹配时，文本扫描截断，定义行既不在
// semanticRefs 也不在 textRefs → 改名漏改定义行，应用后直接产生坏代码。
// 修复：定义行解析提前，显式补入 allRefs。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const imp = (p) => import(pathToFileURL(p).href)
const MALONG_DIR = join(__dirname, '..')

let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}

const WS = join(tmpdir(), 'opencode', 'rename-defline-ws')
const DATA = join(tmpdir(), 'opencode', 'rename-defline-data')
const SOCK = join(tmpdir(), 'opencode', 'rename-defline-code-index.sock')

try { rmSync(WS, { recursive: true, force: true }) } catch {}
try { rmSync(DATA, { recursive: true, force: true }) } catch {}
for (const d of [WS, DATA]) mkdirSync(d, { recursive: true })

// a-fill.js：101 处文本匹配，字典序在 z-def.js 之前 → 文本扫描在到达定义文件前命中 maxResults=100 截断
const filler = Array.from({ length: 101 }, (_, i) => `// mySymbol placeholder ref ${i}`).join('\n') + '\n'
writeFileSync(`${WS}/a-fill.js`, filler)
// z-def.js：定义行 1 + 调用行 2
writeFileSync(`${WS}/z-def.js`, `function mySymbol() { return 42 }\nmySymbol()\n`)

const pc = await imp(join(MALONG_DIR, 'parse-client.js'))
await pc.init({ log: () => {} })
const connected = await pc.connect()
assert(connected, 'parse-client 连接到 malong-parse')

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
await svc.initWorkspace(WS)
await svc.indexBatch([join(WS, 'z-def.js')], WS)

const rename = await imp(join(MALONG_DIR, 'tools', 'tool-rename-symbol', 'handler.js'))
const res = await rename.handle(
  { workspace_dir: WS, file: 'z-def.js', symbol: 'mySymbol', new_name: 'mySymbolRenamed', dry_run: true },
  { codeIndexService: svc, getWorkspaceDir: () => DATA },
)

assert(!res.error, `rename 无错误（得 ${res.error && res.error.message}）`)
const defEdits = (res.edits_per_file || []).find(e => e.file === 'z-def.js')
const defLines = defEdits ? defEdits.edits.map(e => e.line) : []
assert(defLines.includes(1), `定义行 1 在编辑集内（得行 ${JSON.stringify(defLines)}）——漏改定义行会产生 ReferenceError 坏代码`)
assert(defLines.includes(2), `调用行 2 在编辑集内（得行 ${JSON.stringify(defLines)}）`)
const defEdit = defEdits && defEdits.edits.find(e => e.line === 1)
assert(defEdit && defEdit.new.includes('function mySymbolRenamed'), `定义行改为新名（得 ${defEdit && defEdit.new}）`)
assert(res.definition && res.definition.line === 1, `definition 字段指向定义行（得 ${JSON.stringify(res.definition)}）`)

console.log(`\n== test-rename-defline: ${pass} passed, ${fail} failed ==`)
process.exit(fail > 0 ? 1 : 0)
