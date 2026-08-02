// 码龙 — Search/Replace 块协议解析器 (v1e MVP)
// 职责：解析 LLM 输出的 SEARCH/REPLACE 代码块，三级降级匹配
// 详见：通天计划 §7.2
//
// 协议格式：
//   <<<<<<< SEARCH
//   [原始代码块]
//   =======
//   [替换代码块]
//   >>>>>>> REPLACE
//
// 三级降级：
//   1. 规范化匹配（统一换行符、去行尾空白、检测缩进）
//   2. 灰白模糊匹配（忽略空白差异）
//   3. 失败标记

export const name = 'malong-patch-parser'
export const version = '0.1.0'

const SEARCH_MARKER = '<<<<<<< SEARCH'
const SEPARATOR = '======='
const REPLACE_MARKER = '>>>>>>> REPLACE'

function normalizeWhitespace(text) {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map(l => l.replace(/\s+$/, ''))
    .join('\n')
}

function fuzzyNormalize(text) {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    // r34-fix: 折叠所有空白（含换行）——单行 SEARCH 才能匹配多行内容（"忽略空白差异"语义）
    .replace(/\s+/g, ' ')
    .trim()
}

// r34-fix: 导出供单测（原模块私有，行为不变）
export function parseBlocks(text) {
  const blocks = []
  const lines = text.split('\n')
  let i = 0

  while (i < lines.length) {
    const trimmed = lines[i].trim()

    if (trimmed === SEARCH_MARKER || trimmed === '<<<<<<< SEARCH') {
      const searchLines = []
      i++
      while (i < lines.length) {
        // r34-fix: 旧 lookahead（仅当 next===REPLACE_MARKER 才结束）让标准格式
        // `======= 后跟 replace 内容` 永远解析失败（分隔符被吞进 SEARCH）——
        // 标准协议中 ======= 无条件结束 SEARCH；markdown 表格分隔行是 |---| 不是 =======
        if (lines[i].trim() === SEPARATOR) break
        searchLines.push(lines[i])
        i++
      }
      if (i >= lines.length) break
      i++ // skip =======

      const replaceLines = []
      while (i < lines.length && lines[i].trim() !== REPLACE_MARKER && !lines[i].trim().startsWith('>>>>>>>')) {
        replaceLines.push(lines[i])
        i++
      }
      if (i >= lines.length) break
      i++ // skip >>>>>>> REPLACE

      blocks.push({
        search: searchLines.join('\n'),
        replace: replaceLines.join('\n'),
      })
    } else {
      i++
    }
  }

  return blocks
}

function findExactMatch(content, searchBlock) {
  const normalizedContent = normalizeWhitespace(content)
  const normalizedSearch = normalizeWhitespace(searchBlock)

  const idx = normalizedContent.indexOf(normalizedSearch)
  if (idx === -1) return null

  // Map back to original content (preserve original whitespace).
  // r34-fix: 切片长度必须用 searchBlock 的原文长度（normalized 更短——行尾空白/CRLF
  // 被移除），且窗口按长度差扩展——旧 ±5 固定窗口 + normalized 长度会把尾空格漏进结果
  // （替换后残留尾空格）或在长空白差异时漏匹配。
  const lenDiff = Math.abs(normalizedSearch.length - searchBlock.length)
  const windowSize = 5 + lenDiff
  for (let offset = -windowSize; offset <= windowSize; offset++) {
    const start = idx + offset
    if (start < 0 || start > content.length) continue
    // r34-fix: end 动态扩展——原文段长度 ≠ searchBlock.length（CRLF/尾空格/折叠空白），
    // 固定长度切片会截断或残留空白（"REPLACED " bug）
    const maxEnd = Math.min(content.length, start + searchBlock.length + 64)
    for (let end = start + searchBlock.length; end <= maxEnd; end++) {
      if (normalizeWhitespace(content.slice(start, end)) === normalizedSearch) {
        return { start, end }
      }
    }
  }
  return null
}

function findFuzzyMatch(content, searchBlock) {
  const fuzzyContent = fuzzyNormalize(content)
  const fuzzySearch = fuzzyNormalize(searchBlock)

  const idx = fuzzyContent.indexOf(fuzzySearch)
  if (idx === -1) return null

  // Map back to original content（同 findExactMatch 的长度对齐修正）
  const lenDiff = Math.abs(fuzzySearch.length - searchBlock.length)
  const windowSize = 20 + lenDiff
  for (let offset = -windowSize; offset <= windowSize; offset++) {
    const start = idx + offset
    if (start < 0 || start > content.length) continue
    const maxEnd = Math.min(content.length, start + searchBlock.length + 64)
    for (let end = start + searchBlock.length; end <= maxEnd; end++) {
      if (fuzzyNormalize(content.slice(start, end)) === fuzzySearch) {
        return { start, end }
      }
    }
  }
  return null
}

// r34-fix: 导出供单测（原模块私有，行为不变）
export function applyBlocks(content, blocks) {
  let result = content
  const applied = []
  const errors = []

  for (const block of blocks) {
    if (!block.search.trim()) {
      // Insert-only block: no search content means append
      result += '\n' + block.replace
      applied.push({ search: '', replace: block.replace, method: 'insert' })
      continue
    }

    // Level 1: Exact match (normalized whitespace)
    let match = findExactMatch(result, block.search)

    // Level 2: Fuzzy match (ignore whitespace)
    if (!match) {
      match = findFuzzyMatch(result, block.search)
      if (match) {
        applied.push({ search: block.search, replace: block.replace, method: 'fuzzy' })
      }
    } else {
      applied.push({ search: block.search, replace: block.replace, method: 'exact' })
    }

    if (!match) {
      errors.push({ search: block.search, replace: block.replace, error: 'no match found' })
      continue
    }

    result = result.slice(0, match.start) + block.replace + result.slice(match.end)
  }

  return { result, applied, errors }
}

function extractBlocksFromLLM(llmOutput) {
  return parseBlocks(llmOutput)
}

export async function init(core) {
  core.registerService('patchParser', {
    parse: parseBlocks,
    apply: (content, blocks) => applyBlocks(content, blocks),
    applyFromLLM: (content, llmOutput) => {
      const blocks = parseBlocks(llmOutput)
      return applyBlocks(content, blocks)
    },
    extract: extractBlocksFromLLM,
  })

  if (core.log) core.log('info', '[malong/patch-parser] init')
}

export async function start(core) {
  if (core.log) core.log('info', '[malong/patch-parser] start')
}

export async function stop(core) {
  if (core.log) core.log('info', '[malong/patch-parser] stop')
}
