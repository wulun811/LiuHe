// test-route-identifier-collision.js — 路由不得被 goal 里的标识符抢走
//
// 真机实测（2026-11-05，重启 opencode 后自用）：
//   document the add function   → change（应 document）
//   why does add return empty   → change（应 diagnose）
//   the add function is broken  → change（应 diagnose）
//   为什么不支持并发上传          → change（应 diagnose）
//
// 根因：英文改动动词是全串匹配，中文「支持/加上/加入」与名词同形；
// 而 add / support / 支持 正是最常见的函数名与参数名。
// 后果不是标签难看：route 决定真实行为（review 才触发审计契约、document 才展开文档线索）。
//
// 修法（R22-F17）：
//   ① 英文改动动词改为句首锚定（允许 please / how do I 等前缀）——句中出现视为标识符；
//   ② 加上/加入/支持 与 error 降为弱信号，只有全无强信号时才用；
//   ③ 补「改」单字，但排除「改动/改进/改善/改期/改天」这类名词（改进单独列入强信号）。

import { inferRouteDetailed } from '../tools/entry-shared.js'

let pass = 0, fail = 0
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  FAIL:', msg) } }

// ── ① 标识符不得抢走路由（旧行为全是 change）──
{
  const cases = [
    ['document the add function', 'document'],
    ['why does add return empty', 'diagnose'],
    ['the add function is broken', 'diagnose'],
    ['为什么不支持并发上传', 'diagnose'],
    ['上传功能不支持大文件，为什么', 'diagnose'],
    ['看看为什么 add 返回空', 'diagnose'],
  ]
  for (const [goal, want] of cases) {
    const r = inferRouteDetailed(goal)
    assert(r.route === want, `① 「${goal}」应路由为 ${want}（得 ${r.route}，evidence=${JSON.stringify(r.evidence)}）`)
  }
}

// ── ② 真实改动目标不得因为弱词下沉而丢失 ──
{
  const goals = [
    '给 greet() 加上空名字校验，要求空字符串/空白抛 Error',
    '给 add 加上参数校验',
    '让它支持自定义分隔符',
    'add a docstring to greet',
    'add an export flag to the CLI',
    'fix the failing add test',
    'how do I add a new endpoint',
    '改进错误处理',
  ]
  for (const goal of goals) {
    const r = inferRouteDetailed(goal)
    assert(r.route === 'change', `② 「${goal}」应仍为 change（得 ${r.route}，evidence=${JSON.stringify(r.evidence)}）`)
  }
}

// ── ③ evidence 仍必须真实出现在 goal 里（既有可核查合同）──
{
  const goals = [
    'document the add function', 'why does add return empty',
    '给 greet() 加上空名字校验，要求空字符串/空白抛 Error',
    '改 alpha 的返回值', 'add a docstring to greet', 'the error is in add',
  ]
  for (const goal of goals) {
    const r = inferRouteDetailed(goal)
    assert(typeof r.evidence === 'string' && r.evidence.length > 0 && goal.includes(r.evidence),
      `③ evidence 必须出现在 goal 中（evidence=${JSON.stringify(r.evidence)}，goal=${JSON.stringify(goal)}）`)
  }
}

// ── ④ 裸「改」：真动词要认，名词「改动」不得抢 review ──
{
  const a = inferRouteDetailed('改 alpha 的返回值')
  assert(a.route === 'change' && a.evidence === '改', `④ 裸「改」应命中 change（得 ${a.route}/${JSON.stringify(a.evidence)}）`)
  const b = inferRouteDetailed('评审一下这次改动')
  assert(b.route === 'review', `④ 「改动」是名词，不得抢走 review（得 ${b.route}，evidence=${JSON.stringify(b.evidence)}）`)
}

// ── ⑤ 弱信号只在无强信号时使用 ──
{
  const r = inferRouteDetailed('修复不支持自定义分隔符的问题')
  assert(r.route === 'change', `⑤ 强信号「修复」优先（得 ${r.route}）`)
  assert(r.evidence !== '支持', `⑤ 有强信号时 evidence 不得是弱词「支持」（得 ${JSON.stringify(r.evidence)}）`)
}

// ── ⑥ 一个词都没有 → default，且不得编造 evidence ──
{
  const r = inferRouteDetailed('hmm take a look at this thing')
  assert(r.route === 'understand' && r.source === 'default' && r.evidence === null,
    `⑥ 无命中 → understand/default/null（得 ${JSON.stringify(r)}）`)
}

console.log(`\n=== test-route-identifier-collision: ${pass} passed, ${fail} failed ===`)
process.exit(fail > 0 ? 1 : 0)
