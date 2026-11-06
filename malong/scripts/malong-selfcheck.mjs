#!/usr/bin/env node
// malong-selfcheck.mjs — 自检：DSH 侧实际加载的 malong 版本是否含关键修复
//
// 用法（在装了 malong 的机器上跑）：
//   node malong-selfcheck.mjs
//   node malong-selfcheck.mjs --dir /path/to/malong
//
// 目的：DSH 实录里「code_check 报 failed 但测试全绿」那条，源码侧 0.5.26 就修了
// （timedOut → 不算代码缺陷 + next_action 指 async 重试）。现场仍拿到 failed，
// 只有两种可能：
//   (a) 实际加载的是更旧的安装物（bundle 未重建 / 装的是旧包）
//   (b) 修复在，但该分支没被触发（stage.timed_out 未被置位）
// 本脚本只回答 (a)；(b) 需要一次真实 code_check 的 evidence 才能判。
//
// 只读：不写任何文件、不改索引、不连 MCP。
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const i = args.indexOf('--dir')
const START = i >= 0 && args[i + 1]
  ? resolve(args[i + 1])
  : dirname(fileURLToPath(import.meta.url))

// 向上找真正的根：含 package.json 且 name 看起来是 malong，或含 tools/ 的目录。
// 不这样做，从 scripts/ 调用会把上级 package.json 当成"根"，然后什么都没查就报绿
// ——那种绿没有意义（本脚本第一版就是这么错的）。
function looksLikeRoot(dir) {
  const j = readJsonQuiet(join(dir, 'package.json'))
  if (j && /malong/i.test(String(j.name || ''))) return true
  return existsSync(join(dir, 'tools', 'tool-code-check', 'handler.js'))
}
function readJsonQuiet(p) { try { return JSON.parse(readFileSync(p, 'utf-8')) } catch { return null } }

let ROOT = START
for (let d = START, n = 0; n < 5; n++) {
  if (looksLikeRoot(d)) { ROOT = d; break }
  const up = dirname(d)
  if (up === d) break
  d = up
  ROOT = d
}
// bundle 布局：<root>/server/tools/... 时，把 ROOT 定到 <root>（server 的上一级）
if (existsSync(join(ROOT, 'server', 'tools'))) { /* 保留，修复查找已同时尝试两种前缀 */ }

const out = []
const say = (s = '') => { out.push(s); console.log(s) }
let problems = 0

say('══════════════════════════════════════════════════════════')
say(' malong 自检（只读）')
say('══════════════════════════════════════════════════════════')
say(`检测目录: ${ROOT}`)
say()

function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf-8')) } catch { return null }
}
function read(p) {
  try { return readFileSync(p, 'utf-8') } catch { return null }
}

// ── 1. 版本与安装形态 ──
say('【1】版本与安装形态')
const pkgPaths = [
  join(ROOT, 'package.json'),
  join(ROOT, 'server', 'package.json'),
  join(ROOT, '..', 'package.json'),
]
let foundPkg = null
for (const p of pkgPaths) {
  const j = readJson(p)
  if (j && j.name) { foundPkg = { path: p, json: j }; break }
}
if (!foundPkg) {
  say('  ✗ 找不到 package.json——路径不对？用 --dir 指向 malong 根目录或 bundle 目录')
  problems++
} else {
  const { path, json } = foundPkg
  say(`  name    : ${json.name}`)
  say(`  version : ${json.version}`)
  say(`  private : ${json.private === true ? 'true（未发布 npm——安装物应来自本地构建）' : String(json.private)}`)
  say(`  位置    : ${path}`)
  try {
    const st = statSync(path)
    say(`  mtime   : ${st.mtime.toISOString()}`)
    const days = (Date.now() - st.mtimeMs) / 86400000
    if (days > 7) say(`  ⚠ package.json 已 ${days.toFixed(0)} 天未更新——确认这是当前在用的安装物`)
  } catch {}
}
say()

