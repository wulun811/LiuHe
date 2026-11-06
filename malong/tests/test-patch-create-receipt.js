// test-patch-create-receipt.js — 2026-11-05 发布前真机走查
//
// 真机实测：code_patch(create:true) 的回执 hashes.pre=null，但 hashes.intended 也是 null，
// 只有 result 有值；同一次操作在 code_batch(create:true) 里 intended 是有的。
// 判据：create 的 pre 必须为 null，intended 与 result 都必须是写入内容的哈希。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP = join(os.tmpdir(), 'opencode', 'patch-create-receipt-test')
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
const WS = join(TMP, 'ws')
mkdirSync(WS, { recursive: true })
process.env.MALONG_STATE_DIR = join(TMP, 'state')

let pass = 0, fail = 0
const assert = (cond, msg) => { if (cond) pass++; else { fail++; console.error('  FAIL:', msg) } }
const imp = (p) => import(pathToFileURL(p).href)
const shared = await imp(join(__dirname, '..', 'tools', 'entry-shared.js'))
const patch = await imp(join(__dirname, '..', 'tools', 'tool-code-patch', 'handler.js'))

const task = {
  task_id: 'task_create_receipt', revision: 1, route: 'change', lifecycle: 'active',
  node: 'edit', goal: 'create receipt', goal_revision: 1,
  materials: [], operations: [], evidence: [], workspace_dir: WS,
}
shared.putTask(WS, task, { type: 'task_created', task })

const r = await patch.handle({
  workspace_dir: WS, task_id: task.task_id, create: true, dry_run: false,
  content: 'export const x = 1\n',
  locator: { file_path: 'x.js' },
}, {})

assert(r.ok === true, 'create 调用成功（得 ' + JSON.stringify(r.error || r.ok) + '）')
const receipt = r.observation?.receipt
const f = receipt?.files?.[0]
assert(receipt?.op_class === 'create', 'receipt.op_class=create（得 ' + JSON.stringify(receipt?.op_class) + '）')
assert(f?.hashes?.pre === null, 'create pre hash 必须为 null（得 ' + JSON.stringify(f?.hashes?.pre) + '）')
assert(typeof f?.hashes?.intended === 'string' && f.hashes.intended.startsWith('sha256:'), 'create intended hash 必须有值（得 ' + JSON.stringify(f?.hashes?.intended) + '）')
assert(f?.hashes?.intended === f?.hashes?.result, 'create intended 必须等于 result（得 ' + JSON.stringify(f?.hashes) + '）')
assert(f?.hashes?.result === r.observation?.target?.file_version?.hash, 'result hash 必须等于实际文件版本（得 ' + JSON.stringify({ result: f?.hashes?.result, actual: r.observation?.target?.file_version?.hash }) + '）')

// F41：modify 无 request_id 也必须有 pre/intended；否则回执 hashes 双 null
writeFileSync(join(WS, 'y.js'), 'old\n')
const yPre = `sha256:${shared.sha256Hex('old\n')}`
const r2 = await patch.handle({
  workspace_dir: WS, task_id: task.task_id,
  locator: { file_path: 'y.js' },
  base_version: { file: { hash: yPre } },
  patch: { old_string: 'old\n', new_string: 'new\n' },
  dry_run: false,
}, {})
assert(r2.ok === true, 'modify 调用成功（得 ' + JSON.stringify(r2.error || r2.ok) + '）')
const f2 = r2.observation?.receipt?.files?.[0]
assert(f2?.hashes?.pre === yPre, 'modify pre hash 必须等于 base（得 ' + JSON.stringify(f2?.hashes?.pre) + '）')
assert(typeof f2?.hashes?.intended === 'string' && f2.hashes.intended.startsWith('sha256:'), 'modify intended hash 必须有值（得 ' + JSON.stringify(f2?.hashes?.intended) + '）')
assert(f2?.hashes?.intended === f2?.hashes?.result, 'modify intended 必须等于 result（得 ' + JSON.stringify(f2?.hashes) + '）')
assert(f2?.hashes?.pre !== f2?.hashes?.result, 'modify pre 与 result 必须不同（得 ' + JSON.stringify(f2?.hashes) + '）')

try { rmSync(TMP, { recursive: true, force: true }) } catch {}
console.log('== test-patch-create-receipt: ' + pass + ' passed, ' + fail + ' failed ==')
process.exit(fail > 0 ? 1 : 0)
