// test-mock-syncer-truncation.js — r44 mock_syncer 测试文件扫描截断判定
// 哨兵法：收集到 maxFiles+1 才算截断。固化「恰好 100 不误报 / 超 100 必报」，
// 尤其覆盖旧逻辑误报的边角——恰好 100 个测试文件、其后还跟着非测试目录。
import { join, dirname } from 'node:path'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MALONG = dirname(__dirname)
const { handle } = await import(pathToFileURL(join(MALONG, 'tools/tool-mock-syncer/handler.js')).href)

let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}

// 构造 n 个测试文件；trailDir=true 时追加一个字母序靠后、不含测试文件的目录
function buildWs(n, trailDir) {
  const ws = join(os.tmpdir(), 'opencode', `ms-trunc-${n}-${trailDir ? 'trail' : 'clean'}-${process.pid}`)
  rmSync(ws, { recursive: true, force: true })
  mkdirSync(join(ws, 'tests'), { recursive: true })
  writeFileSync(join(ws, 'src.js'), 'function target(a, b) { return a + b }\nmodule.exports = { target }\n')
  for (let i = 0; i < n; i++) writeFileSync(join(ws, 'tests', `t${String(i).padStart(3, '0')}.test.js`), `const target = () => ${i}\n`)
  if (trailDir) {
    mkdirSync(join(ws, 'zzz_docs'), { recursive: true })
    for (let k = 0; k < 3; k++) writeFileSync(join(ws, 'zzz_docs', `note${k}.md`), 'doc\n')
  }
  return ws
}

async function run(n, trailDir) {
  const ws = buildWs(n, trailDir)
  try {
    return await handle({ workspace_dir: ws, file: 'src.js', function: 'target' }, {})
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
}

// 恰好 100 + 尾部非测试目录 → 不得误报截断（旧 files.length>=100 / walkState 逻辑此处会假 truncated）
let r = await run(100, true)
assert((r.truncated || false) === false, `恰好100+尾部非测试目录 应 truncated=false（得 ${r.truncated}）`)

// 101 个测试文件 → 必须报截断
r = await run(101, false)
assert(r.truncated === true, `101 个测试文件 应 truncated=true（得 ${r.truncated}）`)
assert(Array.isArray(r.warnings) && r.warnings.length > 0, `截断时应带 warnings`)

// 恰好 100 干净目录 → 不截断
r = await run(100, false)
assert((r.truncated || false) === false, `恰好100干净 应 truncated=false（得 ${r.truncated}）`)

// 50 个 → 不截断
r = await run(50, false)
assert((r.truncated || false) === false, `50 个 应 truncated=false（得 ${r.truncated}）`)

console.log(`== test-mock-syncer-truncation: ${pass} passed, ${fail} failed ==`)
process.exit(fail > 0 ? 1 : 0)
