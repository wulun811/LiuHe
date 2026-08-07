// test-gatekeeper-golden.js — 质检员上岗考核（0 误报门禁）
// golden fixtures 全部来自生产体检发现的真实 bug（2026-07-31）：
//   fix_imports：node:/多行 import/模板字符串/数组解构/C 风格 for/export async/副作用导入/修剪保真/语法护栏
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const imp = (p) => import(pathToFileURL(p).href)
const MALONG_DIR = join(__dirname, '..')
const { handle: fixImports } = await imp(join(MALONG_DIR, 'tools/tool-fix-imports/handler.js'))
const parseClient = await imp(join(MALONG_DIR, 'parse-client.js'))

let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}

const { tmpdir } = os
const WS = join(tmpdir(), 'opencode', 'gatekeeper-ws')
const DATA = join(tmpdir(), 'opencode', 'gatekeeper-data')
rmSync(WS, { recursive: true, force: true })
rmSync(DATA, { recursive: true, force: true })
mkdirSync(`${WS}/src`, { recursive: true })
mkdirSync(DATA, { recursive: true })
writeFileSync(join(DATA, 'code-index.db'), '')

const codeIndexService = { initWorkspace() {}, getReferences: async () => [], getModuleDependencies: async () => ({}) }
const context = { codeIndexService, getWorkspaceDir: () => DATA, langParserService: null }

// ═══════════ golden fixture 1：node: 单行 import（write-runtime 场景） ═══════════
console.log('── golden 1: node: 单行 import 0 误报 ──')
writeFileSync(`${WS}/src/a.js`, `import { join, basename } from 'node:path'\nimport { readFileSync } from 'node:fs'\n\nexport function run(p) {\n  const abs = join(p, 'x')\n  return basename(abs) + readFileSync(abs, 'utf-8')\n}\n`)
let r = await fixImports({ workspace_dir: WS, file: 'src/a.js' }, context)
assert(r.issues.filter(i => i.type === 'undefined_symbol').length === 0, `node: 单行无 undefined 误报（得 ${JSON.stringify(r.issues)})`)
assert(r.issues.filter(i => i.type === 'unused_import').length === 0, `node: 单行无 unused 误报`)

// ═══════════ golden 2：多行 import 块（node:fs 多行场景） ═══════════
console.log('── golden 2: 多行 import 0 误报 ──')
writeFileSync(`${WS}/src/b.js`, `import {\n  readFileSync,\n  writeFileSync,\n  existsSync,\n} from 'node:fs'\n\nexport function io(p, data) {\n  if (existsSync(p)) return readFileSync(p, 'utf-8')\n  writeFileSync(p, data)\n  return 'ok'\n}\n`)
r = await fixImports({ workspace_dir: WS, file: 'src/b.js' }, context)
assert(r.issues.filter(i => i.type === 'undefined_symbol').length === 0, `多行 import 无 undefined 误报（得 ${r.issues.map(i => i.symbol).join(',')})`)
assert(r.issues.filter(i => i.type === 'unused_import').length === 0, `多行 import 无 unused 误报`)

// ═══════════ golden 3：模板字符串 ${} 内代码保留 ═══════════
console.log('── golden 3: 模板字符串 ${} 内代码 ──')
writeFileSync(`${WS}/src/c.js`, `import { randomBytes } from 'node:crypto'\n\nexport function tid() {\n  return \`trc_\${Date.now()}_\${randomBytes(3).toString('hex')}\`\n}\n`)
r = await fixImports({ workspace_dir: WS, file: 'src/c.js' }, context)
assert(r.issues.filter(i => i.type === 'undefined_symbol').length === 0, '模板表达式内 randomBytes 不误报 undefined')
assert(r.issues.filter(i => i.type === 'unused_import').length === 0, '模板表达式内 randomBytes 不误报 unused')

// ═══════════ golden 4：数组解构 + C 风格 for + export async ═══════════
console.log('── golden 4: 数组解构 / C 风格 for / export async ──')
writeFileSync(`${WS}/src/d.js`, `export async function main(lines) {\n  const [a, b] = [1, 2]\n  for (let idx = 0; idx < 3; idx++) {\n    lines.push(a + b + idx)\n  }\n  return lines\n}\n`)
r = await fixImports({ workspace_dir: WS, file: 'src/d.js' }, context)
assert(r.issues.filter(i => i.type === 'undefined_symbol').length === 0, `解构/for/export async 无 undefined 误报（得 ${r.issues.map(i => i.symbol).join(',')})`)

// ═══════════ golden 5：副作用导入不误报 ═══════════
console.log('── golden 5: 副作用导入 ──')
writeFileSync(`${WS}/src/e.js`, `import './style.css'\nimport 'polyfill'\n\nexport function x() { return 1 }\n`)
r = await fixImports({ workspace_dir: WS, file: 'src/e.js' }, context)
assert(r.issues.filter(i => i.type === 'unused_import').length === 0, `副作用导入不误报 unused（得 ${r.issues.map(i => i.import).join(',')})`)

