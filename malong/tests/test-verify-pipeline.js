// test-verify-pipeline.js — B13 verify_pipeline 工具测试
// 覆盖：契约（missing workspace_dir / 目录不存在）/ detectScripts 探测 /
//       lint 阶段真实执行（fixture 项目）/ test 阶段真实执行 / stages 过滤 /
//       workdir 子目录 / 错误路径不 throw
import { join, dirname } from 'node:path'
import { mkdirSync, writeFileSync, rmSync, readFileSync, chmodSync } from 'node:fs'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}

const WS = join(os.tmpdir(), 'opencode', 'b13-vp-ws')
try { rmSync(WS, { recursive: true, force: true }) } catch {}
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
  // R2（0.5.14）：零目标语法检查不是通过——checked=0 → skipped/not_run（旧实现 passed=true 假绿）
  assert(r.results?.syntax?.passed === null && r.results?.syntax?.skipped === true && r.results?.syntax?.checked === 0, `⑦ 零文件 syntax → skipped/checked=0（得 ${JSON.stringify(r.results?.syntax)?.slice(0, 160)}）`)
  assert(r.status === 'not_run' && r.verification?.status === 'not_run', `⑦ 全未执行 → 顶层 not_run（得 ${r.status}/${r.verification?.status}）`)
}
// ⑧ timeout 参数钳制
{
  const r = await handle({ workspace_dir: WS, stages: 'lint', timeout: 0 }, ctx)
  assert(r.results?.lint?.ran === true, `⑧ timeout=0 → 默认超时不崩（lint ran=${r.results?.lint?.ran}）`)
}
// ⑧b r58: manifest 描述含 MCP 120s 硬超时警告（DSH 反馈：全链必撞超时且无预期）
{
  const m = JSON.parse(readFileSync(join(__dirname, '..', 'tools', 'tool-verify-pipeline', 'manifest.json'), 'utf-8'))
  assert(String(m.description).includes('120s hard timeout'), `⑧b manifest 描述含超时警告（${String(m.description).slice(0, 60)}）`)
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
  // live 审查 I1：边界收紧——workspace=nocfg 自身无 package.json 时不得向上取 WS/父目录脚本（旧实现越界执行 WS 脚本）
  assert(r.results?.test?.ran !== true && r.results?.test?.skipped === true, `⑮ 边界外脚本不执行，test 阶段 skipped（得 ${JSON.stringify(r.results?.test)}）`)
  try { rmSync(outer, { recursive: true, force: true }) } catch {}
  try { rmSync(escMarker, { force: true }) } catch {}
}

// ⑯ R15: timeout 上钳 110s；dogfood ②c：background 模式放宽 600s 且不打 mcp_note
{
  const r = await handle({ workspace_dir: WS, stages: 'lint', timeout: 999999 }, ctx)
  assert(r.results?.lint?.ran === true && !r.error, `⑯ 超大 timeout 被钳到 110s 仍正常执行（结果 ${r.status}）`)
  assert(r.timeout_ms === 110000, `⑯ 前台有效 timeout 暴露=110000（得 ${r.timeout_ms}）`)
  const rb = await handle({ workspace_dir: WS, stages: 'lint', timeout: 999999 }, { ...ctx, background: true })
  assert(rb.results?.lint?.ran === true, `⑯b background 模式仍正常执行（${rb.status}）`)
  assert(rb.timeout_ms === 600000, `⑯b background 上限放宽 600000（得 ${rb.timeout_ms}）`)
  assert(!rb.mcp_note, '⑯b background 不打 MCP 120s 超时预警（不占 MCP 请求槽）')
}

// ⑰ G3/§7.4: exit 0 但 0 测试不算绿 → skipped/no_tests
{
  const WS0 = join(WS, 'zero')
  mkdirSync(WS0, { recursive: true })
  writeFileSync(join(WS0, 'package.json'), JSON.stringify({ name: 'zero', scripts: { test: 'node -e "process.exit(0)"' } }))
  const r = await handle({ workspace_dir: WS0, stages: 'test' }, ctx)
  assert(r.results?.test?.skipped === true && r.results?.test?.no_tests === true, `⑰ exit0 但 0 测试 → skipped/no_tests（得 ${JSON.stringify(r.results?.test && { skipped: r.results.test.skipped, no_tests: r.results.test.no_tests })}）`)
  assert(r.results?.test?.passed === null, `⑰ 0 测试 passed=null（得 ${r.results?.test?.passed}）`)
}

