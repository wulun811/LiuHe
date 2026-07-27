// 码龙 — 依赖图工具 (v1a)
// 模块依赖 DAG 分析，循环依赖检测，影响分析
// 详见：通天计划 §六

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, extname, dirname, resolve } from 'node:path'

export const name = 'tool-dep-graph'
export const version = '0.1.0'

let _core

const CACHED_EXT = new Set(['.js', '.mjs', '.cjs', '.json'])
const IGNORE_DIRS = new Set(['node_modules', '.git', '.tusunsun', 'dist', 'build', 'coverage'])

function parseImports(source) {
  const imports = []
  // Static import
  for (const m of source.matchAll(/import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+)?['"]([^'"]+)['"]/g)) {
    imports.push({ module: m[1], type: 'static' })
  }
  // Dynamic import
  for (const m of source.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    imports.push({ module: m[1], type: 'dynamic' })
  }
  // require
  for (const m of source.matchAll(/(?:require|require\.resolve)\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    imports.push({ module: m[1], type: 'require' })
  }
  return imports
}

function collectJSFiles(dir, max = 500) {
  const files = []
  function walk(d) {
    if (files.length >= max) return
    let entries
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (IGNORE_DIRS.has(e.name) || e.name.startsWith('.')) continue
      const full = join(d, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.isFile() && (CACHED_EXT.has(extname(e.name)) && e.name !== 'package-lock.json')) {
        if (statSync(full).size < 500000) files.push(full)
      }
    }
  }
  walk(dir)
  return files
}

function resolveModulePath(module, fromFile) {
  if (module.startsWith('.') || module.startsWith('/')) {
    const baseDir = dirname(fromFile)
    // Try exact, then .js, then .mjs, then index.js
    for (const ext of ['', '.js', '.mjs', '.cjs', '/index.js', '/index.mjs']) {
      const resolved = resolve(baseDir, module + ext)
      try { if (statSync(resolved).isFile()) return resolved } catch {}
    }
  }
  return null
}

function buildGraph(rootDir) {
  const files = collectJSFiles(rootDir)
  const nodes = []
  const edges = []
  const fileMap = {}

  for (const f of files) {
    const rel = relative(rootDir, f)
    const source = readFileSync(f, 'utf-8')
    const imports = parseImports(source)
    nodes.push({ path: rel, imports: imports.length, size: source.length })
    fileMap[rel] = f

    for (const imp of imports) {
      if (imp.module.startsWith('.')) {
        const resolved = resolveModulePath(imp.module, f)
        if (resolved) {
          edges.push({
            from: rel,
            to: relative(rootDir, resolved),
            type: imp.type,
          })
        }
      }
    }
  }

  return { nodes, edges }
}

function findCycles(nodes, edges) {
  const adj = {}
  for (const n of nodes) adj[n.path] = []
  for (const e of edges) {
    if (adj[e.from]) adj[e.from].push(e.to)
  }

  const visited = new Set()
  const stack = new Set()
  const cycles = []

  function dfs(path, trail) {
    visited.add(path)
    stack.add(path)
    trail.push(path)

    for (const next of adj[path] || []) {
      if (!adj[next]) continue
      if (stack.has(next)) {
        const idx = trail.indexOf(next)
        cycles.push({ cycle: trail.slice(idx).concat(next), length: trail.length - idx })
      } else if (!visited.has(next)) {
        dfs(next, trail)
      }
    }

    stack.delete(path)
    trail.pop()
  }

  for (const n of nodes) {
    if (!visited.has(n.path)) dfs(n.path, [])
  }

  return cycles
}

function impactAnalysis(targetPath, nodes, edges) {
  const adj = {}
  for (const n of nodes) adj[n.path] = []
  for (const e of edges) {
    if (adj[e.from]) adj[e.from].push(e.to)
  }

  // Reverse graph to find dependents
  const reverseAdj = {}
  for (const n of nodes) reverseAdj[n.path] = []
  for (const e of edges) {
    if (reverseAdj[e.to]) reverseAdj[e.to].push(e.from)
  }

  const impacted = []
  const queue = [targetPath]
  const visited = new Set(queue)

  while (queue.length > 0) {
    const current = queue.shift()
    for (const dependent of reverseAdj[current] || []) {
      if (!visited.has(dependent)) {
        visited.add(dependent)
        impacted.push(dependent)
        queue.push(dependent)
      }
    }
  }

  return { target: targetPath, impacted, total: impacted.length }
}

function register(core) {
  core.registerService('depGraph', {
    analyze(rootDir) {
      const graph = buildGraph(rootDir)
      const cycles = findCycles(graph.nodes, graph.edges)
      return {
        files: graph.nodes.length,
        edges: graph.edges.length,
        cycles,
        hasCycles: cycles.length > 0,
        graph,
      }
    },

    findCycles(rootDir) {
      const { nodes, edges } = buildGraph(rootDir)
      return findCycles(nodes, edges)
    },

    impact(targetFile, rootDir) {
      const { nodes, edges } = buildGraph(rootDir)
      return impactAnalysis(targetFile, nodes, edges)
    },
  })
}

export async function init(core) {
  _core = core
  register(core)
}

export async function start() {
  _core.log('info', '[dep-graph] ready')
}

export async function stop() {}

export { buildGraph, findCycles, impactAnalysis }
