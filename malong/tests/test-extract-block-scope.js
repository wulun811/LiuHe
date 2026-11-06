// test-extract-block-scope.js — 顶层块语句里的词法声明必须进符号索引
//
// 2026-11-02 DSH 实测：311 行的 kernel/scripts/pack-smoke.mjs 只索引到第 71 行——
// 整段脚本包在 try { ... } 里，而解析器用 `depth == 1` 判顶层。
// depth 是解析树层数：try 里的 const 在 depth 3 → 全丢。
//
// 判据改成祖先链：从声明到 program 之间没有函数/类/循环，就是模块级绑定。
// 反面同样钉死：函数内局部变量、块中块、循环体、for-of 绑定、类静态块都不得进索引。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  FAIL:', msg) } }

const pc = await import(pathToFileURL(join(__dirname, '..', 'parse-client.js')).href)
await pc.init({ log: () => {} })
try { await pc.connect() } catch {}

const src = [
  "import { readFileSync } from 'node:fs'",
  'const topLevel = 1',
  'try {',
  '  const inTry = 2',
  '  const arrowInTry = (x) => x + 1',
  '  function fnInTry() { return inTry }',
  '} catch (e) {',
  '  const inCatch = 3',
  '}',
  'if (topLevel) {',
  '  const inIf = 4',
  '}',
  'function outer() {',
  '  const localInFn = 5',
  '  if (localInFn) {',
  '    const deeperLocal = 6',
  '  }',
  '}',
  'for (const item of [1]) {',
  '  const inFor = item',
  '}',
  'export const exported = 7',
  'class C {',
  '  static { const inStatic = 8 }',
  '}',
  '',
].join('\n')

const r = await pc.extractAll(src, '.mjs')
const names = new Set(r.symbols.map((s) => s.name))
const has = (n) => names.has(n)

// ── ① 顶层与顶层块里的声明必须都能看到 ──
assert(has('topLevel'), `① 顶层 const 必须入索引（得 ${JSON.stringify([...names])}）`)
assert(has('inTry'), `① 顶层 try 里的 const 必须入索引（DSH 主诉）`)
assert(has('arrowInTry'), `① 顶层 try 里的箭头函数常量必须入索引`)
assert(has('fnInTry'), `① 顶层 try 里的 function 必须入索引`)
assert(has('inCatch'), `① catch 块里的 const 必须入索引`)
assert(has('inIf'), `① 顶层 if 块里的 const 必须入索引`)
assert(has('exported'), `① export const 不得因守卫改动而丢失`)

// ── ② 反面：局部/循环/静态块不得污染索引 ──
assert(!has('localInFn'), `② 函数内局部变量不得入索引（得 ${JSON.stringify([...names])}）`)
assert(!has('deeperLocal'), `② 函数内嵌套块变量不得入索引`)
assert(!has('inFor'), `② 循环体内的 const 不得入索引`)
assert(!has('item'), `② for-of 绑定名不得入索引`)
assert(!has('inStatic'), `② class 静态块里的 const 不得入索引`)

// ── ③ 行号必须指向真实声明行（范围不能因嵌套而错位）──
{
  const s = r.symbols.find((x) => x.name === 'inTry')
  assert(s && s.startLine === 4, `③ inTry 行号应为 4（得 ${JSON.stringify(s && s.startLine)}）`)
  const t = r.symbols.find((x) => x.name === 'arrowInTry')
  assert(t && t.startLine === 5, `③ arrowInTry 行号应为 5（得 ${JSON.stringify(t && t.startLine)}）`)
}

console.log(`== test-extract-block-scope: ${pass} passed, ${fail} failed ==`)
process.exit(fail > 0 ? 1 : 0)