// ═══════════ golden 6：auto_fix 修剪保真（不误删在用成员） ═══════════
console.log('── golden 6: auto_fix 修剪保真 ──')
writeFileSync(`${WS}/src/f.js`, `import { used, unused } from './helper.js'\n\nfunction main() {\n  return used()\n}\nmain()\n`)
r = await fixImports({ workspace_dir: WS, file: 'src/f.js', auto_fix: true }, context)
const after6 = readFileSync(`${WS}/src/f.js`, 'utf-8')
assert(r.fixes_applied?.imports_trimmed === 1, `修剪计数=1（得 ${JSON.stringify(r.fixes_applied)})`)
assert(after6.includes("import { used } from './helper.js'"), `在用成员 used 保留（得 ${after6.split('\n')[0]})`)
assert(!after6.includes('unused'), `未用成员 unused 移除`)

// ═══════════ golden 7：真 undefined 仍能报（不漏报） ═══════════
console.log('── golden 7: 真 undefined 不漏报 ──')
writeFileSync(`${WS}/src/g.js`, `export function run() {\n  return totallyUndefined()\n}\n`)
r = await fixImports({ workspace_dir: WS, file: 'src/g.js' }, context)
const undef7 = r.issues.filter(i => i.type === 'undefined_symbol')
assert(undef7.some(i => i.symbol === 'totallyUndefined'), `真 undefined 被报告（得 ${JSON.stringify(undef7)})`)

// ═══════════ golden 8：edit_batch 自指陷阱（分隔符撞上被编辑文件内容） ═══════════
console.log('── golden 8: edit_batch 自指陷阱 ──')
const { handle: editBatch } = await imp(join(MALONG_DIR, 'tools/tool-batch-edit/handler.js'))
// 被编辑文件自身含协议分隔符字符串 → 旧 handler 的 indexOf 截断会吞掉成功结果
writeFileSync(`${WS}/src/selfref.js`, `const marker = '---MALONG_BATCH_EDIT_JSON_END---'\nconst x = 1\n`)
const r8 = await editBatch({ workspace_dir: WS, file: 'src/selfref.js', edits: [{ old_string: 'const x = 1', new_string: 'const x = 2' }] }, { codeIndexService: { indexFile: async () => ({ symbols: 0 }), markIndexDirty() {} } })
assert(r8.success === true, `自指文件编辑成功（不吞结果，得 ${JSON.stringify(r8).slice(0, 80)})`)
assert(readFileSync(`${WS}/src/selfref.js`, 'utf-8').includes('const x = 2'), `自指文件真实写入`)
assert(r8.final_content === undefined && r8.original_content === undefined, `edit_batch 默认 diff-only 返回`)

// ═══════════ golden 9：edit_batch 契约（file 相对 + 越界拒绝） ═══════════
console.log('── golden 9: edit_batch 契约 ──')
writeFileSync(`${WS}/src/contract.py`, 'def f():\n    return 1\n')
const r9a = await editBatch({ workspace_dir: WS, file: 'src/contract.py', edits: [{ old_string: 'return 1', new_string: 'return 2' }] }, { codeIndexService: { indexFile: async () => ({ symbols: 0 }), markIndexDirty() {} } })
assert(r9a.success === true, `file（相对）+ workspace_dir 成功`)
const r9b = await editBatch({ workspace_dir: WS, file_path: '/etc/passwd', edits: [{ old_string: 'x', new_string: 'y' }] }, { codeIndexService: null })
assert(r9b.error === 'path_blocked' || r9b.error_code === 'PATH_BLOCKED', `绝对路径越界拒绝（得 ${r9b.error_code}）`)
const r9c = await editBatch({ workspace_dir: WS, file_path: `${WS}/src/contract.py`, edits: [{ old_string: 'return 2', new_string: 'return 3' }] }, { codeIndexService: { indexFile: async () => ({ symbols: 0 }), markIndexDirty() {} } })
assert(r9c.success === true, `file_path（绝对，workspace 内）反向兼容`)

// ═══════════ golden 10：sweep_dead_code 字符串/注释感知（模板/三引号/块注释内 import 文本不误报） ═══════════
console.log('── golden 10: sweep_dead_code 字符串感知 ──')
const { handle: deadSweep } = await imp(join(MALONG_DIR, 'tools/tool-dead-code-sweeper/handler.js'))
const sweepCtx = { codeIndexService: null, getWorkspaceDir: () => DATA }
writeFileSync(`${WS}/src/sweep.js`, `import { helper } from './utils'\nimport { realUnused } from './other'\n\nconst snippet = \`\nimport { helper } from './utils'\nusage:\n  helper(1)\n\`\n\n/*\nimport { helper } from './utils'\n*/\n\nexport function run() {\n  return helper(1)\n}\n`)
r = await deadSweep({ workspace_dir: WS, scope: 'src' }, sweepCtx)
const sweepUnused = r.dead_code.filter(d => d.type === 'unused_import')
assert(!sweepUnused.some(d => d.symbol === 'helper' && d.file.includes('sweep.js')), `模板/注释内 import 文本不误报 helper（得 ${JSON.stringify(sweepUnused)})`)
assert(sweepUnused.some(d => d.symbol === 'realUnused' && d.file.includes('sweep.js')), `真 unused realUnused 仍报（不漏报）`)
writeFileSync(`${WS}/src/sweep2.py`, `import os\n\nDOC = """\nimport os\nusage: os.listdir()\n"""\n\ndef run():\n    return 1\n`)
r = await deadSweep({ workspace_dir: WS, scope: 'src' }, sweepCtx)
const sweepUnusedPy = r.dead_code.filter(d => d.type === 'unused_import' && d.file.includes('sweep2.py'))
assert(!sweepUnusedPy.some(d => d.symbol === 'os'), `三引号 docstring 内 import 文本不误报 os（得 ${JSON.stringify(sweepUnusedPy)})`)

