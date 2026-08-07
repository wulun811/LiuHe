// bench-reindex-full.js — r10e(F1)：reindex 全流程实测（collect + parse + DB 写）
// 真实 CodeIndex.indexBatch × 3 次全量（临时 stateDir，不碰正式库），捕获 code-index 内部阶段日志。
// 结果补进 benchmarks/results/r10-reindex-baseline.json（extract_ms/db_ms 实测字段）。
// 用法：node benchmarks/bench-reindex-full.js [workspace] [runs=3]
import { join, dirname } from 'node:path'
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MALONG = dirname(__dirname)
const WS = process.argv[2] || '/home/chen/1q/1FTY-llm/0FTYcloud'
const RUNS = Number(process.argv[3] || 3)
const TMP = join('/tmp', 'opencode', 'bench-reindex-full')
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })

const { collectFilesWithDirStats } = await import(pathToFileURL(join(MALONG, 'file-collector.js')).href)
const pc = await import(pathToFileURL(join(MALONG, 'parse-client.js')).href)
await pc.init({ log: () => {} })
await pc.connect()

const langParser = { extractAllAsync: (s, e, f) => pc.extractAll(s, e, f), batchExtractAsync: (f) => pc.batchExtract(f) }
const services = { langParser }
const core = {
  log: (lvl, msg) => console.error(`[${lvl}] ${msg}`),
  emit: () => {},
  getService: (n) => services[n],
  registerService: (n, svc) => { services[n] = svc },
  getWorkspaceDir: (ws) => join(TMP, createHash('sha1').update(ws).digest('hex').slice(0, 12)),
  get: (_k, d) => d,
}

const { default: idx } = await import(pathToFileURL(join(MALONG, 'code-index.js')).href)
await idx.init(core)
mkdirSync(core.getWorkspaceDir(WS), { recursive: true })
const svc = services.codeIndex
await svc.initWorkspace(WS)

const tCollect0 = Date.now()
const { files } = collectFilesWithDirStats(WS, { maxFiles: 0, hardCap: 0 })
const collectMs = Date.now() - tCollect0
const filePaths = files.map(f => f.path)
console.error(`collect: ${filePaths.length} files in ${collectMs}ms`)

const runs = []
const parseMs = []
const dbMs = []
const origErr = console.error
console.error = (...a) => {
  const line = a.join(' ')
  const pm = line.match(/parse: (\d+)\/(\d+) files in ([\d.]+)s/)
  const im = line.match(/insert: (\d+) files in ([\d.]+)s/)
  if (pm) parseMs.push(Math.round(parseFloat(pm[3]) * 1000))
  if (im) dbMs.push(Math.round(parseFloat(im[2]) * 1000))
  origErr(...a)
}
for (let i = 0; i < RUNS; i++) {
  await svc.markAllDirty()
  const t0 = Date.now()
  await svc.indexBatch(filePaths, WS)
  runs.push({ run: i + 1, total_ms: Date.now() - t0 })
}
console.error = origErr

const p50 = (arr) => arr.sort((a, b) => a - b)[Math.floor(arr.length * 0.5)]
const totalMsSorted = runs.map(r => r.total_ms).sort((a, b) => a - b)
const p50Total = totalMsSorted[Math.floor(totalMsSorted.length * 0.5)]
const fullIndex = {
  generated_at: new Date().toISOString(),
  workspace: WS,
  files: filePaths.length,
  collect_ms: collectMs,
  parse_ms_runs: parseMs,
  parse_p50_ms: p50(parseMs.slice()),
  db_write_ms_runs: dbMs,
  db_write_p50_ms: p50(dbMs.slice()),
  full_run_ms: runs,
  full_p50_ms: p50Total,
  throughput_files_per_s: Math.round(filePaths.length / (p50Total / 1000)),
  note: 'r10e(F1) 全流程实测：collect + parse(daemon) + DB 写(indexBatch 真实路径, 临时库)。DB 写占 ~95%，旧基准未测该段导致高估 4.5x。',
}
const baselinePath = join(__dirname, 'results', 'r10-reindex-baseline.json')
const existing = JSON.parse(readFileSync(baselinePath, 'utf-8'))
writeFileSync(baselinePath, JSON.stringify({ ...existing, full_index: fullIndex }, null, 2))
console.error(`baseline updated: ${baselinePath} (full_p50=${p50Total}ms, ${fullIndex.throughput_files_per_s} files/s)`)

process.exit(0)
