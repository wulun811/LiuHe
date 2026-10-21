// test-rename-defline.js — rename_symbol 定义行漏改回归（全工具冒烟 r12.5 发现）
// 场景：索引 refs 表只存 use/call 不存定义；文本扫描有 maxResults=100 上限——
// 当符号在定义文件之前已有 ≥100 处文本匹配时，文本扫描截断，定义行既不在
// semanticRefs 也不在 textRefs → 改名漏改定义行，应用后直接产生坏代码。
// 修复：定义行解析提前，显式补入 allRefs。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
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

// 二轮审查修复：正则字面量内 \/\/ 不再误判为行注释——行尾符号必须仍可改名
console.log('\n── 正则字面量内转义斜杠不吞行尾符号 ──')
{
  const ws2 = mkdtempSync(join(tmpdir(), 'ren-re-'))
  writeFileSync(join(ws2, 're.js'), 'const urlRe = /https?:\\/\\//; process.env.X = 1\n')
  await svc.initWorkspace(ws2)
  await svc.indexBatch([join(ws2, 're.js')], ws2)
  const res2 = await rename.handle(
    { workspace_dir: ws2, file: 're.js', symbol: 'process', new_name: 'proc2', dry_run: false },
    { codeIndexService: svc, getWorkspaceDir: () => DATA },
  )
  assert(!res2.error, `正则场景 rename 无错误（得 ${res2.error && res2.error.message}）`)
  const out = readFileSync(join(ws2, 're.js'), 'utf-8')
  assert(out.includes('proc2.env.X'), `行尾符号被改名（旧实现 \\/\\/ 误判注释吞掉行尾，得 ${out.trim()}）`)
  assert(out.includes('/https?:\\/\\//'), '正则字面量保持原样')
  try { rmSync(ws2, { recursive: true, force: true }) } catch {}
}

// 三轮→四轮审查修复：前导判定（return/if 括号/等号后的正则）+ 除法豁免——8 场景矩阵
console.log('\n── 正则/除法前导判定矩阵（三轮→四轮）──')
{
  const cases = [
    ['return /https?:\\/\\//; foo.baz = 2\n', 1, 'return 后正则（keyword trimEnd 兜底）'],
    ['if (x) /a\\/\\//.test(y); foo.sym = 1\n', 1, 'if 括号后正则（空格+右括号前导）'],
    ['const urlRe = /https?:\\/\\//; foo.x = 1\n', 1, '等号后正则'],
    ['x = 3 / 2 // foo.comment = 1\n', 0, '除法+注释：注释内不改名'],
    ['(total + 1) / 2 // foo.note = 9\n', 0, '括号除法+注释'],
    ['arr[0] / 2 // foo.idx\n', 0, '下标除法+注释'],
    ['{ a: 1 } / 2 // foo.b\n', 0, '块除法+注释'],
    ['x = a / b / c; foo.end = 1\n', 1, '连除后行尾代码仍改名'],
  ]
  for (const [content, expect, label] of cases) {
    const ws3 = mkdtempSync(join(tmpdir(), 'ren-mx-'))
    writeFileSync(join(ws3, 't.js'), content)
    await svc.initWorkspace(ws3)
    await svc.indexBatch([join(ws3, 't.js')], ws3)
    const res3 = await rename.handle(
      { workspace_dir: ws3, file: 't.js', symbol: 'foo', new_name: 'FOO', dry_run: false },
      { codeIndexService: svc, getWorkspaceDir: () => DATA },
    )
    assert(!res3.error, `${label}: rename 无错误（得 ${res3.error && res3.error.message}）`)
    const out = readFileSync(join(ws3, 't.js'), 'utf-8')
    const n = (out.match(/FOO/g) || []).length
    assert(n === expect, `${label}: FOO 出现 ${n} 次（expect ${expect}，得 ${out.trim()}）——前导判定回归`)
    try { rmSync(ws3, { recursive: true, force: true }) } catch {}
  }
}

// ── dogfood-050（P2）：冲突检测精确同名 + 同文件阻塞 ──
console.log('\n── 冲突检测：前缀同名不误报 / 同文件同名阻塞 ──')
{
  const ctxR = { codeIndexService: svc, getWorkspaceDir: () => DATA }
  // ① 前缀同名（formatNum 是 formatNumber 的子串）不误报
  const wsA = mkdtempSync(join(tmpdir(), 'ren-cfA-'))
  writeFileSync(join(wsA, 'a.js'), 'function formatNumber(x) { return x }\n')
  await svc.initWorkspace(wsA)
  await svc.indexBatch([join(wsA, 'a.js')], wsA)
  const rA = await rename.handle({ workspace_dir: wsA, file: 'a.js', symbol: 'formatNumber', new_name: 'formatNum', dry_run: true }, ctxR)
  assert(!rA.conflict_warning, `① 前缀同名不误报（得 ${rA.conflict_warning}）`)
  assert(rA.conflict_blocking === false, `① 非阻塞（得 ${rA.conflict_blocking}）`)

  // ② 同文件真冲突：sub→mul（mul 已在同文件）→ dry-run 标阻塞；apply 拒绝且文件不变
  const wsB = mkdtempSync(join(tmpdir(), 'ren-cfB-'))
  writeFileSync(join(wsB, 'b.js'), 'function sub(a, b) { return a - b }\nfunction mul(a, b) { return a * b }\nsub(1, 2)\n')
  await svc.initWorkspace(wsB)
  await svc.indexBatch([join(wsB, 'b.js')], wsB)
  const rB = await rename.handle({ workspace_dir: wsB, file: 'b.js', symbol: 'sub', new_name: 'mul', dry_run: true }, ctxR)
  assert(rB.conflict_blocking === true, `② dry-run 标阻塞（得 ${JSON.stringify({ w: rB.conflict_warning, b: rB.conflict_blocking })}）`)
  assert(/already exists/.test(rB.conflict_warning || ''), `② 冲突描述存在（得 ${rB.conflict_warning}）`)
  const beforeB = readFileSync(join(wsB, 'b.js'), 'utf-8')
  const rB2 = await rename.handle({ workspace_dir: wsB, file: 'b.js', symbol: 'sub', new_name: 'mul', dry_run: false }, ctxR)
  assert(rB2.error === 'RENAME_CONFLICT' && rB2.status === 'rejected', `② apply 拒绝（得 ${rB2.error}）`)
  assert(readFileSync(join(wsB, 'b.js'), 'utf-8') === beforeB, '② 拒绝后文件未被改动')
  try { rmSync(wsA, { recursive: true, force: true }); rmSync(wsB, { recursive: true, force: true }) } catch {}
}

console.log(`\n== test-rename-defline: ${pass} passed, ${fail} failed ==`)
process.exit(fail > 0 ? 1 : 0)
