// test-commit-interleaving.js — R3-CE17：commit 校验窗口内外部写不得得到假成功回执
//
// 来源（《R3 独立复核裁决与 G2 下一阶段路线》§2，2026-10-29）：
//   commit() 的循环里对每个文件先同步比对 hash，随后 `await this._validateContent(...)`。
//   在这个 await 窗口内，另一个写入者改写工作区文件；循环结束后代码**不再复检**，
//   直接写 manifest.state='committed'、搬入 recent/、返回 status='committed'。
//   事后回读算出 readback_verified=false，但回执里仍然是绿灯。
//
//   专家判词：「这不是新框架需求，而是旧状态事实向 LLM 反馈出现失真。」
//   最小修复要求：
//     - 验证完成后的 Hash 复检必须作为可信提交前提（不是事后提示）
//     - 复检发现期望效果被外部覆盖 → 返回 commit_conflict / indeterminate，
//       **不得**附带 receipt.files[].status='committed'
//     - 不因外部并发变化自动回滚（保护第三方修改）
//     - 明确隔离等级：文件锁只排他「合作写入者」
//
// 本文件先红后绿：修复前 CE17-a/b 必红，修复后全绿。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const M = join(__dirname, '..')
let pass = 0, fail = 0
function assert(cond, msg) { if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) } }

const { handle } = await import(pathToFileURL(join(M, 'tools', 'tool-edit-transaction', 'handler.js')).href)
const { TransactionStore } = await import(pathToFileURL(join(M, 'tools', 'tool-edit-transaction', 'transaction-store.js')).href)

const mk = () => { const w = mkdtempSync(join(tmpdir(), 'ce17-')); mkdirSync(join(w, 'src'), { recursive: true }); return w }
const rd = (w, ...p) => readFileSync(join(w, ...p), 'utf-8')

// 可控异步闸门：精确打开 commit 里 await 校验的窗口
function makeGate() {
  let hold = false
  let unblock = () => {}
  let informEntered = () => {}
  const gate = new Promise(r => { unblock = r })
  const entered = new Promise(r => { informEntered = r })
  return {
    setHold(v) { hold = v },
    gate, entered,
    unblock: () => unblock(),
    ctx(trigger) {
      return {
        codeIndexService: null,
        langParserService: {
          hasErrorsAsync: async (source) => {
            if (hold && trigger(source)) { informEntered(); await gate }
            return false
          },
        },
      }
    },
  }
}

// ── CE17-a：单文件，校验窗口内被第三方改写 → 不得回报 committed ──
{
  const ws = mk()
  const g = makeGate()
  const ctx = g.ctx(() => true)
  writeFileSync(join(ws, 'src', 'f.js'), 'const x=1;\n')
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'ce17a' }, ctx)
  const e = await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 'src/f.js', edits: [{ old_string: 'x=1', new_string: 'x=2' }] }, ctx)
  assert(e.status === 'staged', 'CE17-a 前置：edit staged（得 ' + JSON.stringify(e.status || e.error_code) + '）')

  g.setHold(true)
  const inFlight = handle({ workspace_dir: ws, action: 'commit', txn_id: b.txnId }, ctx)
  await g.entered
  writeFileSync(join(ws, 'src', 'f.js'), 'const x=999;\n')
  g.unblock()
  const r = await inFlight
  const disk = rd(ws, 'src', 'f.js')

  assert(r.status !== 'committed', 'CE17-a 校验窗口内被外部改写时不得返回 status=committed（得 ' + JSON.stringify(r.status) + '）')
  assert(r.receipt?.state_commit !== 'committed', 'CE17-a receipt.state_commit 不得为 committed（得 ' + JSON.stringify(r.receipt?.state_commit) + '）')
  assert(r.receipt?.files?.[0]?.status !== 'committed', 'CE17-a receipt.files[0].status 不得为 committed（得 ' + JSON.stringify(r.receipt?.files?.[0]?.status) + '）')
  assert(!!(r.error_code || r.error), 'CE17-a 必须给出结构化拒绝（得 ' + JSON.stringify({ s: r.status, ec: r.error_code, e: r.error }) + '）')
  assert(disk === 'const x=999;\n', 'CE17-a 第三方修改不得被抹掉（得 ' + JSON.stringify(disk) + '）')
  rmSync(ws, { recursive: true, force: true })
}

