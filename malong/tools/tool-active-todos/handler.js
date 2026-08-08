import { join, extname, sep } from 'node:path'
import { existsSync, readFileSync, readdirSync, statSync, realpathSync } from 'node:fs'
import { stripStrings } from '../../string-utils.js'
import { DEFAULT_IGNORE_DIRS } from '../../file-collector.js'

const TODO_RE = /(?:#|\/\/|\/\*|\*|--)\s*(TODO|FIXME|XXX|HACK)\s*(?:\((\w+)\))?\s*[:\-]?\s*(.*)/i
// r28-fix：补 .java/.sh/.bash（TODO 纯文本扫描，rb/php 保留无碍）
const SOURCE_EXTS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.go', '.rs', '.java', '.rb', '.c', '.cpp', '.h', '.php', '.sh', '.bash'])
// R22-⑪：SKIP_DIRS 与 file-collector 权威忽略集统一（此前是子集且口径不一致——collector 有的 .hg/.svn/out/target 这里漏扫）；fixtures 类为 TODO 扫描主动选择保留
const SKIP_DIRS = new Set([...DEFAULT_IGNORE_DIRS, 'fixtures', 'test-fixtures', 'mock_data'])
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
      files.push((fullPath.startsWith(baseDir + sep) ? fullPath.slice(baseDir.length + 1) : fullPath).replace(/\\/g, '/'))
    }
  }
}

export async function handle(args, context) {
  const workspaceDir = args?.workspace_dir
  if (!workspaceDir) {
    return { error: 'missing_parameter', message: 'workspace_dir is required' }
  }
  // R22-⑯：非字符串 workspace_dir 让 .endsWith 裸抛 TypeError
  if (typeof workspaceDir !== 'string') {
    return { error: 'invalid_input', message: `workspace_dir must be a string (got ${typeof workspaceDir})` }
  }

  const scope = args?.scope || '.'
  // R22-⑪（拷打发现）：非字符串 scope 让 split 裸抛——前置类型校验
  if (typeof scope !== 'string') {
    return { error: 'invalid_input', message: `scope must be a string (got ${typeof scope})` }
  }
  // r54(P2): scope 含 .. 会越权遍历 workspace 外目录
  if (scope.split(/[\\/]/).includes('..')) {
    return { error: 'invalid_input', message: `scope contains "..": ${scope}` }
  }
  // r11(L11)：workspaceDir 尾斜杠归一化——旧实现 `workspaceDir + '/'` 在用户传尾斜杠路径时拼成 `//` 恒不匹配（r54 修过 edit-sandbox 同款，此处漏网）
  // r56: Windows 分隔符归一化——旧 wsPrefix 拼出反斜杠路径+正斜杠结尾（`N:\ws\fixtures/`），
  //      current_files 绝对路径（全反斜杠）startsWith 恒 false → 绝对路径永不 boost（对抗性 A4 实测）
  const wsNorm = workspaceDir.replace(/\\/g, '/')
  const wsPrefix = wsNorm.endsWith('/') ? wsNorm : wsNorm + '/'
  const toRel = (abs) => {
    const norm = abs.replace(/\\/g, '/')
    return norm.startsWith(wsPrefix) ? norm.slice(wsPrefix.length) : norm
  }
  const currentFiles = new Set((args?.current_files || []).map(f => {
    if (typeof f !== 'string') return ''
    const norm = f.replace(/\\/g, '/')
    if (norm.startsWith(wsPrefix)) return norm.slice(wsPrefix.length)
    if (norm.startsWith('./')) return norm.slice(2)
    return norm
  }))
  let scanDir = scope === '.' ? workspaceDir : join(workspaceDir, scope)

  // 检测 scope 是否为文件路径（而非目录）
  // R22-⑯：symlink 逃逸守卫上移——目录/文件 scope 统一 realpath 检测（R22-⑮ 只堵了文件分支，目录 symlink 绕行）
  if (scope !== '.' && existsSync(scanDir)) {
    try {
      const realWs = realpathSync(workspaceDir)
      const realScan = realpathSync(scanDir)
      if (realScan !== realWs && !realScan.startsWith(realWs + sep)) {
        return { error: 'path_blocked', message: `scope resolves outside workspace: ${scope}` }
      }
    } catch {
      return { error: 'path_blocked', message: `cannot resolve scope path: ${scope}` }
    }
    const stat = statSync(scanDir)
    if (stat.isFile()) {
      // 直接扫描该文件
      const relPath = toRel(scanDir)
      const absPath = scanDir
      let lines
      try { lines = readFileSync(absPath, 'utf-8').split('\n') } catch { return { scope, total_todos: 0, todos: [], truncated: false, summary: { high: 0, medium: 0, low: 0 }, scanned_files: 0 } }

      const todos = []
      for (let i = 0; i < lines.length; i++) {
        const m = TODO_RE.exec(stripStrings(lines[i]))
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
  // R22-⑪：读失败不再静默——计数透出（此前 catch{continue} 丢文件无提示）
  let readErrors = 0
  for (const relPath of files) {
    const absPath = join(workspaceDir, relPath)
    let lines
    try { lines = readFileSync(absPath, 'utf-8').split('\n') } catch { readErrors++; continue }

    for (let i = 0; i < lines.length; i++) {
      const m = TODO_RE.exec(stripStrings(lines[i]))
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
    nextStep = 'No TODO/FIXME markers found (regex scan of markers only).'
  }

  return {
    scope,
    total_todos: todos.length,
    todos: todos.slice(0, 50),
    truncated: todos.length > 50,
    // R17-3：文件扫描到 500 上限截断——否则 LLM 误以为全仓已扫
    files_truncated: files.length >= 500,
    read_errors: readErrors,
    summary,
    scanned_files: files.length,
    next_step: nextStep,
  }
}
