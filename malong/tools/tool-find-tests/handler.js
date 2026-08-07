import { join, dirname, basename, extname } from 'node:path'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { validateFilePath } from '../../error-codes.js'
import { guardReadPath } from '../../path-guard.js'

// R22-⑪：整读上限——超大文件（生成代码/数据文件）此前整读盘只为数行数/扫测试名，无上限
const MAX_STAT_FILE_SIZE = 1024 * 1024
const MAX_PARSE_FILE_SIZE = 2 * 1024 * 1024

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
    // R6：读文件前统一过 guardReadPath——防 join(workspaceDir, p) 经 ../ 越界读
    const guard = guardReadPath(workspaceDir, p)
    if (guard.blocked) {
      return { path: p, exists: false, blocked: true, blocked_reason: guard.detail }
    }
    const abs = join(workspaceDir, p)
    const exists = existsSync(abs)
    const entry = { path: p, exists }
    if (exists) {
      try {
        // R22-⑪：>1MB 只标注跳过（数行数不值整读）
        const st = statSync(abs)
        if (st.size > MAX_STAT_FILE_SIZE) { entry.size_lines = null; entry.large_skipped = true }
        else {
          const content = readFileSync(abs, 'utf-8')
          entry.size_lines = content.split('\n').length
          entry.empty = entry.size_lines <= 1
        }
      } catch { entry.size_lines = 0; entry.empty = true }
    }
    return entry
  })
}

