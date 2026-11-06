// test-malong-selfcheck.js — 自检脚本必须能真的检出旧安装物（S1）
//
// 背景：DSH 实录里「code_check 报 failed 但测试全绿」这条，源码侧 0.5.26 就修了，
// 现场仍拿到 failed。要么装的是旧包，要么分支没触发。自检脚本回答前者。
//
// 为什么要给一个"诊断脚本"写测试：本脚本第一版从 scripts/ 调用时向上找到
// malong/package.json 就当成根，然后 7 条修复检查全部"跳过"，最后报
// "未发现加载了旧安装物的证据"——**绿得没有意义**。这轮我已经栽过三次同类错误，
// 所以这里锁死两件事：
//   ① 找不到目标文件 = 不通过（跳过不等于通过）
//   ② 旧安装物必须真的被判为旧（EXIT=1）
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { execFile } from 'node:child_process'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MALONG = join(__dirname, '..')
const SCRIPT = join(MALONG, 'scripts', 'malong-selfcheck.mjs')
let pass = 0, fail = 0
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  FAIL:', msg) } }

function run(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, ...args], { timeout: 60000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') })
    })
  })
}

// ── ① 对当前仓库：应通过，且必须真的检查了文件（不能全是"跳过"）──
{
  const r = await run([])
  assert(r.code === 0, `① 当前仓库自检应通过（exit=${r.code}）`)
  const checked = (r.stdout.match(/✓ /g) || []).length
  const skipped = (r.stdout.match(/— 找不到目标文件/g) || []).length
  assert(checked >= 15, `① 应真的检查到 ≥15 条修复（得 ${checked}）`)
  assert(skipped === 0, `① 不得有"找不到目标文件"的跳过（得 ${skipped} 条）`)
  assert(/version\s*:\s*0\.6\.1/.test(r.stdout), '① 应报出版本号')
}

// ── ② 从子目录调用也必须定位到真正的根（本脚本第一版的 bug）──
{
  const r = await run(['--dir', join(MALONG, 'scripts')])
  assert(r.code === 0, `② 从 scripts/ 调用应能向上找到根并检查（exit=${r.code}）`)
  const checked = (r.stdout.match(/✓ /g) || []).length
  assert(checked >= 15, `② 从子目录调用也应真的检查到 ≥15 条（得 ${checked}；全跳过说明根定位失效）`)
}

// ── ②c 每一份副本都必须单独满足判据，不能"第一个命中就通过"（B8）──
//    真实 bug：候选列表里源码排在 bundle 前面，`break` 掉之后 bundle 侧从未被检查。
//    实测把 dsh/bundle/server/watchdog-log.js 的判据改坏，自检依然全绿。
//    这里直接构造：复制一份仓库，把 bundle 侧某文件改坏，自检必须红且点名该文件。
{
  const SANDBOX = join(os.tmpdir(), 'opencode', 'selfcheck-dual')
  rmSync(SANDBOX, { recursive: true, force: true })
  const root = join(SANDBOX, 'malong')
  // 只造出判据需要的两处布局：源码 tools/ 与 bundle dsh/bundle/server/
  const need = [
    'package.json',
    'tools/tool-code-check/handler.js',
    'dsh/bundle/server/tools/tool-code-check/handler.js',
  ]
  mkdirSync(join(root, 'tools', 'tool-code-check'), { recursive: true })
  mkdirSync(join(root, 'dsh', 'bundle', 'server', 'tools', 'tool-code-check'), { recursive: true })
  writeFileSync(join(root, 'package.json'),
    JSON.stringify({ name: 'malong', version: '0.6.1-rc.1' }))
  const GOOD = 'const timedOut = evidence.some(x => x)\n'
  writeFileSync(join(root, 'tools', 'tool-code-check', 'handler.js'), GOOD)
  // bundle 侧改坏（缺 timedOut 判据）
  writeFileSync(join(root, 'dsh', 'bundle', 'server', 'tools', 'tool-code-check', 'handler.js'),
    'const other = 1\n')
  const r = await run(['--dir', root])
  assert(r.code === 1, `②c bundle 落后时自检必须 exit=1（得 ${r.code}）`)
  assert(/✗ code_check 超时不误归因/.test(r.stdout),
    '②c 必须报出这一项缺失')
  // Windows 复核（2026-11-06）：脚本输出的是平台原生路径（反斜杠），断言不能只认 `/`。
  assert(/dsh[\\/]bundle[\\/]server[\\/]tools[\\/]tool-code-check[\\/]handler\.js/.test(r.stdout),
    '②c 必须点名是 bundle 那份文件坏了（而不是只说"缺失"）')
  // 修好后：这一项不再报红，且注明查了两份副本。
  // 不要求整体 exit=0——沙箱里其余 11 项文件本就不存在，那是真缺文件（该红）。
  writeFileSync(join(root, 'dsh', 'bundle', 'server', 'tools', 'tool-code-check', 'handler.js'), GOOD)
  const r2 = await run(['--dir', root])
  assert(!/✗ code_check 超时不误归因/.test(r2.stdout),
    '②c 两份一致后该项应转绿')
  assert(/✓ code_check 超时不误归因（2 份副本均通过）/.test(r2.stdout),
    `②c 应说明检查了两份副本（stdout 片段: ${
      (r2.stdout.match(/.*code_check 超时不误归因.*/) || [''])[0].trim()}）`)
  rmSync(SANDBOX, { recursive: true, force: true })
}

