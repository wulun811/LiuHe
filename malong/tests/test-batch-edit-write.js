// test-batch-edit-write.js — batch_edit 写路径（Y001-S4）
// 覆盖：真实写盘 + journal 创建(committed) + 写后同步重抽调用 / dry_run 不写盘 /
//       编辑不匹配不改盘 / file 逃逸拦截 / 缺参 / 兼容别名 file_path / journal_prune 字段
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}
const { handle } = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-batch-edit', 'handler.js')).href)

const ws = join(os.tmpdir(), 'opencode', 'be-write-ws')
rmSync(ws, { recursive: true, force: true })
mkdirSync(ws, { recursive: true })
const src = join(ws, 'src')
mkdirSync(src, { recursive: true })

function journalDirs() {
  const root = join(ws, '.malong', 'journal')
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => join(root, d.name))
}

let indexed = 0
const ctx = { codeIndexService: { indexFile: async () => { indexed++; return { symbols: 3 } } } }

// ── ① 真实写盘 + journal committed + reindex 调用 ──
{
  writeFileSync(join(src, 'a.js'), 'const a = 1\nconst b = 2\n')
  const r = await handle({ workspace_dir: ws, file: 'src/a.js', edits: [{ old_string: 'const a = 1', new_string: 'const a = 10' }] }, ctx)
  assert(r.success === true, `① 写盘成功（得 ${r.success}）`)
  assert(readFileSync(join(src, 'a.js'), 'utf-8').includes('const a = 10'), '① 文件已改')
  assert(r.txn_id && r.txn_id.startsWith('txn_'), `① journal txn_id（得 ${r.txn_id}）`)
  assert(r.reindex && r.reindex.status === 'ok' && r.reindex.symbols === 3, `① reindex 上报（得 ${JSON.stringify(r.reindex)}）`)
  assert(indexed === 1, '① indexFile 被调用 1 次')
  const jdirs = journalDirs()
  assert(jdirs.length === 1, `① 1 个 journal 目录（得 ${jdirs.length}）`)
  const state = JSON.parse(readFileSync(join(jdirs[0], 'state.json'), 'utf-8'))
  assert(state.state === 'committed', `① journal state committed（得 ${state.state}）`)
  assert(existsSync(join(jdirs[0], 'backup', 'a.js')), '① backup 快照存在')
}

// ── ② dry_run 不写盘、不建 journal ──
{
  writeFileSync(join(src, 'b.js'), 'bbb\n')
  const before = journalDirs().length
  const r = await handle({ workspace_dir: ws, file: 'src/b.js', edits: [{ old_string: 'bbb', new_string: 'ccc' }], dry_run: true }, ctx)
  assert(r.success === true, `② dry_run 报告成功（得 ${r.success}）`)
  assert(readFileSync(join(src, 'b.js'), 'utf-8').trim() === 'bbb', '② dry_run 文件未动')
  assert(!r.txn_id, '② dry_run 无 journal txn_id')
  assert(journalDirs().length === before, '② dry_run 无新 journal')
}

// ── ③ 编辑不匹配 → 不改盘（Python 报 failed，delegateWrite 不触发） ──
{
  writeFileSync(join(src, 'c.js'), 'ccc\n')
  const r = await handle({ workspace_dir: ws, file: 'src/c.js', edits: [{ old_string: 'zzz_nonexistent', new_string: 'x' }] }, ctx)
  assert(r.success === false || r.edits_applied === 0, `③ 不匹配失败（得 success=${r.success} applied=${r.edits_applied}）`)
  assert(readFileSync(join(src, 'c.js'), 'utf-8').trim() === 'ccc', '③ 文件未动')
}

// ── ④ file 逃逸 / 缺参 / workspace 校验 ──
{
  const esc = await handle({ workspace_dir: ws, file: '../escape.js', edits: [{ old_string: 'a', new_string: 'b' }] }, ctx)
  assert(esc.error_code === 'PATH_BLOCKED', `④ file 逃逸拦截（得 ${esc.error_code}）`)
  const noWs = await handle({ file: 'src/a.js', edits: [] }, ctx)
  assert(noWs.error === 'missing_parameter', '④ file 需要 workspace_dir')
  const noEdits = await handle({ workspace_dir: ws, file: 'src/a.js' }, ctx)
  assert(noEdits.error === 'missing_parameter' && noEdits.message.includes('edits'), '④ 缺 edits')
  const noBoth = await handle({ workspace_dir: ws }, ctx)
  assert(noBoth.error === 'missing_parameter', '④ 缺 file/file_path')
}

