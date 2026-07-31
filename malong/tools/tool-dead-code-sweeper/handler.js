import { join, extname, basename, dirname } from 'node:path'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'

const SOURCE_EXTS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.go', '.rs', '.java', '.rb'])
const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', 'dist', 'build'])
const ENTRY_NAMES = new Set(['main', 'index', 'app', 'server', 'cli', '__main__', 'manage'])
const MAGIC_METHODS = new Set(['__init__', '__str__', '__repr__', '__eq__', '__hash__', '__len__', '__call__', '__enter__', '__exit__', '__new__', '__del__'])

function walkSourceFiles(baseDir, dir, files, maxFiles) {
  if (files.length >= maxFiles) return
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    if (files.length >= maxFiles) break
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      walkSourceFiles(baseDir, fullPath, files, maxFiles)
    } else if (entry.isFile() && SOURCE_EXTS.has(extname(entry.name))) {
      files.push(fullPath.startsWith(baseDir + '/') ? fullPath.slice(baseDir.length + 1) : fullPath)
    }
  }
}

function isTestFile(path) {
  return /(?:^|\/)(?:tests?|__tests__)\/|\.test\.|\.spec\.|_test\./.test(path)
}

function isEntryPoint(file) {
  const base = basename(file, extname(file))
  return ENTRY_NAMES.has(base)
}

