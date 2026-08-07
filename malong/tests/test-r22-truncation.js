// test-r22-truncation.js — R22④ 截断标注与排除行为的回归锁定（第四轮审核补全）
// 覆盖：
// ① trace-symbol search_truncated：300 文件上限截断 + 零命中 → 标注不丢（P1-4 修复点）
// ② trace-symbol literals_truncated：200 文件上限截断标注
// ③ references 空结果权威声明 suggestion
// ④ config_drift 全扫排除 tests/fixtures + file 模式不受排除影响
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const imp = (p) => import(pathToFileURL(p).href)
const MALONG_DIR = join(__dirname, '..')

let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}

const WS = join(tmpdir(), 'opencode', 'r22-trunc-ws')
const WS2 = join(tmpdir(), 'opencode', 'r22-trunc-ws2')
const WS3 = join(tmpdir(), 'opencode', 'r22-trunc-ws3')
for (const w of [WS, WS2, WS3]) {
  try { rmSync(w, { recursive: true, force: true }) } catch {}
  mkdirSync(join(w, 'src'), { recursive: true })
  writeFileSync(join(w, 'code-index.db'), '')
}

const ctx = {
  codeIndexService: {
    initWorkspace: async () => {},
    ensureFreshFile: async () => ({}),
    getReferences: async () => [],
    resolveFileArg: (f) => ({ ok: true, path: f }),
  },
  getWorkspaceDir: () => WS,
}

// ── ① trace-symbol：300 文件上限 + 零命中 → search_truncated 不丢 ──
{
  const { handle } = await imp(join(MALONG_DIR, 'tools', 'tool-trace-symbol', 'handler.js'))
  for (let i = 0; i < 300; i++) writeFileSync(join(WS, 'src', `a${String(i).padStart(3, '0')}.js`), '')
  writeFileSync(join(WS, 'src', 'def.js'), 'const SYM = "v"\n')
  writeFileSync(join(WS, 'src', 'zzz-last.js'), 'const x = SYM\n')
  const r = await handle({ workspace_dir: WS, symbol: 'SYM', file: 'src/def.js' }, ctx)
  assert(r.search_truncated === true, `① 300 文件截断 + 零命中 → search_truncated=true（得 ${r.search_truncated}）`)
  assert(r.direct_references.length === 0, `① 零命中（含 SYM 的文件在截断窗口外）（得 ${r.direct_references.length}）`)
}

// ── ② trace-symbol：literal 200 文件上限截断标注（独立 WS2，避免①的 500+ 文件干扰） ──
// 注意：literal 值用数字（字符串值会被 isInCommentOrString 剔除——既有设计，见 CHANGELOG debt）
{
  const { handle } = await imp(join(MALONG_DIR, 'tools', 'tool-trace-symbol', 'handler.js'))
  const ctx2 = { ...ctx, getWorkspaceDir: () => WS2 }
  for (let i = 0; i < 201; i++) writeFileSync(join(WS2, 'src', `l${String(i).padStart(3, '0')}.js`), `const n = 54321\n`)
  writeFileSync(join(WS2, 'src', 'def2.js'), 'const TARGET = 54321\n')
  const r = await handle({ workspace_dir: WS2, symbol: 'TARGET', file: 'src/def2.js', include_literals: true }, ctx2)
  assert(r.literals_truncated === true, `② literal 200 文件上限截断 → literals_truncated=true（得 ${r.literals_truncated}）`)
  assert(Array.isArray(r.suspected_literals) && r.suspected_literals.length > 0, `② 有 literal 命中（得 ${r.suspected_literals?.length}）`)
}

// ── ③ references：空结果权威声明 ──
{
  const { handle } = await imp(join(MALONG_DIR, 'tools', 'tool-references', 'handler.js'))
  const r = await handle({ workspace_dir: WS, symbol: 'NO_REF_ZZZ' }, ctx)
  assert(r.results.length === 0 && r.count === 0, `③ 空结果（count=0）`)
  assert(typeof r.suggestion === 'string' && r.suggestion.includes('authoritative'), `③ suggestion 权威声明（得 ${r.suggestion?.slice(0, 60)}...）`)
  // R22-⑤（试用发现）：file 限定空结果——权威声明误导（符号可能在其他文件有引用），改文件专属建议
  const rf = await handle({ workspace_dir: WS, symbol: 'NO_REF_ZZZ', file: 'src/def.js' }, ctx)
  assert(rf.results.length === 0 && typeof rf.suggestion === 'string' && rf.suggestion.includes('No references to "NO_REF_ZZZ" in src/def.js'), `③f file 限定专属建议（得 ${rf.suggestion?.slice(0, 60)}...）`)
  assert(rf.suggestion.includes('Remove the file filter'), `③f 建议给出解除 file 限定的出路`)
}

// ── ④ config_drift：全扫排除 tests/fixtures + file 模式不受影响（独立 WS3） ──
{
  const { handle } = await imp(join(MALONG_DIR, 'tools', 'tool-config-drift', 'handler.js'))
  mkdirSync(join(WS3, 'tests', 'fixtures'), { recursive: true })
  writeFileSync(join(WS3, 'src', 'real.js'), 'const a = process.env.REAL_VAR_X\n')
  writeFileSync(join(WS3, 'tests', 'fixtures', 'mock.js'), 'const b = process.env.MOCK_VAR_X\n')
  writeFileSync(join(WS3, 'tests', 'unit.js'), 'const c = process.env.TEST_VAR_X\n')
  const full = await handle({ workspace_dir: WS3 }, {})
  const names = (full.drifts || []).map(d => d.name)
  assert(names.includes('REAL_VAR_X'), `④ 全扫：src 真变量报（得 ${names.join(',')}）`)
  assert(!names.includes('MOCK_VAR_X') && !names.includes('TEST_VAR_X'), `④ 全扫：tests/fixtures 排除（得 ${names.join(',')}）`)
  const fileMode = await handle({ workspace_dir: WS3, file: 'tests/unit.js' }, {})
  const fnames = (fileMode.drifts || []).map(d => d.name)
  assert(fnames.includes('TEST_VAR_X'), `④ file 模式：显式指定 tests/ 文件仍报（得 ${fnames.join(',')}）`)
}

for (const w of [WS, WS2, WS3]) rmSync(w, { recursive: true, force: true })
console.log(`\n== test-r22-truncation: ${pass} passed, ${fail} failed ==`)
if (fail > 0) process.exit(1)
