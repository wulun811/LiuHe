// test-fix-imports-proposal.js — 提案可用性（B4：提案必须能被直接 apply）
//
// 背景：DSH 实录（2026-11-02）报告 maintain 的 import 提案不可用，三处同时坏：
//   ① specifier 用 Python 点号路径（'a.b.c'）给 JS/TS 文件 → Node 当裸包名 → ERR_MODULE_NOT_FOUND
//   ② 插入位置越过块注释/既有 import 块，插到 shebang 后 → 第二个 import 语句
//   ③ 文件头有块注释时 findImportInsertLine 认为"代码已开始"，返回 1
//
// 本测试的判据是单一的：**提案应用后，node --check 必须能过，且不产生重复导入**。
// 这不是风格问题——照着提案 apply 会坏文件。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import { execFile } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}
const { handle } = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-fix-imports', 'handler.js')).href)

const ws = join(os.tmpdir(), 'opencode', 'fiximp-prop-ws')
const data = join(os.tmpdir(), 'opencode', 'fiximp-prop-data')
for (const d of [ws, data]) rmSync(d, { recursive: true, force: true })
mkdirSync(ws, { recursive: true })
mkdirSync(data, { recursive: true })
writeFileSync(join(data, 'code-index.db'), '')

// 定义所在文件用 .py 后缀，复现 DSH 现场（定义在 Python 文件、使用方是 ESM）
function ctxWithDefs(defPath) {
  return {
    codeIndexService: {
      initWorkspace() {},
      findDefinitions: async () => [{ path: defPath, start_line: 1 }],
      getReferences: async () => [],
      getModuleDependencies: async () => ({}),
    },
    getWorkspaceDir: () => data,
    langParserService: null,
  }
}

async function run(ctx, file, content) {
  writeFileSync(join(ws, file), content)
  return handle({ workspace_dir: ws, file }, ctx)
}

function nodeCheck(file) {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--check', join(ws, file)], (err, _o, stderr) => {
      resolve({ ok: !err, detail: (stderr || '').split('\n').slice(0, 3).join(' ').trim() })
    })
  })
}

// 把提案应用到原文（模拟 agent 照着 transaction_ready 做 edit）
function applyProposal(content, p) {
  if (!content.includes(p.old_string)) return { applied: false, reason: 'old_string 不在原文中' }
  return { applied: true, text: content.split(p.old_string).join(p.new_string) }
}

// ── ① JS specifier：不得是点号路径（Python 模块名）──
{
  const ctx = ctxWithDefs('kernel/scripts/闸门判据.mjs')
  const src = "#!/usr/bin/env node\nexport function f() {\n  return missingHelper()\n}\n"
  const r = await run(ctx, 'use-a.mjs', src)
  const props = r.transaction_ready || []
  assert(props.length >= 1, `① 应产出至少 1 条提案（得 ${props.length}）`)
  const badDot = props.filter(p => /from\s+'[^']*\w+\.\w+[^']*'/.test(p.new_string))
  assert(badDot.length === 0, `① JS/TS 提案不得给点号模块名（得 ${JSON.stringify(badDot.map(p => (p.new_string.match(/from '[^']*'/) || [])[0]))}）`)
  // Windows 复核（2026-11-06）：path.relative 产反斜杠 → `./kernel\scripts\x.mjs`：
  // `\u` 触发语法护栏被拦（假红），`\s` 被 JS 当转义吞成 `s` 语法合法但指向错文件（假绿）。
  const backslashSpec = props.filter(p => /from\s+['"][^'"]*\\[^'"]*['"]/.test(p.new_string))
  assert(backslashSpec.length === 0, `① import specifier 不得含反斜杠（得 ${JSON.stringify(backslashSpec.map(p => (p.new_string.match(/from\s+['"][^'"]*['"]/) || [])[0]))}）`)
}

// ── ② 文件头有块注释 + 既有 import 块：提案不得插到它们之前、也不得插进注释里 ──
{
  const ctx = ctxWithDefs('kernel/scripts/闸门判据.mjs')
  const src = [
    '#!/usr/bin/env node',
    '/**',
    ' * 文档命令闸门',
    ' */',
    "import { readFileSync } from 'node:fs'",
    '',
    'export function g() {',
    '  return readFileSync("x", "utf8") + missingHelper()',
    '}',
    '',
  ].join('\n')
  const r = await run(ctx, 'use-b.mjs', src)
  const props = r.transaction_ready || []
  const applied = props.map(p => applyProposal(src, p)).filter(x => x.applied)
  assert(applied.length >= 1, `② 提案应能应用到原文（得 ${applied.length}）`)
  for (const a of applied) {
    const lines = a.text.split('\n')
    assert(lines[0].startsWith('#!'), '② shebang 仍在首行')
    // 关键①：新 import 既不得在块注释之前，也不得落在注释内部（后者语法合法但等于没加）
    let inBlock = false
    let commentStart = -1, commentEnd = -1
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim()
      if (!inBlock && t.startsWith('/*')) { inBlock = true; if (commentStart < 0) commentStart = i }
      if (inBlock && t.includes('*/')) { inBlock = false; commentEnd = i }
    }
    const importIdxs = lines.map((l, i) => (l.trim().startsWith('import ') ? i : -1)).filter(i => i >= 0)
    assert(commentStart >= 0 && commentEnd > commentStart, '② 夹具应含完整块注释')
    assert(!importIdxs.some(i => i > commentStart && i < commentEnd),
      `② import 不得落在块注释内部（注释 ${commentStart}-${commentEnd}，import 行 ${JSON.stringify(importIdxs)}）`)
    assert(importIdxs.every(i => i > commentEnd),
      `② import 必须在注释块之后（注释结束 ${commentEnd}，import 行 ${JSON.stringify(importIdxs)}）`)
    // 关键②：apply 后必须语法合法
    writeFileSync(join(ws, 'check-b.mjs'), a.text)
    const chk = await nodeCheck('check-b.mjs')
    assert(chk.ok, `② 提案应用后 node --check 必须过（${chk.detail}）`)
    // 关键③：不得引入同名重复导入（node --check 抓不到，必须显式断言）
    const names = lines.filter(l => l.trim().startsWith('import '))
      .flatMap(l => (l.match(/\{([^}]*)\}/) || [, ''])[1].split(',').map(s => s.trim()).filter(Boolean))
    assert(new Set(names).size === names.length, `② 不得引入重复导入（得 ${JSON.stringify(names)}）`)
  }
}

