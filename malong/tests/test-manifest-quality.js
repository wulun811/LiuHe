// test-manifest-quality.js — manifest 描述质量门禁（Glama B→A 防回归）
// 覆盖：1) 全部 tools/*/manifest.json description 非空且 ≤360 字符（防失控超长）
//       2) 低分四工具（code_quality/spec_gen/diff_facts/tsc_check）description ≤120 且含输出格式信号
//       3) 全部 inputSchema.properties[].description 非空（覆盖率 100% 门禁）
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TOOLS_DIR = join(__dirname, '..', 'tools')

let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}

const tools = readdirSync(TOOLS_DIR)
  .filter((t) => existsSync(join(TOOLS_DIR, t, 'manifest.json')))
  .sort()
assert(tools.length === 44, `44 个工具 manifest 齐全（实际 ${tools.length}）`)

// 输出格式信号（低分工具描述必须命中其一，证明写了"输出长什么样"）
const OUTPUT_SIGNALS = ['scores', 'spec', 'JSON', 'json', '{status', 'structured', 'returns', 'output', '->', 'text']

const LOW_SCORE_TOOLS = ['tool-code-quality', 'tool-spec-gen', 'tool-diff-facts', 'tool-tsc-check']
const MAX_DESC = 360        // 全局硬上限（防新工具写 500 字符失控描述）
const MAX_LOW = 120         // 低分四工具 ≤120（本次描述工程目标线）

let missingParamDescs = []
let overlong = []
let lowOver = []
let noOutputSignal = []

for (const t of tools) {
  const mf = join(TOOLS_DIR, t, 'manifest.json')
  const d = JSON.parse(readFileSync(mf, 'utf-8'))

  // 1) description 非空 + ≤360 全局上限
  const desc = (d.description || '').trim()
  assert(desc.length > 0, `${t}: description 非空`)
  assert(desc.length <= MAX_DESC, `${t}: description ≤${MAX_DESC} 字符（实际 ${desc.length}）`)
  if (desc.length > MAX_DESC) overlong.push(`${t}(${desc.length})`)

  // 2) 低分四工具：≤120 + 输出格式信号
  if (LOW_SCORE_TOOLS.includes(t)) {
    assert(desc.length <= MAX_LOW, `${t}: 低分工具描述 ≤${MAX_LOW} 字符（实际 ${desc.length}）`)
    if (desc.length > MAX_LOW) lowOver.push(`${t}(${desc.length})`)
    const hit = OUTPUT_SIGNALS.some((s) => desc.includes(s))
    if (!hit) noOutputSignal.push(t)
    assert(hit, `${t}: description 含输出格式信号`)
  }

  // 3) 参数描述 100% 覆盖
  const props = ((d.inputSchema || {}).properties || {})
  for (const [pname, pv] of Object.entries(props)) {
    if (!(pv.description || '').trim()) missingParamDescs.push(`${t}.${pname}`)
  }
}

assert(missingParamDescs.length === 0, `参数描述覆盖率 100%（缺: ${missingParamDescs.join(', ') || '无'}）`)
assert(overlong.length === 0, `无 description 超 ${MAX_DESC} 字符（超: ${overlong.join(', ') || '无'}）`)
assert(lowOver.length === 0, `低分四工具描述 ≤${MAX_LOW}（超: ${lowOver.join(', ') || '无'}）`)
assert(noOutputSignal.length === 0, `低分四工具描述均含输出信号（缺: ${noOutputSignal.join(', ') || '无'}）`)

console.log(`\n=== test-manifest-quality: ${pass} passed, ${fail} failed ===`)
process.exit(fail > 0 ? 1 : 0)