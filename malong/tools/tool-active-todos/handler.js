import { join, extname } from 'node:path'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'

const TODO_RE = /(?:#|\/\/|\/\*|\*|--)\s*(TODO|FIXME|XXX|HACK)\s*(?:\((\w+)\))?\s*[:\-]?\s*(.*)/i
const SOURCE_EXTS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.go', '.rs', '.java', '.rb', '.c', '.cpp', '.h', '.php'])
const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', 'dist', 'build', '.next', 'fixtures', 'test-fixtures', 'mock_data'])
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000

function walkFiles(baseDir, dir, files, maxFiles) {
  if (files.length >= maxFiles) return
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    if (files.length >= maxFiles) break
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      walkFiles(baseDir, fullPath, files, maxFiles)
    } else if (entry.isFile() && SOURCE_EXTS.has(extname(entry.name))) {
      files.push(fullPath.startsWith(baseDir + '/') ? fullPath.slice(baseDir.length + 1) : fullPath)
    }
  }
}

export async function handle(args, context) {
  const workspaceDir = args?.workspace_dir
  if (!workspaceDir) {
    return { error: 'missing_parameter', message: 'workspace_dir is required' }
  }

  const scope = args?.scope || '.'
  const currentFiles = new Set((args?.current_files || []).map(f => {
    if (f.startsWith(workspaceDir + '/')) return f.slice(workspaceDir.length + 1)
    if (f.startsWith('./')) return f.slice(2)
    return f
  }))
  let scanDir = scope === '.' ? workspaceDir : join(workspaceDir, scope)

  // 检测 scope 是否为文件路径（而非目录）
  if (scope !== '.' && existsSync(scanDir)) {
    const stat = statSync(scanDir)
    if (stat.isFile()) {
      // 直接扫描该文件
      const relPath = scanDir.startsWith(workspaceDir + '/') ? scanDir.slice(workspaceDir.length + 1) : scanDir
      const absPath = scanDir
      let lines
      try { lines = readFileSync(absPath, 'utf-8').split('\n') } catch { return { scope, total_todos: 0, todos: [], truncated: false, summary: { high: 0, medium: 0, low: 0 }, scanned_files: 0 } }

      const todos = []
      for (let i = 0; i < lines.length; i++) {
        const m = TODO_RE.exec(lines[i])
        if (m) {
          todos.push({
            type: m[1].toUpperCase(),
            file: relPath,
            line: i + 1,
            content: m[3].trim(),
            author: m[2] || null,
          })
        }
      }

      const now = Date.now()
      for (const t of todos) {
        let mtime = 0
        try { mtime = statSync(join(workspaceDir, t.file)).mtimeMs } catch {}
        t.file_mtime = mtime > 0 ? new Date(mtime).toISOString() : null

        if (currentFiles.has(t.file)) {
          t.priority = 'high'
          t.reason = '文件正在被编辑'
        } else if (now - mtime < SEVEN_DAYS) {
          const days = Math.floor((now - mtime) / 86400000)
          t.priority = 'medium'
          t.reason = `文件 ${days} 天前修改过`
        } else {
          const days = mtime > 0 ? Math.floor((now - mtime) / 86400000) : null
          t.priority = 'low'
          t.reason = days !== null ? `${days} 天前修改，文件未动` : '无法获取修改时间'
        }
      }

      const order = { high: 0, medium: 1, low: 2 }
      todos.sort((a, b) => order[a.priority] - order[b.priority])

      const summary = { high: 0, medium: 0, low: 0 }
      for (const t of todos) summary[t.priority]++

      return {
        scope,
        total_todos: todos.length,
        todos: todos.slice(0, 50),
        truncated: todos.length > 50,
        summary,
        scanned_files: 1,
      }
    }
  }

  const files = []
  walkFiles(workspaceDir, scanDir, files, 500)

  const todos = []
  for (const relPath of files) {
    const absPath = join(workspaceDir, relPath)
    let lines
    try { lines = readFileSync(absPath, 'utf-8').split('\n') } catch { continue }

    for (let i = 0; i < lines.length; i++) {
      const m = TODO_RE.exec(lines[i])
      if (m) {
        todos.push({
          type: m[1].toUpperCase(),
          file: relPath,
          line: i + 1,
          content: m[3].trim(),
          author: m[2] || null,
        })
      }
    }
  }

  const now = Date.now()
  for (const t of todos) {
    let mtime = 0
    try { mtime = statSync(join(workspaceDir, t.file)).mtimeMs } catch {}
    t.file_mtime = mtime > 0 ? new Date(mtime).toISOString() : null

    if (currentFiles.has(t.file)) {
      t.priority = 'high'
      t.reason = '文件正在被编辑'
    } else if (now - mtime < SEVEN_DAYS) {
      const days = Math.floor((now - mtime) / 86400000)
      t.priority = 'medium'
      t.reason = `文件 ${days} 天前修改过`
    } else {
      const days = mtime > 0 ? Math.floor((now - mtime) / 86400000) : null
      t.priority = 'low'
      t.reason = days !== null ? `${days} 天前修改，文件未动` : '无法获取修改时间'
    }
  }

  const order = { high: 0, medium: 1, low: 2 }
  todos.sort((a, b) => order[a.priority] - order[b.priority])

  const summary = { high: 0, medium: 0, low: 0 }
  for (const t of todos) summary[t.priority]++

  let nextStep
  if (summary.high > 0) {
    nextStep = `Address ${summary.high} high-priority TODOs in current files.`
  } else if (todos.length > 0) {
    nextStep = `Review TODOs above. Prioritize by file modification recency.`
  } else {
    nextStep = 'No TODOs found. Code is clean.'
  }

  return {
    scope,
    total_todos: todos.length,
    todos: todos.slice(0, 50),
    truncated: todos.length > 50,
    summary,
    scanned_files: files.length,
    next_step: nextStep,
  }
}