// ── CE17-b：多文件，校验第二个文件时第一个被改写 → 同样不得回报 committed ──
// 这是 CE17-a 的更严格版本：只复检「最后校验的那个文件」不够，必须复检全组。
{
  const ws = mk()
  const g = makeGate()
  const ctx = g.ctx(source => source.includes('b=2'))
  writeFileSync(join(ws, 'src', 'a.js'), 'const a=1;\n')
  writeFileSync(join(ws, 'src', 'b.js'), 'const b=1;\n')
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'ce17b' }, ctx)
  await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 'src/a.js', edits: [{ old_string: 'a=1', new_string: 'a=2' }] }, ctx)
  await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 'src/b.js', edits: [{ old_string: 'b=1', new_string: 'b=2' }] }, ctx)

  g.setHold(true)
  const inFlight = handle({ workspace_dir: ws, action: 'commit', txn_id: b.txnId }, ctx)
  await g.entered
  writeFileSync(join(ws, 'src', 'a.js'), 'const a=999;\n') // 改的是「已校验过」的第一个文件
  g.unblock()
  const r = await inFlight

  assert(r.status !== 'committed', 'CE17-b 多文件：已校验文件被改写时不得返回 committed（得 ' + JSON.stringify(r.status) + '）')
  assert(rd(ws, 'src', 'a.js') === 'const a=999;\n', 'CE17-b 第三方修改不得被抹掉（得 ' + JSON.stringify(rd(ws, 'src', 'a.js')) + '）')
  rmSync(ws, { recursive: true, force: true })
}

// ── CE17-c：正常路径不得被误伤（防过度拒绝）──
{
  const ws = mk()
  const ctx = { codeIndexService: null, langParserService: { hasErrorsAsync: async () => false } }
  writeFileSync(join(ws, 'src', 'f.js'), 'const x=1;\n')
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'ce17c' }, ctx)
  await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 'src/f.js', edits: [{ old_string: 'x=1', new_string: 'x=2' }] }, ctx)
  const r = await handle({ workspace_dir: ws, action: 'commit', txn_id: b.txnId }, ctx)
  assert(r.status === 'committed', 'CE17-c 正常提交仍须 committed（得 ' + JSON.stringify(r.status || r.error) + '）')
  assert(r.receipt?.state_commit === 'committed', 'CE17-c 正常提交 receipt.state_commit=committed（得 ' + JSON.stringify(r.receipt?.state_commit) + '）')
  assert(r.receipt?.files?.[0]?.status === 'committed', 'CE17-c 正常提交 files[0].status=committed')
  assert(r.file_hashes?.['src/f.js']?.readback_verified === true, 'CE17-c 正常提交 readback_verified=true')
  assert(rd(ws, 'src', 'f.js') === 'const x=2;\n', 'CE17-c 正常提交内容正确')
  rmSync(ws, { recursive: true, force: true })
}

// ── CE17-d：commit 前已存在外部改动（无交错）→ 仍须拒绝（防回归）──
{
  const ws = mk()
  const ctx = { codeIndexService: null, langParserService: { hasErrorsAsync: async () => false } }
  writeFileSync(join(ws, 'src', 'f.js'), 'const x=1;\n')
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'ce17d' }, ctx)
  await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 'src/f.js', edits: [{ old_string: 'x=1', new_string: 'x=2' }] }, ctx)
  writeFileSync(join(ws, 'src', 'f.js'), 'const x=999;\n')
  const r = await handle({ workspace_dir: ws, action: 'commit', txn_id: b.txnId }, ctx)
  assert(r.status !== 'committed' && !!(r.error || r.error_code), 'CE17-d 既有外部改动仍须拒绝（得 ' + JSON.stringify(r.status || r.error_code) + '）')
  assert(r.receipt?.state_commit !== 'committed', 'CE17-d 不得给 committed 回执')
  assert(rd(ws, 'src', 'f.js') === 'const x=999;\n', 'CE17-d 外部内容保留')
  rmSync(ws, { recursive: true, force: true })
}

// ── CE17-e：被拒绝的提交必须保留可处理的事务（不自动回滚，不吞掉目录）──
{
  const ws = mk()
  const g = makeGate()
  const ctx = g.ctx(() => true)
  writeFileSync(join(ws, 'src', 'f.js'), 'const x=1;\n')
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'ce17e' }, ctx)
  await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 'src/f.js', edits: [{ old_string: 'x=1', new_string: 'x=2' }] }, ctx)
  g.setHold(true)
  const inFlight = handle({ workspace_dir: ws, action: 'commit', txn_id: b.txnId }, ctx)
  await g.entered
  writeFileSync(join(ws, 'src', 'f.js'), 'const x=999;\n')
  g.unblock()
  const r = await inFlight
  assert(r.status !== 'committed', 'CE17-e 前提：拒绝提交（得 ' + JSON.stringify(r.status) + '）')

  // 事务目录仍在顶层（未搬入 recent/），即仍可 rollback / 重试
  const topLevel = existsSync(join(ws, '.ai-transactions', b.txnId))
  const inRecent = existsSync(join(ws, '.ai-transactions', 'recent', b.txnId))
  assert(topLevel && !inRecent, 'CE17-e 拒绝提交后事务须留在顶层（top=' + topLevel + ' recent=' + inRecent + '）')

  // 不得自动回滚（第三方修改必须保留）
  assert(rd(ws, 'src', 'f.js') === 'const x=999;\n', 'CE17-e 不得自动回滚覆盖第三方修改（得 ' + JSON.stringify(rd(ws, 'src', 'f.js')) + '）')

  // 且必须明确告知「staged 效果此前已写盘」——防止 LLM 误以为文件从未变过
  const txt = JSON.stringify(r)
  assert(!/file was not modified|no changes were made|zero write/i.test(txt),
    'CE17-e 拒绝回执不得宣称零写入（staged 时文件确已改过）')
  rmSync(ws, { recursive: true, force: true })
}

