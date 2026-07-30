// 码龙 — AST 解析工具 (v2 P2.1)
// 用 Rust 解析服务解析多语言源码，返回可序列化的简化 AST
// 详见：通天计划 §六

export const name = 'tool-ast-parse'
export const version = '0.2.0'

let _core, _langParser, _cachedParser

function hasErrorNode(node) {
  if (node.type === 'ERROR') return true
  for (let i = 0; i < node.childCount; i++) {
    if (hasErrorNode(node.child(i))) return true
  }
  return false
}

function register(core) {
  core.registerService('astParse', {
    parse(source, ext = '.js') {
      const tree = _langParser.parse(source, ext)
      if (!tree) return { ast: null, hasErrors: true, childCount: 0 }
      const ast = _langParser.simplifyAST(tree.rootNode, source, ext)
      return { ast, hasErrors: hasErrorNode(tree.rootNode), childCount: tree.rootNode.childCount }
    },

    parseFile(source) {
      return this.parse(source, '.js')
    },
  })
}

export async function init(core) {
  _core = core
  _langParser = core.getService('langParser')
  if (!_langParser) throw new Error('[ast-parse] lang-parser service required but not registered')
  register(core)
}

export async function start() {
  _core.log('info', '[ast-parse] ready')
}

export async function stop() {
  _langParser = null
}