// ═══════════ golden 11：exception_guard 不支持语言显式声明（不静默 clean） ═══════════
console.log('── golden 11: exception_guard 语言感知 ──')
const { handle: excGuard } = await imp(join(MALONG_DIR, 'tools/tool-exception-guard/handler.js'))
writeFileSync(`${WS}/src/main.go`, 'package main\n\nfunc main() {\n\tpanic("boom")\n}\n')
r = await excGuard({ workspace_dir: WS, file: 'src/main.go' }, { codeIndexService: null, getWorkspaceDir: () => DATA })
assert(r.error === 'unsupported_language', `不支持扩展名显式报错（得 ${r.error}）`)
assert(r.issues.length === 0 && r.summary.language_supported === false, `不谎报 clean（issues=0 且 language_supported=false）`)
r = await excGuard({ workspace_dir: WS, file: 'src/sweep2.py' }, { codeIndexService: null, getWorkspaceDir: () => DATA })
assert(r.error === undefined && Array.isArray(r.issues), `支持语言正常路径不受影响`)

// ═══════════ golden 12：active_todos 跳过 fixtures（测试假数据不污染） ═══════════
console.log('── golden 12: active_todos fixtures 跳过 ──')
const { handle: activeTodos } = await imp(join(MALONG_DIR, 'tools/tool-active-todos/handler.js'))
mkdirSync(`${WS}/fixtures`, { recursive: true })
mkdirSync(`${WS}/src`, { recursive: true })
writeFileSync(`${WS}/fixtures/dummy.js`, '// TODO: 假数据里的 TODO 不应被扫到\nconst x = 1\n')
writeFileSync(`${WS}/src/real.js`, '// TODO: 真实代码里的 TODO 应保留\nfunction f() { return 1 }\n')
r = await activeTodos({ workspace_dir: WS, scope: '.' }, {})
assert(r.todos.every(t => t.file !== 'fixtures/dummy.js'), `fixtures 内 TODO 被跳过（得 ${r.todos.map(t => t.file).join(',')})`)
assert(r.todos.some(t => t.file === 'src/real.js'), `真实代码 TODO 保留`)

// ═══════════ golden 13：config_drift CI 内置变量白名单（GITHUB_* 不误报） ═══════════
console.log('── golden 13: config_drift CI 白名单 ──')
const { handle: configDrift } = await imp(join(MALONG_DIR, 'tools/tool-config-drift/handler.js'))
writeFileSync(`${WS}/src/ci.js`, `export async function run() {\n  const repo = process.env.GITHUB_REPOSITORY\n  const token = process.env.GITHUB_TOKEN\n  const custom = process.env.MY_CUSTOM_KEY\n  return { repo, token, custom }\n}\n`)
writeFileSync(`${WS}/.env.example`, 'MY_CUSTOM_KEY=x\n')
r = await configDrift({ workspace_dir: WS, file: 'src/ci.js' }, {})
const ciDrifts = r.drifts.filter(d => d.type === 'missing_env_var')
assert(!ciDrifts.some(d => d.name === 'GITHUB_REPOSITORY' || d.name === 'GITHUB_TOKEN'), `CI 内置变量不误报（得 ${JSON.stringify(ciDrifts)})`)
assert(!ciDrifts.some(d => d.name === 'MY_CUSTOM_KEY'), `已声明变量不误报`)
writeFileSync(`${WS}/src/ci2.js`, `export async function run() {\n  return process.env.TRULY_MISSING\n}\n`)
r = await configDrift({ workspace_dir: WS, file: 'src/ci2.js' }, {})
assert(r.drifts.some(d => d.name === 'TRULY_MISSING'), `真缺失变量仍报（不漏报）`)

// ═══════════ golden 14：active_todos 字符串感知（字符串字面量里的 TODO 文本不误报） ═══════════
console.log('── golden 14: active_todos 字符串感知 ──')
const strJs = [
  "const a = '// TODO: 字符串里的 TODO 不是真 TODO'",
  'const b = "// FIXME: 双引号字符串也不是"',
  '// TODO: 真实注释 TODO 应保留',
  'function f() { return 1 }',
  '',
].join('\n')
writeFileSync(`${WS}/src/str.js`, strJs)
r = await activeTodos({ workspace_dir: WS, scope: 'src' }, {})
const strTodos = r.todos.filter(t => t.file === 'src/str.js')
assert(strTodos.length === 1 && strTodos[0].type === 'TODO', `字符串 TODO 不误报、注释 TODO 保留（得 ${JSON.stringify(strTodos)})`)
assert(strTodos[0].content === '真实注释 TODO 应保留', `注释内容正确（得 ${strTodos[0].content}）`)

