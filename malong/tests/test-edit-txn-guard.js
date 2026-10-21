// test-edit-txn-guard.js — 批10-1：edit_transaction 校验护栏 + commit 复检 + stats + committed 续接
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) { if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) } }
const { handle } = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-edit-transaction', 'handler.js')).href)

const ws = join(os.tmpdir(), 'opencode', 'txn-guard-ws')
try { rmSync(ws, { recursive: true, force: true }) } catch {}
mkdirSync(ws, { recursive: true })
const f = (n, c) => writeFileSync(join(ws, n), c)
const read = n => readFileSync(join(ws, n), 'utf-8')

const failParser = { hasErrorsAsync: async () => ({ has_errors: true }) }
const okParser = { hasErrorsAsync: async () => ({ has_errors: false }) }
const ctxFail = { codeIndexService: null, langParserService: failParser }
const ctxOk = { codeIndexService: null, langParserService: okParser }
const ctxNone = { codeIndexService: null }

// ① 语法失败 → 拦截，文件未落盘
{
  f('s1.js', 'const a = 1\n')
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'g1' }, ctxFail)
  const r = await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 's1.js', edits: [{ old_string: 'const a = 1', new_string: 'const a = 1 const' }] }, ctxFail)
  assert(r.status === 'edit_failed' && r.error_code === 'VALIDATION_FAILED', '① 语法失败拦截（得 ' + JSON.stringify({ s: r.status, c: r.error_code }) + '）')
  assert(read('s1.js') === 'const a = 1\n', '① 文件未落盘')
  assert(r.validation && r.validation.syntax && r.validation.syntax.status === 'fail', '① validation.syntax=fail')
  assert(Array.isArray(r.diagnostics) && r.diagnostics.some(d => d.source === 'syntax'), '① diagnostics 带 syntax 标记')
  await handle({ workspace_dir: ws, action: 'rollback', txn_id: b.txnId }, ctxFail)
}

// ② 语法通过 → 放行 + validation 回执
{
  f('s2.js', 'const a = 1\n')
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'g2' }, ctxOk)
  const r = await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 's2.js', edits: [{ old_string: 'const a = 1', new_string: 'const a = 2' }] }, ctxOk)
  assert(r.status === 'staged', '② staged（得 ' + r.status + '）')
  assert(r.validation && r.validation.syntax.status === 'pass' && r.validation.bracket.status === 'pass', '② validation pass')
  assert(read('s2.js').includes('const a = 2'), '② 文件已改')
  await handle({ workspace_dir: ws, action: 'rollback', txn_id: b.txnId }, ctxOk)
}

// ③ 正则字面量：stripper 直接识别（不再需要仲裁降级），不误拦
{
  f('s3.js', 'const x = 1\n')
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'g3' }, ctxOk)
  const r = await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 's3.js', edits: [{ old_string: 'const x = 1', new_string: 'const re = /[)]/' }] }, ctxOk)
  assert(r.status === 'staged', '③ 不误拦（得 ' + r.status + '）')
  assert(r.validation && r.validation.bracket.status === 'pass' && !r.validation.bracket.false_positive_downgraded, '③ 正则识别后 bracket 原生 pass（无降级标记）')
  await handle({ workspace_dir: ws, action: 'rollback', txn_id: b.txnId }, ctxOk)
}

// ③b P0 锁（2026-10-12 狗粮）：syntax 报 pass（mock 模拟 daemon EOF 漏报）但 bracket 抓到 EOF 未闭合 → 必须拦截不落盘
// 旧实现在此场景把 bracket fail 降级为 pass → 坏文件静默落盘（真阳性：删 } 的 JS 被 Preview OK 写盘）
{
  f('s3b.js', 'function f() {\n  return 1;\n}\n')
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'g3b' }, ctxOk)
  const r = await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 's3b.js', edits: [{ old_string: 'function f() {\n  return 1;\n}', new_string: 'function f() {\n  return 1;' }] }, ctxOk)
  assert(r.status === 'edit_failed' && r.error_code === 'VALIDATION_FAILED', '③b daemon 漏报类真失败被拦截（得 ' + JSON.stringify({ s: r.status, c: r.error_code }) + '）')
  assert(r.validation && r.validation.bracket && r.validation.bracket.status === 'fail' && r.validation.bracket.syntax_disagreement === true, '③b bracket fail 保留 + disagreement 标注')
  assert(read('s3b.js') === 'function f() {\n  return 1;\n}\n', '③b 文件未落盘')
  const r2 = await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 's3b.js', edits: [{ old_string: 'function f() {\n  return 1;\n}', new_string: 'function f() {\n  return 1;' }], safety: { block_on_validation_error: false } }, ctxOk)
  assert(r2.status === 'staged', '③c 显式 override 放行（得 ' + r2.status + '）')
  await handle({ workspace_dir: ws, action: 'rollback', txn_id: b.txnId }, ctxOk)
}

// ④ markdown 不产 bracket 噪声
{
  f('doc.md', '# title\n')
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'g4' }, ctxNone)
  const r = await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 'doc.md', edits: [{ old_string: '# title', new_string: '# title (unbalanced ((' }] }, ctxNone)
  assert(r.status === 'staged' && !r.validation_warnings, '④ md 无警告')
  assert(r.validation && r.validation.syntax.status === 'skip', '④ md syntax skip')
  await handle({ workspace_dir: ws, action: 'rollback', txn_id: b.txnId }, ctxNone)
}

