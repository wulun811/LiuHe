// test-gatekeeper-golden.js — 质检员上岗考核（0 误报门禁）
// golden fixtures 全部来自生产体检发现的真实 bug（2026-07-31）：
//   fix_imports：node:/多行 import/模板字符串/数组解构/C 风格 for/export async/副作用导入/修剪保真/语法护栏
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MALONG_DIR = join(__dirname, '..')
const { handle: fixImports } = await import(join(MALONG_DIR, 'tools/tool-fix-imports/handler.js'))

let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}

const WS = '/tmp/opencode/gatekeeper-ws'
const DATA = '/tmp/opencode/gatekeeper-data'
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
const { handle: editBatch } = await import(join(MALONG_DIR, 'tools/tool-batch-edit/handler.js'))
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
const { handle: deadSweep } = await import(join(MALONG_DIR, 'tools/tool-dead-code-sweeper/handler.js'))
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
const { handle: excGuard } = await import(join(MALONG_DIR, 'tools/tool-exception-guard/handler.js'))
writeFileSync(`${WS}/src/main.go`, 'package main\n\nfunc main() {\n\tpanic("boom")\n}\n')
r = await excGuard({ workspace_dir: WS, file: 'src/main.go' }, { codeIndexService: null, getWorkspaceDir: () => DATA })
assert(r.error === 'unsupported_language', `不支持扩展名显式报错（得 ${r.error}）`)
assert(r.issues.length === 0 && r.summary.language_supported === false, `不谎报 clean（issues=0 且 language_supported=false）`)
r = await excGuard({ workspace_dir: WS, file: 'src/sweep2.py' }, { codeIndexService: null, getWorkspaceDir: () => DATA })
assert(r.error === undefined && Array.isArray(r.issues), `支持语言正常路径不受影响`)

// ═══════════ golden 12：active_todos 跳过 fixtures（测试假数据不污染） ═══════════
console.log('── golden 12: active_todos fixtures 跳过 ──')
const { handle: activeTodos } = await import(join(MALONG_DIR, 'tools/tool-active-todos/handler.js'))
mkdirSync(`${WS}/fixtures`, { recursive: true })
mkdirSync(`${WS}/src`, { recursive: true })
writeFileSync(`${WS}/fixtures/dummy.js`, '// TODO: 假数据里的 TODO 不应被扫到\nconst x = 1\n')
writeFileSync(`${WS}/src/real.js`, '// TODO: 真实代码里的 TODO 应保留\nfunction f() { return 1 }\n')
r = await activeTodos({ workspace_dir: WS, scope: '.' }, {})
assert(r.todos.every(t => t.file !== 'fixtures/dummy.js'), `fixtures 内 TODO 被跳过（得 ${r.todos.map(t => t.file).join(',')})`)
assert(r.todos.some(t => t.file === 'src/real.js'), `真实代码 TODO 保留`)

// ═══════════ golden 13：config_drift CI 内置变量白名单（GITHUB_* 不误报） ═══════════
console.log('── golden 13: config_drift CI 白名单 ──')
const { handle: configDrift } = await import(join(MALONG_DIR, 'tools/tool-config-drift/handler.js'))
writeFileSync(`${WS}/src/ci.js`, `export async function run() {\n  const repo = process.env.GITHUB_REPOSITORY\n  const token = process.env.GITHUB_TOKEN\n  const custom = process.env.MY_CUSTOM_KEY\n  return { repo, token, custom }\n}\n`)
writeFileSync(`${WS}/.env.example`, 'MY_CUSTOM_KEY=x\n')
r = await configDrift({ workspace_dir: WS, file: 'src/ci.js' }, {})
const ciDrifts = r.drifts.filter(d => d.type === 'missing_env_var')
assert(!ciDrifts.some(d => d.name === 'GITHUB_REPOSITORY' || d.name === 'GITHUB_TOKEN'), `CI 内置变量不误报（得 ${JSON.stringify(ciDrifts)})`)
assert(!ciDrifts.some(d => d.name === 'MY_CUSTOM_KEY'), `已声明变量不误报`)
writeFileSync(`${WS}/src/ci2.js`, `export async function run() {\n  return process.env.TRULY_MISSING\n}\n`)
r = await configDrift({ workspace_dir: WS, file: 'src/ci2.js' }, {})
assert(r.drifts.some(d => d.name === 'TRULY_MISSING'), `真缺失变量仍报（不漏报）`)

console.log(`\n=== test-gatekeeper-golden: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