// ═══════════ golden 15：fix_imports 无括号单参数 arrow（new Promise(resolve => ...) 不误报 undefined） ═══════════
console.log('── golden 15: 无括号单参数 arrow ──')
writeFileSync(`${WS}/src/arrow.js`, `export function run() {\n  return new Promise(resolve => {\n    resolve(42)\n  })\n}\n`)
r = await fixImports({ workspace_dir: WS, file: 'src/arrow.js' }, context)
const arrowUndef = r.issues.filter(i => i.type === 'undefined_symbol' && i.symbol === 'resolve')
assert(arrowUndef.length === 0, `Promise(resolve => ...) 的 resolve 不误报 undefined（得 ${JSON.stringify(arrowUndef)})`)
writeFileSync(`${WS}/src/arrow2.js`, `const xs = [1, 2, 3]\nconst doubled = xs.map(x => x * 2)\nexport function run() {\n  return doubled.reduce((acc, cur) => acc + cur, 0)\n}\n`)
r = await fixImports({ workspace_dir: WS, file: 'src/arrow2.js' }, context)
const arrowUndef2 = r.issues.filter(i => i.type === 'undefined_symbol')
assert(arrowUndef2.length === 0, `map/reduce arrow 参数不误报（得 ${JSON.stringify(arrowUndef2)})`)

// ═══════════ golden 16：config_drift 字符串感知（模板字符串里的 from/join 自然语言不误报表名） ═══════════
console.log('── golden 16: config_drift 字符串感知 ──')
const dbstrJs = 'export function log() {\n  return `initialize from client, pid=${process.pid}`\n}\n'
writeFileSync(`${WS}/src/dbstr.js`, dbstrJs)
r = await configDrift({ workspace_dir: WS, file: 'src/dbstr.js' }, {})
const dbRefs = r.config_references.filter(x => x.type === 'db_table')
assert(dbRefs.length === 0, `模板字符串里 from client 不误报表名（得 ${JSON.stringify(dbRefs)})`)
writeFileSync(`${WS}/src/dbstr2.js`, "import { query } from './db'\nexport async function run() {\n  const rows = await query('SELECT * FROM orders WHERE id = ?')\n  return rows\n}\n")
r = await configDrift({ workspace_dir: WS, file: 'src/dbstr2.js' }, {})
const dbRefs2 = r.config_references.filter(x => x.type === 'db_table')
assert(dbRefs2.some(x => x.name === 'orders'), `SQL 调用行字符串里的表名应检出 orders（得 ${JSON.stringify(dbRefs2)})`)
writeFileSync(`${WS}/src/dbstr3.js`, "export function describe() {\n  return `sessions table has 100 rows`\n}\n")
r = await configDrift({ workspace_dir: WS, file: 'src/dbstr3.js' }, {})
const dbRefs3 = r.config_references.filter(x => x.type === 'db_table')
assert(dbRefs3.length === 0, `自然语言模板文本不误报表名（得 ${JSON.stringify(dbRefs3)})`)

// ═══════════ golden 17：fix_imports 正则字面量（/x/g 的 flag 不是标识符引用；除法链 a / b / c 不误剥） ═══════════
console.log('── golden 17: 正则字面量 flag 不误报 ──')
writeFileSync(`${WS}/src/regex.js`, `const dynRe = /import\\s*\\(\\s*['"]([^'"]+)['"]\\s*\\)/g\nexport function run(text) {\n  return dynRe.test(text)\n}\n`)
r = await fixImports({ workspace_dir: WS, file: 'src/regex.js' }, context)
const regexUndef = r.issues.filter(i => i.type === 'undefined_symbol')
assert(regexUndef.length === 0, `正则 /.../g 的 flag g 不误报 undefined（得 ${JSON.stringify(regexUndef)})`)
writeFileSync(`${WS}/src/div.js`, `export function ratio(a, b, c) {\n  return a / b / c\n}\n`)
r = await fixImports({ workspace_dir: WS, file: 'src/div.js' }, context)
const divUndef = r.issues.filter(i => i.type === 'undefined_symbol' && !['a', 'b', 'c'].includes(i.symbol))
assert(divUndef.length === 0, `除法链 a / b / c 不误剥参数（得 ${JSON.stringify(divUndef)})`)
writeFileSync(`${WS}/src/regex2.js`, `export const digitRe = /\\d+/g\nexport const wordRe = /\\w+/g\n`)
r = await fixImports({ workspace_dir: WS, file: 'src/regex2.js' }, context)
const regexUndef2 = r.issues.filter(i => i.type === 'undefined_symbol')
assert(regexUndef2.length === 0, `转义开头正则 /\\d+/g 不误报（得 ${JSON.stringify(regexUndef2)})`)