// ── 2. 关键修复是否在这个安装物里 ──
say('【2】关键修复存在性（逐条 grep 实际文件）')
// bundle 根候选：仓库内 bundle 在 dsh/bundle/server，已解包的运行物在 server/
const BUNDLE_ROOTS_EARLY = [
  join(ROOT, 'server'),
  join(ROOT, 'dsh', 'bundle', 'server'),
  join(ROOT, '..', 'server'),
].filter(d => existsSync(d))
const FIXES = [
  {
    id: 'code_check 超时不误归因',
    desc: 'timedOut → 判为请求预算截断，不指回 code_patch',
    files: ['tools/tool-code-check/handler.js', 'server/tools/tool-code-check/handler.js'],
    must: [/const timedOut\s*=\s*evidence\.some/],
    since: '0.5.26',
  },
  {
    id: 'fix_imports JS/TS specifier',
    desc: '点号路径 → 相对路径（防 ERR_MODULE_NOT_FOUND）',
    files: ['tools/tool-fix-imports/handler.js', 'server/tools/tool-fix-imports/handler.js'],
    must: [/function importSpecifier/],
    since: 'f5e35d0 / 2026-11-02',
  },
  {
    id: 'fix_imports 跨语言不提案',
    desc: '非 JS/TS 目标不给 import 提案，降级为 leads',
    files: ['tools/tool-fix-imports/handler.js', 'server/tools/tool-fix-imports/handler.js'],
    must: [/JS_EXTS/, /crossLangLeads/],
    since: 'f5e35d0 / 2026-11-02',
  },
  {
    id: 'fix_imports 块注释插入点',
    desc: '文件头 /** */ 不当作"代码已开始"',
    files: ['tools/tool-fix-imports/handler.js', 'server/tools/tool-fix-imports/handler.js'],
    must: [/inBlockComment/],
    since: 'fe6e26f / 2026-11-02',
  },
  {
    id: 'verifySyntax 按真实后缀',
    desc: '.js 走 --input-type=module（node --check 对 ESM 会放行）',
    files: ['tools/tool-fix-imports/handler.js', 'server/tools/tool-fix-imports/handler.js'],
    must: [/input-type=module/],
    since: 'fe6e26f / 2026-11-02',
  },
  {
    id: 'code_audit dead_code 尊重 files',
    desc: 'files 参数在 dead_code 上生效（此前扫全库）',
    files: ['tools/tool-code-audit/handler.js', 'server/tools/tool-code-audit/handler.js'],
    must: [/if \(!scope && files\.length\)/],
    since: '9d76593 / 2026-11-02',
  },
  {
    id: 'route 造物动词',
    desc: '「写一个/做一个」等不再被 document 抢走',
    files: ['tools/entry-shared.js', 'server/tools/entry-shared.js'],
    must: [/写一个|做一个/],
    since: 'f5e35d0 / 2026-11-02',
  },
  {
    id: '超时预报不误报',
    desc: '单阶段成功路径不再挂「will definitely time out」',
    files: ['tools/tool-verify-pipeline/handler.js', 'server/tools/tool-verify-pipeline/handler.js'],
    must: [/wanted\.length > 1 && totalBudgetMs/],
    since: 'B7 / 2026-11-02',
  },
  {
    id: 'evidence 区分超时与失败',
    desc: 'actual 分别写 killed / timed_out / timed_out_ms',
    files: ['tools/tool-code-check/handler.js', 'server/tools/tool-code-check/handler.js'],
    must: [/stage\?\.killed === true \? \{ killed: true \}/, /timed_out_ms/],
    since: 'B7 / 2026-11-02',
  },
  {
    id: 'watchdog 日志带数值',
    desc: 'FAIL 行不再只打检查项名，含 detail（RSS 等）',
    files: ['watchdog-log.js', 'server/watchdog-log.js'],
    must: [/formatFailChecks/, /c\.detail \|\| c\.status/],
    since: 'B8 / 2026-11-02',
  },
  {
    id: 'watchdog 自救不可用要说清',
    desc: '无 --expose-gc 时不静默跳过 GC 分支',
    files: ['mcp-server.js', 'server/mcp-server.js'],
    must: [/gcUnavailableNotice/],
    since: 'B8 / 2026-11-02',
  },
  {
    id: 'watchdog 额度耗尽不静默',
    desc: 'restart 用尽后明确报「已放弃」',
    files: ['mcp-server.js', 'server/mcp-server.js'],
    must: [/restartExhaustedNotice/, /shouldNoticeExhausted/],
    since: 'B8 / 2026-11-02',
  },
  {
    id: '堆上限真的传给 V8',
    desc: 'checkV8HeapLimit 读 execArgv，不读 argv（argv 可能是脚本参数）',
    files: ['mcp-server.js', 'server/mcp-server.js'],
    must: [/process\.execArgv\.find/],
    since: 'B8 / 2026-11-02',
  },
  {
    id: '内存监控不依赖 expose-gc',
    desc: '无 --expose-gc 时软告警仍生效',
    files: ['mcp-server.js', 'server/mcp-server.js'],
    must: [/formatMemoryWarning/],
    since: 'B8 / 2026-11-02',
  },
  {
    id: '内存告警三阈值同源',
    desc: 'soft/warn/fail 集中在 MEMORY_THRESHOLDS，不再各处写死',
    files: ['watchdog-log.js', 'server/watchdog-log.js'],
    must: [/MEMORY_THRESHOLDS/, /soft threshold/, /FAIL=/],
    since: 'B8 / 2026-11-02',
  },
]

