// 码龙 — NL 代码搜索模块 (v3 P4.2.5)
// 语义+结构+符号混合搜索，不依赖 Python embedding
// 回退策略：符号匹配 → 文件路径模糊匹配 → 内容关键词

const NL_PATTERNS = [
  { intents: ['findFunction', 'findMethod'], patterns: [/function\s+(\w+)/i, /method\s+(\w+)/i, /where is (\w+) (?:function|method|defined)/i, /find\s+(?:the\s+)?(\w+)\s+(?:function|method)/i] },
  { intents: ['findClass'], patterns: [/class\s+(\w+)/i, /where is (\w+) class/i, /find\s+(?:the\s+)?(\w+)\s+class/i] },
  { intents: ['findVariable'], patterns: [/variable\s+(\w+)/i, /where is (\w+) (?:variable|const)/i] },
  { intents: ['whereUsed', 'impactAnalysis'], patterns: [/(?:where|how|what)\s+(?:is\s+)?(\w+)\s+(?:used|called|referenced)/i, /who calls (\w+)/i, /impact.*(\w+)/i, /depend.*(\w+)/i] },
  { intents: ['deadCode'], patterns: [/dead\s*code/i, /unused\s+(?:function|code)/i, /never\s+called/i, /what.*not.*used/i] },
  { intents: ['dependencyTree'], patterns: [/dependency\s+(?:tree|graph|chain)/i, /depend.*module/i, /import.*graph/i] },
  { intents: ['complexity'], patterns: [/complexity/i, /complex/i, /hard to understand/i, /too many lines/i] },
  { intents: ['search'], patterns: [/search\s+(?:for\s+)?(\w+)/i, /find\s+(?:the\s+)?(\w+)/i, /locate\s+(\w+)/i] },
]

export const name = 'malong-code-search'
export const version = '0.1.0'

let _core, _codeIndex, _langParser

export async function init(core) {
  _core = core
  core.registerService('codeSearch', {
    async search(query, { topK = 10, tenantId = 'default' } = {}) {
      if (!query || query.trim().length < 2) return { query, results: [], intent: 'unknown' }
      const intent = _classifyQuery(query)
      const tokens = _tokenize(query)
      const [symbolResults, fileResults, callResults] = await Promise.all([
        _searchSymbols(tokens, topK),
        _searchFiles(tokens, topK),
        _executeIntent(intent, tokens, query),
      ])
      const combined = _fuseResults(symbolResults, fileResults, callResults, query, topK)
      return { query, intent, results: combined }
    },
  })
  core.log('info', `[code-search] service registered`)
}

export async function start() {}

export async function stop() {
  _codeIndex = null
  _langParser = null
}

function _classifyQuery(query) {
  const q = query.trim()
  for (const entry of NL_PATTERNS) {
    for (const p of entry.patterns) {
      if (p.test(q)) return entry.intents[0]
    }
  }
  return 'search'
}

function _tokenize(query) {
  return query
    .replace(/[^a-zA-Z0-9_\u4e00-\u9fff]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 1)
}

async function _searchSymbols(tokens, limit) {
  const _getService = () => _core?.services?.codeIndex
  const ci = _getService()
  if (!ci?.searchSymbols) return []
  const results = []
  const seen = new Set()
  for (const tok of tokens) {
    if (tok.length < 2 || seen.has(tok)) continue
    seen.add(tok)
    try {
      const matches = await ci.searchSymbols(tok, { limit: Math.ceil(limit / Math.max(1, tokens.length)) })
      for (const m of matches) {
        results.push({
          type: 'symbol',
          name: m.name,
          kind: m.type,
          file: m.file,
          line: m.start_line,
          score: tok === m.name ? 0.9 : tok.length / Math.max(tok.length, m.name.length) * 0.7,
        })
      }
    } catch {}
  }
  results.sort((a, b) => b.score - a.score)
  return results.slice(0, limit)
}

