// 14：CJS require() 扫描——Rust 解析器只产出 ESM import refs，
// require() 是 dep_graph / dependency_gatekeeper / 别名反查的盲区。
// 字符串感知：不先剥字符串（剥了会把 require 的参数一起删掉——P2-B4 死代码的教训），
// 而是算字符串区间，跳过落在区间内的匹配（注释/字符串里的 require('x') 是假阳性）。

export function scanCjsRequires(source) {
  const results = []
  const lines = String(source).split('\n')
  for (let i = 0; i < lines.length; i++) {
    const code = lines[i].replace(/\/\/.*$/, '')
    const ranges = []
    for (const m of code.matchAll(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g)) {
      ranges.push([m.index, m.index + m[0].length])
    }
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
