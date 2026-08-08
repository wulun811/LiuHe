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
try { rmSync(WS, { recursive: true, force: true }) } catch {}
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
  extractAllAsync: (s, e, f, ws) => pc.extractAll(s, e, f, ws),
  hasErrorsAsync: (s, e, f, ws) => pc.hasErrors(s, e, f, ws),
  batchExtractAsync: (f, ws) => pc.batchExtract(f, ws),
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

// ===== R22-㉒ 三修复：ansible 真实项目实测（__future__ 误报 / LIMIT 截断漏报 / 赋值&kwarg 误报）=====
// ① from __future__ import 是指令不是名字绑定——永不报 unused_import
writeFileSync(join(WS, 'py_future.py'), [
  'from __future__ import absolute_import, division, print_function',
  'import itertools',
  'import os',
  '',
  'def helper():',
  '    return os.path.join("a", "b")',
].join('\n') + '\n')
// ② scope 子目录 LIMIT 截断：dirA 1 个死函数 + dirB 60 个死函数（61 > LIMIT 50 窗口）
mkdirSync(join(WS, 'dirA'), { recursive: true })
mkdirSync(join(WS, 'dirB'), { recursive: true })
writeFileSync(join(WS, 'dirA/dead_in_a.py'), 'def deadInA():\n    return 1\ndef usedInA():\n    return 2\nprint(usedInA())\n')
const dirBDead = Array.from({ length: 60 }, (_, i) => `def deadB${i}():\n    return ${i}\n`).join('\n')
writeFileSync(join(WS, 'dirB/many_dead.py'), dirBDead + '\n')

await svc.indexProject(WS, { timeout: 60000 })

const r2 = await handle({ workspace_dir: WS, scope: 'py_future.py' }, ctx)
assert(!r2.dead_code.some(d => d.symbol === 'absolute_import'), 'from __future__ import absolute_import 不报')
assert(!r2.dead_code.some(d => d.symbol === 'division'), 'from __future__ import division 不报')
assert(!r2.dead_code.some(d => d.symbol === 'print_function'), 'from __future__ import print_function 不报')
assert(!r2.dead_code.some(d => d.symbol === 'os'), '已使用的 os import 不报')
assert(r2.dead_code.some(d => d.symbol === 'itertools' && d.type === 'unused_import'), '普通未用 import 仍报')

// 旧实现（无 scopePrefix）：LIMIT 50 全仓窗口被 dirB 60 个死函数占满 → dirA 死函数漏报
const r3 = await handle({ workspace_dir: WS, scope: 'dirA' }, ctx)
assert(r3.dead_code.some(d => d.name === 'deadInA' && d.type === 'unused_function'), 'scope 子目录死函数不被全仓 LIMIT50 截断')

// ③ 函数作为值传递形态（赋值 RHS / kwarg）refs 不记录 → isValueReferenced 豁免
const { isValueReferenced } = await import(pathToFileURL(join(__dirname, '..', 'code-index.js')).href)
writeFileSync(join(WS, 'valref.py'), [
  'def callback():',
  '    return 1',
  '',
  'def kwarg_only():',
  '    return 2',
  '',
  'sys.excepthook = callback',
  'os.walk("/", onerror=kwarg_only)',
].join('\n') + '\n')
assert(isValueReferenced('callback', join(WS, 'valref.py')), '赋值 RHS 引用豁免（sys.excepthook = fn）')
assert(isValueReferenced('kwarg_only', join(WS, 'valref.py')), 'kwarg 值引用豁免（onerror=fn）')
writeFileSync(join(WS, 'cmp.py'), 'if a == maybe_fn:\n    pass\n')
assert(!isValueReferenced('maybe_fn', join(WS, 'cmp.py')), '== 比较形态不豁免')
assert(!isValueReferenced('nopeFn', join(WS, 'cmp.py')), '无赋值引用不豁免')

console.log(`\n== test-dead-code-sweeper: ${pass} passed, ${fail} failed ==`)
process.exit(fail > 0 ? 1 : 0)
