// test-h07-capability-hints.js — H07（0.5.14）情境能力提示 + 承载措辞
// 背景：低频原能力存在但工作时容易想不到去查（011–013/位置表）；无快捷位不应看起来像不可用。
// 本测试锁定：① 五类意图（组合结构/依赖/变更事实/重命名/规格文档）各给 ≤2 条提示，名称在 44 目录中；
// ② 提示带可执行描述动作（code_query mode=capability）与副作用面（写/Git/命令可见）；③ 条件不足不推；
// ④ 目录把 not_carried/no_landing 译为「无快捷位，完整出口可用」（availability=no_shortcut_entry + wiring_note）。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  FAIL:', msg) } }
const imp = (p) => import(pathToFileURL(p).href)

const cat = await imp(join(__dirname, '..', 'workflow', 'capability-catalog.js'))
const q = await imp(join(__dirname, '..', 'tools', 'tool-code-query', 'handler.js'))

// ── ① 五类意图 → 提示正确、可执行、副作用可见 ──
const cases = [
  { text: '帮我做组合结构检查 confirm composition', name: 'inspect' },
  { text: 'check the dependency graph for this module', name: 'dep_graph' },
  { text: 'what changed after the edit? diff facts please', name: 'diff_facts' },
  { text: 'rename this symbol to something better', name: 'rename_symbol' },
  { text: 'generate the API doc / specification for this module', name: 'spec_gen' },
]
for (const c of cases) {
  const hints = cat.intentHints(c.text)
  assert(hints.length >= 1 && hints.length <= 2, `① ${c.name}: 提示数量 1..2（得 ${hints.length}）`)
  const h = hints.find(x => x.name === c.name)
  assert(!!h, `① ${c.name}: 命中对应提示（得 ${JSON.stringify(hints.map(x => x.name))}）`)
  assert(h && h.describe?.tool === 'code_query' && h.describe?.args?.mode === 'capability' && h.describe?.args?.name === c.name, `① ${c.name}: 描述动作可执行`)
  assert(h && Array.isArray(h.effects) && h.effects.length > 0, `① ${c.name}: 副作用面取自目录（得 ${JSON.stringify(h?.effects)}）`)
}
assert(cat.intentHints('rename the function').find(x => x.name === 'rename_symbol')?.effects.includes('workspace_write'), '① rename_symbol 副作用含 workspace_write（写可见）')

// ── ② 条件不足不推；最多 2 条 ──
{
  assert(cat.intentHints('fix a small typo').length === 0, '② 无匹配意图不给提示')
  assert(cat.intentHints('rename after dependency graph inspection').length <= 2, '② 最多 2 条')
}

// ── ③ 目录承载措辞：无快捷位 ≠ 不可用 ──
{
  const caps = cat.listCapabilities({ limit: 200 })
  const noShortcut = caps.items.filter(i => i.availability === 'no_shortcut_entry')
  assert(noShortcut.length > 0, '③ 存在无快捷位条目（得 ' + noShortcut.length + '）')
  assert(noShortcut.every(i => i.outlet === 'invoke_capability' && /FULLY available via invoke_capability/.test(i.wiring_note || '')), '③ 无快捷位条目给出「完整出口可用」说明')
  assert(/not_carried\/no_landing = NO shortcut entry/.test(caps.note), '③ 目录 note 解释承载标签')
  const carried = caps.items.find(i => i.wiring === 'carried')
  assert(!carried || carried.availability === 'shortcut_entry', '③ 快捷条目 availability=shortcut_entry')
}

// ── ④ code_query 集成：query 意图 → 顶层 capability_hints ──
{
  const r = await q.handle({ workspace_dir: process.cwd(), mode: 'capabilities', query: 'dependency graph' }, {})
  assert(r.ok === true, '④ capabilities 调用成功（得 ' + JSON.stringify(r.error) + '）')
  assert(Array.isArray(r.capability_hints) && r.capability_hints.some(h => h.name === 'dep_graph'), '④ 顶层 capability_hints 命中 dep_graph（得 ' + JSON.stringify(r.capability_hints?.map(x => x.name)) + '）')
  const r2 = await q.handle({ workspace_dir: process.cwd(), mode: 'capabilities', query: 'zzz-nothing' }, {})
  assert(!r2.capability_hints, '④ 普通/无意图查询不给无关推荐')
}

// ── ⑤ F4（0.5.14 Windows 复核）：中文意图同样命中（原实现把中文包在 ASCII 边界 \b...\b 里，五组全零）──
const zhCases = [
  { text: '请做整体结构检查', name: 'inspect' },
  { text: '请查看模块依赖关系', name: 'dep_graph' },
  { text: '请核对改动事实', name: 'diff_facts' },
  { text: '请重命名这个函数', name: 'rename_symbol' },
  { text: '请生成接口文档', name: 'spec_gen' },
]
for (const c of zhCases) {
  const hints = cat.intentHints(c.text, { workspace_dir: process.cwd() })
  assert(hints.length >= 1 && hints.length <= 2, `⑤ ${c.name}: 中文提示数量 1..2（得 ${hints.length}）`)
  const h = hints.find(x => x.name === c.name)
  assert(!!h, `⑤ ${c.name}: 中文命中对应提示（得 ${JSON.stringify(hints.map(x => x.name))}）`)
  assert(h && h.describe?.args?.workspace_dir === process.cwd(), `⑤ ${c.name}: describe 自带 workspace_dir（得 ${JSON.stringify(h?.describe?.args)}）`)
}
assert(cat.intentHints('今天天气不错').length === 0, '⑤ 无关中文不推提示')

// ── ⑥ 提示动作原样可执行（不补参直接调）──
for (const c of [...cases.map(x => ({ text: x.text, name: x.name })), ...zhCases]) {
  const h = cat.intentHints(c.text, { workspace_dir: process.cwd() }).find(x => x.name === c.name)
  assert(!!h, `⑥ ${c.name}: 有提示可取（得 ${c.text}）`)
  if (!h) continue
  const r = await q.handle(h.describe.args, {})
  assert(r.ok === true, `⑥ ${c.name}: describe 动作原样调用成功（得 ${JSON.stringify({ ok: r.ok, e: r.error, m: r.message })}）`)
  assert(r.result && r.result.name === c.name, `⑥ ${c.name}: 返回对应能力描述（得 ${JSON.stringify(r.result?.name)}）`)
}
assert(cat.intentHints('请重命名这个函数').find(x => x.name === 'rename_symbol')?.effects.includes('workspace_write'), '⑥ 中文重命名意图仍带写副作用面（不自动执行）')

console.log('\n=== test-h07-capability-hints: ' + pass + ' passed, ' + fail + ' failed ===')
process.exit(fail > 0 ? 1 : 0)
