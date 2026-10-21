// 14：CJS require() 扫描——Rust 解析器只产出 ESM import refs，
// require() 是 dep_graph / dependency_gatekeeper / 别名反查的盲区。
// 字符串感知：不先剥字符串（剥了会把 require 的参数一起删掉——P2-B4 死代码的教训），
// 而是算字符串区间，跳过落在区间内的匹配（注释/字符串里的 require('x') 是假阳性）。
// 审查修复（五轮）：旧实现 `//` 剥注释先于字符串区间计算——同行 URL（"http://x"）连坐
// 删后半行代码（假阴性）；块注释 /* require('x') */ 与模板串 \`require('x')\` 不识别（假阳性
// → 幽灵依赖 + rename-symbol 跨文件多改名）。改单遍状态机：行注释/块注释（跨行）/字符串/
// 模板串整体跳过，字符串原文保留（区间记录不变，防 P2-B4 剥参数教训）。

function stripCommentsAndStrings(line, block) {
  let out = ''
  const ranges = []
  let i = 0
  while (i < line.length) {
    const c = line[i]
    if (block.inBlock) {
      const end = line.indexOf('*/', i)
      if (end === -1) break
      i = end + 2
      block.inBlock = false
      continue
    }
    if (c === '/' && line[i + 1] === '/') break
    if (c === '/' && line[i + 1] === '*') { block.inBlock = true; i += 2; continue }
    if (c === '"' || c === "'" || c === '`') {
      const q = c
      const start = i
      i++
      while (i < line.length && line[i] !== q) { if (line[i] === '\\') i++; i++ }
      i++ // 跳过闭合引号（未闭合则到行尾）
      out += line.slice(start, i)
      ranges.push([start, i])
      continue
    }
    out += c
    i++
  }
  return { code: out, ranges }
}

export function scanCjsRequires(source) {
  const results = []
  const lines = String(source).split('\n')
  const block = { inBlock: false }
  for (let i = 0; i < lines.length; i++) {
    const { code, ranges } = stripCommentsAndStrings(lines[i], block)
    const inString = (idx) => ranges.some(([s, e]) => idx >= s && idx < e)
    for (const m of code.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      if (inString(m.index)) continue
      const module = m[1]
      const aliasMap = {}
      const esc = module.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const d = new RegExp(`(?:const|let|var)\\s*\\{([^}]*)\\}\\s*=\\s*require\\(\\s*['"]${esc}['"]\\s*\\)`).exec(code)
      if (d) {
        for (const part of d[1].split(',')) {
          const p = part.trim()
          if (!p) continue
          const mm = p.match(/^(\w+)\s*:\s*(\w+)$/)
          if (mm) aliasMap[mm[2]] = mm[1]
          else if (/^\w+$/.test(p)) aliasMap[p] = p
        }
      }
      results.push({ module, line: i + 1, aliasMap })
    }
  }
  return results
}

// dogfood-050 r5：ESM import 扫描——Rust 提取器只产模块行（嵌套 specifier 不采集），
// 这里补本地名→原名映射（挂到模块行 call_expr，格式同 CJS aliasMap），供跨文件解析/别名反查。
// 复用 stripCommentsAndStrings（字符串/注释跳过的行状态机）；多行 import 用整源代码正则处理，
// 命中位点若落在字符串区间内则跳过（防字符串里的 import 文本假阳性）。
export function scanEsmImports(source) {
  const lines = String(source).split('\n')
  const block = { inBlock: false }
  const codeParts = []
  const stringRanges = []
  let offset = 0
  for (const line of lines) {
    const { code, ranges } = stripCommentsAndStrings(line, block)
    for (const [s, e] of ranges) stringRanges.push([s + offset, e + offset])
    codeParts.push(code)
    offset += code.length + 1
  }
  const code = codeParts.join('\n')
  const results = []
  const re = /\bimport\s+(?:([\w$]+)\s*,?\s*)?(?:\*\s+as\s+([\w$]+)\s*)?(?:,?\s*\{([\s\S]{0,500}?)\}\s*)?from\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]/g
  let m
  while ((m = re.exec(code)) !== null) {
    const idx = m.index
    if (stringRanges.some(([s, e]) => idx >= s && idx < e)) continue
    const module = m[4] || m[5]
    if (!module) continue
    const line = code.slice(0, idx).split('\n').length
    const aliasMap = {}
    if (m[1]) aliasMap[m[1]] = 'default'
    if (m[2]) aliasMap[m[2]] = '*'
    if (m[3]) {
      for (const part of m[3].split(',')) {
        const p = part.trim()
        if (!p) continue
        const mm = p.match(/^([\w$]+)\s+as\s+([\w$]+)$/)
        if (mm) aliasMap[mm[2]] = mm[1]
        else if (/^[\w$]+$/.test(p)) aliasMap[p] = p
      }
    }
    results.push({ module, line, aliasMap })
  }
  return results
}