// ⑤ strict 拦 syntax skip；override=false 放行
{
  f('s5.js', 'const a = 1\n')
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'g5' }, ctxNone)
  const r1 = await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 's5.js', edits: [{ old_string: 'const a = 1', new_string: 'const a = 5' }], safety: { profile: 'strict' } }, ctxNone)
  assert(r1.status === 'edit_failed' && r1.error_code === 'VALIDATION_FAILED', '⑤ strict 拦 skip（得 ' + JSON.stringify({ s: r1.status, c: r1.error_code }) + '）')
  const r2 = await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 's5.js', edits: [{ old_string: 'const a = 1', new_string: 'const a = 5' }], safety: { block_on_validation_error: false } }, ctxNone)
  assert(r2.status === 'staged', '⑤ override 放行（得 ' + r2.status + '）')
  await handle({ workspace_dir: ws, action: 'rollback', txn_id: b.txnId }, ctxNone)
}

// ⑥ commit 复检：stage 时无解析器（skip 放行）→ commit 时有解析器 → 拦
{
  f('s6.js', 'const a = 1\n')
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'g6' }, ctxNone)
  const r = await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 's6.js', edits: [{ old_string: 'const a = 1', new_string: 'const a = 1 const' }] }, ctxNone)
  assert(r.status === 'staged', '⑥ stage 放行（无解析器，得 ' + r.status + '）')
  const c = await handle({ workspace_dir: ws, action: 'commit', txn_id: b.txnId }, ctxFail)
  assert(c.error === 'commit_blocked' && c.code === 'VALIDATION_FAILED', '⑥ commit 复检拦截（得 ' + JSON.stringify({ e: c.error, c: c.code }) + '）')
  assert(c.validation && c.validation.syntax.status === 'fail', '⑥ commit 回执带 validation')
  const rb = await handle({ workspace_dir: ws, action: 'rollback', txn_id: b.txnId }, ctxNone)
  assert(rb.status === 'rolled_back' && read('s6.js') === 'const a = 1\n', '⑥ 回滚恢复')
}

// ⑦ commit 回执 stats（lines_before/after/delta）
{
  f('s7.js', 'line1\nline2\nline3\n')
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'g7' }, ctxOk)
  await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 's7.js', edits: [{ old_string: 'line3', new_string: 'line3\nline4' }] }, ctxOk)
  const c = await handle({ workspace_dir: ws, action: 'commit', txn_id: b.txnId }, ctxOk)
  assert(c.status === 'committed' && Array.isArray(c.stats) && c.stats.length === 1, '⑦ commit 带 stats')
  const st = c.stats && c.stats[0]
  assert(st && st.lines_before === 3 && st.lines_after === 4 && st.delta === 1, '⑦ stats 行数（得 ' + JSON.stringify(st) + '）')
}

// ⑧ committed 续接：edit 自动开新事务，undo 续接事务回到首提交内容
{
  f('s8.js', 'v1\n')
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'g8' }, ctxOk)
  await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 's8.js', edits: [{ old_string: 'v1', new_string: 'v2' }] }, ctxOk)
  const c = await handle({ workspace_dir: ws, action: 'commit', txn_id: b.txnId }, ctxOk)
  assert(c.status === 'committed', '⑧ 首次 commit（得 ' + c.status + '）')
  const r = await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 's8.js', edits: [{ old_string: 'v2', new_string: 'v3' }] }, ctxOk)
  assert(r.status === 'staged' && r.continued_from === b.txnId && r.txn_id && r.txn_id !== b.txnId, '⑧ 续接新事务（得 ' + JSON.stringify({ s: r.status, cf: r.continued_from, t: r.txn_id }) + '）')
  assert(read('s8.js').includes('v3'), '⑧ 续接已写')
  await handle({ workspace_dir: ws, action: 'commit', txn_id: r.txn_id }, ctxOk)
  const u = await handle({ workspace_dir: ws, action: 'undo_commit', txn_id: r.txn_id }, ctxOk)
  assert(u.status === 'undone' && read('s8.js').includes('v2'), '⑧ 续接 undo 回到 v2（得 ' + u.status + '）')
}

// ⑨ new_lines：数组形式消换行转义
{
  f('s9.js', 'const a = 1\n')
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'g9' }, ctxOk)
  const r = await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 's9.js', edits: [{ old_string: 'const a = 1', new_lines: ['const a = 2', 'const b = 3'] }] }, ctxOk)
  assert(r.status === 'staged' && read('s9.js') === 'const a = 2\nconst b = 3\n', '⑨ new_lines 组装（得 ' + JSON.stringify(read('s9.js')) + '）')
  await handle({ workspace_dir: ws, action: 'rollback', txn_id: b.txnId }, ctxOk)
}

// ⑩ line_span：替换 / 插入 / 到 EOF
{
  f('s10.js', 'l1\nl2\nl3\n')
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'g10' }, ctxOk)
  const r1 = await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 's10.js', edits: [{ line_span: { start_line: 2, end_line: 2 }, new_lines: ['X'] }] }, ctxOk)
  assert(r1.status === 'staged' && read('s10.js') === 'l1\nX\nl3\n', '⑩ 行替换（得 ' + JSON.stringify(read('s10.js')) + '）')
  const r2 = await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 's10.js', edits: [{ line_span: { start_line: 3 }, new_lines: ['Y'] }] }, ctxOk)
  assert(r2.status === 'staged' && read('s10.js') === 'l1\nX\nY\nl3\n', '⑩ 行插入（得 ' + JSON.stringify(read('s10.js')) + '）')
  const r3 = await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 's10.js', edits: [{ line_span: { start_line: 4, end_line: null }, new_lines: ['Z'] }] }, ctxOk)
  assert(r3.status === 'staged' && read('s10.js') === 'l1\nX\nY\nZ\n', '⑩ 行到 EOF 替换（得 ' + JSON.stringify(read('s10.js')) + '）')
  await handle({ workspace_dir: ws, action: 'rollback', txn_id: b.txnId }, ctxOk)
}

