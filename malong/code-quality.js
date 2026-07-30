// 码龙 — 代码质量探针 (v2 P2.12)
// 5 维探针: techDebt, archViolation, blastRadius, overEngineering, paradigmFit
// 0% LLM, 90% AST/static analysis, 10% MiniLM embedding
// 详见：通天计划 §6.9

import { readFileSync } from 'node:fs'
import { extname } from 'node:path'

export const name = 'malong-code-quality'
export const version = '0.2.0'

let _core, _langParser, _depGraph

// ── 1. techDebt: 圈复杂度 + 认知复杂度 (支持 JSON AST) ──

function calcCyclomatic(node) {
  let score = 1
  function walk(n) {
    if (!n) return
    if (['if_statement', 'for_statement', 'while_statement', 'do_statement',
         'switch_expression', 'catch_clause', 'ternary_expression',
         'conditional_expression', 'case_expression'].includes(n.type)) score++
    if (n.children && Array.isArray(n.children)) {
      for (const c of n.children) walk(c)
    }
  }
  walk(node)
  return score
}

function calcCyclomaticTree(tree) {
  let score = 1
  function walk(n) {
    if (['if_statement', 'for_statement', 'while_statement', 'do_statement',
         'switch_expression', 'catch_clause', 'ternary_expression',
         'conditional_expression', 'case_expression'].includes(n.type)) score++
    for (let i = 0; i < n.childCount; i++) walk(n.child(i))
  }
  walk(tree.rootNode)
  return score
}

function calcCognitive(node, depth = 0) {
  let score = 0
  function walk(n, nesting) {
    if (!n) return
    const isBranch = ['if_statement', 'else_clause', 'for_statement', 'while_statement',
                      'do_statement', 'catch_clause', 'ternary_expression',
                      'conditional_expression'].includes(n.type)
    if (isBranch) {
      score += 1 + nesting
      nesting++
    }
    if (n.children && Array.isArray(n.children)) {
      for (const c of n.children) walk(c, nesting)
    }
  }
  walk(node, 0)
  return score
}

function calcCognitiveTree(node, depth = 0) {
  let score = 0
  function walk(n, nesting) {
    const isBranch = ['if_statement', 'else_clause', 'for_statement', 'while_statement',
                      'do_statement', 'catch_clause', 'ternary_expression',
                      'conditional_expression'].includes(n.type)
    if (isBranch) {
      score += 1 + nesting
      nesting++
    }
    for (let i = 0; i < n.childCount; i++) walk(n.child(i), nesting)
  }
  walk(node, 0)
  return score
}

// ── 2. archViolation: 依赖边界违规 ──

function calcArchViolations(tree, source, ext) {
  let violations = 0
  function walk(node) {
    if (!node) return
    const t = node.type
    if (t === 'call_expression') {
      const text = source?.slice(node.startIndex, node.endIndex) || node.text || ''
      const name = node.name || node.text || ''
      if (/(^|\b)(process|global|root|eval|Function)\b/.test(name)) violations++
    } else if (t === 'member_expression') {
      let depth = 0
      // Walk JSON AST (children) or tree AST (child)
      let cur = node
      while (cur && cur.type === 'member_expression') { depth++; cur = cur.children?.[0] || cur.child?.(0) }
      if (depth > 3) violations++
    }
    if (node.children && Array.isArray(node.children)) {
      for (const c of node.children) walk(c)
    } else {
      for (let i = 0; i < (node.childCount || 0); i++) walk(node.child(i))
    }
  }
  if (tree.rootNode) walk(tree.rootNode)
  else walk(tree)
  return violations
}

// ── 3. blastRadius: 引用计数 + 危险 API ──

const DANGEROUS_APIS = ['eval', 'Function', 'exec', 'execSync', 'execFile',
  'execFileSync', 'spawn', 'spawnSync', 'child_process',
  '__import__', 'os.system', 'subprocess', 'sys.exit',
  'unsafe', 'ptr::read', 'transmute']

function calcBlastRadius(source) {
  let dangerousCount = 0
  for (const api of DANGEROUS_APIS) {
    const idx = source.indexOf(api)
    if (idx >= 0) dangerousCount++
  }
  // 文件大小作为影响范围代理
  const sizeScore = Math.min(1, source.length / 50000)
  return { dangerousCount, sizeScore, score: Math.min(1, (dangerousCount * 0.3 + sizeScore * 0.7)) }
}

// ── 4. overEngineering: AST 变更幅度 ──

function compareASTSize(source) {
  // 函数/方法嵌套深度 vs 文件大小
  const lines = source.split('\n').length
  const nestedDepth = estimateNestingDepth(source)
  const ratio = nestedDepth / Math.sqrt(lines)
  return Math.min(1, ratio / 3)
}

