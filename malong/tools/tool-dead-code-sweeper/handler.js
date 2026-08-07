import { join, extname, basename, dirname, sep } from 'node:path'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'

// r29：与 malong-parse 支持语言对齐（r28 新增 C/C++/Java/Bash）
const SOURCE_EXTS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts', '.py', '.go', '.rs', '.java', '.c', '.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx', '.sh', '.bash', '.rb'])
const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', 'dist', 'build'])
const ENTRY_NAMES = new Set(['main', 'index', 'app', 'server', 'cli', '__main__', 'manage'])
const MAGIC_METHODS = new Set(['__init__', '__str__', '__repr__', '__eq__', '__hash__', '__len__', '__call__', '__enter__', '__exit__', '__new__', '__del__', 'constructor'])
// r12（隔壁实战教训）：seedTasks 被 tongtian-cli 字符串引用却报死——unused_function 只看 import 图，
// CLI 命令字符串 / scripts/*.sh / package.json scripts / 文档里的文本引用不在图内。
// 文本兜底：这些非源码文件里 grep 符号名，命中即视为活（宁可漏报不可误删——死代码删除代价不可逆）
const TEXT_REF_EXTS = new Set(['.sh', '.bash', '.json', '.md', '.txt', '.html', '.yml', '.yaml', '.toml', '.ini', '.rst', '.csv'])
// r12（隔壁第 5 条建议）：守卫类函数生产零调用 = 架构级未接线信号（比普通死代码危险得多）
const GUARD_NAME_RE = /^(?:assert|validate|verify|check|sanitize|guard|authorize|permit|ensure|isValid|isAuthorized|hasPermission|requirePermission)/i

// r12：收集全项目非源码文本（scripts/CLI/文档/配置文件），供死代码候选做文本级引用兑底
function collectTextReferences(workspaceDir, maxFiles = 500) {
  const texts = []
  let count = 0
  const walk = (dir, depth) => {
    if (count >= maxFiles) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (count >= maxFiles) return
      if (entry.name.startsWith('.') || entry.name === '.index-cache' || SKIP_DIRS.has(entry.name) || entry.name === 'tests' || entry.name === 'test' || entry.name === '__tests__') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth < 6) walk(full, depth + 1)
      } else {
        const ext = extname(entry.name)
        if (!TEXT_REF_EXTS.has(ext) && ext) continue
        let content
        try {
          if (statSync(full).size > 1024 * 1024) continue
          content = readFileSync(full, 'utf-8')
        } catch { continue }
        texts.push(content)
        count++
      }
    }
  }
  walk(workspaceDir, 0)
  return texts
}

function hasTextReference(texts, symbolName) {
  if (!texts || !texts.length) return false
  const esc = String(symbolName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // R22-⑪：短名（<4）裸词匹配太宽——`run`/`foo` 命中任意文本（"run the script"）永不报死（报告 P2）
  // 短名要求引号/空白包裹（CLI 命令字符串/JSON key 形态），长名仍用单词边界
  const re = String(symbolName).length < 4
    ? new RegExp(`["'\[\{,\s]${esc}["'\]\},;\s]`)
    : new RegExp(`\\b${esc}\\b`)
  return texts.some(t => re.test(t))
}

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
      const relPath = fullPath.startsWith(baseDir + sep) ? fullPath.slice(baseDir.length + 1) : fullPath
      files.push(relPath.replace(/\\/g, '/'))
    }
  }
}

function isTestFile(path) {
  return /(?:^|\/)(?:tests?|__tests__)\/|\.test\.|\.spec\.|_test\./.test(path)
}

function isEntryPoint(file) {
  const base = basename(file, extname(file))
  if (ENTRY_NAMES.has(base)) return true
  // r23：入口识别增强——mcp-server 这类 CLI 启动入口不在通用白名单，靠 package.json 声明兜底
  return /^(?:mcp[-_]?server|server|daemon|worker|agent|runner)$/.test(base)
}

