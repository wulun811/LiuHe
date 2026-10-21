// test-win-name-guard.js — 15-A：Windows 名字边界（设备保留名/尾点/尾空格）段级拒绝
// 覆盖：纯谓词 findWindowsUnsafeSegment / 平台门与强制门 / validateFilePath /
//       writeSymbol(create) 与 edit_transaction(create) 真实写入口失败路径 / undo 侧 guardRealPath / 合法名不误伤
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, rmSync, existsSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) { if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) } }

const { validateFilePath, findWindowsUnsafeSegment, windowsPathChecksEnabled } = await import(pathToFileURL(join(__dirname, '..', 'error-codes.js')).href)
const { guardRealPath } = await import(pathToFileURL(join(__dirname, '..', 'path-guard.js')).href)
const { writeSymbol } = await import(pathToFileURL(join(__dirname, '..', 'write-runtime.js')).href)
const { handle } = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-edit-transaction', 'handler.js')).href)

const TMP = join(os.tmpdir(), 'opencode', 'win-name-guard')
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
mkdirSync(TMP, { recursive: true })
const ctx = (ws) => ({ codeIndexService: null, getWorkspaceDir: () => ws, langParserService: null })

const isWin = process.platform === 'win32'
delete process.env.MALONG_TEST_FORCE_WIN_PATH_CHECKS

// ① 纯谓词：保留名（大小写/带扩展名/目录段）
for (const p of ['CON', 'con', 'Con.txt', 'NUL', 'PRN', 'AUX', 'COM1', 'com9.dll', 'LPT9', 'src/NUL/x.js', 'a/b/con.js']) {
  const r = findWindowsUnsafeSegment(p)
  assert(r && r.kind === 'reserved_name', '① 保留名命中 ' + p + '（得 ' + JSON.stringify(r) + '）')
}
for (const p of ['foo.', 'foo ', 'dir /x.js', 'src/name.']) {
  const r = findWindowsUnsafeSegment(p)
  assert(r && r.kind === 'trailing_dot_or_space', '① 尾点/空格命中 ' + p + '（得 ' + JSON.stringify(r) + '）')
}
for (const p of ['console.js', 'auxiliary.rs', 'com10.txt', 'nm-nul.js', 'report..old.md', 'src/app.js', 'CONtract.md']) {
  assert(findWindowsUnsafeSegment(p) === null, '① 合法名放行 ' + p)
}

// ② 平台门：未强制时仅 win32 拒绝（Linux 的 aux.rs 类文件读取/写入不受影响）
const gated = validateFilePath('CON')
assert(isWin ? (gated.blocked === true && gated.reason === 'windows_invalid_path') : gated.ok === true,
  '② 平台门（isWin=' + isWin + '，得 ' + JSON.stringify(gated) + '）')
assert(typeof windowsPathChecksEnabled() === 'boolean', '② 门函数可调用')

// ③ 强制门（模拟 Windows 平台）：validateFilePath 拒绝 + 类型化 reason
process.env.MALONG_TEST_FORCE_WIN_PATH_CHECKS = '1'
const b1 = validateFilePath('CON')
assert(b1.blocked === true && b1.reason === 'windows_invalid_path' && b1.detail.includes('reserved_name'), '③ CON 拒绝（得 ' + JSON.stringify(b1) + '）')
assert(validateFilePath('src/con.js').blocked === true, '③ 带扩展名保留名拒绝')
assert(validateFilePath('nested/dir /x.js').blocked === true, '③ 目录段尾空格拒绝')
assert(validateFilePath('normal/app.js').ok === true, '③ 普通路径放行')
assert(validateFilePath('auxiliary.rs').ok === true, '③ 非保留前缀放行')
const ws0 = join(TMP, 'abs-ws'); mkdirSync(ws0, { recursive: true })
assert(validateFilePath(join(ws0, 'CON'), ws0).blocked === true, '③ 工作区内绝对路径同样拒绝')
assert(validateFilePath(join(TMP, 'outside.js'), ws0).blocked === true, '③ 工作区外绝对路径仍拒绝')

// ④ 真实写入口：writeSymbol create 保留名 → PATH_BLOCKED、不落盘；合法名在强制门下正常
{
  const ws = join(TMP, 'ws-write'); mkdirSync(ws, { recursive: true })
  const r = await writeSymbol({ workspace_dir: ws, create: true, locator: { file_path: 'CON' }, content: 'x = 1\n' }, ctx(ws))
  assert(r.success === false && r.error?.code === 'PATH_BLOCKED' && /windows-unsafe/.test(r.error?.message || ''), '④ writeSymbol CON 拒绝（得 ' + JSON.stringify(r.error || r) + '）')
  assert(!existsSync(join(ws, 'CON')), '④ CON 未落盘')
  const r2 = await writeSymbol({ workspace_dir: ws, create: true, locator: { file_path: 'sub/NUL.txt' }, content: 'x = 1\n' }, ctx(ws))
  assert(r2.success === false && r2.error?.code === 'PATH_BLOCKED', '④ writeSymbol sub/NUL.txt 拒绝')
  const ok = await writeSymbol({ workspace_dir: ws, create: true, locator: { file_path: 'ok.js' }, content: 'const a = 1\n' }, ctx(ws))
  assert(ok.success === true && existsSync(join(ws, 'ok.js')), '④ 强制门下普通文件仍可写')
}

// ⑤ edit_transaction create 保留名 → PATH_BLOCKED；undo 侧 guardRealPath 同拒
{
  const ws = join(TMP, 'ws-txn'); mkdirSync(ws, { recursive: true })
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'w15a' }, ctx(ws))
  const r = await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 'COM1', create: true, content: 'x = 1\n' }, ctx(ws))
  assert(r.error_code === 'PATH_BLOCKED', '⑤ edit_transaction COM1 拒绝（得 ' + JSON.stringify({ s: r.status, c: r.error_code }) + '）')
  assert(r.reason === 'windows_invalid_path', '⑤ reason 透出（得 ' + r.reason + '）')
  assert(!existsSync(join(ws, 'COM1')), '⑤ COM1 未落盘')
  assert(guardRealPath(ws, 'NUL').blocked === true, '⑤ undo/journal 侧 guardRealPath 同拒')
  await handle({ workspace_dir: ws, action: 'rollback', txn_id: b.txnId }, ctx(ws))
}

delete process.env.MALONG_TEST_FORCE_WIN_PATH_CHECKS
console.log('test-win-name-guard: ' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)