// ⑱ R07（0.5.10 审核修复）：缺 tsc/命令不假 failed——typecheck 命令解析先行：
//    无 tsconfig → skipped/no_tsconfig（不 spawn）；有 tsconfig 但命令缺失 → skipped/tsc_not_found（ENOENT 归口，不冒充代码失败）
{
  const tdir = join(WS, 'nocmd')
  mkdirSync(tdir, { recursive: true })
  writeFileSync(join(tdir, 'package.json'), JSON.stringify({ name: 'b13-vp-nocmd' }))
  let r = await handle({ workspace_dir: tdir, stages: 'typecheck' }, ctx)
  assert(r.results?.typecheck?.skipped === true && r.results?.typecheck?.unavailable === 'no_tsconfig', `⑱ 无 tsconfig → skipped/no_tsconfig（得 ${JSON.stringify(r.results?.typecheck)}）`)
  assert(r.results?.typecheck?.passed === null, `⑱ unavailable 不标 passed=false（得 ${JSON.stringify(r.results?.typecheck?.passed)}）`)
  assert(r.status === 'not_run', `⑱ skipped 不拖 fail，但也不报「通过」→ not_run（得 ${r.status}）`)
  writeFileSync(join(tdir, 'tsconfig.json'), '{}')
  const savedPath = process.env.PATH
  process.env.PATH = '/nonexistent-for-test'
  try { r = await handle({ workspace_dir: tdir, stages: 'typecheck' }, ctx) } finally { process.env.PATH = savedPath }
  assert(r.results?.typecheck?.skipped === true && r.results?.typecheck?.unavailable === 'tsc_not_found', `⑱ 有 tsconfig 但命令缺失 → skipped/tsc_not_found（得 ${JSON.stringify(r.results?.typecheck)}）`)
  assert(r.results?.typecheck?.passed === null, `⑱ tsc_not_found 不假 failed（得 ${JSON.stringify(r.results?.typecheck?.passed)}）`)
}

// ⑲b dogfood-050 修复：node --test TAP 计数——旧兜底把含 "ok" 子串的行当通过（实测 9/0/9 假计数）
{
  const tap = join(WS, 'tap')
  mkdirSync(join(tap, 'tests'), { recursive: true })
  writeFileSync(join(tap, 'package.json'), JSON.stringify({ name: 'b13-vp-tap', scripts: { test: 'node --test' } }))
  writeFileSync(join(tap, 'tests', 'mix.test.js'), [
    "const test = require('node:test')",
    "const assert = require('node:assert')",
    "test('passes', () => { assert.equal(1 + 1, 2) })",
    "test('fails', () => { assert.equal(1, 2) })",
  ].join('\n') + '\n')
  const r = await handle({ workspace_dir: tap, stages: 'test' }, ctx)
  assert(r.results?.test?.passed === false, `⑲b TAP 混合结果 passed=false（得 ${r.results?.test?.passed}）`)
  assert(r.results?.test?.passedCount === 1, `⑲b TAP passedCount=1（得 ${r.results?.test?.passedCount}——旧实现 9）`)
  assert(r.results?.test?.failedCount === 1, `⑲b TAP failedCount=1（得 ${r.results?.test?.failedCount}——旧实现 0）`)
  assert(r.results?.test?.total === 2, `⑲b TAP total=2（得 ${r.results?.test?.total}）`)
}
// ⑲c TAP 全绿：计数取自 "# pass N"（旧实现按含 'ok' 子串行数虚高）
{
  const tap = join(WS, 'tap-green')
  mkdirSync(join(tap, 'tests'), { recursive: true })
  writeFileSync(join(tap, 'package.json'), JSON.stringify({ name: 'b13-vp-tapg', scripts: { test: 'node --test' } }))
  writeFileSync(join(tap, 'tests', 'all.test.js'), [
    "const test = require('node:test')",
    "const assert = require('node:assert')",
    "test('a', () => { assert.equal(1, 1) })",
    "test('b', () => { assert.equal(2, 2) })",
    "test('c', () => { assert.equal(3, 3) })",
  ].join('\n') + '\n')
  const r = await handle({ workspace_dir: tap, stages: 'test' }, ctx)
  assert(r.status === 'pass', `⑲c TAP 全绿 status=pass（得 ${r.status}）`)
  assert(r.results?.test?.passedCount === 3, `⑲c TAP passedCount=3（得 ${r.results?.test?.passedCount}）`)
  assert(r.results?.test?.failedCount === 0, `⑲c TAP failedCount=0（得 ${r.results?.test?.failedCount}）`)
}