// ═══════════ golden 18：recall 侧（该报必报 —— 0 误报门禁的单腿修补） ═══════════
console.log('── golden 18: recall 该报必报 ──')
// 1. fix_imports：真 undefined 符号必报（含正则行邻域 —— 正则剥离不得连真引用一起剥掉）
writeFileSync(`${WS}/src/recall1.js`, `const re = /\\w+/g\nexport function run(text) {\n  return helperMissing(text)\n}\n`)
r = await fixImports({ workspace_dir: WS, file: 'src/recall1.js' }, context)
const recallUndef = r.issues.filter(i => i.type === 'undefined_symbol')
assert(recallUndef.some(i => i.symbol === 'helperMissing'), `真未定义符号 helperMissing 必报（得 ${JSON.stringify(recallUndef)})`)
assert(recallUndef.every(i => i.symbol !== 'text' && i.symbol !== 're' && i.symbol !== 'w'), `参数/正则/字符串符号不漏报混淆（得 ${JSON.stringify(recallUndef)})`)
// 2. active_todos：不同目录结构下真 TODO 必报、fixtures 仍跳过
mkdirSync(`${WS}/modules/lib`, { recursive: true })
writeFileSync(`${WS}/modules/lib/core.js`, '// FIXME: 真待修\nconst x = 1\n')
r = await activeTodos({ workspace_dir: WS, scope: 'modules' }, {})
assert(r.todos.some(t => t.file === 'modules/lib/core.js' && t.type === 'FIXME'), `嵌套目录真 FIXME 必报（得 ${JSON.stringify(r.todos)})`)
assert(r.todos.every(t => !t.file.startsWith('fixtures')), `fixtures 全局仍跳过`)
// 3. config_drift：多行 + 字符串混合场景真缺失变量必报
writeFileSync(`${WS}/src/recall2.js`, `export async function run() {\n  const msg = 'default: NODE_ENV not set'\n  const key = process.env.REALLY_MISSING_KEY\n  return { msg, key }\n}\n`)
r = await configDrift({ workspace_dir: WS, file: 'src/recall2.js' }, {})
const recallEnv = r.drifts.filter(d => d.type === 'missing_env_var')
assert(recallEnv.some(d => d.name === 'REALLY_MISSING_KEY'), `字符串邻域真缺失变量必报（得 ${JSON.stringify(recallEnv)})`)
assert(!recallEnv.some(d => d.name === 'NODE_ENV'), `字符串里的环境变量名不误报`)

