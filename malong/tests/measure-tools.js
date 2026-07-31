// measure-tools.js — 各工具资源占用测量（内存增量 + 耗时）
// 用途：决定 HEAVY_TOOLS 权重是否需要放宽（Rust parse-server 后内存已下降）
import { join, dirname } from 'node:path'
import { mkdirSync, rmSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MALONG_DIR = join(__dirname, '..')
const TOOLS = join(MALONG_DIR, 'tools')

const WS = '/home/chen/1q/0bore/docs/六合工具集'
const DATA = '/tmp/opencode/measure-data'
rmSync(DATA, { recursive: true, force: true })
mkdirSync(DATA, { recursive: true })
mkdirSync(join(DATA, 'meta'), { recursive: true })
mkdirSync(join(DATA, 'workspaces'), { recursive: true })

const { default: codeIndex } = await import(join(MALONG_DIR, 'code-index.js'))
const langParserMod = await import(join(MALONG_DIR, 'lang-parser.js'))
const repoMapMod = await import(join(MALONG_DIR, 'repo-map.js'))

let langParser
if (langParserMod.init && langParserMod.default?.init) {
  langParser = { extractAllAsync: () => null }
} else {
  const pc = await import(join(MALONG_DIR, 'parse-client.js'))
  await pc.init({ log: () => {} })
  await pc.connect()
  langParser = {
    extractAllAsync: (source, ext, filePath) => pc.extractAll(source, ext, filePath),
    hasErrorsAsync: (source, ext, filePath) => pc.hasErrors(source, ext, filePath),
    batchExtractAsync: (files) => pc.batchExtract(files),
  }
}

const services = { langParser }
const core = {
  services,
  getService: (n) => services[n],
  registerService: (n, svc) => { services[n] = svc },
  getWorkspaceDir: () => join(DATA, 'workspaces', 'ws'),
  log: () => {},
  emit: () => {},
  get: (key, def) => def,
}
await codeIndex.init(core)
const svc = services.codeIndex
await repoMapMod.init(core)
const repoMap = services.repoMap
mkdirSync(join(DATA, 'workspaces', 'ws'), { recursive: true })
await svc.initWorkspace(WS)

const ctx = {
  codeIndexService: svc,
  repoMapService: repoMap,
  getWorkspaceDir: () => join(DATA, 'workspaces', 'ws'),
  log: () => {},
}
mkdirSync(join(DATA, 'workspaces', 'ws'), { recursive: true })

const mem = () => {
  const u = process.memoryUsage()
  return { rss: u.rss, heap: u.heapUsed, external: u.external }
}

async function measure(name, fn) {
  if (global.gc) global.gc()
  const before = mem()
  const t0 = Date.now()
  let ok = true
  try {
    await fn()
  } catch (e) {
    ok = false
    console.log(`  ✗ ${name}: ${e.message}`)
  }
  const dt = Date.now() - t0
  const after = mem()
  const rssDelta = (after.rss - before.rss) / 1024 / 1024
  const heapDelta = (after.heap - before.heap) / 1024 / 1024
  console.log(`  ${ok ? '✓' : '✗'} ${name.padEnd(24)} ${dt.toString().padStart(6)}ms  RSS +${rssDelta.toFixed(1)}MB  heap +${heapDelta.toFixed(1)}MB`)
  return { name, dt, rssDelta, heapDelta, ok }
}

console.log('workspace:', WS)

// 预索引（reindex 单独测，不并入 baseline）
console.log('\n── 索引阶段（一次性成本） ──')
const tIdx0 = Date.now()
await svc.indexBatch([], WS) // noop, ensure dir
await svc.resolveCrossFileRefs()

// 先做全量 reindex 用真实数据
const files = await collectAll(WS)
console.log(`  文件数: ${files.length}`)

async function collectAll(dir) {
  const { collectFilesWithDirStats } = await import(join(MALONG_DIR, 'file-collector.js'))
  return collectFilesWithDirStats(dir, { maxFiles: 2000 })
}

const results = []
console.log('\n── 各工具测量 ──')

results.push(await measure('reindex (blocking)', async () => {
  const h = await import(join(TOOLS, 'tool-reindex', 'handler.js'))
  await h.handle({ workspace_dir: WS, blocking: true }, ctx)
}))

results.push(await measure('repo_map', async () => {
  const h = await import(join(TOOLS, 'tool-repo-map', 'handler.js'))
  await h.handle({ workspace_dir: WS, focused: true }, ctx)
}))

results.push(await measure('read_symbol (core)', async () => {
  const h = await import(join(TOOLS, 'tool-read-symbol', 'handler.js'))
  await h.handle({ workspace_dir: WS, locator: { file_path: 'malong/code-index.js', name: 'indexFile' } }, ctx)
}))

results.push(await measure('write_symbols (dry_run)', async () => {
  const h = await import(join(TOOLS, 'tool-write-symbols', 'handler.js'))
  await h.handle({ workspace_dir: WS, writes: [{ file_path: 'malong/code-index.js', locator: { name: 'indexFile' }, content: 'x', base_version: { file: { hash: 'nope' }, symbol: null } }], policy: { dry_run: true, all_or_nothing: true }, allow_unsafe_no_base: true }, ctx)
}))

results.push(await measure('impact_analysis', async () => {
  const h = await import(join(TOOLS, 'tool-impact-analysis', 'handler.js'))
  await h.handle({ workspace_dir: WS, file: 'malong/code-index.js', symbol: 'indexFile', change_type: 'modify' }, ctx)
}))

results.push(await measure('dep_graph (depth 3)', async () => {
  const h = await import(join(TOOLS, 'tool-dep-graph', 'handler.js'))
  await h.handle({ workspace_dir: WS, file: 'malong/code-index.js', depth: 3 }, ctx)
}))

results.push(await measure('fix_imports', async () => {
  const h = await import(join(TOOLS, 'tool-fix-imports', 'handler.js'))
  await h.handle({ workspace_dir: WS, file: 'malong/mcp-server.js' }, ctx)
}))

results.push(await measure('sweep_dead_code', async () => {
  const h = await import(join(TOOLS, 'tool-dead-code-sweeper', 'handler.js'))
  await h.handle({ workspace_dir: WS, scope: 'malong' }, ctx)
}))

results.push(await measure('guard_patterns', async () => {
  const h = await import(join(TOOLS, 'tool-guard-patterns', 'handler.js'))
  await h.handle({ workspace_dir: WS, file: 'malong/mcp-server.js' }, ctx)
}))

results.push(await measure('exception_guard', async () => {
  const h = await import(join(TOOLS, 'tool-exception-guard', 'handler.js'))
  await h.handle({ workspace_dir: WS, file: 'malong/code-index.js' }, ctx)
}))

results.push(await measure('config_drift', async () => {
  const h = await import(join(TOOLS, 'tool-config-drift', 'handler.js'))
  await h.handle({ workspace_dir: WS, scope: 'malong' }, ctx)
}))

results.push(await measure('active_todos', async () => {
  const h = await import(join(TOOLS, 'tool-active-todos', 'handler.js'))
  await h.handle({ workspace_dir: WS, scope: 'malong' }, ctx)
}))

results.push(await measure('naming_consistency', async () => {
  const h = await import(join(TOOLS, 'tool-naming-consistency', 'handler.js'))
  await h.handle({ workspace_dir: WS, file: 'malong/code-index.js' }, ctx)
}))

console.log('\n── 汇总 ──')
const heavy = results.filter(r => r.ok && r.rssDelta > 20)
const total = results.filter(r => r.ok).reduce((a, r) => ({ dt: a.dt + r.dt, rss: a.rss + r.rssDelta }), { dt: 0, rss: 0 })
console.log(`总耗时 ${total.dt}ms，RSS 增量总和 ${total.rss.toFixed(1)}MB`)
console.log(`>20MB RSS 的工具: ${heavy.map(r => `${r.name}(${r.rssDelta.toFixed(0)}MB)`).join(', ') || '无'}`)
process.exit(0)
