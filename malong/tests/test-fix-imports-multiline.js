// test-fix-imports-multiline.js — 多行 import 修复（Y001-S2）
// 覆盖：Python 括号多行部分未用（成员行级修剪）/ 全未用（块级整删）/ 全用不误报 /
//       JS 多行部分未用 / JS 全未用块删 / auto_fix 写盘后语法合法 / 反斜杠续行不崩 / 相对导入重建
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}
const { handle } = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-fix-imports', 'handler.js')).href)

const ws = join(os.tmpdir(), 'opencode', 'fiximp-ml-ws')
const data = join(os.tmpdir(), 'opencode', 'fiximp-ml-data')
for (const d of [ws, data]) rmSync(d, { recursive: true, force: true })
mkdirSync(ws, { recursive: true })
mkdirSync(data, { recursive: true })
writeFileSync(join(data, 'code-index.db'), '')
const ctx = {
  codeIndexService: { initWorkspace() {}, getReferences: async () => [], getModuleDependencies: async () => ({}) },
  getWorkspaceDir: () => data,
  langParserService: null,
}

async function run(file, content, opts = {}) {
  writeFileSync(join(ws, file), content)
  return handle({ workspace_dir: ws, file, ...opts }, ctx)
}

// ── ① Python 括号多行部分未用 → 成员行级修剪 ──
{
  const r = await run('m1.py', "from os.path import (\n    join,\n    basename,\n    exists,\n)\n\ndef f(p):\n    return join(p, 'x')\n")
  const uns = r.issues.filter(i => i.type === 'unused_import')
  assert(uns.length === 2, `① Python 部分未用报 2（得 ${uns.length}）`)
  assert(uns.every(i => i.partial === true && !i.skipped), `① partial 无 skipped（得 ${JSON.stringify(uns.map(i => i.partial + '/' + i.skipped))}）`)
  const tr = r.transaction_ready || []
  assert(tr.length === 2 && tr.every(t => t.new_string === ''), `① transaction_ready 2 条行删（得 ${tr.length}）`)
  assert(tr.some(t => t.old_string.includes('basename')) && tr.some(t => t.old_string.includes('exists')), '① 修剪目标为未用成员行')
  assert(!tr.some(t => t.old_string.includes('join')), '① 在用成员 join 行不被删')
}

// ── ② Python 括号多行全部未用 → 块级整删（old_string 覆盖整块） ──
{
  const r = await run('m2.py', "import os\n\nfrom pathlib import (\n    Path,\n    PurePath,\n)\n\ndef f():\n    return 1\n")
  const uns = r.issues.filter(i => i.type === 'unused_import')
  assert(uns.length === 3, `② Python 全未用报 3（os+Path+PurePath）（得 ${uns.length}）`)
  const tr = r.transaction_ready || []
  assert(tr.length === 2, `② transaction_ready 2 条（得 ${tr.length}）`)
  const block = tr.find(t => t.old_string.includes('from pathlib import ('))
  assert(block && block.old_string.split('\n').length >= 4 && block.new_string === '', `② 块级 old_string 覆盖 4+ 行 new_string 空（得 ${block ? block.old_string.split('\n').length : 0} 行）`)
}

// ── ③ JS 多行部分未用 → 成员行级修剪 ──
{
  const r = await run('m3.js', "import {\n  join,\n  basename,\n} from 'node:path'\n\nexport function f(p) {\n  return join(p, 'x')\n}\n")
  const uns = r.issues.filter(i => i.type === 'unused_import')
  assert(uns.length === 1 && uns[0].unused[0] === 'basename' && uns[0].partial === true, `③ JS 部分未用报 basename partial（得 ${JSON.stringify(uns.map(i => i.unused))}）`)
  const tr = r.transaction_ready || []
  assert(tr.length === 1 && tr[0].old_string.trim() === 'basename,' && tr[0].new_string === '', `③ 修剪 basename 行（得 ${JSON.stringify(tr)}）`)
}

// ── ④ JS 多行全部未用 → 块级整删 ──
{
  const r = await run('m4.js', "import {\n  join,\n  basename,\n} from 'node:path'\n\nexport function f() {\n  return 1\n}\n")
  const tr = r.transaction_ready || []
  const block = tr.find(t => t.old_string.startsWith('import {'))
  assert(block && block.old_string.includes('basename') && block.new_string === '', `④ JS 块级整删（得 ${tr.length} 条）`)
}