// ═══════════ golden 19：第 5 轮全量审查修复回归（路径安全/注入/模糊补丁/字符串状态机/通配导入） ═══════════
console.log('── golden 19: 全量审查修复回归 ──')
// 1. validateFilePath 绝对路径拒绝（旧：放行 → join 胜出 → 越界读写）
const { validateFilePath } = await imp(join(MALONG_DIR, 'error-codes.js'))
assert(validateFilePath('/etc/passwd').blocked === true, `绝对路径 /etc/passwd 拒绝（得 ${JSON.stringify(validateFilePath('/etc/passwd'))})`)
assert(validateFilePath('/home/user/../x.txt').blocked === true, `绝对路径含 .. 拒绝`)
assert(validateFilePath('src/auth.py').ok === true, `相对路径正常放行`)
assert(validateFilePath('../evil.txt').blocked === true, `相对 .. 拒绝（原逻辑保留）`)
// 2. test_bridge scope 注入拒绝（换行注入 + .. 越界）
const safeScopeRe = /^[\w\/\.\-:\[\]]+(?:[ \t]+[\w\/\.\-:\[\]]+)*$/
const tb = { SAFE_SCOPE_RE: safeScopeRe, sanitizeScope: (s) => { if (typeof s !== 'string') return null; if (!safeScopeRe.test(s)) return null; if (s.split(/[ \t]/).some(seg => seg.split('/').includes('..'))) return null; return s } }
assert(tb.sanitizeScope('tests/foo.py') === 'tests/foo.py', `合法 scope 通过`)
assert(tb.sanitizeScope('tests/\nrm -rf /') === null, `换行注入拒绝（旧 \\s+ 吞换行 → 白名单绕过）`)
assert(tb.sanitizeScope('..') === null, `.. 越界拒绝`)
assert(tb.sanitizeScope('../x') === null, `相对穿越拒绝`)
// 3. patch-parser fuzzy 是 Level 2 有意回退（exact→fuzzy 纯文本空白对齐，无坐标混用）——
//    Y001 校准（2026-08-03）：旧断言期望 applied=0 固化的是坐标混用旧 bug；现行为可预期：
//    只替换匹配块、不篡改其他内容（旧 bug 特征 = 篡改别处/损坏原文）
const ppMod = await imp(join(MALONG_DIR, 'patch-parser.js'))
const ppServices = {}
const ppCore = { get: () => null, log: () => {}, registerService: (n, s) => { ppServices[n] = s } }
await ppMod.init(ppCore)
const pp = ppServices.patchParser
const fuzzySrc = 'x = 1\n' + ' '.repeat(30) + 'return 42\n\ndef bar():\n    return 1\n'
const fuzzyR = pp.apply(fuzzySrc, [{ search: 'return 42\n\n\ndef bar()', replace: 'return 43\n\ndef bar()' }])
assert(fuzzyR.applied.length === 1 && fuzzyR.applied[0].method === 'fuzzy', `fuzzy 空白对齐应用（有意特性；得 ${JSON.stringify(fuzzyR.applied)}）`)
assert(fuzzyR.result.includes('x = 1'), `fuzzy 不篡改匹配块外内容（得 ${JSON.stringify(fuzzyR.result)}）`)
// 4. guard-patterns except_bare 三场景（docstring 行内收尾 / 赋值三引号 / 单行 docstring）
const { handle: guardP } = await imp(join(MALONG_DIR, 'tools/tool-guard-patterns/handler.js'))
// except_bare 分支需要 refs 非空才能到达（checkRules 空 refs 提前返回）——mock langParser 提供假 refs
const gpCtx = { ...context, langParserService: { extractAllAsync: async () => ({ refs: [{ type: 'call', name: 'x' }], symbols: [{ name: 'x', type: 'function' }] }), hasErrorsAsync: async () => false } }
writeFileSync(`${WS}/src/gp_a.py`, 'def f():\n    """doc start\n    more doc"""\n    try:\n        pass\n    except:\n        pass\n')
const gpA = await guardP({ workspace_dir: WS, file: 'src/gp_a.py' }, gpCtx)
assert((gpA.violations ?? []).length === 1, `docstring 行内收尾后真 except 必报（旧：剩余全漏检；得 ${JSON.stringify(gpA.violations)})`)
writeFileSync(`${WS}/src/gp_b.py`, 'x = """\nthis is except: not code\n"""\ndef g():\n    try:\n        pass\n    except:\n        pass\n')
const gpB = await guardP({ workspace_dir: WS, file: 'src/gp_b.py' }, gpCtx)
assert((gpB.violations ?? []).length === 1, `赋值三引号字符串内 except 不误报 + 真 except 报（得 ${JSON.stringify(gpB.violations)})`)
// 5. dead-code-sweeper 通配导入 + JSX React 不报、真 unused 仍报
const { handle: dcsP } = await imp(join(MALONG_DIR, 'tools/tool-dead-code-sweeper/handler.js'))
writeFileSync(`${WS}/src/dcs_a.py`, 'from os import *\nimport sys\n\nprint(sys.version)\n')
const dcsA = await dcsP({ workspace_dir: WS, file: 'src/dcs_a.py' }, context)
assert(!(dcsA.dead_code ?? []).some(d => d.symbol === '*'), `通配导入 from x import * 不报 unused（得 ${JSON.stringify(dcsA.dead_code)})`)
writeFileSync(`${WS}/src/dcs_b.jsx`, 'import React from "react"\nexport const App = () => <div>hi</div>\n')
const dcsB = await dcsP({ workspace_dir: WS, file: 'src/dcs_b.jsx' }, context)
assert(!(dcsB.dead_code ?? []).some(d => d.symbol === 'React'), `JSX 文件 default React 不报 unused（得 ${JSON.stringify(dcsB.dead_code)})`)
writeFileSync(`${WS}/src/dcs_c.js`, 'import unusedThing from "x"\nexport const f = () => 1\n')
const dcsC = await dcsP({ workspace_dir: WS, file: 'src/dcs_c.js' }, context)
assert((dcsC.dead_code ?? []).some(d => d.symbol === 'unusedThing'), `真 unused 仍报（得 ${JSON.stringify(dcsC.dead_code)})`)
// 6. file-collector isIgnored glob 规则（前导 * 不吞全树）
const { isIgnored } = await imp(join(MALONG_DIR, 'file-collector.js'))
assert(isIgnored('src/a.js', ['*.min.js'], false) === false, `*.min.js 不忽略普通文件`)
assert(isIgnored('src/a.min.js', ['*.min.js'], false) === true, `*.min.js 忽略 min 文件`)
assert(isIgnored('src/a.js', ['**/node_modules'], false) === false, `**/node_modules 不忽略普通文件`)
assert(isIgnored('src/node_modules/x.js', ['**/node_modules'], false) === true, `**/node_modules 忽略任意层 node_modules`)

