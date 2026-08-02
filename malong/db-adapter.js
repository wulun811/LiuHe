// db-adapter.js — SQLite 双后端适配层（r35：沙盒分支产品）
// 完整版（默认）：better-sqlite3 直接透传原生实例——行为 100% 不变，零影响。
// 沙盒版（better-sqlite3 不可用 / Node ≥20 零依赖）：vendored sql.js（WASM 内存库）。
//   - 只读方：mtime 检测自动重载（写进程 export 后重读）
//   - 写方：脏标记 + 事务粒度 export + 500ms 节流合并，tmp+rename 原子写回
//   - pragma/transaction/get/all/run 返回形状对齐 better-sqlite3
import { existsSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs'
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
    this._loaded = this._load()
  }

  _load() {
    const SQL = _sqlJsInit
    if (this.path && existsSync(this.path)) {
      this._loadMtime = statSync(this.path).mtimeMs
      const data = new Uint8Array(readFileSync(this.path))
      this._db = new SQL.Database(data)
    } else {
      this._db = new SQL.Database()
      this._loadMtime = 0
    }
    // 只读方在事务里（BEGIN）时替换实例会丢事务状态——但重载只在查询前触发，
    // 查询前无未完成事务
    return true
  }

  _checkReload() {
    if (this.readonly && this.path && existsSync(this.path)) {
      const mtime = statSync(this.path).mtimeMs
      if (mtime !== this._loadMtime) {
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
      this._loadMtime = statSync(this.path).mtimeMs
    } catch {
      // 导出失败不崩——下次写仍会重试；tmp 残留由下次 rename 覆盖
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
    this._db.exec(`PRAGMA ${p}`)
    return undefined
  }

  close() {
    if (this._closed) return
    // r35-fix: 先 export 再置 _closed（exportNow 会检查 _closed，旧顺序把落盘拦掉）
    if (!this.readonly && this._dirty) this.exportNow()
    this._closed = true
    this._closeInner()
  }

  get isSqlJs() { return true }
}

// ── 统一入口 ──
// r35：createDb 为 async（sql.js 后端 wasm 初始化异步）——
// better-sqlite3 路径直接返回原生实例（await 透传，行为不变）

export async function createDb(path, opts = {}) {
  if (detectBackend() === 'better-sqlite3') {
    const Database = _require('better-sqlite3')
    return new Database(path, opts)
  }
  await initSqlJsOnce()
  return new SqlJsDb(path, opts)
}

export function getBackendName() {
  return detectBackend()
}
