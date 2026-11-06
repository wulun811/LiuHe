// test-route-inference.js — code_task 的路由推断（tools/entry-shared.js::inferRoute）
//
// 背景（2026-10-30 重启后自用试用）：用一个中文目标走六合线，goal 是
//   「给 greet() 加上空名字校验，要求空字符串/空白抛 Error，并保持 farewell 行为不变」
// 结果 route=diagnose，随后 next_action.note 说「收集复现证据、病因假设留给你」——
// 那是一条改动任务，根本没有病因假设。
//
// 追下去发现不是偶发：ROUTES 里全是英文正则，中文目标一个都不匹配。
//
//   实现一个导出 CSV 的功能      → understand（应为 change）
//   修复登录失败的问题            → understand（应为 change，英文 fix 也是 change）
//   审查这个模块的安全风险        → understand（应为 review）
//   清理死代码                    → understand（应为 maintain）
//   为什么 reindex 会超时         → understand（应为 diagnose）
//
// 这不是「标签错了」而已，路由决定真实行为：
//   · route=review 才触发 audit 完成契约（understand 就永远不会被要求审计）
//   · route=maintain 才给死代码/依赖收束指引
//   · route=system/document 影响 code_task 是否返回结构信息
//   · 每个 route 的 next_action.note 不同（给错就是把方向指错）
//
// 本测试把「中文目标必须与等价英文目标同路由」钉成合同，同时锁住英文既有行为不变。

import { inferRoute } from '../tools/entry-shared.js'

let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) pass++
  else { fail++; console.error('  FAIL:', msg) }
}

// ── ① 中文改动类：与英文等价目标同路由 ──
{
  const cases = [
    ['给 greet() 加上空名字校验，要求空字符串/空白抛 Error', 'change'],
    ['实现一个导出 CSV 的功能', 'change'],
    ['新增一个 --json 输出选项', 'change'],
    ['修复登录失败的问题', 'change'],
    ['重构 transaction-store 的清扫逻辑', 'change'],
    ['把轨迹移到独立子目录', 'change'],
    ['删除不再使用的旧接口', 'change'],
    ['让它支持自定义分隔符', 'change'],
  ]
  for (const [goal, want] of cases) {
    const got = inferRoute(goal)
    assert(got === want, `① 「${goal}」应路由为 ${want}（得 ${got}）`)
  }
}

// ── ② 中文诊断类 ──
{
  const cases = [
    ['为什么 reindex 会超时', 'diagnose'],
    ['排查写入偶发失败的原因', 'diagnose'],
    ['reindex 崩溃了', 'diagnose'],
    ['这个命令报错', 'diagnose'],
  ]
  for (const [goal, want] of cases) {
    const got = inferRoute(goal)
    assert(got === want, `② 「${goal}」应路由为 ${want}（得 ${got}）`)
  }
}

// ── ③ 中文审查/维护/文档/系统/隔离 ──
{
  const cases = [
    ['审查这个模块的安全风险', 'review'],
    ['评审一下这次改动', 'review'],
    ['清理死代码', 'maintain'],
    ['升级依赖版本', 'maintain'],
    ['补充文档注释', 'document'],
    ['写一段 docstring', 'document'],
    ['这个仓库的架构总览', 'system'],
    ['入口初始化流程是怎样的', 'system'],
    ['给这个问题做最小复现', 'isolate'],
  ]
  for (const [goal, want] of cases) {
    const got = inferRoute(goal)
    assert(got === want, `③ 「${goal}」应路由为 ${want}（得 ${got}）`)
  }
}

// ── ④ 英文既有行为不得回归（路由表顺序/优先级不变）──
{
  const cases = [
    ['add empty-name validation to greet', 'change'],
    ['fix the crash in reindex', 'change'],
    ['implement CSV export', 'change'],
    ['why does reindex time out', 'diagnose'],
    ['review the security risk of this module', 'review'],
    ['clean up dead code', 'maintain'],
    ['add a docstring to greet', 'change'],           // document 在 change 之后：显式动词优先
    ['write documentation for greet', 'document'],
    ['architecture overview of the repo', 'system'],
    ['make a minimal repro', 'isolate'],
  ]
  for (const [goal, want] of cases) {
    const got = inferRoute(goal)
    assert(got === want, `④ 「${goal}」应路由为 ${want}（得 ${got}）`)
  }
}

// ── ⑤ 优先级：改动动词压过「错误/失败」名词（否则 changelog 里出现 error 就变诊断）──
{
  const cases = [
    ['修复登录失败的问题', 'change'],
    ['修复 reindex 崩溃', 'change'],
    ['把报错信息改成中文', 'change'],
  ]
  for (const [goal, want] of cases) {
    const got = inferRoute(goal)
    assert(got === want, `⑤ 「${goal}」改动优先于诊断（期望 ${want}，得 ${got}）`)
  }
}

// ── ⑥ 不得过度匹配：维护/结构词不得把改动任务抢成别的路由 ──
{
  const cases = [
    ['重构这一段结构', 'change'],          // 结构 → 但重构优先
    ['添加依赖注入支持', 'change'],        // 依赖 → 但添加优先
    ['清理掉旧的构建脚本并换成新的', 'maintain'],
  ]
  for (const [goal, want] of cases) {
    const got = inferRoute(goal)
    assert(got === want, `⑥ 「${goal}」不得被次要关键词抢走（期望 ${want}，得 ${got}）`)
  }
}

// ── ⑦ 无关键词 → 兜底 understand；空/非法输入也不得抛 ──
{
  assert(inferRoute('') === 'understand', '⑦ 空目标兜底 understand')
  assert(inferRoute(null) === 'understand', '⑦ null 兜底 understand')
  assert(inferRoute(undefined) === 'understand', '⑦ undefined 兜底 understand')
  assert(inferRoute('看看这个文件') === 'understand', '⑦ 无动作词的中文兜底 understand')
  let threw = null
  try { inferRoute({ toString() { throw new Error('boom') } }) } catch (e) { threw = e }
  assert(threw === null, '⑦ 输入对象 toString 抛错时不得把异常抛给调用方')
}

console.log(`\n== test-route-inference: ${pass} passed, ${fail} failed ==`)
if (fail > 0) process.exitCode = 1
