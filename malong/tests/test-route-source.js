// test-route-source.js — C 档：路由「不做推断就不装懂」
//
// 背景（2026-10-30 用户决策）：中文意图识别不可靠（换个说法 0/3 命中），
// 但删掉中文支持等于让所有中文查询恒 0 命中——那只是把错误变安静。
// 用户选择 C 档：**不砍能力，砍承诺**。
//
// 具体合同（本文件锁死）：
//   ① 显式 route            → task.route_source='explicit'，不加任何"猜"的说明
//   ② 关键词命中英文/中文   → 'inferred' + route_evidence 指出**命中了哪个词**（可核查）
//   ③ 一个词都没命中        → 'default' + 明确说"没识别出动作"，并给出纠正路径
//   ④ 非 ASCII 目标的 default → 额外说明"中文/非 ASCII 目标常匹配不上关键词"，
//                              不得让使用者以为工具读懂了
//   ⑤ 说明文字必须可操作（给 route 参数名 / switch_route），不能只说"我不确定"
//   ⑥ inferRoute() 字符串 API 保持兼容（旧调用方不受影响）
//
// 为什么要 route_source 而不是继续猜：route 决定真实行为——
// route=review 才触发 audit 完成契约；route=maintain/system 决定结构展开。
// 猜错且不标注，就是「静默的错」；标注后至少可以纠正。

import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const imp = (p) => import(pathToFileURL(join(__dirname, '..', p)).href)
let pass = 0, fail = 0
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  FAIL:', msg) } }

const TMP = join(os.tmpdir(), 'opencode', 'route-source-test')
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
mkdirSync(join(TMP, 'src'), { recursive: true })
process.env.MALONG_STATE_DIR = join(TMP, 'state')
writeFileSync(join(TMP, 'src', 'greet.js'), 'export function greet(n) { return `hi ${n}` }\n')

const shared = await imp('tools/entry-shared.js')
const taskMod = await imp('tools/tool-code-task/handler.js')
const controlMod = await imp('tools/tool-code-control/handler.js')
const statusMod = await imp('tools/tool-code-status/handler.js')
const store = await imp('tools/entry-store.js')
// ⑦/⑧ 用：删快照逼事件重放，验证纠正结果能被重放出来
const snapPath = (id) => join(process.env.MALONG_STATE_DIR, 'entry-tasks', store.wsHash(TMP), `${id}.json`)

// 最小索引服务：本文件只验 route 元信息，不验检索质量
const ctx = {
  getWorkspaceDir: (w) => w,
  codeIndexService: {
    async initWorkspace() {},
    async indexBatch() { return ['src/greet.js'] },
    async findDefinitions() { return [] },
    async searchSymbols() { return [{ name: 'greet', type: 'function', start_line: 1, end_line: 1, file: 'src/greet.js' }] },
    findSymbolsInFile() { return [] },
    async getFileOutline() { return { outline: [{ name: 'greet', type: 'function', line: 1, end_line: 1 }] } },
    async getSymbolsAtLine() { return [] },
    getSymbolByStableId() { return null },
    getFileByPath() { return { path: 'src/greet.js', index_state: 'fresh' } },
  },
}
const call = (args) => taskMod.handle({ workspace_dir: TMP, ...args }, ctx)

// ── ① 显式 route：不得被标注成"猜的" ──
{
  const r = await call({ goal: '随便看看', route: 'review' })
  assert(r.ok === true, '① 显式 route 成功')
  assert(r.task?.route === 'review', `① route 采用显式值（得 ${r.task?.route}）`)
  assert(r.task?.route_source === 'explicit', `① route_source='explicit'（得 ${JSON.stringify(r.task?.route_source)}）`)
  assert(!r.task?.route_evidence, `① 显式 route 不得携带"命中词"证据（得 ${JSON.stringify(r.task?.route_evidence)}）`)
  assert(!r.observation?.route_note, `① 显式 route 不得加推测说明（得 ${JSON.stringify(r.observation?.route_note)}）`)
}