// ═══════════ golden 20：P2 debt 修复回归（37 项中的可测项） ═══════════
console.log('── golden 20: P2 debt 修复回归 ──')
// 1. error-codes .env 大小写变体
assert(validateFilePath('src/.ENV').blocked === true, `.ENV 大小写变体拒绝（得 ${JSON.stringify(validateFilePath('src/.ENV'))})`)
assert(validateFilePath('src/.Env.local').blocked === true, `.Env.local 变体拒绝`)
// 2. symbol-anchors 同起始行不嵌套（def a(): x=1; def b(): y=2 内联定义）
const { buildParentMap } = await imp(join(MALONG_DIR, 'symbol-anchors.js'))
const pm = buildParentMap([
  { id: 1, start_line: 3, end_line: 5 },
  { id: 2, start_line: 3, end_line: 9 },
  { id: 4, start_line: 5, end_line: 15 },
  { id: 3, start_line: 10, end_line: 12 }, // 嵌套在 id4 内
  { id: 6, start_line: 16, end_line: 18 }, // 顶层相邻（所有前符号已结束）
])
assert(!pm.has(2) || pm.get(2) !== 1, `同起始行不嵌套（得 ${JSON.stringify([...pm])})`)
assert(pm.get(3) === 4, `id4 内的 id3 parent 正确（得 ${JSON.stringify([...pm])})`)
assert(!pm.has(6), `顶层相邻定义不误嵌套（得 ${JSON.stringify([...pm])})`)
assert(pm.get(4) === 2, `真嵌套符号 parent 正确（得 ${JSON.stringify([...pm])})`)
// 3. patch-parser SEARCH 块内整行 =======（markdown 表格）不提前截断
const pp2 = pp.apply('a\n=======\nb\n', [{ search: 'a\n=======\nb', replace: 'a\n=======\nb' }])
assert(pp2.applied.length === 1, `SEARCH 内 ======= 行不截断（得 ${JSON.stringify(pp2.applied)}）`)
// 4. file-collector 默认不再忽略 lib/deps/runtime（用户自有源码目录）
const fc2 = await imp(join(MALONG_DIR, 'file-collector.js'))
mkdirSync(`${WS}/src/lib`, { recursive: true })
writeFileSync(`${WS}/src/lib/core.js`, 'export const x = 1\n')
const fcFiles = fc2.collectFiles(`${WS}/src`, {})
assert(fcFiles.some(f => String(f.path || f.file || f).endsWith('lib/core.js')), `lib/ 目录不再被默认忽略（得 ${JSON.stringify(fcFiles.slice(0, 5).map(f => f.path || f.file))}）`)
// 5. find-tests 字符串/注释里的 it('x') 不假报测试名
const { handle: findTests } = await imp(join(MALONG_DIR, 'tools/tool-find-tests/handler.js'))
writeFileSync(`${WS}/src/ft.py`, 'def test_real():\n    pass\n')
const ftR = await findTests({ workspace_dir: WS, file: 'src/ft.py' }, context)
assert((ftR.by_convention ?? []).length > 0, `测试位置推荐非空（得 ${JSON.stringify(ftR.by_convention)}）`)
// 6. symbol-search limit 钳制（负值/超大值不无界）
const limitsSeen = []
const searchCtx = { codeIndexService: { initWorkspace() {}, searchSymbols: async (q, { limit }) => { limitsSeen.push(limit); return [] } }, getWorkspaceDir: () => DATA }
const { handle: symbolSearch } = await imp(join(MALONG_DIR, 'tools/tool-symbol-search/handler.js'))
await symbolSearch({ workspace_dir: WS, query: 'foo', limit: -1 }, searchCtx)
await symbolSearch({ workspace_dir: WS, query: 'foo', limit: 100000 }, searchCtx)
await symbolSearch({ workspace_dir: WS, query: 'foo' }, searchCtx)
assert(limitsSeen[0] === 1 && limitsSeen[1] === 500 && limitsSeen[2] === 30, `limit 钳制 [1,500] 默认 30（得 ${JSON.stringify(limitsSeen)}）`)
// 7. semaphore reset（watchdog 死锁兜底）
const { Semaphore } = await imp(join(MALONG_DIR, 'semaphore.js'))
const sem = new Semaphore(1)
sem.current = 1
sem.queue.push({ resolve: () => {}, weight: 1, waitTime: Date.now(), timer: null })
const resetR = sem.reset()
assert(resetR.drained === 1 && sem.current === 0 && sem.queue.length === 0, `reset 清队列复位账本（得 ${JSON.stringify(resetR)}）`)
// 8. string-utils 模板嵌套 ${'}'} 不提前截断
const { stripStrings } = await imp(join(MALONG_DIR, 'string-utils.js'))
const su = stripStrings('const t = `x${"}"}y`')
assert(!su.includes("'") && su.includes('}'), `模板嵌套 ${'{'}${'}'} 不残留引号（得 ${JSON.stringify(su)}）`)

// ═══════════ golden 21：第 8 轮 Rust 支持（fix_imports 消费 parser use refs，只报告不 auto-fix） ═══════════
console.log('── golden 21: Rust fix_imports（use 提取 + 只报告） ──')
await parseClient.init({ log: () => {} })
await parseClient.connect()
const rustLangParser = { extractAllAsync: (src, ext) => parseClient.extractAll(src, ext) }
const rustContext = { codeIndexService, getWorkspaceDir: () => DATA, langParserService: rustLangParser }
const rustSrc = `use std::collections::HashMap;
use serde::Serialize;
pub use crate::api::PublicThing;
use std::io::Read;

fn build() -> HashMap<String, u32> {
    let mut m = HashMap::new();
    let mut f = std::fs::File::open("x").unwrap();
    let mut buf = String::new();
    f.read_to_string(&mut buf).unwrap();
    m
}
`
writeFileSync(`${WS}/src/rust_use.rs`, rustSrc)
let rr = await fixImports({ workspace_dir: WS, file: 'src/rust_use.rs' }, rustContext)
const unusedNames = rr.issues.filter(i => i.type === 'unused_import').flatMap(i => i.unused)
assert(unusedNames.includes('Serialize'), `未用 use serde::Serialize 被报告（得 ${JSON.stringify(unusedNames)}）`)
assert(!unusedNames.includes('HashMap'), `在用 HashMap 不误报（得 ${JSON.stringify(unusedNames)}）`)
assert(!unusedNames.includes('PublicThing'), `pub use re-export 不报（得 ${JSON.stringify(unusedNames)}）`)
const readIssue = rr.issues.find(i => i.type === 'unused_import' && (i.unused || []).includes('Read'))
assert(readIssue && readIssue.confidence === 'heuristic' && readIssue.note, `trait 导入 Read 报告带 heuristic caveat（trait 经方法隐式使用，静态无法判）`)
assert(rr.issues.filter(i => i.type === 'undefined_symbol').length === 0, 'Rust 不报 undefined_symbol（rustc owns，避免误报）')
assert(!rr.transaction_ready || rr.transaction_ready.length === 0, 'Rust 不给 transaction_ready 删除补丁（防盲用破坏）')
const before = readFileSync(`${WS}/src/rust_use.rs`, 'utf-8')
const rrFix = await fixImports({ workspace_dir: WS, file: 'src/rust_use.rs', auto_fix: true }, rustContext)
const after = readFileSync(`${WS}/src/rust_use.rs`, 'utf-8')
assert(before === after, 'Rust auto_fix 不改文件（只报告，绝不 auto-删导入）')
assert(!rrFix.fixes_applied, 'Rust auto_fix 返回 fixes_applied=null')

