// test-patch-delete-warning.js — F34（2026-11-05 极限风暴）
//
// 真机实测：patch 只给 old_string、漏写 new_string 时，写入层在结果里挂了
// warning（write-runtime.js），但 code_patch 的 dry-run / apply 响应都没透出——
// 调用方看到的是一次正常的 "Applied edit (written)"，一行代码被静默删除。
// 修复：warning 必须出现在 observation.warning（预览与落盘两条路径）。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP = join(os.tmpdir(), 'opencode', 'patch-delete-warning-test')
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
mkdirSync(join(TMP, 'src'), { recursive: true })
process.env.MALONG_STATE_DIR = join(TMP, 'state')
process.env.MALONG_ENTRY_STATE = '1'

let pass = 0, fail = 0
const assert = (cond, msg) => { if (cond) pass++; else { fail++; console.error('  FAIL:', msg) } }
const imp = (p) => import(pathToFileURL(p).href)
const shared = await imp(join(__dirname, '..', 'tools', 'entry-shared.js'))
const read = await imp(join(__dirname, '..', 'tools', 'tool-code-read', 'handler.js'))
const patch = await imp(join(__dirname, '..', 'tools', 'tool-code-patch', 'handler.js'))

const WS = join(TMP)
const FILE = join(WS, 'src', 'del.js')
const ORIG = 'export const a = 1\nexport const b = 2\n'
writeFileSync(FILE, ORIG)
const T = { task_id: 'task_del_warn', revision: 1, route: 'change', lifecycle: 'active', node: 'edit', materials: [], operations: [], evidence: [], goal: 'delete line without new_string', workspace_dir: WS }
shared.putTask(WS, T, { type: 'task_created', task: T })
const ctx = {}
const rr = await read.handle({ workspace_dir: WS, task_id: T.task_id, locator: { file_path: 'src/del.js' } }, ctx)
const readRef = rr.read_ref
assert(!!readRef, '读取文件必须有 read_ref（得 ' + JSON.stringify(rr?.error) + '）')

// ── ① 预览：必须挂 warning ──
{
  const r = await patch.handle({
    workspace_dir: WS, task_id: T.task_id, read_ref: readRef, dry_run: true,
    patch: { old_string: 'export const b = 2\n' },
  }, ctx)
  assert(r.ok === true, '① 预览 ok:true（得 ' + JSON.stringify(r.error || r.ok) + '）')
  assert(/new_string omitted/.test(String(r.observation?.warning || '')), '① 预览必须透出 new_string omitted（得 ' + JSON.stringify(r.observation?.warning) + '）')
  assert(readFileSync(FILE, 'utf-8') === ORIG, '① 预览不得落盘')
}

// ── ② 落盘：删除生效，但 warning 必须同时出现 ──
{
  const r = await patch.handle({
    workspace_dir: WS, task_id: T.task_id, read_ref: readRef, dry_run: false,
    patch: { old_string: 'export const b = 2\n' },
  }, ctx)
  assert(r.ok === true, '② 落盘 ok:true（得 ' + JSON.stringify(r.error || r.ok) + '）')
  assert(/new_string omitted/.test(String(r.observation?.warning || '')), '② 落盘必须透出 new_string omitted（得 ' + JSON.stringify(r.observation?.warning) + '）')
  const after = readFileSync(FILE, 'utf-8')
  assert(after === 'export const a = 1\n', '② old_string 被删除（得 ' + JSON.stringify(after) + '）')
}

// ── ③ 显式空串（有意的删除）不应误报 warning ──
{
  writeFileSync(FILE, ORIG)
  const rr2 = await read.handle({ workspace_dir: WS, task_id: T.task_id, locator: { file_path: 'src/del.js' } }, ctx)
  const r = await patch.handle({
    workspace_dir: WS, task_id: T.task_id, read_ref: rr2.read_ref, dry_run: false,
    patch: { old_string: 'export const b = 2\n', new_string: '' },
  }, ctx)
  assert(r.ok === true, '③ 显式空串删除应成功（得 ' + JSON.stringify(r.error || r.ok) + '）')
  assert(!/new_string omitted/.test(String(r.observation?.warning || '')), '③ 显式空串不得误报 omitted（得 ' + JSON.stringify(r.observation?.warning) + '）')
}

try { rmSync(TMP, { recursive: true, force: true }) } catch {}
console.log('== test-patch-delete-warning: ' + pass + ' passed, ' + fail + ' failed ==')
process.exit(fail > 0 ? 1 : 0)