// ⑪ expect_sha：失配拦、命中放行
{
  const crypto = await import('node:crypto')
  const sha = crypto.createHash('sha256').update('sha1\n').digest('hex')
  f('s11.js', 'sha1\n')
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'g11' }, ctxOk)
  const rBad = await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 's11.js', edits: [{ line_span: { start_line: 1, end_line: 1 }, expect_sha: 'deadbeef', new_lines: ['sha2'] }] }, ctxOk)
  assert(rBad.status === 'edit_failed' && rBad.error_code === 'STALE_CONTENT', '⑪ sha 失配拦（得 ' + JSON.stringify({ s: rBad.status, c: rBad.error_code }) + '）')
  assert(read('s11.js') === 'sha1\n', '⑪ 失配未落盘')
  const rOk = await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 's11.js', edits: [{ line_span: { start_line: 1, end_line: 1 }, expect_sha: sha, new_lines: ['sha2'] }] }, ctxOk)
  assert(rOk.status === 'staged' && read('s11.js') === 'sha2\n', '⑪ sha 命中放行')
  assert(Array.isArray(rOk.anchor_checked_lines) && rOk.anchor_checked_lines.includes(1), 'AC29 回执可见已核对锚点（得 ' + JSON.stringify(rOk.anchor_checked_lines) + '）')

  // 14-A AC29：公开 schema 位（line_span.expect_sha）——旧实现静默忽略；失配拦、命中放、双位置冲突拒
  const sha2v = crypto.createHash('sha256').update('sha2\n').digest('hex')
  const rInnerBad = await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 's11.js', edits: [{ line_span: { start_line: 1, end_line: 1, expect_sha: 'deadbeef' }, new_lines: ['sha2x'] }] }, ctxOk)
  assert(rInnerBad.status === 'edit_failed' && rInnerBad.error_code === 'STALE_CONTENT', '⑪x AC29 内位 sha 失配拦（得 ' + JSON.stringify({ s: rInnerBad.status, c: rInnerBad.error_code }) + '）')
  assert(read('s11.js') === 'sha2\n', '⑪x AC29 内位失配未落盘')
  const rInnerOk = await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 's11.js', edits: [{ line_span: { start_line: 1, end_line: 1, expect_sha: sha2v }, new_lines: ['sha3'] }] }, ctxOk)
  assert(rInnerOk.status === 'staged' && read('s11.js') === 'sha3\n', '⑪x AC29 内位 sha 命中放行')
  const rConflict = await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 's11.js', edits: [{ line_span: { start_line: 1, end_line: 1, expect_sha: sha2v }, expect_sha: 'deadbeef', new_lines: ['x'] }] }, ctxOk)
  assert(rConflict.status === 'edit_failed' && rConflict.error_code === 'INVALID_INPUT', '⑪x AC29 双位置异值拒（得 ' + JSON.stringify({ s: rConflict.status, c: rConflict.error_code }) + '）')
  assert(read('s11.js') === 'sha3\n', '⑪x AC29 冲突未落盘')
  const sha3v = crypto.createHash('sha256').update('sha3\n').digest('hex')
  const rBothSame = await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 's11.js', edits: [{ line_span: { start_line: 1, end_line: 1, expect_sha: 'sha256:' + sha3v }, expect_sha: sha3v, new_lines: ['sha4'] }] }, ctxOk)
  assert(rBothSame.status === 'staged' && read('s11.js') === 'sha4\n', '⑪x AC29 双位置同值放行（sha256: 前缀归一）')
  const pv = await handle({ workspace_dir: ws, action: 'edit', file: 's11.js', dry_run: true, edits: [{ line_span: { start_line: 1, end_line: 1, expect_sha: 'deadbeef' }, new_lines: ['x'] }] }, ctxOk)
  assert(pv.would_apply === 0 && (pv.failed_edits || []).some(e => e.reason === 'stale_content'), '⑪x AC29 dry_run 内位失配 → failed stale_content（得 ' + JSON.stringify(pv.failed_edits || null) + '）')
  await handle({ workspace_dir: ws, action: 'rollback', txn_id: b.txnId }, ctxOk)
}

