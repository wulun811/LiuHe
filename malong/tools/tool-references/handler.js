// 六合工具集 — references handler

import { join } from 'node:path'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { isConstantName } from '../misuse-helpers.js'

function detectMisuse(symbol) {
  if (!symbol) return null
  if (isConstantName(symbol)) {
    return {
      warning: 'likely_wrong_tool',
      suggestion: `"${symbol}" looks like a constant. For tracing its value and finding hardcoded copies, use trace_symbol(symbol="${symbol}").`
    }
  }
  return null
}

export async function handle(args, context) {
  const { codeIndexService, getWorkspaceDir } = context
  const workspaceDir = args?.workspace_dir

  if (!workspaceDir) {
    return { error: 'missing_parameter', message: 'workspace_dir is required', suggestion: 'Provide the absolute path to the project root directory. Call reindex first if this is a new workspace.' }
  }

  // 检查 workspace 是否已索引
  const dbPath = join(getWorkspaceDir(workspaceDir), 'code-index.db')
  if (!existsSync(dbPath)) {
    return { 
      error: 'workspace_not_indexed',
      message: `Workspace not indexed: ${workspaceDir}`,
      suggestion: `Call reindex(workspace_dir="${workspaceDir}") first`
    }
  }

  if (!codeIndexService) {
    return { error: 'service_unavailable', message: 'codeIndex service not available', suggestion: 'Check MCP server configuration and ensure code-index.js is loaded' }
  }

  // 初始化 workspace 数据库
  codeIndexService.initWorkspace(workspaceDir)

  const symbol = args?.symbol || ''
  if (!symbol) {
    return { error: 'missing_parameter', message: 'symbol is required', suggestion: 'Provide a symbol name / call target to find references for' }
  }

  const misuseWarning = detectMisuse(symbol)
  let results = await codeIndexService.getReferences(symbol, args?.file)
  const result = { symbol, results, count: results.length, workspace_dir: workspaceDir }

  if (results.length === 0) {
    const textRefs = findSymbolTextRefs(workspaceDir, symbol, args?.file, 30)
    if (textRefs.length > 0) {
      result.results = textRefs
      result.count = textRefs.length
      result.search_method = 'text_fallback'
    } else {
      result.suggestion = `No references found. If files were recently added, call reindex(workspace_dir="${workspaceDir}") to update the index.`
    }
  }
  
  if (misuseWarning) {
    result.misuse_warning = misuseWarning
  }

  if (results.length > 0) {
    result.next_step = `For test refs: find_tests(file="${args?.file || ''}")`
  }

  return result
}

const SOURCE_EXTS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts', '.py', '.go', '.rs', '.java', '.rb', '.php'])

function findSymbolTextRefs(workspaceDir, symbol, excludeFile, maxResults) {
  const results = []
  const re = new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
  const scanned = { files: 0 }
  walkRefs(workspaceDir, workspaceDir, re, excludeFile, results, scanned, 300, maxResults)
  return results
}

function walkRefs(baseDir, currentDir, re, excludeFile, results, scanned, maxFiles, maxResults) {
  if (scanned.files >= maxFiles || results.length >= maxResults) return
  let entries
  try { entries = readdirSync(currentDir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    if (scanned.files >= maxFiles || results.length >= maxResults) break
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const fullPath = join(currentDir, entry.name)
    if (entry.isDirectory()) {
      walkRefs(baseDir, fullPath, re, excludeFile, results, scanned, maxFiles, maxResults)
    } else if (entry.isFile()) {
      const ext = fullPath.slice(fullPath.lastIndexOf('.'))
      if (!SOURCE_EXTS.has(ext)) continue
      scanned.files++
      const relPath = fullPath.startsWith(baseDir + '/') ? fullPath.slice(baseDir.length + 1) : fullPath
      if (relPath === excludeFile) continue
      try {
        const content = readFileSync(fullPath, 'utf-8')
        const lines = content.split('\n')
        for (let i = 0; i < lines.length; i++) {
          if (!re.test(lines[i])) continue
          // P2-B7：回退路径的 \bsymbol\b 会命中字符串/注释里的假引用（console.log('max')）
          // —— 行级剥字符串与注释后再确认，字符串内命中不算真引用
          const code = lines[i]
            .replace(/\/\*[\s\S]*?\*\//g, ' ')
            .replace(/\/\/.*$|#.*$/g, ' ')
            .replace(/`(?:[^`\\]|\\.)*`/g, ' ')
            .replace(/"(?:[^"\\]|\\.)*"/g, ' ')
            .replace(/'(?:[^'\\]|\\.)*'/g, ' ')
          if (!re.test(code)) continue
          results.push({ path: relPath, kind: 'reference', target_name: re.source.replace(/\\b/g, ''), line: i + 1 })
          if (results.length >= maxResults) break
        }
      } catch {}
    }
  }
}