// ⑲ live 审查 I1：workspace 根无 package.json 时不得向上爬执行祖先脚本
{
  const iso = join(WS, 'iso-root')
  mkdirSync(join(iso, 'proj'), { recursive: true })
  writeFileSync(join(iso, 'package.json'), JSON.stringify({ name: 'b13-vp-iso-ancestor', scripts: { test: 'node -e "console.log(1)"' } }))
  const r = await handle({ workspace_dir: join(iso, 'proj'), stages: 'test' }, ctx)
  assert(r.results?.test?.ran !== true, `⑲ 根无 pkg → 不执行祖先脚本（旧实现 ran=true；得 ${JSON.stringify(r.results?.test)}）`)
}

// ⑳ LH-010（2026-10-07）：stage 结果带 command/cwd（可执行解析）；known-bad 语法样本必须 fail
{
  const bad = join(WS, 'bad-syntax')
  mkdirSync(bad, { recursive: true })
  writeFileSync(join(bad, 'package.json'), JSON.stringify({ name: 'bad' }))
  writeFileSync(join(bad, 'broken.js'), 'const x = ;\n')
  const r = await handle({ workspace_dir: bad }, ctx)
  assert(r.status === 'fail', `⑳ known-bad 语法项目必须 fail（得 ${r.status}）`)
  assert(r.results?.syntax?.passed === false, `⑳ syntax 阶段 passed=false（得 ${JSON.stringify(r.results?.syntax)?.slice(0, 200)}）`)
  assert(Array.isArray(r.results?.syntax?.failed) && r.results.syntax.failed.some(f => String(f.file).includes('broken.js')), '⑳ failed 列出坏文件')
  assert(r.results?.syntax?.cwd === bad, `⑳ syntax 阶段带 cwd（得 ${r.results?.syntax?.cwd}）`)
  assert(typeof r.results?.syntax?.command === 'string' && r.results.syntax.command.length > 0, '⑳ syntax 阶段带 command')
}
{
  const r = await handle({ workspace_dir: WS, stages: 'lint' }, ctx)
  assert(typeof r.results?.lint?.command === 'string' && r.results.lint.command.includes('lint'), `⑳ lint 阶段 command 可执行解析（得 ${r.results?.lint?.command}）`)
  assert(r.results?.lint?.cwd === WS, `⑳ lint 阶段 cwd（得 ${r.results?.lint?.cwd}）`)
}
{
  const bare2 = join(WS, 'bare2')
  mkdirSync(bare2, { recursive: true })
  writeFileSync(join(bare2, 'package.json'), JSON.stringify({ name: 'bare2' }))
  const r = await handle({ workspace_dir: bare2, stages: 'test' }, ctx)
  assert(r.results?.test?.skipped === true && r.results?.test?.command === null && r.results?.test?.cwd === bare2, `⑳ 无 test 脚本 skipped 仍带 cwd、command=null（得 ${JSON.stringify(r.results?.test)}）`)
}

// ㉑ live 复验（批5后，2026-10-07）：宿主门控 env 不泄漏进项目子进程——
//    背景：graph 宿主下 code_check→npm test，子进程继承 MALONG_INTERFACE 使 malong 自身
//    registry 门控隐藏测试临时工具（test-tool-registry 0/49 假失败）。
//    执行类工具跑的是「项目命令」，语义应与 CI/终端一致 → 默认剥离（显式覆盖走 opts.env）。
{
  const envProj = join(WS, 'env-hygiene')
  mkdirSync(envProj, { recursive: true })
  const probe = "node -e \"const i=process.env.MALONG_INTERFACE||null;const s=process.env.MALONG_ENTRY_STATE||null;if(i||s){console.error('LEAK i='+i+' s='+s);process.exit(3)};console.log('1 passed, 0 failed')\""
  writeFileSync(join(envProj, 'package.json'), JSON.stringify({ name: 'b13-vp-env', scripts: { test: probe } }))
  const savedI = process.env.MALONG_INTERFACE
  const savedS = process.env.MALONG_ENTRY_STATE
  process.env.MALONG_INTERFACE = 'graph'
  process.env.MALONG_ENTRY_STATE = '1'
  let r
  try {
    r = await handle({ workspace_dir: envProj, stages: 'test' }, ctx)
  } finally {
    if (savedI === undefined) delete process.env.MALONG_INTERFACE; else process.env.MALONG_INTERFACE = savedI
    if (savedS === undefined) delete process.env.MALONG_ENTRY_STATE; else process.env.MALONG_ENTRY_STATE = savedS
  }
  const t = r.results?.test || {}
  assert(t.passed === true && t.failedCount === 0, '㉑ 宿主门控 env 不泄漏到子进程（须 CLEAN 通过；得 ' + JSON.stringify({ passed: t.passed, failedCount: t.failedCount, stderr: String(t.stderr_tail || '').slice(0, 120) }) + '）')
}

