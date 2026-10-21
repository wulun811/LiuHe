// workflow/maintain.js — S4.3 maintain 提案层（G4 保守）。
// 复用 fix_imports 的只读分析（transaction_ready 已过语法护栏），产出可经统一写路径应用的补丁提案；
// 绝不在此层写盘：写盘一律由 code_maintain 走 writeSymbols（journal/operation/证据）。
// 保守点：仅接受 fix_imports 已判语法安全的 patch；Rust 只报告（fix_imports 不给 transaction_ready）；
// 不删死代码（G4）；不猜业务影响。
import { createHash } from 'node:crypto'
import { handle as fixImportsH } from '../tools/tool-fix-imports/handler.js'

export const MAINTAIN_RULES_VERSION = { import_fix: 'fiximports-patch-v1' }

// malong-ignore: 提案身份指纹，非密码学用途
export function proposalFingerprint(p) {
  return 'fp_' + createHash('sha256').update(`${p.file}\0${p.old_string}\0${p.new_string}`).digest('hex').slice(0, 16)
}

// 对每个文件跑 fix_imports（只读）并归集 transaction_ready 为统一补丁提案。
// analyze 可注入（测试用 stub）；默认真实 fix_imports handler。
export async function proposeImportFixes({ workspaceDir, files, context, analyze = fixImportsH, maxCandidates = 10, maxPerFile = 20 } = {}) {
  const proposals = []
  const skipped = []
  const issuesByFile = {}
  for (const file of [...new Set(files || [])]) {
    if (typeof file !== 'string' || !file) continue
    let r = null
    try {
      r = await analyze({ workspace_dir: workspaceDir, file, max_candidates: maxCandidates }, context || {})
    } catch (e) {
      skipped.push({ file, reason: 'analyzer_failed', detail: String(e?.message || e).slice(0, 200) })
      continue
    }
    if (!r || r.error) { skipped.push({ file, reason: r?.error || 'analyzer_error' }); continue }
    if (r.supported === false) { skipped.push({ file, reason: 'language_not_supported' }); continue }
    const issues = Array.isArray(r.issues) ? r.issues : []
    issuesByFile[file] = issues.map(i => i.type)
    const tr = Array.isArray(r.transaction_ready) ? r.transaction_ready.slice(0, maxPerFile) : []
    if (tr.length === 0) { skipped.push({ file, reason: issues.length ? 'no_safe_patch' : 'clean' }); continue }
    for (const t of tr) {
      if (!t || typeof t.old_string !== 'string' || typeof t.new_string !== 'string') continue
      if (t.old_string === t.new_string) continue
      const p = { file: (typeof t.file === 'string' && t.file) ? t.file : file, old_string: t.old_string, new_string: t.new_string, kind: 'import_fix' }
      p.fingerprint = proposalFingerprint(p)
      proposals.push(p)
    }
  }
  return { proposals, skipped, issuesByFile }
}

// 按指纹/显式清单筛选提案（apply 时选择性应用）。未提供 → 全选。
export function selectProposals(all, requested) {
  if (!Array.isArray(requested) || requested.length === 0) return all
  const set = new Set(requested.map(x => (typeof x === 'string' ? x : x?.fingerprint)).filter(Boolean))
  return all.filter(p => set.has(p.fingerprint))
}