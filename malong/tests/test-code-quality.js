// test-code-quality.js — B13 缺口三：code_quality 5 维探针
// 覆盖：契约（缺 file）/ 文件不存在 / 真实 rust-service compute_metrics 通路
//       （techDebt 用圈复杂度）/ 危险 API blastRadius / 嵌套 overEngineering /
//       paradigmFit 风格 / 复杂度分支文件 vs 简单文件区分度
import { join, dirname } from 'node:path'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}

const WS = join(os.tmpdir(), 'opencode', 'b13-cq-ws')
try { rmSync(WS, { recursive: true, force: true }) } catch {}
mkdirSync(join(WS, 'src'), { recursive: true })
writeFileSync(join(WS, 'src/simple.js'), 'export function add(a, b) { return a + b }\nexport const NAME = "x"\n')
writeFileSync(join(WS, 'src/complex.js'), [
  'export function nasty() {',
  '  let acc = 0',
  '  for (let i = 0; i < 10; i++) {',
  '    if (i % 2 === 0) {',
  '      for (let j = 0; j < 5; j++) {',
  '        if (j > 2) acc += exec("ls")',
  '      }',
  '    }',
  '  }',
  '  return acc',
  '}',
].join('\n') + '\n')

const pc = await import(pathToFileURL(join(__dirname, '..', 'parse-client.js')).href)
await pc.init({ log: () => {} })
try { await pc.connect() } catch {}
const langParserService = {
  computeMetrics: (s, e) => pc.computeMetrics(s, e),
}

const { handle } = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-code-quality', 'handler.js')).href)
const ctx = { langParserService, getWorkspaceDir: () => WS }

// ① 契约：缺 file
{
  const r = await handle({ workspace_dir: WS }, ctx)
  assert(r.error === 'missing_parameter', `① 缺 file → missing_parameter（得 ${r.error}）`)
}
// ② 文件不存在
{
  const r = await handle({ workspace_dir: WS, file: 'nope.js' }, ctx)
  assert(r.error === 'file_not_found', `② file_not_found（得 ${r.error}）`)
}
// ③ 简单文件：5 维 + overall 存在，近似标记 false（rust metrics 通路）
{
  const r = await handle({ workspace_dir: WS, file: 'src/simple.js' }, ctx)
  assert(r.dimensions?.techDebt?.value !== undefined, `③ techDebt 有值`)
  assert(r.dimensions?.archViolation?.value !== undefined, `③ archViolation 有值`)
  assert(r.dimensions?.blastRadius?.value !== undefined, `③ blastRadius 有值`)
  assert(r.dimensions?.overEngineering?.value !== undefined, `③ overEngineering 有值`)
  assert(r.dimensions?.paradigmFit?.value !== undefined, `③ paradigmFit 有值`)
  assert(typeof r.overall === 'number' && r.overall >= 0 && r.overall <= 1, `③ overall 在 [0,1]（得 ${r.overall}）`)
  assert(r.approximation === false, `③ rust compute_metrics 通路 → 非近似（得 ${r.approximation}）`)
}
// ④ 复杂文件：圈复杂度 > 简单文件 → techDebt 更低（值高=风险高？不——value 是"质量分"，低=差）
//    通天公式：value = 1 - risk，所以复杂文件 techDebt.value < 简单文件
{
  const simple = await handle({ workspace_dir: WS, file: 'src/simple.js' }, ctx)
  const complex = await handle({ workspace_dir: WS, file: 'src/complex.js' }, ctx)
  assert(complex.dimensions.techDebt.rawCyclomatic > simple.dimensions.techDebt.rawCyclomatic, `④ 复杂文件圈复杂度更高（${complex.dimensions.techDebt.rawCyclomatic} > ${simple.dimensions.techDebt.rawCyclomatic}）`)
  assert(complex.dimensions.techDebt.value <= simple.dimensions.techDebt.value, `④ 复杂文件 techDebt 质量分更低（${complex.dimensions.techDebt.value} ≤ ${simple.dimensions.techDebt.value}）`)
  assert(complex.dimensions.overEngineering.rawNestingDepth > simple.dimensions.overEngineering.rawNestingDepth, `④ 复杂文件嵌套更深（${complex.dimensions.overEngineering.rawNestingDepth} > ${simple.dimensions.overEngineering.rawNestingDepth}）`)
  assert(complex.dimensions.blastRadius.rawDangerousAPIs > 0, `④ 复杂文件含 exec → blastRadius 危险 API > 0（得 ${complex.dimensions.blastRadius.rawDangerousAPIs}）`)
  assert(complex.overall < simple.overall, `④ 复杂文件 overall 更低（${complex.overall} < ${simple.overall}）`)
}
// ⑤ 纯文本近似：无 langParser → approximation=true 且不崩
{
  const r = await handle({ workspace_dir: WS, file: 'src/simple.js' }, { getWorkspaceDir: () => WS })
  assert(r.approximation === true, `⑤ 无解析服务 → approximation=true（得 ${r.approximation}）`)
  assert(r.dimensions?.techDebt?.value !== undefined, `⑤ 近似模式仍有 5 维`)
}

// ⑥ file 逃逸拦截（r42）
{
  const r = await handle({ workspace_dir: WS, file: '../outside.js' }, ctx)
  assert(r.error === 'path_blocked', `⑥ file 逃逸 → path_blocked（得 ${r.error}）`)
}

try { rmSync(WS, { recursive: true, force: true }) } catch {}
console.log(`== test-code-quality: ${pass} passed, ${fail} failed ==`)
process.exit(fail > 0 ? 1 : 0)
