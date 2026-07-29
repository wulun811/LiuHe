import { join, extname, basename } from 'node:path'
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

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    let m

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
          if (n && !n.startsWith('#') && !n.startsWith('\\')) imports.set(n, i + 1)
        }
        continue
      }
    } else if (['.js', '.mjs', '.ts', '.tsx', '.jsx'].includes(ext)) {
      m = /import\s+(?:{([^}]+)}|(\w+))/.exec(line)
      if (m) {
        const names = m[1] ? m[1].split(',').map(s => s.trim().split(/\s+as\s+/).pop().trim()) : [m[2]]
        for (const n of names) {
          if (n) imports.set(n, i + 1)
        }
        continue
      }
    }

    const identifiers = line.match(/\b[a-zA-Z_]\w*\b/g) || []
    for (const id of identifiers) used.add(id)
  }

  return [...imports.entries()]
    .filter(([name]) => !used.has(name))
    .map(([name, line]) => ({ type: 'unused_import', line, symbol: name }))
}

export async function handle(args, context) {
  const { codeIndexService, getWorkspaceDir } = context
  const workspaceDir = args?.workspace_dir

  if (!workspaceDir) {
    return { error: 'missing_parameter', message: 'workspace_dir is required' }
  }

  const scope = args?.scope || '.'
  const includeFiles = args?.include_files === true
  const scanDir = scope === '.' ? workspaceDir : join(workspaceDir, scope)

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

  return {
    scope,
    dead_code: deadCode.slice(0, 100),
    truncated: deadCode.length > 100,
    summary,
    scanned_files: files.length,
  }
}
