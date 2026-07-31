// string-utils.js — 字符串感知工具（行级正则质检工具的公共基础）

// 剥离字符串字面量（保留模板字符串 ${} 表达式），防字符串里的文本被正则误匹配
export function stripStrings(line) {
  let out = ''
  let i = 0
  let quote = null
  while (i < line.length) {
    const ch = line[i]
    if (quote) {
      if (ch === '\\') { i += 2; continue }
      if (ch === quote) { quote = null; i++; continue }
      if (quote === '`' && ch === '$' && line[i + 1] === '{') {
        let depth = 1
        let j = i + 2
        while (j < line.length && depth > 0) {
          if (line[j] === '{') depth++
          else if (line[j] === '}') depth--
          j++
        }
        out += line.slice(i, j)
        i = j
        continue
      }
      i++
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; i++; continue }
    out += ch
    i++
  }
  return out
}