for (const fx of FIXES) {
  // B8：`files` 里写的是两种布局的相对路径（`tools/...` 源码 / `server/...` 运行物），
  // 但仓库内 bundle 在 `dsh/bundle/server/...`。旧实现只试 `join(ROOT, rel)`，
  // 于是 `server/...` 那一路永远落空——**bundle 侧从未被这条检查覆盖过**。
  // 把 `server/` 前缀按实际 bundle 根展开。
  const cands = []
  for (const rel of fx.files) {
    if (rel.startsWith('server/')) {
      for (const br of BUNDLE_ROOTS_EARLY) cands.push(join(br, rel.slice('server/'.length)))
    } else {
      cands.push(join(ROOT, rel))
    }
  }
  let srcPath = null, src = null
  const found = []
  for (const p of cands) {
    const s = read(p)
    if (s) found.push({ p, s })
  }
  // B8：不得"第一个命中就通过"。源码与 bundle 同时存在时，只查源码会漏掉
  // 「bundle 没同步」——实测把 dsh/bundle/server/watchdog-log.js 的判据改坏，
  // 自检依然全绿。每一份实际存在的副本都必须单独满足判据。
  if (found.length === 0) {
    problems++
    say(`  ✗ ${fx.id} — 找不到目标文件（${fx.files.join(' 或 ')}）`)
    say(`      → 要么路径不对，要么这个安装物缺文件。跳过不等于通过。`)
    continue
  }
  let bad = 0
  for (const { p, s } of found) {
    const missing = fx.must.filter(re => !re.test(s))
    if (missing.length > 0) {
      bad++
      problems++
      say(`  ✗ ${fx.id}  ← 缺失（应自 ${fx.since}）`)
      say(`      期望匹配: ${missing.map(String).join(' , ')}`)
      say(`      文件: ${p}`)
    }
  }
  if (bad === 0) say(`  ✓ ${fx.id}${found.length > 1 ? `（${found.length} 份副本均通过）` : ''}`)
  else say(`      → 这份安装物比需要的新版本旧，需重建/重装后再谈其他问题`)
}
say()