// ⑲d R07（0.5.10）：typecheck 不可用分类纯函数——Windows 本地化缺命令/缺包横幅/无配置 归 unavailable；真编译错误不归
{
  const { typecheckUnavailableReason } = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-verify-pipeline', 'handler.js')).href)
  assert(typecheckUnavailableReason({ exitCode: 1, stdout: '', stderr: 'tsc 不是内部或外部命令，也不是可运行的程序或批处理文件。' }) === 'tsc_not_found', '⑲d 中文缺命令 → tsc_not_found')
  assert(typecheckUnavailableReason({ exitCode: 1, stdout: '', stderr: 'npx is not recognized as an internal or external command' }) === 'tsc_not_found', '⑲d 英文缺命令 → tsc_not_found')
  assert(typecheckUnavailableReason({ exitCode: 9009, stdout: '', stderr: '', error: 'command not found (cmd.exe exit 9009)', error_code: 'ENOENT' }) === 'tsc_not_found', '⑲d 9009 结构化 → tsc_not_found')
  assert(typecheckUnavailableReason({ exitCode: 1, stdout: '', stderr: 'npx canceled due to missing packages' }) === 'tsc_not_found', '⑲d npx 缺包 → tsc_not_found')
  assert(typecheckUnavailableReason({ exitCode: 1, stdout: 'Version 5.4.5 tsc compiler Usage: tsc', stderr: '' }) === 'no_tsconfig', '⑲d 帮助横幅 → no_tsconfig')
  assert(typecheckUnavailableReason({ exitCode: 2, stdout: 'a.ts(1,2): error TS2322: nope', stderr: '' }) === null, '⑲d 真编译错误不归 unavailable')
  assert(typecheckUnavailableReason({ exitCode: 1, stdout: 'all good', stderr: '' }) === null, '⑲d 无特征样本不误判')
}

// ⑲e N04（0.5.11 复审）：包脚本里有 tsc 但本机缺 tsc —— 结构化事实判 unavailable，不靠本地化文本
//      失败路径：脚本工具可解析时必须保持 failed（不得把任意非零都改成 unavailable）
{
  const vp = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-verify-pipeline', 'handler.js')).href)
  const { firstScriptToken, isCommandResolvable, scriptToolUnavailableReason } = vp
  assert(firstScriptToken('tsc --noEmit') === 'tsc', '⑲e 首 token 解析：tsc --noEmit（得 ' + firstScriptToken('tsc --noEmit') + '）')
  assert(firstScriptToken('NODE_ENV=production tsc -p .') === 'tsc', '⑲e 剥 env 前缀（得 ' + firstScriptToken('NODE_ENV=production tsc -p .') + '）')
  assert(firstScriptToken('npx --no-install tsc --noEmit') === 'tsc', '⑲e npx 包装取真实工具（得 ' + firstScriptToken('npx --no-install tsc --noEmit') + '）')
  assert(firstScriptToken('') === null, '⑲e 空脚本 → null')
  // 结构化 IO 注入：不依赖本机真的没装 tsc
  const io = {
    exists: (p) => String(p).replace(/\\/g, '/').endsWith('node_modules/.bin/eslint'),
    join: join,
    platform: () => 'linux',
  }
  assert(isCommandResolvable('tsc', WS, { PATH: '/usr/bin:/bin' }, io) === false, '⑲e tsc 解析不到 → false')
  assert(isCommandResolvable('eslint', WS, { PATH: '/usr/bin:/bin' }, io) === true, '⑲e 项目 .bin 里的 eslint → true')
  assert(scriptToolUnavailableReason('tsc --noEmit', 1, WS, { PATH: '/usr/bin:/bin' }, io)?.reason === 'tsc_not_found', '⑲e 缺 tsc 脚本 → tsc_not_found')
  assert(scriptToolUnavailableReason('tsc --noEmit', 0, WS, { PATH: '/usr/bin:/bin' }, io) === null, '⑲e exit=0 不判不可用')
  assert(scriptToolUnavailableReason('eslint .', 1, WS, { PATH: '/usr/bin:/bin' }, io) === null, '⑲e 工具可解析 → 保持 failed（不兜底成 unavailable）')
  assert(scriptToolUnavailableReason('', 1, WS, { PATH: '/usr/bin:/bin' }, io) === null, '⑲e 空脚本不判不可用')

  // 端到端：typecheck 脚本 = 不存在的 tsc 且本机解析不到 → skipped（不是 fail）
  const eproj = join(WS, 'n04-typecheck')
  mkdirSync(eproj, { recursive: true })
  writeFileSync(join(eproj, 'package.json'), JSON.stringify({ name: 'n04', scripts: { typecheck: 'no-such-local-tsc --noEmit' } }))
  writeFileSync(join(eproj, 'tsconfig.json'), '{}')
  const e = await handle({ workspace_dir: eproj, stages: 'typecheck' }, ctx)
  const st = e.results?.typecheck || {}
  assert(e.status === 'not_run' && e.verification?.status === 'not_run', '⑲e 缺工具不拖 fail，也不报通过 → not_run（得 ' + e.status + '/' + e.verification?.status + '）')
  assert(st.skipped === true && st.passed === null, '⑲e 缺工具 → skipped 且 passed=null（得 ' + JSON.stringify({ skipped: st.skipped, passed: st.passed }) + '）')
  assert(/not_found/.test(String(st.unavailable || '')), '⑲e unavailable 标明缺件（得 ' + st.unavailable + '）')
}

