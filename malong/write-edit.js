// write-edit.js — 编辑应用纯函数（apply 原语 + 校验），无 IO、无外部依赖
// 从 write-runtime.js 拆分（P4 批量后运行时已近千行）

export function countOccurrences(haystack, needle) {
  let n = 0
  let idx = 0
  for (;;) {
    idx = haystack.indexOf(needle, idx)
    if (idx === -1) break
    n++
    idx += needle.length
  }
  return n
}

export function makeSimpleDiff(oldLines, newLines) {
  // 最长公共前后缀 → 变更区间 + 统一 diff 头
  let prefix = 0
  const maxP = Math.min(oldLines.length, newLines.length)
  while (prefix < maxP && oldLines[prefix] === newLines[prefix]) prefix++
  let suffix = 0
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) suffix++
  const oldChanged = oldLines.slice(prefix, oldLines.length - suffix)
  const newChanged = newLines.slice(prefix, newLines.length - suffix)
  const hunk = []
  for (const l of oldChanged) hunk.push(`-${l}`)
  for (const l of newChanged) hunk.push(`+${l}`)
  const oldStart = prefix + 1
  const newStart = prefix + 1
  return {
    patch: `@@ -${oldStart},${oldChanged.length} +${newStart},${newChanged.length} @@\n${hunk.join('\n')}`,
    lines_changed: Math.max(oldChanged.length, newChanged.length),
  }
}

export function applyReplace(lines, range, newContent) {
  const [a, b] = range
  const before = lines.slice(0, a - 1)
  const after = lines.slice(b)
  const newLines = newContent.split('\n')
  return { lines: [...before, ...newLines, ...after], diff: makeSimpleDiff(lines, [...before, ...newLines, ...after]) }
}

export function applyBodyEdit(lines, range, newContent, preserveSignature) {
  const [a, b] = range
  if (b < a) {
    // 7：调用方传 [start+1, end]，单行符号 → [L+1, L]（b < a）——旧守卫 b === a 永不成立，
    // 单行 body 编辑静默插入到符号行之后且返回成功
    return { error: { code: 'SINGLE_LINE_SYMBOL', message: 'Single-line symbol: use boundary=full or patch mode.' } }
  }
  // 护栏：body 模式误传完整符号（含签名行）→ 拒绝。典型误用是把整个符号文本贴进 content
  // 判定：content 任意一行 trim 后与签名行一致（嵌套同名定义几乎不可能，零误伤）
  // 注意：调用方传入的 range 已 +1 偏移（[range[0]+1, range[1]]），签名行是 lines[a-2]
  const sigTrim = lines[a - 2]?.trim() || ''
  if (sigTrim && newContent.split('\n').some(l => l.trim() === sigTrim)) {
    return { error: { code: 'BODY_CONTAINS_SIGNATURE', message: 'boundary=body content must not contain the signature line; pass only the method body, or use boundary=full for the whole symbol.' } }
  }
  const before = lines.slice(0, a - 1)
  const after = lines.slice(b)
  const newLines = newContent.split('\n')
  return { lines: [...before, ...newLines, ...after], diff: makeSimpleDiff(lines, [...before, ...newLines, ...after]) }
}

export function applyInsertAfter(lines, range, newContent) {
  const [, b] = range
  const before = lines.slice(0, b)
  const after = lines.slice(b)
  return { lines: [...before, ...newContent.split('\n'), ...after], diff: makeSimpleDiff(lines, [...before, ...newContent.split('\n'), ...after]) }
}

function stripLiteralsForBracket(text) {
  // 字符串/注释里的括号不是代码结构：先剥掉再平衡校验（尽力而为，不处理 ${} 内的代码）
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, ' ')
    .replace(/#.*$/gm, ' ')
    .replace(/`(?:[^`\\]|\\.)*`/g, ' ')
    .replace(/"(?:[^"\\]|\\.)*"/g, ' ')
    .replace(/'(?:[^'\\]|\\.)*'/g, ' ')
}

export function checkBracketBalance(text) {
  const code = stripLiteralsForBracket(text)
  const pairs = { '(': ')', '[': ']', '{': '}' }
  const stack = []
  for (const ch of code) {
    if (pairs[ch]) stack.push(ch)
    else if (Object.values(pairs).includes(ch)) {
      const open = stack.pop()
      if (pairs[open] !== ch) return { ok: false, detail: `unbalanced: expected ${pairs[open] || 'nothing'} but got ${ch}` }
    }
  }
  return stack.length === 0 ? { ok: true } : { ok: false, detail: `unclosed: ${stack.join('')}` }
}
