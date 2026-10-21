// test-unix-mode-preserve.js — N3（0.5.14 Windows 复核，Linux 侧复验）：编辑不得重置 Unix 权限位
// 团队自报：编辑后 755 脚本需手工 chmod 恢复。本侧实测复现：edit_batch 把 755 → 664（tmp+rename 用 umask 默认）。
// 本测试（仅 POSIX；Windows 无语义，显式 NOT_RUN）锁定：
//   ① 755 可执行脚本经 edit_batch 编辑后仍 755；② 640 保持 640；③ 整文件写（write_symbols 批写路径）也保留权限位；
//   ④ 新建文件不被擅自置可执行位；⑤ 内容确实变了（不因保留 mode 漏写）。
import { join, dirname } from 'node:path'
import { mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, statSync, existsSync } from 'node:fs'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

if (process.platform === 'win32') {
  console.log('NOT_RUN: test-unix-mode-preserve is POSIX-only (Windows has no POSIX mode bits)')
  process.exit(0)
}

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  FAIL: ' + msg) } }
const brief = (v) => JSON.stringify(v ?? null).slice(0, 220)
const oct = (m) => (m & 0o777).toString(8)

const TMP = join(os.tmpdir(), 'opencode', 'unix-mode-preserve')
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
mkdirSync(join(TMP, 'scripts'), { recursive: true })
process.env.MALONG_STATE_DIR = join(TMP, 'state')
const imp = (p) => import(pathToFileURL(p).href)
const editBatch = (await imp(join(__dirname, '..', 'tools', 'tool-batch-edit', 'handler.js'))).handle
const writeSymbols = (await imp(join(__dirname, '..', 'tools', 'tool-write-symbols', 'handler.js'))).handle
const modeOf = (p) => statSync(p).mode & 0o777
// write_symbols 需要 codeIndexService（本测试只关心权限位/内容，索引副作用用空实现）
const ctx = {
  codeIndexService: {
    async initWorkspace() {}, async indexBatch() { return [] }, async indexFile() {}, markIndexDirty() {},
    async findDefinitions() { return [] }, async searchSymbols() { return [] }, findSymbolsInFile() { return [] },
    async getFileOutline() { return { outline: [] } }, async getSymbolsAtLine() { return [] },
    getSymbolByStableId() { return null }, getFileByPath(f) { return { path: f, index_state: 'fresh' } },
  },
}

// ── ① 755 可执行脚本：edit_batch 编辑后仍 755 ──
{
  const rel = 'scripts/run.sh'
  const f = join(TMP, rel)
  writeFileSync(f, '#!/bin/sh\necho one\n')
  chmodSync(f, 0o755)
  const before = modeOf(f)
  const r = await editBatch({ workspace_dir: TMP, file: rel, edits: [{ old_string: 'echo one', new_string: 'echo two' }] })
  assert(r && (r.success === true || r.ok === true), '① edit_batch 成功（得 ' + brief(r && (r.error || r.result)) + '）')
  assert(modeOf(f) === before && modeOf(f) === 0o755, '① 755 编辑后仍 755（前 ' + oct(before) + ' → 后 ' + oct(modeOf(f)) + '）')
  assert(/echo two/.test(readFileSync(f, 'utf8')), '① 内容确实写入（不因保留 mode 漏写）')
}

// ── ② 640（非默认可执行/非 644）也原样保留 ──
{
  const rel = 'scripts/secret.sh'
  const f = join(TMP, rel)
  writeFileSync(f, '#!/bin/sh\necho secret\n')
  chmodSync(f, 0o640)
  const r = await editBatch({ workspace_dir: TMP, file: rel, edits: [{ old_string: 'echo secret', new_string: 'echo masked' }] })
  assert(r && (r.success === true || r.ok === true), '② edit_batch 成功（得 ' + brief(r && (r.error || r.result)) + '）')
  assert(modeOf(f) === 0o640, '② 640 保持 640（得 ' + oct(modeOf(f)) + '）')
}

// ── ③ 整文件写（write_symbols 批写路径）保留可执行位 ──
{
  const rel = 'scripts/deploy.sh'
  const f = join(TMP, rel)
  writeFileSync(f, '#!/bin/sh\necho deploy-v1\n')
  chmodSync(f, 0o755)
  const r = await writeSymbols({ workspace_dir: TMP, allow_unsafe_no_base: true, writes: [{ file_path: rel, edit_mode: 'patch', patch: { old_string: 'echo deploy-v1', new_string: 'echo deploy-v2' } }] }, ctx)
  assert(r && (r.success === true || r.ok === true), '③ write_symbols 成功（得 ' + brief(r && (r.error || r.result)) + '）')
  assert(modeOf(f) === 0o755, '③ 批写路径也保留 755（得 ' + oct(modeOf(f)) + '）')
  assert(/deploy-v2/.test(readFileSync(f, 'utf8')), '③ 内容已更新')
}

// ── ④ 新建文件不被擅自置可执行位（沿用 umask 默认）──
{
  const rel = 'scripts/new.sh'
  const f = join(TMP, rel)
  const r = await writeSymbols({ workspace_dir: TMP, writes: [{ file_path: rel, content: '#!/bin/sh\necho new\n', create: true }] }, ctx)
  assert(r && (r.success === true || r.ok === true), '④ 新建成功（得 ' + brief(r && (r.error || r.result)) + '）')
  assert(existsSync(f), '④ 新文件存在')
  assert((modeOf(f) & 0o111) === 0, '④ 新建文件没有可执行位（得 ' + oct(modeOf(f)) + '）')
}

console.log('\n=== test-unix-mode-preserve: ' + pass + ' passed, ' + fail + ' failed ===')
process.exit(fail > 0 ? 1 : 0)