// Windows cmd builtins are executable without a matching .exe in PATH.
{
  const { isCommandResolvable, scriptToolUnavailableReason } = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-verify-pipeline', 'handler.js')).href)
  const io = { exists: () => false, platform: () => 'win32' }
  for (const cmd of ['set', 'SET', '@echo', 'call', 'if']) {
    assert(isCommandResolvable(cmd, WS, { PATH: '', PATHEXT: '.EXE;.CMD' }, io) === true, `cmd builtin ${cmd} does not require a file`)
  }
  assert(isCommandResolvable('no-such-check-tool', WS, { PATH: '', PATHEXT: '.EXE;.CMD' }, io) === false, 'missing ordinary command stays unavailable')
  assert(scriptToolUnavailableReason('missing-check || node fallback.cjs', 1, WS, { PATH: '' }, io) === null, 'compound shell fallback must not be rejected before execution')
}
if (process.platform === 'win32') {
  const proj = join(WS, 'cmd-builtins')
  mkdirSync(proj, { recursive: true })
  const pkg = join(proj, 'package.json')
  writeFileSync(join(proj, 'bad.cjs'), 'function broken( {\n')
  writeFileSync(join(proj, 'good.cjs'), 'const checked = true\n')
  writeFileSync(pkg, JSON.stringify({ name: 'cmd-builtins', scripts: { typecheck: 'set CHECK_MODE=strict&& node --check bad.cjs' } }))
  const bad = await handle({ workspace_dir: proj, stages: 'typecheck' }, ctx)
  assert(bad.results?.typecheck?.ran === true && bad.results.typecheck.passed === false && bad.status === 'fail', 'native cmd set prefix must execute and retain a real syntax failure')
  assert(/SyntaxError/.test(bad.results?.typecheck?.stderr || ''), 'native failing checker returns its actual SyntaxError')
  writeFileSync(pkg, JSON.stringify({ name: 'cmd-builtins', scripts: { typecheck: 'set CHECK_MODE=strict&& node --check good.cjs' } }))
  const good = await handle({ workspace_dir: proj, stages: 'typecheck' }, ctx)
  assert(good.results?.typecheck?.ran === true && good.results.typecheck.passed === true, 'native cmd set prefix also executes a successful checker')
  writeFileSync(pkg, JSON.stringify({ name: 'cmd-builtins', scripts: { typecheck: 'no-such-check-tool || node --check good.cjs' } }))
  const fallback = await handle({ workspace_dir: proj, stages: 'typecheck' }, ctx)
  assert(fallback.results?.typecheck?.ran === true && fallback.results.typecheck.passed === true, 'native shell fallback may succeed despite a missing first command')
}

