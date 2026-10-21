// test-create-file.js — Q2 create:true 新建文件能力（write_symbol / write_symbols 层）
// 覆盖：单发创建 + undo 删除 / 已存在拒绝 / 参数校验 / 越界拦截 / 嵌套目录 / dry-run /
//       批量创建 / all_or_nothing 回滚删除新建文件 / 同文件多 create 项拒绝 / 崩溃恢复语义
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}
const { writeSymbol, writeSymbols } = await import(pathToFileURL(join(__dirname, '..', 'write-runtime.js')).href)
const { createJournal, updateJournalState, restoreJournal, recoverJournals } = await import(pathToFileURL(join(__dirname, '..', 'write-journal.js')).href)
const { sha256 } = await import(pathToFileURL(join(__dirname, '..', 'hash-utils.js')).href)

const TMP = join(os.tmpdir(), 'opencode', 'create-file-test')
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
mkdirSync(TMP, { recursive: true })
// 14-C/15-A：恢复测试要区分「写者已死」与「写者存活」——进程内模拟崩溃必须伪造死 pid，
// 否则 recoverJournals 的存活判定（pid 文件 + kill(pid,0)）会把在途事务正确保留为 in_flight_kept
const deadPid = spawnSync(process.execPath, ['-e', '']).pid
function deadWriter(dir) { writeFileSync(join(dir, 'pid'), String(deadPid)) }
let wsN = 0
const mkws = () => { const ws = join(TMP, 'ws' + (++wsN)); mkdirSync(ws, { recursive: true }); return ws }
const ctx = (ws) => ({ codeIndexService: null, getWorkspaceDir: () => ws, langParserService: null })

// ── ① 单发创建：落盘 + journal created + undo 删除 ──
{
  const ws = mkws()
  const r = await writeSymbol({ workspace_dir: ws, create: true, locator: { file_path: 'src/new.js' }, content: 'export const x = 1\n' }, ctx(ws))
  assert(r.success === true && r.txn_id, `① 创建成功（得 ${JSON.stringify(r.error || r.txn_id)}）`)
  assert(existsSync(join(ws, 'src/new.js')) && readFileSync(join(ws, 'src/new.js'), 'utf-8') === 'export const x = 1\n', '① 文件与内容正确')
  assert(r.undo?.expires_at && r.undo?.via, '① undo 元数据就位')
  const jstate = JSON.parse(readFileSync(join(ws, '.malong/journal', r.txn_id, 'state.json'), 'utf-8'))
  assert(jstate.created === true, '① journal 标 created:true')
  const u = await restoreJournal(ws, r.txn_id)
  assert(u.ok === true && u.deleted === true && !existsSync(join(ws, 'src/new.js')), `① undo 删除新建文件（得 ${JSON.stringify(u)}）`)
}

// ── ② 已存在 → FILE_EXISTS ──
{
  const ws = mkws()
  writeFileSync(join(ws, 'exists.js'), 'old\n')
  const r = await writeSymbol({ workspace_dir: ws, create: true, locator: { file_path: 'exists.js' }, content: 'new\n' }, ctx(ws))
  assert(r.success === false && r.error?.code === 'FILE_EXISTS', `② FILE_EXISTS（得 ${r.error?.code}）`)
  assert(readFileSync(join(ws, 'exists.js'), 'utf-8') === 'old\n', '② 已存在文件不被覆盖')
}

// ── ③ 参数校验：缺 content / 带 patch / 带 base_version ──
{
  const ws = mkws()
  const a = await writeSymbol({ workspace_dir: ws, create: true, locator: { file_path: 'a.js' } }, ctx(ws))
  assert(a.success === false && a.error?.code === 'missing_parameter', `③ 缺 content（得 ${a.error?.code}）`)
  const b = await writeSymbol({ workspace_dir: ws, create: true, locator: { file_path: 'b.js' }, content: 'x\n', patch: { old_string: 'x', new_string: 'y' } }, ctx(ws))
  assert(b.success === false && b.error?.code === 'invalid_input', `③ 带 patch 拒绝（得 ${b.error?.code}）`)
  const c = await writeSymbol({ workspace_dir: ws, create: true, locator: { file_path: 'c.js' }, content: 'x\n', base_version: { file: { hash: 'sha256:x' } } }, ctx(ws))
  assert(c.success === false && c.error?.code === 'invalid_input', `③ 带 base_version 拒绝（得 ${c.error?.code}）`)
}

// ── ④ 越界拦截 ──
{
  const ws = mkws()
  const r = await writeSymbol({ workspace_dir: ws, create: true, locator: { file_path: '../evil.js' }, content: 'x\n' }, ctx(ws))
  assert(r.success === false, `④ 越界被拒（得 ${JSON.stringify(r.error || r.success)}）`)
  assert(!existsSync(join(TMP, 'evil.js')), '④ 未写出工作区')
}

// ── ⑤ 嵌套目录 + dry-run ──
{
  const ws = mkws()
  const d = await writeSymbol({ workspace_dir: ws, create: true, locator: { file_path: 'deep/a/b/f.txt' }, content: 'hi\n' }, ctx(ws))
  assert(d.success === true && existsSync(join(ws, 'deep/a/b/f.txt')), '⑤ 嵌套目录自动创建')
  const p = await writeSymbol({ workspace_dir: ws, create: true, locator: { file_path: 'preview.txt' }, content: 'preview\n', dry_run: true }, ctx(ws))
  assert(p.success === true && p.dry_run === true && !existsSync(join(ws, 'preview.txt')), '⑤ dry-run 不落盘')
}

