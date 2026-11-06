// test-batch-accounting.js — F20（2026-11-05 极限风暴）
//
// 真机实测三处互相矛盾的记账：
//  ① best_effort 1 个写成功 + 1 个失败 → summary 说 "Applied batch to 2 file(s)"
//  ② 回执把失败文件标成 status="written"、hashes.result=null（同一文件同时 written/失败）
//  ③ 全部 already_applied（零字节变化）仍报 effect=workspace_write / committed=true，
//     还发 undo token；而 observation 的 state_commit 写 not_attempted，自相矛盾。
//
// 修复后口径：只有真有 result hash 的文件才算成功；失败文件 status=failed；
// 成功文件里 pre==post 的算 unchanged；全部成功文件都 unchanged 才是 no-op。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP = join(os.tmpdir(), 'opencode', 'batch-accounting-test')
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
process.env.MALONG_STATE_DIR = join(TMP, 'state')
process.env.MALONG_ENTRY_STATE = '1'

let pass = 0, fail = 0
const assert = (cond, msg) => { if (cond) pass++; else { fail++; console.error('  FAIL:', msg) } }
const M = join(__dirname, '..')
const imp = (p) => import(pathToFileURL(p).href)
const shared = await imp(join(M, 'tools', 'entry-shared.js'))
const batch = await imp(join(M, 'tools', 'tool-code-batch', 'handler.js'))
const read = await imp(join(M, 'tools', 'tool-code-read', 'handler.js'))

const WS = join(TMP, 'ws')
mkdirSync(join(WS, 'src'), { recursive: true })
const A = 'export const a = 1\nexport const keep = 2\n'
const B = 'export const b = 1\n'
writeFileSync(join(WS, 'src', 'a.js'), A)
writeFileSync(join(WS, 'src', 'b.js'), B)
const T = { task_id: 'task_batch_acct', revision: 1, route: 'change', lifecycle: 'active', node: 'edit', materials: [], operations: [], evidence: [], goal: 'batch accounting', workspace_dir: WS }
shared.putTask(WS, T, { type: 'task_created', task: T })

const ctx = {}
async function readRef(file) {
  const r = await read.handle({ workspace_dir: WS, task_id: T.task_id, locator: { file_path: file } }, ctx)
  assert(!!r?.read_ref, '读取 ' + file + ' 必须返回 read_ref（得 ' + JSON.stringify(r?.error || r?.observation?.summary) + '）')
  return r.read_ref
}

// ── ① best_effort：1 写成功 + 1 失败，记账必须分开 ──
{
  const ra = await readRef('src/a.js')
  const rb = await readRef('src/b.js')
  const r = await batch.handle({
    workspace_dir: WS, task_id: T.task_id, dry_run: false,
    policy: { all_or_nothing: false },
    writes: [
      { read_ref: ra, patch: { old_string: 'export const keep = 2', new_string: 'export const keep = 3' } },
      { read_ref: rb, patch: { old_string: 'export const doesNotExist = 0', new_string: 'export const doesNotExist = 1' } },
    ],
  }, ctx)
  assert(r.ok === true, '① best_effort 调用应返回 ok:true（得 ' + JSON.stringify(r.error || r.ok) + '）')
  const sum = String(r.observation?.summary || '')
  assert(/1 written/.test(sum), '① summary 必须报 1 written（得 ' + sum + '）')
  assert(/1 failed/.test(sum), '① summary 必须报 1 failed（得 ' + sum + '）')
  assert(!/Applied batch to 2 file/.test(sum), '① 不得再说 Applied to 2 file(s)（得 ' + sum + '）')
  const files = r.observation?.receipt?.files || []
  const fa = files.find(f => f.file === 'src/a.js')
  const fb = files.find(f => f.file === 'src/b.js')
  assert(fa?.status === 'written', '① a.js 回执 status=written（得 ' + JSON.stringify(fa) + '）')
  assert(fb?.status === 'failed', '① b.js 回执 status=failed（得 ' + JSON.stringify(fb) + '）')
  assert(fb?.hashes?.result === null, '① 失败文件不得有 result hash（得 ' + JSON.stringify(fb?.hashes) + '）')
  assert(readFileSync(join(WS, 'src', 'b.js'), 'utf-8') === B, '① 失败文件字节未动')
}

