// 码龙 — 多语言解析器工厂 (v2 P3.0)
// 统一管理 tree-sitter 语言加载/缓存/符号提取/引用提取
// 支持双模式：Rust 服务优先，fallback 到 builtin
// 详见：通天计划 §六 码龙, P3-rust-parser-service.md

import Parser from 'tree-sitter'
import JavaScript from 'tree-sitter-javascript'
import Python from 'tree-sitter-python'
import Go from 'tree-sitter-go'
import Rust from 'tree-sitter-rust'
import { createRequire } from 'node:module'
import * as parseClient from './parse-client.js'
const _require = createRequire(import.meta.url)
const TypeScript = _require('tree-sitter-typescript/bindings/node/typescript.js')
const TSX = _require('tree-sitter-typescript/bindings/node/tsx.js')

export const name = 'malong-lang-parser'
export const version = '0.5.0'

const PARSE_MODE = process.env.MALONG_PARSE_MODE ?? 'shadow'  // 'rust' | 'builtin' | 'shadow'
let _core
let _mode = 'builtin'  // 'builtin' | 'rust-service'

export const LANG_MAP = {
  '.js': { lang: JavaScript, name: 'javascript' },
  '.mjs': { lang: JavaScript, name: 'javascript' },
  '.cjs': { lang: JavaScript, name: 'javascript' },
  '.ts': { lang: TypeScript, name: 'typescript' },
  '.tsx': { lang: TSX, name: 'tsx' },
  '.mts': { lang: TypeScript, name: 'typescript' },
  '.cts': { lang: TypeScript, name: 'typescript' },
  '.py': { lang: Python, name: 'python' },
  '.go': { lang: Go, name: 'go' },
  '.rs': { lang: Rust, name: 'rust' },
}

const ALL_EXTS = new Set(Object.keys(LANG_MAP))

function langFor(ext) {
  return LANG_MAP[ext]?.name || 'javascript'
}

function parserFor(ext) {
  const entry = LANG_MAP[ext]
  if (!entry) return null
  const p = new Parser()
  p.setLanguage(entry.lang)
  return p
}

// ── Language-specific symbol extraction ──

