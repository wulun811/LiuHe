// dep_graph — 模块依赖 DAG/循环检测/影响分析
// B13 缺口四：file 变可选 + scope:"project" 全项目模块图 + 环检测
// （修复 2026-08-03 核查发现的死链：handler 曾期待 getModuleDependencies
// 产出 circular_dependencies 字段而该字段从未存在，环提示永不触发）

import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { attachStalenessWarning } from '../../staleness.js'
import { validateFilePath } from '../../error-codes.js'

function traceId() {
  return `trc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function makeError(code, message, suggestion) {
  return { error: code, message, ...(suggestion ? { suggestion } : {}), trace_id: traceId() }
}

export async function handle(args, context) {
  const { codeIndexService, getWorkspaceDir } = context
  const workspaceDir = args?.workspace_dir

  if (typeof workspaceDir !== 'string' || !workspaceDir) {
    return makeError('missing_parameter', 'workspace_dir is required', 'Provide the absolute path to the project root directory. Call reindex first if this is a new workspace.')
  }

  const dbPath = join(getWorkspaceDir(workspaceDir), 'code-index.db')
  if (!existsSync(dbPath)) {
    return makeError('workspace_not_indexed', `Workspace not indexed: ${workspaceDir}`, `Call reindex(workspace_dir="${workspaceDir}") first`)
  }

  if (!codeIndexService) {
    return makeError('service_unavailable', 'codeIndex service not available', 'Check MCP server configuration and ensure code-index.js is loaded')
  }

  await codeIndexService.initWorkspace(workspaceDir)

  // B13：scope:"project" 全项目模式（省略 file）——模块图 + 环检测
  if (args?.scope === 'project' || !args?.file) {
    try {
      const graph = codeIndexService.buildModuleGraph()
      const cycles = codeIndexService.findModuleCycles(graph.nodes, graph.edges)
      const truncated = graph.nodes.length > MAX_PROJECT_NODES
      return {
        scope: 'project',
        file: null,
        nodes: graph.nodes.length,
        edges: graph.edges.length,
        cycles: cycles.slice(0, MAX_PROJECT_CYCLES).map(c => ({
          cycle: c.cycle,
          length: c.length,
          severity: c.length <= 2 ? 'major' : 'warning',
        })),
        cycle_count: cycles.length,
        truncated,
        ...(truncated ? { warning: `Project exceeds ${MAX_PROJECT_NODES} nodes; graph is partial.` } : {}),
        next_step: cycles.length > 0
          ? 'Cycles detected. Use fix_imports to resolve, or inspect each cycle entry for direction of dependency.'
          : 'No module cycles. Safe to refactor imports.',
      }
    } catch (e) {
      return makeError('graph_failed', `Failed to build project graph: ${e.message}`, 'Ensure the workspace is indexed (reindex) and refs contain import rows.')
    }
  }

  const file = args.file
  // r54(P0-1): staleness/indexFile 前必须先校验——否则 `../` 经 checkFileStaleness 自动索引逃逸 workspace
  const v = validateFilePath(file, workspaceDir)
  if (v.blocked) {
    return makeError('PATH_BLOCKED', `file blocked: ${v.detail}`, 'Provide a file path inside workspace_dir (no "..", no absolute paths outside workspace)')
  }
  // R19-②：getModuleDependencies 不走服务层 7 出口——显式调服务层统一入口（带守卫，行为等价旧 checkFileStaleness）
  const staleness = await codeIndexService.ensureFreshFile?.(file)
  // r54(P2): depth 钳制 [1,10]（manifest 称 max 10，旧实现无钳制可致 transitive 输出爆炸）
  const depthRaw = parseInt(args?.depth)
  const depDepth = Number.isNaN(depthRaw) ? 3 : Math.max(1, Math.min(depthRaw, 10))
  const result = await codeIndexService.getModuleDependencies(file, { depth: depDepth })

  // 单文件模式环判定：复用 getModuleDependencies 依赖带内判定（本文件是否出现在自己的传递依赖链）——
  // R22-⑰（第四轮审核 P1）：不再每次构建全项目图（O(V+E)，大仓 >2000 文件数百 ms）。
  // R22-⑱（第五轮核实）：basename 比较会误判同名跨目录（src/a.js ↔ lib/a.js）——改路径解析后精确比较。
  let inCycle = false
  try {
    const deps = result.deps || result
    const posix = (p) => String(p).split('\\').join('/')
    const wsPrefix = posix(workspaceDir).endsWith('/') ? posix(workspaceDir) : posix(workspaceDir) + '/'
    const fileRel = posix(file).startsWith(wsPrefix)
      ? posix(file).slice(wsPrefix.length)
      : posix(file).replace(/^\.\//, '')
    // 相对 from 目录解析 import 说明符 → 精确目标路径（无 basename 歧义）
    const resolveRel = (fromPath, mod) => {
      const segs = posix(fromPath).split('/')
      segs.pop()
      for (const s of posix(String(mod)).split('/')) {
        if (s === '' || s === '.') continue
        if (s === '..') segs.pop()
        else segs.push(s)
      }
      return segs.join('/')
    }
    const trans = deps.transitiveDeps || []
    inCycle = (deps.directImports || []).some(i => i.module && resolveRel(fileRel, i.module) === fileRel)
      || trans.some(t => t.module && resolveRel(t.from, t.module) === fileRel)
  } catch {}
  result.cycle_scan = 'dependency-bounded (depth 3); use scope=project for full-graph cycle detection'

  // r22：next_step 补 symbol——取文件首个顶层 function/class 名，impact 直接可查
  let firstSymbol = null
  try {
    const outline = await codeIndexService.getFileOutline(file, { depth: 1, includeRefs: false, includeTestRefs: false, maxItems: 0 })
    if (outline?.outline?.length) {
      const top = outline.outline.find(s => s.type === 'function' || s.type === 'class' || s.type === 'method')
      if (top) firstSymbol = top.name
    }
  } catch {}
  const impactHint = firstSymbol
    ? `impact_analysis(file="${file}", symbol="${firstSymbol}")`
    : `impact_analysis(file="${file}")`
  result.in_cycle = inCycle
  result.next_step = inCycle
    ? 'File participates in a module cycle. Use fix_imports to resolve.'
    : `To modify a dependency, check impact first: ${impactHint}`
  return attachStalenessWarning(result, staleness)
}

const MAX_PROJECT_NODES = 2000
const MAX_PROJECT_CYCLES = 20
