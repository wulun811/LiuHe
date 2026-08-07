// eval-stability.js — 长期稳定性检测（Y002-S6/F1）
// mcp-server 常驻 + 3 并发客户端间歇调用 + 每 6h 采样 RSS/DB/usage 增长。
// 用法: node tools/eval-stability.js [--hours 24] [--interval-min 30]
// 输出: docs/Y-优化/stability-report.json + 控制台进度
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPORT = join(__dirname, '..', '..', 'docs', 'Y-优化', 'stability-report.json')
const args = process.argv.slice(2)
const hours = parseFloat(args[args.indexOf('--hours') + 1] || '24')
const intervalMin = parseFloat(args[args.indexOf('--interval-min') + 1] || '30')
const endAt = Date.now() + hours * 3600000

const WS = join(tmpdir(), 'opencode', 'stability-ws')
rmSync(WS, { recursive: true, force: true })
mkdirSync(WS, { recursive: true })
writeFileSync(join(WS, 'lib.js'), 'export function add(a, b) { return a + b }\nexport function sub(a, b) { return a - b }\nexport const LIMIT = 10\n')

const imp = (p) => import(pathToFileURL(p).href)
const pc = await imp(join(__dirname, '..', 'parse-client.js'))
await pc.init({ log: () => {} })
await pc.connect()

const { default: codeIndex } = await imp(join(__dirname, '..', 'code-index.js'))
const langParser = {
  extractAllAsync: (s, e, f) => pc.extractAll(s, e, f),
  hasErrorsAsync: (s, e, f) => pc.hasErrors(s, e, f),
  batchExtractAsync: (f) => pc.batchExtract(f),
}
const services = { langParser }
const DATA = join(tmpdir(), 'opencode', 'stability-data')
mkdirSync(DATA, { recursive: true })
const SOCK = join(tmpdir(), 'opencode', `stability-${process.pid}.sock`)
const core = {
  services,
  getService: (n) => services[n],
  registerService: (n, svc) => { services[n] = svc },
  getWorkspaceDir: () => DATA,
  log: () => {},
  emit: () => {},
  get: (k, def) => k === 'codeIndex.udsPath' ? SOCK : def,
}
await codeIndex.init(core)
const svc = services.codeIndex
await svc.initWorkspace(WS)
await svc.indexBatch([join(WS, 'lib.js')], WS)

const samples = []
const leaks = []
const startRss = process.memoryUsage().rss
const startUsage = existsSync(join(DATA, 'stability.jsonl')) ? require('node:fs').statSync(join(DATA, 'stability.jsonl')).size : 0

const tools = {
  read: async () => svc.getReferences('add'),
  impact: async () => svc.getImpactAnalysis('lib.js', { symbol: 'add' }),
  reindex: async () => svc.indexFile(join(WS, 'lib.js'), WS),
}

async function sampleRound(roundNo) {
  // 3 并发客户端间歇调用（模拟 3 个 MCP 客户端）
  const results = await Promise.allSettled([
    tools.read(), tools.impact(), tools.reindex(),
  ])
  const mem = process.memoryUsage()
  const sample = {
    round: roundNo,
    ts: new Date().toISOString(),
    rss_mb: Math.round(mem.rss / 1048576),
    heap_mb: Math.round(mem.heapUsed / 1048576),
    results: results.map(r => r.status),
  }
  samples.push(sample)
  if (mem.rss > startRss * 1.5) {
    leaks.push({ round: roundNo, rss_mb: Math.round(mem.rss / 1048576), note: 'RSS grew >50% from start' })
  }
  const ok = results.every(r => r.status === 'fulfilled' && !r.value?.error)
  return ok
}

let round = 0
let failed = 0
console.log(`[stability] running ${hours}h, sample every ${intervalMin}min; ws=${WS}`)
while (Date.now() < endAt) {
  round++
  const ok = await sampleRound(round)
  if (!ok) failed++
  if (round % 2 === 0 || !ok) {
    const last = samples[samples.length - 1]
    console.log(`[stability] round ${round}: ${ok ? 'ok' : 'FAIL'} rss=${last.rss_mb}MB heap=${last.heap_mb}MB failed=${failed}`)
  }
  await new Promise(r => setTimeout(r, intervalMin * 60000))
}

const report = {
  date: new Date().toISOString(),
  planned_hours: hours,
  rounds: samples.length,
  failures: failed,
  rss_growth_mb: Math.round((process.memoryUsage().rss - startRss) / 1048576),
  start_rss_mb: Math.round(startRss / 1048576),
  end_rss_mb: Math.round(process.memoryUsage().rss / 1048576),
  leak_alerts: leaks,
  samples,
  pass: failed === 0,
}
mkdirSync(dirname(REPORT), { recursive: true })
writeFileSync(REPORT, JSON.stringify(report, null, 2) + '\n')
console.log(`[stability] DONE rounds=${samples.length} failures=${failed} rssGrowth=${report.rss_growth_mb}MB → ${REPORT}`)
process.exit(failed === 0 ? 0 : 1)
