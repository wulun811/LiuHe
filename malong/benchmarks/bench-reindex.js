// bench-reindex.js — r10(E)：reindex walker 大目录实测（不进 test 链）
// 合成 2 万文件仓库 → collectFilesWithDirStats（真实预算 walker）耗时 + RSS。
// 说明：reindex = collect（本脚本测） + Rust extract（bench-extract.js 测） + DB 写（线性组合可推算）。
// 用法：node benchmarks/bench-reindex.js [nFiles=20000]
import { join, dirname } from 'node:path'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MALONG = dirname(__dirname)
const N = Number(process.argv[2] || 20000)

const { collectFilesWithDirStats } = await import(pathToFileURL(join(MALONG, 'file-collector.js')).href)

const SYNTH = join('/tmp', 'opencode', 'bench-reindex-synth')
rmSync(SYNTH, { recursive: true, force: true })

const SAMPLES = {
  '.js': 'export function alpha(x) { return x + 1 }\nexport const beta = 2\n',
  '.py': 'def alpha(x):\n    return x + 1\nBETA = 2\n',
  '.go': 'package main\nfunc alpha(x int) int { return x + 1 }\nvar Beta = 2\n',
  '.rs': 'pub fn alpha(x: i32) -> i32 { x + 1 }\npub const BETA: i32 = 2;\n',
  '.ts': 'export function alpha(x: number): number { return x + 1 }\nexport const beta = 2\n',
  '.c': 'int alpha(int x) { return x + 1; }\nconst int BETA = 2;\n',
  '.java': 'class Alpha { int alpha(int x) { return x + 1; } static final int BETA = 2; }\n',
  '.sh': 'alpha() { echo $1; }\nBETA=2\n',
}
const EXTS = Object.keys(SAMPLES)

console.log(`generating ${N} files...`)
const tGen = Date.now()
for (let d = 0; d < 5; d++) mkdirSync(join(SYNTH, `mod${d}`), { recursive: true })
let count = 0
for (let d = 0; d < 5 && count < N; d++) {
  const dir = join(SYNTH, `mod${d}`)
  for (let i = 0; i < N / 5 && count < N; i++) {
    const ext = EXTS[count % EXTS.length]
    writeFileSync(join(dir, `f${i}_${count % 97}.${ext}`), SAMPLES[ext] + `// file ${count}\n`)
    count++
  }
}
const genMs = Date.now() - tGen
console.log(`generated ${count} files in ${genMs}ms`)

const tCollect = Date.now()
const { files, truncated } = collectFilesWithDirStats(SYNTH, { maxFiles: 0, hardCap: 0 })
const collectMs = Date.now() - tCollect
console.log(`collect (walker budget): ${files.length} files in ${collectMs}ms (truncated=${truncated})`)

const memMB = Math.round(process.memoryUsage().rss / 1048576)
const result = {
  generated_at: new Date().toISOString(),
  n_files: N,
  gen_ms: genMs,
  collect_ms: collectMs,
  files_found: files.length,
  truncated,
  rss_mb: memMB,
  note: 'reindex = collect (this) + extract (bench-extract.js) + DB writes; walker budget line is the JS-side gate',
}
const { writeFileSync: wfs, mkdirSync: mk } = await import('node:fs')
mk(join(__dirname, 'results'), { recursive: true })
wfs(join(__dirname, 'results', 'r10-reindex-baseline.json'), JSON.stringify(result, null, 2))
console.log(`\nbaseline saved: benchmarks/results/r10-reindex-baseline.json (rss=${memMB}MB)`)
rmSync(SYNTH, { recursive: true, force: true })
console.log('synth workspace cleaned')
