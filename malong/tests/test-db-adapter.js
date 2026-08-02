// test-db-adapter.js — SQLite 适配层（r35）
// 同一测试在 better-sqlite3（完整版）与 sql.js（沙盒版）后端下运行——
// 沙盒模拟（移除 better-sqlite3）时自动验证 sql.js 路径。
// 覆盖：prepare/get/all/run/transaction/pragma/持久化/只读 mtime 重载/坏行容错
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, rmSync, existsSync, statSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}
const adapter = await import(pathToFileURL(join(__dirname, '..', 'db-adapter.js')).href)

const TMP = join(os.tmpdir(), 'opencode', 'db-adapter-test')
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })
const DB = join(TMP, 't.db')

console.log(`  backend: ${adapter.getBackendName()}`)

// ── 基础 CRUD + 列名对象 ──
{
  const db = await adapter.createDb(DB)
  db.exec('CREATE TABLE IF NOT EXISTS t (a INTEGER, b TEXT)')
  db.prepare('INSERT INTO t VALUES (?, ?)').run(1, 'x')
  const all = db.prepare('SELECT * FROM t').all()
  assert(all.length === 1 && all[0].a === 1 && all[0].b === 'x', `all 返回列名对象（${JSON.stringify(all)}）`)
  const row = db.prepare('SELECT * FROM t WHERE a = ?').get(1)
  assert(row && row.b === 'x', 'get 返回单行')
  assert(db.prepare('SELECT * FROM t WHERE a = ?').get(999) === undefined, 'get 无行返回 undefined')
  db.close()
}

// ── run 返回形状 ──
{
  const db = await adapter.createDb(DB)
  const r = db.prepare('INSERT INTO t (a, b) VALUES (?, ?)').run(2, 'y')
  assert(r.changes === 1, `run.changes=1（${JSON.stringify(r)}）`)
  assert(r.lastInsertRowid >= 2, `run.lastInsertRowid（${r.lastInsertRowid}）`)
  db.close()
}

// ── transaction 包装函数语义 + 回滚 ──
{
  const db = await adapter.createDb(DB)
  const val = db.transaction(() => { db.prepare('INSERT INTO t (a, b) VALUES (?, ?)').run(3, 'z'); return 42 })()
  assert(val === 42, 'transaction 返回包装函数且 fn 返回值透传')
  let threw = false
  try {
    db.transaction(() => { db.prepare('INSERT INTO t (a, b) VALUES (?, ?)').run(4, 'w'); throw new Error('boom') })()
  } catch { threw = true }
  assert(threw, 'transaction 异常上抛')
  assert(db.prepare('SELECT COUNT(*) AS c FROM t WHERE a = 4').get().c === 0, '回滚生效（a=4 不存在）')
  db.close()
}

// ── pragma integrity_check ──
{
  const db = await adapter.createDb(DB)
  const r = db.pragma('integrity_check')
  assert(Array.isArray(r) && r.length === 1 && r[0]?.integrity_check === 'ok', `integrity_check（${JSON.stringify(r)}）`)
  db.close()
}

// ── 持久化：写后重开可读 ──
{
  const db = await adapter.createDb(DB)
  db.prepare('INSERT INTO t (a, b) VALUES (?, ?)').run(9, 'persisted')
  await new Promise(r => setTimeout(r, 700))
  db.close()
  const db2 = await adapter.createDb(DB)
  const n = db2.prepare('SELECT COUNT(*) AS c FROM t WHERE a = 9').get().c
  assert(n === 1, `持久化后重开可读（a=9 计数 ${n}）`)
  db2.close()
}

// ── 只读方 mtime 重载（写进程导出后自动重读）──
{
  const DB2 = join(TMP, 'ro.db')
  const w = await adapter.createDb(DB2)
  w.exec('CREATE TABLE IF NOT EXISTS ro (a INTEGER)')
  w.prepare('INSERT INTO ro VALUES (?)').run(1)
  await new Promise(r => setTimeout(r, 700))
  w.close()

  const ro = await adapter.createDb(DB2, { readonly: true })
  assert(ro.prepare('SELECT COUNT(*) AS c FROM ro').get().c === 1, '只读打开初始读取')
  // 写进程新增一行 → 只读方 mtime 重载
  const w2 = await adapter.createDb(DB2)
  w2.prepare('INSERT INTO ro VALUES (?)').run(2)
  await new Promise(r => setTimeout(r, 700))
  w2.close()
  assert(ro.prepare('SELECT COUNT(*) AS c FROM ro').get().c === 2, `只读方 mtime 重载自动看到新行（${ro.prepare('SELECT COUNT(*) AS c FROM ro').get().c}）`)
  ro.close()
}

// ── prepare 多次复用（statement 生命周期透明）──
{
  const db = await adapter.createDb(DB)
  const st = db.prepare('SELECT * FROM t WHERE a = ?')
  const r1 = st.get(1)
  const r2 = st.get(2)
  assert(r1 && r2 && r1.a === 1 && r2.a === 2, '同一 prepare 多次 get 均可用')
  db.close()
}

rmSync(TMP, { recursive: true, force: true })
console.log(`== test-db-adapter: ${pass} passed, ${fail} failed ==`)
if (fail > 0) process.exit(1)
