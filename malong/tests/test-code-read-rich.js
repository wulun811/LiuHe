// P2 切片1：code_read(mode=rich) 有界投影契约测试。
// 失败路径：core 泄漏投影；outline 未截断；navigation.next_action 指向 graph 隐藏的 read_symbol。
import { projectRichRead } from '../tools/tool-code-read/rich-projection.js'

let pass = 0, fail = 0
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  FAIL:', msg) } }

// 1. core 不投影（保持紧凑）
const core = projectRichRead('core', { outline: { items: [{ name: 'a', type: 'function', line: 1 }] }, navigation: { callers_count: 2 } })
assert(Object.keys(core).length === 0, 'core 模式不投影 outline/navigation')

// 2. rich 投影 outline（有界）
const r2 = projectRichRead('rich', { outline: { truncated: false, items: [{ name: 'double', type: 'function', line: 1 }, { name: 'triple', type: 'function', line: 3 }] } })
assert(r2.outline && r2.outline.count === 2 && r2.outline.items.length === 2, 'rich 投影 outline 条目')
assert(r2.outline.truncated === false, '未超限时 truncated=false')
assert(typeof r2.outline.note === 'string' && /not the symbol body/i.test(r2.outline.note), 'outline 带“非正文”说明')

// 3. rich outline 超 50 项 → 截断
const big = { outline: { items: Array.from({ length: 73 }, (_, i) => ({ name: 's' + i, type: 'function', line: i + 1 })) } }
const r3 = projectRichRead('rich', big)
assert(r3.outline.items.length === 50 && r3.outline.truncated === true && r3.outline.count === 73, 'outline >50 项截断到 50 且标记 truncated')

// 4. navigation.next_action 改写为 code_read（graph 隐藏 read_symbol）
const r4 = projectRichRead('rich', { navigation: { callers_count: 3, callees_count: 1, next_action: { tool: 'read_symbol', params: { locator: { symbol_id: 'js:a.js::x#function' }, mode: 'core' } } } })
assert(r4.navigation && r4.navigation.callers_count === 3 && r4.navigation.callees_count === 1, 'navigation 计数透出')
assert(r4.navigation.next_action && r4.navigation.next_action.tool === 'code_read', 'next_action 改写为 code_read（非隐藏的 read_symbol）')
assert(r4.navigation.next_action.params.locator.symbol_id === 'js:a.js::x#function', 'navigation locator 保留')
assert(r4.navigation.next_action.params.mode === 'core', 'navigation mode 保留 core')

// 5. 无 outline/navigation → 空投影
assert(Object.keys(projectRichRead('rich', {})).length === 0, 'rich 无数据 → 空投影')

// 6. navigation 无 locator → next_action=null
const r6 = projectRichRead('rich', { navigation: { callers_count: 0, callees_count: 0 } })
assert(r6.navigation.next_action === null, 'navigation 无 locator → next_action=null')

// 7. 防御 null r
assert(Object.keys(projectRichRead('rich', null)).length === 0, 'r=null 不抛异常')

console.log('=== test-code-read-rich: ' + pass + ' passed, ' + fail + ' failed ===')
process.exit(fail ? 1 : 0)