// ⑪m AC29 批量入口（edit_multi）：内位 sha 守卫覆盖 dry_run/apply，预览-应用一致，回执可见锚点
{
  const crypto = await import('node:crypto')
  const h = s => crypto.createHash('sha256').update(s).digest('hex')
  f('m1.js', 'm1\n'); f('m2.js', 'm2\n')
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'g11m' }, ctxOk)
  // ① 批量 dry_run 内位 sha 失配 → 报 stale，不落盘
  const pvBad = await handle({ workspace_dir: ws, action: 'edit_multi', txn_id: b.txnId, dry_run: true, file_edits: [{ file: 'm1.js', edits: [{ line_span: { start_line: 1, end_line: 1, expect_sha: 'deadbeef' }, new_lines: ['mx'] }] }] }, ctxOk)
  assert(pvBad.status === 'preview' && (pvBad.files[0].failed_edits || []).some(e => e.reason === 'stale_content'), 'AC29m 批量 dry_run 失配 → stale（得 ' + JSON.stringify(pvBad.files?.[0]?.failed_edits) + '）')
  assert(read('m1.js') === 'm1\n', 'AC29m 批量 dry_run 未落盘')
  // ② 批量 dry_run 内位 sha 命中 → would_apply=1
  const pvOk = await handle({ workspace_dir: ws, action: 'edit_multi', txn_id: b.txnId, dry_run: true, file_edits: [{ file: 'm1.js', edits: [{ line_span: { start_line: 1, end_line: 1, expect_sha: h('m1\n') }, new_lines: ['mx'] }] }] }, ctxOk)
  assert(pvOk.status === 'preview' && pvOk.files[0].would_apply === 1, 'AC29m 批量 dry_run 命中 → would_apply=1（得 ' + JSON.stringify(pvOk.files?.[0]?.would_apply) + '）')
  // ③ 批量 apply 内位 sha 命中 → 成功（预览=应用一致）
  const apOk = await handle({ workspace_dir: ws, action: 'edit_multi', txn_id: b.txnId, file_edits: [{ file: 'm2.js', edits: [{ line_span: { start_line: 1, end_line: 1, expect_sha: h('m2\n') }, new_lines: ['m2y'] }] }] }, ctxOk)
  assert(apOk.status === 'staged' && read('m2.js') === 'm2y\n', 'AC29m 批量 apply 命中放行（得 ' + JSON.stringify({ s: apOk.status, c: read('m2.js') }) + '）')
  assert(apOk.files[0].anchor_checked_lines?.includes(1), 'AC29m 批量 apply 回执可见已核对锚点（得 ' + JSON.stringify(apOk.files?.[0]?.anchor_checked_lines) + '）')
  // ④ 批量 apply 内位 sha 失配（旧 sha） → 拦且不落盘（独立 txn 避免污染）
  const b2 = await handle({ workspace_dir: ws, action: 'begin', name: 'g11m2' }, ctxOk)
  const apBad = await handle({ workspace_dir: ws, action: 'edit_multi', txn_id: b2.txnId, file_edits: [{ file: 'm2.js', edits: [{ line_span: { start_line: 1, end_line: 1, expect_sha: h('m2\n') }, new_lines: ['m2z'] }] }] }, ctxOk)
  assert(apBad.status === 'rolled_back' && (apBad.files || []).some(x => x.error_code === 'STALE_CONTENT'), 'AC29m 批量 apply 失配拦（得 ' + JSON.stringify({ s: apBad.status, f: apBad.files }) + '）')
  assert(read('m2.js') === 'm2y\n', 'AC29m 批量 apply 失配未落盘')
  await handle({ workspace_dir: ws, action: 'rollback', txn_id: b.txnId }, ctxOk)
  await handle({ workspace_dir: ws, action: 'rollback', txn_id: b2.txnId }, ctxOk)
}

// ⑫ 非法 span / 缺内容 → 失败且文件未动；元素校验放宽
{
  f('s12.js', 'a\nb\n')
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'g12' }, ctxOk)
  const r1 = await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 's12.js', edits: [{ line_span: { start_line: 0 }, new_lines: ['x'] }] }, ctxOk)
  assert(r1.status === 'edit_failed', '⑫ start_line 0 拒（得 ' + r1.status + '）')
  const r2 = await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 's12.js', edits: [{ line_span: { start_line: 2, end_line: 1 }, new_lines: ['x'] }] }, ctxOk)
  assert(r2.status === 'edit_failed', '⑫ end<start 拒')
  const r3 = await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 's12.js', edits: [{ line_span: { start_line: 1, end_line: 1 } }] }, ctxOk)
  assert(r3.status === 'edit_failed', '⑫ 缺 new_lines/new_string 拒')
  const r4 = await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 's12.js', edits: [{ new_string: 'x' }] }, ctxOk)
  assert(r4.error_code === 'INVALID_INPUT', '⑫ 无 old_string/line_span 元素拒（得 ' + r4.error_code + '）')
  assert(read('s12.js') === 'a\nb\n', '⑫ 文件未动')
  await handle({ workspace_dir: ws, action: 'rollback', txn_id: b.txnId }, ctxOk)
}
// ⑬ chunk 分块累积 → assemble 组装 + parts 清理
{
  f('s13.js', 'old1\nold2\nold3\n')
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'g13' }, ctxOk)
  const c1 = await handle({ workspace_dir: ws, action: 'edit_chunk', txn_id: b.txnId, file: 's13.js', seq: 1, total: 2, lines: ['a', 'b'] }, ctxOk)
  assert(c1.status === 'chunk_received' && c1.seq === 1 && c1.received === 1 && c1.ready_to_assemble === false, '⑬ chunk1 接收（得 ' + JSON.stringify(c1) + '）')
  const c2 = await handle({ workspace_dir: ws, action: 'edit_chunk', txn_id: b.txnId, file: 's13.js', seq: 2, total: 2, lines: ['c'] }, ctxOk)
  assert(c2.status === 'chunk_received' && c2.ready_to_assemble === true, '⑬ chunk2 就绪')
  const a = await handle({ workspace_dir: ws, action: 'assemble', txn_id: b.txnId, file: 's13.js' }, ctxOk)
  assert(a.status === 'staged' && read('s13.js') === 'a\nb\nc', '⑬ assemble 组装（得 ' + JSON.stringify(read('s13.js')) + '）')
  const staging = join(ws, '.ai-transactions', b.txnId, 'staging')
  const parts = existsSync(staging) ? readdirSync(staging) : []
  assert(parts.length === 0, '⑬ parts 清理（剩 ' + JSON.stringify(parts) + '）')
  await handle({ workspace_dir: ws, action: 'rollback', txn_id: b.txnId }, ctxOk)
}