function extractTestNames(filePath, workspaceDir) {
  // R6：读前守卫——防 filePath 经 ../ 越界读
  const guard = guardReadPath(workspaceDir, filePath)
  if (guard.blocked) return []
  const abs = join(workspaceDir, filePath)
  if (!existsSync(abs)) return []
  // R22-⑪：>2MB 的测试文件跳过解析（超大测试文件罕见，整读不值得）
  try { if (statSync(abs).size > MAX_PARSE_FILE_SIZE) return [] } catch { return [] }
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
        // R22-⑯：只剥注释不剥字符串——旧 P2-B6 把字符串一起剥掉，但正则要求紧跟引号，造成 JS/TS test_symbols 恒空（实证：it("works") 剥后变 it( ) → 永远不匹配）
        const code = lines[i].replace(/\/\/.*$/, '')
        m = /^\s*(?:it|test)(?:\.(?:only|skip))?\s*\(\s*['"`](.+?)['"`]/.exec(code)
        if (!m) m = /^\s*describe\s*\(\s*['"`](.+?)['"`]/.exec(code)
      } else if (ext === '.go') {
        m = /^func\s+(Test\w+)/.exec(lines[i])
      }
      if (m) tests.push({ name: m[1], line: i + 1 })
    }
    return tests
  } catch { return [] }
}

// 11#6：索引反查 by_import 不可靠——动态 import 存 target_name="import"（丢模块路径），
// 静态 import 的 target_name 是模块名也常与文件基名对不上 → 测试文件漏找。
// 文本兜底：有界扫测试文件，行级匹配 import/require 目标基名（静态/动态/require 全覆盖，无回溯风险）。
const TEST_PATH_RE = /(?:^|\/)(?:tests?|__tests__)\/|\.test\.|\.spec\.|_test\./
const SKIP_SCAN_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', 'dist', 'build', 'target', '.ai-cache'])

function findTestImportersByText(workspaceDir, baseName, maxFiles = 800, maxResults = 20) {
  const results = []
  let scanned = 0
  const walk = (dir) => {
    if (scanned >= maxFiles || results.length >= maxResults) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (scanned >= maxFiles || results.length >= maxResults) break
      if (e.name.startsWith('.') || SKIP_SCAN_DIRS.has(e.name)) continue
      const full = join(dir, e.name)
      // Windows：绝对路径反斜杠会让 TEST_PATH_RE（/tests|.test. 语义）与 wsPrefix 拼接全落空 → 先归一化
      const norm = full.replace(/\\/g, '/')
      if (e.isDirectory()) {
        walk(full)
      } else if (e.isFile() && TEST_PATH_RE.test(norm)) {
        scanned++
        // R22-⑪：>1MB 跳过该文件（行级 import 扫描不值整读大文件）
        try { if (statSync(full).size > MAX_STAT_FILE_SIZE) continue } catch { continue }
        try {
          const lines = readFileSync(full, 'utf-8').split('\n')
          for (let i = 0; i < lines.length; i++) {
            const ln = lines[i]
            if (/(?:\bfrom\b|import\s*\(|require\s*\()\s*['"`]/.test(ln) && ln.includes(baseName)) {
              // R22-⑯：尾斜杠 workspace 前缀归一化（r11(L11) 同款——`ws + '/'` 在尾斜杠时拼成 `//` 恒不匹配）
              const wsNorm = workspaceDir.replace(/\\/g, '/')
              const wsPrefix = wsNorm.endsWith('/') ? wsNorm : wsNorm + '/'
              const rel = norm.startsWith(wsPrefix) ? norm.slice(wsPrefix.length) : norm
              results.push({ path: rel, kind: 'import', target_name: baseName, line: i + 1 })
              break
            }
          }
        } catch {}
      }
    }
  }
  walk(workspaceDir)
  return results
}

export async function handle(args, context) {
  const { codeIndexService, getWorkspaceDir } = context
  const workspaceDir = args?.workspace_dir

  if (!workspaceDir) {
    return { error: 'missing_parameter', message: 'workspace_dir is required' }
  }

  let file = args?.file
  // R22-⑪（拷打发现）：非字符串 file 让后续 join/path 操作裸抛——前置类型校验
  if (typeof file !== 'string') {
    return { error: 'invalid_input', message: `file must be a string (got ${typeof file})` }
  }
  if (!file) {
    return { error: 'missing_parameter', message: 'file is required' }
  }

  // 16：file 参数共用守卫——目录/不存在时返回结构化错误（含路径归一化）
  // r11(M2)：未索引（FILE_NOT_INDEXED）不短路——convention 扫描不需要索引，
  // 旧实现直接返回错误且提示 "auto-indexes on demand"（该路径不存在），新建 workspace 上 find_tests 永远失败
  let notIndexed = false
  if (codeIndexService?.resolveFileArg) {
    // R22-⑮：resolveFileArg 前先保鲜（对齐 references R22-④ 模式）——未索引文件自动重抽补齐，避免 FILE_NOT_INDEXED 死胡同；排除文件保鲜无效仍走结构化错误
    if (codeIndexService?.ensureFreshFile) {
      try { await codeIndexService.ensureFreshFile(file) } catch {}
    }
    const resolved = codeIndexService.resolveFileArg(file)
    if (!resolved.ok) {
      if (resolved.error?.code === 'FILE_NOT_INDEXED') {
        notIndexed = true
        // R6：未索引分支同样过 validateFilePath——旧实现直接赋值，后续 join 可经 ../ 越界
        const v = validateFilePath(resolved.path, workspaceDir)
        if (v.blocked) {
          return { error: 'PATH_BLOCKED', message: `file blocked: ${v.detail}`, suggestion: 'Provide a file path inside workspace_dir (no "..", no absolute paths outside workspace)' }
        }
        file = resolved.path
      } else {
        return { error: resolved.error.code, message: resolved.error.message, suggestion: resolved.error.suggestion }
      }
    } else {
      file = resolved.path
    }
  } else {
    // R22-⑪（拷打发现）：无 codeIndexService 时守卫被绕过——`../../etc/passwd` 直接进 convention 扫描
    const v = validateFilePath(file, workspaceDir)
    if (v.blocked) {
      return { error: 'PATH_BLOCKED', message: `file blocked: ${v.detail}`, suggestion: 'Provide a file path inside workspace_dir (no "..", no absolute paths outside workspace)' }
    }
  }

  const symbol = args?.symbol
  const searchMethods = []
  // r11(M1)：import 反查失败记录（透出而非静默）
  let importScanError = null

  const candidates = deriveTestPaths(file)
  const byConvention = checkExistence(candidates, workspaceDir)
  searchMethods.push('convention')

  let byImport = []
  if (codeIndexService) {
    const dbPath = join(getWorkspaceDir(workspaceDir), 'code-index.db')
    if (existsSync(dbPath)) {
      try {
        // r52: 缺 await——initWorkspace 内 _db 懒初始化（异步），不等待则 getReferences 拿到 null 库抛 TypeError 被 catch{} 吞，byImport 恒空（r47 code-search 同根因）
        await codeIndexService.initWorkspace(workspaceDir)
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
      } catch (e) {
        // r11(M1)：import 反查失败不静默——旧 catch{} 吞错后 byImport 恒空 + coverage 误导 no tests found
        importScanError = `import graph lookup failed: ${e.message}`
      }
    }
  }

  // 11#6：索引反查常漏（动态 import 存 target_name="import" 丢模块路径）→ 文本兜底扫测试文件 import/require
  if (byImport.length === 0) {
    const textHits = findTestImportersByText(workspaceDir, basename(file, extname(file)))
    if (textHits.length > 0) {
      byImport = textHits
      searchMethods.push('import_text_fallback')
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
    // r11(M2)：未索引提示——convention 结果照常给，附重建索引建议（旧实现直接报错）
    ...(notIndexed ? { not_indexed: true, note: 'file not in index yet; convention scan still works. Call reindex(workspace_dir=...) to enable import-graph lookups.' } : {}),
    ...(importScanError ? { import_scan_error: importScanError } : {}),
    next_step: nextStep,
  }
}