//    真实 bug：bundle 侧写死 `server/tools/...`，而仓库里 bundle 在
//    `dsh/bundle/server/tools/...` → 本节永远"只检测到一种布局，跳过"。
//    于是源码改了、bundle 没同步，自检照样全绿——这是"检查项永远跳过"的假绿。
//    判据：双布局同时存在时，必须真的比对过（要么一致，要么明确报不一致），绝不允许"跳过"。
//    Windows/CI 复核（2026-11-06）：不能依赖「本地恰好构建过 dsh/bundle/server」——
//    全新检出没有该目录（gitignore），CI 上会误红。改为自造最小双布局沙箱。
{
  const SB = join(os.tmpdir(), 'opencode', 'selfcheck-dualroot')
  rmSync(SB, { recursive: true, force: true })
  const root = join(SB, 'malong')
  const PAIRS = [
    'tools/tool-code-check/handler.js',
    'tools/tool-verify-pipeline/handler.js',
    'tools/tool-fix-imports/handler.js',
    'tools/tool-code-audit/handler.js',
    'tools/entry-shared.js',
    'mcp-server.js',
    'watchdog-log.js',
    'health-check.js',
  ]
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'malong', version: '0.6.1' }))
  for (const rel of PAIRS) {
    const body = '// sandbox fixture\nconst x = 1\n'
    const a = join(root, rel)
    const b = join(root, 'dsh', 'bundle', 'server', rel)
    mkdirSync(dirname(a), { recursive: true })
    mkdirSync(dirname(b), { recursive: true })
    writeFileSync(a, body)
    writeFileSync(b, body)
  }
  const r = await run(['--dir', root])
  assert(!/只检测到一种布局/.test(r.stdout),
    '②b 不得输出"只检测到一种布局，跳过"（双布局同时存在）')
  assert(/bundle 根:/.test(r.stdout), '②b 必须报出探测到的 bundle 根路径')
  const same = (r.stdout.match(/✓ \S+ 一致/g) || []).length
  const diff = (r.stdout.match(/✗ \S+ (不一致|bundle 侧缺失)/g) || []).length
  assert(same + diff >= 5,
    `②b 必须真的比对 ≥5 个文件（一致 ${same} + 不一致 ${diff}）——比对为 0 说明路径又错了`)
  rmSync(SB, { recursive: true, force: true })
}

// ── ③ 故意造一个缺修复的旧安装物 → 必须判为旧（EXIT=1）──
{
  const TMP = join(os.tmpdir(), 'opencode', 'selfcheck-old')
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(join(TMP, 'tools', 'tool-fix-imports'), { recursive: true })
  writeFileSync(join(TMP, 'package.json'), JSON.stringify({ name: 'malong', version: '0.5.0' }))
  // 旧版 handler：没有 importSpecifier / JS_EXTS / crossLangLeads
  writeFileSync(join(TMP, 'tools', 'tool-fix-imports', 'handler.js'),
    "function importSuggestion(lang, m, s) { return '' }\nexport async function handle() { return {} }\n")

  const r = await run(['--dir', TMP])
  assert(r.code === 1, `③ 旧安装物必须 exit=1（得 ${r.code}）`)
  assert(/✗/.test(r.stdout), '③ 必须输出 ✗ 标记')
  assert(/importSpecifier/.test(r.stdout), '③ 必须点名缺失的判据（importSpecifier）')
  assert(/需重建\/重装/.test(r.stdout), '③ 必须给出可操作结论')

  // ── ④ 缺文件同样算不通过（跳过 ≠ 通过）──
  //    关键：目录里**不能有**可向上找到的根，否则根定位会找回 TMP，
  //    于是红的理由是"判据缺失"而不是"缺文件"，测不到这条。
  {
    const BARE = join(os.tmpdir(), 'opencode', 'selfcheck-bare')
    rmSync(BARE, { recursive: true, force: true })
    mkdirSync(join(BARE, 'empty', 'tools'), { recursive: true })
    writeFileSync(join(BARE, 'empty', 'package.json'), JSON.stringify({ name: 'malong', version: '0.5.0' }))
    // empty/ 下没有任何 tools/tool-*/handler.js
    const r2 = await run(['--dir', join(BARE, 'empty')])
    assert(r2.code === 1,
      `④ 目录里缺目标文件时必须 exit=1（得 ${r2.code}）——"找不到"不等于"没问题"`)
    assert(/找不到目标文件/.test(r2.stdout), '④ 必须明确报"找不到目标文件"')
    assert(/跳过不等于通过/.test(r2.stdout), '④ 必须说明跳过不算通过')
    rmSync(BARE, { recursive: true, force: true })
  }
  rmSync(TMP, { recursive: true, force: true })
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