// ⑭ 断档拒 + 重发同 seq 覆盖 + 缺失 part → CHUNK_INCOMPLETE
{
  f('s14.js', 'x\n')
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'g14' }, ctxOk)
  await handle({ workspace_dir: ws, action: 'edit_chunk', txn_id: b.txnId, file: 's14.js', seq: 1, lines: ['p'] }, ctxOk)
  const gap = await handle({ workspace_dir: ws, action: 'edit_chunk', txn_id: b.txnId, file: 's14.js', seq: 3, lines: ['q'] }, ctxOk)
  assert(gap.error_code === 'CHUNK_SEQ_GAP' && gap.expected_seq === 2, '⑭ 断档拒（得 ' + JSON.stringify({ c: gap.error_code, e: gap.expected_seq }) + '）')
  await handle({ workspace_dir: ws, action: 'edit_chunk', txn_id: b.txnId, file: 's14.js', seq: 2, lines: ['q'] }, ctxOk)
  const resend = await handle({ workspace_dir: ws, action: 'edit_chunk', txn_id: b.txnId, file: 's14.js', seq: 2, lines: ['Q'] }, ctxOk)
  assert(resend.status === 'chunk_received', '⑭ 重发同 seq 覆盖')
  const a = await handle({ workspace_dir: ws, action: 'assemble', txn_id: b.txnId, file: 's14.js' }, ctxOk)
  assert(a.status === 'staged' && read('s14.js') === 'p\nQ', '⑭ 重发生效（得 ' + JSON.stringify(read('s14.js')) + '）')
  await handle({ workspace_dir: ws, action: 'rollback', txn_id: b.txnId }, ctxOk)
}
{
  f('s14b.js', 'x\n')
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'g14b' }, ctxOk)
  await handle({ workspace_dir: ws, action: 'edit_chunk', txn_id: b.txnId, file: 's14b.js', seq: 1, total: 2, lines: ['p'] }, ctxOk)
  await handle({ workspace_dir: ws, action: 'edit_chunk', txn_id: b.txnId, file: 's14b.js', seq: 2, lines: ['q'] }, ctxOk)
  const crypto3 = await import('node:crypto')
  const prefix = crypto3.createHash('sha256').update('s14b.js').digest('hex').slice(0, 16)
  rmSync(join(ws, '.ai-transactions', b.txnId, 'staging', prefix + '.part-2'), { force: true })
  const inc = await handle({ workspace_dir: ws, action: 'assemble', txn_id: b.txnId, file: 's14b.js' }, ctxOk)
  assert(inc.error_code === 'CHUNK_INCOMPLETE', '⑭ 缺 part → CHUNK_INCOMPLETE（得 ' + inc.error_code + '）')
  await handle({ workspace_dir: ws, action: 'rollback', txn_id: b.txnId }, ctxOk)
}

// ⑮ 坏块 assemble 拦截（不落盘、parts 保留）→ 重发修复后成功
{
  f('s15.js', 'const ok = 1\n')
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'g15' }, ctxOk)
  await handle({ workspace_dir: ws, action: 'edit_chunk', txn_id: b.txnId, file: 's15.js', seq: 1, lines: ['const ok = 1 const broken'] }, ctxOk)
  const a1 = await handle({ workspace_dir: ws, action: 'assemble', txn_id: b.txnId, file: 's15.js' }, ctxFail)
  assert(a1.error_code === 'VALIDATION_FAILED', '⑮ 坏块 assemble 拦（得 ' + a1.error_code + '）')
  assert(read('s15.js') === 'const ok = 1\n', '⑮ 未落盘')
  const staging2 = join(ws, '.ai-transactions', b.txnId, 'staging')
  const kept = existsSync(staging2) ? readdirSync(staging2).length : 0
  assert(kept === 1, '⑮ parts 保留待修（得 ' + kept + '）')
  await handle({ workspace_dir: ws, action: 'edit_chunk', txn_id: b.txnId, file: 's15.js', seq: 1, lines: ['const ok = 2'] }, ctxOk)
  const a2 = await handle({ workspace_dir: ws, action: 'assemble', txn_id: b.txnId, file: 's15.js' }, ctxOk)
  assert(a2.status === 'staged' && read('s15.js') === 'const ok = 2', '⑮ 重发坏块后组装成功（得 ' + JSON.stringify(read('s15.js')) + '）')
  await handle({ workspace_dir: ws, action: 'rollback', txn_id: b.txnId }, ctxOk)
}

// ⑯ 事故载荷复现：300 行全文重写走 3 块（每块 100 行）
{
  const lines300 = []
  for (let i = 1; i <= 300; i++) lines300.push('line' + i)
  f('s16.js', 'placeholder\n')
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'g16' }, ctxOk)
  for (let c = 0; c < 3; c++) {
    await handle({ workspace_dir: ws, action: 'edit_chunk', txn_id: b.txnId, file: 's16.js', seq: c + 1, total: 3, lines: lines300.slice(c * 100, c * 100 + 100) }, ctxOk)
  }
  const a = await handle({ workspace_dir: ws, action: 'assemble', txn_id: b.txnId, file: 's16.js' }, ctxOk)
  const got = read('s16.js')
  assert(a.status === 'staged' && got.split('\n').length === 300 && got.startsWith('line1\nline2') && got.endsWith('line300'), '⑯ 300 行分块重写（得 ' + got.split('\n').length + ' 行）')
  await handle({ workspace_dir: ws, action: 'rollback', txn_id: b.txnId }, ctxOk)
}

