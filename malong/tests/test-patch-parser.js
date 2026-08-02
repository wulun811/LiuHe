// test-patch-parser.js — SEARCH/REPLACE 块解析与三级降级匹配（r34-fix 补测）
// 重点：多行尾空格场景的精确匹配映射（normalized 索引 → 原文位置）
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}
const patch = await import(pathToFileURL(join(__dirname, '..', 'patch-parser.js')).href)

// ── 解析 ──
const blocks = patch.parseBlocks('<<<<<<< SEARCH\nconst a = 1\n=======\nconst a = 2\n>>>>>>> REPLACE\n<<<<<<< SEARCH\nfuncB()\n=======\nfuncB2()\n>>>>>>> REPLACE')
assert(blocks.length === 2, `解析 2 个块（实际 ${blocks.length}）`)
assert(blocks[0].search === 'const a = 1' && blocks[0].replace === 'const a = 2', '块 1 内容正确')
assert(blocks[1].search === 'funcB()' && blocks[1].replace === 'funcB2()', '块 2 内容正确')

// SEARCH 内含 markdown 表格分隔行（|---|）不被误判
const tableBlock = patch.parseBlocks('<<<<<<< SEARCH\n| a | b |\n|---|\n=======\n| a | b |\n>>>>>>> REPLACE')
assert(tableBlock.length === 1 && tableBlock[0].search.includes('|---|'), 'SEARCH 内表格分隔行保留')

// 插入块（空 search → append）
const insertBlocks = patch.parseBlocks('<<<<<<< SEARCH\n\n=======\nnew line\n>>>>>>> REPLACE')
assert(insertBlocks.length === 1, '空 SEARCH 块可解析')

// ── 应用：精确匹配 ──
{
  const r = patch.applyBlocks('const a = 1\nconst b = 2', [{ search: 'const a = 1', replace: 'const a = 99' }])
  assert(r.result === 'const a = 99\nconst b = 2', `精确替换（${JSON.stringify(r.result)}）`)
  assert(r.applied[0].method === 'exact', '方法标记 exact')
  assert(r.errors.length === 0, '无错误')
}

// 无匹配 → errors 上报
{
  const r = patch.applyBlocks('hello', [{ search: 'nope', replace: 'x' }])
  assert(r.errors.length === 1 && r.applied.length === 0, '无匹配上报 errors 且不篡改')
  assert(r.result === 'hello', '无匹配时原文不变')
}

// ── CRLF / 行尾空白规范化 ──
{
  const r = patch.applyBlocks('const a = 1\r\nconst b = 2', [{ search: 'const a = 1', replace: 'const a = 7' }])
  assert(r.result === 'const a = 7\r\nconst b = 2', `CRLF 内容可匹配且保留原文换行（${JSON.stringify(r.result)}）`)
}

// ── 多行尾空格匹配（r34-fix 目标：±5 窗口映射失败）──
{
  const content = Array.from({ length: 10 }, (_, i) => `line${i} `).join('\n')
  const search = Array.from({ length: 10 }, (_, i) => `line${i} `).join('\n')
  const r = patch.applyBlocks(content, [{ search, replace: 'REPLACED' }])
  assert(r.errors.length === 0, `多行尾空格应匹配成功（errors=${JSON.stringify(r.errors)}）`)
  assert(r.result === 'REPLACED', `多行尾空格替换生效（${JSON.stringify(r.result)}）`)
}

// ── 尾空格内容在中间位置 ──
{
  const content = 'prefix\n' + Array.from({ length: 8 }, (_, i) => `mid${i} `).join('\n') + '\nsuffix'
  const search = Array.from({ length: 8 }, (_, i) => `mid${i} `).join('\n')
  const r = patch.applyBlocks(content, [{ search, replace: 'MID' }])
  assert(r.errors.length === 0, '中间位置尾空格块匹配（errors=' + JSON.stringify(r.errors) + '）')
  assert(r.result === 'prefix\nMID\nsuffix', `中间替换生效（${JSON.stringify(r.result)}）`)
}

// ── fuzzy：空白差异（空格折叠）──
{
  const content = 'function  foo( a, b ) {\n  return  a + b\n}'
  // fuzzy：折叠空白（含换行）后一致——单行 SEARCH 匹配多行内容
  const search = 'function foo( a, b ) { return a + b }'
  const r = patch.applyBlocks(content, [{ search, replace: 'function foo(x) { return x }' }])
  assert(r.errors.length === 0, '空白差异走 fuzzy 匹配')
  assert(r.result.includes('function foo(x) { return x }'), `fuzzy 替换生效（${JSON.stringify(r.result)}）`)
  assert(r.applied[0].method === 'fuzzy', '方法标记 fuzzy')
}

// ── 多块依次应用（顺序语义）──
{
  const r = patch.applyBlocks('a\nb\nc', [
    { search: 'a', replace: 'A' },
    { search: 'b', replace: 'B' },
  ])
  assert(r.result === 'A\nB\nc', `多块顺序应用（${JSON.stringify(r.result)}）`)
}

// ── 插入块 append ──
{
  const r = patch.applyBlocks('base', [{ search: '', replace: 'tail' }])
  assert(r.result === 'base\ntail', `插入块 append（${JSON.stringify(r.result)}）`)
}

console.log(`== test-patch-parser: ${pass} passed, ${fail} failed ==`)
if (fail > 0) process.exit(1)
