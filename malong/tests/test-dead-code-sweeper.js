// test-dead-code-sweeper.js — r12: dead_code_sweeper 文本级兜底引用 + unused_guard 架构级未接线信号
// 背景（隔壁实战教训）：seedTasks 被 tongtian-cli 字符串引用（CLI 命令/scripts/*.sh/package.json）
// 却报死代码——unused_function 只看 import 图。本测试复刻该场景 + 守卫类函数零调用 → unused_guard。
import { join, dirname } from 'node:path'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}

const WS = join(os.tmpdir(), 'opencode', 'r12-dcs-ws')
rmSync(WS, { recursive: true, force: true })
mkdirSync(join(WS, 'src'), { recursive: true })
mkdirSync(join(WS, 'scripts'), { recursive: true })
mkdirSync(join(WS, 'docs'), { recursive: true })

// seedTasks：仅被 CLI 命令字符串引用（import 图外）——r12 前误报死代码
writeFileSync(join(WS, 'src/app.js'), [
  'export function seedTasks() { return 1 }',
  'export function trulyDeadFn() { return 2 }',
  'export function assertAllowedSource(x) { return !!x }',
  'export function liveFn() { return 3 }',
  'function internalDeadFn() { return 4 }',
].join('\n') + '\n')
// CLI 脚本字符串引用 seedTasks（tongtian-cli seed 同款场景）
writeFileSync(join(WS, 'scripts/cli.sh'), '#!/bin/bash\ntongtian-cli seedTasks --all\n')
// package.json scripts 引用
writeFileSync(join(WS, 'package.json'), JSON.stringify({ name: 'ws', scripts: { seed: 'node cli.js seedTasks' } }))
writeFileSync(join(WS, 'docs/notes.md'), '# notes\n\nseedTasks is invoked by the cli\n')

const pc = await import(pathToFileURL(join(__dirname, '..', 'parse-client.js')).href)
await pc.init({ log: () => {} })
try { await pc.connect() } catch {}
const { default: codeIndex } = await import(pathToFileURL(join(__dirname, '..', 'code-index.js')).href)
const langParser = {
  extractAllAsync: (s, e, f) => pc.extractAll(s, e, f),
  hasErrorsAsync: (s, e, f) => pc.hasErrors(s, e, f),
  batchExtractAsync: (f) => pc.batchExtract(f),
}
const services = { langParser }
const core = {
  services,
  getService: (n) => services[n],
  registerService: (n, svc) => { services[n] = svc },
  getWorkspaceDir: () => WS,
  log: () => {},
  emit: () => {},
  get: (k, def) => def,
}
await codeIndex.init(core)
const svc = services.codeIndex
await svc.initWorkspace(WS)
await svc.indexProject(WS)
const ctx = { codeIndexService: svc, getWorkspaceDir: () => WS }

const { handle } = await import(pathToFileURL(join(__dirname, '..', 'tools/tool-dead-code-sweeper/handler.js')).href)
const r = await handle({ workspace_dir: WS }, ctx)

const names = (r.dead_code || []).map(d => d.name)
console.log('  dead_code:', JSON.stringify(r.dead_code.map(d => d.type + ':' + (d.name || d.file))))

// seedTasks 被 CLI/scripts/文档文本引用 → 必须不报（r12 修复点）
assert(!r.dead_code.some(d => d.name === 'seedTasks'), 'seedTasks（CLI 字符串引用）不报死代码')
// assertAllowedSource 守卫类零调用 → unused_guard 架构级信号
const guard = r.dead_code.find(d => d.name === 'assertAllowedSource')
assert(guard && guard.type === 'unused_guard', '守卫类零调用 → unused_guard（不是 unused_function）')
assert(r.summary.unused_guards === 1, `summary.unused_guards = 1，实际 ${r.summary.unused_guards}`)
// 真死函数仍报 unused_function
assert(r.dead_code.some(d => d.name === 'trulyDeadFn' && d.type === 'unused_function'), '真死函数仍报 unused_function')
assert(r.dead_code.some(d => d.name === 'internalDeadFn' && d.type === 'unused_function'), '内部死函数仍报 unused_function')

console.log(`\n== test-dead-code-sweeper: ${pass} passed, ${fail} failed ==`)
process.exit(fail > 0 ? 1 : 0)
