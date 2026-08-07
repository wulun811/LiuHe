// test-edit-collision-guard.js — 读写碰撞守卫（Y001-S1 + Y002-S1）
// 覆盖：record→check 基础判定 / 外部修改检测 / session 隔离 / 跨 workspace 串读回归 /
//       classify 四态（this_txn/write_runtime/transaction/batch_edit/external） /
//       大文件采样 / 参数与路径校验 / sha256 哈希 / 快照持久化（跨进程重启保留）
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}
const { handle } = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-edit-collision-guard', 'handler.js')).href)
const { TransactionStore } = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-edit-transaction', 'transaction-store.js')).href)
const { registerWriter } = await import(pathToFileURL(join(__dirname, '..', 'writer-registry.js')).href)

// Y002-S1：测试定向 stateDir，避免快照持久化写进真实 ~/.config/malong
const TMP = join(os.tmpdir(), 'opencode', 'ecg-test-state')
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })
const oldStateDir = process.env.MALONG_STATE_DIR
process.env.MALONG_STATE_DIR = TMP

const ws = join(os.tmpdir(), 'opencode', 'ecg-test-ws')
const ws2 = join(os.tmpdir(), 'opencode', 'ecg-test-ws2')
for (const d of [ws, ws2]) rmSync(d, { recursive: true, force: true })
mkdirSync(ws, { recursive: true })
mkdirSync(ws2, { recursive: true })
const file = 'a.txt'
const pathOf = d => join(d, file)
writeFileSync(pathOf(ws), 'version A')
writeFileSync(pathOf(ws2), 'version B')
const ctx = {}

// ── ① 基础流程 + sha256 哈希长度 ──
{
  const r = await handle({ workspace_dir: ws, file, action: 'record_read' }, ctx)
  assert(r.status === 'recorded' && r.hash && r.hash.length === 64, `① record 返回 sha256 64hex（得 ${r.status} ${r.hash?.length}）`)
  const c = await handle({ workspace_dir: ws, file, action: 'check' }, ctx)
  assert(c.status === 'up_to_date', `① 未改动 check → up_to_date（得 ${c.status}）`)
  assert(c.next_step === 'Safe to edit. Use edit_transaction or edit_batch.', '① next_step 文案')
}

// ── ② 外部修改检测 ──
{
  writeFileSync(pathOf(ws), 'version A changed')
  const c = await handle({ workspace_dir: ws, file, action: 'check' }, ctx)
  assert(c.status === 'modified' && c.modified_by === 'external', `② 外部修改 → modified/external（得 ${c.status}/${c.modified_by}）`)
  assert(c.read_hash && c.current_hash && c.read_seq >= 1, '② 响应带 read_hash/current_hash/read_seq')
  assert(c.warning && c.warning.includes('externally'), '② external 警告文案')
}

// ── ③ never_read / session 隔离 ──
{
  writeFileSync(pathOf(ws), 'version C')
  const n = await handle({ workspace_dir: ws, file, action: 'check', session_id: 'never-probe' }, ctx)
  assert(n.status === 'never_read', '③ 未 record 直接 check → never_read')
  await handle({ workspace_dir: ws, file, action: 'record_read', session_id: 's1' }, ctx)
  const s2 = await handle({ workspace_dir: ws, file, action: 'check', session_id: 's2' }, ctx)
  assert(s2.status === 'never_read', '③ session 隔离：s2 查不到 s1 快照')
  const s1 = await handle({ workspace_dir: ws, file, action: 'check', session_id: 's1' }, ctx)
  assert(s1.status === 'up_to_date', '③ s1 自身仍 up_to_date')
}

// ── ④ 跨 workspace 串读回归（Y001-S1 核心 bug） ──
{
  await handle({ workspace_dir: ws, file, action: 'record_read' }, ctx)
  writeFileSync(pathOf(ws2), 'version B modified')
  const c2 = await handle({ workspace_dir: ws2, file, action: 'check' }, ctx)
  assert(c2.status === 'never_read', `④ 同相对路径跨 ws 不串读：ws2 → never_read（得 ${c2.status}）`)
  const c1 = await handle({ workspace_dir: ws, file, action: 'check' }, ctx)
  assert(c1.status === 'up_to_date', `④ ws1 快照不被 ws2 改动污染（得 ${c1.status}）`)
}

