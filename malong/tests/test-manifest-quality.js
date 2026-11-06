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
assert(tools.length === 56, `56 个工具 manifest 齐全（44 常驻 + 4 graph 只读 + 8 graph stateful（含 ADR-018 invoke_capability），实际 ${tools.length}）`)

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
// dogfood-050 P3：create 文档误导——必须写明 locator.file_path（旧只写 content）
const cbDesc = JSON.parse(readFileSync(join(TOOLS_DIR, 'tool-code-batch', 'manifest.json'), 'utf-8')).description || ''
const cpDesc = JSON.parse(readFileSync(join(TOOLS_DIR, 'tool-code-patch', 'manifest.json'), 'utf-8')).description || ''
assert(cbDesc.includes('locator.file_path'), 'code_batch 描述含 locator.file_path（create 文档修正）')
assert(cpDesc.includes('locator.file_path'), 'code_patch 描述含 locator.file_path（嵌套说明修正）')
assert(noOutputSignal.length === 0, `低分四工具描述均含输出信号（缺: ${noOutputSignal.join(', ') || '无'}）`)

// 4) R14（2026-10-30 自用试用教训）：npm test 是【硬编码清单】——新写的 tests/test-*.js
//    忘了登记的话，它就算红了全链也照样绿（本轮 test-route-source.js 就真漏了一整轮）。
//    守卫一：tests/ 下每个 test-*.js 必须属于【至少一个 npm 套件】（test / test:perf / …）。
//    守卫二：性能基线（时间阈值类）不进日常链——按需 `npm run test:perf` 拉起。
//    依据：日常链被机器负载抖动挡住正确性回归（2026-10-30 实测：write P95 5190ms 超阈，
//    同一台机 HEAD 基线 1031~1447ms、当前树 422~466ms，纯环境噪声）。
{
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'))
  const scripts = pkg.scripts || {}
  const refs = (v) => [...String(v || '').matchAll(/tests\/([\w.-]+\.js)/g)].map((m) => m[1])
  const daily = new Set(refs(scripts['test:all'] || scripts.test))
  const perf = new Set(refs(scripts['test:perf']))
  const everySuite = new Set(Object.values(scripts).flatMap((v) => refs(v)))
  const testFiles = readdirSync(__dirname).filter((f) => /^test-.*\.js$/.test(f)).sort()

  const unregistered = testFiles.filter((f) => !everySuite.has(f))
  assert(testFiles.length > 150, `test-*.js 数量合理（${testFiles.length}）`)
  assert(unregistered.length === 0, `tests/test-*.js 均归属某个 npm 套件（无归属: ${unregistered.join(', ') || '无'}）`)

  // 性能基线：日常链里不许有（否则一条环境抖动能挡住后面全部正确性测试）
  const PERF_BASELINES = ['test-mvp-latency.js']
  const perfInDaily = PERF_BASELINES.filter((f) => daily.has(f))
  const perfMissing = PERF_BASELINES.filter((f) => !perf.has(f))
  assert(perfInDaily.length === 0, `性能基线不进日常链（应在 test:perf，实际混入: ${perfInDaily.join(', ') || '无'}）`)
  assert(perfMissing.length === 0, `性能基线必须能由 test:perf 拉起（缺: ${perfMissing.join(', ') || '无'}）`)

  const phantom = [...everySuite].filter((f) => !existsSync(join(__dirname, f)))
  assert(phantom.length === 0, `npm 套件不得指向不存在的文件（幽灵: ${phantom.join(', ') || '无'}）`)
}

console.log(`\n=== test-manifest-quality: ${pass} passed, ${fail} failed ===`)
process.exit(fail > 0 ? 1 : 0)