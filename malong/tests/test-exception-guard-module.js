// test-exception-guard-module.js — r12: exception_guard 模块边界（隔壁实战教训）
// 背景：sancai 的 YamlError 被建议给 tongtian（跨语言已修、跨模块没修）——同工作区不同子系统
// 的异常类互相污染。修复：hierarchy 只收目标文件所在模块（目录子树 + 祖先链直接子文件）；
// 边界内无异常类时回退全库并标注 hierarchy_scope='project'。
import { join, dirname } from 'node:path'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}

const WS = join(os.tmpdir(), 'opencode', 'r12-eg-ws')
rmSync(WS, { recursive: true, force: true })
mkdirSync(join(WS, 'module-a'), { recursive: true })
mkdirSync(join(WS, 'module-b'), { recursive: true })

// 同模块异常（module-a 内）
writeFileSync(join(WS, 'module-a/errors.js'), 'export class NotFoundError extends Error {}\nexport class YamlError extends Error {}\n')
// 跨模块异常（module-b 内，sancai 类比——不应建议给 module-a）
writeFileSync(join(WS, 'module-b/errors.js'), 'export class RemoteError extends Error {}\n')
// 被检查文件
writeFileSync(join(WS, 'module-a/app.js'), [
  'export function find() {',
  "  throw new Error('user not found')",
  '}',
].join('\n') + '\n')
writeFileSync(join(WS, 'module-b/app.js'), [
  'export function call() {',
  "  throw new Error('remote failed')",
  '}',
].join('\n') + '\n')

const { handle } = await import(pathToFileURL(join(__dirname, '..', 'tools/tool-exception-guard/handler.js')).href)
const ctx = { codeIndexService: null, getWorkspaceDir: () => WS }

// ① module-a/app.js：同模块异常进 hierarchy，跨模块 RemoteError 排除
const ra = await handle({ workspace_dir: WS, file: 'module-a/app.js' }, ctx)
const namesA = Object.keys(ra.project_exceptions || {})
console.log('  module-a project_exceptions:', JSON.stringify(namesA), 'scope:', ra.hierarchy_scope)
assert(namesA.includes('NotFoundError'), 'module-a 同模块 NotFoundError 进 hierarchy')
assert(namesA.includes('YamlError'), 'module-a 同目录 YamlError 进 hierarchy')
assert(!namesA.includes('RemoteError'), 'module-a 跨模块 RemoteError 不进 hierarchy（r12 修复点）')
assert(ra.hierarchy_scope === 'module', `module-a scope=module，实际 ${ra.hierarchy_scope}`)

// ② module-b/app.js：同模块 RemoteError 进 hierarchy，跨模块 NotFoundError/YamlError 排除
const rb = await handle({ workspace_dir: WS, file: 'module-b/app.js' }, ctx)
const namesB = Object.keys(rb.project_exceptions || {})
console.log('  module-b project_exceptions:', JSON.stringify(namesB), 'scope:', rb.hierarchy_scope)
assert(namesB.includes('RemoteError'), 'module-b 同模块 RemoteError 进 hierarchy')
assert(!namesB.includes('NotFoundError'), 'module-b 跨模块 NotFoundError 不进 hierarchy（r12 修复点）')
assert(rb.hierarchy_scope === 'module', `module-b scope=module，实际 ${rb.hierarchy_scope}`)

// ③ 边界内无异常类（新建空模块 module-c）→ 回退全库 + scope=project
mkdirSync(join(WS, 'module-c'), { recursive: true })
writeFileSync(join(WS, 'module-c/app.js'), 'export function run() { throw new Error("boom") }\n')
const rc = await handle({ workspace_dir: WS, file: 'module-c/app.js' }, ctx)
const namesC = Object.keys(rc.project_exceptions || {})
console.log('  module-c project_exceptions:', JSON.stringify(namesC), 'scope:', rc.hierarchy_scope)
assert(rc.hierarchy_scope === 'project', `module-c scope=project（回退全库），实际 ${rc.hierarchy_scope}`)

console.log(`\n== test-exception-guard-module: ${pass} passed, ${fail} failed ==`)
process.exit(fail > 0 ? 1 : 0)
