// test-file-collector.js — 文件收集与 .malongignore 规则（r34-fix 补测）
// 覆盖 isIgnored 各 glob 分支 + collectFiles 目录遍历行为
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}
const fc = await import(pathToFileURL(join(__dirname, '..', 'file-collector.js')).href)
const { isIgnored, collectFiles, parseMalongignore } = fc

// ── isIgnored 规则 ──
// 目录规则
assert(isIgnored('node_modules', ['node_modules'], true) === true, '目录名规则忽略 node_modules')
assert(isIgnored('src', ['node_modules'], true) === false, '无关目录不忽略')
assert(isIgnored('src/lib', ['src/'], true) === true, 'dir/ 前缀规则忽略 src/ 下目录')
assert(isIgnored('src/lib', ['src/'], false) === true, 'dir/ 前缀规则忽略 src/ 下文件')

// **/ 任意层级
assert(isIgnored('a/b/node_modules', ['**/node_modules'], false) === true, '**/node_modules 任意层级匹配')
assert(isIgnored('node_modules', ['**/node_modules'], false) === true, '**/node_modules 根层匹配')
assert(isIgnored('src', ['**/node_modules'], true) === false, '无关目录不误伤')

// **/dist/** 中段目录
assert(isIgnored('x/y/dist/z/file.js', ['**/dist/**'], false) === true, '**/dist/** 任意层级 dist 匹配')
assert(isIgnored('dist/file.js', ['**/dist/**'], false) === true, '**/dist/** 根层 dist 匹配')
assert(isIgnored('distal/file.js', ['**/dist/**'], false) === false, 'distal 前缀不误伤')

// **/dist（无尾部 /**）
assert(isIgnored('a/dist/b.js', ['**/dist'], false) === true, '**/dist 匹配任意层级 dist 段')

// *.min.js 文件名后缀
assert(isIgnored('src/app.min.js', ['*.min.js'], false) === true, '*.min.js 文件名匹配')
assert(isIgnored('src/app.js', ['*.min.js'], false) === false, '非 min 文件不匹配')
assert(isIgnored('src/app.min.js', ['*.min.js'], true) === false, '目录不按文件名规则忽略')

// 前缀通配（r34 已知缺陷：仅 relPath 前缀匹配——子目录文件不命中，语义上应匹配 basename）
assert(isIgnored('generated_foo.js', ['generated_*'], false) === true, 'generated_* 前缀匹配')
assert(isIgnored('src/generated_foo.js', ['generated_*'], false) === false, '子目录文件当前不命中（已知缺陷，锁定现状）')

// 精确规则
assert(isIgnored('secret.key', ['secret.key'], false) === true, '精确文件名规则')
assert(isIgnored('a/secret.key', ['secret.key'], false) === false, '精确规则不含子目录')

// 注释与空行
const TMP = join(os.tmpdir(), 'opencode', 'file-collector-test')
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })
writeFileSync(join(TMP, '.malongignore'), '# comment\n\nnode_modules\n*.log\n')
assert(parseMalongignore(join(TMP, '.malongignore')).length === 2, '解析忽略注释和空行')
assert(parseMalongignore(join(TMP, 'nonexistent')).length === 0, '缺文件返回空规则')

// ── 已知缺陷验证：**/src/foo 多段模式 ──
// line 38-41：post='src/foo'，seg 是单段 → seg.includes('src/foo') 恒 false
const multiSeg = isIgnored('any/depth/src/foo.js', ['**/src/foo.js'], false)
assert(multiSeg === false, '**/src/foo.js 当前行为：不匹配（r34 已知缺陷，语义上应匹配）')

// ── collectFiles 遍历 ──
const WS = join(TMP, 'ws')
mkdirSync(join(WS, 'src', 'deep', 'er', 'nest', 'ed', 'too', 'deep', 'way'), { recursive: true })
mkdirSync(join(WS, 'node_modules', 'pkg'), { recursive: true })
mkdirSync(join(WS, '.hidden'), { recursive: true })
mkdirSync(join(WS, 'dist'), { recursive: true })
for (const f of ['src/a.js', 'src/b.py', 'src/deep/c.js', 'src/deep/er/d.js', 'src/deep/er/nest/e.js', 'src/deep/er/nest/ed/f.js', 'src/deep/er/nest/ed/too/g.js', 'src/deep/er/nest/ed/too/deep/h.js', 'src/deep/er/nest/ed/too/deep/way/i.js', 'node_modules/pkg/x.js', '.hidden/s.js', 'dist/o.js', 'README.md']) {
  writeFileSync(join(WS, f), 'x')
}

const files = collectFiles(WS, {})
assert(files.length === 9, `默认忽略 node_modules/.hidden/dist，收集 9 个（实际 ${files.length}）`)
const paths = files.map(f => f.path.replace(WS + '/', ''))
assert(!paths.includes('node_modules/pkg/x.js'), 'node_modules 被忽略')
assert(!paths.includes('dist/o.js'), 'dist 被忽略')
assert(!paths.includes('.hidden/s.js'), '点目录被忽略')
assert(!paths.includes('README.md'), '非缓存扩展名不收集')
assert(paths.includes('src/a.js') && paths.includes('src/b.py'), '代码文件收集')

// maxFiles 限制
const capped = collectFiles(WS, { maxFiles: 3 })
assert(capped.length === 3, `maxFiles=3 截断（实际 ${capped.length}）`)

// 深度 8 内可遍历，9 层截断
const deepFiles = collectFiles(WS, {})
assert(deepFiles.some(f => f.path.includes('way/i.js')), '8 层深度可收集（depth>8 才截断）')
mkdirSync(join(WS, 'src', 'deep', 'er', 'nest', 'ed', 'too', 'deep', 'way', 'nine'), { recursive: true })
writeFileSync(join(WS, 'src', 'deep', 'er', 'nest', 'ed', 'too', 'deep', 'way', 'nine', 'j.js'), 'x')
const deep9 = collectFiles(WS, {})
assert(!deep9.some(f => f.path.includes('nine/j.js')), '9 层目录不遍历（depth>8 截断）')

// skipDirs
const skipped = collectFiles(WS, { skipDirs: ['src/deep'] })
assert(!skipped.some(f => f.path.includes('src/deep')), 'skipDirs 跳过子目录')

// 自定义规则
const withRule = collectFiles(WS, { ignoreRules: ['src/deep/er/'] })
assert(!withRule.some(f => f.path.includes('er/nest')), '自定义目录规则生效')
assert(withRule.some(f => f.path.includes('src/deep/c.js')), '自定义规则不误伤其他')

rmSync(TMP, { recursive: true, force: true })
console.log(`== test-file-collector: ${pass} passed, ${fail} failed ==`)
if (fail > 0) process.exit(1)