// ⑲f N04b（0.5.11+）：复合命令守卫扩至 POSIX——复合脚本交还 runner 判定；缺件由结果层结构分类兜住
{
  const vp = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-verify-pipeline', 'handler.js')).href)
  const { scriptToolUnavailableReason, typecheckUnavailableReason } = vp
  const lio = { exists: () => false, platform: () => 'linux' }
  const lenv = { PATH: '' }
  const COMPOUNDS = ['cd sub && tsc --noEmit', 'cd sub; tsc', 'tsc || echo skip', 'echo cfg > out.log && tsc', '$(npm bin)/tsc', 'cd sub\ntsc --noEmit']
  for (const s of COMPOUNDS) {
    assert(scriptToolUnavailableReason(s, 1, WS, lenv, lio) === null, '⑲f POSIX 复合脚本交还 runner（得 ' + JSON.stringify(scriptToolUnavailableReason(s, 1, WS, lenv, lio)) + '：' + s + '）')
  }
  assert(scriptToolUnavailableReason('tsc --noEmit', 1, WS, lenv, lio)?.reason === 'tsc_not_found', '⑲f 简单脚本缺 tsc 仍结构化判定（守卫扩面不回退）')
  assert(typecheckUnavailableReason({ exitCode: 1, stdout: '', stderr: 'sh: 1: tsc: not found' }) === 'tsc_not_found', '⑲f dash 缺 tsc → tsc_not_found')
  assert(typecheckUnavailableReason({ exitCode: 1, stdout: '', stderr: '/bin/sh: 1: tsc: not found' }) === 'tsc_not_found', '⑲f /bin/sh 前缀 → tsc_not_found')
  assert(typecheckUnavailableReason({ exitCode: 1, stdout: '', stderr: 'sh: 1: no-such-tool-xyz: not found' }) === 'script_tool_not_found', '⑲f dash 缺普通命令 → script_tool_not_found')
  assert(typecheckUnavailableReason({ exitCode: 1, stdout: '', stderr: 'bash: line 1: no-such-tool-xyz: command not found' }) === 'script_tool_not_found', '⑲f bash 缺普通命令 → script_tool_not_found')
  assert(typecheckUnavailableReason({ exitCode: 1, stdout: '', stderr: 'error TS6053: File tsconfig.json not found.' }) === null, '⑲f TS 诊断不误判为缺件')
  assert(typecheckUnavailableReason({ exitCode: 1, stdout: '', stderr: 'sh: 1: tsc: not found\nerror TS2322: real diagnostic' }) === null, '⑲f 共存时真实诊断优先（不吞失败）')
  // ⑲g N04c：exit=0 的阶段已跑通 → 缺件文本不得改判；真实失败产出也不得被缺件文本吞掉
  assert(typecheckUnavailableReason({ exitCode: 0, stdout: '', stderr: 'sh: 1: no-such-tool: not found' }) === null, '⑲g exit=0 的 fallback 成功不得改判 unavailable')
  assert(typecheckUnavailableReason({ exitCode: 1, stdout: '', stderr: 'sh: 1: no-such-tool: not found\nSyntaxError: Unexpected end of input' }) === null, '⑲g 缺件+真实语法错 → 真实失败优先（不吞）')
  assert(typecheckUnavailableReason({ exitCode: 1, stdout: '', stderr: 'sh: 1: no-such-tool: not found\n    at wrapSafe (node:internal/modules/cjs/loader:1637:18)' }) === null, '⑲g 缺件+运行时栈 → 真实失败优先')
  assert(typecheckUnavailableReason({ exitCode: 1, stdout: '', stderr: 'sh: 1: no-such-tool: not found' }) === 'script_tool_not_found', '⑲g 缺件是唯一信号时仍归 unavailable')
  const cproj = join(WS, 'posix-compound')
  mkdirSync(join(cproj, 'sub'), { recursive: true })
  writeFileSync(join(cproj, 'sub', 'good.cjs'), 'const ok = true\n')
  writeFileSync(join(cproj, 'package.json'), JSON.stringify({ name: 'posix-compound', scripts: { typecheck: 'cd sub && node --check good.cjs' } }))
  const g = await handle({ workspace_dir: cproj, stages: 'typecheck' }, ctx)
  assert(g.results?.typecheck?.ran === true && g.results.typecheck.passed === true, '⑲f E2E 复合脚本真跑真过（修复前被误跳过；得 ' + JSON.stringify({ ran: g.results?.typecheck?.ran, passed: g.results?.typecheck?.passed, skipped: g.results?.typecheck?.skipped, unavailable: g.results?.typecheck?.unavailable }) + '）')
  writeFileSync(join(cproj, 'package.json'), JSON.stringify({ name: 'posix-compound', scripts: { typecheck: 'cd sub && no-such-tool-xyz --noEmit' } }))
  const b2 = await handle({ workspace_dir: cproj, stages: 'typecheck' }, ctx)
  const bt = b2.results?.typecheck || {}
  assert(bt.skipped === true && bt.passed === null && /not_found/.test(String(bt.unavailable || '')), '⑲f E2E 复合脚本缺工具 → unavailable（不冒充 failed；得 ' + JSON.stringify({ skipped: bt.skipped, passed: bt.passed, unavailable: bt.unavailable, status: b2.status }) + '）')
  // ⑲g E2E：复合 fallback 真跑通不得被 sh 的 not found 提示改判；fallback 后真错不得被吞
  writeFileSync(join(cproj, 'package.json'), JSON.stringify({ name: 'posix-compound', scripts: { typecheck: 'no-such-tool-xyz || node --check sub/good.cjs' } }))
  const f1 = await handle({ workspace_dir: cproj, stages: 'typecheck' }, ctx)
  const ft1 = f1.results?.typecheck || {}
  assert(ft1.ran === true && ft1.passed === true && !ft1.skipped, '⑲g E2E fallback 成功 → PASS（不得被 sh not found 改判；得 ' + JSON.stringify({ ran: ft1.ran, passed: ft1.passed, skipped: ft1.skipped, unavailable: ft1.unavailable }) + '）')
  writeFileSync(join(cproj, 'sub', 'bad.cjs'), 'function broken( {\n')
  writeFileSync(join(cproj, 'package.json'), JSON.stringify({ name: 'posix-compound', scripts: { typecheck: 'no-such-tool-xyz || node --check sub/bad.cjs' } }))
  const f2 = await handle({ workspace_dir: cproj, stages: 'typecheck' }, ctx)
  const ft2 = f2.results?.typecheck || {}
  assert(ft2.ran === true && ft2.passed === false && !ft2.skipped && /SyntaxError/.test(String(ft2.stderr || '')), '⑲g E2E fallback 后真错 → failed 且保留 SyntaxError（不得吞成 unavailable；得 ' + JSON.stringify({ ran: ft2.ran, passed: ft2.passed, skipped: ft2.skipped, unavailable: ft2.unavailable }) + '）')
}