// ⑰ chunk 目标不存在 → 早拒 FILE_NOT_FOUND（不写 staging；提示 create:true）
{
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'g17' }, ctxOk)
  const r = await handle({ workspace_dir: ws, action: 'edit_chunk', txn_id: b.txnId, file: 'no-such.js', seq: 1, lines: ['x'] }, ctxFail)
  assert(r.error_code === 'FILE_NOT_FOUND', '⑰ 不存在文件早拒（得 ' + r.error_code + '）')
  assert((r.message || '').includes('create:true'), '⑰ 提示 code_patch create:true')
  const staging = join(ws, '.ai-transactions', b.txnId, 'staging')
  const n = existsSync(staging) ? readdirSync(staging).length : 0
  assert(n === 0, '⑰ 不写 staging（得 ' + n + '）')
  await handle({ workspace_dir: ws, action: 'rollback', txn_id: b.txnId }, ctxOk)
}

// ⑱ 分块组装 → rollback 恢复原字节（批12-A：assemble 首次落盘前登记备份）
{
  f('s18.js', 'const v = 1\n')
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'g18' }, ctxOk)
  await handle({ workspace_dir: ws, action: 'edit_chunk', txn_id: b.txnId, file: 's18.js', seq: 1, total: 1, lines: ['const v = 2'] }, ctxOk)
  const a = await handle({ workspace_dir: ws, action: 'assemble', txn_id: b.txnId, file: 's18.js' }, ctxOk)
  assert(a.status === 'staged' && read('s18.js') === 'const v = 2', '⑱ 组装落盘（得 ' + JSON.stringify({ s: a.status, c: a.error_code }) + '）')
  const r = await handle({ workspace_dir: ws, action: 'rollback', txn_id: b.txnId }, ctxOk)
  assert(r.status === 'rolled_back' && r.files_restored === 1, '⑱ rollback 恢复（得 ' + JSON.stringify({ s: r.status, n: r.files_restored, e: r.error_code }) + '）')
  assert(read('s18.js') === 'const v = 1\n', '⑱ 原字节还原')
}

// ⑲ 分块组装 → commit → undo_commit 恢复原字节
{
  f('s19.js', 'const w = 1\n')
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'g19' }, ctxOk)
  await handle({ workspace_dir: ws, action: 'edit_chunk', txn_id: b.txnId, file: 's19.js', seq: 1, total: 1, lines: ['const w = 2'] }, ctxOk)
  await handle({ workspace_dir: ws, action: 'assemble', txn_id: b.txnId, file: 's19.js' }, ctxOk)
  const c = await handle({ workspace_dir: ws, action: 'commit', txn_id: b.txnId }, ctxOk)
  assert(c.status === 'committed', '⑲ commit（得 ' + JSON.stringify(c.status || c.error_code) + '）')
  const u = await handle({ workspace_dir: ws, action: 'undo_commit', txn_id: b.txnId }, ctxOk)
  assert(u.status === 'undone' && u.files_restored === 1, '⑲ undo 恢复（得 ' + JSON.stringify({ s: u.status, n: u.files_restored, e: u.error_code }) + '）')
  assert(read('s19.js') === 'const w = 1\n', '⑲ 原字节还原')
}

// ⑳ 备份登记失败 → assemble 中止写入（预置同名目录使 copyFileSync EISDIR）
{
  f('s20.js', 'const x = 1\n')
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'g20' }, ctxOk)
  await handle({ workspace_dir: ws, action: 'edit_chunk', txn_id: b.txnId, file: 's20.js', seq: 1, total: 1, lines: ['const x = 2'] }, ctxOk)
  const crypto4 = await import('node:crypto')
  const prefix4 = crypto4.createHash('sha256').update('s20.js').digest('hex').slice(0, 16)
  mkdirSync(join(ws, '.ai-transactions', b.txnId, 'backup', prefix4 + '-s20.js'), { recursive: true })
  const a = await handle({ workspace_dir: ws, action: 'assemble', txn_id: b.txnId, file: 's20.js' }, ctxOk)
  assert(a.error_code === 'BACKUP_FAILED', '⑳ 备份失败中止（得 ' + JSON.stringify({ c: a.error_code, s: a.status }) + '）')
  assert(read('s20.js') === 'const x = 1\n', '⑳ 未落盘')
  const m = JSON.parse(readFileSync(join(ws, '.ai-transactions', b.txnId, 'manifest.json'), 'utf-8'))
  assert(!m.files['s20.js'] || !m.files['s20.js'].new_hash, '⑳ manifest 无 new_hash')
  await handle({ workspace_dir: ws, action: 'rollback', txn_id: b.txnId }, ctxOk)
}

// ㉑ manifest 缺 backupName（模拟旧/受损事务）→ rollback 明确诊断，不读目录不抛
{
  f('s21.js', 'const y = 1\n')
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'g21' }, ctxOk)
  await handle({ workspace_dir: ws, action: 'edit_chunk', txn_id: b.txnId, file: 's21.js', seq: 1, total: 1, lines: ['const y = 2'] }, ctxOk)
  await handle({ workspace_dir: ws, action: 'assemble', txn_id: b.txnId, file: 's21.js' }, ctxOk)
  const mpath = join(ws, '.ai-transactions', b.txnId, 'manifest.json')
  const m = JSON.parse(readFileSync(mpath, 'utf-8'))
  delete m.files['s21.js'].backupName
  writeFileSync(mpath, JSON.stringify(m))
  const r = await handle({ workspace_dir: ws, action: 'rollback', txn_id: b.txnId }, ctxOk)
  assert(r.status === 'rolled_back_partial' && r.skipped && r.skipped[0] && r.skipped[0].reason === 'backup_missing', '㉑ 缺备份明确诊断（得 ' + JSON.stringify({ s: r.status, sk: r.skipped, e: r.error_code }) + '）')
  assert(read('s21.js') === 'const y = 2', '㉑ 文件保持事务后状态（未误读目录）')
}

