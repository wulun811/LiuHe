import { join, dirname, basename, extname } from 'node:path'
import { existsSync, readFileSync, statSync } from 'node:fs'

const CONVENTIONS = {
  '.py': (base, dir) => [
    `tests/test_${base}.py`,
    `test/test_${base}.py`,
    `${dir}/test_${base}.py`,
    `test_${base}.py`,
    `tests/unit/test_${base}.py`,
  ],
  '.js': (base, dir) => [
    `${dir}/${base}.test.js`,
    `${dir}/__tests__/${base}.test.js`,
    `test/${base}.test.js`,
    `tests/${base}.test.js`,
    `${dir}/${base}.spec.js`,
  ],
  '.mjs': (base, dir) => [
    `${dir}/${base}.test.mjs`,
    `test/${base}.test.mjs`,
  ],
  '.ts': (base, dir) => [
    `${dir}/${base}.test.ts`,
    `${dir}/__tests__/${base}.test.ts`,
    `test/${base}.test.ts`,
    `${dir}/${base}.spec.ts`,
  ],
  '.tsx': (base, dir) => [
    `${dir}/${base}.test.tsx`,
    `${dir}/__tests__/${base}.test.tsx`,
  ],
  '.go': (base, dir) => [`${dir}/${base}_test.go`],
  '.rs': (base, dir) => [`tests/${base}_test.rs`, `${dir}/${base}_test.rs`],
  '.java': (base, dir) => [
    `${dir}/test/${base}Test.java`,
    `test/${base}Test.java`,
    `src/test/java/${base}Test.java`,
  ],
}

function deriveTestPaths(file) {
  const ext = extname(file)
  const base = basename(file, ext)
  const dir = dirname(file)
  const convention = CONVENTIONS[ext]
  if (!convention) return []
  return convention(base, dir === '.' ? '' : dir)
}

function checkExistence(paths, workspaceDir) {
  return paths.map(p => {
    const abs = join(workspaceDir, p)
    const exists = existsSync(abs)
    const entry = { path: p, exists }
    if (exists) {
      try {
        const content = readFileSync(abs, 'utf-8')
        entry.size_lines = content.split('\n').length
        entry.empty = entry.size_lines <= 1
      } catch { entry.size_lines = 0; entry.empty = true }
    }
    return entry
  })
}

function extractTestNames(filePath, workspaceDir) {
  const abs = join(workspaceDir, filePath)
  if (!existsSync(abs)) return []
  try {
    const content = readFileSync(abs, 'utf-8')
    const ext = extname(filePath)
    const tests = []
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      let m
      if (ext === '.py') {
        m = /^\s*(?:async\s+)?def\s+(test_\w+)/.exec(lines[i])
      } else if (['.js', '.mjs', '.ts', '.tsx'].includes(ext)) {
        m = /(?:it|test)\s*\(\s*['"`](.+?)['"`]/.exec(lines[i])
        if (!m) m = /(?:describe)\s*\(\s*['"`](.+?)['"`]/.exec(lines[i])
      } else if (ext === '.go') {
        m = /^func\s+(Test\w+)/.exec(lines[i])
      }
      if (m) tests.push({ name: m[1], line: i + 1 })
    }
    return tests
  } catch { return [] }
}

export async function handle(args, context) {
  const { codeIndexService, getWorkspaceDir } = context
  const workspaceDir = args?.workspace_dir

  if (!workspaceDir) {
    return { error: 'missing_parameter', message: 'workspace_dir is required' }
  }

  const file = args?.file
  if (!file) {
    return { error: 'missing_parameter', message: 'file is required' }
  }

  // 检测 file 是否为目录
  const absFile = join(workspaceDir, file)
  if (existsSync(absFile)) {
    const stat = (await import('node:fs')).statSync(absFile)
    if (stat.isDirectory()) {
      return { error: 'invalid_input', message: `"${file}" is a directory, not a file. Please specify a source file path.` }
    }
  }

  const symbol = args?.symbol
  const searchMethods = []

  const candidates = deriveTestPaths(file)
  const byConvention = checkExistence(candidates, workspaceDir)
  searchMethods.push('convention')

  let byImport = []
  if (codeIndexService) {
    const dbPath = join(getWorkspaceDir(workspaceDir), 'code-index.db')
    if (existsSync(dbPath)) {
      try {
        codeIndexService.initWorkspace(workspaceDir)
        const refs = await codeIndexService.getReferences(basename(file, extname(file)))
        const testImporters = (refs || [])
          .filter(r => {
            const p = r.path || ''
            return /(?:^|\/)(?:tests?|__tests__)\/|\.test\.|\.spec\.|_test\./.test(p)
          })
          .map(r => ({ path: r.path, kind: r.kind, target_name: r.target_name }))

        const seen = new Set()
        byImport = testImporters.filter(r => {
          if (seen.has(r.path)) return false
          seen.add(r.path)
          return true
        })
        if (byImport.length > 0) searchMethods.push('import_graph')
      } catch {}
    }
  }

  let testSymbols = []
  if (symbol) {
    for (const t of byConvention.filter(c => c.exists)) {
      const names = extractTestNames(t.path, workspaceDir)
      for (const n of names) {
        if (n.name.toLowerCase().includes(symbol.toLowerCase())) {
          testSymbols.push({ ...n, file: t.path })
        }
      }
    }
    for (const t of byImport) {
      const names = extractTestNames(t.path, workspaceDir)
      for (const n of names) {
        if (n.name.toLowerCase().includes(symbol.toLowerCase())) {
          testSymbols.push({ ...n, file: t.path })
        }
      }
    }
    const seen = new Set()
    testSymbols = testSymbols.filter(t => {
      const key = `${t.file}:${t.name}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  const existingConvention = byConvention.filter(c => c.exists)
  let coverageHint
  if (existingConvention.length === 0 && byImport.length === 0) {
    coverageHint = 'no tests found — consider creating tests'
  } else if (byImport.length === 0) {
    coverageHint = `${existingConvention.length} test file(s) exist by convention but none import target — possibly stale`
  } else {
    coverageHint = `${byImport.length} test file(s) actively import target module`
  }

  const existingTests = byConvention.filter(c => c.exists)
  let nextStep
  if (existingTests.length > 0) {
    nextStep = `Run: test_bridge(action="run", scope="${existingTests[0].path}")`
  } else if (byImport.length > 0) {
    nextStep = `Run: test_bridge(action="run", scope="${byImport[0].path}")`
  } else {
    nextStep = 'No tests found. Consider creating tests.'
  }

  return {
    source_file: file,
    by_convention: byConvention,
    by_import: byImport,
    test_symbols: testSymbols.length > 0 ? testSymbols : undefined,
    coverage_hint: coverageHint,
    search_methods: searchMethods,
    next_step: nextStep,
  }
}