// ── ② 关键词命中：标注 inferred + 指出命中词（可核查）──
{
  const goal = '实现一个导出 CSV 的功能'
  const r = await call({ goal })
  assert(r.task?.route === 'change', `② 中文改动词 → change（得 ${r.task?.route}）`)
  assert(r.task?.route_source === 'inferred', `② route_source='inferred'（得 ${JSON.stringify(r.task?.route_source)}）`)
  assert(typeof r.task?.route_evidence === 'string' && r.task.route_evidence.length > 0, `② 必须指出命中的词（得 ${JSON.stringify(r.task?.route_evidence)}）`)
  assert(goal.includes(String(r.task?.route_evidence)), `② 命中词必须确实出现在 goal 里（证据 ${JSON.stringify(r.task?.route_evidence)} 不在 goal 中）`)
  assert(typeof r.observation?.route_note === 'string' && /inferred|推断|命中/i.test(r.observation.route_note), `② 有说明告知这是推断（得 ${JSON.stringify(r.observation?.route_note)}）`)
  assert(/route/.test(r.observation.route_note), `② 说明里要给出纠正手段（route 参数）（得 ${r.observation.route_note}）`)

  const en = await call({ goal: 'add an export flag to the CLI' })
  assert(en.task?.route === 'change' && en.task?.route_source === 'inferred', `② 英文同样标 inferred（得 ${en.task?.route} / ${en.task?.route_source}）`)
  assert(/add/i.test(String(en.task?.route_evidence)), `② 英文命中词为 add（得 ${JSON.stringify(en.task?.route_evidence)}）`)
}

// ── ③ 一个词都没命中：标 default，并明确说没识别出动作 ──
{
  const r = await call({ goal: 'hmm take a look at this thing' })
  assert(r.task?.route === 'understand', `③ 无关键词兜底 understand（得 ${r.task?.route}）`)
  assert(r.task?.route_source === 'default', `③ route_source='default'（得 ${JSON.stringify(r.task?.route_source)}）`)
  assert(!r.task?.route_evidence, `③ default 不得编造命中词（得 ${JSON.stringify(r.task?.route_evidence)}）`)
  const note = String(r.observation?.route_note || '')
  assert(/not recognized|no action|未识别|没有识别|没识别/i.test(note), `③ 必须明说没识别出动作（得 ${JSON.stringify(note)}）`)
  assert(/route/.test(note), `③ 必须给出纠正手段：route 参数（得 ${JSON.stringify(note)}）`)
  assert(/switch_route/.test(note), `③ 必须给出运行中纠正手段：switch_route（得 ${JSON.stringify(note)}）`)
}

// ── ④ 非 ASCII 目标的 default：必须承认"中文常匹配不上"，不得装作读懂了 ──
{
  const goal = '看看这个文件里面都有什么'
  const r = await call({ goal })
  assert(r.task?.route_source === 'default', `④ 纯中文无动词 → default（得 ${JSON.stringify(r.task?.route_source)}）`)
  const note = String(r.observation?.route_note || '')
  assert(/non-ASCII|Chinese|中文|非 ASCII/i.test(note), `④ 非 ASCII 目标必须点明语言层面的限制（得 ${JSON.stringify(note)}）`)
  assert(r.observation?.route_source === 'default', `④ observation 也要暴露 route_source（得 ${JSON.stringify(r.observation?.route_source)}）`)
}

// ── ⑤ 说明必须可操作：列出可选 route 取值，而不是只说"我不确定" ──
{
  const r = await call({ goal: '看看这个文件里面都有什么' })
  const note = String(r.observation?.route_note || '')
  const routes = ['understand', 'change', 'diagnose', 'review', 'maintain', 'document', 'isolate', 'system']
  const listed = routes.filter(x => note.includes(x))
  assert(listed.length >= 3, `⑤ 说明应列出可选 route（得 ${listed.length} 个：${listed.join(',')}）`)
}

// ── ⑥ 兼容：inferRoute 仍返回字符串 ──
{
  assert(typeof shared.inferRoute('实现 CSV 导出') === 'string', '⑥ inferRoute 仍返回字符串（旧调用方兼容）')
  assert(shared.inferRoute('实现 CSV 导出') === 'change', '⑥ inferRoute 结果不变')
  assert(typeof shared.inferRouteDetailed('实现 CSV 导出') === 'object', '⑥ 新增 inferRouteDetailed 提供细节')
}

