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
  if (b === a) {
    return { error: { code: 'SINGLE_LINE_SYMBOL', message: 'Single-line symbol: use boundary=full or patch mode.' } }
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

export function checkBracketBalance(text) {
  const pairs = { '(': ')', '[': ']', '{': '}' }
  const stack = []
  for (const ch of text) {
    if (pairs[ch]) stack.push(ch)
    else if (Object.values(pairs).includes(ch)) {
      const open = stack.pop()
      if (pairs[open] !== ch) return { ok: false, detail: `unbalanced: expected ${pairs[open] || 'nothing'} but got ${ch}` }
    }
  }
  return stack.length === 0 ? { ok: true } : { ok: false, detail: `unclosed: ${stack.join('')}` }
}
