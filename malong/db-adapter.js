// db-adapter.js — SQLite 双后端适配层（r35：沙盒分支产品）
// 完整版（默认）：better-sqlite3 直接透传原生实例——行为 100% 不变，零影响。
// 沙盒版（better-sqlite3 不可用 / Node ≥20 零依赖）：vendored sql.js（WASM 内存库）。
//   - 只读方：mtime 检测自动重载（写进程 export 后重读）
//   - 写方：脏标记 + 事务粒度 export + 500ms 节流合并，tmp+rename 原子写回
//   - pragma/transaction/get/all/run 返回形状对齐 better-sqlite3
import { existsSync, readFileSync, writeFileSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const __dirname = dirname(fileURLToPath(import.meta.url))
const _require = createRequire(import.meta.url)

const SQLJS_DIR = join(__dirname, 'vendor')
const EXPORT_THROTTLE_MS = 500

let _backend = null // 'better-sqlite3' | 'sql.js'
let _sqlJsInit = null

function detectBackend() {
  if (_backend) return _backend
  try {
    _require('better-sqlite3')
    _backend = 'better-sqlite3'
  } catch {
    _backend = 'sql.js'
  }
  return _backend
}

async function initSqlJsOnce() {
  if (_sqlJsInit) return _sqlJsInit
  const { default: initSqlJs } = _require(join(SQLJS_DIR, 'sql-wasm.cjs'))
  _sqlJsInit = await initSqlJs({
    locateFile: (f) => join(SQLJS_DIR, f),
  })
  return _sqlJsInit
}

const WRITE_RE = /\b(INSERT|UPDATE|DELETE|CREATE|DROP|REPLACE|ALTER|VACUUM|REINDEX)\b/i

function isWriteSql(sql) {
  return WRITE_RE.test(sql)
}

// R22-⑰（第四轮审核 P1）：sql.js 后端 500ms 节流导出 + unref timer → SIGTERM/正常退出时
// 最近 500ms 脏数据只在内存（DB 文件不新）。exit 钩子同步落盘兜底（exportNow 全同步：writeFileSync+renameSync）。
// SIGKILL 无法拦截（进程被内核杀，事件循环不执行）——文档语义仍是「关键操作后显式 close/exportNow」。
const _sqlJsInstances = new Set()
process.once('exit', () => {
  for (const inst of _sqlJsInstances) {
    try {
      if (!inst.readonly && inst._dirty) inst.exportNow()
    } catch {}
  }
})

// ── sql.js 后端包装 ──

class SqlJsDb {
  constructor(path, opts = {}) {
    this.path = path
    this.readonly = !!opts.readonly
    this._db = null
    this._dirty = false
    this._inTxn = 0
    this._exportTimer = null
    this._loadMtime = 0
    this._closed = false
    this._loadSize = 0
    this._lastExportError = null
    this._lockFile = null
    this._loaded = this._load()
    if (!this.readonly) this._acquireWriteLock()
    // R22-⑰：注册 exit 兜底（close 时注销）
    if (!this.readonly) _sqlJsInstances.add(this)
  }

  // R12：写锁（sql.js 后端多进程防护）——O_EXCL 独占，stale（pid 已死）自动回收。
  // 锁冲突不 throw：openHealthy 会把 createDb 抛错误判为损坏而 rename 重建健康库。
  // R22-⑱（第五轮核实）：旧 stale 检测只查 pid 存活——PID 被 OS 复用到无关进程时锁永远有效。
  // 加 heartbeat（持有者每 30s touch mtime）+ mtime>120s 判定：崩溃/被杀/占锁者退场都能回收，
  // 无关进程不会 touch 锁 → 120s 后自动回收。
  _acquireWriteLock() {
    if (!this.path) return
    const lockPath = this.path + '.lock'
    const tryTake = () => {
      try {
        writeFileSync(lockPath, `${process.pid} ${Date.now()}`, { flag: 'wx' })
        this._lockFile = lockPath
        this._lockHeartbeat = setInterval(() => {
          try {
            writeFileSync(lockPath, `${process.pid} ${Date.now()}`)
          } catch {}
        }, 30_000)
        if (this._lockHeartbeat.unref) this._lockHeartbeat.unref()
        return true
      } catch { return false }
    }
    if (tryTake()) return
    try {
      const content = readFileSync(lockPath, 'utf-8').trim()
      const pid = parseInt(content, 10)
      if (pid && pid !== process.pid) {
        let pidAlive = true
        try { process.kill(pid, 0) } catch { pidAlive = false }
        let stale = !pidAlive
        if (pidAlive) {
          try {
            const st = statSync(lockPath)
            if (Date.now() - st.mtimeMs > 120_000) stale = true // 无 heartbeat → 占锁者已死/被复用的无关进程
          } catch { stale = true }
        }
        if (stale) {
          // stale 锁，回收重取
          try { unlinkSync(lockPath) } catch {}
          if (tryTake()) return
        }
      }
    } catch {}
    console.error(`[db-adapter] refusing write lock: ${lockPath} — another writer process holds the DB lock (multi-writer deployments require better-sqlite3)`)
  }

  _releaseWriteLock() {
    if (this._lockHeartbeat) { clearInterval(this._lockHeartbeat); this._lockHeartbeat = null }
    if (this._lockFile) {
      try { unlinkSync(this._lockFile) } catch {}
      this._lockFile = null
    }
  }

  _load() {
    const SQL = _sqlJsInit
    if (this.path && existsSync(this.path)) {
      const st = statSync(this.path)
      this._loadMtime = st.mtimeMs
      this._loadSize = st.size
      const data = new Uint8Array(readFileSync(this.path))
      this._db = new SQL.Database(data)
    } else {
      this._db = new SQL.Database()
      this._loadMtime = 0
      this._loadSize = 0
    }
    // 只读方在事务里（BEGIN）时替换实例会丢事务状态——但重载只在查询前触发，
    // 查询前无未完成事务
    return true
  }

  _checkReload() {
    if (this.readonly && this.path && existsSync(this.path)) {
      // r36-fix: mtime+size 双比较——低精度文件系统（FAT/网络盘秒级 mtime）
      // 下同秒两次写盘 mtime 不变会漏重载；size 变化补捕
      const st = statSync(this.path)
      if (st.mtimeMs !== this._loadMtime || st.size !== this._loadSize) {
        this._closeInner()
        this._loaded = this._load()
      }
    }
  }

  _closeInner() {
    if (this._db) {
      try { this._db.close() } catch {}
      this._db = null
    }
  }

  _scheduleExport() {
    if (this.readonly || !this._dirty) return
    if (this._exportTimer) clearTimeout(this._exportTimer)
    this._exportTimer = setTimeout(() => this.exportNow(), EXPORT_THROTTLE_MS)
    if (this._exportTimer.unref) this._exportTimer.unref()
  }

  exportNow() {
    if (this.readonly || this._closed) return
    if (this._exportTimer) { clearTimeout(this._exportTimer); this._exportTimer = null }
    if (!this._dirty || !this._db) return
    try {
      const data = this._db.export()
      const tmp = this.path + '.tmp'
      writeFileSync(tmp, Buffer.from(data))
      renameSync(tmp, this.path)
      this._dirty = false
      // r38-fix: mtime+size 同步更新——与 _load()/_checkReload 的 r36 双比较不变式一致。
      // 当前 writable 实例不跑只读侧 _checkReload 故无害；防止未来守卫变动后 _loadSize 失配误重载
      const st = statSync(this.path)
      this._loadMtime = st.mtimeMs
      this._loadSize = st.size
      // 审核补：成功后清零——否则历史一次失败导致每次 close 恒误告警（_lastExportError 是瞬时状态）
      this._lastExportError = null
    } catch (e) {
      // R12: 记录失败原因（dirty 保留，下次写仍会重试）——close 时据此显式告警，不静默丢数据
      this._lastExportError = { reason: e.message || String(e), at: Date.now() }
    }
  }

  // r35-fix: 每次调用重建 statement——sql.js 的 statement 一旦 free 不可复用，
  // 而调用方可能对同一 prepare 结果多次 get（better-sqlite3 语义）；对调用方透明
  prepare(sql) {
    return {
      get: (...params) => {
        this._checkReload()
        const st = this._db.prepare(sql)
        st.bind(params)
        if (!st.step()) { st.free(); return undefined }
        const row = st.getAsObject()
        st.free()
        return row
      },
      all: (...params) => {
        this._checkReload()
        const st = this._db.prepare(sql)
        st.bind(params)
        const rows = []
        while (st.step()) rows.push(st.getAsObject())
        st.free()
        return rows
      },
      run: (...params) => {
        this._checkReload()
        const st = this._db.prepare(sql)
        st.bind(params)
        st.step()
        st.free()
        if (isWriteSql(sql)) {
          this._dirty = true
          this._scheduleExport()
        }
        return { changes: this.getRowsModified(), lastInsertRowid: this._lastInsertRowid() }
      },
      iterate: (...params) => {
        this._checkReload()
        const st = this._db.prepare(sql)
        st.bind(params)
        const rows = []
        while (st.step()) rows.push(st.getAsObject())
        st.free()
        return rows[Symbol.iterator]()
      },
    }
  }

  get(sql, ...params) {
    this._checkReload()
    const st = this._db.prepare(sql)
    st.bind(params)
    if (!st.step()) { st.free(); return undefined }
    const row = st.getAsObject()
    st.free()
    return row
  }

  all(sql, ...params) {
    this._checkReload()
    const st = this._db.prepare(sql)
    st.bind(params)
    const rows = []
    while (st.step()) rows.push(st.getAsObject())
    st.free()
    return rows
  }

  run(sql, ...params) {
    this._checkReload()
    this._db.run(sql, ...params)
    if (isWriteSql(sql)) {
      this._dirty = true
      this._scheduleExport()
    }
    return { changes: this.getRowsModified(), lastInsertRowid: this._lastInsertRowid() }
  }

  getRowsModified() {
    try { return this._db.getRowsModified() } catch { return 0 }
  }

  _lastInsertRowid() {
    try {
      const st = this._db.prepare('SELECT last_insert_rowid() AS id')
      st.bind([])
      if (st.step()) { const v = st.getAsObject().id; st.free(); return v }
      st.free()
    } catch {}
    return 0
  }

  exec(sql) {
    this._checkReload()
    this._db.exec(sql)
    if (isWriteSql(sql)) {
      this._dirty = true
      this._scheduleExport()
    }
  }

  // better-sqlite3 语义：transaction(fn) 返回包装函数，调用时执行（db.transaction(fn)()）
  transaction(fn) {
    return (...args) => {
      if (this._inTxn > 0) {
        // 嵌套：SAVEPOINT 兜底
        this._inTxn++
        this._db.exec(`SAVEPOINT sp_${this._inTxn}`)
        try {
          const r = fn(...args)
          this._db.exec(`RELEASE sp_${this._inTxn}`)
          this._inTxn--
          return r
        } catch (e) {
          try { this._db.exec(`ROLLBACK TO sp_${this._inTxn}`); this._db.exec(`RELEASE sp_${this._inTxn}`) } catch {}
          this._inTxn--
          throw e
        }
      }
      this._inTxn = 1
      this._db.exec('BEGIN')
      try {
        const r = fn(...args)
        this._db.exec('COMMIT')
        this._inTxn = 0
        this._dirty = true
        this.exportNow()
        return r
      } catch (e) {
        try { this._db.exec('ROLLBACK') } catch {}
        this._inTxn = 0
        throw e
      }
    }
  }

  pragma(p) {
    this._checkReload()
    // R22-⑯：sql.js 后端支持 {simple:true}→返回单值（对齐 better-sqlite3），否则 FK 恒 OFF
    const simple = arguments.length > 1 && arguments[1]?.simple === true
    if (/integrity_check/i.test(p)) {
      try {
        const st = this._db.prepare(`PRAGMA ${p}`)
        st.bind([])
        const rows = []
        while (st.step()) rows.push(st.getAsObject())
        st.free()
        return rows
      } catch { return [{ integrity_check: 'error' }] }
    }
    if (simple) {
      // 对标 better-sqlite3 pragma(p, {simple:true})：执行 PRAGMA 并返回单值
      const st = this._db.prepare(`PRAGMA ${p}`)
      st.bind([])
      let val
      while (st.step()) { val = st.getAsObject(); break }
      st.free()
      return val ? Object.values(val)[0] : undefined
    }
    // R22-⑰（第四轮审核 P1）：非 simple 模式也返回数组（对齐 better-sqlite3 [{col: val}]）——
    // 否则 sql.js 后端 pragma('journal_mode') 返回 undefined，WAL/foreign_keys 是否生效不可验证
    {
      const st = this._db.prepare(`PRAGMA ${p}`)
      st.bind([])
      const rows = []
      while (st.step()) rows.push(st.getAsObject())
      st.free()
      return rows
    }
  }

  close() {
    if (this._closed) return
    // r35-fix: 先 export 再置 _closed（exportNow 会检查 _closed，旧顺序把落盘拦掉）
    if (!this.readonly && this._dirty) this.exportNow()
    // R12: close 时最后的 export 仍失败 → 显式告警（不静默 close 丢数据）
    if (!this.readonly && this._lastExportError) {
      console.error(`[db-adapter] close: last export failed (${this._lastExportError.reason}) — data may be lost on disk. Re-run the operation or restart.`)
    }
    this._closed = true
    this._closeInner()
    _sqlJsInstances.delete(this)
    this._releaseWriteLock()
  }

  get isSqlJs() { return true }
}

// ── 统一入口 ──
// r35：createDb 为 async（sql.js 后端 wasm 初始化异步）——
// better-sqlite3 路径直接返回原生实例（await 透传，行为不变）

export async function createDb(path, opts = {}) {
  if (detectBackend() === 'better-sqlite3') {
    const Database = _require('better-sqlite3')
    const db = new Database(path, opts)
    // r9(B5)：SQLite 并发参数——无 busy_timeout 时多工具并发写直接 SQLITE_BUSY 抛错；
    // WAL 允许读写并发（此前 rollback journal 下读会阻塞写、health integrity_check 与写交错）。
    // 注意：WAL 产生 -wal/-shm 伴生文件，health GC 清理 workspace 目录时整体删，无残留
    try { db.pragma('busy_timeout = 10000') } catch {}
    try { db.pragma('journal_mode = WAL') } catch {}
    return db
  }
  await initSqlJsOnce()
  return new SqlJsDb(path, opts)
}

export function getBackendName() {
  return detectBackend()
}
