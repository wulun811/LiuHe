// workflow/output-budget.js — S5.4b2 累计输出优化（默认给窗口 + 截断标记，靠 expand 取全）。
// 不删数据：只控制「默认回多少」，truncated/omitted 让模型知道还有，并指向 code_control(action="expand")。
// 约定：重复调用（status/resume）默认给「最新 max 条」，避免随操作累积把 context 撑爆。

export const DEFAULT_WINDOW = 20

// 累计列表取最新 max 条（保持原顺序）。返回 { items, truncated, total, omitted }。
export function windowed(list, max = DEFAULT_WINDOW) {
  const arr = Array.isArray(list) ? list : []
  const cap = Math.max(1, parseInt(max) || DEFAULT_WINDOW)
  if (arr.length <= cap) return { items: arr, truncated: false, total: arr.length, omitted: 0 }
  const items = arr.slice(arr.length - cap)
  return { items, truncated: true, total: arr.length, omitted: arr.length - cap }
}

// 首屏列表取前 max 条（候选/材料等非累计列表）。返回 { items, truncated, total, omitted }。
export function capped(list, max = DEFAULT_WINDOW) {
  const arr = Array.isArray(list) ? list : []
  const cap = Math.max(1, parseInt(max) || DEFAULT_WINDOW)
  if (arr.length <= cap) return { items: arr, truncated: false, total: arr.length, omitted: 0 }
  return { items: arr.slice(0, cap), truncated: true, total: arr.length, omitted: arr.length - cap }
}

// ── R4/H02（0.5.14 复审修复）：入口可见文本预算 ──
// 预算按 JSON.stringify 字符串长度计（对齐 MCP content[].text；排除 JSON-RPC 转义膨胀）。
// 超预算时按调用方给的降级步骤逐级收缩（最可牺牲在前）；安全/失败/副作用/恢复字段不得列入步骤。
// 截断是显式的：observation.visible_char_budget 记录 limit/actual/truncated_fields + 展开指引。
export const CODE_TASK_FILE_TARGET_BUDGET = 6000
export const CODE_TASK_GENERAL_BUDGET = 12000

// N1（0.5.14 Windows 复核）：预算口径 = 模型最终可见文本。
// 旧实现用 JSON.stringify(obj)（紧凑）计数，MCP 边界却用 JSON.stringify(result, null, 2) 输出，
// 且预算元信息在计数之后才加入 → 声明 actual=4388 而实际 content[0].text 长 6032（专家 037/002）。
// 现在：① 用与出口相同的序列化函数（默认 2 空格缩进）；② 预算元信息本身计入；
// ③ actual = 加上元信息后的最终串长度（声明计数与最终可见文本一致）。
export const VISIBLE_BUDGET_UNIT = 'chars:final_model_visible_text(JSON.stringify(result,null,2)), including this budget node'

// M4（2026-10-19 专家 Windows 复核）：超预算建议必须区分场景——用户已经给了精确 target 时，
// 再说「Narrow with target={file|symbol}」是自指的（他会一直看到同一句话，目标却已是最小单位）。
// 调用方用 overSuggestion 传入本场景的真实出口；未传时保留旧文案（一般定位入口）。
export function fitVisibleBudget(obj, limit, steps = [], opts = {}) {
  const serialize = typeof opts?.serialize === 'function' ? opts.serialize : (o) => JSON.stringify(o, null, 2)
  const overSuggestion = typeof opts?.overSuggestion === 'string' && opts.overSuggestion ? opts.overSuggestion : 'Narrow with target={file|symbol} or search_terms to reduce the entry size.'
  const size = () => { try { return String(serialize(obj)).length } catch { return 0 } }
  if (size() <= limit) return obj
  const node = obj && typeof obj === 'object' ? obj.observation : null
  const hasNode = !!node && typeof node === 'object'
  // 预算元信息先占位（其自身长度也计入合同）
  if (hasNode) {
    node.visible_char_budget = {
      limit,
      actual: null,
      truncated_fields: [],
      unit: VISIBLE_BUDGET_UNIT,
      note: 'Partial view: fields listed above were reduced to fit the entry budget. Expand with the pointed actions (code_query modes / code_control action=expand) — safety, failure and recovery fields are kept intact.',
    }
  }
  const applied = []
  // M4-续（2026-10-19 实包复验）：预算元信息本身占 ~500 字符，且是**循环后**才写入的。
  // 旧循环每轮只看「当前串长度」，不含元信息 → 降到 5700 就停，加上元信息反弹到 6200，
  // 既不再跑剩余步，也不能回到循环（专家 6270、实包复验 6364 就是这个机制）。
  // 现在：每轮用「串 + 元信息（含 actual 位数）」预估总长作停止判据；收尾后若仍超，再重跑一遍剩余步。
  const budgetNodeSize = () => (hasNode ? String(serialize(node.visible_char_budget)).length + 4 : 0)
  const estTotal = () => size() + budgetNodeSize() + 8 // actual 位数/逗号的粗略占位
  const runSteps = () => {
    for (const step of steps) {
      if (estTotal() <= limit) return
      try { step.apply(obj) } catch {}
      if (hasNode) node.visible_char_budget.truncated_fields = [...applied, step.name]
      applied.push(step.name)
    }
  }
  runSteps()
  // 第二轮：元信息落库后长度变化（actual 进位/字段变多）可能又顶出去——允许同一串步骤再跑一次
  // （步骤都是幂等收敛的：已折叠字段再次 apply 不升温）。仅当上轮确实未达预算时重试。
  if (hasNode && size() > limit) runSteps()
  if (hasNode) node.visible_char_budget.truncated_fields = applied.slice()
  const over = size() > limit
  if (hasNode && over) {
    node.visible_char_budget.over_budget_after_steps = true
    node.visible_char_budget.suggestion = overSuggestion
  }
  if (hasNode) {
    // 固定点：actual 字段自身的位数会改变总长（1-2 轮收敛）——声明值必须等于最终串长度
    let prev = -1
    for (let i = 0; i < 6; i++) {
      const cur = size()
      node.visible_char_budget.actual = cur
      if (cur === prev) break
      prev = cur
    }
  }
  return obj
}