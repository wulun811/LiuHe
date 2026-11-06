// test-txn-rollback-scope.js — 回滚作用域边界（R16f）
//
// 背景：2026-10-31 我在一个**跨天 staged 事务**上误触发 rollback，把已经提交进 git 的内容
// 一起撤回了工作区。复核后的结论是：rollback 只对 staged 事务生效（已提交事务查不到），
// 那是我的用法错误，不是工具缺陷——按约定不为不存在的缺陷改代码。
//
// 但这条安全边界此前没有专门用例。将来若有人“顺手放宽 rollback 作用域”（比如让已提交事务
// 也能回滚），这里会立刻红。本文件锁的是**不变量**，不是实现细节：
//   ① 已提交事务 rollback → 拒绝，磁盘不变
//   ② commit 后用同一 txn_id 编辑 → 续接成新事务（continued_from 可追溯）
//   ③ 拒绝回滚旧事务时，不得连坐新事务的写入
//   ④ 拒绝不等于销毁：recent/<txn> 仍在，undo_commit 能力保留
//   ⑤ staged 事务 rollback → 回到 begin 时的字节（语义锁）
//   ⑥ staged 事务期间文件被外部改写 → 跳过并报 external_change，不得覆盖外部内容
import { join, dirname } from 'node:path'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import os from 'node:os'

// Windows 复核（2026-11-06）：URL.pathname 在 win32 返回 `/N:/...`（盘符前多斜杠 + 百分号编码），
// join 后成 `N:\N:\...` → ERR_MODULE_NOT_FOUND。用 fileURLToPath 解码。
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const { handle } = await import(pathToFileURL(join(REPO, 'tools', 'tool-edit-transaction', 'handler.js')).href)
const ctx = { codeIndexService: null, langParserService: { hasErrorsAsync: async () => ({ has_errors: false }) } }

let pass = 0, fail = 0
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  FAIL:', msg) } }

const WS = join(os.tmpdir(), 'opencode', 'txn-rollback-scope-ws')
rmSync(WS, { recursive: true, force: true })
mkdirSync(WS, { recursive: true })
const p = join(WS, 'a.js')
const read = () => readFileSync(p, 'utf-8')
writeFileSync(p, 'v0\n')

// ── ① 已提交事务不可被 rollback 越过 ──
const a = await handle({ workspace_dir: WS, action: 'begin', name: 'A' }, ctx)
await handle({ workspace_dir: WS, action: 'edit', txn_id: a.txnId, file: 'a.js', edits: [{ old_string: 'v0', new_string: 'v1' }] }, ctx)
const c1 = await handle({ workspace_dir: WS, action: 'commit', txn_id: a.txnId }, ctx)
assert(c1.status === 'committed', '① 前置：第一次提交成功（得 ' + JSON.stringify(c1.status) + '）')
const rb1 = await handle({ workspace_dir: WS, action: 'rollback', txn_id: a.txnId }, ctx)
assert(rb1.error === 'txn_not_found', '① 已提交事务 rollback 必须以 txn_not_found 拒绝（得 ' + JSON.stringify({ status: rb1.status, error: rb1.error, message: rb1.message }) + '）')
assert(read().trim() === 'v1', '① 被拒时磁盘内容不得变化（得 ' + JSON.stringify(read().trim()) + '）')

// ── ② commit 后复用同一 txn_id → 续接新事务 ──
const e2 = await handle({ workspace_dir: WS, action: 'edit', txn_id: a.txnId, file: 'a.js', edits: [{ old_string: 'v1', new_string: 'v2' }] }, ctx)
assert(e2.status === 'staged' && e2.txn_id && e2.txn_id !== a.txnId && e2.continued_from === a.txnId,
  '② 续接成新事务且可追溯（得 ' + JSON.stringify({ s: e2.status, id: e2.txn_id, cf: e2.continued_from }) + '）')
const c2 = await handle({ workspace_dir: WS, action: 'commit', txn_id: e2.txn_id }, ctx)
assert(c2.status === 'committed' && read().trim() === 'v2', '② 续接事务提交后内容为 v2（得 ' + JSON.stringify({ s: c2.status, c: read().trim() }) + '）')

// ── ③ 再次拒回滚旧事务：不得连坐新事务写入 ──
const rb2 = await handle({ workspace_dir: WS, action: 'rollback', txn_id: a.txnId }, ctx)
assert(rb2.error === 'txn_not_found' && read().trim() === 'v2', '③ 拒回滚旧事务不得撤销新事务内容（得 ' + JSON.stringify({ e: rb2.error, c: read().trim() }) + '）')

// ── ④ 拒绝 ≠ 销毁：recent/<txn> 保留，undo 能力还在 ──
assert(existsSync(join(WS, '.ai-transactions', 'recent', a.txnId)), '④ recent/<txn> 必须保留供 undo_commit（路径 ' + a.txnId + '）')

// ── ⑤ staged 事务回滚 = 回到 begin 字节 ──
writeFileSync(p, 'w0\n')
const b = await handle({ workspace_dir: WS, action: 'begin', name: 'B' }, ctx)
await handle({ workspace_dir: WS, action: 'edit', txn_id: b.txnId, file: 'a.js', edits: [{ old_string: 'w0', new_string: 'w1' }] }, ctx)
const rbB = await handle({ workspace_dir: WS, action: 'rollback', txn_id: b.txnId }, ctx)
assert(rbB.status === 'rolled_back' && read().trim() === 'w0', '⑤ staged 回滚回到 begin 字节（得 ' + JSON.stringify({ s: rbB.status, c: read().trim() }) + '）')

// ── ⑥ staged 期间被外部改写 → 跳过，不覆盖 ──
writeFileSync(p, 'x0\n')
const c = await handle({ workspace_dir: WS, action: 'begin', name: 'C' }, ctx)
await handle({ workspace_dir: WS, action: 'edit', txn_id: c.txnId, file: 'a.js', edits: [{ old_string: 'x0', new_string: 'x1' }] }, ctx)
writeFileSync(p, 'x2\n') // 外部写入
const rbC = await handle({ workspace_dir: WS, action: 'rollback', txn_id: c.txnId }, ctx)
const skipped = (rbC.skipped || []).map(s => s.reason)
assert(rbC.status === 'rolled_back_partial' && skipped.includes('external_change'),
  '⑥ 外部改写必须跳过并报 external_change（得 ' + JSON.stringify({ s: rbC.status, skipped }) + '）')
assert(read().trim() === 'x2', '⑥ 不得覆盖外部内容（得 ' + JSON.stringify(read().trim()) + '）')

// ── ⑦ 不存在的 txn_id：明确拒绝，不产生副作用 ──
const rbX = await handle({ workspace_dir: WS, action: 'rollback', txn_id: 'no-such-txn' }, ctx)
assert(rbX.error === 'txn_not_found' && read().trim() === 'x2', '⑦ 未知事务被拒且无副作用（得 ' + JSON.stringify({ e: rbX.error, c: read().trim() }) + '）')

rmSync(WS, { recursive: true, force: true })
console.log('== test-txn-rollback-scope: ' + pass + ' passed, ' + fail + ' failed ==')
process.exit(fail > 0 ? 1 : 0)