// ── ⑥ writeSymbols 批量创建成功 ──
{
  const ws = mkws()
  const r = await writeSymbols({ workspace_dir: ws, writes: [
    { file_path: 'm1.js', create: true, content: 'let a = 1\n' },
    { file_path: 'm2.js', create: true, content: 'let b = 2\n' },
  ] }, ctx(ws))
  assert(r.success === true && existsSync(join(ws, 'm1.js')) && existsSync(join(ws, 'm2.js')), `⑥ 批量创建（得 ${JSON.stringify(r.error || r.success)}）`)
  assert(r.intended_files?.['m1.js'] && r.intended_files?.['m2.js'], '⑥ intended_files 记录')
  assert(r.undo?.reverse?.length === 2, '⑥ undo 含两文件 backup')
}

// ── ⑦ all_or_nothing 回滚：已写的新建文件被删除 ──
{
  const ws = mkws()
  writeFileSync(join(ws, 'exists.js'), 'old\n')
  const r = await writeSymbols({ workspace_dir: ws, writes: [
    { file_path: 'a2.js', create: true, content: 'temp\n' },
    { file_path: 'exists.js', create: true, content: 'nope\n' },
  ] }, ctx(ws))
  assert(r.success === false && r.error?.code === 'FILE_EXISTS', `⑦ 批次失败（得 ${r.error?.code}）`)
  assert(!existsSync(join(ws, 'a2.js')), '⑦ 已写的新建文件被回滚删除')
  assert(readFileSync(join(ws, 'exists.js'), 'utf-8') === 'old\n', '⑦ 已存在文件未被动')
}

// ── ⑧ 同文件多个 create 项 → 拒绝 ──
{
  const ws = mkws()
  const r = await writeSymbols({ workspace_dir: ws, writes: [
    { file_path: 'dup.js', create: true, content: 'a\n' },
    { file_path: 'dup.js', create: true, content: 'b\n' },
  ] }, ctx(ws))
  assert(r.success === false && r.error?.code === 'invalid_input', `⑧ 同文件多 create 拒绝（得 ${r.error?.code}）`)
  assert(!existsSync(join(ws, 'dup.js')), '⑧ 未落盘')
}

// ── ⑨ 崩溃恢复：created staged + 文件已写 == new_hash → committed ──
{
  const ws = mkws()
  const abs = join(ws, 'cr.js')
  const j = createJournal(ws, 'cr.js', abs, '', { editMode: 'create', created: true, state: 'staged' })
  const content = 'crash\n'
  writeFileSync(abs, content)
  updateJournalState(j.dir, { state: 'staged', new_hash: sha256(content) })
  deadWriter(j.dir)
  const rec = await recoverJournals(ws)
  const st = JSON.parse(readFileSync(join(j.dir, 'state.json'), 'utf-8'))
  assert(st.state === 'committed', `⑨ 已落盘 created 恢复为 committed（得 ${st.state} / ${JSON.stringify(rec)}）`)
}

// ── ⑩ 崩溃恢复：created staged + 文件缺失 → abandoned ──
{
  const ws = mkws()
  const abs = join(ws, 'gone.js')
  const j = createJournal(ws, 'gone.js', abs, '', { editMode: 'create', created: true, state: 'staged' })
  updateJournalState(j.dir, { state: 'staged', new_hash: sha256('x\n') })
  deadWriter(j.dir)
  await recoverJournals(ws)
  const st = JSON.parse(readFileSync(join(j.dir, 'state.json'), 'utf-8'))
  assert(st.state === 'abandoned', `⑩ 未落盘 created 恢复为 abandoned（得 ${st.state}）`)
}

// ── ⑪ 在途保护（14-C 存活判定）：写者 pid 存活时 recoverJournals 不得删改在途事务 ──
{
  const ws = mkws()
  const abs = join(ws, 'live.js')
  const j = createJournal(ws, 'live.js', abs, '', { editMode: 'create', created: true, state: 'staged' })
  writeFileSync(abs, 'live\n')
  updateJournalState(j.dir, { state: 'staged', new_hash: sha256('live\n') })
  const rec = await recoverJournals(ws)
  const st = JSON.parse(readFileSync(join(j.dir, 'state.json'), 'utf-8'))
  assert(st.state === 'staged', `⑪ 活写者在途事务保持 staged（得 ${st.state}）`)
  assert(!existsSync(join(ws, 'live.js.backup')) , '⑪ 文件未被恢复改写')
  assert(readFileSync(abs, 'utf-8') === 'live\n', '⑪ 已写内容保留')
  assert(JSON.stringify(rec).includes('in_flight_kept'), `⑪ 恢复报告 in_flight_kept（得 ${JSON.stringify(rec).slice(0, 120)}）`)
}

console.log(`=== test-create-file: ${pass} passed, ${fail} failed ===`)
process.exit(fail > 0 ? 1 : 0)
