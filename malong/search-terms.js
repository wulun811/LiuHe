// search-terms.js — 查询假设词（caller_hypothesis）的唯一边界校验
//
// 专家 2026-10-31《中文自然语言检索与代码定位》P1：code_task 与 code_search 必须用
// **同一套**规则处理 search_terms，否则同一份输入在两个入口得到不同结论（跨入口矛盾）。
// 这里只做纯函数校验：无 I/O、无时间、无随机；不回显被丢弃的原值（避免把密钥写回回执）。
export const MAX_SEARCH_TERMS = 8
export const MAX_SEARCH_TERM_LEN = 64
// 控制字符（含换行/制表/转义序列）不进检索词：它们既不是标识符，也会把回执搞脏
const CONTROL_RE = /[\u0000-\u001f\u007f]/

/**
 * @param {unknown} raw 调用方传入的 search_terms
 * @returns {{ok: true, provided: boolean, terms: string[], dropped: Array<{index:number, reason:string}>}
 *          | {ok: false, error: string}}
 */
export function normalizeSearchTerms(raw) {
  if (raw == null) return { ok: true, provided: false, terms: [], dropped: [] }
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'search_terms must be an array of strings' }
  }
  const terms = []
  const dropped = []
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i]
    if (typeof s !== 'string') { dropped.push({ index: i, reason: 'not_a_string' }); continue }
    const t = s.trim()
    if (!t) { dropped.push({ index: i, reason: 'empty' }); continue }
    if (t.length > MAX_SEARCH_TERM_LEN) { dropped.push({ index: i, reason: 'too_long' }); continue }
    if (CONTROL_RE.test(t)) { dropped.push({ index: i, reason: 'control_char' }); continue }
    if (terms.includes(t)) { dropped.push({ index: i, reason: 'duplicate' }); continue }
    if (terms.length >= MAX_SEARCH_TERMS) { dropped.push({ index: i, reason: 'over_limit' }); continue }
    terms.push(t)
  }
  return { ok: true, provided: true, terms, dropped }
}
