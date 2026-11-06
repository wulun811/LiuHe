// workflow/orient.js — S5.3 路由纵切首屏（system/isolate/document）。
// 纯本地确定性推导：入口点探测（FS）、最小复现边界（复用 impact）、文档覆盖（启发式）。
// 不猜业务影响；不写盘；启发式结果一律附 limitation 由调用方声明。
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// 常见入口候选（存在才列入）
const ENTRY_CANDIDATES = [
  'index.js', 'index.mjs', 'index.cjs', 'index.ts', 'index.tsx',
  'main.js', 'main.mjs', 'main.ts',
  'src/index.js', 'src/index.ts', 'src/main.js', 'src/main.ts',
  'app.py', 'main.py', '__main__.py', 'manage.py', 'src/main.py', 'src/__main__.py',
  'cmd', 'bin',
]

// system 路由：入口点探测（package.json main/bin/module + 约定文件名）
// R16（真机试用 F2）：只看 workspace 根时，单仓多包（liuhe/malong/package.json）的入口恒为空，
// 零命中兜底因此只能看到字母序第一个目录。现在下探一层子包（有界：最多 40 个子目录，跳过构建产物）。
const SUBPACKAGE_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', 'vendor', '.cache', 'tmp', 'temp'])
const SUBPACKAGE_ENTRY_CANDIDATES = ['index.js', 'index.mjs', 'index.cjs', 'index.ts', 'main.js', 'main.mjs', 'server.js', 'mcp-server.js', 'cli.js']
function packageEntryFields(pkg) {
  const out = []
  if (!pkg || typeof pkg !== 'object') return out
  if (typeof pkg.main === 'string') out.push(pkg.main)
  if (typeof pkg.module === 'string') out.push(pkg.module)
  if (typeof pkg.bin === 'string') out.push(pkg.bin)
  else if (pkg.bin && typeof pkg.bin === 'object') for (const v of Object.values(pkg.bin)) if (typeof v === 'string') out.push(v)
  return out
}
export function detectEntryPoints(workspaceDir) {
  const fromPackage = []
  try {
    const pkg = JSON.parse(readFileSync(join(workspaceDir, 'package.json'), 'utf-8'))
    if (typeof pkg.main === 'string') fromPackage.push(pkg.main)
    if (typeof pkg.module === 'string') fromPackage.push(pkg.module)
    if (typeof pkg.bin === 'string') fromPackage.push(pkg.bin)
    else if (pkg.bin && typeof pkg.bin === 'object') for (const v of Object.values(pkg.bin)) if (typeof v === 'string') fromPackage.push(v)
  } catch { /* 无/坏 package.json 不阻断 */ }
  const conventional = ENTRY_CANDIDATES.filter(p => existsSync(join(workspaceDir, p)))
  // R16：单仓多包下探一层（确定性：子目录名字节序）
  const fromSubpackages = []
  const subConventional = []
  let subdirs = []
  try {
    subdirs = readdirSync(workspaceDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.') && !SUBPACKAGE_SKIP_DIRS.has(d.name))
      .map(d => d.name).sort().slice(0, 40)
  } catch { /* 不可读就不探测，不阻断 */ }
  for (const d of subdirs) {
    let pkg = null
    try { pkg = JSON.parse(readFileSync(join(workspaceDir, d, 'package.json'), 'utf-8')) } catch { pkg = null }
    for (const rel of packageEntryFields(pkg)) {
      const clean = String(rel).replace(/^\.\//, '')
      if (existsSync(join(workspaceDir, d, clean))) fromSubpackages.push(d + '/' + clean)
    }
    for (const c of SUBPACKAGE_ENTRY_CANDIDATES) if (existsSync(join(workspaceDir, d, c))) subConventional.push(d + '/' + c)
  }
  const files = [...new Set([...fromPackage, ...conventional, ...fromSubpackages, ...subConventional])].filter(f => existsSync(join(workspaceDir, f)))
  return {
    from_package: [...new Set(fromPackage)],
    conventional,
    ...(fromSubpackages.length ? { from_subpackages: [...new Set(fromSubpackages)] } : {}),
    ...(subConventional.length ? { subpackage_conventional: [...new Set(subConventional)] } : {}),
    files,
  }
}

// isolate 路由：由 impact（callers/callees）构造最小复现边界（root + 传递被调者，深度受限）
export function reproBoundary(impact) {
  if (!impact || !impact.file) return null
  const callees = Array.isArray(impact.callees) ? impact.callees : []
  const files = [...new Set([impact.file, ...callees.map(c => c.file).filter(Boolean)])]
  return {
    root: { symbol: impact.symbol || null, file: impact.file },
    files,
    symbols: [
      { name: impact.symbol || null, file: impact.file, line: 0, role: 'root' },
      ...callees.map(c => ({ name: c.name || null, file: c.file || null, line: c.line || 0, role: 'callee' })),
    ],
    callee_count: callees.length,
    note: 'root + transitive callees (depth-limited) — minimal surface to reproduce',
  }
}

const DOC_INLINE = ['/**', '"""', "'''"]
function lineLooksDoc(s) {
  const t = (s || '').trimStart()
  return t.startsWith('//') || t.startsWith('#') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('///')
}

// document 路由：符号文档覆盖（启发式：紧邻上一行注释 / 正文 docstring / JSDoc）
// modules: [{ file, symbols: [{ name, kind, line }] }]（structureSummary 形状）
export function docCoverage(workspaceDir, modules) {
  const undocumented = []
  let total = 0, documented = 0, unreadable = 0
  for (const m of (modules || [])) {
    let lines = null
    try { lines = readFileSync(join(workspaceDir, m.file), 'utf-8').split('\n') } catch { unreadable++; continue }
    for (const s of (m.symbols || [])) {
      total++
      const ln = s.line || 0
      const above = ln >= 2 ? lines[ln - 2] : ''
      const body = lines.slice(Math.max(0, ln - 1), ln + 3).join('\n')
      const ok = lineLooksDoc(above) || DOC_INLINE.some(mk => body.includes(mk))
      if (ok) documented++
      else undocumented.push({ name: s.name, kind: s.kind, file: m.file, line: ln })
    }
  }
  return {
    total, documented, undocumented,
    unreadable_files: unreadable,
    // LH-006：无可读符号时 coverage 是 unknown（null）而不是 0——0 会被读成「全未文档化」
    unknown: total === 0,
    coverage: total ? Math.round((documented / total) * 100) / 100 : null,
    note: 'heuristic (adjacent comment / docstring only); does not assess prose quality',
  }
}