// ── ⑦ 运行中改了 route：来源必须变成 explicit，旧「命中词」必须清掉 ──
// 否则会出现最坏的一种谎言：用户已经手动纠正过 route，任务里却还写着
// 「route 是从 goal 里某个词推断出来的」，下一轮谁都不知道该信哪个。
{
  const created = await call({ goal: '实现一个导出 CSV 的功能' })
  const id = created.task.task_id
  assert(created.task.route_source === 'inferred', `⑦ 前置：创建时 inferred（得 ${JSON.stringify(created.task.route_source)}）`)
  assert(created.task.route_evidence === '实现', `⑦ 前置：证据为「实现」（得 ${JSON.stringify(created.task.route_evidence)}）`)

  const sw = await controlMod.handle({ workspace_dir: TMP, task_id: id, action: 'switch_route', route: 'review' }, ctx)
  assert(sw.ok === true, `⑦ switch_route 成功（得 ${JSON.stringify(sw.error)}）`)
  assert(sw.task?.route === 'review', `⑦ route 已切换（得 ${sw.task?.route}）`)
  assert(sw.task?.route_source === 'explicit', `⑦ 切换后来源必须是 explicit（得 ${JSON.stringify(sw.task?.route_source)}）`)
  assert(sw.task?.route_evidence === undefined, `⑦ 切换后不得留着旧命中词（得 ${JSON.stringify(sw.task?.route_evidence)}）`)

  const persisted = store.getTask(TMP, id)
  assert(persisted?.route_source === 'explicit', `⑦ 持久化也必须是 explicit（得 ${JSON.stringify(persisted?.route_source)}）`)
  assert(persisted?.route_evidence === undefined, `⑦ 持久化不得留着旧命中词（得 ${JSON.stringify(persisted?.route_evidence)}）`)

  // ⑧ 事件重放（删快照 → 从事件重建）：纠正结果必须能重放出来，不能回退成推断
  rmSync(snapPath(id), { force: true })
  const rebuilt = store.getTask(TMP, id)
  assert(rebuilt?.route === 'review', `⑧ 重放后 route=review（得 ${rebuilt?.route}）`)
  assert(rebuilt?.route_source === 'explicit', `⑧ 重放后来源仍是 explicit（得 ${JSON.stringify(rebuilt?.route_source)}）`)
  assert(rebuilt?.route_evidence === undefined, `⑧ 重放后不得复活旧命中词（得 ${JSON.stringify(rebuilt?.route_evidence)}）`)
}

// ── ⑨ 回来查任务（code_status）也必须看得到来源 ──
// 只在创建那一刻标注是没用的：使用者后来回头查任务，才是决定「信不信这条 route」的时刻。
{
  const created = await call({ goal: '实现一个导出 CSV 的功能' })
  const st = await statusMod.handle({ workspace_dir: TMP, task_id: created.task.task_id })
  assert(st.ok === true, `⑨ code_status 成功（得 ${JSON.stringify(st.error)}）`)
  assert(st.task?.route_source === 'inferred', `⑨ code_status 也带 route_source（得 ${JSON.stringify(st.task?.route_source)}）`)
  assert(st.task?.route_evidence === '实现', `⑨ code_status 也带命中词（得 ${JSON.stringify(st.task?.route_evidence)}）`)
}

// ── ⑩ request_id 去重回包也得带来源（不能因为走了去重分支就丢字段）──
{
  const rid = 'rid-route-source-1'
  await call({ goal: '实现一个导出 CSV 的功能', request_id: rid })
  const again = await call({ goal: '实现一个导出 CSV 的功能', request_id: rid })
  assert(again.observation?.deduplicated === true, '⑩ 前置：走的是去重分支')
  assert(again.task?.route_source === 'inferred', `⑩ 去重回包带 route_source（得 ${JSON.stringify(again.task?.route_source)}）`)
}

console.log(`\n== test-route-source: ${pass} passed, ${fail} failed ==`)
if (fail > 0) process.exitCode = 1
