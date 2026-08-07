// test-dep-graph-project.js — B13 缺口四：dep_graph 全项目环检测 + 死链修复
// 覆盖：buildModuleGraph/findModuleCycles（真实索引 A→B→A 环）/
//       scope=project 输出 nodes/edges/cycles / 单文件模式 in_cycle 修复 /
//       manifest 契约（file 可选）
import { join, dirname } from 'node:path'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}

const WS = join(os.tmpdir(), 'opencode', 'b13-dg-ws')
const SOCK = join(os.tmpdir(), 'opencode', 'b13-dg.sock')
rmSync(WS, { recursive: true, force: true })
mkdirSync(join(WS, 'src'), { recursive: true })

// A → B → A 环：a.js imports b.js, b.js imports a.js；c.js 独立
writeFileSync(join(WS, 'src/a.js'), "import { b } from './b.js'\nexport function a() { return b() }\n")
writeFileSync(join(WS, 'src/b.js'), "import { a } from './a.js'\nexport function b() { return a() }\n")
writeFileSync(join(WS, 'src/c.js'), 'export function c() { return 1 }\n')

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
  get: (k, def) => k === 'codeIndex.udsPath' ? SOCK : def,
}
await codeIndex.init(core)
const svc = services.codeIndex
await svc.initWorkspace(WS)
await svc.indexBatch([join(WS, 'src/a.js'), join(WS, 'src/b.js'), join(WS, 'src/c.js')], WS)

const { handle } = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-dep-graph', 'handler.js')).href)
const ctx = { codeIndexService: svc, getWorkspaceDir: () => WS }

