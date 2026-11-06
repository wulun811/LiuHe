// index-scope.js — 符号索引「收什么 / 不收什么」的唯一真相源（2026-11-02 R18-B11）
//
// 为什么单独成文件：这条说明同时出现在两处活文本里——
//   ① code-index.js 的 outline_note（覆盖不全时随回执下发）
//   ② tools/tool-symbol-search/handler.js 的零命中建议
// 两处各写一份，改了一处忘了另一处，就会再次出现「提示与实现相反」。
//
// 上一轮的错法（DSH 复验发现）：解析器已经改了，顶层 try/catch/if 里的声明会进索引，
// 但提示仍写着「Declarations inside block statements (top-level try/if/for/while) are NOT indexed」。
// 同一份回包里，顶层 try 里的 sequenceStepsOf 明明被列了出来——提示却把能用的能力说成盲区。
// 这类文案是用来防止「没索引到」被读成「不存在」的；写反了，就会把读者赶去重写一个已存在的函数。
//
// 边界由 malong-parse 的 is_module_scope_binding() 决定，
// 夹具与真值表见 tests/test-index-note-accuracy.js（本文件的措辞必须与它一致）。

export const INDEX_SCOPE_INDEXED =
  'Indexed: top-level declarations, plus declarations inside top-level try / catch / if blocks ' +
  '(export const / export function included).'

export const INDEX_SCOPE_NOT_INDEXED =
  'Not indexed: declarations inside function bodies, inside loop bodies ' +
  '(for / while / for-of, including the loop variable binding), or inside class static blocks / method bodies.'

export const INDEX_SCOPE_NOTE = INDEX_SCOPE_INDEXED + ' ' + INDEX_SCOPE_NOT_INDEXED