// ⑲h R2（0.5.14 复审修复）：汇总四值语义 + Windows cmd 缺命令分类 + verification 合同
{
  const vp = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-verify-pipeline', 'handler.js')).href)
  const { typecheckUnavailableReason } = vp
  const enMiss = { exitCode: 1, stdout: '', stderr: "'no-such-tool-xyz' is not recognized as an internal or external command,\noperable program or batch file." }
  assert(typecheckUnavailableReason(enMiss) === 'script_tool_not_found', '⑲h cmd 英文缺普通命令 → script_tool_not_found（得 ' + typecheckUnavailableReason(enMiss) + '）')
  const zhMiss = { exitCode: 1, stdout: '', stderr: "'no-such-tool-xyz' 不是内部或外部命令，也不是可运行的程序或批处理文件。" }
  assert(typecheckUnavailableReason(zhMiss) === 'script_tool_not_found', '⑲h cmd 中文缺普通命令 → script_tool_not_found')
  const cmdTsc = { exitCode: 1, stdout: '', stderr: "'tsc' is not recognized as an internal or external command" }
  assert(typecheckUnavailableReason(cmdTsc) === 'tsc_not_found', '⑲h cmd 缺 tsc → tsc_not_found')
  const moji = { exitCode: 1, stdout: '', stderr: "'no-such-tool-xyz' " + '\uFFFD'.repeat(6) + '，\uFFFD\uFFFD。' }
  assert(typecheckUnavailableReason(moji, 'win32') === 'script_tool_not_found', '⑲h GBK 乱码态（win32）仍可提取缺件信号')
  assert(typecheckUnavailableReason(moji, 'linux') === null, '⑲h 乱码提取只在 win32 生效（防误伤其它平台）')
  const mixed = { exitCode: 1, stdout: '', stderr: "'no-such-tool-xyz' is not recognized as an internal or external command\nerror TS2322: real diagnostic" }
  assert(typecheckUnavailableReason(mixed) === null, '⑲h 缺命令 + 真实 TS 诊断 → 真实失败优先（不吞）')
  // 部分执行 + 部分未执行 → partial（完整性受限；未测项不计通过）
  const rp = await handle({ workspace_dir: WS, stages: 'lint,typecheck' }, ctx)
  assert(rp.status === 'partial' && rp.verification?.status === 'partial' && rp.verification.complete === false, `⑲h 一跑一未跑 → partial（得 ${rp.status}/${rp.verification?.status}）`)
  assert(rp.verification.passed === 1 && rp.verification.skipped === 1, `⑲h verification 计数正确（得 ${JSON.stringify(rp.verification)}）`)
  assert(String(rp.verification.reason || '').includes('typecheck'), `⑲h partial.reason 标明未执行阶段（得 ${rp.verification.reason}）`)
  // 全部真通过 → pass 且 complete=true
  const rAll = await handle({ workspace_dir: WS, stages: 'lint' }, ctx)
  assert(rAll.status === 'pass' && rAll.verification?.complete === true && rAll.verification.skipped === 0, `⑲h 全通过 → pass/complete（得 ${rAll.status}）`)
  // 真实失败 → fail（且 verification.failed 计数）
  const rFail = await handle({ workspace_dir: join(WS, 'sub'), stages: 'lint' }, ctx)
  assert(rFail.status === 'fail' && rFail.verification?.failed === 1, `⑲h 真失败 → fail（得 ${rFail.status}）`)
}