// ㉒ 多文件分块组装 → rollback 全部还原
{
  f('s22a.js', 'const m1 = 1\n')
  f('s22b.js', 'const m2 = 1\n')
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'g22' }, ctxOk)
  await handle({ workspace_dir: ws, action: 'edit_chunk', txn_id: b.txnId, file: 's22a.js', seq: 1, total: 1, lines: ['const m1 = 2'] }, ctxOk)
  await handle({ workspace_dir: ws, action: 'assemble', txn_id: b.txnId, file: 's22a.js' }, ctxOk)
  await handle({ workspace_dir: ws, action: 'edit_chunk', txn_id: b.txnId, file: 's22b.js', seq: 1, total: 1, lines: ['const m2 = 2'] }, ctxOk)
  await handle({ workspace_dir: ws, action: 'assemble', txn_id: b.txnId, file: 's22b.js' }, ctxOk)
  const r = await handle({ workspace_dir: ws, action: 'rollback', txn_id: b.txnId }, ctxOk)
  assert(r.status === 'rolled_back' && r.files_restored === 2, '㉒ 多文件恢复（得 ' + JSON.stringify({ s: r.status, n: r.files_restored }) + '）')
  assert(read('s22a.js') === 'const m1 = 1\n' && read('s22b.js') === 'const m2 = 1\n', '㉒ 两文件原字节还原')
}

// ㉓ 非唯一 old_string：替换首个 + ambiguous_edits 回执（12-D，旧实现静默取首）
{
  f('s23.js', 'const dup = 1\nconst dup = 1\n')
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'g23' }, ctxOk)
  const r = await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 's23.js', edits: [{ old_string: 'const dup = 1', new_string: 'const dup = 2' }] }, ctxOk)
  assert(r.status === 'staged' && Array.isArray(r.ambiguous_edits) && r.ambiguous_edits[0].occurrences === 2, '㉓ 非唯一 old_string 回执 ambiguous_edits（得 ' + JSON.stringify(r.ambiguous_edits) + '）')
  assert(typeof r.warning === 'string' && r.warning.includes('multiple occurrences'), '㉓ warning 提示多命中')
  assert(read('s23.js') === 'const dup = 2\nconst dup = 1\n', '㉓ 首个命中被替换（行为兼容）')
  const r2 = await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 's23.js', edits: [{ old_string: 'const dup = 1', new_string: 'const dup = 3', replace_all: true }] }, ctxOk)
  assert(r2.status === 'staged' && !r2.ambiguous_edits, '㉓ replace_all 不标歧义')
  assert(read('s23.js') === 'const dup = 2\nconst dup = 3\n', '㉓ replace_all 全替换')
  await handle({ workspace_dir: ws, action: 'rollback', txn_id: b.txnId }, ctxOk)
}

// ㉔ 同名事务并发 undo：锁+哈希守卫下无撕裂（同进程 Promise.all，与跨进程同一文件锁路径）
{
  f('s24.js', 'const c0 = 0\n')
  const b1 = await handle({ workspace_dir: ws, action: 'begin', name: 'g24' }, ctxOk)
  await handle({ workspace_dir: ws, action: 'edit', txn_id: b1.txnId, file: 's24.js', edits: [{ old_string: 'const c0 = 0', new_string: 'const c0 = 1' }] }, ctxOk)
  await handle({ workspace_dir: ws, action: 'commit', txn_id: b1.txnId }, ctxOk)
  const b2 = await handle({ workspace_dir: ws, action: 'begin', name: 'g24' }, ctxOk)
  await handle({ workspace_dir: ws, action: 'edit', txn_id: b2.txnId, file: 's24.js', edits: [{ old_string: 'const c0 = 1', new_string: 'const c0 = 2' }] }, ctxOk)
  await handle({ workspace_dir: ws, action: 'commit', txn_id: b2.txnId }, ctxOk)
  const [u1, u2] = await Promise.all([
    handle({ workspace_dir: ws, action: 'undo_commit', txn_id: b1.txnId }, ctxOk),
    handle({ workspace_dir: ws, action: 'undo_commit', txn_id: b2.txnId }, ctxOk),
  ])
  const content = read('s24.js')
  assert(['const c0 = 0\n', 'const c0 = 1\n', 'const c0 = 2\n'].includes(content), '㉔ 并发 undo 无撕裂（得 ' + JSON.stringify(content) + '）')
  const okCount = [u1, u2].filter(u => u.status === 'undone').length
  assert(okCount >= 1, '㉔ 至少一个 undo 成功（得 ' + JSON.stringify([u1.status, u2.status]) + '）')
}