// r23：收集全项目 import/require 的目标路径字符串（静态 + 动态 + require）以及
// tools/*/manifest.json 的 handler 字段（tool-registry 用路径拼接动态 import，无 import 字面量），
// orphan_file 判定用文件路径级匹配——修复动态 import（await import('./x.js')）产生的误报
function collectImportTargets(files, workspaceDir) {
  const targets = new Set()
  const patterns = [
    /(?:^|\s)(?:import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g,        // 动态 import() / require()
    /^\s*import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm,           // 静态 import ... from '...'
    /['"]((?:\.{0,2}\/)?[\w./-]+\.(?:js|mjs|cjs|py|ts|tsx))['"]/g,     // 引号路径字面量（join(__dirname,'x.py') 等）
  ]
  for (const rel of files) {
    let content
    try { content = readFileSync(join(workspaceDir, rel), 'utf-8') } catch { continue }
    for (let p = 0; p < patterns.length; p++) {
      const re = patterns[p]
      let m
      re.lastIndex = 0
      while ((m = re.exec(content)) !== null) {
        const t = m[1]
        // import/require 模块说明符：只收相对/绝对路径（裸名是 npm 包）
        if (p < 2 && !(t.startsWith('.') || t.startsWith('/'))) continue
        // 路径字面量：排除 URL 与 node: 内置
        if (p === 2 && /^(?:https?:)?\/\//.test(t)) continue
        targets.add(t.replace(/\.(js|mjs|cjs|jsx|ts|tsx|py)$/, ''))
      }
    }
    // 工具注册机制：tools/*/manifest.json 的 handler 字段（registry 路径拼接 import）
    const dirPath = dirname(join(workspaceDir, rel))
    const manifestPath = join(dirPath, 'manifest.json')
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
        if (manifest.handler) {
          const h = join(dirPath, manifest.handler).slice(workspaceDir.length + 1).replace(/\.(js|mjs|cjs)$/, '')
          targets.add(h)
          targets.add(`./${h}`)
        }
      } catch {}
    }
  }
  return targets
}

function isReferencedByImport(relPath, importTargets) {
  const noExt = relPath.replace(/\.(js|mjs|cjs|jsx|ts|tsx|py)$/, '')
  const bare = basename(noExt)
  for (const t of importTargets) {
    const tStripped = t.replace(/^\.\//, '')
    if (tStripped === noExt) return true
    // 相对父级路径（../../x）与子目录路径：按裸名与末段匹配
    if (basename(tStripped) === bare) return true
    if (noExt.endsWith(`/${tStripped}`)) return true
  }
  return false
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
  // R22-⑪（拷打发现）：非字符串 scope 让 split 裸抛——前置类型校验
  if (typeof scope !== 'string') {
    return { error: 'invalid_input', message: `scope must be a string (got ${typeof scope})` }
  }
  // r54(P2): scope 含 .. 会越权遍历 workspace 外目录
  if (scope.split(/[\\/]/).includes('..')) {
    return { error: 'invalid_input', message: `scope contains "..": ${scope}` }
  }
  const includeFiles = args?.include_files === true
  let scanDir = scope === '.' ? workspaceDir : join(workspaceDir, scope)
  let scanFile = null

  // 14：scope 为文件路径时只扫该文件——旧实现静默改成扫父目录（scope="lib.js" 扫全仓），
  // 用户以为只查一个文件，实际拿到整仓结果，扫描范围完全失真
  if (scope !== '.' && existsSync(scanDir)) {
    const stat = statSync(scanDir)
    if (stat.isFile()) {
      scanFile = scope.replace(/^\.\//, '')
      scanDir = dirname(scanDir)
    }
  }
  // r29：目录 scope 前缀（DB 层结果按此过滤）；规范化 ./ 前缀与尾部 /，防前缀串匹配
  const scopePrefix = scope === '.' ? '' : scope.replace(/^\.\//, '').replace(/\/+$/, '') + '/'

  const files = []
  walkSourceFiles(workspaceDir, scanDir, files, 500)
  if (scanFile) {
    const only = files.filter(f => f === scanFile)
    files.length = 0
    files.push(...only)
  }

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
        await codeIndexService.initWorkspace(workspaceDir)
        const dead = await codeIndexService.detectDeadCode?.()
        if (dead && Array.isArray(dead)) {
          // r12：文本引用兜底懒加载——只在存在死代码候选时扫描（候选少则省一次全仓文件遍历）
          let textRefs = null
          for (const s of dead) {
            if (!['function', 'method'].includes(s.type)) continue
            if (MAGIC_METHODS.has(s.name)) continue
            if (isTestFile(s.file || s.path || '')) continue
            // 14：单文件 scope 时，DB 层的 unused_function 也限定在该文件内
            if (scanFile && (s.file || s.path) !== scanFile) continue
            // r29：目录 scope 时 DB 层结果同样限定在 scope 内——旧实现只有单文件过滤，
            // 目录 scope 会把整仓 unused_function 混进来（scope 外目录的文件也报）
            if (!scanFile && scope !== '.' && !(s.file || s.path || '').startsWith(scopePrefix)) continue
            // r29：Rust #[cfg(test)] 内联测试函数（test_ 前缀）由 cargo test 直接发现，
            // 不走符号引用 → 全被误报 unused_function
            const sPath = s.file || s.path || ''
            if (extname(sPath) === '.rs' && (s.name.startsWith('test_') || s.name.endsWith('_test'))) continue
            // r12（seedTasks 教训）：import 图外的文本引用（CLI 命令字符串/scripts/*.sh/package.json scripts/文档）
            // 命中即视为活——宁可漏报不可误删
            if (textRefs === null) textRefs = collectTextReferences(workspaceDir)
            if (hasTextReference(textRefs, s.name)) continue

            let mtime = null, daysUnused = null
            try {
              const st = statSync(join(workspaceDir, s.file || s.path))
              mtime = new Date(st.mtimeMs).toISOString().slice(0, 10)
              daysUnused = Math.floor((Date.now() - st.mtimeMs) / 86400000)
            } catch {}

            const isGuard = GUARD_NAME_RE.test(s.name)
            deadCode.push(isGuard
              ? {
                type: 'unused_guard',
                file: s.file || s.path,
                line: s.start_line,
                name: s.name,
                confidence: 'architecture_signal',
                message: '守卫类函数（assert/validate/verify 命名）生产零调用——可能是架构级未接线（守卫未接入调用链），比普通死代码危险，先人工确认调用路径再处理',
                suggestion: `trace call sites of ${s.name} — if truly unwired, wire it into the flow or delete deliberately`,
              }
              : {
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

  if (includeFiles) {
    try {
      // r23：orphan_file 判定改用「全项目 import/require 目标字符串」路径级匹配，
      // 替代旧的符号级 getReferences(basename) —— 后者对动态 import（await import('./x.js')）
      // 与模块路径 import ref 匹配不上，导致 repo-map.js / lang-parser.js / code-index.js
      // 这类「被动态加载的活文件」被误报为孤儿
      const importTargets = collectImportTargets(files, workspaceDir)
      const imported = new Set()
      for (const f of files) {
        if (isTestFile(f) || isEntryPoint(f)) continue
        if (f.includes('__init__')) continue
        if (isReferencedByImport(f, importTargets)) imported.add(f)
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
    // r12：架构级未接线信号独立计数——与普通死代码区分（勿直接删）
    unused_guards: deadCode.filter(d => d.type === 'unused_guard').length,
    orphan_files: deadCode.filter(d => d.type === 'orphan_file').length,
  }
  summary.estimated_tokens_saved = summary.unused_imports * 50 + summary.unused_functions * 200 + summary.unused_guards * 200 + summary.orphan_files * 500

  let nextStep = null
  if (deadCode.some(d => d.type === 'unused_guard')) {
    nextStep = 'unused_guard 是架构级未接线信号（守卫未接入调用链）——先人工 trace 调用路径，确认未接线后再处理；普通 unused imports/functions 可安全删除。'
  } else if (deadCode.length > 0) {
    nextStep = `Remove dead code via edit_transaction. Unused imports are safe to remove immediately.`
  } else {
    nextStep = `No dead code found (import graph + text reference fallback scanned).`
  }

  return {
    scope,
    coverage: 'graph-scan (import refs) + text-ref fallback (scripts/docs/config); dynamic/reflection wiring NOT covered',
    dead_code: deadCode.slice(0, 100),
    truncated: deadCode.length > 100,
    summary,
    scanned_files: files.length,
    next_step: nextStep,
  }
}