// ── ⑤ auto_fix 写盘：Python 部分未用修剪后语法仍合法且文件落盘正确 ──
{
  const r = await run('m5.py', "from os.path import (\n    join,\n    basename,\n)\n\ndef f(p):\n    return join(p, 'x')\n", { auto_fix: true })
  assert(r.fixes_applied && r.fixes_applied.imports_trimmed === 1, `⑤ auto_fix 修剪 1（得 ${JSON.stringify(r.fixes_applied)}）`)
  assert(r.issues.filter(i => i.type === 'syntax_guard_blocked').length === 0, '⑤ 无语法护栏拦截')
  const after = readFileSync(join(ws, 'm5.py'), 'utf-8')
  assert(!after.includes('basename') && after.includes('join'), `⑤ 写盘后 basename 已删 join 保留（得 ${JSON.stringify(after.split('\n').slice(0, 6))}）`)
  const line4 = after.split('\n')[3]
  assert(/^\s*\)\s*$/.test(line4), `⑤ 块闭合行保留且合法（得 ${JSON.stringify(line4)}）`)
}

// ── ⑥ Python 括号多行全用不误报 ──
{
  const r = await run('m6.py', "from os.path import (\n    join,\n    basename,\n)\n\ndef f(p):\n    return join(basename(p), 'x')\n")
  const uns = r.issues.filter(i => i.type === 'unused_import')
  assert(uns.length === 0, `⑥ 全用不误报（得 ${uns.length}）`)
  assert(r.issues.filter(i => i.type === 'undefined_symbol').length === 0, '⑥ 无 undefined 误报')
}

// ── ⑦ 反斜杠续行只报不删（不产生破坏性 transaction_ready） ──
{
  const r = await run('m7.py', "from os.path import join, \\\n    basename\n\ndef f(p):\n    return join(p, 'x')\n")
  const tr = r.transaction_ready || []
  assert(!tr.some(t => t.old_string.includes('from os.path import')), `⑦ 反斜杠续行无破坏性删除补丁（得 ${JSON.stringify(tr)}）`)
}

// ── ⑧ Python 多行相对导入重建（.utils） ──
{
  writeFileSync(join(ws, 'utilmod.py'), 'X = 1\n')
  const r = await run('m8.py', "from .utils import (\n    join,\n    basename,\n)\n\ndef f(p):\n    return join(p, 'x')\n")
  const rel = r.issues.filter(i => i.type === 'relative_import')
  assert(rel.length === 1 && rel[0].relative === '.utils', `⑧ 多行相对导入重建（得 ${JSON.stringify(rel.map(i => i.relative))}）`)
}

// ── ⑨ 反斜杠续行全用：不误报 + 无 undefined_symbol（债务5：旧实现续行成员 undefined 误报） ──
{
  const r = await run('m9.py', "from os.path import join, \\\n    basename\n\ndef f(p):\n    return join(basename(p), 'x')\n")
  const uns = r.issues.filter(i => i.type === 'unused_import')
  assert(uns.length === 0, `⑨ 续行全用不误报（得 ${uns.length}）`)
  assert(r.issues.filter(i => i.type === 'undefined_symbol').length === 0, `⑨ 无 undefined 误报（续行成员已识别）`)
}

// ── ⑩ 续行部分未用 → skipped（行级修剪会破坏续行链，不产生破坏性补丁） ──
{
  const r = await run('m10.py', "from os.path import join, \\\n    basename\n\ndef f(p):\n    return join(p, 'x')\n")
  const uns = r.issues.filter(i => i.type === 'unused_import')
  assert(uns.length === 1 && uns[0].skipped, `⑩ 续行部分未用 → skipped（得 ${JSON.stringify(uns.map(i => i.skipped))}）`)
  const tr = r.transaction_ready || []
  assert(!tr.some(t => t.old_string.includes('from os.path import')), `⑩ 无破坏性删除补丁（得 ${JSON.stringify(tr)}）`)
}

// ── ⑪ 续行全部未用 → 块级整删 ──
{
  const r = await run('m11.py', "from os.path import join, \\\n    basename\n\ndef f():\n    return 1\n")
  const tr = r.transaction_ready || []
  const block = tr.find(t => t.old_string.includes('from os.path import'))
  assert(block && block.old_string.split('\n').length >= 2 && block.new_string === '', `⑪ 续行块整删（得 ${tr.length} 条，${block ? block.old_string.split('\n').length : 0} 行）`)
}