// ── ⑤ classify this_txn：TransactionStore 备份命中 ──
{
  writeFileSync(pathOf(ws), 'version D')
  await handle({ workspace_dir: ws, file, action: 'record_read' }, ctx)
  const store = new TransactionStore(ws)
  const txnId = store.begin('t1')
  await store.backupFile(txnId, file)
  writeFileSync(pathOf(ws), 'version E')
  const c = await handle({ workspace_dir: ws, file, action: 'check' }, ctx)
  assert(c.status === 'modified' && c.modified_by === 'this_txn', `⑤ 备份命中 → this_txn（得 ${c.status}/${c.modified_by}）`)
  assert(c.warning && c.warning.includes('this transaction'), '⑤ this_txn 警告文案')
}

// ── ⑥ 大文件采样路径（>1MB） ──
{
  const big = 'bigfile.txt'
  const bigPath = join(ws, big)
  const MB = 1024 * 1024
  const base = 'x'.repeat(MB + 4096)
  writeFileSync(bigPath, base)
  await handle({ workspace_dir: ws, file: big, action: 'record_read' }, ctx)
  const up = await handle({ workspace_dir: ws, file: big, action: 'check' }, ctx)
  assert(up.status === 'up_to_date', `⑥ 大文件未动 → up_to_date（得 ${up.status}）`)
  const tailMod = base.slice(0, base.length - 100) + 'Y'.repeat(100)
  writeFileSync(bigPath, tailMod)
  const t = await handle({ workspace_dir: ws, file: big, action: 'check' }, ctx)
  assert(t.status === 'modified', `⑥ 大文件尾部修改 → modified（得 ${t.status}）`)
  writeFileSync(bigPath, base)
  await handle({ workspace_dir: ws, file: big, action: 'record_read' }, ctx)
  const midMod = base.slice(0, MB) + 'Z' + base.slice(MB + 1)
  writeFileSync(bigPath, midMod)
  const m = await handle({ workspace_dir: ws, file: big, action: 'check' }, ctx)
  assert(m.status === 'modified', `⑥ 大文件中部修改 → modified（得 ${m.status}）`)
}

// ── ⑦ 参数与路径校验 ──
{
  const a = await handle({ file, action: 'record_read' }, ctx)
  assert(a.error_code === 'INVALID_INPUT', '⑦ 缺 workspace_dir → INVALID_INPUT')
  const b = await handle({ workspace_dir: ws, action: 'record_read' }, ctx)
  assert(b.error_code === 'INVALID_INPUT', '⑦ 缺 file → INVALID_INPUT')
  const c = await handle({ workspace_dir: ws, file, action: 'nonsense' }, ctx)
  assert(c.error_code === 'INVALID_ACTION', '⑦ 非法 action → INVALID_ACTION')
  const d = await handle({ workspace_dir: ws, file: '../escape.txt', action: 'record_read' }, ctx)
  assert(d.error_code === 'PATH_BLOCKED', '⑦ 路径穿越 → PATH_BLOCKED')
  const e = await handle({ workspace_dir: ws, file: 'missing.txt', action: 'record_read' }, ctx)
  assert(e.status === 'file_not_found', '⑦ record 不存在文件 → file_not_found')
}

// ── ⑧ 无 .ai-transactions 时 classify 空吞不崩（external 兜底） ──
{
  const bare = join(os.tmpdir(), 'opencode', 'ecg-test-bare')
  rmSync(bare, { recursive: true, force: true })
  mkdirSync(bare, { recursive: true })
  writeFileSync(join(bare, file), 'v1')
  await handle({ workspace_dir: bare, file, action: 'record_read' }, ctx)
  writeFileSync(join(bare, file), 'v2')
  const c = await handle({ workspace_dir: bare, file, action: 'check' }, ctx)
  assert(c.status === 'modified' && c.modified_by === 'external', `⑧ 无事务目录 → external 不崩（得 ${c.status}/${c.modified_by}）`)
  rmSync(bare, { recursive: true, force: true })
}

