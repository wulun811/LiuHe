// test-index-note-accuracy.js — 索引覆盖说明必须与解析器实现一致
//
// 2026-11-02 DSH 复验发现：上一轮把实现修好了，提示却写反了——
// outline_note 与 symbol-search 零命中建议都写着「块语句里的声明不索引（top-level try/if/for/while）」，
// 而同一版本回包里，顶层 try 里的 sequenceStepsOf 是被列出来的。
//
// 因此本测试同时钉两头：
//   ① 真值表（真解析、真抽取）：哪些位置收、哪些位置不收
//   ② 文案：必须与真值表一一对应，且不得再说「wc -l 语义」
// 只钉文案或只钉行为，都会让二者重新漂开。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) { if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) } }

const { computeOutlineLineFields } = await import(pathToFileURL(join(__dirname, '..', 'code-index.js')).href)
const { INDEX_SCOPE_NOTE, INDEX_SCOPE_INDEXED, INDEX_SCOPE_NOT_INDEXED } =
  await import(pathToFileURL(join(__dirname, '..', 'index-scope.js')).href)
const pc = await import(pathToFileURL(join(__dirname, '..', 'parse-client.js')).href)

// ── ① 真值表：真解析一遍，确认「收 / 不收」的实际边界 ──
const src = [
  'const topLevel = 1',                     // 1  ✅
  'try {',                                   // 2
  '  const inTry = 2',                       // 3  ✅
  '  const arrowInTry = (x) => x + 1',       // 4  ✅
  '  function fnInTry() { return inTry }',   // 5  ✅
  '} catch (e) {',                           // 6
  '  const inCatch = 3',                     // 7  ✅
  '}',                                       // 8
  'if (topLevel) {',                         // 9
  '  const inIf = 4',                        // 10 ✅
  '}',                                       // 11
  'function outer() {',                      // 12
  '  const inFnBody = 5',                    // 13 ❌
  '  if (inFnBody) {',                       // 14
  '    const deeperInFn = 6',                // 15 ❌
  '  }',                                      // 16
  '}',                                       // 17
  'for (const item of [1]) {',               // 18
  '  const inForBody = item',                // 19 ❌
  '}',                                       // 20
  'while (topLevel) { const inWhile = 7 }',  // 21 ❌
  'export const exported = 8',               // 22 ✅
  'export function exportedFn() {}',         // 23 ✅
  'class C {',                                // 24
  '  static { const inStatic = 9 }',         // 25 ❌
  '  method() { const inMethod = 10 }',      // 26 ❌
  '}',                                        // 27
  '',
].join('\n')

await pc.init({ log: () => {} })
await pc.connect()
const extracted = await pc.extractAll(src, '.mjs')
const names = new Set(extracted.symbols.map((s) => s.name))

for (const want of ['topLevel', 'inTry', 'arrowInTry', 'fnInTry', 'inCatch', 'inIf', 'exported', 'exportedFn']) {
  assert(names.has(want), `① 应收：${want}（得 ${JSON.stringify([...names])}）`)
}
for (const bad of ['inFnBody', 'deeperInFn', 'inForBody', 'item', 'inWhile', 'inStatic', 'inMethod']) {
  assert(!names.has(bad), `① 不应收：${bad}（得 ${JSON.stringify([...names])}）`)
}

// ── ② 文案必须与真值表一致（措辞本身就是要修的缺陷）──
assert(/top-level try \/ catch \/ if/.test(INDEX_SCOPE_INDEXED), `② 说明必须写出「顶层 try/catch/if 体内也收」（得 ${INDEX_SCOPE_INDEXED}）`)
assert(/function bodies/.test(INDEX_SCOPE_NOT_INDEXED), '② 说明必须写出函数体不收')
assert(/loop bodies/.test(INDEX_SCOPE_NOT_INDEXED) && /for-of/.test(INDEX_SCOPE_NOT_INDEXED), '② 说明必须写出循环体（含 for-of 绑定）不收')
assert(/class static blocks/.test(INDEX_SCOPE_NOT_INDEXED), '② 说明必须写出 class 静态块不收')
assert(!/top-level try \/ if \/ for \/ while/.test(INDEX_SCOPE_NOTE), '② 不得再写「try/if/for/while 一并不索引」（与实现相反）')

// ── ③ 两处活文本必须共用同一个真相源（不是各写一份）──
const note = computeOutlineLineFields([{ start_line: 1, end_line: 3 }], 10).outline_note
assert(note && note.includes(INDEX_SCOPE_NOTE), `③ outline_note 必须内嵌共享文案（得 ${note}）`)
assert(!/NOT indexed — a symbol missing/.test(note || ''), '③ outline_note 不得再写旧的对立说法')
{
  const handlerSrc = readFileSync(join(__dirname, '..', 'tools', 'tool-symbol-search', 'handler.js'), 'utf-8')
  assert(/INDEX_SCOPE_NOTE/.test(handlerSrc), '③ symbol-search handler 必须引用共享文案常量')
  assert(!/Declarations inside block statements/.test(handlerSrc), '③ symbol-search handler 不得再内联旧说法')
}

// ── ④ lines 不得被描述成 wc -l（末行无换行时两者差 1）──
// 真实语义：按 \n 切分，末行无换行也算一行。wc -l 数的是换行符个数。
const contract = readFileSync(join(__dirname, '..', 'RESPONSE-CONTRACT.md'), 'utf-8')
const indexSrc = readFileSync(join(__dirname, '..', 'code-index.js'), 'utf-8')
assert(!/wc -l\s*语义/.test(contract), '④ RESPONSE-CONTRACT 不得把 lines 说成「wc -l 语义」')
assert(!/wc -l\s*语义/.test(indexSrc), '④ code-index 注释不得把 lines 说成「wc -l 语义」')
assert(/末行无换行/.test(indexSrc), '④ code-index 必须写明「末行无换行也算一行」')

console.log(`== test-index-note-accuracy: ${pass} passed, ${fail} failed ==`)
process.exit(fail > 0 ? 1 : 0)