// ── ⑫ r10e：Python 局部定义收集——多目标赋值/元组解包 for/多 with as/元组 except as 不再误报 undefined ──
{
  const pyCases = {
    'p1.py': "def f():\n    def get_pair():\n        return 1, 2\n    st, en = get_pair()\n    return st + en\n",
    'p2.py': "def g2(xs, ys):\n    for st, en in zip(xs, ys):\n        print(st, en)\n",
    'p3.py': "def h():\n    with open('a') as f1, open('b') as f2:\n        pass\n",
    'p4.py': "def k():\n    try:\n        pass\n    except (ValueError, TypeError) as e:\n        print(e)\n",
  }
  for (const [file, code] of Object.entries(pyCases)) {
    const r = await run(file, code)
    const uns = r.issues.filter(i => i.type === 'undefined_symbol')
    assert(uns.length === 0, `⑫ ${file} 局部变量零误报（得 ${JSON.stringify(uns.map(i => i.symbol))}）`)
  }
}

// ── ⑬ r10e：findCandidates 只认顶层定义——局部变量巧合同名不产生 `from x import v` 荒谬建议 ──
{
  const ctx2 = {
    ...ctx,
    codeIndexService: {
      initWorkspace() {},
      // 模拟：v 在别的文件只是局部变量（findDefinitions 顶层查询返回空）
      findDefinitions: async () => [],
      getModuleDependencies: async () => ({}),
    },
  }
  const r = await handle({ workspace_dir: ws, file: 'p1.py', auto_fix: true }, ctx2)
  const uns = r.issues.filter(i => i.type === 'undefined_symbol')
  assert(uns.length === 0, `⑬ 局部变量无 undefined 无荒谬 import（得 ${JSON.stringify(uns)}）`)
}

// ── ⑭ r10e：状态机剥除 + 新形态回归（0FTYcloud 251 脚本实测驱动：686→0 误报）──
{
  const pyCases = {
    'q1.py': "import os\nk = v = ''\nos.environ.setdefault(k.strip(), v.strip().strip('\"').strip(\"'\"))\nBASE_URL = os.getenv(\"DEEPSEEK_BASE_URL\", \"https://opencode.ai/zen/go/v1\")\n",
    'q2.py': "best_state = {k: v.detach().clone() for k, v in\n    pairs}\n",
    'q3.py': "from src.engines.swebench.run_one import (  # noqa: E402\n    ensure_worktree, build_code_fag)\n\ndef f():\n    return ensure_worktree()\n",
    'q4.py': "d_map = {0: \"forward\", 1: \"backward\"}\nfor d_label in [\"forward\", \"backward\"]:\n    k = f\"d{['forward','backward'].index(d_label)}_ep\"\n",
    'q5.py': "def f():\n    return f\"run_mechanism -> {{expansions, recall@50, precision@50}}\"\n",
    'q6.py': "def f(a, b):\n    return a + b\n\ndef g():\n    return f(1, 2)\n",
    'q7.py': "def h(*a, **kw):\n    print(*a, **kw, flush=True)\n",
  }
  for (const [file, code] of Object.entries(pyCases)) {
    const r = await run(file, code)
    const uns = r.issues.filter(i => i.type === 'undefined_symbol')
    // q2 的 pairs 是片段里真 undefined（未定义/未导入）——只断言局部变量零误报
    const okNames = uns.map(i => i.symbol).filter(s => s !== 'pairs')
    assert(okNames.length === 0, `⑭ ${file} 零误报（得 ${JSON.stringify(okNames)}）`)
  }
}

// ⑮ R8: .go 显式不支持（防 undefined_symbols 全量垃圾）
{
  const goSrc = ['package main', '', 'import "fmt"', '', 'func main() {', '    fmt.Println(getValue())', '}', ''].join('\n')
  const r = await run('thing.go', goSrc)
  assert(r.supported === false, `⑮ .go 返回 supported:false`)
  assert(r.issues.length === 0, `⑮ .go issues 为空（无垃圾 undefined_symbol，得 ${r.issues.length}）`)
  assert(r.note && r.note.includes('not implemented'), `⑮ .go note 显式标注`)
}
// ⑯ R8: .java（detectLanguage→unknown）同样显式不支持
{
  const javaSrc = 'public class App { public static void main(String[] a) { System.out.println(foo()); }\n'
  const r = await run('App.java', javaSrc)
  assert(r.supported === false && r.issues.length === 0, `⑯ .java 返回 supported:false 且 issues 为空`)
}
// ⑰ R8: 正常语言不受影响
{
  const pySrc = ['import os', '', 'def f():', "    return os.path.join('a', 'b')", ''].join('\n')
  const r = await run('ok.py', pySrc)
  assert(r.supported !== false, `⑰ .py 正常分析（supported=${r.supported}）`)
}

for (const d of [ws, data]) rmSync(d, { recursive: true, force: true })

console.log(`== test-fix-imports-multiline: ${pass} passed, ${fail} failed ==`)
if (fail > 0) process.exit(1)
