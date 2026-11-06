// test-journal-state-write-failure.js — GATE-03（专家 0.6.1 §3，P1 设计核验）
//
// 专家要求：注入 state.json / manifest 写入失败，检查
//   ① 报告是否诚实（不得把「状态没写进去」说成已恢复/已提交）
//   ② 重启后是否进入 needs_review（或至少不被当成终态清掉）
//   ③ 不得虚构持久化、不得自动回滚已落盘的内容
//
// 现状（修前已知）：updateJournalState() 用 try{}catch{} 吞掉所有异常，
// 调用方通常不知道状态写入失败。本测试把「失败路径可观测」固定成合同。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) pass++
  else { fail++; console.error('  FAIL:', msg) }
}

const jr = await import(pathToFileURL(join(root, 'write-journal.js')).href)
const created = []
function fresh(tag) {
  const ws = mkdtempSync(join(tmpdir(), `lh-jgate-${tag}-`))
  created.push(ws)
  return ws
}

try {
  // ── ① updateJournalState 必须把失败反馈给调用方（不能全吞）──
  {
    const ws = fresh('report')
    const j = jr.createJournal(ws, 'a.js', join(ws, 'a.js'), 'const a = 1;\n', { editMode: 'patch' })
    // 把 state.json 换成非空目录 → 原子写 rename 到该路径必失败（EISDIR/ENOTEMPTY）
    rmSync(join(j.dir, 'state.json'), { force: true })
    mkdirSync(join(j.dir, 'state.json', 'blocks'), { recursive: true })
    writeFileSync(join(j.dir, 'state.json', 'blocks', 'x'), 'x')
    const r = jr.updateJournalState(j.dir, { state: 'committed' })
    assert(r && typeof r === 'object', '① updateJournalState 必须返回结构化结果（不得返回 undefined）')
    assert(r.ok === false, `① 写入失败必须 ok=false（得 ${JSON.stringify(r)}）`)
    assert(typeof r.error === 'string' && r.error.length > 0, '① 失败必须携带 error 文案')
    // 不得虚构持久化
    const onDisk = (() => { try { return readFileSync(join(j.dir, 'state.json'), 'utf-8') } catch { return null } })()
    assert(onDisk === null || !onDisk.includes('"committed"'), '① 不得声称已落盘（磁盘上没有 committed）')
  }

  // ── ② 成功路径仍返回 ok=true 且真的落盘（反向保护：不能为了报错把成功也报错）──
  {
    const ws = fresh('ok')
    const j = jr.createJournal(ws, 'b.js', join(ws, 'b.js'), 'const b = 1;\n', { editMode: 'patch' })
    const r = jr.updateJournalState(j.dir, { state: 'committed', committed_at: new Date().toISOString() })
    assert(r.ok === true, `② 正常写入应 ok=true（得 ${JSON.stringify(r)}）`)
    const st = JSON.parse(readFileSync(join(j.dir, 'state.json'), 'utf-8'))
    assert(st.state === 'committed', '② 正常写入确实落盘')
  }

  // ── ③ 恢复流程不得把「状态写不进去」的目录当终态清掉 ──
  {
    const ws = fresh('recover')
    const j = jr.createJournal(ws, 'c.js', join(ws, 'c.js'), 'const c = 1;\n', { editMode: 'patch' })
    jr.updateJournalState(j.dir, { state: 'staged', new_hash: 'deadbeef' })
    // 让 state.json 不可读亦不可写（目录占位）
    rmSync(join(j.dir, 'state.json'), { force: true })
    mkdirSync(join(j.dir, 'state.json'))
    const recovered = await jr.recoverJournals(ws)
    assert(existsSync(j.dir), '③ 状态不可读写的事务目录必须保留（不得当孤儿删）')
    const act = recovered.find(x => x.txn_id === j.txnId)
    assert(!!act, `③ 恢复结果必须披露该事务（得 ${JSON.stringify(recovered)}）`)
    assert(act && /unparseable|manual|review/i.test(String(act.action) + String(act.reason || '')),
      `③ 披露必须指向人工复核（得 ${act && (act.action + ':' + (act.reason || ''))}）`)
  }

  // ── ④ 已落盘的业务内容不得被「状态写入失败」连累回滚 ──
  {
    const ws = fresh('noautoro')
    writeFileSync(join(ws, 'd.js'), 'const d = 1;\n')
    const j = jr.createJournal(ws, 'd.js', join(ws, 'd.js'), 'const d = 1;\n', { editMode: 'patch' })
    // 模拟 edit 已落盘：文件变 d=2，state 记 staged+new_hash
    writeFileSync(join(ws, 'd.js'), 'const d = 2;\n')
    const { createHash } = await import('node:crypto')
    const nh = createHash('sha256').update(Buffer.from('const d = 2;\n')).digest('hex')
    jr.updateJournalState(j.dir, { state: 'staged', new_hash: nh })
    // 现在破坏 state 写入目标，让「补标 committed_recovered」写不进去
    rmSync(join(j.dir, 'state.json'), { force: true })
    mkdirSync(join(j.dir, 'state.json'))
    await jr.recoverJournals(ws)
    assert(readFileSync(join(ws, 'd.js'), 'utf-8') === 'const d = 2;\n', '④ 已落盘的编辑不得因状态写失败被回滚（不得虚构恢复）')
    assert(existsSync(j.dir), '④ 目录保留（备份仍可人工取回）')
  }

  // ── ⑤ pruneJournals 对「state 不可解析」的目录不得静默删（与 CE19 同型）──
  {
    const ws = fresh('prune')
    const j = jr.createJournal(ws, 'e.js', join(ws, 'e.js'), 'const e = 1;\n', { editMode: 'patch' })
    rmSync(join(j.dir, 'state.json'), { force: true })
    writeFileSync(join(j.dir, 'state.json'), '{broken')
    const old = new Date(Date.now() - 40 * 86400_000)
    const { utimesSync } = await import('node:fs')
    utimesSync(j.dir, old, old)
    const r = jr.pruneJournals(ws, { force: true })
    assert(existsSync(j.dir), '⑤ state 不可解析的超龄 journal 不得被自动删（保留待人工）')
    assert(r.pruned === 0, `⑤ 不得计入 pruned（得 ${JSON.stringify(r)}）`)
    assert(r.kept >= 1, '⑤ 应计入 kept')
  }
} finally {
  for (const d of created) { try { rmSync(d, { recursive: true, force: true }) } catch {} }
}

console.log(`\n== test-journal-state-write-failure: ${pass} passed, ${fail} failed ==`)
if (fail > 0) process.exitCode = 1
