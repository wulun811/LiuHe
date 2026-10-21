// write-edit.js — 编辑应用纯函数（apply 原语 + 校验），无 IO、无外部依赖
// 从 write-runtime.js 拆分（P4 批量后运行时已近千行）

export function countOccurrences(haystack, needle) {
  if (!needle) return 0 // 9（F4）：空 needle → indexOf('',idx) 恒命中且 idx+=0 不前进 → 死循环
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

// P0 修复（2026-10-12 狗粮发现）：正则字面量识别——含括号/引号的正则（如 /['"]/）旧实现当作代码，
// 造成 bracket 假阳性；而写路径的 syntax 仲裁恰在 daemon 漏报（EOF 未闭合括号）时失守。
// 剥离器补正则识别后，bracket 结果可独立成立，不再依赖降级仲裁。
const REGEX_ALLOWED_AFTER = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '^', '~'])
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'instanceof', 'do', 'else', 'yield', 'await', 'throw'])
const ID_CHAR = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_$'

function regexMayStart(out) {
  let j = out.length - 1
  while (j >= 0 && (out[j] === ' ' || out[j] === '\n' || out[j] === '\t' || out[j] === '\r')) j--
  if (j < 0) return true
  const pc = out[j]
  if (ID_CHAR.includes(pc)) {
    let k = j
    while (k >= 0 && ID_CHAR.includes(out[k])) k--
    return REGEX_KEYWORDS.has(out.slice(k + 1, j + 1))
  }
  return REGEX_ALLOWED_AFTER.has(pc)
}

// 返回闭合 '/' 之后的下标；未闭合或遇换行（正则不可跨行）返回 -1 —— 保守回退为普通字符（除法）
function scanRegexLiteral(text, start) {
  let i = start + 1
  let inClass = false
  while (i < text.length) {
    const ch = text[i]
    if (ch === '\n') return -1
    if (ch === '\\') { i += 2; continue }
    if (ch === '[') inClass = true
    else if (ch === ']') inClass = false
    else if (ch === '/' && !inClass) return i + 1
    i++
  }
  return -1
}

function stripLiteralsForBracket(text) {
  // 字符串/注释/正则里的括号不是代码结构：先剥掉再平衡校验（尽力而为，不处理模板串内代码）
  // R22 修复 #3b（2026-10-12）：单趟扫描替代 regex 链——旧实现先跑注释 regex，把字符串里的 //
  // （如 URL https://…）当行注释剥掉、连带吞掉闭合引号，跨行级联误判（合法 JSON/含 URL 的 JS 误报不平衡）
  let out = ''
  let i = 0
  const n = text.length
  while (i < n) {
    const c = text[i]
    if (c === '"' || c === "'" || c === '`') {
      i++
      while (i < n) {
        if (text[i] === '\\') { i += 2; continue }
        if (text[i] === c) { i++; break }
        i++
      }
      out += ' '
      continue
    }
    if (c === '/' && text[i + 1] === '/') { while (i < n && text[i] !== '\n') i++; out += ' '; continue }
    if (c === '/' && text[i + 1] === '*') { i += 2; while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++; i = Math.min(n, i + 2); out += ' '; continue }
    if (c === '#') { while (i < n && text[i] !== '\n') i++; out += ' '; continue }
    if (c === '/' && regexMayStart(out)) {
      const end = scanRegexLiteral(text, i)
      if (end !== -1) { out += ' '; i = end; continue }
    }
    out += c
    i++
  }
  return out
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