// ── 3. 源码 vs bundle 是否一致 ──
// B8：本节的 bundle 侧路径写成 `<root>/server/tools/...`，但仓库里 bundle 实际在
// `<root>/dsh/bundle/server/tools/...`。于是从源码根运行时 `pb` 恒不存在，
// `pairChecked` 恒为 0，本节**永远**输出「只检测到一种布局，跳过」——
// 源码改了 bundle 没同步，这个自检也照样全绿。
// 这是"检查项永远跳过"的假绿，比不检查更糟：它让人以为一致性被验过了。
// 修：bundle 根按候选表探测，不再写死单一前缀。
const BUNDLE_ROOTS = [
  join(ROOT, 'server'),                 // 已解包的运行物（bridge 安装形态）
  join(ROOT, 'dsh', 'bundle', 'server'), // 仓库内的 bundle（构建产物）
  join(ROOT, '..', 'server'),
]
const bundleRoot = BUNDLE_ROOTS.find(d => existsSync(join(d, 'tools'))) || null
say('【3】源码与 bundle 一致性（若两者都在）')
if (!bundleRoot) say('  （本机只有源码布局，无 bundle 可比）')
else {
  say(`  bundle 根: ${bundleRoot}`)
  const PAIRS = [
    'tools/tool-code-check/handler.js',
    'tools/tool-verify-pipeline/handler.js',
    'tools/tool-fix-imports/handler.js',
    'tools/tool-code-audit/handler.js',
    'tools/entry-shared.js',
    // B8：watchdog / 内存监控这三处是本轮改动核心，必须一并比对，
    // 否则"源码改了 bundle 没同步"恰好落在检查盲区里。
    'mcp-server.js',
    'watchdog-log.js',
    'health-check.js',
  ]
  let pairChecked = 0
  for (const rel of PAIRS) {
    const pa = join(ROOT, rel), pb = join(bundleRoot, rel)
    const sa = read(pa), sb = read(pb)
    if (!sa) continue // 源码都没有，属【2】的范围
    pairChecked++
    const base = rel.split('/').pop()
    if (sb == null) { say(`  ✗ ${base} bundle 侧缺失——bundle 未重建`); problems++ }
    else if (sa === sb) say(`  ✓ ${base} 一致`)
    else { say(`  ✗ ${base} 不一致——bundle 落后于源码，必须重建`); problems++ }
  }
  // 一条都没比到 = 路径探测错，不能静默算通过
  if (pairChecked === 0) { say('  ✗ 没能比对任何文件——bundle 根探测有误'); problems++ }
}
say()

// ── 4. 需要 DSH 回报的信息（本脚本查不到）──
say('【4】本脚本查不到的（需要现场证据）')
say('  (a) 一次失败 code_check 的完整 evidence.actual：')
say('      · 有 timed_out / timed_out_ms  → 真超时（请求预算截断，不是代码缺陷）')
say('      · 无 timed_out、exit_code≠0    → 进程自己退出非零，是真失败；看 stderr_tail')
say('      （B7 起 killed / timed_out / timed_out_ms 分别透传，failed 时 stderr_tail 必写，')
say('        所以这两种情形已经可以从证据本身分辨，不必再靠猜）')
say('  (b) 进程启动时间 vs 上面 package.json 的 mtime：')
say('      若进程比安装物老，说明它加载的还是旧代码，重启即可。')
say('      注：容器/沙箱里 ps 可能只看到自己，此时这一项无法断言，跳过不影响结论。')
say('  (c) 内存类 FAIL 的现场数值：B8 起 FAIL 行会带 detail（如 901MB > 800MB）。')
say()
say('══════════════════════════════════════════════════════════')
say(problems === 0
  ? ' 结论：未发现"加载了旧安装物"的证据。'
  : ` 结论：发现 ${problems} 处疑似旧版本。先解决安装一致性，再谈其他。`)
say('══════════════════════════════════════════════════════════')
process.exit(problems === 0 ? 0 : 1)