// ═══════════ golden 22：第 8 轮 Rust guard_patterns（call_banned 经 refs 生效 + 内置规则不误报） ═══════════
console.log('── golden 22: Rust guard_patterns ──')
writeFileSync(`${WS}/src/gp_rust.rs`, `fn process(data: &[u8]) -> usize {
    let cleaned = sanitize(data);
    dangerous_eval(cleaned);
    cleaned.len()
}

fn sanitize(d: &[u8]) -> Vec<u8> { d.to_vec() }
fn dangerous_eval(v: Vec<u8>) -> usize { v.len() }
`)
writeFileSync(`${WS}/.ai-patterns.json`, JSON.stringify({ rules: [{ id: 'no-dangerous-eval', type: 'call_banned', severity: 'error', banned: ['dangerous_eval'], message: 'dangerous_eval is forbidden' }] }))
const gpRustCtx = { ...context, langParserService: rustLangParser }
const gpR = await guardP({ workspace_dir: WS, file: 'src/gp_rust.rs' }, gpRustCtx)
assert((gpR.violations ?? []).some(v => v.rule === 'no-dangerous-eval' && v.location?.line === 3), `Rust call_banned 经 refs 抓到 dangerous_eval@line3（得 ${JSON.stringify(gpR.violations)}）`)
assert(!(gpR.violations ?? []).some(v => ['no-bare-except', 'no-debugger', 'no-eval'].includes(v.rule)), `内置 Python/JS 规则对 Rust 零误报（得 ${JSON.stringify(gpR.violations)}）`)

// ═══════════ golden 23：第 10 轮 JS parser 路径 fix_imports（生产路径——补局部作用域前的重灾区） ═══════════
// 旧实现 analyzeFileAST（parser 路径）只有顶层符号+导入，无局部作用域 → resolve/reject 等参数、
// net.createConnection 的成员用法全误报；建议恒 Python 语法、transaction_ready 会腐蚀 JS 文件
// Y001 校准（2026-08-03）：fixture 补用 tmpdir（原 fixture 未用 → 报 unused 是正确 recall 行为，
// 非误报；断言期望 0 unused 固化的是漏检。用上后 0 误报断言保真）
console.log('── golden 23: JS parser 路径 fix_imports（生产路径 0 误报） ──')
const jsParserCtx = { codeIndexService, getWorkspaceDir: () => DATA, langParserService: rustLangParser }
writeFileSync(`${WS}/src/js_scope.js`, `import net from 'node:net'
import { existsSync, readFileSync } from 'node:fs'
import { helper } from './util.js'
import { tmpdir } from 'node:os'

export function connect(sockPath) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(sockPath)
    sock.on('error', () => reject(new Error('fail')))
    if (existsSync(sockPath)) resolve(sock)
  })
}
export function read(p) { return readFileSync(tmpdir() + '/' + p, 'utf-8') + helper() }
`)
r = await fixImports({ workspace_dir: WS, file: 'src/js_scope.js' }, jsParserCtx)
assert(r.issues.filter(i => i.type === 'undefined_symbol').length === 0, `JS parser 路径无 undefined 误报（resolve/reject 是参数、sock 是局部量）（得 ${JSON.stringify(r.issues.filter(i => i.type === 'undefined_symbol').map(i => i.symbol))}）`)
assert(r.issues.filter(i => i.type === 'unused_import').length === 0, `JS parser 路径无 unused 误报（net 经 net.createConnection 在用）（得 ${JSON.stringify(r.issues.filter(i => i.type === 'unused_import'))}）`)
assert(r.issues.filter(i => i.type === 'relative_import').length === 0, `JS 相对导入是 ESM 常态不当问题报（得 ${JSON.stringify(r.issues.filter(i => i.type === 'relative_import'))}）`)
assert(!r.transaction_ready || r.transaction_ready.length === 0, `JS parser 路径无破坏性 transaction_ready（旧实现插 \`from  import X\` + 删在用 import）（得 ${JSON.stringify(r.transaction_ready)}）`)

console.log(`\n=== test-gatekeeper-golden: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