// ⑳ 0.5.25：Python 项目也能验——没有 npm test 脚本时用项目 venv 的解释器跑 pytest
// （旧实现：test 阶段直接 skipped「No test script in package.json」→ Python 仓的 code_check 永远验不了）
{
  // 假解释器用 POSIX shell 脚本模拟 pytest 输出——Windows 无法执行，真跑部分跳过；
  // 解释器解析的 Windows 布局由 test-python-project 的 2b 段覆盖。
  if (process.platform === 'win32') {
    console.log('  [NOT_RUN] ⑳ Python venv 真跑（Windows 无法执行 POSIX 假解释器）')
  } else {
    const pyWs = join(os.tmpdir(), 'opencode', 'b13-vp-py')
    try { rmSync(pyWs, { recursive: true, force: true }) } catch {}
    const proj = join(pyWs, 'proj')
    mkdirSync(join(proj, '.venv', 'bin'), { recursive: true })
    writeFileSync(join(proj, 'pyproject.toml'), '[project]\nname = "py-fixture"\n')
    const fakePy = join(proj, '.venv', 'bin', 'python')
    writeFileSync(fakePy, '#!/bin/sh\necho "2 passed in 0.02s"\n')
    try { chmodSync(fakePy, 0o755) } catch {}
    // 显式 test 阶段 → 真跑 pytest
    const r = await handle({ workspace_dir: pyWs, stages: 'test' }, ctx)
    assert(r.results?.test?.ran === true, `⑳ Python 仓 test 阶段真跑（得 ${JSON.stringify(r.results?.test)?.slice(0, 160)}）`)
    assert(String(r.results?.test?.command).includes('.venv/bin/python'), `⑳ 用项目 venv 解释器（得 ${r.results?.test?.command}）`)
    assert(r.results?.test?.cwd === proj, `⑳ cwd = 项目根而非工作区根（得 ${r.results?.test?.cwd}）`)
    assert(r.results?.test?.total === 2 && r.results?.test?.passedCount === 2, `⑳ pytest 输出被解析（得 ${r.results?.test?.total}/${r.results?.test?.passedCount}）`)
    // 自动选阶段：Python 项目也要带上 test
    const r2 = await handle({ workspace_dir: pyWs }, ctx)
    assert(Object.keys(r2.results || {}).includes('test'), `⑳ 自动选阶段含 test（得 ${Object.keys(r2.results || {})}）`)
    // ⑳b 0.5.25：pytest 进度字符解析——项目 pytest 配置自带 addopts="-q" 时叠加命令行 -q 变 -qq，
    // 汇总行（"N passed"）被隐藏 → 旧实现判「0 tests → 不计入通过」（明明跑完却不算绿）
    {
      const quietWs = join(os.tmpdir(), 'opencode', 'b13-vp-quiet')
      try { rmSync(quietWs, { recursive: true, force: true }) } catch {}
      const qproj = join(quietWs, 'proj')
      mkdirSync(join(qproj, '.venv', 'bin'), { recursive: true })
      writeFileSync(join(qproj, 'pyproject.toml'), '[project]\nname = "quiet-fixture"\n')
      const qpy = join(qproj, '.venv', 'bin', 'python')
      writeFileSync(qpy, '#!/bin/sh\necho "......."\necho "....... [100%]"\n')
      try { chmodSync(qpy, 0o755) } catch {}
      const rq = await handle({ workspace_dir: quietWs, stages: 'test' }, ctx)
      assert(rq.results?.test?.passed === true, `⑳b 进度字符也能判通过（得 ${JSON.stringify(rq.results?.test)?.slice(0, 160)}）`)
      assert(rq.results?.test?.passedCount === 14, `⑳b 从进度字符数出通过数（得 ${rq.results?.test?.passedCount}）`)
      assert(rq.results?.test?.total === 14, `⑳b total 同步（得 ${rq.results?.test?.total}）`)
      try { rmSync(quietWs, { recursive: true, force: true }) } catch {}
    }
    try { rmSync(pyWs, { recursive: true, force: true }) } catch {}
  }

  // 没有任何测试入口 → skipped（不假绿）
  const bareWs = join(os.tmpdir(), 'opencode', 'b13-vp-bare')
  try { rmSync(bareWs, { recursive: true, force: true }) } catch {}
  mkdirSync(bareWs, { recursive: true })
  const r3 = await handle({ workspace_dir: bareWs, stages: 'test' }, ctx)
  assert(r3.results?.test?.skipped === true && r3.results?.test?.passed === null, `⑳ 无入口 → skipped/not-pass（得 ${JSON.stringify(r3.results?.test)?.slice(0, 140)}）`)
  try { rmSync(bareWs, { recursive: true, force: true }) } catch {}
}

try { rmSync(WS, { recursive: true, force: true }) } catch {}
console.log(`== test-verify-pipeline: ${pass} passed, ${fail} failed ==`)
process.exit(fail > 0 ? 1 : 0)
