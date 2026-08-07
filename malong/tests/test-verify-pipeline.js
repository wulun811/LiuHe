// test-verify-pipeline.js — B13 verify_pipeline 工具测试
// 覆盖：契约（missing workspace_dir / 目录不存在）/ detectScripts 探测 /
//       lint 阶段真实执行（fixture 项目）/ test 阶段真实执行 / stages 过滤 /
//       workdir 子目录 / 错误路径不 throw
import { join, dirname } from 'node:path'
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}

const WS = join(os.tmpdir(), 'opencode', 'b13-vp-ws')
rmSync(WS, { recursive: true, force: true })
mkdirSync(join(WS, 'sub'), { recursive: true })
writeFileSync(join(WS, 'package.json'), JSON.stringify({
  name: 'b13-vp-fixture',
  scripts: {
    lint: 'node -e "console.log(42)"',
    test: 'node -e "console.log(1 + 1 === 2 ? \'1 passing\' : \'0 passing\')"',
  },
}))
writeFileSync(join(WS, 'sub', 'package.json'), JSON.stringify({
  name: 'b13-vp-sub',
  scripts: { lint: 'node -e "process.exit(1)"' },
}))

const { handle } = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-verify-pipeline', 'handler.js')).href)
const ctx = { getWorkspaceDir: (d) => d }

// ① 契约：缺 workspace_dir
{
  const r = await handle({}, ctx)
  assert(r.error === 'missing_parameter', `① 缺 workspace_dir → missing_parameter（得 ${r.error}）`)
  assert(!r.workspace_dir, `① 无异常字段`)
}
// ② 目录不存在
{
  const r = await handle({ workspace_dir: join(WS, 'nope') }, ctx)
  assert(r.error === 'workspace_not_found', `② 目录不存在 → workspace_not_found（得 ${r.error}）`)
}
// ③ workdir 不存在
{
  const r = await handle({ workspace_dir: WS, workdir: 'nope' }, ctx)
  assert(r.error === 'workdir_not_found', `③ workdir 不存在 → workdir_not_found（得 ${r.error}）`)
}
// ④ 自动探测 + lint/test 全跑（lint pass, test pass）
{
  const r = await handle({ workspace_dir: WS }, ctx)
  assert(r.status === 'pass', `④ 全绿 pass（得 ${r.status}）`)
  assert(r.results?.lint?.passed === true && r.results?.lint?.ran === true, `④ lint 跑通并 pass`)
  assert(r.results?.test?.passed === true, `④ test 跑通并 pass`)
  assert(r.results?.test?.passedCount === 1, `④ test passedCount=1（得 ${r.results?.test?.passedCount}）`)
  assert(r.results?.test?.failedCount === 0, `④ test failedCount=0（得 ${r.results?.test?.failedCount}）`)
  assert(r.scripts?.lint === true && r.scripts?.test === true, `④ 探测到 lint+test（得 ${JSON.stringify(r.scripts)}）`)
  assert(!r.results?.typecheck, `④ 无 typecheck 脚本 → 不跑（得 ${JSON.stringify(Object.keys(r.results))}）`)
}
// ⑤ stages 显式过滤：只跑 lint
{
  const r = await handle({ workspace_dir: WS, stages: 'lint' }, ctx)
  assert(Object.keys(r.results).length === 1 && r.results.lint, `⑤ stages=lint 只跑 lint（得 ${Object.keys(r.results)}）`)
}
// ⑥ workdir 子目录：sub 的 lint 失败（exit 1）→ fail + 输出截断
{
  const r = await handle({ workspace_dir: WS, workdir: 'sub', stages: 'lint' }, ctx)
  assert(r.status === 'fail', `⑥ sub lint 失败 → fail（得 ${r.status}）`)
  assert(r.results.lint.passed === false, `⑥ lint passed=false`)
  assert(r.results.lint.exitCode === 1, `⑥ exitCode=1（得 ${r.results.lint.exitCode}）`)
}
// ⑦ 无脚本项目 → syntax fallback（node --check 兜底）
{
  const bare = join(WS, 'bare')
  mkdirSync(bare, { recursive: true })
  writeFileSync(join(bare, 'package.json'), JSON.stringify({ name: 'bare' }))
  const r = await handle({ workspace_dir: bare }, ctx)
  assert(r.results?.syntax, `⑦ syntax fallback 存在（得 ${Object.keys(r.results)}）`)
  assert(typeof r.results?.syntax?.passed === 'boolean', `⑦ syntax 有 passed 布尔`)
}
// ⑧ timeout 参数钳制
{
  const r = await handle({ workspace_dir: WS, stages: 'lint', timeout: 0 }, ctx)
  assert(r.results?.lint?.ran === true, `⑧ timeout=0 → 默认超时不崩（lint ran=${r.results?.lint?.ran}）`)
}
// ⑨ 只有 lint:fix 的项目：detectScripts 认 lint:fix 且 runStage 跑的是真实脚本名（回归：硬编码 run lint → Missing script 假失败）
// ⑨b r10d：超时被杀必须显式标注 killed/timed_out（不再是普通失败）
{
  const tmo = join(WS, 'tmo')
  mkdirSync(tmo, { recursive: true })
  writeFileSync(join(tmo, 'package.json'), JSON.stringify({
    name: 'b13-vp-tmo',
    scripts: { test: 'node -e "setTimeout(()=>{}, 30000)"' },
  }))
  const r = await handle({ workspace_dir: tmo, stages: 'test', timeout: 1 }, ctx)
  assert(r.results?.test?.killed === true, `⑨b 超时被杀标注 killed=true（得 ${r.results?.test?.killed}）`)
  assert(r.results?.test?.timed_out?.timeout_ms === 1, `⑨b timed_out 带 timeout_ms（得 ${JSON.stringify(r.results?.test?.timed_out)}）`)
  assert(r.results?.test?.exitCode !== 0, `⑨b 超时不算通过（exitCode=${r.results?.test?.exitCode}）`)
}
{
  const lfx = join(WS, 'lfx')
  mkdirSync(lfx, { recursive: true })
  writeFileSync(join(lfx, 'package.json'), JSON.stringify({
    name: 'b13-vp-lfx',
    scripts: { 'lint:fix': 'node -e "console.log(42)"' },
  }))
  const r = await handle({ workspace_dir: lfx, stages: 'lint' }, ctx)
  assert(r.results?.lint?.passed === true, `⑨ lint:fix 项目 lint 跑通（passed=${r.results?.lint?.passed}，exit=${r.results?.lint?.exitCode}）`)
  assert(r.scripts?.lint === true, `⑨ scripts.lint 对外布尔 true（得 ${JSON.stringify(r.scripts)}）`)
}