export const LANG_HANDLERS = {
  javascript: {
    extractSymbols(tree, source) {
      const symbols = []
      const imports = []
      function walk(node, depth = 0) {
        if (depth > 100) return
        if (node.type === 'function_declaration') {
          const name = node.childForFieldName('name')
          if (name) symbols.push({ name: source.slice(name.startIndex, name.endIndex), type: 'function', startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 })
        } else if (node.type === 'class_declaration') {
          const name = node.childForFieldName('name')
          if (name) symbols.push({ name: source.slice(name.startIndex, name.endIndex), type: 'class', startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 })
        } else if (node.type === 'method_definition') {
          const name = node.childForFieldName('name')
          if (name) symbols.push({ name: source.slice(name.startIndex, name.endIndex), type: 'method', startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 })
        } else if (node.type === 'import_statement') {
          const s = node.childForFieldName('source')
          if (s) imports.push({ target: source.slice(s.startIndex, s.endIndex).replace(/['"]/g, ''), kind: 'import' })
        } else if ((node.type === 'lexical_declaration' || node.type === 'variable_declaration') && (depth === 1 || !node.parent)) {
          for (const c of node.children) {
            if (c.type === 'variable_declarator') {
              const name = c.childForFieldName('name')
              if (name) symbols.push({ name: source.slice(name.startIndex, name.endIndex), type: 'variable', startLine: c.startPosition.row + 1, endLine: c.endPosition.row + 1 })
            }
          }
        } else if (node.type === 'export_statement') {
          for (let i = 0; i < node.childCount; i++) walk(node.child(i), depth)
          return
        }
        for (let i = 0; i < node.childCount; i++) walk(node.child(i), depth + 1)
      }
      walk(tree.rootNode)
      return { symbols, imports }
    },

    extractTopLevel(tree, source) {
      const syms = []
      function walk(node, depth = 0) {
        if (depth > 50) return
        if (node.type === 'function_declaration' && depth <= 1) {
          const name = node.childForFieldName('name')
          if (name) syms.push({ name: source.slice(name.startIndex, name.endIndex), type: 'fn', line: node.startPosition.row + 1 })
        } else if (node.type === 'class_declaration' && depth <= 1) {
          const name = node.childForFieldName('name')
          if (name) syms.push({ name: source.slice(name.startIndex, name.endIndex), type: 'class', line: node.startPosition.row + 1 })
        } else if (node.type === 'method_definition' && depth <= 2) {
          const name = node.childForFieldName('name')
          if (name) syms.push({ name: source.slice(name.startIndex, name.endIndex), type: 'method', line: node.startPosition.row + 1 })
        } else if (node.type === 'lexical_declaration' && depth <= 1) {
          for (const c of node.children) {
            if (c.type === 'variable_declarator') {
              const name = c.childForFieldName('name')
              if (name) syms.push({ name: source.slice(name.startIndex, name.endIndex), type: 'const', line: c.startPosition.row + 1 })
            }
          }
        } else if (node.type === 'export_statement') {
          for (let i = 0; i < node.childCount; i++) walk(node.child(i), depth)
          return
        }
        for (let i = 0; i < node.childCount; i++) walk(node.child(i), depth + 1)
      }
      walk(tree.rootNode)
      return syms
    },

    extractReferences(tree, source) {
      const refs = []
      function walk(node) {
        if (node.type === 'call_expression') {
          const fn = node.childForFieldName('function')
          if (fn) refs.push({ type: 'call', name: source.slice(fn.startIndex, fn.endIndex), line: node.startPosition.row + 1 })
        } else if (node.type === 'import_statement') {
          const sourceNode = node.childForFieldName('source')
          const imported = []
          for (const c of node.children) {
            if (c.type === 'import_specifier' || c.type === 'namespace_import') {
              const n = c.childForFieldName('name') || c.childForFieldName('local')
              if (n) imported.push(source.slice(n.startIndex, n.endIndex))
            }
          }
          refs.push({ type: 'import', module: sourceNode ? source.slice(sourceNode.startIndex, sourceNode.endIndex).replace(/['"]/g, '') : '', symbols: imported, line: node.startPosition.row + 1 })
        }
        for (let i = 0; i < node.childCount; i++) walk(node.child(i))
      }
      walk(tree.rootNode)
      return refs
    },

    extractAll(tree, source) {
      const symbols = []
      const refs = []
      function walk(node, depth = 0) {
        if (depth > 100) return
        if (node.type === 'export_statement') {
          for (let i = 0; i < node.childCount; i++) walk(node.child(i), depth)
          return
        }
        if (node.type === 'function_declaration') {
          const name = node.childForFieldName('name')
          if (name) symbols.push({ name: source.slice(name.startIndex, name.endIndex), type: 'function', startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 })
        } else if (node.type === 'class_declaration') {
          const name = node.childForFieldName('name')
          if (name) symbols.push({ name: source.slice(name.startIndex, name.endIndex), type: 'class', startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 })
        } else if (node.type === 'method_definition') {
          const name = node.childForFieldName('name')
          if (name) symbols.push({ name: source.slice(name.startIndex, name.endIndex), type: 'method', startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 })
        } else if ((node.type === 'lexical_declaration' || node.type === 'variable_declaration') && (depth === 1 || !node.parent)) {
          for (const c of node.children) {
            if (c.type === 'variable_declarator') {
              const name = c.childForFieldName('name')
              if (name) symbols.push({ name: source.slice(name.startIndex, name.endIndex), type: 'variable', startLine: c.startPosition.row + 1, endLine: c.endPosition.row + 1 })
            }
          }
        }
        if (node.type === 'call_expression') {
          const fn = node.childForFieldName('function')
          if (fn) refs.push({ type: 'call', name: source.slice(fn.startIndex, fn.endIndex), line: node.startPosition.row + 1 })
        } else if (node.type === 'import_statement') {
          const sourceNode = node.childForFieldName('source')
          const imported = []
          for (const c of node.children) {
            if (c.type === 'import_specifier' || c.type === 'namespace_import') {
              const n = c.childForFieldName('name') || c.childForFieldName('local')
              if (n) imported.push(source.slice(n.startIndex, n.endIndex))
            }
          }
          refs.push({ type: 'import', module: sourceNode ? source.slice(sourceNode.startIndex, sourceNode.endIndex).replace(/['"]/g, '') : '', symbols: imported, line: node.startPosition.row + 1 })
        }
        for (let i = 0; i < node.childCount; i++) walk(node.child(i), depth + 1)
      }
      walk(tree.rootNode)
      return { symbols, refs }
    },

    simplifyAST(node, source, depth = 0) {
      if (depth > 30) return null
      const INTERESTING_TYPES = new Set(['program', 'function_declaration', 'class_declaration', 'method_definition', 'arrow_function', 'lexical_declaration', 'variable_declaration', 'variable_declarator', 'import_statement', 'export_statement', 'export_specifier', 'import_specifier', 'assignment_expression', 'call_expression', 'member_expression', 'binary_expression', 'if_statement', 'for_statement', 'while_statement', 'return_statement', 'throw_statement', 'try_statement'])
      const result = { type: node.type, startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1, startCol: node.startPosition.column, endCol: node.endPosition.column }
      const nameField = node.childForFieldName('name') || node.childForFieldName('property')
      if (nameField) result.name = source.slice(nameField.startIndex, nameField.endIndex)
      if (node.childCount === 0 || !INTERESTING_TYPES.has(node.type)) {
        result.text = source.slice(node.startIndex, node.endIndex)
        if (result.text.length > 100) result.text = result.text.slice(0, 100) + '...'
        return result
      }
      const children = []
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i)
        if (child) {
          const simplified = this.simplifyAST(child, source, depth + 1)
          if (simplified) children.push(simplified)
        }
      }
      if (children.length > 0) result.children = children
      return result
    },
  },

  python: {
    extractSymbols(tree, source) {
      const symbols = []
      const imports = []
      function walk(node, depth = 0) {
        if (depth > 100) return
        if (node.type === 'function_definition') {
          const name = node.childForFieldName('name')
          if (name) symbols.push({ name: source.slice(name.startIndex, name.endIndex), type: 'function', startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 })
        } else if (node.type === 'class_definition') {
          const name = node.childForFieldName('name')
          if (name) symbols.push({ name: source.slice(name.startIndex, name.endIndex), type: 'class', startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 })
        } else if (node.type === 'decorated_definition') {
          for (const c of node.children) walk(c, depth + 1)
          return
        } else if (node.type === 'import_statement' || node.type === 'import_from_statement') {
          if (node.type === 'import_statement') {
            for (const c of node.children) {
              if (c.type === 'dotted_name') imports.push({ target: source.slice(c.startIndex, c.endIndex), kind: 'import' })
            }
          } else {
            const module = node.childForFieldName('module_name')
            if (module) {
              for (const c of node.children) {
                if (c.type === 'dotted_name' && c !== module) {
                  imports.push({ target: module ? `${source.slice(module.startIndex, module.endIndex)}.${source.slice(c.startIndex, c.endIndex)}` : source.slice(c.startIndex, c.endIndex), kind: 'import' })
                }
              }
              if (!node.children.some(c => c.type === 'dotted_name' && c !== module)) {
                imports.push({ target: source.slice(module.startIndex, module.endIndex), kind: 'import' })
              }
            }
          }
        } else if (node.type === 'assignment') {
          const left = node.childForFieldName('left')
          if (left && (left.type === 'identifier' || left.type === 'attribute')) {
            const name = source.slice(left.startIndex, left.endIndex).split('.')[0]
            if (/^[a-zA-Z_]/.test(name)) symbols.push({ name, type: 'variable', startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 })
          }
        }
        for (let i = 0; i < node.childCount; i++) walk(node.child(i), depth + 1)
      }
      walk(tree.rootNode)
      return { symbols, imports }
    },

    extractTopLevel(tree, source) {
      const syms = []
      function walk(node, depth = 0) {
        if (depth > 50) return
        if (node.type === 'function_definition') {
          const name = node.childForFieldName('name')
          if (name) syms.push({ name: source.slice(name.startIndex, name.endIndex), type: 'fn', line: node.startPosition.row + 1 })
        } else if (node.type === 'class_definition') {
          const name = node.childForFieldName('name')
          if (name) syms.push({ name: source.slice(name.startIndex, name.endIndex), type: 'class', line: node.startPosition.row + 1 })
        } else if (node.type === 'decorated_definition') {
          for (const c of node.children) walk(c, depth + 1)
          return
        } else if (node.type === 'assignment') {
          const left = node.childForFieldName('left')
          if (left && left.type === 'identifier') {
            const name = source.slice(left.startIndex, left.endIndex)
            if (/^[A-Z][A-Z0-9_]*$/.test(name)) syms.push({ name, type: 'const', line: node.startPosition.row + 1 })
          }
        }
        for (let i = 0; i < node.childCount; i++) walk(node.child(i), depth + 1)
      }
      walk(tree.rootNode)
      return syms
    },

    extractReferences(tree, source) {
      const refs = []
      function walk(node) {
        if (node.type === 'call') {
          const fn = node.childForFieldName('function')
          if (fn) refs.push({ type: 'call', name: source.slice(fn.startIndex, fn.endIndex), line: node.startPosition.row + 1 })
        } else if (node.type === 'import_statement') {
          for (const c of node.children) {
            if (c.type === 'dotted_name') {
              const mod = source.slice(c.startIndex, c.endIndex)
              refs.push({ type: 'import', module: mod, symbols: [], line: node.startPosition.row + 1 })
            }
          }
        } else if (node.type === 'import_from_statement') {
          const module = node.childForFieldName('module_name')
          const modName = module ? source.slice(module.startIndex, module.endIndex) : ''
          const imported = []
          for (const c of node.children) {
            if (c !== module && (c.type === 'dotted_name' || c.type === 'identifier')) imported.push(source.slice(c.startIndex, c.endIndex))
            else if (c.type === 'aliased_import') {
              const alias = c.childForFieldName('alias')
              if (alias) imported.push(source.slice(alias.startIndex, alias.endIndex))
            }
          }
          refs.push({ type: 'import', module: modName, symbols: imported, line: node.startPosition.row + 1 })
        }
        for (let i = 0; i < node.childCount; i++) walk(node.child(i))
      }
      walk(tree.rootNode)
      return refs
    },

    extractAll(tree, source) {
      const symbols = []
      const refs = []
      function walk(node, depth = 0) {
        if (depth > 100) return
        if (node.type === 'function_definition') {
          const name = node.childForFieldName('name')
          if (name) symbols.push({ name: source.slice(name.startIndex, name.endIndex), type: 'function', startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 })
        } else if (node.type === 'class_definition') {
          const name = node.childForFieldName('name')
          if (name) symbols.push({ name: source.slice(name.startIndex, name.endIndex), type: 'class', startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 })
        } else if (node.type === 'decorated_definition') {
          for (const c of node.children) walk(c, depth + 1)
          return
        } else if (node.type === 'assignment') {
          const left = node.childForFieldName('left')
          if (left && (left.type === 'identifier' || left.type === 'attribute')) {
            const name = source.slice(left.startIndex, left.endIndex).split('.')[0]
            if (/^[a-zA-Z_]/.test(name)) symbols.push({ name, type: 'variable', startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 })
          }
        }
        if (node.type === 'call') {
          const fn = node.childForFieldName('function')
          if (fn) refs.push({ type: 'call', name: source.slice(fn.startIndex, fn.endIndex), line: node.startPosition.row + 1 })
        } else if (node.type === 'import_statement') {
          for (const c of node.children) {
            if (c.type === 'dotted_name') {
              refs.push({ type: 'import', module: source.slice(c.startIndex, c.endIndex), symbols: [], line: node.startPosition.row + 1 })
            }
          }
        } else if (node.type === 'import_from_statement') {
          const module = node.childForFieldName('module_name')
          const modName = module ? source.slice(module.startIndex, module.endIndex) : ''
          const imported = []
          for (const c of node.children) {
            if (c !== module && (c.type === 'dotted_name' || c.type === 'identifier')) imported.push(source.slice(c.startIndex, c.endIndex))
            else if (c.type === 'aliased_import') {
              const alias = c.childForFieldName('alias')
              if (alias) imported.push(source.slice(alias.startIndex, alias.endIndex))
            }
          }
          refs.push({ type: 'import', module: modName, symbols: imported, line: node.startPosition.row + 1 })
        }
        for (let i = 0; i < node.childCount; i++) walk(node.child(i), depth + 1)
      }
      walk(tree.rootNode)
      return { symbols, refs }
    },

    simplifyAST(node, source, depth = 0) {
      return simplifyASTJS(node, source, depth)
    },
  },

  go: {
    extractSymbols(tree, source) {
      const symbols = []
      const imports = []
      function walk(node, depth = 0) {
        if (depth > 100) return
        if (node.type === 'function_declaration') {
          const name = node.childForFieldName('name')
          if (name) symbols.push({ name: source.slice(name.startIndex, name.endIndex), type: 'function', startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 })
        } else if (node.type === 'method_declaration') {
          const name = node.childForFieldName('name')
          if (name) symbols.push({ name: source.slice(name.startIndex, name.endIndex), type: 'method', startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 })
        } else if (node.type === 'type_declaration') {
          for (const c of node.children) {
            if (c.type === 'type_spec') {
              const name = c.childForFieldName('name')
              if (name) symbols.push({ name: source.slice(name.startIndex, name.endIndex), type: 'type', startLine: c.startPosition.row + 1, endLine: c.endPosition.row + 1 })
            }
          }
        } else if (node.type === 'import_declaration') {
          for (const c of node.children) {
            if (c.type === 'import_spec' || c.type === 'import_spec_list') {
              if (c.type === 'import_spec') {
                const p = c.childForFieldName('path')
                if (p) imports.push({ target: source.slice(p.startIndex, p.endIndex).replace(/"/g, ''), kind: 'import' })
              } else {
                for (const s of c.children) {
                  if (s.type === 'import_spec') {
                    const p = s.childForFieldName('path')
                    if (p) imports.push({ target: source.slice(p.startIndex, p.endIndex).replace(/"/g, ''), kind: 'import' })
                  }
                }
              }
            }
          }
        } else if (node.type === 'short_var_declaration' || node.type === 'var_declaration') {
          for (const c of node.children) {
            if (c.type === 'identifier') symbols.push({ name: source.slice(c.startIndex, c.endIndex), type: 'variable', startLine: c.startPosition.row + 1, endLine: c.endPosition.row + 1 })
            else if (c.type === 'var_spec') {
              const name = c.childForFieldName('name')
              if (name) symbols.push({ name: source.slice(name.startIndex, name.endIndex), type: 'variable', startLine: c.startPosition.row + 1, endLine: c.endPosition.row + 1 })
            }
          }
        }
        for (let i = 0; i < node.childCount; i++) walk(node.child(i), depth + 1)
      }
      walk(tree.rootNode)
      return { symbols, imports }
    },

    extractTopLevel(tree, source) {
      const syms = []
      function walk(node, depth = 0) {
        if (depth > 50) return
        if (node.type === 'function_declaration') {
          const name = node.childForFieldName('name')
          if (name) syms.push({ name: source.slice(name.startIndex, name.endIndex), type: 'fn', line: node.startPosition.row + 1 })
        } else if (node.type === 'method_declaration') {
          const name = node.childForFieldName('name')
          if (name) syms.push({ name: source.slice(name.startIndex, name.endIndex), type: 'method', line: node.startPosition.row + 1 })
        } else if (node.type === 'type_declaration') {
          for (const c of node.children) {
            if (c.type === 'type_spec') {
              const name = c.childForFieldName('name')
              if (name) syms.push({ name: source.slice(name.startIndex, name.endIndex), type: 'type', line: c.startPosition.row + 1 })
            }
          }
        } else if (node.type === 'const_declaration') {
          for (const c of node.children) {
            if (c.type === 'const_spec') {
              const name = c.childForFieldName('name')
              if (name) syms.push({ name: source.slice(name.startIndex, name.endIndex), type: 'const', line: c.startPosition.row + 1 })
            }
          }
        }
        for (let i = 0; i < node.childCount; i++) walk(node.child(i), depth + 1)
      }
      walk(tree.rootNode)
      return syms
    },

    extractReferences(tree, source) {
      const refs = []
      function walk(node) {
        if (node.type === 'call_expression') {
          const fn = node.childForFieldName('function')
          if (fn) refs.push({ type: 'call', name: source.slice(fn.startIndex, fn.endIndex), line: node.startPosition.row + 1 })
        } else if (node.type === 'import_declaration') {
          for (const c of node.children) {
            if (c.type === 'import_spec') {
              const p = c.childForFieldName('path')
              if (p) refs.push({ type: 'import', module: source.slice(p.startIndex, p.endIndex).replace(/"/g, ''), symbols: [], line: node.startPosition.row + 1 })
            } else if (c.type === 'import_spec_list') {
              for (const s of c.children) {
                if (s.type === 'import_spec') {
                  const p = s.childForFieldName('path')
                  if (p) refs.push({ type: 'import', module: source.slice(p.startIndex, p.endIndex).replace(/"/g, ''), symbols: [], line: s.startPosition.row + 1 })
                }
              }
            }
          }
        }
        for (let i = 0; i < node.childCount; i++) walk(node.child(i))
      }
      walk(tree.rootNode)
      return refs
    },

    extractAll(tree, source) {
      const symbols = []
      const refs = []
      function walk(node, depth = 0) {
        if (depth > 100) return
        if (node.type === 'function_declaration') {
          const name = node.childForFieldName('name')
          if (name) symbols.push({ name: source.slice(name.startIndex, name.endIndex), type: 'function', startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 })
        } else if (node.type === 'method_declaration') {
          const name = node.childForFieldName('name')
          if (name) symbols.push({ name: source.slice(name.startIndex, name.endIndex), type: 'method', startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 })
        } else if (node.type === 'type_declaration') {
          for (const c of node.children) {
            if (c.type === 'type_spec') {
              const name = c.childForFieldName('name')
              if (name) symbols.push({ name: source.slice(name.startIndex, name.endIndex), type: 'type', startLine: c.startPosition.row + 1, endLine: c.endPosition.row + 1 })
            }
          }
        } else if (node.type === 'short_var_declaration' || node.type === 'var_declaration') {
          for (const c of node.children) {
            if (c.type === 'identifier') symbols.push({ name: source.slice(c.startIndex, c.endIndex), type: 'variable', startLine: c.startPosition.row + 1, endLine: c.endPosition.row + 1 })
            else if (c.type === 'var_spec') {
              const name = c.childForFieldName('name')
              if (name) symbols.push({ name: source.slice(name.startIndex, name.endIndex), type: 'variable', startLine: c.startPosition.row + 1, endLine: c.endPosition.row + 1 })
            }
          }
        }
        if (node.type === 'call_expression') {
          const fn = node.childForFieldName('function')
          if (fn) refs.push({ type: 'call', name: source.slice(fn.startIndex, fn.endIndex), line: node.startPosition.row + 1 })
        } else if (node.type === 'import_declaration') {
          for (const c of node.children) {
            if (c.type === 'import_spec') {
              const p = c.childForFieldName('path')
              if (p) refs.push({ type: 'import', module: source.slice(p.startIndex, p.endIndex).replace(/"/g, ''), symbols: [], line: node.startPosition.row + 1 })
            } else if (c.type === 'import_spec_list') {
              for (const s of c.children) {
                if (s.type === 'import_spec') {
                  const p = s.childForFieldName('path')
                  if (p) refs.push({ type: 'import', module: source.slice(p.startIndex, p.endIndex).replace(/"/g, ''), symbols: [], line: s.startPosition.row + 1 })
                }
              }
            }
          }
        }
        for (let i = 0; i < node.childCount; i++) walk(node.child(i), depth + 1)
      }
      walk(tree.rootNode)
      return { symbols, refs }
    },

    simplifyAST(node, source, depth = 0) {
      return simplifyASTJS(node, source, depth)
    },
  },

  rust: {
    extractSymbols(tree, source) {
      const symbols = []
      const imports = []
      function walk(node, depth = 0) {
        if (depth > 100) return
        if (node.type === 'function_item') {
          const name = node.childForFieldName('name')
          if (name) symbols.push({ name: source.slice(name.startIndex, name.endIndex), type: 'function', startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 })
        } else if (node.type === 'struct_item') {
          const name = node.childForFieldName('name')
          if (name) symbols.push({ name: source.slice(name.startIndex, name.endIndex), type: 'class', startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 })
        } else if (node.type === 'enum_item') {
          const name = node.childForFieldName('name')
          if (name) symbols.push({ name: source.slice(name.startIndex, name.endIndex), type: 'type', startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 })
        } else if (node.type === 'trait_item') {
          const name = node.childForFieldName('name')
          if (name) symbols.push({ name: source.slice(name.startIndex, name.endIndex), type: 'type', startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 })
        } else if (node.type === 'impl_item') {
          const trait = node.childForFieldName('trait')
          const type = node.childForFieldName('type')
          if (type) symbols.push({ name: source.slice(type.startIndex, type.endIndex), type: 'method', startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1, implFor: trait ? source.slice(trait.startIndex, trait.endIndex) : '' })
        } else if (node.type === 'use_declaration') {
          for (const c of node.children) {
            if (c.type === 'use_as_clause') continue
            if (c.type === 'scoped_use_list') {
              const path = c.childForFieldName('path')
              const pathStr = path ? source.slice(path.startIndex, path.endIndex) : ''
              for (const item of c.children) {
                if (item.type === 'use_list') {
                  for (const u of item.children) {
                    if (u.type === 'identifier') imports.push({ target: `${pathStr}::${source.slice(u.startIndex, u.endIndex)}`, kind: 'import' })
                    else if (u.type === 'scoped_identifier') imports.push({ target: source.slice(u.startIndex, u.endIndex), kind: 'import' })
                  }
                }
              }
            } else if (c.type === 'scoped_identifier' || c.type === 'identifier') {
              imports.push({ target: source.slice(c.startIndex, c.endIndex), kind: 'import' })
            }
          }
        } else if (node.type === 'let_declaration') {
          const pat = node.childForFieldName('pattern')
          if (pat && pat.type === 'identifier') symbols.push({ name: source.slice(pat.startIndex, pat.endIndex), type: 'variable', startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 })
        }
        for (let i = 0; i < node.childCount; i++) walk(node.child(i), depth + 1)
      }
      walk(tree.rootNode)
      return { symbols, imports }
    },

    extractTopLevel(tree, source) {
      const syms = []
      function walk(node, depth = 0) {
        if (depth > 50) return
        if (node.type === 'function_item') {
          const name = node.childForFieldName('name')
          if (name) syms.push({ name: source.slice(name.startIndex, name.endIndex), type: 'fn', line: node.startPosition.row + 1 })
        } else if (node.type === 'struct_item') {
          const name = node.childForFieldName('name')
          if (name) syms.push({ name: source.slice(name.startIndex, name.endIndex), type: 'struct', line: node.startPosition.row + 1 })
        } else if (node.type === 'enum_item') {
          const name = node.childForFieldName('name')
          if (name) syms.push({ name: source.slice(name.startIndex, name.endIndex), type: 'enum', line: node.startPosition.row + 1 })
        } else if (node.type === 'trait_item') {
          const name = node.childForFieldName('name')
          if (name) syms.push({ name: source.slice(name.startIndex, name.endIndex), type: 'trait', line: node.startPosition.row + 1 })
        } else if (node.type === 'impl_item') {
          const type = node.childForFieldName('type')
          if (type) syms.push({ name: source.slice(type.startIndex, type.endIndex), type: 'impl', line: node.startPosition.row + 1 })
        } else if (node.type === 'const_item') {
          const name = node.childForFieldName('name')
          if (name) syms.push({ name: source.slice(name.startIndex, name.endIndex), type: 'const', line: node.startPosition.row + 1 })
        }
        for (let i = 0; i < node.childCount; i++) walk(node.child(i), depth + 1)
      }
      walk(tree.rootNode)
      return syms
    },

    extractReferences(tree, source) {
      const refs = []
      function walk(node) {
        if (node.type === 'call_expression') {
          const fn = node.childForFieldName('function')
          if (fn) refs.push({ type: 'call', name: source.slice(fn.startIndex, fn.endIndex), line: node.startPosition.row + 1 })
        } else if (node.type === 'use_declaration') {
          for (const c of node.children) {
            if (c.type === 'scoped_identifier') {
              refs.push({ type: 'import', module: source.slice(c.startIndex, c.endIndex), symbols: [], line: node.startPosition.row + 1 })
            } else if (c.type === 'scoped_use_list') {
              const path = c.childForFieldName('path')
              const pathStr = path ? source.slice(path.startIndex, path.endIndex) : ''
              for (const item of c.children) {
                if (item.type === 'use_list') {
                  for (const u of item.children) {
                    if (u.type === 'identifier') refs.push({ type: 'import', module: `${pathStr}::${source.slice(u.startIndex, u.endIndex)}`, symbols: [], line: u.startPosition.row + 1 })
                  }
                }
              }
            } else if (c.type === 'identifier') {
              refs.push({ type: 'import', module: source.slice(c.startIndex, c.endIndex), symbols: [], line: c.startPosition.row + 1 })
            }
          }
        }
        for (let i = 0; i < node.childCount; i++) walk(node.child(i))
      }
      walk(tree.rootNode)
      return refs
    },

    extractAll(tree, source) {
      const symbols = []
      const refs = []
      function walk(node, depth = 0) {
        if (depth > 100) return
        if (node.type === 'function_item') {
          const name = node.childForFieldName('name')
          if (name) symbols.push({ name: source.slice(name.startIndex, name.endIndex), type: 'function', startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 })
        } else if (node.type === 'struct_item') {
          const name = node.childForFieldName('name')
          if (name) symbols.push({ name: source.slice(name.startIndex, name.endIndex), type: 'class', startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 })
        } else if (node.type === 'enum_item') {
          const name = node.childForFieldName('name')
          if (name) symbols.push({ name: source.slice(name.startIndex, name.endIndex), type: 'type', startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 })
        } else if (node.type === 'trait_item') {
          const name = node.childForFieldName('name')
          if (name) symbols.push({ name: source.slice(name.startIndex, name.endIndex), type: 'type', startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 })
        } else if (node.type === 'impl_item') {
          const trait = node.childForFieldName('trait')
          const type = node.childForFieldName('type')
          if (type) symbols.push({ name: source.slice(type.startIndex, type.endIndex), type: 'method', startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1, implFor: trait ? source.slice(trait.startIndex, trait.endIndex) : '' })
        } else if (node.type === 'let_declaration') {
          const pat = node.childForFieldName('pattern')
          if (pat && pat.type === 'identifier') symbols.push({ name: source.slice(pat.startIndex, pat.endIndex), type: 'variable', startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 })
        }
        if (node.type === 'call_expression') {
          const fn = node.childForFieldName('function')
          if (fn) refs.push({ type: 'call', name: source.slice(fn.startIndex, fn.endIndex), line: node.startPosition.row + 1 })
        } else if (node.type === 'use_declaration') {
          for (const c of node.children) {
            if (c.type === 'use_as_clause') continue
            if (c.type === 'scoped_use_list') {
              const path = c.childForFieldName('path')
              const pathStr = path ? source.slice(path.startIndex, path.endIndex) : ''
              for (const item of c.children) {
                if (item.type === 'use_list') {
                  for (const u of item.children) {
                    if (u.type === 'identifier') refs.push({ type: 'import', module: `${pathStr}::${source.slice(u.startIndex, u.endIndex)}`, symbols: [], line: u.startPosition.row + 1 })
                    else if (u.type === 'scoped_identifier') refs.push({ type: 'import', module: source.slice(u.startIndex, u.endIndex), symbols: [], line: u.startPosition.row + 1 })
                  }
                }
              }
            } else if (c.type === 'scoped_identifier' || c.type === 'identifier') {
              refs.push({ type: 'import', module: source.slice(c.startIndex, c.endIndex), symbols: [], line: c.startPosition.row + 1 })
            }
          }
        }
        for (let i = 0; i < node.childCount; i++) walk(node.child(i), depth + 1)
      }
      walk(tree.rootNode)
      return { symbols, refs }
    },

    simplifyAST(node, source, depth = 0) {
      return simplifyASTJS(node, source, depth)
    },
  },
}

// TypeScript/TSX share JavaScript handler (compatible node types)
LANG_HANDLERS.typescript = LANG_HANDLERS.javascript
LANG_HANDLERS.tsx = LANG_HANDLERS.javascript

const COMMON_AST_TYPES = new Set([
  'source_file', 'module', 'program',
  'function_definition', 'function_declaration', 'function_item',
  'class_definition', 'class_declaration', 'struct_item',
  'let_declaration', 'variable_declaration',
  'import_statement', 'import_from_statement', 'import_declaration', 'use_declaration',
  'if_statement', 'for_statement', 'while_statement', 'loop_expression',
  'return_statement', 'call_expression',
])

function simplifyASTJS(node, source, depth = 0) {
  if (depth > 30) return null
  const result = { type: node.type, startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 }
  const nameField = node.childForFieldName('name')
  if (nameField) result.name = source.slice(nameField.startIndex, nameField.endIndex)
  if (node.childCount === 0 || !COMMON_AST_TYPES.has(node.type)) {
    result.text = source.slice(node.startIndex, node.endIndex)
    if (result.text && result.text.length > 100) result.text = result.text.slice(0, 100) + '...'
    return result
  }
  const children = []
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (child) {
      const simplified = simplifyASTJS(child, source, depth + 1)
      if (simplified) children.push(simplified)
    }
  }
  if (children.length > 0) result.children = children
  return result
}

// ── Shared helpers ──

function hasErrorNode(node) {
  if (node.type === 'ERROR') return true
  for (let i = 0; i < node.childCount; i++) {
    if (hasErrorNode(node.child(i))) return true
  }
  return false
}

// ── Plugin service ──

const _parserCache = {}

export async function init(core) {
  _core = core

  // env var 控制模式: MALONG_PARSE_MODE=builtin → 强制 builtin, 不连 Rust
  if (PARSE_MODE === 'builtin') {
    _mode = 'builtin'
    core.log('info', `[lang-parser] MALONG_PARSE_MODE=builtin, using builtin tree-sitter`)
  } else {
    await parseClient.init(core)
    const connected = await parseClient.connect()
    if (connected) {
      _mode = 'rust-service'
      const h = await parseClient.health().catch(() => null)
      core.log('info', `[lang-parser] connected to malong-parse v${h?.version || '?'} (pid=${h?.pid || '?'})`)
    } else if (PARSE_MODE === 'rust') {
      core.log('error', `[lang-parser] MALONG_PARSE_MODE=rust but malong-parse unavailable — FALLING BACK to builtin`)
      _mode = 'builtin'
    } else {
      _mode = 'builtin'
      core.log('warn', '[lang-parser] malong-parse unavailable, using builtin tree-sitter')
    }
  }

  // ── Tree-based complexity helpers (sync fallback for computeMetricsAsync) ──

  function calcCyclomaticFromTree(rootNode) {
    let score = 1
    function walk(n) {
      if (['if_statement', 'for_statement', 'while_statement', 'do_statement',
           'switch_expression', 'catch_clause', 'ternary_expression',
           'conditional_expression', 'case_expression'].includes(n.type)) score++
      for (let i = 0; i < n.childCount; i++) { const c = n.child(i); if (c) walk(c) }
    }
    walk(rootNode)
    return score
  }

  function calcCognitiveFromTree(rootNode) {
    let score = 0
    function walk(n, nesting) {
      const isBranch = ['if_statement', 'else_clause', 'for_statement', 'while_statement',
                        'do_statement', 'catch_clause', 'ternary_expression',
                        'conditional_expression'].includes(n.type)
      if (isBranch) { score += 1 + nesting; nesting++ }
      for (let i = 0; i < n.childCount; i++) { const c = n.child(i); if (c) walk(c, nesting) }
    }
    walk(rootNode, 0)
    return score
  }

  // ── Shadow mode helpers ──

  function _diffAndLog(method, builtin, rust) {
    if (!builtin || !rust) return
    let differs = false
    const compare = (a, b, path) => {
      if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) { differs = true; core.log('warn', `[lang-parser] shadow diff ${method}${path}: length ${a.length} vs ${b.length}`); return }
        for (let i = 0; i < a.length; i++) compare(a[i], b[i], `${path}[${i}]`)
      } else if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
        const keys = new Set([...Object.keys(a), ...Object.keys(b)])
        for (const k of keys) compare(a[k], b[k], `${path}.${k}`)
      } else if (a !== b) {
        differs = true
        if (typeof a === 'string' && typeof b === 'string' && a.length > 20) {
          if (a.slice(0, 20) !== b.slice(0, 20)) core.log('warn', `[lang-parser] shadow diff ${method}${path}: "${a.slice(0,20)}..." vs "${b.slice(0,20)}..."`)
        } else {
          core.log('warn', `[lang-parser] shadow diff ${method}${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`)
        }
      }
    }
    compare(builtin, rust, '')
    if (!differs) core.log('info', `[lang-parser] shadow OK ${method}`)
  }

  async function _runShadow(methodName, args, builtinFn) {
    const builtinResult = await builtinFn()
    if (_mode === 'shadow' && parseClient.isConnected()) {
      try {
        const rustResult = await parseClient[methodName](...args)
        _diffAndLog(methodName, builtinResult, rustResult)
      } catch (e) {
        // shadow comparison failure is non-fatal
      }
    }
    return builtinResult
  }

  core.registerService('langParser', {
    getParser(ext) {
      if (!_parserCache[ext]) {
        _parserCache[ext] = parserFor(ext)
      }
      return _parserCache[ext]
    },

    getLanguage(ext) { return langFor(ext) },
    getSupportedExts() { return ALL_EXTS },
    
    getMode() { return _mode },
    getConfigMode() { return PARSE_MODE },
    isRustService() { return _mode === 'rust-service' },

    parse(source, ext) {
      const p = this.getParser(ext)
      if (!p) return null
      return p.parse(source)
    },

    parseFromPath(filePath, source) {
      const i = filePath.lastIndexOf('.')
      const ext = i >= 0 ? filePath.slice(i) : ''
      return this.parse(source, ext)
    },

    extractSymbols(tree, source, ext) {
      const lang = langFor(ext)
      const handler = LANG_HANDLERS[lang]
      if (!handler) return { symbols: [], imports: [] }
      return handler.extractSymbols(tree, source)
    },

    extractTopLevel(tree, source, ext) {
      const lang = langFor(ext)
      const handler = LANG_HANDLERS[lang]
      if (!handler) return []
      return handler.extractTopLevel(tree, source)
    },

    extractReferences(tree, source, ext) {
      const lang = langFor(ext)
      const handler = LANG_HANDLERS[lang]
      if (!handler) return []
      return handler.extractReferences(tree, source)
    },

    extractAll(tree, source, ext) {
      const lang = langFor(ext)
      const handler = LANG_HANDLERS[lang]
      if (!handler || !handler.extractAll) return { symbols: [], refs: [] }
      return handler.extractAll(tree, source)
    },

    simplifyAST(node, source, ext, depth = 0) {
      const lang = langFor(ext)
      const handler = LANG_HANDLERS[lang]
      if (!handler) return null
      return handler.simplifyAST(node, source, depth)
    },

    hasErrors(tree) {
      return hasErrorNode(tree.rootNode)
    },

    classifyMessage(content) {
      const p = this.getParser('.js')
      if (!p) return { hasCode: false, codeRatio: 0, primaryType: 'text', nodeCount: 0 }
      const tree = p.parse(content)
      const hasCode = ['function_declaration', 'class_declaration', 'import_statement', 'export_statement', 'arrow_function', 'method_definition',
        'function_definition', 'class_definition', 'function_item', 'struct_item']
      let codeScore = 0
      const total = tree.rootNode.childCount || 1
      for (let i = 0; i < tree.rootNode.childCount; i++) {
        if (hasCode.includes(tree.rootNode.child(i).type)) codeScore++
      }
      return { hasCode: codeScore > 0, codeRatio: Math.min(1, codeScore / Math.max(1, total * 0.3)), primaryType: codeScore > 0 ? 'code' : 'text', nodeCount: tree.rootNode.childCount }
    },

    // ── 异步方法（优先使用 Rust 服务） ──
    
    async extractAllAsync(source, ext, filePath) {
      if (_mode === 'shadow') {
        return _runShadow('extractAll', [source, ext, filePath], async () => {
          const tree = this.parse(source, ext)
          if (!tree) return { symbols: [], refs: [] }
          return this.extractAll(tree, source, ext)
        })
      }
      if (_mode === 'rust-service') {
        try {
          return await parseClient.extractAll(source, ext, filePath)
        } catch (e) {
          core.log('warn', `[lang-parser] rust-service extractAll failed, fallback: ${e.message}`)
        }
      }
      const tree = this.parse(source, ext)
      if (!tree) return { symbols: [], refs: [] }
      return this.extractAll(tree, source, ext)
    },

    async extractSymbolsAsync(source, ext, filePath) {
      if (_mode === 'shadow') {
        return _runShadow('extractSymbols', [source, ext, filePath], async () => {
          const tree = this.parse(source, ext)
          if (!tree) return { symbols: [], imports: [] }
          return this.extractSymbols(tree, source, ext)
        })
      }
      if (_mode === 'rust-service') {
        try {
          return await parseClient.extractSymbols(source, ext, filePath)
        } catch (e) {
          core.log('warn', `[lang-parser] rust-service extractSymbols failed, fallback: ${e.message}`)
        }
      }
      const tree = this.parse(source, ext)
      if (!tree) return { symbols: [], imports: [] }
      return this.extractSymbols(tree, source, ext)
    },

    async extractTopLevelAsync(source, ext, filePath) {
      if (_mode === 'shadow') {
        return _runShadow('extractTopLevel', [source, ext, filePath], async () => {
          const tree = this.parse(source, ext)
          if (!tree) return []
          return this.extractTopLevel(tree, source, ext)
        })
      }
      if (_mode === 'rust-service') {
        try {
          return await parseClient.extractTopLevel(source, ext, filePath)
        } catch (e) {
          core.log('warn', `[lang-parser] rust-service extractTopLevel failed, fallback: ${e.message}`)
        }
      }
      const tree = this.parse(source, ext)
      if (!tree) return []
      return this.extractTopLevel(tree, source, ext)
    },

    async extractReferencesAsync(source, ext, filePath) {
      if (_mode === 'shadow') {
        return _runShadow('extractReferences', [source, ext, filePath], async () => {
          const tree = this.parse(source, ext)
          if (!tree) return []
          return this.extractReferences(tree, source, ext)
        })
      }
      if (_mode === 'rust-service') {
        try {
          return await parseClient.extractReferences(source, ext, filePath)
        } catch (e) {
          core.log('warn', `[lang-parser] rust-service extractReferences failed, fallback: ${e.message}`)
        }
      }
      const tree = this.parse(source, ext)
      if (!tree) return []
      return this.extractReferences(tree, source, ext)
    },

    async hasErrorsAsync(source, ext, filePath) {
      if (_mode === 'shadow') {
        return _runShadow('hasErrors', [source, ext, filePath], async () => {
          const tree = this.parse(source, ext)
          if (!tree) return false
          return this.hasErrors(tree)
        })
      }
      if (_mode === 'rust-service') {
        try {
          return await parseClient.hasErrors(source, ext, filePath)
        } catch (e) {
          core.log('warn', `[lang-parser] rust-service hasErrors failed, fallback: ${e.message}`)
        }
      }
      const tree = this.parse(source, ext)
      if (!tree) return false
      return this.hasErrors(tree)
    },

    async classifyMessageAsync(content) {
      if (_mode === 'shadow') {
        return _runShadow('classifyMessage', [content], async () => {
          return this.classifyMessage(content)
        })
      }
      if (_mode === 'rust-service') {
        try {
          return await parseClient.classifyMessage(content)
        } catch (e) {
          core.log('warn', `[lang-parser] rust-service classifyMessage failed, fallback: ${e.message}`)
        }
      }
      return this.classifyMessage(content)
    },

    async computeMetricsAsync(source, ext, filePath) {
      const buildResult = (tree, src) => {
        const cyc = calcCyclomaticFromTree(tree.rootNode)
        const cog = calcCognitiveFromTree(tree.rootNode)
        let maxNesting = 0, funcCount = 0, classCount = 0
        function walk(n, depth) {
          if (n.type === 'function_declaration' || n.type === 'function_definition' || n.type === 'function_item' ||
              n.type === 'method_definition' || n.type === 'method_declaration' || n.type === 'arrow_function') funcCount++
          if (n.type === 'class_declaration' || n.type === 'class_definition' || n.type === 'struct_item' ||
              n.type === 'enum_item' || n.type === 'trait_item') classCount++
          const isBranch = n.type === 'if_statement' || n.type === 'else_clause' || n.type === 'for_statement' ||
                           n.type === 'while_statement' || n.type === 'do_statement' || n.type === 'catch_clause' ||
                           n.type === 'ternary_expression' || n.type === 'conditional_expression'
          const nd = isBranch ? depth + 1 : depth
          if (nd > maxNesting) maxNesting = nd
          for (let i = 0; i < n.childCount; i++) { const c = n.child(i); if (c) walk(c, nd) }
        }
        walk(tree.rootNode, 0)
        const lines = src.split('\n')
        let commentCount = 0
        for (const line of lines) {
          const t = line.trim()
          if (t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || t.startsWith('#') || t.startsWith('"""') || t.startsWith("'''")) {
            commentCount += line.length
          }
        }
        const commentRatio = src.length > 0 ? Math.round((commentCount / src.length) * 10000) / 100 : 0
        return {
          cyclomatic_complexity: cyc,
          cognitive_complexity: cog,
          max_nesting_depth: maxNesting,
          function_count: funcCount,
          class_count: classCount,
          loc: lines.length,
          comment_ratio: commentRatio,
        }
      }

      if (_mode === 'shadow') {
        return _runShadow('computeMetrics', [source, ext, filePath], async () => {
          const tree = this.parse(source, ext)
          if (!tree) return null
          return buildResult(tree, source)
        })
      }
      if (_mode === 'rust-service') {
        try {
          return await parseClient.computeMetrics(source, ext, filePath)
        } catch (e) {
          core.log('warn', `[lang-parser] rust-service computeMetrics failed, fallback: ${e.message}`)
        }
      }
      const tree = this.parse(source, ext)
      if (!tree) return null
      return buildResult(tree, source)
    },

    async batchExtractAsync(files) {
      if (_mode === 'shadow') {
        return _runShadow('batchExtract', [files], async () => {
          return files.map(f => {
            const ext = f.path.slice(f.path.lastIndexOf('.'))
            const tree = this.parse(f.source, ext)
            if (!tree) return { path: f.path, symbols: [], refs: [] }
            const result = this.extractAll(tree, f.source, ext)
            return { path: f.path, ...result }
          })
        })
      }
      if (_mode === 'rust-service') {
        try {
          return await parseClient.batchExtract(files)
        } catch (e) {
          core.log('warn', `[lang-parser] rust-service batchExtract failed, fallback: ${e.message}`)
        }
      }
      return files.map(f => {
        const ext = f.path.slice(f.path.lastIndexOf('.'))
        const tree = this.parse(f.source, ext)
        if (!tree) return { path: f.path, symbols: [], refs: [] }
        const result = this.extractAll(tree, f.source, ext)
        return { path: f.path, ...result }
      })
    },
  })
  core.log('info', `[lang-parser] config=${PARSE_MODE} effective=${_mode} loaded=${Object.values(LANG_MAP).map(l => l.name).join(',')}`)
}

export async function start() {}

export async function stop() {
  for (const k of Object.keys(_parserCache)) delete _parserCache[k]
  await parseClient.disconnect()
}