// ㉕ dry_run 预览：不落盘/不要求 txn + 匹配行号回显 + 随后真编辑可继续（13-A）
{
  f('s25.js', 'const a = 1\nconst b = 2\n')
  const p = await handle({ workspace_dir: ws, action: 'edit', file: 's25.js', edits: [{ old_string: 'const b = 2', new_string: 'const b = 3' }, { old_string: 'nope', new_string: 'x' }], dry_run: true }, ctxOk)
  assert(p.status === 'preview' && p.would_apply === 1 && p.failed_edits && p.failed_edits[0].reason === 'not_found', '㉕ dry_run 预览回执（得 ' + JSON.stringify({ s: p.status, w: p.would_apply }) + '）')
  assert(p.matches && p.matches[0].line === 2, '㉕ 匹配行号回显（得 ' + JSON.stringify(p.matches) + '）')
  assert(read('s25.js') === 'const a = 1\nconst b = 2\n', '㉕ dry_run 不落盘')
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'g25' }, ctxOk)
  const r = await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 's25.js', edits: [{ old_string: 'const b = 2', new_string: 'const b = 3' }] }, ctxOk)
  assert(r.status === 'staged' && read('s25.js').includes('const b = 3'), '㉕ 预览后真编辑可继续')
  await handle({ workspace_dir: ws, action: 'rollback', txn_id: b.txnId }, ctxOk)
}

// ㉖ edit_multi dry_run：逐文件回执 + 失败不落盘/不连坐事务（13-A）
{
  f('s26a.js', 'const x = 1\n')
  f('s26b.js', 'const y = 1\n')
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'g26' }, ctxOk)
  const p = await handle({ workspace_dir: ws, action: 'edit_multi', txn_id: b.txnId, dry_run: true, file_edits: [
    { file: 's26a.js', edits: [{ old_string: 'const x = 1', new_string: 'const x = 2' }] },
    { file: 's26b.js', edits: [{ old_string: 'MISSING', new_string: 'z' }] },
  ] }, ctxOk)
  assert(p.status === 'preview' && p.files[0].would_apply === 1 && p.files[1].failed_edits.length === 1, '㉖ edit_multi dry_run 逐文件回执（得 ' + JSON.stringify(p.summary) + '）')
  assert(read('s26a.js') === 'const x = 1\n' && read('s26b.js') === 'const y = 1\n', '㉖ dry_run 不落盘')
  const r = await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 's26a.js', edits: [{ old_string: 'const x = 1', new_string: 'const x = 2' }] }, ctxOk)
  assert(r.status === 'staged', '㉖ 预览失败不连坐事务（仍 active 可编辑）')
  await handle({ workspace_dir: ws, action: 'rollback', txn_id: b.txnId }, ctxOk)
}

// ㉗ 长行失败提示 line_span 锚定（13-A，用户实测唯一失误来源）
{
  f('s27.js', 'const z = 1 // ' + '长'.repeat(150) + '\n')
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'g27' }, ctxOk)
  const r = await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 's27.js', edits: [{ old_string: 'const z = 2 // ' + '短'.repeat(150), new_string: 'x' }] }, ctxOk)
  assert(r.status === 'edit_failed' && r.failed_edits && r.failed_edits[0].hint && r.failed_edits[0].hint.includes('line_span'), '㉗ 长行失败提示 line_span（得 ' + JSON.stringify(r.failed_edits?.[0]?.hint) + '）')
  await handle({ workspace_dir: ws, action: 'rollback', txn_id: b.txnId }, ctxOk)
}

// ㉘ create：多级新目录落盘 + rollback 删除（13-A）
{
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'g28' }, ctxOk)
  const r = await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 'new/dir/s28.js', create: true, content: 'const n = 1\n' }, ctxOk)
  assert(r.status === 'staged' && r.created === true && existsSync(join(ws, 'new', 'dir', 's28.js')), '㉘ create 落盘（得 ' + JSON.stringify({ s: r.status, c: r.created }) + '）')
  const rb = await handle({ workspace_dir: ws, action: 'rollback', txn_id: b.txnId }, ctxOk)
  assert(rb.status === 'rolled_back' && !existsSync(join(ws, 'new', 'dir', 's28.js')), '㉘ rollback 删除新建文件（得 ' + rb.status + '）')
}

// ㉙ create：commit → undo 删除 + 已存在文件拒绝（13-A）
{
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'g29' }, ctxOk)
  await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 's29.js', create: true, content: 'const c29 = 1\n' }, ctxOk)
  const c = await handle({ workspace_dir: ws, action: 'commit', txn_id: b.txnId }, ctxOk)
  assert(c.status === 'committed' && c.files.includes('s29.js'), '㉙ create 可提交（得 ' + JSON.stringify(c.status) + '）')
  const u = await handle({ workspace_dir: ws, action: 'undo_commit', txn_id: b.txnId }, ctxOk)
  assert(u.status === 'undone' && !existsSync(join(ws, 's29.js')), '㉙ undo 删除新建文件（得 ' + JSON.stringify({ s: u.status, e: existsSync(join(ws, 's29.js')) }) + '）')
  const b2 = await handle({ workspace_dir: ws, action: 'begin', name: 'g29b' }, ctxOk)
  const r2 = await handle({ workspace_dir: ws, action: 'edit', txn_id: b2.txnId, file: 's2.js', create: true, content: 'x' }, ctxOk)
  assert(r2.error_code === 'INVALID_INPUT' && /already exists/.test(r2.message || ''), '㉙ create 已存在文件拒绝（得 ' + JSON.stringify({ c: r2.error_code, m: r2.message }) + '）')
  await handle({ workspace_dir: ws, action: 'rollback', txn_id: b2.txnId }, ctxOk)
}

try { rmSync(ws, { recursive: true, force: true }) } catch {}

console.log('== test-edit-txn-guard: ' + pass + ' passed, ' + fail + ' failed ==')
if (fail > 0) process.exit(1)
