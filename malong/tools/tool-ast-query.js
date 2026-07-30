// 码龙 — AST 查询工具 (v2 P2.1)
// 用 Rust 解析服务查询多语言符号表、引用、调用图
// 详见：通天计划 §六

export const name = 'tool-ast-query'
export const version = '0.2.0'

let _core, _langParser

function extractSymbolTable(source) {
  const tree = _langParser.parse(source, '.js')
  if (!tree) return { symbols: [], hasErrors: false }
  const { symbols } = _langParser.extractSymbols(tree, source, '.js')
  const exported = symbols.filter(s => s.type !== 'import')
  return { symbols: exported, hasErrors: _langParser.hasErrors(tree) }
}

function extractReferences(source) {
  const tree = _langParser.parse(source, '.js')
  if (!tree) return []
  return _langParser.extractReferences(tree, source, '.js')
}

function extractCallGraph(source, filePath) {
  const { symbols } = extractSymbolTable(source)
  const refs = extractReferences(source)
  const calls = refs.filter(r => r.type === 'call')
  const imports = refs.filter(r => r.type === 'import')

  const definedNames = new Set(symbols.map(s => s.name))

  return {
    functions: symbols.filter(s => s.type === 'function' || s.type === 'method'),
    definedCalls: calls.filter(c => definedNames.has(c.name)),
    externalCalls: calls.filter(c => !definedNames.has(c.name)),
    imports,
    file: filePath || '(inline)',
  }
}

function register(core) {
  core.registerService('astQuery', {
    querySymbols(source) {
      return extractSymbolTable(source)
    },

    queryReferences(source) {
      return extractReferences(source)
    },

    queryCallGraph(source, filePath) {
      return extractCallGraph(source, filePath)
    },
  })
}

export async function init(core) {
  _core = core
  _langParser = core.getService('langParser')
  if (!_langParser) throw new Error('[ast-query] lang-parser service required but not registered')
  register(core)
}

export async function start() {
  _core.log('info', '[ast-query] ready')
}

export async function stop() {
  _langParser = null
}