function findUnusedImports(content, ext) {
  const lines = content.split('\n')
  const imports = new Map()
  const used = new Set()
  const isPy = ext === '.py'

  // 字符串/注释感知状态：仅用于防 import 文本误认
  // （模板字符串 / 三引号 / 块注释内部的行不做 import 检测；used 收集保持全词保守方向不变）
  let inTemplate = false    // JS 反引号
  let inBlockComment = false // JS /* */
  let inTriple = null        // Py """ / '''
  const jsxCandidates = new Set()  // default import 大写名：可能仅以 JSX 标签使用

  const countBackticks = (line) => {
    let n = 0
    for (let j = 0; j < line.length; j++) {
      if (line[j] === '\\') { j++; continue }
      if (line[j] === '`') n++
    }
    return n
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    let importOk = !inTemplate && !inBlockComment && !inTriple

    // 行尾更新状态（供下一行判断）
    if (isPy) {
      if (inTriple) {
        if (line.indexOf(inTriple) !== -1) inTriple = null
      } else {
        const m = line.match(/(?:"""|''')/)
        if (m) {
          const rest = line.slice(line.indexOf(m[0]) + 3)
          if (!rest.includes(m[0])) inTriple = m[0]
        }
      }
    } else {
      if (inBlockComment) {
        if (line.indexOf('*/') !== -1) inBlockComment = false
      } else if (line.includes('/*')) {
        const start = line.indexOf('/*')
        const end = line.indexOf('*/', start + 2)
        if (end === -1) inBlockComment = true
      }
      if (countBackticks(line) % 2 === 1) inTemplate = !inTemplate
    }

    let m

    if (importOk) {
      if (ext === '.py') {
        m = /^(?:from\s+\S+\s+)?import\s+(.+)/.exec(line)
        if (m) {
          const raw = m[1].replace(/[()]/g, '')
          const names = raw.split(',').map(s => {
            const parts = s.trim().split(/\s+as\s+/)
            const name = (parts[1] || parts[0]).trim()
            return name.includes('.') ? name.split('.')[0] : name
          })
          for (const n of names) {
            // from x import * 是通配导入，无法静态判定使用 → 永不报 unused（递归进化第 5 轮 P1#13）
            if (n === '*' || !n || n.startsWith('#') || n.startsWith('\\')) continue
            imports.set(n, i + 1)
          }
          continue
        }
      } else if (['.js', '.mjs', '.ts', '.tsx', '.jsx'].includes(ext)) {
        m = /^\s*import\s+(?:{([^}]+)}|(\w+))/.exec(line)
        if (m) {
          const names = m[1] ? m[1].split(',').map(s => s.trim().split(/\s+as\s+/).pop().trim()) : [m[2]]
          for (const n of names) {
            if (n) {
              imports.set(n, i + 1)
              // default import 且大写开头：可能是仅以 JSX 标签形式使用的组件（React 等）
              if (!m[1] && /^[A-Z]/.test(n)) jsxCandidates.add(n)
            }
          }
          continue
        }
      } else if (ext === '.rs') {
        // 8：Rust use 导入（正则版，与 fix_imports 的 parser 版互补）。绑定=路径末段/as 别名；
        // 跳过 pub use（re-export）与 glob（*）；只收干净标识符（嵌套 use list 复杂项跳过 → 保守不误报）
        const trimmed = line.trim()
        if (!/^pub\s+(?:\([^)]*\)\s+)?use\b/.test(trimmed)) {
          m = /^use\s+(.+);/.exec(trimmed)
          if (m) {
            const body = m[1].trim()
            const braceIdx = body.indexOf('{')
            const items = braceIdx !== -1
              ? body.slice(braceIdx + 1, body.lastIndexOf('}')).split(',').map(s => s.trim()).filter(Boolean)
              : [body]
            for (const item of items) {
              const asM = /\s+as\s+(\w+)\s*$/.exec(item)
              const binding = asM ? asM[1] : item.split('::').pop().trim()
              if (!/^\w+$/.test(binding) || binding === '*' || binding === 'self' || binding === 'super') continue
              imports.set(binding, i + 1)
            }
            continue
          }
        }
      }
    }

    const identifiers = line.match(/\b[a-zA-Z_]\w*\b/g) || []
    for (const id of identifiers) used.add(id)
  }

  // JSX 检测：文件里出现 <Tag 形态（HTML 元素小写 / 组件大写 / 成员表达式）
  // —— JSX 文件里 default 组件导入即使无标识符引用也合法（递归进化第 5 轮 P1#13）
  // 误判代价是漏报（安全方向），不误删合法导入
  const hasJsxSyntax = /<[A-Za-z][\w.]*(?:\s|>|\/)/.test(lines.join('\n'))
  return [...imports.entries()]
    .filter(([name]) => !used.has(name))
    .filter(([name]) => !(hasJsxSyntax && jsxCandidates.has(name)))
    .map(([name, line]) => ({
      type: 'unused_import', line, symbol: name,
      // 8：Rust trait 导入经方法隐式使用，静态无法判 → 启发式，提示人工确认（fix_imports 同此约束）
      ...(ext === '.rs' ? { confidence: 'heuristic', note: 'Rust trait imports (use Trait) may be used implicitly via methods; verify before removing.' } : {}),
    }))
}

export async function handle(args, context) {
  const { codeIndexService, getWorkspaceDir } = context
  const workspaceDir = args?.workspace_dir

  if (!workspaceDir) {
    return { error: 'missing_parameter', message: 'workspace_dir is required' }
  }

  const scope = args?.scope || '.'
  const includeFiles = args?.include_files === true
  let scanDir = scope === '.' ? workspaceDir : join(workspaceDir, scope)

  // 检测 scope 是否为文件路径（而非目录）
  if (scope !== '.' && existsSync(scanDir)) {
    const stat = statSync(scanDir)
    if (stat.isFile()) {
      // 调整为扫描该文件所在目录
      scanDir = dirname(scanDir)
    }
  }

  const files = []
  walkSourceFiles(workspaceDir, scanDir, files, 500)

  const deadCode = []

  for (const relPath of files) {
    if (isTestFile(relPath)) continue
    const absPath = join(workspaceDir, relPath)
    let content
    try { content = readFileSync(absPath, 'utf-8') } catch { continue }
    const ext = extname(relPath)

    const unusedImports = findUnusedImports(content, ext)
    for (const u of unusedImports) {
      deadCode.push({ ...u, file: relPath, suggestion: `remove: import ${u.symbol}` })
    }
  }

  if (codeIndexService) {
    const dbPath = join(getWorkspaceDir(workspaceDir), 'code-index.db')
    if (existsSync(dbPath)) {
      try {
        codeIndexService.initWorkspace(workspaceDir)
        const dead = await codeIndexService.detectDeadCode?.({ minUseCount: 0 })
        if (dead && Array.isArray(dead)) {
          for (const s of dead) {
            if (!['function', 'method'].includes(s.type)) continue
            if (MAGIC_METHODS.has(s.name)) continue
            if (isTestFile(s.file || s.path || '')) continue

            let mtime = null, daysUnused = null
            try {
              const st = statSync(join(workspaceDir, s.file || s.path))
              mtime = new Date(st.mtimeMs).toISOString().slice(0, 10)
              daysUnused = Math.floor((Date.now() - st.mtimeMs) / 86400000)
            } catch {}

            deadCode.push({
              type: 'unused_function',
              file: s.file || s.path,
              line: s.start_line,
              name: s.name,
              last_modified: mtime,
              days_unused: daysUnused,
              suggestion: `remove or archive ${s.name}()`,
            })
          }
        }
      } catch {}
    }
  }

  if (includeFiles && codeIndexService) {
    try {
      const imported = new Set()
      for (const f of files) {
        if (isTestFile(f) || isEntryPoint(f)) continue
        const refs = await codeIndexService.getReferences(basename(f, extname(f)))
        if (refs && refs.length > 0) {
          const hasImporter = refs.some(r => r.kind === 'import' && r.path !== f)
          if (hasImporter) imported.add(f)
        }
      }
      for (const f of files) {
        if (isTestFile(f) || isEntryPoint(f) || imported.has(f)) continue
        if (f.includes('__init__')) continue
        let mtime = null
        try { mtime = new Date(statSync(join(workspaceDir, f)).mtimeMs).toISOString().slice(0, 10) } catch {}
        deadCode.push({
          type: 'orphan_file',
          file: f,
          reason: '无任何导入',
          last_modified: mtime,
          suggestion: 'archive or delete',
        })
      }
    } catch {}
  }

  const summary = {
    unused_imports: deadCode.filter(d => d.type === 'unused_import').length,
    unused_functions: deadCode.filter(d => d.type === 'unused_function').length,
    orphan_files: deadCode.filter(d => d.type === 'orphan_file').length,
  }
  summary.estimated_tokens_saved = summary.unused_imports * 50 + summary.unused_functions * 200 + summary.orphan_files * 500

  let nextStep = null
  if (deadCode.length > 0) {
    nextStep = `Remove dead code via edit_transaction. Unused imports are safe to remove immediately.`
  } else {
    nextStep = `No dead code found.`
  }

  return {
    scope,
    dead_code: deadCode.slice(0, 100),
    truncated: deadCode.length > 100,
    summary,
    scanned_files: files.length,
    next_step: nextStep,
  }
}