async function _searchFiles(tokens, limit) {
  const _getService = () => _core?.services?.codeIndex
  const ci = _getService()
  if (!ci?.getStats) return []
  try {
    const stats = ci.getStats?.()
    if (!stats || !stats.files) return []
  } catch { return [] }
  const results = []
  const seen = new Set()
  for (const tok of tokens) {
    if (tok.length < 2) continue
    try {
      const syms = await ci.searchSymbols(tok, { limit })
      for (const s of syms) {
        if (!seen.has(s.file)) {
          seen.add(s.file)
          results.push({ type: 'file', path: s.file, score: tok.length > 3 ? 0.5 : 0.3 })
        }
      }
    } catch {}
  }
  return results.slice(0, limit)
}

async function _executeIntent(intent, tokens, rawQuery) {
  const _getService = () => _core?.services?.codeIndex
  const ci = _getService()
  if (!ci) return []
  try {
    if (intent === 'whereUsed' || intent === 'impactAnalysis') {
      const symbolMatch = rawQuery.match(/(\w+)/g)
      const target = symbolMatch?.find(t => t.length > 2 && !['where','how','what','is','used','called','the','who','calls','impact','depend','this'].includes(t.toLowerCase()))
      if (target) {
        const [callers, callees] = await Promise.all([
          ci.getCallers(target).catch(() => []),
          ci.getCallees(target).catch(() => []),
        ])
        const results = []
        for (const c of callers) results.push({ type: 'caller', name: target, callerFile: c.caller_file, score: 0.8 })
        for (const c of callees) results.push({ type: 'callee', name: target, targetName: c.target_name, sourceFile: c.source_file, score: 0.7 })
        return results
      }
    }
    if (intent === 'deadCode') {
      const dead = await ci.detectDeadCode().catch(() => [])
      return dead.map(d => ({ type: 'deadCode', name: d.name, file: d.file, line: d.start_line, refCount: d.ref_count, score: 0.9 }))
    }
    if (intent === 'complexity') {
      const symbolMatch = rawQuery.match(/(\w+)\s*(?:function|method|class)?/i)
      if (symbolMatch) {
        const target = symbolMatch[1]
        if (target && target.length > 1) {
          const cx = await ci.getComplexity(target).catch(() => null)
          if (cx) return [{ type: 'complexity', name: cx.name, file: cx.file, linesOfCode: cx.linesOfCode, cyclomatic: cx.cyclomaticComplexity, cognitive: cx.cognitiveComplexity, score: 0.85 }]
        }
      }
      return []
    }
    if (intent === 'dependencyTree') {
      const symbolMatch = rawQuery.match(/(\w+(?:\/\w+)*(?:\.\w+)?)/g)
      const target = symbolMatch?.find(t => t.includes('.') || t.includes('/') || t.length > 4)
      if (target) {
        const deps = await ci.getModuleDependencies(target).catch(() => null)
        if (deps) {
          const results = []
          for (const d of deps.directImports) results.push({ type: 'import', from: target, module: d.module, score: 0.8 })
          for (const d of deps.transitiveDeps) results.push({ type: 'transitiveImport', from: d.from, module: d.module, depth: d.depth, score: 0.6 })
          return results
        }
      }
    }
  } catch {}
  return []
}

function _fuseResults(symbolResults, fileResults, intentResults, query, topK) {
  const seen = new Set()
  const all = []
  for (const r of intentResults) {
    const key = `${r.type}:${r.name || r.file || ''}`
    if (!seen.has(key)) { seen.add(key); all.push(r) }
  }
  for (const r of symbolResults) {
    const key = `${r.type}:${r.name}:${r.file}`
    if (!seen.has(key)) { seen.add(key); all.push(r) }
  }
  for (const r of fileResults) {
    const key = `${r.type}:${r.path}`
    if (!seen.has(key)) { seen.add(key); all.push(r) }
  }
  all.sort((a, b) => (b.score || 0) - (a.score || 0))
  return all.slice(0, topK)
}
