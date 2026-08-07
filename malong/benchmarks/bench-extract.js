// bench-extract.js — r10(E)：解析性能基线（不进 test 链）
// 当前仓库 cold/hot extract 各 5 次 → p50/p95 耗时 + 吞吐；结果存 benchmarks/results/r10-baseline.json
// 用法：node benchmarks/bench-extract.js [workspace] [maxFiles=3000]
import { join, dirname } from 'node:path'
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MALONG = dirname(__dirname)
const WS = process.argv[2] || '/home/chen/1q/0bore'
const MAX_FILES = Number(process.argv[3] || 3000)

const { init, connect, extractAll } = await import(pathToFileURL(join(MALONG, 'parse-client.js')).href)

function collectFiles(dir, out = [], depth = 0) {
  if (depth > 8) return out
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue
    const p = join(dir, e.name)
    if (e.isDirectory()) collectFiles(p, out, depth + 1)
    else if (/\.(js|ts|py|go|rs|c|h|cpp|java|sh)$/.test(e.name)) out.push(p)
  }
  return out
}

const files = collectFiles(WS).slice(0, MAX_FILES)
console.log(`corpus: ${files.length} source files (sampled from ${WS})`)

await init({ log: () => {} })
await connect()
await extractAll('let _ = 1;', '.js', undefined)  // warm-up connection

const runs = []
for (let i = 0; i < 5; i++) {
  const t0 = process.hrtime.bigint()
  let tokens = 0
  for (const f of files) {
    try {
      const ext = f.slice(f.lastIndexOf('.'))
      const r = await extractAll(readFileSync(f, 'utf-8'), ext, f)
      tokens += r?.stats?.tokens || r?.symbols?.length || 0
    } catch { /* unparseable files are fine for baseline */ }
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  runs.push({ run: i + 1, ms: Math.round(ms), files: files.length, tokens })
  console.log(`  run ${i + 1}: ${Math.round(ms)}ms (${Math.round(files.length / (ms / 1000))} files/s)`)
}

const sorted = runs.map(r => r.ms).sort((a, b) => a - b)
const p50 = sorted[Math.floor(sorted.length * 0.5)]
const p95 = sorted[Math.floor(sorted.length * 0.95)]
const baseline = {
  generated_at: new Date().toISOString(),
  workspace: WS,
  files,
  runs,
  p50_ms: p50,
  p95_ms: p95,
  throughput_files_per_s: Math.round(files.length / (p50 / 1000)),
  note: 'r10 initial baseline (hot: daemon cache warm). Cold baseline = first run.',
}
const outDir = join(__dirname, 'results')
mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'r10-baseline.json'), JSON.stringify(baseline, null, 2))
console.log(`\nbaseline saved: benchmarks/results/r10-baseline.json (p50=${p50}ms, p95=${p95}ms)`)