// ── ⑤ 兼容别名 file_path（绝对路径，须带 workspace_dir 且在其中） + 越界拦截 ──
{
  const abs = join(src, 'd.js')
  writeFileSync(abs, 'ddd\n')
  const before = journalDirs().length
  const r = await handle({ workspace_dir: ws, file_path: abs, edits: [{ old_string: 'ddd', new_string: 'DDD' }] }, ctx)
  assert(r.success === true, `⑤ 兼容别名写盘成功（得 ${r.success} ${r.error_code || ''}）`)
  assert(readFileSync(abs, 'utf-8').trim() === 'DDD', '⑤ 文件已改')
  assert(journalDirs().length === before + 1, `⑤ file_path + workspace_dir 建 journal（得 ${journalDirs().length}）`)
  const esc = await handle({ workspace_dir: ws, file_path: join(os.tmpdir(), 'outside.js'), edits: [{ old_string: 'a', new_string: 'b' }] }, ctx)
  assert(esc.error_code === 'PATH_BLOCKED', '⑤ file_path 出 workspace 拦截')
  const noWs = await handle({ file_path: abs, edits: [{ old_string: 'a', new_string: 'b' }] }, ctx)
  assert(noWs.error_code === 'PATH_BLOCKED', '⑤ 无 workspace_dir 绝对路径拒绝（既有设计）')
}
// ── ⑤b r46: file_path 收到相对路径（opencode 前端把 file 别名成 file_path）→ 按 workspace-relative 解析不误拦 ──
{
  writeFileSync(join(src, 'd2.js'), 'ddd2\n')
  const r = await handle({ workspace_dir: ws, file_path: 'src/d2.js', edits: [{ old_string: 'ddd2', new_string: 'DDD2' }] }, ctx)
  assert(r.success === true, `⑤b file_path 相对路径写盘成功（得 ${r.success} ${r.error_code || ''}）`)
  assert(readFileSync(join(src, 'd2.js'), 'utf-8').trim() === 'DDD2', '⑤b 文件已改')
  const esc = await handle({ workspace_dir: ws, file_path: '../outside.js', edits: [{ old_string: 'a', new_string: 'b' }] }, ctx)
  assert(esc.error_code === 'PATH_BLOCKED', `⑤b file_path 相对越界仍拦截（得 ${esc.error_code}）`)
  // r48: 无 workspace_dir + 相对 file_path 不得 TypeError 崩溃（r46 join(null,x) 回归）
  const noWsRel = await handle({ file_path: 'src/d2.js', edits: [{ old_string: 'a', new_string: 'b' }] }, {})
  assert(noWsRel && !(noWsRel instanceof Error) && noWsRel.error !== undefined, `⑤b 无 ws+相对 file_path 不崩且有错误返回（得 ${JSON.stringify(noWsRel).slice(0, 80)}）`)
}

// ── ⑥ journal_prune 字段（新鲜 journal 不过期 → pruned=0 不出现字段，不打扰） ──
{
  writeFileSync(join(src, 'e.js'), 'eee\n')
  const r = await handle({ workspace_dir: ws, file: 'src/e.js', edits: [{ old_string: 'eee', new_string: 'EEE' }] }, ctx)
  assert(r.success === true && r.journal_prune === undefined, `⑥ 新 journal 不触发 prune 字段（得 ${JSON.stringify(r.journal_prune)}）`)
  assert(journalDirs().length >= 2, '⑥ journal 正常累积')
}

// ── ⑦ r40 写后语法自检：好语法 ok=true，坏语法 ok=false + 提示（警告不阻断写盘） ──
{
  writeFileSync(join(src, 'g.js'), 'const g = 1\n')
  const ok = await handle({ workspace_dir: ws, file: 'src/g.js', edits: [{ old_string: 'const g = 1', new_string: 'const g = 2' }] }, ctx)
  assert(ok.syntax_check && ok.syntax_check.ok === true, `⑦ 好语法 syntax_check.ok=true（得 ${JSON.stringify(ok.syntax_check)}）`)
  writeFileSync(join(src, 'h.js'), 'const h = 1\n')
  const bad = await handle({ workspace_dir: ws, file: 'src/h.js', edits: [{ old_string: 'const h = 1', new_string: 'const h = ' }], partial: true }, ctx)
  assert(bad.syntax_check && bad.syntax_check.ok === false, `⑦ 坏语法 syntax_check.ok=false（得 ${JSON.stringify(bad.syntax_check)}）`)
  assert(/SyntaxError/.test(bad.syntax_check.error || ''), `⑦ 坏语法 error 含 SyntaxError（得 ${(bad.syntax_check.error || '').slice(0, 40)}）`)
  assert(typeof bad.syntax_check.suggestion === 'string', '⑦ 坏语法带 suggestion')
}

rmSync(ws, { recursive: true, force: true })

console.log(`== test-batch-edit-write: ${pass} passed, ${fail} failed ==`)
if (fail > 0) process.exit(1)