// ── ③ 无既有 import 的普通文件：插入位置在第一条语句之前 ──
{
  const ctx = ctxWithDefs('lib/util.mjs')
  const src = 'export function h() {\n  return missingHelper()\n}\n'
  const r = await run(ctx, 'use-c.mjs', src)
  const props = r.transaction_ready || []
  const applied = props.map(p => applyProposal(src, p)).filter(x => x.applied)
  assert(applied.length >= 1, `③ 提案应能应用（得 ${applied.length}）`)
  if (applied.length) {
    writeFileSync(join(ws, 'check-c.mjs'), applied[0].text)
    const chk = await nodeCheck('check-c.mjs')
    assert(chk.ok, `③ 提案应用后 node --check 必须过（${chk.detail}）`)
  }
}

// ── ④ 护栏必须真的模拟提案：坏提案不得被当成"已过语法验证"放行 ──
//    漏洞史：护栏只模拟 new_string 以 'import '/'from ' 开头的条目，
//    而整文件头替换型提案的 new_string 以 '#!/usr/bin/env node' 开头 → 护栏从未生效。
{
  const ctx = ctxWithDefs('kernel/scripts/闸门判据.mjs')
  const src = "#!/usr/bin/env node\nexport function k() {\n  return missingHelper()\n}\n"
  const r = await run(ctx, 'use-d.mjs', src)
  const blocked = (r.issues || []).some(i => i.type === 'syntax_guard_blocked')
  const props = r.transaction_ready || []
  // 若提案本身合法，不该误报 blocked；若提案会坏文件，必须 blocked 且不产出提案
  if (props.length) {
    const a = applyProposal(src, props[0])
    writeFileSync(join(ws, 'check-d.mjs'), a.text)
    const chk = await nodeCheck('check-d.mjs')
    assert(chk.ok || blocked, `④ 坏提案必须被 syntax_guard 拦下（node --check: ${chk.detail}；blocked=${blocked}）`)
  }
}

// ── ⑦ verifySyntax 必须真的验证 ESM 语法（M6 覆盖）──
//    实测：`node --check x.js` 对含 ESM import 且语法错的文件返回 **exit=0**（.js 按 CJS 解析，
//    import 不被当作语法错），旧实现固定写 .js → 护栏对 ESM 提案全程失效。
{
  const mod = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-fix-imports', 'handler.js')).href)
  const vs = mod.__test?.verifySyntax
  assert(typeof vs === 'function', '⑦ verifySyntax 必须可测（经 __test 导出）')
  if (typeof vs === 'function') {
    const broken = "import { a } from './x.mjs'\nexport function f() {\n  return a(\n}\n"
    const ok = "import { a } from './x.mjs'\nexport function f() {\n  return a(1)\n}\n"
    const rBadMjs = await vs(broken, 'javascript', 'x.mjs')
    const rOkMjs = await vs(ok, 'javascript', 'x.mjs')
    assert(rBadMjs.ok === false, `⑦ .mjs 坏语法必须判坏（得 ok=${rBadMjs.ok}）`)
    assert(rOkMjs.ok === true, `⑦ .mjs 好语法必须判好（得 ok=${rOkMjs.ok}, ${rOkMjs.detail}）`)
    const rBadJs = await vs(broken, 'javascript', 'x.js')
    const rOkJs = await vs(ok, 'javascript', 'x.js')
    assert(rBadJs.ok === false, `⑦ .js 坏语法必须判坏（旧实现恒 true——这正是 DSH 漏网根因）`)
    assert(rOkJs.ok === true, `⑦ .js 好语法必须判好（得 ok=${rOkJs.ok}, ${rOkJs.detail}）`)
    // Python 侧不得回归
    const rPyBad = await vs('def f(:\n  pass\n', 'python', 'x.py')
    assert(rPyBad.ok === false, '⑦ .py 坏语法必须判坏')
  }
}