// ── ② 纯 no-op + 1 个失败：零字节变化 → no_change，不得发 undo ──
{
  const ra = await readRef('src/a.js')
  const rb = await readRef('src/b.js')
  const r = await batch.handle({
    workspace_dir: WS, task_id: T.task_id, dry_run: false,
    policy: { all_or_nothing: false },
    writes: [
      // old 不存在、new 已在 → already_applied，零字节变化
      { read_ref: ra, patch: { old_string: 'export const keep = 4', new_string: 'export const keep = 3' } },
      { read_ref: rb, patch: { old_string: 'export const doesNotExist = 0', new_string: 'export const doesNotExist = 1' } },
    ],
  }, ctx)
  assert(r.ok === true, '② 纯 no-op 调用应返回 ok:true（得 ' + JSON.stringify(r.error || r.ok) + '）')
  const o = r.observation || {}
  assert(o.effect === 'no_change', '② effect=no_change（得 ' + JSON.stringify(o.effect) + '）')
  assert(o.committed === false, '② committed=false（得 ' + JSON.stringify(o.committed) + '）')
  assert(o.state_commit === 'not_attempted', '② observation.state_commit=not_attempted（得 ' + JSON.stringify(o.state_commit) + '）')
  assert(/No change applied/.test(String(o.summary)), '② summary 必须说 No change applied（得 ' + o.summary + '）')
  assert(o.receipt?.effect === 'no_change', '② receipt.effect=no_change（得 ' + JSON.stringify(o.receipt?.effect) + '）')
  assert(o.receipt?.state_commit === 'not_attempted', '② receipt.state_commit=not_attempted（得 ' + JSON.stringify(o.receipt?.state_commit) + '）')
  assert(!r.undo, '② no-op 不得发 undo token（得 ' + JSON.stringify(r.undo) + '）')
  assert(readFileSync(join(WS, 'src', 'a.js'), 'utf-8').includes('keep = 3'), '② a.js 字节未变（仍是 keep = 3）')
}

// ── ③ all_or_nothing：1 个失败 → 整批不落盘（旧行为，防回归）──
{
  const ra = await readRef('src/a.js')
  const rb = await readRef('src/b.js')
  const beforeA = readFileSync(join(WS, 'src', 'a.js'), 'utf-8')
  const r = await batch.handle({
    workspace_dir: WS, task_id: T.task_id, dry_run: false,
    writes: [
      { read_ref: ra, patch: { old_string: 'export const a = 1', new_string: 'export const a = 9' } },
      { read_ref: rb, patch: { old_string: 'export const doesNotExist = 0', new_string: 'export const doesNotExist = 1' } },
    ],
  }, ctx)
  assert(r.ok === false && r.error === 'PATCH_OLD_STRING_NOT_FOUND', '③ all_or_nothing 失败必须是 ok:false + PATCH_OLD_STRING_NOT_FOUND（得 ' + JSON.stringify(r.error || r.ok) + '）')
  assert(readFileSync(join(WS, 'src', 'a.js'), 'utf-8') === beforeA, '③ 整批回滚，a.js 字节未动')
}

// ── ④ create-only 批次：op_class 必须是 create，不是 modify ──
// 真机实测（/tmp/opencode/dogfood-061）：3 个 create 的批次回执写 op_class=modify，
// 但 pre=null + undo 会删除文件——保证边界是「目标不存在」，不是「版本锚定修改」。
{
  const r = await batch.handle({
    workspace_dir: WS, task_id: T.task_id, dry_run: false,
    writes: [
      { create: true, content: 'export const n1 = 1\n', locator: { file_path: 'src/new1.js' } },
      { create: true, content: 'export const n2 = 2\n', locator: { file_path: 'src/new2.js' } },
    ],
  }, ctx)
  assert(r.ok === true, '④ create-only 批次应成功（得 ' + JSON.stringify(r.error || r.ok) + '）')
  assert(r.observation?.receipt?.op_class === 'create', '④ receipt.op_class=create（得 ' + JSON.stringify(r.observation?.receipt?.op_class) + '）')
  assert(r.observation?.receipt?.files?.every(f => f.hashes?.pre === null), '④ create 文件 pre hash 必须为 null')
  assert(readFileSync(join(WS, 'src', 'new1.js'), 'utf-8') === 'export const n1 = 1\n', '④ new1.js 已写入')
}

try { rmSync(TMP, { recursive: true, force: true }) } catch {}
console.log('== test-batch-accounting: ' + pass + ' passed, ' + fail + ' failed ==')
process.exit(fail > 0 ? 1 : 0)
