// test-s5-orient.js — S5.3 路由纵切（system/isolate/document）
// 覆盖：detectEntryPoints（package main/bin + 约定入口）、reproBoundary（root+callees 去重）、
//       docCoverage（启发式文档覆盖）、code_task 三路由首屏 orientation、非纵切路由 orientation=null。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  FAIL:', msg) } }

const TMP = join(os.tmpdir(), 'opencode', 's5-orient-test')
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
process.env.MALONG_STATE_DIR = join(TMP, 'state')
mkdirSync(join(TMP, 'src'), { recursive: true })
mkdirSync(join(TMP, 'bin'), { recursive: true })

const imp = (p) => import(pathToFileURL(p).href)
const orient = await imp(join(__dirname, '..', 'workflow', 'orient.js'))

// ── 1. detectEntryPoints ──
writeFileSync(join(TMP, 'package.json'), JSON.stringify({ name: 'x', main: 'src/app.js', bin: { cli: 'bin/cli.js' } }))
writeFileSync(join(TMP, 'index.js'), '// entry\n')
writeFileSync(join(TMP, 'src', 'app.js'), 'export function login(p) { return p }\n')
writeFileSync(join(TMP, 'bin', 'cli.js'), '#!/usr/bin/env node\n')
const ep = orient.detectEntryPoints(TMP)
assert(ep.files.includes('src/app.js') && ep.files.includes('bin/cli.js'), 'package main/bin 入入口')
assert(ep.files.includes('index.js'), '约定入口 index.js 命中')
assert(ep.from_package.includes('src/app.js') && ep.from_package.includes('bin/cli.js'), 'from_package 标注来源')
assert(orient.detectEntryPoints(join(TMP, 'nope')).files.length === 0, '不存在的 workspace → 空入口（不抛）')

// ── 2. reproBoundary ──
const rb = orient.reproBoundary({
  symbol: 'login', file: 'src/app.js',
  callees: [{ name: 'hash', file: 'src/helper.js', line: 3 }, { name: 'log', file: 'src/helper.js', line: 9 }],
})
assert(rb && rb.root.symbol === 'login', 'root 记根符号')
assert(rb.files.length === 2 && rb.files.includes('src/helper.js'), '边界文件去重（root+callees）')
assert(rb.symbols.length === 3 && rb.symbols[0].role === 'root' && rb.symbols[1].role === 'callee', '符号含 root+callee 角色')
assert(rb.callee_count === 2, 'callee_count 正确')
assert(orient.reproBoundary(null) === null, 'impact 缺失 → null')

// ── 3. docCoverage ──
writeFileSync(join(TMP, 'src', 'd.js'), ['// doc for a', 'function a() {}', '', 'function b() {}', ''].join('\n'))
const dc = orient.docCoverage(TMP, [{ file: 'src/d.js', symbols: [{ name: 'a', kind: 'function', line: 2 }, { name: 'b', kind: 'function', line: 4 }] }])
assert(dc.total === 2 && dc.documented === 1, `doc 覆盖 1/2（得 ${dc.documented}/${dc.total}）`)
assert(dc.undocumented.length === 1 && dc.undocumented[0].name === 'b', '未文档化符号 b')
assert(dc.coverage === 0.5, 'coverage=0.5')

// ── 4. code_task 路由纵切首屏 ──
function mockIndex() {
  const symbols = {
    'src/app.js': [{ name: 'login', type: 'function', start_line: 1, end_line: 1, stable_id: 'js:src/app.js::login#function', signature: 'function login(p)', body_hash: 'h', signature_hash: 's' }],
  }
  return {
    async initWorkspace() {},
    async indexBatch() { return ['src/app.js'] },
    async findDefinitions(name) { return name === 'login' ? [{ name, type: 'function', path: 'src/app.js', start_line: 1, end_line: 1 }] : [] },
    async searchSymbols() { return [] },
    findSymbolsInFile(file, name, kind) { return (symbols[file] || []).filter(s => s.name === name && (!kind || s.type === kind)) },
    getSymbolByStableId() { return null },
    getFileByPath(file) { return { path: file, index_state: 'fresh' } },
    async getFileOutline() { return { outline: [{ name: 'login', type: 'function', line: 1 }] } },
    async getImpactAnalysis() {
      return { callers: [], callees: [{ name: 'hash', file: 'src/helper.js', line: 3 }], caller_count: { direct: 0, indirect: 0 }, risk_level: 'low', limitations: [] }
    },
  }
}
const ctx = { codeIndexService: mockIndex(), getWorkspaceDir: (w) => w }
const taskMod = await imp(join(__dirname, '..', 'tools', 'tool-code-task', 'handler.js'))

let t = await taskMod.handle({ workspace_dir: TMP, goal: 'map the architecture and entry points', route: 'system' }, ctx)
assert(t.ok === true && t.observation.orientation?.kind === 'system', 'system 路由 → orientation.system')
assert(t.observation.orientation.entry_points.files.length >= 1, 'system 入口点非空')

t = await taskMod.handle({ workspace_dir: TMP, goal: 'isolate the empty password bug in login', route: 'isolate', target: { symbol: 'login' } }, ctx)
assert(t.ok === true && t.observation.orientation?.kind === 'isolate', 'isolate 路由 → orientation.isolate')
assert(t.observation.orientation.boundary?.files?.includes('src/helper.js'), 'isolate 边界含被调者文件')

t = await taskMod.handle({ workspace_dir: TMP, goal: 'document the login function', route: 'document', target: { symbol: 'login' } }, ctx)
assert(t.ok === true && t.observation.orientation?.kind === 'document', 'document 路由 → orientation.document')
assert(t.observation.orientation.coverage && typeof t.observation.orientation.coverage.total === 'number', 'document 覆盖统计')

t = await taskMod.handle({ workspace_dir: TMP, goal: 'what does login do', route: 'understand', target: { symbol: 'login' } }, ctx)
assert(t.ok === true && t.observation.orientation === null, '非纵切路由（understand）→ orientation=null')

// ── R3：goal 精确符号名置顶（同文件常量不得靠声明序压过目标函数）──
{
  writeFileSync(join(TMP, 'src', 'rank.js'), 'const CONST_A = 1\nexport function targetFn() { return CONST_A }\n')
  const { findCandidates } = await imp(join(__dirname, '..', 'tools', 'entry-shared.js'))
  const mock = {
    getFileOutline: async () => ({ outline: [
      { name: 'CONST_A', type: 'variable', line: 1 },
      { name: 'targetFn', type: 'function', line: 2 },
    ] }),
    findDefinitions: async () => [],
    searchSymbols: async () => [],
    getSymbolsAtLine: async () => [],
  }
  const cs = await findCandidates(mock, TMP, 'targetFn 的实现细节和调用方', { file: 'src/rank.js' }, { files: ['src/rank.js'] })
  assert(cs[0]?.name === 'targetFn', `R3 精确名置顶（得 ${cs[0]?.name} / ${cs.map(c => c.name).join(',')}）`)
}

console.log(`\n=== test-s5-orient: ${pass} passed, ${fail} failed ===`)
process.exit(fail > 0 ? 1 : 0)