// ⑩ workdir 逃逸拦截（r41：真实路径模式必须防逃逸）
{
  const r = await handle({ workspace_dir: WS, workdir: '../outside' }, ctx)
  assert(r.error === 'path_blocked', `⑩ workdir 逃逸 → path_blocked（得 ${r.error}）`)
}

// ⑪ 非字符串 workdir → invalid_input（r43：join 抛 TypeError 的输入卫生）
{
  const r = await handle({ workspace_dir: WS, workdir: 123 }, ctx)
  assert(r.error === 'invalid_input', `⑪ workdir=123 → invalid_input（得 ${r.error}）`)
}

// ⑫ workdir=null 视为缺省（r44：!= null 统一 null/undefined，只拒真·非字符串）
{
  const r = await handle({ workspace_dir: WS, workdir: null }, ctx)
  assert(r.error !== 'invalid_input', `⑫ workdir=null 应当缺省处理而非 invalid_input（得 ${r.error}）`)
}

// ⑬ stages 全不可识别 → invalid_input（r45：此前 stages='lint:fix' 被过滤成空 → 静默跑挂起的 syntax 阶段）
{
  const r = await handle({ workspace_dir: WS, stages: 'lint:fix' }, ctx)
  assert(r.error === 'invalid_input', `⑬ stages=lint:fix → invalid_input（得 ${r.error}）`)
}

// ⑭ syntax 阶段真实语法检查（r45：无脚本项目兜底不再 `node --check` 无参数挂起 30s，而是逐个文件检查）
{
  writeFileSync(join(WS, 'bare', 'ok.js'), 'const x = 1\nmodule.exports = x\n')
  const r = await handle({ workspace_dir: join(WS, 'bare') }, ctx)
  assert(r.results?.syntax?.ran === true && r.results?.syntax?.passed === true, `⑭ 合法 js 文件 syntax pass（checked=${r.results?.syntax?.checked}）`)
  assert((r.results?.syntax?.checked || 0) >= 1, `⑭ syntax 实际检查了文件（checked=${r.results?.syntax?.checked}）`)
  writeFileSync(join(WS, 'bare', 'bad.js'), 'const x = 1\nconst = broken\n')
  const r2 = await handle({ workspace_dir: join(WS, 'bare') }, ctx)
  assert(r2.results?.syntax?.passed === false && (r2.results?.syntax?.failed || []).some(f => f.file.endsWith('bad.js')), `⑭ 坏语法文件被抓出（failed=${JSON.stringify(r2.results?.syntax?.failed?.map(f => f.file))}）`)
  rmSync(join(WS, 'bare', 'bad.js'))
}

// ⑮ R15: workspace 外 package.json 越界拦截——父目录有带毒脚本，不得执行
{
  const outer = join(WS, '..', 'b13-vp-outer')
  const escMarker = '/tmp/opencode/b13-vp-escapemark'
  mkdirSync(outer, { recursive: true })
  writeFileSync(join(outer, 'package.json'), JSON.stringify({
    name: 'b13-vp-outer',
    scripts: { test: `node -e "require('fs').writeFileSync('${escMarker}', 'escaped')"` },
  }))
  const inner = join(WS, 'nocfg')
  mkdirSync(inner, { recursive: true })
  try { rmSync(escMarker, { force: true }) } catch {}
  const r = await handle({ workspace_dir: join(WS, 'nocfg'), stages: 'test' }, ctx)
  let markerExists = false
  try { markerExists = readFileSync(escMarker, 'utf-8').length > 0 } catch {}
  assert(!markerExists, `⑮ workspace 外 package.json 不被执行（无逃逸标记）`)
  assert(r.status === 'fail' || (r.results?.test && r.results?.test?.ran), `⑮ 返回了结果（${r.status}）`)
  rmSync(outer, { recursive: true, force: true })
  try { rmSync(escMarker, { force: true }) } catch {}
}

// ⑯ R15: timeout 上钳 110s
{
  const r = await handle({ workspace_dir: WS, stages: 'lint', timeout: 999999 }, ctx)
  assert(r.results?.lint?.ran === true && !r.error, `⑯ 超大 timeout 被钳到 110s 仍正常执行（结果 ${r.status}）`)
}

rmSync(WS, { recursive: true, force: true })
console.log(`== test-verify-pipeline: ${pass} passed, ${fail} failed ==`)
process.exit(fail > 0 ? 1 : 0)