//    只看 removals 的护栏会漏掉"插入的 import 本身语法非法"（如被插进字符串/注释内）。
//    构造：文件头是普通注释，提案把 import 插到首行前，其中一条候选 specifier 含引号 → 语法坏。
{
  const ctx = ctxWithDefs('kernel/scripts/闸门判据.mjs')
  // 语法已坏的文件：护栏不应因为"只看 removals（空）"而放行整个提案
  const src = "#!/usr/bin/env node\nexport function p() {\n  return missingHelper(\n}\n"
  const r = await run(ctx, 'use-g.mjs', src)
  const blocked = (r.issues || []).some(i => i.type === 'syntax_guard_blocked')
  const props = r.transaction_ready || []
  for (const p of props) {
    const a = applyProposal(src, p)
    if (!a.applied) continue
    writeFileSync(join(ws, 'check-g.mjs'), a.text)
    const chk = await nodeCheck('check-g.mjs')
    assert(chk.ok || blocked, `⑥ 坏语法文件上的提案必须被拦（node --check: ${chk.detail}；blocked=${blocked}）`)
  }
}

// ── ⑤ 重复导入判据必须真的能识别（直击 findDuplicateImport）──
//    为什么必须单测它：node --check 对**同名重复 import 返回 exit=0**（实测），
//    而"插到既有 import 块之前"正是 DSH 现场的反例。若判据本身失效，
//    端到端夹具会被别的分支（语法护栏）先拦下，测不出判据是否还在——即假测试。
{
  const mod = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-fix-imports', 'handler.js')).href)
  const fn = mod.findDuplicateImport || mod.__test?.findDuplicateImport
  assert(typeof fn === 'function', '⑤ findDuplicateImport 必须可测（经 __test 导出）')
  if (typeof fn === 'function') {
    assert(fn("import { a } from './x.mjs'\nimport { a } from './y.mjs'\n") === 'a', '⑤ 同名不同源必须识别')
    assert(fn("import { a } from './x.mjs'\nimport { a } from './x.mjs'\n") === 'a', '⑤ 完全重复行必须识别')
    assert(fn("import { a } from './x.mjs'\nimport { b } from './y.mjs'\n") === null, '⑤ 不同名不得误报')
    assert(fn("import {\n  a,\n} from './x.mjs'\n") === null, '⑤ 单条多行 import 不得误报')
    assert(fn("const a = 1\nconst a = 2\n") === null, '⑤ 非 import 行不得误报')
  }
}

// ── ⑧ 跨语言目标不得提提案（只可作为线索）──
//    DSH 现场：.mjs 里用了定义在 .py 里的符号，提案会生成
//    `import { f } from './闸门判据.py'`——裸包名没了，但这条 import 依然不可能执行。
//    正确行为：不给 transaction_ready，改放 leads 并说明原因。
{
  const ctx = ctxWithDefs('kernel/scripts/闸门判据.py')
  const src = "#!/usr/bin/env node\nexport function x() {\n  return missingHelper()\n}\n"
  const r = await run(ctx, 'use-h.mjs', src)
  const props = r.transaction_ready || []
  const bad = props.filter(p => /from\s+'[^']*\.py'/.test(p.new_string))
  assert(bad.length === 0, `⑧ 不得给出 import *.py 的提案（得 ${JSON.stringify(bad.map(p => (p.new_string.match(/from '[^']*'/) || [])[0]))}）`)
  // 必须留下线索，不能静默丢弃
  const leads = r.leads || []
  assert(leads.some(l => l.kind === 'cross_language_import' && l.symbol === 'missingHelper'),
    `⑧ 跨语言目标必须作为线索保留（得 ${JSON.stringify(leads.map(l => l.kind))}）`)
  assert(leads.every(l => l.verdict === 'lead'), '⑧ leads 必须显式标注 verdict=lead（不是结论）')
}

// ── ⑨ 同语言目标的提案必须带验证结论 ──
//    "要么让它能被验证，要么别让它以结论形态出现"：出去的东西要自证。
{
  const ctx = ctxWithDefs('lib/util.mjs')
  const src = 'export function h() {\n  return missingHelper()\n}\n'
  const r = await run(ctx, 'use-i.mjs', src)
  const props = r.transaction_ready || []
  assert(props.length >= 1, `⑨ 同语言应给出提案（得 ${props.length}）`)
  assert(props.every(p => p.verification && p.verification.ok === true),
    `⑨ 每条提案必须带 verification.ok=true（得 ${JSON.stringify(props.map(p => p.verification))}）`)
  assert(props.every(p => p.verdict === 'verified'), '⑨ 通过验证的提案 verdict=verified')
}

rmSync(data, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
