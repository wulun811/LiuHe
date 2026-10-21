// test-doc-files.js — 0.5.25：文档文件工具（doc-files.js）+ code_search 的文档兜底
// 覆盖：收集 .md/.txt（跳过点目录/node_modules） / 字面命中带文件+行号 / 长句退化为逐词 /
//       无命中返回空 / limit 生效 / 跳过超限文件
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
let pass = 0, fail = 0
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  FAIL:', msg) } }

const doc = await import(pathToFileURL(join(ROOT, 'doc-files.js')).href)

const TMP = mkdtempSync(join(tmpdir(), 'malong-docfiles-'))
mkdirSync(join(TMP, 'DOCS'), { recursive: true })
mkdirSync(join(TMP, 'src'), { recursive: true })
mkdirSync(join(TMP, 'node_modules', 'pkg'), { recursive: true })
mkdirSync(join(TMP, '.hidden'), { recursive: true })
writeFileSync(join(TMP, 'DOCS', '交付说明.md'), '# 交付说明\n\n本仓交付物就是文档。\n验收口径见版本协商机制。\n')
writeFileSync(join(TMP, 'DOCS', 'notes.txt'), 'plain notes\n版本协商 in plain text\n')
writeFileSync(join(TMP, 'src', 'README.md'), '# src\n')
writeFileSync(join(TMP, 'src', 'main.py'), 'print("x")\n')
writeFileSync(join(TMP, 'node_modules', 'pkg', 'readme.md'), 'should be skipped\n')
writeFileSync(join(TMP, '.hidden', 'secret.md'), 'skipped\n')
writeFileSync(join(TMP, '.dotfile.md'), 'skipped\n')

// ── 1. 收集 ──
const files = doc.collectDocFiles(TMP)
assert(files.includes('DOCS/交付说明.md'), '收集到 .md（中文名）')
assert(files.includes('DOCS/notes.txt'), '收集到 .txt')
assert(files.includes('src/README.md'), '收集到嵌套目录里的 .md')
assert(!files.includes('src/main.py'), '不收 .py')
assert(!files.some((f) => f.includes('node_modules')), '跳过 node_modules')
assert(!files.some((f) => f.includes('.hidden')), '跳过点目录')
assert(!files.includes('.dotfile.md'), '跳过点文件')

// ── 2. 字面命中 ──
const hits = doc.searchDocFiles(TMP, '版本协商', { limit: 10 })
assert(hits.length >= 2, '字面命中数 ≥ 2（得 ' + hits.length + '）')
assert(hits.some((h) => h.file === 'DOCS/交付说明.md' && h.line === 4), '命中带文件与行号（得 ' + JSON.stringify(hits[0]) + '）')
assert(hits.every((h) => h.text && h.matched), '命中带片段与匹配词')

// ── 3. 长句退化为逐词 ──
const longHits = doc.searchDocFiles(TMP, '请帮我找出关于版本协商机制的全部说明材料谢谢', { limit: 10 })
assert(longHits.length >= 1, '长句退化为逐词后仍有命中（得 ' + longHits.length + '）')

// ── 4. 无命中 ──
assert(doc.searchDocFiles(TMP, 'zzz-不存在的词-zzz', { limit: 10 }).length === 0, '无命中返回空数组')
assert(doc.searchDocFiles(TMP, '', { limit: 10 }).length === 0, '空查询返回空数组')

// ── 5. limit 生效 ──
const limited = doc.searchDocFiles(TMP, '版本协商', { limit: 1 })
assert(limited.length === 1, 'limit 生效（得 ' + limited.length + '）')

// ── 6. 超大文件跳过 ──
writeFileSync(join(TMP, 'DOCS', 'big.md'), 'x'.repeat(3 * 1024 * 1024) + '\n版本协商\n')
const afterBig = doc.searchDocFiles(TMP, '版本协商', { limit: 10, maxBytes: 1024 })
assert(!afterBig.some((h) => h.file === 'DOCS/big.md'), '超过 maxBytes 的文件被跳过')

// ── 7. 0.5.26：混排 query 精度（英文 + 中文）——碎片噪音回归防护 ──
writeFileSync(join(TMP, 'CONTRIBUTING.md'), '# CONTRIBUTING\n\nCONTRIBUTING covers triage and contributing.\n')
writeFileSync(join(TMP, 'DOCS', '混排.md'), '# 混排说明\n\nClaim-centric 科研对象在这里。\n\n单独提到 Claim-centric。\n')
const mixed = doc.searchDocFiles(TMP, 'Claim-centric 科研对象', { limit: 10 })
assert(mixed.length > 0, '混排 query 有命中（得 ' + mixed.length + '）')
assert(mixed[0].file === 'DOCS/混排.md', '混排 query 首个命中是真命中（得 ' + mixed[0].file + '）')
assert(mixed[0].matched === 'Claim-centric 科研对象', '混排 query 命中词是整串而非碎片（得 ' + mixed[0].matched + '）')
assert(!mixed.some(h => ['ntr', 'tri', 'ent', 'cla', 'aim'].includes(h.matched)), '混排 query 不产生英文碎片命中（得 ' + JSON.stringify(mixed.map(h => h.matched)) + '）')
assert(!mixed.some(h => h.file === 'CONTRIBUTING.md'), '混排 query 不误命中 CONTRIBUTING（碎片噪音回归防护）')

// ── 8. 0.5.26：每文件配额 + 特异度排序 ──
writeFileSync(join(TMP, 'DOCS', '多行.md'), '版本协商 一\n版本协商 二\n版本协商 三\n版本协商 四\n')
const quota = doc.searchDocFiles(TMP, '版本协商', { limit: 10 })
const fromMulti = quota.filter(h => h.file === 'DOCS/多行.md')
assert(fromMulti.length <= 2, '每文件配额生效：单文件不独占结果位（得 ' + fromMulti.length + '）')
assert(quota.length > 0 && quota[0].score >= 4, '整串命中 score 最高（得 ' + JSON.stringify(quota[0] || null) + '）')

console.log('\n=== test-doc-files: ' + pass + ' passed, ' + fail + ' failed ===')
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
process.exit(fail > 0 ? 1 : 0)
