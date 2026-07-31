// test-dogfood-r12.js — 第 12 轮全工具 dogfood 修复回归
// 锁定：#1 references 行号 / #2 edit_batch diff 换行 / #4 mock_sync 类方法 / #5 exception_guard 同语言 / #6 find_tests 文本反查
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MALONG = join(__dirname, '..')

let pass = 0, fail = 0
function assert(c, m) { if (c) { pass++ } else { fail++; console.error('  FAIL:', m) } }

// ── #1 references/getReferences 返回行号（fresh CodeIndex + 运行中 daemon）──
{
  const WS = '/tmp/opencode/r12-refline'
  const DATA = '/tmp/opencode/r12-refline-data'
  const SOCK = '/tmp/opencode/r12-refline.sock'
  rmSync(WS, { recursive: true, force: true }); rmSync(DATA, { recursive: true, force: true })
  mkdirSync(join(WS, 'src'), { recursive: true }); mkdirSync(DATA, { recursive: true })
  writeFileSync(join(WS, 'src/caller.js'), `import { helper } from './lib.js'\nexport function a() {\n  helper(1)\n  const x = helper(2)\n  return helper(3) + x\n}\n`)
  writeFileSync(join(WS, 'src/lib.js'), `export function helper(n) { return n * 2 }\n`)
  const pc = await import(join(MALONG, 'parse-client.js'))
  await pc.init({ log: () => {} })
  const ok = await pc.connect()
  assert(ok, '#1 parse-client 连接 daemon')
  const { default: codeIndex } = await import(join(MALONG, 'code-index.js'))
  const langParser = { extractAllAsync: (s, e, f) => pc.extractAll(s, e, f), batchExtractAsync: (f) => pc.batchExtract(f) }
  const services = { langParser }
  const core = { services, getService: n => services[n], registerService: (n, s) => { services[n] = s }, getWorkspaceDir: () => DATA, log: () => {}, emit: () => {}, get: (k, d) => k === 'codeIndex.udsPath' ? SOCK : (k === 'codeIndex.udsToken' ? '' : d) }
  await codeIndex.init(core)
  const svc = services.codeIndex
  svc.initWorkspace(WS)
  await svc.indexBatch([join(WS, 'src/caller.js'), join(WS, 'src/lib.js')], WS)
  svc.resolveCrossFileRefs()
  const refs = await svc.getReferences('helper')
  const lines = refs.filter(r => r.path.endsWith('caller.js')).map(r => r.line)
  assert(lines.length >= 3, `#1 caller.js helper 引用 ≥3（得 ${lines.length}）`)
  assert(lines.every(l => l > 0), `#1 引用带行号（得 ${lines.join(',')}）`)
  assert(new Set(lines).size === lines.length, `#1 同文件多处引用行号互异（得 ${lines.join(',')}）`)
  rmSync(WS, { recursive: true, force: true }); rmSync(DATA, { recursive: true, force: true })
}

// ── #2 edit_batch generate_diff 头行换行（Python）──
{
  const py = join(MALONG, 'tools/tool-batch-edit/batch_edit_mvp.py')
  const out = execFileSync('python3', ['-c', `
import sys; sys.path.insert(0, ${JSON.stringify(dirname(py))})
import batch_edit_mvp as m
d = m.generate_diff('a\\nb\\n', 'a\\nc\\n', 'f.txt')
print(d.startswith('--- a/f.txt\\n+++ b/f.txt\\n@@'))
`], { encoding: 'utf-8' }).trim()
  assert(out === 'True', `#2 generate_diff 头行带换行（得 ${out}）`)
}

// ── #4 mock_sync 认得类/对象方法 ──
{
  const WS = '/tmp/opencode/r12-mock'
  rmSync(WS, { recursive: true, force: true }); mkdirSync(join(WS, 'src'), { recursive: true })
  writeFileSync(join(WS, 'src/svc.js'), `class Svc {\n  async getImpactAnalysis(filePath, opts) {\n    return null\n  }\n}\n`)
  const { handle } = await import(join(MALONG, 'tools/tool-mock-syncer/handler.js'))
  const r = await handle({ workspace_dir: WS, file: 'src/svc.js', function: 'getImpactAnalysis' }, {})
  assert(!r.error, `#4 mock_sync 找到类方法（得 ${r.error || 'ok'}）`)
  assert(r.target?.line === 2, `#4 类方法定位 line=2（得 ${r.target?.line}）`)
  rmSync(WS, { recursive: true, force: true })
}

// ── #5 exception_guard 同语言过滤（JS 目标不吃 Python 异常）──
{
  const WS = '/tmp/opencode/r12-eg'
  rmSync(WS, { recursive: true, force: true }); mkdirSync(join(WS, 'src'), { recursive: true })
  writeFileSync(join(WS, 'src/app.js'), `export function f(x) { if (!x) throw new Error('not found') }\n`)
  writeFileSync(join(WS, 'code-index.db'), '')
  const { handle } = await import(join(MALONG, 'tools/tool-exception-guard/handler.js'))
  const pyClasses = [{ name: 'ValidationError', type: 'class', file: 'fixtures/exceptions.py', start_line: 1 }]
  const ctx = { codeIndexService: { initWorkspace() {}, searchSymbols: async q => pyClasses.filter(c => c.name.includes(q)) }, getWorkspaceDir: () => WS }
  const r = await handle({ workspace_dir: WS, file: 'src/app.js' }, ctx)
  assert(Object.keys(r.project_exceptions).length === 0, `#5 JS 目标过滤 Python 异常（得 ${Object.keys(r.project_exceptions).join(',')}）`)
  assert(r.issues.length === 0, `#5 JS 无跨语言误报（得 ${r.issues.length}）`)
  rmSync(WS, { recursive: true, force: true })
}

// ── #6 find_tests 文本反查（动态 import 的测试）──
{
  const WS = '/tmp/opencode/r12-ft'
  rmSync(WS, { recursive: true, force: true }); mkdirSync(join(WS, 'src'), { recursive: true }); mkdirSync(join(WS, 'tests'), { recursive: true })
  writeFileSync(join(WS, 'src/health-check.js'), `export function run() { return 1 }\n`)
  writeFileSync(join(WS, 'tests/test-dyn.js'), `const m = await import('../src/health-check.js')\nconsole.log(m.run())\n`)
  const { handle } = await import(join(MALONG, 'tools/tool-find-tests/handler.js'))
  const r = await handle({ workspace_dir: WS, file: 'src/health-check.js' }, {})
  assert(r.by_import.some(t => t.path.endsWith('test-dyn.js')), `#6 文本反查找到动态 import 测试（得 ${JSON.stringify(r.by_import)}）`)
  assert(r.by_import.some(t => t.line > 0), '#6 反查结果带行号')
  rmSync(WS, { recursive: true, force: true })
}

console.log(`\n=== test-dogfood-r12: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