// ── ⑨⑩⑪ classify 四态：写者 registry 识别（Y002-S1 写路径契约） ──
{
  // ⑨ write_runtime 登记
  writeFileSync(pathOf(ws), 'v-wr')
  await handle({ workspace_dir: ws, file, action: 'record_read' }, ctx)
  writeFileSync(pathOf(ws), 'v-wr2')
  registerWriter(ws, file, 'write_runtime')
  const c = await handle({ workspace_dir: ws, file, action: 'check' }, ctx)
  assert(c.status === 'modified' && c.modified_by === 'write_runtime', `⑨ write_runtime 登记 → modified_by=write_runtime（得 ${c.status}/${c.modified_by}）`)

  // ⑩ batch_edit 登记
  writeFileSync(pathOf(ws), 'v-be')
  await handle({ workspace_dir: ws, file, action: 'record_read' }, ctx)
  writeFileSync(pathOf(ws), 'v-be2')
  registerWriter(ws, file, 'batch_edit')
  const c2 = await handle({ workspace_dir: ws, file, action: 'check' }, ctx)
  assert(c2.status === 'modified' && c2.modified_by === 'batch_edit', `⑩ batch_edit 登记 → modified_by=batch_edit（得 ${c2.status}/${c2.modified_by}）`)

  // ⑪ transaction 登记（真实 TransactionStore.applyEdits 路径）
  writeFileSync(pathOf(ws), 'v-tx')
  await handle({ workspace_dir: ws, file, action: 'record_read' }, ctx)
  const store = new TransactionStore(ws)
  const txnId = store.begin('t2')
  await store.backupFile(txnId, file)
  await store.applyEdits(txnId, file, [{ old_string: 'v-tx', new_string: 'v-tx2' }])
  const c3 = await handle({ workspace_dir: ws, file, action: 'check' }, ctx)
  assert(c3.status === 'modified' && c3.modified_by === 'transaction', `⑪ applyEdits 登记 → modified_by=transaction（得 ${c3.status}/${c3.modified_by}）`)
}

// ── ⑫ 登记后外部再改 → external（registry 精确匹配，不误判写者） ──
{
  writeFileSync(pathOf(ws), 'v-ex')
  await handle({ workspace_dir: ws, file, action: 'record_read' }, ctx)
  writeFileSync(pathOf(ws), 'v-ex2')
  registerWriter(ws, file, 'batch_edit')
  writeFileSync(pathOf(ws), 'v-ex3')
  const c = await handle({ workspace_dir: ws, file, action: 'check' }, ctx)
  assert(c.status === 'modified' && c.modified_by === 'external', `⑫ 登记后内容再变 → external（得 ${c.status}/${c.modified_by}）`)
}

// ── ⑬ 快照持久化：跨进程重启保留（新进程空内存 → 从 stateDir 盘加载） ──
{
  const snapPath = join(TMP, 'collision-guard-snapshots.json')
  rmSync(snapPath, { force: true })
  const persistWs = join(os.tmpdir(), 'opencode', 'ecg-test-persist')
  rmSync(persistWs, { recursive: true, force: true })
  mkdirSync(persistWs, { recursive: true })
  const pf = join(persistWs, file)
  writeFileSync(pf, 'persist-v1')

  const handlerUrl = pathToFileURL(join(__dirname, '..', 'tools', 'tool-edit-collision-guard', 'handler.js')).href
  const env = { ...process.env, MALONG_STATE_DIR: TMP }
  const runNode = (code) => execFileSync(process.execPath, ['--input-type=module', '-e', code], { env, encoding: 'utf-8' })

  // 进程 A：record_read（写盘）
  runNode(`import { handle } from '${handlerUrl}'
const r = await handle({ workspace_dir: ${JSON.stringify(persistWs)}, file: ${JSON.stringify(file)}, action: 'record_read' }, {})
if (r.status !== 'recorded') throw new Error('record failed: ' + r.status)`)
  assert(existsSync(snapPath), `⑬ record_read 后快照盘文件存在`)

  // 进程 B：新进程（无内存快照）直接 check → 从盘加载 → up_to_date
  const out = runNode(`import { handle } from '${handlerUrl}'
const r = await handle({ workspace_dir: ${JSON.stringify(persistWs)}, file: ${JSON.stringify(file)}, action: 'check' }, {})
console.log(JSON.stringify(r))`)
  const r = JSON.parse(out.trim().split('\n').pop())
  assert(r.status === 'up_to_date', `⑬ 新进程从盘恢复快照 → up_to_date（得 ${r.status}）`)

  // 进程 C：修改后 check → modified/external（registry 未跨进程，回退 external，安全）
  writeFileSync(pf, 'persist-v2')
  const out2 = runNode(`import { handle } from '${handlerUrl}'
const r = await handle({ workspace_dir: ${JSON.stringify(persistWs)}, file: ${JSON.stringify(file)}, action: 'check' }, {})
console.log(JSON.stringify(r))`)
  const r2 = JSON.parse(out2.trim().split('\n').pop())
  assert(r2.status === 'modified' && r2.modified_by === 'external', `⑬ 重启后外部改 → external 不崩（得 ${r2.status}/${r2.modified_by}）`)

  rmSync(persistWs, { recursive: true, force: true })
}

rmSync(ws, { recursive: true, force: true })
rmSync(ws2, { recursive: true, force: true })
rmSync(TMP, { recursive: true, force: true })
process.env.MALONG_STATE_DIR = oldStateDir

console.log(`== test-edit-collision-guard: ${pass} passed, ${fail} failed ==`)
if (fail > 0) process.exit(1)
