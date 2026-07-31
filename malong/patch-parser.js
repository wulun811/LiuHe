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
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n/g, '\n')
    .trim()
}

function parseBlocks(text) {
  const blocks = []
  const lines = text.split('\n')
  let i = 0

  while (i < lines.length) {
    const trimmed = lines[i].trim()

    if (trimmed === SEARCH_MARKER || trimmed === '<<<<<<< SEARCH') {
      const searchLines = []
      i++
      while (i < lines.length && lines[i].trim() !== SEPARATOR) {
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

  // Map back to original content (preserve original whitespace)
  const beforeLen = content.slice(0, idx).length
  const afterLen = content.slice(idx + normalizedSearch.length).length
  // Since normalization only removes trailing whitespace, the index in original
  // content should be close. Find the actual match by scanning around idx.
  for (let offset = -5; offset <= 5; offset++) {
    const candidateIdx = idx + offset
    if (candidateIdx < 0 || candidateIdx + normalizedSearch.length > content.length) continue
    const candidate = normalizeWhitespace(content.slice(candidateIdx, candidateIdx + normalizedSearch.length))
    if (candidate === normalizedSearch) {
      return { start: candidateIdx, end: candidateIdx + normalizedSearch.length }
    }
  }
  return null
}

function findFuzzyMatch(content, searchBlock) {
  const fuzzyContent = fuzzyNormalize(content)
  const fuzzySearch = fuzzyNormalize(searchBlock)

  const idx = fuzzyContent.indexOf(fuzzySearch)
  if (idx === -1) return null

  // Map back to original content
  for (let offset = -20; offset <= 20; offset++) {
    const candidateIdx = idx + offset
    if (candidateIdx < 0 || candidateIdx + fuzzySearch.length > content.length) continue
    const candidate = fuzzyNormalize(content.slice(candidateIdx, candidateIdx + fuzzySearch.length))
    if (candidate === fuzzySearch) {
      return { start: candidateIdx, end: candidateIdx + fuzzySearch.length }
    }
  }
  // ±20 窗口内找不到原文位置：fuzzy 空间 idx 与原文偏差过大（如匹配块前有长空白差异）。
  // 此时用 fuzzy idx + 原文长度硬切会静默篡改文件（递归进化第 5 轮 P0#4），宁可报错
  return null
}

function applyBlocks(content, blocks) {
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