// ── CE17-f：最终定档后回读失配 → 不得给绿灯 ──
// 用子类在「manifest 已写 committed」这一瞬间注入外部写，确定性覆盖定档后窗口。
{
  const ws = mk()
  writeFileSync(join(ws, 'src', 'f.js'), 'const x=1;\n')
  class InjectingStore extends TransactionStore {
    constructor(root, opts = {}) { super(root, opts); this.injected = false }
    _writeManifest(txnId, m) {
      super._writeManifest(txnId, m)
      if (m && m.state === 'committed' && !this.injected) {
        this.injected = true
        writeFileSync(join(this.projectRoot, 'src', 'f.js'), 'const x=999;\n')
      }
    }
  }
  const store = new InjectingStore(ws, { sweep: false })
  const txnId = store.begin('ce17f')
  const e = await store.applyEdits(txnId, 'src/f.js', [{ old_string: 'x=1', new_string: 'x=2' }])
  assert(e.status === 'staged', 'CE17-f 前置：edit staged（得 ' + JSON.stringify(e.status || e.error_code) + '）')
  const r = await store.commit(txnId)
  assert(r.status !== 'committed',
    'CE17-f 定档后回读失配时不得返回 committed（得 ' + JSON.stringify(r.status) + '）')
  assert(r.file_hashes?.['src/f.js']?.readback_verified === false,
    'CE17-f 必须如实报告 readback_verified=false（得 ' + JSON.stringify(r.file_hashes?.['src/f.js']) + '）')
  assert(r.effect === 'external_change_observed',
    'CE17-f 必须给出 effect=external_change_observed（得 ' + JSON.stringify(r.effect) + '）')
  assert(rd(ws, 'src', 'f.js') === 'const x=999;\n', 'CE17-f 第三方修改保留')
  rmSync(ws, { recursive: true, force: true })
}

// ── CE17-g：commit 结束后不得残留 .mlock（锁必须释放）──
{
  const ws = mk()
  const ctx = { codeIndexService: null, langParserService: { hasErrorsAsync: async () => false } }
  writeFileSync(join(ws, 'src', 'f.js'), 'const x=1;\n')
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'ce17g' }, ctx)
  await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 'src/f.js', edits: [{ old_string: 'x=1', new_string: 'x=2' }] }, ctx)
  await handle({ workspace_dir: ws, action: 'commit', txn_id: b.txnId }, ctx)
  const leftover = readdirSync(join(ws, 'src')).filter(f => f.endsWith('.mlock'))
  assert(leftover.length === 0, 'CE17-g commit 后不得残留锁文件（得 ' + JSON.stringify(leftover) + '）')
  rmSync(ws, { recursive: true, force: true })
}

// ── CE17-h：commit 结果必须声明隔离等级（不得暗示数据库式隔离）──
{
  const ws = mk()
  const ctx = { codeIndexService: null, langParserService: { hasErrorsAsync: async () => false } }
  writeFileSync(join(ws, 'src', 'f.js'), 'const x=1;\n')
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'ce17h' }, ctx)
  await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 'src/f.js', edits: [{ old_string: 'x=1', new_string: 'x=2' }] }, ctx)
  const r = await handle({ workspace_dir: ws, action: 'commit', txn_id: b.txnId }, ctx)
  assert(!!r.isolation, 'CE17-h commit 结果须带 isolation 声明（得 ' + JSON.stringify(Object.keys(r)) + '）')
  assert(/cooperat|non-cooperat|advisory/i.test(JSON.stringify(r.isolation)),
    'CE17-h isolation 须说明锁只约束合作写入者（得 ' + JSON.stringify(r.isolation) + '）')
  rmSync(ws, { recursive: true, force: true })
}

console.log('== test-commit-interleaving: ' + pass + ' passed, ' + fail + ' failed ==')
if (fail > 0) process.exit(1)
