// test-r10-open.js — R10（P1）openHealthy 删库竞态回归
// ① corrupt 场景：垃圾 db → rename 到 .corrupt-* 留取证 + 重建成功
// ② BUSY 场景：另一连接持写锁 → initWorkspace 抛错（不删原库、不静默重建）
import { join, dirname } from 'node:path'
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0
let fail = 0
function assert(cond, msg) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`) }
  else { fail++; console.log(`  ✗ ${msg}`) }
}
const imp = (p) => import(pathToFileURL(p).href)

async function bootService(WS) {
  const SOCK = join(tmpdir(), 'opencode', `r10-${Date.now()}.sock`)
  const pc = await imp(join(__dirname, '..', 'parse-client.js'))
  await pc.init({ log: () => {} })
  try { await pc.connect() } catch {}
  const { default: codeIndex } = await imp(join(__dirname, '..', 'code-index.js'))
  const langParser = {
    extractAllAsync: (s, e, f) => pc.extractAll(s, e, f),
    hasErrorsAsync: (s, e, f) => pc.hasErrors(s, e, f),
    batchExtractAsync: (f) => pc.batchExtract(f),
  }
  const services = { langParser }
  const core = {
    services,
    getService: (n) => services[n],
    registerService: (n, svc) => { services[n] = svc },
    getWorkspaceDir: () => WS,
    log: () => {},
    emit: () => {},
    get: (k, def) => k === 'codeIndex.udsPath' ? SOCK : def,
  }
  await codeIndex.init(core)
  return services.codeIndex
}

// ① corrupt 场景：垃圾 code-index.db → openHealthy rename 到 .corrupt-* + 重建
{
  const WS = join(tmpdir(), 'opencode', 'r10-corrupt')
  rmSync(WS, { recursive: true, force: true })
  mkdirSync(WS, { recursive: true })
  writeFileSync(join(WS, 'code-index.db'), 'this is not a sqlite database at all')
  const svc = await bootService(WS)
  await svc.initWorkspace(WS)
  const files = existsSync(WS) ? readdirSync(WS) : []
  const corruptBackups = files.filter(f => f.startsWith('code-index.db.corrupt-'))
  assert(corruptBackups.length >= 1, `corrupt db rename 到 .corrupt-* 留取证（得 ${corruptBackups.join(',')}）`)
  const ok = await svc.searchSymbols('x')
  assert(Array.isArray(ok), `重建后服务可用（searchSymbols 返回数组）`)
  assert(existsSync(join(WS, 'code-index.db')), `重建的 db 存在`)
  rmSync(WS, { recursive: true, force: true })
}

// ② BUSY 场景：另一连接持写锁 → initWorkspace 抛错，原库不删
{
  const WS = join(tmpdir(), 'opencode', 'r10-busy')
  rmSync(WS, { recursive: true, force: true })
  mkdirSync(WS, { recursive: true })
  const dbPath = join(WS, 'code-index.db')
  // 先构造一个健康库
  const { createDb } = await imp(join(__dirname, '..', 'db-adapter.js'))
  const seed = await createDb(dbPath, {})
  seed.pragma('journal_mode=WAL')
  seed.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, name TEXT)')
  seed.close()

  // 另一连接持写锁（better-sqlite3 直接占用）——locking_mode=EXCLUSIVE 让任何其他连接操作 BUSY
  const Database = (await import('better-sqlite3')).default
  const locker = new Database(dbPath)
  locker.pragma('busy_timeout = 0')
  locker.pragma('locking_mode = EXCLUSIVE')
  locker.exec('BEGIN IMMEDIATE')

  const svc = await bootService(WS)
  let threw = false
  let errMsg = ''
  try {
    await svc.initWorkspace(WS)
  } catch (e) {
    threw = true
    errMsg = e.message
  }
  locker.exec('ROLLBACK')
  locker.close()
  assert(threw, `BUSY 时 initWorkspace 抛错（不静默重建）`)
  assert(/DB unavailable/i.test(errMsg), `错误信息显式 DB unavailable（${errMsg.slice(0, 80)}）`)
  assert(existsSync(dbPath), `BUSY 后原库保留（未删）`)
  const wsDirFiles = readdirSync(WS)
  assert(!wsDirFiles.some(f => f.includes('.corrupt-')), `BUSY 不产生 .corrupt- 备份（未误判损坏）`)
  rmSync(WS, { recursive: true, force: true })
}

console.log(`== test-r10-open: ${pass} passed, ${fail} failed ==`)
process.exit(fail > 0 ? 1 : 0)