// ① buildModuleGraph：3 节点 + A↔B 边
{
  const g = svc.buildModuleGraph()
  assert(g.nodes.length === 3, `① 3 节点（得 ${g.nodes.length}）`)
  assert(g.edges.length >= 2, `① ≥2 边（A→B, B→A，得 ${g.edges.length}）`)
  const ab = g.edges.find(e => e.from.includes('a.js') && e.to.includes('b.js'))
  const ba = g.edges.find(e => e.from.includes('b.js') && e.to.includes('a.js'))
  assert(!!ab && !!ba, `① A→B 与 B→A 边都在（ab=${!!ab} ba=${!!ba}）`)
}
// ② findModuleCycles：检出 A↔B 环
{
  const g = svc.buildModuleGraph()
  const cycles = svc.findModuleCycles(g.nodes, g.edges)
  assert(cycles.length === 1, `② 恰 1 环（得 ${cycles.length}）`)
  assert(cycles[0].cycle.some(p => p.includes('a.js')) && cycles[0].cycle.some(p => p.includes('b.js')), `② 环含 a/b（得 ${JSON.stringify(cycles[0].cycle)}）`)
}
// ③ scope=project 输出
{
  const r = await handle({ workspace_dir: WS, scope: 'project' }, ctx)
  assert(r.scope === 'project', `③ scope=project`)
  assert(r.nodes === 3, `③ nodes=3（得 ${r.nodes}）`)
  assert(r.cycle_count === 1, `③ cycle_count=1（得 ${r.cycle_count}）`)
  assert(r.cycles[0].cycle.includes('src/a.js') || r.cycles[0].cycle.some(p => p.includes('a.js')), `③ cycle 含 a.js`)
  assert(r.next_step.includes('fix_imports'), `③ next_step 指向 fix_imports`)
}
// ④ 省略 file 也走 project 模式（契约：file 可选）
{
  const r = await handle({ workspace_dir: WS }, ctx)
  assert(r.scope === 'project' && r.nodes === 3, `④ 省略 file → project（得 scope=${r.scope} nodes=${r.nodes}）`)
}
// ⑤ 单文件模式：in_cycle=true（死链修复——旧 handler 期待不存在的 circular_dependencies）
{
  const r = await handle({ workspace_dir: WS, file: 'src/a.js' }, ctx)
  assert(r.in_cycle === true, `⑤ a.js in_cycle=true（得 ${r.in_cycle}）——死链修复实证`)
  assert(r.next_step.includes('fix_imports'), `⑤ next_step 环提示（得 ${r.next_step}）`)
  const c = await handle({ workspace_dir: WS, file: 'src/c.js' }, ctx)
  assert(c.in_cycle === false, `⑤ c.js in_cycle=false（得 ${c.in_cycle}）`)
}
// ⑥ 未索引工作区 → workspace_not_indexed
{
  const empty = join(WS, 'empty')
  mkdirSync(empty, { recursive: true })
  const r = await handle({ workspace_dir: empty }, { codeIndexService: svc, getWorkspaceDir: () => empty })
  assert(r.error === 'workspace_not_indexed', `⑥ workspace_not_indexed（得 ${r.error}）`)
}
// ⑨ R22-⑱：同名跨目录不误判环（same-name/src/a.js → src/b.js → lib/a.js：basename 同为 a 但无环）
{
  const WS2 = join(WS, 'same-name')
  mkdirSync(join(WS2, 'src'), { recursive: true })
  mkdirSync(join(WS2, 'lib'), { recursive: true })
  writeFileSync(join(WS2, 'src/a.js'), "import { b } from './b.js'\nexport function a() { return b() }\n")
  writeFileSync(join(WS2, 'src/b.js'), "import { libA } from '../lib/a.js'\nexport function b() { return libA() }\n")
  writeFileSync(join(WS2, 'lib/a.js'), 'export function libA() { return 1 }\n')
  await svc.initWorkspace(WS)
  await svc.indexBatch([join(WS2, 'src/a.js'), join(WS2, 'src/b.js'), join(WS2, 'lib/a.js')], WS)
  const rA = await handle({ workspace_dir: WS, file: 'same-name/src/a.js' }, { codeIndexService: svc, getWorkspaceDir: () => WS })
  const rLib = await handle({ workspace_dir: WS, file: 'same-name/lib/a.js' }, { codeIndexService: svc, getWorkspaceDir: () => WS })
  assert(rA.in_cycle === false, `⑨ 同名跨目录不误判环 src/a.js（得 ${rA.in_cycle}）`)
  assert(rLib.in_cycle === false, `⑨ 同名跨目录不误判环 lib/a.js（得 ${rLib.in_cycle}）`)
}
// ⑦ manifest：file 不再必填（仅 workspace_dir）
{
  const m = JSON.parse(await (await import('node:fs/promises')).readFile(join(__dirname, '..', 'tools', 'tool-dep-graph', 'manifest.json'), 'utf-8'))
  assert(JSON.stringify(m.inputSchema.required) === JSON.stringify(['workspace_dir']), `⑦ required 仅 workspace_dir（得 ${JSON.stringify(m.inputSchema.required)}）`)
  assert(m.version === '1.1.0', `⑦ version 1.1.0`)
}
// ⑧ r12.5：注释行 import ref 防御——模拟陈旧索引（解析器残留把注释当 import）
// 直接往 refs 表插入指向注释行的假 import 行，验证 getModuleDependencies/buildModuleGraph 过滤
{
  writeFileSync(join(WS, 'src/d.js'), "// import('./ghost.js') 注释里的假依赖\nimport { c } from './c.js'\nexport function d() { return c() }\n")
  await svc.indexBatch([join(WS, 'src/a.js'), join(WS, 'src/b.js'), join(WS, 'src/c.js'), join(WS, 'src/d.js')], WS)
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(join(WS, 'code-index.db'))
  const fid = db.prepare("SELECT id FROM files WHERE path = 'src/d.js'").get().id
  db.prepare("INSERT INTO refs (source_file_id, source_symbol_id, target_name, kind, line, call_expr) VALUES (?, NULL, ?, 'import', ?, '')").run(fid, './ghost.js', 1)

  const deps = await svc.getModuleDependencies('src/d.js', { depth: 1 })
  assert(deps.directImports.every(i => i.module !== './ghost.js'), `⑧ 单文件模式过滤注释行假 import（得 ${JSON.stringify(deps.directImports.map(i => i.module))}）`)
  assert(deps.directImports.some(i => i.module === './c.js'), `⑧ 真实 import 保留（得 ${JSON.stringify(deps.directImports.map(i => i.module))}）`)

  const g = svc.buildModuleGraph()
  assert(!g.edges.some(e => e.to.includes('ghost')), `⑧ 全项目图不含 ghost 边（得 ${JSON.stringify(g.edges.filter(e => e.to.includes('ghost')))}）`)

  // 非注释行（代码行）的 import 不被误过滤
  const fid2 = db.prepare("SELECT id FROM files WHERE path = 'src/c.js'").get().id
  db.prepare("INSERT INTO refs (source_file_id, source_symbol_id, target_name, kind, line, call_expr) VALUES (?, NULL, 'realish.js', 'import', 1, '')").run(fid2)
  const deps2 = await svc.getModuleDependencies('src/c.js', { depth: 1 })
  assert(deps2.directImports.some(i => i.module === 'realish.js'), `⑧ 非注释行的 import 保留（c.js 第 1 行是 export 非注释）`)
}

rmSync(WS, { recursive: true, force: true })
console.log(`== test-dep-graph-project: ${pass} passed, ${fail} failed ==`)
process.exit(fail > 0 ? 1 : 0)