function estimateNestingDepth(source) {
  let maxDepth = 0, depth = 0
  for (const ch of source) {
    if (ch === '{' || ch === '(') depth++
    else if (ch === '}' || ch === ')') depth--
    if (depth > maxDepth) maxDepth = depth
  }
  return maxDepth
}

// ── 5. paradigmFit: 项目风格一致性 (命名/模式) ──

function calcParadigmFit(source, ext) {
  // 基于扩展名推断预期范式
  const expectedPatterns = paradigmPatternsFor(ext)
  let matchCount = 0, totalCount = 0
  for (const [regex, expected] of expectedPatterns) {
    for (const match of source.matchAll(regex)) {
      totalCount++
      const name = match[1] || match[0]
      if (/^[a-z]/.test(name) && expected === 'camelCase') matchCount++
      else if (/^[A-Z]/.test(name) && expected === 'PascalCase') matchCount++
      else if (/_/.test(name) && expected === 'snake_case') matchCount++
    }
  }
  return totalCount > 0 ? matchCount / totalCount : 0.5
}

function paradigmPatternsFor(ext) {
  if (ext === '.py') return [[/^(\w+)\s*=\s*(?:lambda|def|class)/gm, 'snake_case'], [/\bclass\s+(\w+)/g, 'PascalCase']]
  if (ext === '.go') return [[/^func\s+(\w+)/gm, 'camelCase'], [/\btype\s+(\w+)/g, 'PascalCase']]
  if (ext === '.rs') return [[/^fn\s+(\w+)/gm, 'snake_case'], [/\bstruct\s+(\w+)/g, 'PascalCase'], [/\benum\s+(\w+)/g, 'PascalCase']]
  return [[/(?:function|const|let|var)\s+(\w+)/g, 'camelCase'], [/\bclass\s+(\w+)/g, 'PascalCase']]
}

// ── Service ──

export async function init(core) {
  _core = core
  _langParser = core.getService('langParser')
  _depGraph = core.getService('toolDepGraph')
  if (!_langParser) throw new Error('[code-quality] lang-parser service required')

  core.registerService('codeQuality', {
    async scoreSource(source, filePath = '') {
      const ext = extname(filePath) || '.js'

      // async path: try simplifyASTAsync first
      let cyc, cog, arch
      try {
        const ast = await _langParser.simplifyASTAsync(source, ext, 50)
        if (ast) {
          cyc = calcCyclomatic(ast)
          cog = calcCognitive(ast)
          arch = calcArchViolations(ast, source, ext)
        }
      } catch {}

      if (cyc === undefined) {
        // fallback to sync parse
        const tree = _langParser.parse(source, ext)
        if (!tree) return { dimensions: {}, overall: 0, error: 'parse_failed' }
        cyc = calcCyclomaticTree(tree.rootNode)
        cog = calcCognitiveTree(tree.rootNode)
        arch = calcArchViolations(tree, source, ext)
      }

      const techDebt = Math.min(1, (cyc / 20 + cog / 30) / 2)
      const archScore = Math.min(1, arch / 5)
      const br = calcBlastRadius(source)
      const oe = compareASTSize(source)
      const pf = calcParadigmFit(source, ext)

      const dims = {
        techDebt: { value: Math.round((1 - techDebt) * 100) / 100, rawCyclomatic: cyc, rawCognitive: cog },
        archViolation: { value: Math.round((1 - archScore) * 100) / 100, rawViolations: arch },
        blastRadius: { value: Math.round((1 - br.score) * 100) / 100, rawDangerousAPIs: br.dangerousCount },
        overEngineering: { value: Math.round((1 - oe) * 100) / 100, rawNestingDepth: estimateNestingDepth(source) },
        paradigmFit: { value: Math.round(pf * 100) / 100, rawMatchRate: pf },
      }

      // Weighted overall (techDebt 0.25, arch 0.20, blast 0.20, overEng 0.20, paraFit 0.15)
      const overall = Math.round((
        dims.techDebt.value * 0.25 +
        dims.archViolation.value * 0.20 +
        dims.blastRadius.value * 0.20 +
        dims.overEngineering.value * 0.20 +
        dims.paradigmFit.value * 0.15
      ) * 100) / 100

      return { dimensions: dims, overall }
    },

    async scoreFile(filePath) {
      const source = readFileSync(filePath, 'utf-8')
      return this.scoreSource(source, filePath)
    },
  })
  core.log('info', '[code-quality] 5-dim probe registered')
}

export async function start() {}
export async function stop() {}
