// P2 切片1：code_read(mode=rich) 的有界投影（纯函数，供单测直接断言）。
// 背景：read_symbol(mode=rich) 已生成 outline/navigation，但 code_read 的 observation 未携带；
// 且 navigation.next_action 指向 read_symbol（graph 模式隐藏）——此处改写为 code_read（当前目录内可执行）。
// 合同：core 默认不投影（保持紧凑）；rich 投影有界（outline ≤50 项 + truncated）、显式说明非正文。
const OUTLINE_MAX_ITEMS = 50

export function projectRichRead(readMode, r) {
  if (readMode !== 'rich') return {}
  const out = {}
  if (r && r.outline && Array.isArray(r.outline.items)) {
    const items = r.outline.items.slice(0, OUTLINE_MAX_ITEMS)
    out.outline = {
      truncated: !!r.outline.truncated || r.outline.items.length > OUTLINE_MAX_ITEMS,
      count: r.outline.items.length,
      items,
      note: 'Structure only (names/types/lines), capped at ' + OUTLINE_MAX_ITEMS + ' items — not the symbol body.',
    }
  }
  if (r && r.navigation) {
    const loc = (r.navigation.next_action && r.navigation.next_action.params && r.navigation.next_action.params.locator) || null
    out.navigation = {
      callers_count: r.navigation.callers_count != null ? r.navigation.callers_count : 0,
      callees_count: r.navigation.callees_count != null ? r.navigation.callees_count : 0,
      next_action: loc ? { tool: 'code_read', params: { locator: loc, mode: 'core' } } : null,
      note: 'Static call counts (not runtime proof). For other anchors use code_task or a read-only query.',
    }
  }
  return out
}
