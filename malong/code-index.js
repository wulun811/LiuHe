// 码龙 — 公共代码索引服务 (v2 P5.0)
// 多语言 Rust 解析服务，SQLite 存储符号/引用/依赖
// 详见：通天计划 §六 码龙

import { createDb } from './db-adapter.js'
import { join, relative, extname, resolve, dirname, sep } from 'node:path'
import { readFileSync, writeFileSync, existsSync, unlinkSync, renameSync, watch, chmodSync, statSync, mkdirSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import { createServer } from 'node:http'
import { DEFAULT_IGNORE_DIRS } from './file-collector.js'
import { scanCjsRequires } from './cjs-imports.js'
import { validateFilePath } from './error-codes.js'
import { resolveFileArg, normalizeFilePath } from './file-arg.js'
import { sha256 } from './hash-utils.js'
import { computeFileAnchors } from './symbol-anchors.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// r31-fix: Windows 下 relative() 返回反斜杠路径，DB 统一正斜杠（查询侧用 src/auth.py）
const toDbRel = (p) => p.replace(/\\/g, '/')

// r54(P0-6): LIKE 通配符注入——symbol 含 %/_ 时 `LIKE '%sym%'` 会整表匹配。转义特殊字符 + ESCAPE 子句。
const escapeLike = (s) => String(s).replace(/[\\%_]/g, (c) => '\\' + c)

// 13#1：提取器版本戳 = 二进制文件 sha256。二进制内容变（重新部署）→ 版本变 → 触发索引自愈。
// 路径解析与 mcp-server.js 的 PARSE_SERVICE_BIN / _ALT 对齐（primary 优先，dev 回退 target/release）。
export function resolveExtractorBin() {
  const candidates = [
    join(os.homedir(), '.local', 'bin', 'malong-parse'),
    join(__dirname, '..', 'malong-parse', 'target', 'release', 'malong-parse'),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
    if (process.platform === 'win32' && existsSync(c + '.exe')) return c + '.exe'
  }
  return null
}

export function extractorVersion(binPath = resolveExtractorBin()) {
  if (!binPath || !existsSync(binPath)) return 'unknown'
  try { return sha256(readFileSync(binPath)) } catch { return 'unknown' }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT UNIQUE NOT NULL,
  repo TEXT NOT NULL DEFAULT '',
  size INTEGER DEFAULT 0,
  mtime INTEGER DEFAULT 0,
  indexed_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS symbols (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('function','class','variable','method','export','import','interface','type')),
  signature TEXT DEFAULT '',
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL DEFAULT 0,
  parent_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS refs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  source_symbol_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
  target_file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
  target_symbol_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
  target_name TEXT DEFAULT '',
  kind TEXT NOT NULL CHECK(kind IN ('call','import','extends','implements','assign','use')),
  line INTEGER DEFAULT 0,
  call_expr TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sym_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_sym_file ON symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_sym_type ON symbols(type);
CREATE INDEX IF NOT EXISTS idx_sym_parent ON symbols(parent_id);
CREATE INDEX IF NOT EXISTS idx_ref_source ON refs(source_symbol_id);
CREATE INDEX IF NOT EXISTS idx_ref_target ON refs(target_symbol_id);
CREATE INDEX IF NOT EXISTS idx_ref_file ON refs(source_file_id);
CREATE INDEX IF NOT EXISTS idx_ref_name ON refs(target_name);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

// P2-C1：与 file-collector 的 DEFAULT_CACHED_EXT 对齐（旧缺 .ts/.tsx → outline-reader 对 .ts 永久 not_indexed）
// r28：补齐 .jsx/.mts/.cts + 新增 C/C++/Java/Bash（与 malong-parse ext_to_language 对齐）；.h/.hh 不入索引（大量 venv 头文件）
const CACHED_EXT = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts', '.py', '.go', '.rs', '.c', '.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx', '.java', '.sh', '.bash'])
// 15（P3）：CJS 解构别名 per-local import ref 的 call_expr 标记——模块级查询（dep_graph/
// getModuleGraph/getCallGraph/跨文件解析）必须排除，避免本地绑定名被当成模块依赖
const ALIAS_LOCAL_MARKER = '__alias__'
const WATCHER_DEBOUNCE = 300

// Rust stdlib/prelude/方法链噪声 callee（与 malong-parse rust_lang.rs 的 NOISE_CALLEES 对齐）。
// 提取器已在源头过滤；这里是安全网，兼容旧索引数据 + 查询期兜底。
const RUST_NOISE_CALLEES = new Set([
  'Ok', 'Err', 'Some', 'None',
  'map', 'map_err', 'map_or', 'map_or_else', 'and_then', 'or', 'or_else', 'or_default',
  'unwrap', 'unwrap_or', 'unwrap_or_else', 'unwrap_or_default', 'unwrap_unchecked',
  'expect', 'ok_or', 'ok_or_else', 'filter', 'filter_map', 'flat_map', 'flatten',
  'fold', 'collect', 'copied', 'cloned', 'enumerate', 'zip', 'chain', 'rev', 'take',
  'take_while', 'skip', 'skip_while', 'position', 'rposition', 'find', 'find_map', 'any',
  'all', 'count', 'sum', 'product', 'min', 'max', 'min_by', 'max_by', 'min_by_key',
  'max_by_key', 'sort', 'sort_by', 'sort_by_key', 'sort_unstable', 'sort_unstable_by',
  'dedup', 'dedup_by', 'partition', 'inspect', 'for_each', 'nth', 'next', 'peekable',
  'fuse', 'by_ref', 'step_by', 'cycle', 'reduce', 'scan', 'is_sorted',
  'into', 'as_str', 'as_bytes', 'as_mut', 'as_ref', 'as_deref', 'as_deref_mut', 'as_slice',
  'to_string', 'to_owned', 'to_vec', 'to_lowercase', 'to_uppercase', 'try_into', 'try_from',
  'into_iter', 'iter', 'iter_mut', 'chars', 'bytes', 'lines', 'from_utf8', 'from_str',
  'as_os_str', 'as_path', 'to_path_buf', 'to_str',
  'len', 'is_empty', 'capacity', 'push', 'push_str', 'pop', 'insert', 'remove', 'swap_remove',
  'contains', 'get', 'get_mut', 'get_key_value', 'first', 'last', 'clear', 'retain', 'drain',
  'extend', 'extend_from_slice', 'with_capacity', 'entry', 'or_insert', 'or_insert_with',
  'split', 'split_whitespace', 'split_terminator', 'rsplit', 'splitn', 'matches', 'trim',
  'trim_start', 'trim_end', 'trim_matches', 'replace', 'replacen', 'starts_with', 'ends_with',
  'parse', 'is_ascii', 'reserve', 'shrink_to_fit', 'truncate', 'resize', 'fill',
  'copy_from_slice', 'windows', 'chunks', 'chunks_exact', 'split_first', 'split_last',
  'split_at', 'join', 'concat', 'repeat', 'strip_prefix', 'strip_suffix', 'get_or_insert',
  'clone', 'drop', 'forget', 'swap', 'transmute', 'size_of', 'align_of', 'type_name', 'hash',
  'eq', 'ne', 'cmp', 'partial_cmp', 'is_some', 'is_none', 'is_ok', 'is_err', 'write', 'write_all',
  'read', 'read_to_string', 'read_exact', 'flush', 'lock', 'stdin', 'stdout', 'stderr',
])

function langOf(filePath) {
  const ext = extname(filePath || '').toLowerCase()
  if (ext === '.rs') return 'rust'
  if (ext === '.py') return 'python'
  if (ext === '.go') return 'go'
  if (ext === '.c' || ext === '.h') return 'c'
  if (ext === '.cpp' || ext === '.cc' || ext === '.cxx' || ext === '.hpp' || ext === '.hh' || ext === '.hxx') return 'cpp'
  if (ext === '.java') return 'java'
  if (ext === '.sh' || ext === '.bash') return 'bash'
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs' || ext === '.jsx') return 'javascript'
  if (ext === '.ts' || ext === '.tsx' || ext === '.mts' || ext === '.cts') return 'typescript'
  return 'other'
}

// JS/TS 视为同族（同生态，跨文件调用真实存在）；其余按自身语言。
function langFamily(lang) {
  return (lang === 'javascript' || lang === 'typescript') ? 'js-ts' : lang
}

function isNoiseCallee(name, lang) {
  return lang === 'rust' && RUST_NOISE_CALLEES.has(name)
}

// 多候选同名符号时，按 call_expr 的模块路径前缀对文件路径消歧。
// crate::hash::token_to_id -> 优先文件路径含 hash 的符号；无法判断则取首个。
function pickCandidate(candidates, callExpr, filePathMap) {
  if (candidates.length === 1) return candidates[0]
  const segs = (callExpr || '').split('::').map(s => s.trim()).filter(Boolean)
  const moduleSegs = segs.slice(0, -1).filter(s => s !== 'crate' && s !== 'self' && s !== 'super')
  for (let i = moduleSegs.length - 1; i >= 0; i--) {
    const seg = moduleSegs[i].toLowerCase()
    const hit = candidates.find(s => {
      const p = (filePathMap.get(s.file_id) || '').toLowerCase()
      return p.includes(`/${seg}.`) || p.includes(`/${seg}/`) || p.includes(`${seg}.rs`) || p.includes(`${seg}.py`) || p.includes(`${seg}.go`)
    })
    if (hit) return hit
  }
  return candidates[0]
}

const _exportRefCache = new Map()

// R19-②：查询出口附加 freshness——handler 层 attachStalenessWarning 输入源统一到服务层（删旧 checkFileStaleness 后提示不丢）。
// 只挂 auto_indexed 状态（方案：freshness: { auto_indexed: true } | null）；数组挂属性由 handler 透出（同 truncated 模式）。
function _attachFreshness(target, freshness) {
  if (!target || !freshness?.auto_indexed) return target
  target.freshness = { auto_indexed: true }
  return target
}
// r29：判定函数是否被「注册/导出形态」引用（对象字面量属性值、exports.name、export 列表）——
// refs 只记调用与 import，这些形态零 ref，detectDeadCode 需显式豁免以免误报死代码。
// 保守方向：宁可漏报（不报死代码）不可杀错（真删）。同文件缓存避免重复读盘。
function isExportReferenced(name, file) {
  if (!file || !name) return false
  let source = _exportRefCache.get(file)
  if (source === undefined) {
    // r29：file 已是调用方拼好的绝对路径（self._currentWorkspace + 相对路径），
    // 此处直接读——旧实现再 join(process.cwd(), file) 双重拼接读不到文件 → 过滤永不生效
    try { source = readFileSync(file, 'utf-8') } catch { source = null }
    if (source !== null) {
      if (_exportRefCache.size > 200) _exportRefCache.clear()
      _exportRefCache.set(file, source)
    }
  }
  if (source === null) return false
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // 只豁免「对象字面量属性值引用」（registerService/registerTool 回调挂载）：refs 零记录但语义上是活引用。
  // 导出形态（module.exports = { x } / exports.x = / export default x）不豁免——导出后无调用 = 死导出，
  // 该报（r14 断言：module.exports = { testIt } 的 testIt 必须报死代码）。
  return new RegExp(`:\\s*${esc}\\b`).test(source)
}

// r10d：getter/属性访问形态豁免——`foo.name` 属性读取（无括号）refs 不记录，但语义上是活使用。
// 与 isExportReferenced 共享 _exportRefCache（同文件内容）。保守方向：宁漏报不杀错。
function isPropertyAccessed(name, file) {
  if (!file || !name) return false
  let source = _exportRefCache.get(file)
  if (source === undefined) {
    // r29：file 已是调用方拼好的绝对路径，此处直接读（见 isExportReferenced 同注释）
    try { source = readFileSync(file, 'utf-8') } catch { source = null }
    if (source !== null) {
      if (_exportRefCache.size > 200) _exportRefCache.clear()
      _exportRefCache.set(file, source)
    }
  }
  if (source === null) return false
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\.\\s*${esc}\\b`).test(source)
}

// R22-㉒（ansible 真实项目实测）：函数作为值传递的形态 refs 不记录——
// `sys.excepthook = _ansible_excepthook`（赋值 RHS）与 `os.walk(..., onerror=handle_walk_errors)`（kwarg 值）
// 被误报死代码。与 isExportReferenced/isPropertyAccessed 同类豁免：源文件内形态检测，宁漏报不杀错。
// 排除形态：==/!=/<=/>= 比较（负向后瞻）；def 行（def name 前无 =）；注释/字符串内的偶然命中属漏报方向安全。
function isValueReferenced(name, file) {
  if (!file || !name) return false
  let source = _exportRefCache.get(file)
  if (source === undefined) {
    try { source = readFileSync(file, 'utf-8') } catch { source = null }
    if (source !== null) {
      if (_exportRefCache.size > 200) _exportRefCache.clear()
      _exportRefCache.set(file, source)
    }
  }
  if (source === null) return false
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // 赋值 RHS / kwarg 值：前字符不是比较符的 `= name`（kw=name 同样命中本模式）
  return new RegExp(`(?<![=!<>])\\s*=\\s*${esc}\\b`).test(source)
}

function _calcComplexity(sym) {
  const loc = Math.max(1, (sym.end_line || sym.start_line) - sym.start_line + 1)
  const cyclomatic = Math.min(10, Math.ceil(loc / 10))
  const cognitive = Math.min(10, Math.ceil(loc / 15))
  return {
    name: sym.name,
    type: sym.type,
    file: sym.file,
    linesOfCode: loc,
    cyclomaticComplexity: cyclomatic,
    cognitiveComplexity: cognitive,
    complexityScore: Math.min(10, Math.round((cyclomatic + cognitive) / 2)),
  }
}

async function initDb(dir) {
  const dbPath = join(dir, 'code-index.db')
  const db = await openHealthy(dbPath)
  if (!db || db.error) {
    // R10：openHealthy 失败（BUSY/损坏重建失败）→ 显式抛错，上层报错而非静默继续
    // 审核补：带 code——mcp-server 透出 service_unavailable（-32001）而非笼统 -32603
    const err = new Error(`DB unavailable (${db?.error || 'unknown'}): ${db?.message || 'open failed'}`)
    err.code = 'service_unavailable'
    throw err
  }
  db.pragma('journal_mode=WAL')
  db.pragma('synchronous=NORMAL')
  db.pragma('busy_timeout=5000')
  db.pragma('cache_size=-16384')
  db.pragma('mmap_size=67108864')
  db.pragma('temp_store=FILE')
  // r54(P0-5): 外键默认每连接 OFF——SCHEMA 声明的 ON DELETE CASCADE/SET NULL 从未生效，
  // 单文件重抽 DELETE symbols 后跨文件 refs.target_symbol_id 永久悬空 → impact 静默漏报。
  db.pragma('foreign_keys=ON')
  db.exec(SCHEMA)
  try { db.exec('ALTER TABLE refs ADD COLUMN line INTEGER DEFAULT 0') } catch (e) { if (!e.message?.includes('duplicate column')) console.error('[code-index] migration error:', e.message) }
  try { db.exec("ALTER TABLE refs ADD COLUMN call_expr TEXT DEFAULT ''") } catch (e) { if (!e.message?.includes('duplicate column')) console.error('[code-index] migration error:', e.message) }
  // 原语化 P1：版本锚点列（附录 C/E；parent_id/signature 已在 SCHEMA 建表）
  for (const [table, col] of [
    ['files', "content_hash TEXT DEFAULT ''"],
    ['files', "index_state TEXT DEFAULT 'fresh'"],
    ['symbols', "stable_id TEXT DEFAULT ''"],
    ['symbols', "body_hash TEXT DEFAULT ''"],
    ['symbols', "signature_hash TEXT DEFAULT ''"],
  ]) {
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col}`) } catch (e) { if (!e.message?.includes('duplicate column')) console.error('[code-index] migration error:', e.message) }
  }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_sym_stable ON symbols(stable_id)') } catch (e) { console.error('[code-index] migration error:', e.message) }
  return db
}

// R10：busy 错误判定——SQLITE_BUSY 或消息含 locked/busy（better-sqlite3 integrity_check 在并发写时抛）
function isBusyError(e) {
  return e?.code === 'SQLITE_BUSY' || /busy|database is locked/i.test(String(e?.message || ''))
}

// r35：openHealthy 走 db-adapter（better-sqlite3 完整版 / sql.js 沙盒版）
async function openHealthy(dbPath) {
  const attempt = async () => {
    // 7：锁冲突≠损坏——busy_timeout 5s 让并发进程的写锁先等再判，SQLITE_BUSY 不删库
    const db = await createDb(dbPath, { timeout: 5000 })
    try {
      const r = db.pragma('integrity_check')
      const ok = Array.isArray(r) && r.length === 1 && r[0]?.integrity_check === 'ok'
      if (!ok) throw new Error('integrity_check failed')
      return db
    } catch (e) {
      // pragma 抛错（如垃圾文件 "file is not a database"）也必须 close——Windows 上
      // 残留句柄会让后续 renameSync(.corrupt-*) 失败（EBUSY），重建便永远打不开
      db.close()
      throw e
    }
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  try {
    return await attempt()
  } catch (e) {
    // R10：busy ≠ 损坏——SQLITE_BUSY 重试 2 次（间隔 500ms），仍失败显式报错，绝不删库
    if (isBusyError(e)) {
      let last = e
      for (let i = 0; i < 2; i++) {
        await sleep(500)
        try { return await attempt() } catch (e2) { last = e2 }
      }
      if (isBusyError(last)) {
        return { db: null, error: 'BUSY', message: `DB busy after retries: ${last.message}` }
      }
      e = last
    }
    // 真损坏：rename 到 .corrupt-<ts> 留取证，再重建（旧实现直接 unlink，无取证）
    console.error(`[code-index] DB corrupt (${e.message}) — rebuilding: ${dbPath}`)
    const corruptPath = `${dbPath}.corrupt-${Date.now()}`
    for (const suffix of ['', '-wal', '-shm']) {
      try { renameSync(dbPath + suffix, corruptPath + suffix) } catch {}
    }
    const rebuilt = await createDb(dbPath)
    // R10：重建后必须验证——旧实现重建后不跑 integrity_check
    const r = rebuilt.pragma('integrity_check')
    const ok = Array.isArray(r) && r.length === 1 && r[0]?.integrity_check === 'ok'
    if (!ok) {
      rebuilt.close()
      return { db: null, error: 'CORRUPT', message: 'integrity_check failed after rebuild' }
    }
    return rebuilt
  }
}

class CodeIndex {
  constructor() {
    this._core = null
    this._db = null
    this._langParser = null
    this._indexing = false
    this._udsServer = null
    this._watcher = null
    this._watchedDir = null
    this._watcherTimer = null
    this._wsLock = Promise.resolve() // r54(P1): 串行化 workspace 初始化/切换，防并发交错 close 彼此的 db
    this._impactCache = new Map()
    this._contextCache = new Map()
    this._outlineCache = new Map()
    this._impactCacheMax = 200
    this._outlineCacheMax = 100
    this._contextCacheMax = 50
    this._touchedWorkspaces = new Set() // r9(F10/H12)：本进程初始化过的 workspace hash 集合（GC protect）
  }

  _resolveRepoDir(filePath) {
    if (this._watchedDir) return this._watchedDir
    let dir = filePath
    const lastSlash = dir.lastIndexOf('/')
    if (lastSlash > 0) dir = dir.slice(0, lastSlash)
    for (let i = 0; i < 5; i++) {
      if (existsSync(join(dir, '.git'))) return dir
      const parent = dir.lastIndexOf('/')
      if (parent <= 0) break
      dir = dir.slice(0, parent)
    }
    return null
  }

  async _initWorkspaceDb(workspaceDir) {
    // r54(P1): 串行化——并发多 workspace 首调/切换交错会 close 彼此的 db、查错库、泄漏连接
    const prev = this._wsLock
    let release
    this._wsLock = new Promise((r) => { release = r })
    await prev
    try {
      return await this._initWorkspaceDbLocked(workspaceDir)
    } finally {
      release()
    }
  }

  async _initWorkspaceDbLocked(workspaceDir) {
    const wsDir = this._core.getWorkspaceDir(workspaceDir)
    if (this._db && this._currentWorkspace === workspaceDir) {
      return // 已经初始化过
    }
    // 7：后台索引期间切换 workspace 会把 A 的文件写进 B 的库（第五轮 P0#8）。
    // 注：this._indexing（class 字段）——服务对象上的 indexing 存取器在此处不可见（之前用 this.indexing 恒 undefined，防护死代码）
    if (this._indexing && this._db && this._currentWorkspace !== workspaceDir) {
      throw new Error(`workspace switch to "${workspaceDir}" during background indexing of "${this._currentWorkspace}"; wait for indexing to finish or reindex with blocking=true`)
    }
    if (this._db) {
      // r52: close 后立即置 null——否则 await initDb 窗口内 watcher 触发的 indexFile 打到已关闭连接（'database is not open'），且 initDb 失败后 _db 残留已关闭对象 + _currentWorkspace 残留旧值 → 下次 initWorkspace(旧ws) 提前返回，永久损坏直到重启
      const oldDb = this._db
      this._db = null
      this._currentWorkspace = null
      oldDb.close()
    }
    this._db = await initDb(wsDir)
    this._currentWorkspace = workspaceDir
    // r9(F10/H12)：记录本进程初始化过的全部 workspace hash——启动 GC 只保护当前 ws 时，
    // 多会话共享 stateDir 的部署里 B 进程会把 A 进程刚打开（但 14 天无写入）的库删掉
    const wsHash = wsDir.split('/').pop() || null
    if (wsHash) this._touchedWorkspaces?.add(wsHash)
    // 13#4：开库自检提取器版本戳，陈旧（含首次无戳的既有库）→ 全量标 dirty，下次 reindex 自动重抽
    this._reconcileExtractorVersion()
    // 写入 metadata
    const metadataPath = join(wsDir, 'metadata.json')
    const metadata = {
      workspace_dir: workspaceDir,
      created_at: new Date().toISOString(),
      last_accessed: new Date().toISOString()
    }
    writeFileSync(metadataPath, JSON.stringify(metadata, null, 2))
  }

  // R19：新鲜度统一入口——查询出口接线，替代各 handler 各自调 checkFileStaleness。
  // 内置路径守卫（关键）：服务层方法不只有 handler 调用——code_search _executeIntent、
  // call_chain/inspect 内部直取 services 调 getCallers/getSymbols，这些内部链路不经 handler 的
  // validateFilePath；若不守卫，../ 经内部调用链触发自动索引写盘 → r54 P0-1 堵的逃逸面重新打开。
  // 守卫失败 → 不索引、返回 guarded（查询照走，安全——查询无写面）。
  async ensureFreshFile(filePath) {
    const wsDir = this._currentWorkspace
    if (!wsDir || !filePath) return { auto_indexed: false }
    const pathCheck = validateFilePath(filePath, wsDir)
    if (pathCheck.blocked) return { fresh: true, guarded: true }
    const absPath = join(wsDir, filePath)
    try {
      const realRoot = realpathSync(wsDir)
      const real = realpathSync(absPath)
      if (real !== realRoot && !real.startsWith(realRoot + sep)) {
        return { fresh: true, guarded: true }
      }
    } catch { /* 文件不存在/symlink 断裂 → 放行，mtime stat 会失败降级 */ }
    try {
      const diskMtime = statSync(absPath).mtimeMs
      const f = this._db.prepare('SELECT mtime FROM files WHERE path = ?').get(filePath)
      const indexedMtime = f ? f.mtime : 0
      // R11：两边取整比较（files.mtime 实际存 REAL 浮点 vs statSync 浮点）
      if (Math.round(diskMtime) !== Math.round(indexedMtime)) {
        try { this._contextCache.delete(absPath) } catch {}
        try {
          for (const key of this._outlineCache.keys()) {
            if (key.includes(`\0${filePath}\0`)) this._outlineCache.delete(key)
          }
          for (const key of this._impactCache.keys()) {
            if (key.includes(`\0${filePath}\0`)) this._impactCache.delete(key)
          }
        } catch {}
        try { _exportRefCache.delete(absPath) } catch {}
        try {
          const r = await this.indexFile(absPath, wsDir)
          // 审核修复：indexFile 对非代码文件返回 null——null 时不算 auto_indexed（避免误导标记）
          return { auto_indexed: r !== null }
        } catch {
          return { auto_indexed: false }
        }
      }
    } catch {}
    return { auto_indexed: false }
  }

  async indexFile(filePath, repo) {
    if (!CACHED_EXT.has(extname(filePath))) return null
    if (!this._db) {
      if (!repo) return null
      await this._initWorkspaceDb(repo)
    }
    // r54(P0-1): 沙箱逃逸兜底——relative() 产出 `..`/绝对路径说明 filePath 在 repo 外，
    // 拒绝索引（防 checkFileStaleness/ensureIndexed 自动索引读入并回显 workspace 外文件）
    if (repo) {
      const rp = toDbRel(relative(repo, filePath))
      if (rp.startsWith('..') || rp.startsWith('/')) return null
    }
    let size = 0
    try { size = statSync(filePath).size } catch { return null }
    if (size > 1024 * 1024) return null
    const ext = extname(filePath)
    const source = readFileSync(filePath, 'utf-8')
    const result = await this._langParser.extractAllAsync(source, ext, filePath, repo || undefined)
    if (!result) return null
    // r54(P1): extractAllAsync 可达数十秒——期间另一 workspace 的调用可能已切换 this._db。
    // 写入前校验库归属，不一致则放弃（防把 A 工作区文件写进 B 工作区的库）。
    if (repo && this._currentWorkspace !== repo) return null
    const { symbols = [], refs = [] } = result
    const relPath = repo ? toDbRel(relative(repo, filePath)) : filePath
    let mtime = Date.now()
    try { mtime = statSync(filePath).mtimeMs } catch {}
    // r28-fix：CJS require 扫描只对 CJS 文件有意义——对 C/Java/Bash 等新语言文件扫 require( 会误报 import
    const cjsImports = (ext === '.js' || ext === '.mjs' || ext === '.cjs') ? scanCjsRequires(source) : []
    const idx = this._db.transaction(() => {
      return this._indexFileDb(relPath, source.length, symbols, refs, mtime, sha256(source), cjsImports)
    })()
    if (idx) this._reindexDone()
    return idx
  }

  _reindexDone() {
    // 15（P0）：单文件重抽会 DELETE+重插本文件符号（id 全变），其他文件指向它的 ref 的
    // target_symbol_id 被外键 ON DELETE SET NULL 清空；indexFile 路径此前从不重 resolve →
    // impact/sweep/别名反查在「写后读」循环里静默失真。两个 resolve 都幂等（只绑未绑定的
    // ref），先按名解析再别名归位，顺序与 indexBatch 一致。
    this._resolveCrossFileRefs()
    this._resolveAliasedRefs()
  }

  _indexFileDb(relPath, sourceLength, symbols, refs, mtime, contentHash, cjsImports = [], skipCleanup = false) {
    let fileId = null
    const existing = this._db.prepare('SELECT id FROM files WHERE path = ?').get(relPath)
    if (existing) {
      fileId = existing.id
      if (!skipCleanup) {
        // 18：indexBatch 已在循环前批量清理（IN 一次删光），此处不再逐文件 DELETE
        this._db.prepare('DELETE FROM symbols WHERE file_id = ?').run(fileId)
        this._db.prepare('DELETE FROM refs WHERE source_file_id = ?').run(fileId)
      }
      this._db.prepare("UPDATE files SET size = ?, mtime = ?, content_hash = ?, index_state = 'fresh', indexed_at = datetime('now') WHERE id = ?").run(sourceLength, mtime, contentHash || '', fileId)
    }
    if (!fileId) {
      const r = this._db.prepare('INSERT OR IGNORE INTO files (path, repo, size, mtime, content_hash, index_state) VALUES (?, ?, ?, ?, ?, ?)').run(relPath, '', sourceLength, mtime, contentHash || '', 'fresh')
      fileId = r.lastInsertRowid
    }
    this._impactCache?.clear()
    this._contextCache?.clear()
    this._outlineCache?.clear()

    if (symbols.length > 0) {
      // 8：Rust parser 产出 const/enum/fn/impl/struct/trait 六种 kind，DB CHECK 约束只认 8 种
      // → 索引任何 .rs 文件必炸（dogfooding 当场抓到：索引 malong-parse 自身源码）。
      // 在 parser→storage 边界归一化，schema 保持稳定
      const KIND_MAP = { fn: 'function', const: 'variable', enum: 'class', impl: 'class', struct: 'class', trait: 'interface' }
      const SYM_BATCH = 180
      const symRows = symbols.flatMap(s => [fileId, s.name, KIND_MAP[s.type] || s.type, s.startLine, s.endLine])
      for (let i = 0; i < symRows.length; i += SYM_BATCH * 5) {
        const batch = symRows.slice(i, i + SYM_BATCH * 5)
        const ph = Array(batch.length / 5).fill('(?,?,?,?,?)').join(',')
        this._db.prepare(`INSERT INTO symbols (file_id, name, type, start_line, end_line) VALUES ${ph}`).run(...batch.flat())
      }
    }
    const insertedSyms = this._db.prepare('SELECT id, name, type, start_line, end_line FROM symbols WHERE file_id = ?').all(fileId)
    // 原语化 P1：索引/重抽时同步回填锚点（附录 D 写后一致性 + 附录 A stable_id）
    this._backfillFileAnchors(relPath, insertedSyms)
    const symIdMap = new Map(insertedSyms.map(s => [s.name, s.id]))
    const funcSyms = insertedSyms.filter(s => s.type === 'function' || s.type === 'method')

    const refRows = []
    for (const r of refs) {
      if (r.type === 'call') {
        const sep = r.name.includes('::') ? '::' : (r.name.includes('.') ? '.' : null)
        const callName = sep ? r.name.split(sep).pop().trim() : r.name
        const callExpr = sep ? r.name : ''
        let sourceSymId = null
        let bestRange = Infinity
        for (const fs of funcSyms) {
          if (fs.start_line <= r.line && r.line <= fs.end_line) {
            const range = fs.end_line - fs.start_line
            if (range < bestRange) { bestRange = range; sourceSymId = fs.id }
          }
        }
        refRows.push([fileId, sourceSymId, callName, 'call', r.line, callExpr])
      } else if (r.type === 'import') {
        refRows.push([fileId, null, r.module || '', 'import', r.line, ''])
        if (r.symbols && r.symbols.length > 0) {
          for (const symName of r.symbols) {
            refRows.push([fileId, null, symName, 'import', r.line, ''])
          }
        }
      } else if (r.type === 'use' || r.type === 'assign') {
        // Y002-S3：变量引用追踪（JS/TS spike）——模块级变量读写入 refs 表（schema 早支持，
        // 此前只填 call/import）；use/assign 不参与 unbound 误报流（L444 查询不含这两类）
        refRows.push([fileId, null, r.name, r.type, r.line, ''])
      }
    }
    // 14：CJS require() 补 import refs（Rust 解析器只认 ESM import）。
    // call_expr 存解构别名映射 {"本地名":"源名"}，供 _resolveAliasedRefs 反查 + 别名调用者归位。
    // 已存在的同模块同行 import ref（ESM 混用）不重复插入。
    if (cjsImports && cjsImports.length) {
      for (const ci of cjsImports) {
        if (refRows.some(r => r[3] === 'import' && r[2] === ci.module && r[4] === ci.line)) continue
        const aliasJson = ci.aliasMap && Object.keys(ci.aliasMap).length ? JSON.stringify(ci.aliasMap) : ''
        refRows.push([fileId, null, ci.module, 'import', ci.line, aliasJson])
        // 15（P3）：CJS 解构别名补 per-local import refs（对齐 ESM r.symbols 行为）。
        // references(symbol=本地名) 走 DB 命中 kind='import' 并绑定行标；
        // 同名字段下 _resolveCrossFileRefs 对同名本地变量会被 file_id 过滤跳过，不影响解析。
        if (ci.aliasMap) {
          for (const local of Object.keys(ci.aliasMap)) {
            if (!local) continue
            refRows.push([fileId, null, local, 'import', ci.line, ALIAS_LOCAL_MARKER])
          }
        }
      }
    }
    if (refRows.length > 0) {
      const BATCH_SIZE = 150
      for (let i = 0; i < refRows.length; i += BATCH_SIZE) {
        const batch = refRows.slice(i, i + BATCH_SIZE)
        const ph = batch.map(() => '(?,?,?,?,?,?)').join(',')
        this._db.prepare(`INSERT INTO refs (source_file_id, source_symbol_id, target_name, kind, line, call_expr) VALUES ${ph}`).run(...batch.flat())
      }
    }

    const updateRef = this._db.prepare('UPDATE refs SET target_symbol_id = ? WHERE id = ?')
    // Y002-S3：use/assign 也参与同文件绑定（变量读写 → target_symbol_id，references 可查）
    const namedRefs = this._db.prepare("SELECT id, target_name FROM refs WHERE source_file_id = ? AND target_symbol_id IS NULL AND target_name != '' AND kind IN ('call','use','assign')").all(fileId)
    for (const nr of namedRefs) {
      const symId = symIdMap.get(nr.target_name)
      if (symId) updateRef.run(symId, nr.id)
    }

    return { path: relPath, symbols: symbols.length, refs: refs.length }
  }

  _resolveCrossFileRefs() {
    // 21：只绑裸调用——成员调用（obj.slice()/byFile.get()）绝大多数是原生/库方法，
    // 跨文件绑同名符号只会制造噪声（slice→format.rs、get→test_impact.js 等误绑）。
    const unbound = this._db.prepare("SELECT r.id, r.source_file_id, r.target_name, r.call_expr FROM refs r WHERE r.target_symbol_id IS NULL AND r.kind IN ('call','import','extends','implements','use','assign') AND r.target_name != '' AND (r.call_expr IS NULL OR r.call_expr = '' OR r.call_expr NOT LIKE '%.%') AND (r.call_expr IS NULL OR r.call_expr != ?)").all(ALIAS_LOCAL_MARKER)
    if (!unbound.length) return 0
    const allSyms = this._db.prepare('SELECT s.id, s.name, s.file_id FROM symbols s').all()
    const symMap = new Map()
    for (const s of allSyms) {
      if (!symMap.has(s.name)) symMap.set(s.name, [])
      symMap.get(s.name).push(s)
    }
    const filePathMap = new Map(this._db.prepare('SELECT id, path FROM files').all().map(f => [f.id, f.path]))
    const updateRef = this._db.prepare('UPDATE refs SET target_symbol_id = ?, target_file_id = ? WHERE id = ?')
    let resolved = 0
    this._db.transaction(() => {
      for (const r of unbound) {
        const candidates = symMap.get(r.target_name)
        if (!candidates) continue
        const others = candidates.filter(s => s.file_id !== r.source_file_id)
        if (!others.length) continue
        const sym = pickCandidate(others, r.call_expr, filePathMap)
        updateRef.run(sym.id, sym.file_id, r.id)
        resolved++
      }
    })()
    return resolved
  }

  _resolveAliasedRefs() {
    // 14：CJS 解构别名反查——import ref 的 call_expr 存 {"本地名":"源名"}（scanCjsRequires 产出）。
    // 本文件里 target_name=本地名 的 call ref 原本被本地绑定到导入变量（如 libProcess→局部 var），
    // 这里重绑定到其他文件里的源符号（如 lib.js::process），让 impact_analysis 能反查到别名调用者。
    const aliasRows = this._db.prepare("SELECT r.source_file_id, r.call_expr FROM refs r WHERE r.kind = 'import' AND r.call_expr LIKE '{%'").all()
    if (!aliasRows.length) return 0
    let rebound = 0
    this._db.transaction(() => {
      for (const row of aliasRows) {
        let map
        try { map = JSON.parse(row.call_expr) } catch { continue }
        if (!map || typeof map !== 'object') continue
        for (const [local, original] of Object.entries(map)) {
          if (!local || !original) continue
          const target = this._db.prepare('SELECT id, file_id FROM symbols WHERE name = ? AND file_id != ? LIMIT 1').get(original, row.source_file_id)
          if (!target) continue
          const res = this._db.prepare(
            "UPDATE refs SET target_symbol_id = ?, target_file_id = ? WHERE source_file_id = ? AND target_name = ? AND kind = 'call'"
          ).run(target.id, target.file_id, row.source_file_id, local)
          rebound += res.changes
        }
      }
    })()
    return rebound
  }

  _isTestFile(filePath) {
    const lower = filePath.toLowerCase()
    if (lower.includes('__tests__/') || lower.includes('/tests/') || lower.includes('/test/') || lower.startsWith('tests/') || lower.startsWith('test/')) return true
    const base = lower.split('/').pop()
    return /^test[_-]./.test(base) || /[_-]test\./.test(base) || /\.test\./.test(base) || /\.spec\./.test(base) || /^test\.[^.]+$/.test(base)
  }

  _extractContext(filePath, line, window = 1) {
    if (!line || line <= 0) return null
    let absPath = filePath
    if (!absPath.startsWith('/')) absPath = join(this._currentWorkspace || '', filePath)
    try {
      if (!this._contextCache.has(absPath)) {
        if (this._contextCache.size >= this._contextCacheMax) {
          const oldest = this._contextCache.keys().next().value
          this._contextCache.delete(oldest)
        }
        this._contextCache.set(absPath, readFileSync(absPath, 'utf-8').split('\n'))
      }
      const lines = this._contextCache.get(absPath)
      const start = Math.max(0, line - 1 - window)
      const end = Math.min(lines.length, line + window)
      const ctx = lines.slice(start, end).join('\n')
      return ctx || null
    } catch {
      return null
    }
  }

  _calculateRisk(direct, tests, changeType) {
    const total = direct + tests
    if (changeType === 'delete') {
      if (total >= 3) return 'high'
      if (total >= 1) return 'medium'
    } else if (changeType === 'rename') {
      if (total >= 4) return 'high'
      if (total >= 1) return 'medium'
    } else {
      if (total >= 6) return 'high'
      if (total >= 2) return 'medium'
    }
    return 'low'
  }

  _extractDocstrings(filePath, symbols) {
    const absPath = this._currentWorkspace ? join(this._currentWorkspace, filePath) : filePath
    if (!existsSync(absPath)) return {}
    try {
      const content = readFileSync(absPath, 'utf-8')
      const lines = content.split('\n')
      const result = {}
      for (const sym of symbols) {
        if (sym.type !== 'function' && sym.type !== 'method' && sym.type !== 'class') continue
        const defLine = sym.start_line - 1
        for (let i = defLine + 1; i < Math.min(defLine + 5, lines.length); i++) {
          const t = lines[i].trim()
          if (!t) continue
          const m = t.match(/^(?:"""([\s\S]*?)"""|'''([\s\S]*?)'''|\/\*\*([\s\S]*?)\*\/)/)
          if (m) {
            const doc = (m[1] || m[2] || m[3] || '').trim().split('\n')[0].trim()
            if (doc) result[sym.start_line] = doc
          }
          break
        }
      }
      return result
    } catch {
      return {}
    }
  }

  _extractDecorators(filePath, symbols) {
    const absPath = this._currentWorkspace ? join(this._currentWorkspace, filePath) : filePath
    if (!existsSync(absPath)) return {}
    try {
      const content = readFileSync(absPath, 'utf-8')
      const lines = content.split('\n')
      const result = {}
      for (const sym of symbols) {
        if (sym.type !== 'function' && sym.type !== 'method' && sym.type !== 'class') continue
        const defLine = sym.start_line - 1
        const decorators = []
        for (let i = defLine - 1; i >= Math.max(0, defLine - 10); i--) {
          const t = lines[i].trim()
          if (!t) continue
          if (t.startsWith('@')) {
            decorators.unshift(t.slice(1).split('(')[0])
          } else {
            break
          }
        }
        if (decorators.length > 0) {
          result[sym.start_line] = decorators
        }
      }
      return result
    } catch {
      return {}
    }
  }

  _resolveRefDetail(sourceSymbolId) {
    if (!sourceSymbolId) return { line: 0, func: null }
    const row = this._db.prepare('SELECT name, type, start_line FROM symbols WHERE id = ?').get(sourceSymbolId)
    if (!row) return { line: 0, func: null }
    return {
      line: row.start_line,
      func: (row.type === 'function' || row.type === 'method') ? row.name : null,
    }
  }

  _findIndirectCallers(symbolName, maxDepth, excludeFile) {
    const direct = excludeFile
      ? this._db.prepare("SELECT DISTINCT r.source_symbol_id, f.path AS caller_file, s.name AS caller_func FROM refs r JOIN files f ON r.source_file_id = f.id LEFT JOIN symbols s ON r.source_symbol_id = s.id WHERE r.target_name = ? AND r.kind = 'call' AND f.path != ? AND r.source_symbol_id IS NOT NULL").all(symbolName, excludeFile)
      : this._db.prepare("SELECT DISTINCT r.source_symbol_id, f.path AS caller_file, s.name AS caller_func FROM refs r JOIN files f ON r.source_file_id = f.id LEFT JOIN symbols s ON r.source_symbol_id = s.id WHERE r.target_name = ? AND r.kind = 'call' AND r.source_symbol_id IS NOT NULL").all(symbolName)

    const visited = new Set(direct.map(d => d.source_symbol_id))
    let queue = direct.map(d => ({ symId: d.source_symbol_id, func: d.caller_func, file: d.caller_file }))

    const results = []
    for (let d = 2; d <= maxDepth; d++) {
      const nextQueue = []
      for (const { symId, func: funcName } of queue) {
        const higher = this._db.prepare("SELECT DISTINCT f.path AS caller_file, s.name AS caller_func, r.line AS caller_line, r.source_symbol_id AS higher_sym_id FROM refs r JOIN files f ON r.source_file_id = f.id LEFT JOIN symbols s ON r.source_symbol_id = s.id WHERE r.target_symbol_id = ? AND r.kind = 'call'").all(symId)
        for (const h of higher) {
          results.push({ file: h.caller_file, function: h.caller_func, line: h.caller_line || 0, depth: d, via: funcName })
          if (h.higher_sym_id && !visited.has(h.higher_sym_id)) {
            visited.add(h.higher_sym_id)
            nextQueue.push({ symId: h.higher_sym_id, func: h.caller_func, file: h.caller_file })
          }
        }
      }
      queue = nextQueue
      if (!queue.length) break
    }
    return results
  }

  _findCallees(symId, sourceFilePath, contextMode = 'snippet') {
    if (!symId) return []
    const rows = this._db.prepare(
      "SELECT r.target_name, r.target_symbol_id, r.target_file_id, r.line, r.call_expr, " +
      "f2.path AS target_file_path " +
      "FROM refs r " +
      "LEFT JOIN files f2 ON r.target_file_id = f2.id " +
      "WHERE r.source_symbol_id = ? AND r.kind = 'call'"
    ).all(symId)

    // r22：裸调用跨文件绑定可能猜错——查 source 文件是否真的 import 了该符号
    const srcFile = sourceFilePath ? this._db.prepare('SELECT id FROM files WHERE path = ?').get(sourceFilePath) : null
    const srcFileId = srcFile?.id
    const hasImportBinding = (targetName, calleeFile) => {
      if (!srcFileId) return false
      // ① 符号级 import ref（ESM symbols / CJS per-local）：target_name = 符号名
      const byName = this._db.prepare(
        "SELECT 1 FROM refs WHERE source_file_id = ? AND kind = 'import' AND target_name = ? LIMIT 1"
      ).get(srcFileId, targetName)
      if (byName) return true
      // ② 模块级 import ref（target_name = './lib3.js'）：与 callee 文件基名匹配
      if (calleeFile) {
        const base = calleeFile.split('/').pop().replace(/\.[^.]+$/, '')
        const byModule = this._db.prepare(
          "SELECT 1 FROM refs WHERE source_file_id = ? AND kind = 'import' AND target_name LIKE ? LIMIT 1"
        ).get(srcFileId, `%${base}%`)
        if (byModule) return true
      }
      return false
    }

    const callees = []
    const seen = new Set()
    const calleeLang = langOf(sourceFilePath)
    for (const r of rows) {
      if (isNoiseCallee(r.target_name, calleeLang)) continue
      const key = `${r.target_name}\0${r.line || 0}`
      if (seen.has(key)) continue
      seen.add(key)

      let calleeFile = r.target_file_path || null
      let calleeLine = 0
      if (r.target_symbol_id) {
        const ts = this._db.prepare('SELECT start_line, file_id FROM symbols WHERE id = ?').get(r.target_symbol_id)
        if (ts) {
          calleeLine = ts.start_line
          if (!calleeFile) {
            const cf = this._db.prepare('SELECT path FROM files WHERE id = ?').get(ts.file_id)
            if (cf) calleeFile = cf.path
          }
        }
      }

      // 裸调用（非成员访问）且解析到跨文件同名符号、source 又没 import 它 → 同名猜测，标 ambiguous
      const isMemberCall = !!(r.call_expr || '').includes('.')
      const isCrossFile = calleeFile && calleeFile !== sourceFilePath
      const ambiguous = !isMemberCall && isCrossFile && !hasImportBinding(r.target_name, calleeFile)

      callees.push({
        function: r.target_name,
        file: sourceFilePath,
        line: r.line || 0,
        call_expr: r.call_expr || '',
        // Y002-S4：callees context 同样受 contextMode 约束（none → null，不读文件省 token）
        context: contextMode === 'none' ? null : this._extractContext(sourceFilePath, r.line || 0),
        callee_file: calleeFile,
        callee_line: calleeLine,
        resolved: !!r.target_symbol_id,
        ambiguous,
      })
    }
    return callees
  }

  async walkAndIndex(dir, rootDir) {
    const { readdirSync } = await import('node:fs')
    const { join: joinPath } = await import('node:path')
    const files = []
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const full = joinPath(d, e.name)
        if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '.git' && !e.name.startsWith('.')) walk(full) }
        else if (CACHED_EXT.has(extname(e.name))) files.push(full)
      }
    }
    walk(rootDir || dir)
    return this.indexBatch(files, rootDir || dir)
  }

  async indexBatch(filePaths, repo, onProgress) {
    const validFiles = filePaths.filter(fp => CACHED_EXT.has(extname(fp)))
    if (!validFiles.length) return []

    const existingFiles = new Map(this._db.prepare('SELECT path, mtime, index_state FROM files').all().map(f => [f.path, { mtime: f.mtime, state: f.index_state }]))
    const changedFiles = []
    const mtimeMap = new Map()
    const currentPaths = new Set()
    for (const fp of validFiles) {
      const relPath = repo ? toDbRel(relative(repo, fp)) : fp
      currentPaths.add(relPath)
      let st
      try { st = statSync(fp) } catch { continue }
      const old = existingFiles.get(relPath)
      // 13#3：dirty 文件（提取器升级自检标记 / force 重抽）无视 mtime 必重抽；否则按 mtime 增量
      // R11：`!==` 而非 `>=`——与读侧 staleness 判定一致，mtime 回退（checkout/rsync）同样触发重抽。
      // 注意：files.mtime 实际存 REAL（SQLite 浮点亲和），statSync.mtimeMs 也是浮点——两边取整比较，否则永不相等恒重抽
      if (old && old.state !== 'dirty' && Math.round(old.mtime) === Math.round(st.mtimeMs)) continue
      // R22-⑯：与 indexFile:455 上限对齐——>1MB 不索引（旧 indexBatch 无门，>1MB 文件 reindex 后可入索引但单文件重抽永不刷新，两套判定分裂）
      if (st.size > 1024 * 1024) continue
      changedFiles.push(fp)
      mtimeMap.set(relPath, st.mtimeMs)
    }

    const deletedIds = this._db.prepare('SELECT id, path FROM files').all().filter(f => !currentPaths.has(f.path)).map(f => f.id)

    if (!changedFiles.length && !deletedIds.length) {
      if (onProgress) onProgress(0, 0)
      return []
    }

    const totalChanges = changedFiles.length + deletedIds.length
    const rebuildIndexes = totalChanges > 20
    console.error(`[code-index] incremental: ${changedFiles.length} changed, ${deletedIds.length} deleted, ${validFiles.length - changedFiles.length} unchanged skipped, rebuildIndexes=${rebuildIndexes}`)

    this._db.pragma('synchronous=OFF')
    if (rebuildIndexes) {
      this._db.exec('DROP INDEX IF EXISTS idx_sym_name; DROP INDEX IF EXISTS idx_sym_file; DROP INDEX IF EXISTS idx_sym_type; DROP INDEX IF EXISTS idx_sym_parent; DROP INDEX IF EXISTS idx_ref_source; DROP INDEX IF EXISTS idx_ref_target; DROP INDEX IF EXISTS idx_ref_file; DROP INDEX IF EXISTS idx_ref_name')
    }
    const t0 = Date.now()
    try {
      if (deletedIds.length) {
        this._db.transaction(() => {
          for (const id of deletedIds) {
            this._db.prepare('DELETE FROM symbols WHERE file_id = ?').run(id)
            this._db.prepare('DELETE FROM refs WHERE source_file_id = ?').run(id)
            this._db.prepare('DELETE FROM files WHERE id = ?').run(id)
          }
        })()
      }

      // 18（r8 重排）：清理逻辑已移到 parse 之后、insert 之前（见 insert 段）——
      // 旧实现「先删后插」：parse 窗口（可达数十秒）内读工具拿到被清空的索引（E3 竞态）。

      let parsed = []
      let parseErrorCount = 0
      if (changedFiles.length) {
        const BATCH_SIZE = 50
        parsed = []
        for (let i = 0; i < changedFiles.length; i += BATCH_SIZE) {
          const chunk = changedFiles.slice(i, i + BATCH_SIZE)
          const files = chunk.map(fp => ({ path: toDbRel(relative(repo, fp)), file_path: fp }))
          const results = await this._langParser.batchExtractAsync(files, repo)
          const statMap = new Map()
          for (const fp of chunk) {
            try { statMap.set(fp, statSync(fp)) } catch {}
          }
          for (const r of results) {
            if (r.error) {
              // r11(M4)：parse 错误计数——旧实现只打 stderr（MCP 场景不可见），reindex 结果聚合透出
              parseErrorCount++
              console.error(`[code-index] batch parse error for ${r.path}: ${r.error}`)
              continue
            }
            const st = statMap.get(join(repo, r.path)) || statMap.get(r.path)
            let src = null
            try { src = readFileSync(st ? join(repo, r.path) : r.path) } catch {}
            parsed.push({
              relPath: r.path,
              sourceLength: st?.size || 0,
              symbols: r.symbols || [],
              refs: r.refs || [],
              cjsImports: src ? scanCjsRequires(src.toString()) : [],
              contentHash: src ? sha256(src) : null,
            })
            this._lastParseErrors = parseErrorCount
          }
          if (i + BATCH_SIZE < changedFiles.length) await new Promise(r => setImmediate(r))
        }
        console.error(`[code-index] parse: ${parsed.length}/${changedFiles.length} files in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
      }

      // 18（r8 重排）：parse 完成后才清理 changed 文件的旧 symbols/refs——两个坑（均实测）：
      // ① DROP 索引后逐文件 DELETE WHERE file_id=? 是 N×全表扫描（318 文件 × 26084 refs = 52s）
      // ② 批量 DELETE symbols 触发外键 ON DELETE SET NULL 逐符号级联全扫（10768 syms × 全扫 = 6s）
      // 正解：关外键 → IN 批量一次删光（单次全扫）→ UPDATE 清悬空引用（单次全扫，_resolveCrossFileRefs 幂等重绑）
      // r8(F7)：清理事务内同标 dirty——崩溃在删后插前 → 残留 dirty 下次增量必重抽（不再永久索引空洞）
      if (changedFiles.length) {
        const CLEAN_BATCH = 400
        const relPaths = changedFiles.map(fp => toDbRel(relative(repo, fp)))
        for (let i = 0; i < relPaths.length; i += CLEAN_BATCH) {
          const rels = relPaths.slice(i, i + CLEAN_BATCH)
          const ph = rels.map(() => '?').join(',')
          const ids = this._db.prepare(`SELECT id FROM files WHERE path IN (${ph})`).all(...rels).map(f => f.id)
          if (!ids.length) continue
          const ph2 = ids.map(() => '?').join(',')
          const fkOn = this._db.pragma('foreign_keys', { simple: true })
          this._db.pragma('foreign_keys = OFF')
          this._db.transaction(() => {
            this._db.prepare(`DELETE FROM refs WHERE source_file_id IN (${ph2})`).run(...ids)
            this._db.prepare(`DELETE FROM symbols WHERE file_id IN (${ph2})`).run(...ids)
            this._db.prepare(`UPDATE files SET index_state = 'dirty', content_hash = '' WHERE id IN (${ph2})`).run(...ids)
          })()
          this._db.prepare('UPDATE refs SET target_symbol_id = NULL, target_file_id = NULL WHERE target_symbol_id NOT IN (SELECT id FROM symbols) AND target_symbol_id IS NOT NULL').run()
          this._db.pragma(`foreign_keys = ${fkOn ? 'ON' : 'OFF'}`)
        }
      }

      const CHUNK = 200
      const results = []
      for (let i = 0; i < parsed.length; i += CHUNK) {
        const chunk = parsed.slice(i, i + CHUNK)
        // r8(F6/F12)：parse 期间文件被改 → 丢弃陈旧解析结果并标 dirty——
        // 防止旧符号插入（与写后同步 indexFile 的新行形成同 stable_id 重复行），且下次增量必重抽
        const freshChunk = []
        for (const p of chunk) {
          let changed = false
          try {
            const st = statSync(join(repo, p.relPath))
            if (st.mtimeMs !== mtimeMap.get(p.relPath)) changed = true
          } catch { changed = true }
          if (changed) {
            try { this._db.prepare("UPDATE files SET index_state = 'dirty', content_hash = '' WHERE path = ?").run(p.relPath) } catch {}
            continue
          }
          freshChunk.push(p)
        }
        if (freshChunk.length === 0) continue
        const txResults = this._db.transaction(() => {
          const r = []
          for (const p of freshChunk) r.push(this._indexFileDb(p.relPath, p.sourceLength, p.symbols, p.refs, mtimeMap.get(p.relPath) || Date.now(), p.contentHash, p.cjsImports, true))
          return r
        })()
        results.push(...txResults)
        if (onProgress) onProgress(Math.min(i + CHUNK, parsed.length), parsed.length)
        if (i + CHUNK < parsed.length) await new Promise(r => setImmediate(r))
      }
      console.error(`[code-index] insert: ${parsed.length} files in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
      if (typeof global.gc === 'function') global.gc()
      const resolved = this._resolveCrossFileRefs()
      const rebounded = this._resolveAliasedRefs()
      console.error(`[code-index] resolve: ${resolved} refs in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
      if (rebounded > 0) console.error(`[code-index] aliased: ${rebounded} refs rebound`)
      return results
    } finally {
      if (rebuildIndexes) {
        this._db.exec('CREATE INDEX IF NOT EXISTS idx_sym_name ON symbols(name); CREATE INDEX IF NOT EXISTS idx_sym_file ON symbols(file_id); CREATE INDEX IF NOT EXISTS idx_sym_type ON symbols(type); CREATE INDEX IF NOT EXISTS idx_sym_parent ON symbols(parent_id); CREATE INDEX IF NOT EXISTS idx_ref_source ON refs(source_symbol_id); CREATE INDEX IF NOT EXISTS idx_ref_target ON refs(target_symbol_id); CREATE INDEX IF NOT EXISTS idx_ref_file ON refs(source_file_id); CREATE INDEX IF NOT EXISTS idx_ref_name ON refs(target_name)')
      }
      this._db.pragma('synchronous=NORMAL')
      console.error(`[code-index] ${rebuildIndexes ? 'indexes rebuilt' : 'indexes kept'}, total ${((Date.now() - t0) / 1000).toFixed(1)}s`)
    }
  }

  async init(core) {
    this._core = core
    this._langParser = core.getService('langParser')
    if (!this._langParser) throw new Error('[code-index] lang-parser service required but not registered')
    // 延迟初始化数据库，等待 workspace_dir 参数
    this._db = null
    this._currentWorkspace = null

    const self = this

    // 初始化指定 workspace 的数据库（委托 class 方法，保证 indexFile 懒初始化路径一致）
    async function initWorkspaceDb(workspaceDir) {
      await self._initWorkspaceDb(workspaceDir)
    }

    async function doSyncFileChange(filePath) {
      if (!existsSync(filePath)) {
        const relPath = self._watchedDir ? toDbRel(relative(self._watchedDir, filePath)) : filePath
        const matched = self._db.prepare('SELECT id FROM files WHERE path = ?').get(relPath)
        if (matched) {
          self._db.prepare('DELETE FROM symbols WHERE file_id = ?').run(matched.id)
          self._db.prepare('DELETE FROM refs WHERE source_file_id = ?').run(matched.id)
          self._db.prepare('DELETE FROM files WHERE id = ?').run(matched.id)
          self._reindexDone()
        }
        if (self._core.emit) self._core.emit('file.changed', { path: filePath, type: 'deleted' })
        return { path: relPath, status: 'deleted' }
      }
      const repo = self._watchedDir || self._resolveRepoDir(filePath)
      const result = await self.indexFile(filePath, repo)
      if (result) self._core.log('info', `[code-index] synced: ${result.path} (${result.symbols} syms)`)
      if (self._core.emit) self._core.emit('file.changed', { path: filePath })
      return result
    }

    // 启动文件监听器（增量索引）
    function startWatcher(dir) {
      self._watchedDir = dir
      if (!existsSync(dir)) return
      const pendingChanges = new Set()
      try {
        self._watcher = watch(dir, { recursive: true }, (eventType, filename) => {
          if (!filename) return
          const ext = extname(filename)
          if (!CACHED_EXT.has(ext)) return
          const parts = filename.split(/[\\/]/)
          if (parts.some(p => DEFAULT_IGNORE_DIRS.has(p))) return
          pendingChanges.add(filename)
          if (self._watcherTimer) clearTimeout(self._watcherTimer)
          self._watcherTimer = setTimeout(() => {
            const files = Array.from(pendingChanges)
            pendingChanges.clear()
            for (const f of files) {
              const fullPath = join(dir, f)
              if (existsSync(fullPath)) {
                // 7：fire-and-forget 必须 .catch——parse 服务抖动时 unhandled rejection 直接崩整个 MCP 进程
                doSyncFileChange(fullPath).catch((e) => {
                  self._core.log('warn', `[code-index] watcher sync failed for ${fullPath}: ${e.message}`)
                })
              }
            }
          }, WATCHER_DEBOUNCE)
        })
        self._watcher.on('error', (err) => {
          self._core.log('warn', `[code-index] watcher error (${err.code || err.message}) — disabling watch to avoid crash`)
          try { self._watcher.close() } catch {}
          self._watcher = null
        })
        self._core.log('info', `[code-index] watching ${dir}`)
      } catch (e) {
        self._core.log('warn', `[code-index] watch failed: ${e.message}`)
      }
    }

    core.registerService('codeIndex', {
      // 初始化 workspace（供 handler 调用）
      async initWorkspace(workspaceDir) {
        await initWorkspaceDb(workspaceDir)
        if (!self._watcher || self._watchedDir !== resolve(workspaceDir)) {
          if (self._watcher) { self._watcher.close(); self._watcher = null }
          // r52: 切换时清防抖 timer——旧 timer 触发时 _watchedDir 已指向新 workspace，会把旧 workspace 文件以 ../../ 相对路径写进新库（跨库污染，P0#8 同根因漏网）
          if (self._watcherTimer) { clearTimeout(self._watcherTimer); self._watcherTimer = null }
          startWatcher(resolve(workspaceDir))
        }
        return { workspace_dir: workspaceDir, db_path: join(core.getWorkspaceDir(workspaceDir), 'code-index.db') }
      },

      // r8(F11)：当前在用工作区的缓存 hash——health(cleanup) 用它保护不被 GC 误删
      getCurrentWorkspaceHash() {
        if (!self._currentWorkspace) return null
        return core.getWorkspaceDir(self._currentWorkspace).split('/').pop() || null
      },

      // r9(F10/H12)：本进程初始化过的全部 workspace hash（GC protect 列表）
      getTouchedWorkspaceHashes() {
        return [...(self._touchedWorkspaces || [])]
      },

      // 索引单个文件（供 reindex handler 调用）
      async indexFile(filePath, repo) {
        return await self.indexFile(filePath, repo)
      },

      // 16：file 参数共用守卫（供 handler 预检 + 路径归一化）
      resolveFileArg(rawFile) {
        return resolveFileArg({ db: self._db, workspaceDir: self._currentWorkspace, file: rawFile })
      },

      // 解析跨文件引用（供 reindex handler 调用）
      resolveCrossFileRefs() {
        self._resolveCrossFileRefs()
        self._resolveAliasedRefs()
        return { status: 'ok' }
      },

      async indexBatch(filePaths, repo, onProgress) {
        return self.indexBatch(filePaths, repo, onProgress)
      },

      // 13#5：force 重抽——全量标 dirty（供 reindex force=true 调用）
      markAllDirty() {
        return self.markAllDirty()
      },

      // 13#4：手动触发提取器版本自检（currentVer 可注入；默认当前二进制 sha256）
      reconcileExtractorVersion(currentVer) {
        return self._reconcileExtractorVersion(currentVer)
      },

      // 索引状态（供 reindex handler 调用）
      get indexing() {
        return self._indexing
      },

      set indexing(value) {
        self._indexing = value
        if (!value) {
          self._indexProgress = null
          if (self._db) {
            const stats = {
              workspace_dir: self._currentWorkspace,
              files: self._db.prepare('SELECT COUNT(*) as cnt FROM files').get().cnt,
              symbols: self._db.prepare('SELECT COUNT(*) as cnt FROM symbols').get().cnt,
              refs: self._db.prepare('SELECT COUNT(*) as cnt FROM refs').get().cnt,
              // r11(M4)：本次索引 parse 失败文件数（超时/病态语法）——reindex 结果聚合透出
              parse_errors: self._lastParseErrors || 0,
              completed_at: new Date().toISOString(),
            }
            self._lastIndexed = stats
          }
        }
      },

      // 索引进度（供 reindex handler 查询）
      _indexProgress: null,
      get indexProgress() {
        return self._indexProgress
      },
      set indexProgress(value) {
        self._indexProgress = value
      },

      // 上次索引完成记录（供 reindex handler 查询）
      _lastIndexed: null,
      get lastIndexed() {
        return self._lastIndexed
      },

      async getSymbols(filePath, { timeout = 5000 } = {}) {
        const freshness = await self.ensureFreshFile(filePath)
        const f = self._db.prepare('SELECT id FROM files WHERE path = ?').get(filePath)
        if (!f) return []
        return _attachFreshness(self._db.prepare('SELECT name, type, start_line, end_line FROM symbols WHERE file_id = ? ORDER BY start_line').all(f.id), freshness)
      },

      // r10e：按符号名查全仓顶层定义（parent_id IS NULL）——fix_imports findCandidates 用它区分
      // 「真·可导入模块符号」与「别文件里的局部变量巧合同名」（旧 getReferences 使用点当候选 → from x import v 荒谬建议）
      async findDefinitions(symbol, { limit = 20 } = {}) {
        return self._db.prepare('SELECT s.name, s.type, s.start_line, f.path FROM symbols s JOIN files f ON s.file_id = f.id WHERE s.name = ? AND s.parent_id IS NULL AND s.type IN (\'function\',\'class\',\'variable\') ORDER BY s.start_line LIMIT ?').all(symbol, limit)
      },

      async getReferences(symbol, filePath, { timeout = 5000, limit = 500 } = {}) {
        let freshness = null
        if (filePath) freshness = await self.ensureFreshFile(filePath)
        const pat = `%${escapeLike(symbol)}%`
        // R17-1：多取 1 条检测截断——LIMIT 静默截断会让 LLM 误以为就这么点引用
        let rows
        if (filePath) {
          const f = self._db.prepare('SELECT id FROM files WHERE path = ?').get(filePath)
          if (!f) return []
          rows = self._db.prepare("SELECT f.path, r.kind, r.target_name, r.line FROM refs r JOIN files f ON r.source_file_id = f.id WHERE r.source_file_id = ? AND (r.target_name = ? OR r.target_name LIKE ? ESCAPE '\\') LIMIT ?").all(f.id, symbol, pat, limit + 1)
        } else {
          rows = self._db.prepare("SELECT f.path, r.kind, r.target_name, r.line FROM refs r JOIN files f ON r.source_file_id = f.id WHERE (r.target_name = ? OR r.target_name LIKE ? ESCAPE '\\') LIMIT ?").all(symbol, pat, limit + 1)
        }
        const truncated = rows.length > limit
        const out = truncated ? rows.slice(0, limit) : rows
        if (truncated) out.truncated = true
        return _attachFreshness(out, freshness)
      },

      async classifyMessage(content, { timeout = 3000 } = {}) {
        return await self._langParser.classifyMessageAsync(content)
      },

      async extractSymbols(content, { timeout = 3000 } = {}) {
        const result = await self._langParser.extractAllAsync(content, '.js')
        if (!result) return { symbols: [], imports: [], hasErrors: false }
        return { symbols: result.symbols || [], imports: result.refs?.filter(r => r.type === 'import') || [], hasErrors: result.hasErrors || false }
      },

      async getSemanticDensity(content, { timeout = 3000 } = {}) {
        try {
          const result = await self._langParser.extractAllAsync(content, '.js')
          if (result && result.symbols) {
            const nodeCount = result.symbols.length + (result.refs?.length || 0)
            const density = Math.min(1, nodeCount / 50)
            return { density: Math.round(density * 100) / 100, nodeCount }
          }
        } catch {}
        return { density: 0, nodeCount: 0 }
      },

      async searchSymbols(query, { limit = 30 } = {}) {
        if (!query || query.length < 1) return []
        // R7：LIKE 通配符转义——`_`/`%` 变字面量（对齐 getReferences），防全表命中
        const pat = `%${escapeLike(query)}%`
        return self._db.prepare("SELECT s.name, s.type, s.start_line, s.end_line, f.path AS file FROM symbols s JOIN files f ON s.file_id = f.id WHERE s.name LIKE ? ESCAPE '\\' ORDER BY s.name LIMIT ?").all(pat, limit)
      },

      async getCallers(symbolName, { filePath } = {}) {
        let freshness = null
        if (filePath) freshness = await self.ensureFreshFile(filePath)
        if (filePath) {
          const f = self._db.prepare('SELECT id FROM files WHERE path = ?').get(filePath)
          if (!f) return []
          return _attachFreshness(self._db.prepare("SELECT r.target_name AS callee, r.target_symbol_id, f2.path AS target_file, r.line FROM refs r JOIN files f ON r.source_file_id = f.id LEFT JOIN files f2 ON r.target_file_id = f2.id WHERE r.source_file_id = ? AND r.kind = 'call' AND r.target_name = ?").all(f.id, symbolName), freshness)
        }
        return self._db.prepare("SELECT f.path AS caller_file, r.target_name AS callee, r.line FROM refs r JOIN files f ON r.source_file_id = f.id WHERE r.kind = 'call' AND r.target_name = ?").all(symbolName)
      },

      async getCallees(symbolName, { filePath } = {}) {
        if (!symbolName) return []
        let freshness = null
        if (filePath) freshness = await self.ensureFreshFile(filePath)
        if (filePath) {
          return _attachFreshness(self._db.prepare("SELECT r.target_name, r.kind, f2.path AS target_file FROM symbols s JOIN refs r ON r.source_file_id = s.file_id LEFT JOIN files f2 ON r.target_file_id = f2.id WHERE s.name = ? AND s.file_id = (SELECT id FROM files WHERE path = ?) AND r.kind IN ('call','import')").all(symbolName, filePath), freshness)
        }
        return self._db.prepare("SELECT r.target_name, r.kind, f.path AS source_file, f2.path AS target_file FROM symbols s JOIN refs r ON r.source_file_id = s.file_id JOIN files f ON s.file_id = f.id LEFT JOIN files f2 ON r.target_file_id = f2.id WHERE s.name = ? AND r.kind IN ('call','import')").all(symbolName)
      },

      async getSymbolsAtLine(filePath, line) {
        const freshness = await self.ensureFreshFile(filePath)
        const f = self._db.prepare('SELECT id FROM files WHERE path = ?').get(filePath)
        if (!f) return []
        return _attachFreshness(self._db.prepare("SELECT id, name, type, start_line, end_line FROM symbols WHERE file_id = ? AND ? BETWEEN start_line AND end_line ORDER BY end_line - start_line ASC").all(f.id, line), freshness)
      },

      async getImpactAnalysis(filePath, { symbol, changeType = 'modify', maxCallers = 20, depth = 2, contextMode = 'snippet' } = {}) {
        const freshness = await self.ensureFreshFile(filePath)
        // r54(P0-7): 文档契约 "0=unlimited"——maxCallers<=0 时 slice(0,0) 返回空数组，与承诺相反。归一为 Infinity。
        if (!(maxCallers > 0)) maxCallers = Infinity
        const cacheKey = `${self._currentWorkspace || ''}\0${filePath}\0${symbol || ''}\0${changeType}\0${maxCallers}\0${depth}\0${contextMode}`
        if (self._impactCache.has(cacheKey)) {
          const cached = self._impactCache.get(cacheKey)
          return { ...cached, _fromCache: true }
        }
        // Y002-S4：输出预算控制——context_mode: none（不读文件）/ snippet（默认 ±1 行）/
        // full（±5 行）；none 模式跳过 _extractContext，token 预算最低
        const contextWindow = contextMode === 'full' ? 5 : 1
        const withContext = (info) => contextMode === 'none' ? { ...info, context: null } : info

        // 16：file 参数共用守卫——无效（目录/绝对路径/不存在）时返回 file_error 归因，
        // 不再静默返回空对象让 LLM 误以为「没有调用者」
        const fileArg = resolveFileArg({ db: self._db, workspaceDir: self._currentWorkspace, file: filePath })
        if (!fileArg.ok) {
          const errRes = { file: filePath, symbol: symbol || null, callers: [], importers: [], callees: [], truncated: false, caller_count: { direct: 0, indirect: 0, test: 0, import: 0 }, risk_level: 'low', limitations: [], file_error: fileArg.error }
          self._impactCache.set(cacheKey, errRes)
          return { ...errRes }
        }
        const f = { id: fileArg.fileId }

        let symLine = 0
        let symId = 0
        let symbolNotInFile = false
        if (symbol) {
          let sym = self._db.prepare('SELECT id, start_line FROM symbols WHERE name = ? AND file_id = ?').get(symbol, f.id)
          if (!sym) {
            // r54(P1): 文件内查不到——跨文件兜底必须显式标注，不能静默抓任意同名符号
            // （a.js 无 beta 却返回 b.js beta 的调用者、risk 照算、零提示，误导重构决策）
            sym = self._db.prepare('SELECT id, start_line FROM symbols WHERE name = ?').get(symbol)
            if (sym) symbolNotInFile = true
          }
          if (sym) { symLine = sym.start_line; symId = sym.id }
        }

        let refs
        if (symbol) {
          // 10（F4）：不再排除同文件 caller——旧 `source_file_id != ?` 令同文件调用者（如 writeSymbols 调
          // applyBatchItem）全漏，blast radius 严重低估。同文件调用者同样是真实受影响方
          // 14：加 target_symbol_id 匹配——CJS 解构别名（{ process: libProcess }）经 _resolveAliasedRefs
          // 重绑定后，调用点 ref 的 target_symbol_id 指向源符号，按名匹配（libProcess≠process）会漏
          refs = symId
            ? self._db.prepare(
                "SELECT r.id, r.source_file_id, f.path AS source_file_path, r.target_name, r.kind, r.source_symbol_id, r.target_symbol_id, r.line, r.call_expr " +
                "FROM refs r JOIN files f ON r.source_file_id = f.id " +
                "WHERE r.target_name = ? OR r.target_symbol_id = ?"
              ).all(symbol, symId)
            : self._db.prepare(
                "SELECT r.id, r.source_file_id, f.path AS source_file_path, r.target_name, r.kind, r.source_symbol_id, r.target_symbol_id, r.line, r.call_expr " +
                "FROM refs r JOIN files f ON r.source_file_id = f.id " +
                "WHERE r.target_name = ?"
              ).all(symbol)
        } else {
          refs = self._db.prepare(
            "SELECT r.id, r.source_file_id, f.path AS source_file_path, r.target_name, r.kind, r.source_symbol_id, r.target_symbol_id, r.line, r.call_expr " +
            "FROM refs r JOIN files f ON r.source_file_id = f.id " +
            "WHERE r.target_name IN (SELECT name FROM symbols WHERE file_id = ?)"
          ).all(f.id)
        }

        const defFamily = langFamily(langOf(filePath))
        const directCallers = []
        const testCallers = []
        const importers = []
        const crossLanguageMatches = []
        const seenKeys = new Set()

        const sameLangAs = (file) => {
          const fam = langFamily(langOf(file))
          return fam === defFamily || defFamily === 'other' || fam === 'other'
        }
        const bucketCaller = (info, sameLang, isTest, target) => {
          if (!sameLang) crossLanguageMatches.push(info)
          else if (isTest) testCallers.push(info)
          else target.push(info)
        }

        for (const r of refs) {
          if (r.kind === 'import') {
            importers.push({ file: r.source_file_path, line: r.line || 0, ref_type: 'import' })
            continue
          }
          const { func: callerFunc } = self._resolveRefDetail(r.source_symbol_id)
          const refLine = r.line || 0
          const isTest = self._isTestFile(r.source_file_path)
          const key = `${r.source_file_path}\0${callerFunc || ''}`
          seenKeys.add(key)
          const sameLang = sameLangAs(r.source_file_path)
          const info = withContext({
            type: isTest ? 'test' : 'direct',
            ref_type: r.kind,
            file: r.source_file_path,
            line: refLine,
            function: callerFunc,
            call_expr: r.call_expr || '',
            confidence: sameLang ? 'high' : 'low',
            context: self._extractContext(r.source_file_path, refLine, contextWindow),
          })
          bucketCaller(info, sameLang, isTest, directCallers)
        }

        const indirectCallers = []
        if (symbol && depth >= 2) {
          const indirect = self._findIndirectCallers(symbol, depth, filePath)
          for (const entry of indirect) {
            const key = `${entry.file}\0${entry.function || ''}`
            if (seenKeys.has(key)) continue
            seenKeys.add(key)
            const isTest = self._isTestFile(entry.file)
            const sameLang = sameLangAs(entry.file)
            const info = withContext({
              type: isTest ? 'test' : 'indirect',
              ref_type: 'indirect',
              file: entry.file,
              line: entry.line || 0,
              function: entry.function,
              call_expr: '',
              confidence: sameLang ? 'high' : 'low',
              context: self._extractContext(entry.file, entry.line || 0, contextWindow),
              depth: entry.depth,
              via: entry.via,
            })
            bucketCaller(info, sameLang, isTest, indirectCallers)
          }
        }

        const allCallers = [...directCallers, ...indirectCallers, ...testCallers]
        const truncated = allCallers.length > maxCallers

        const callees = symbol && symId ? self._findCallees(symId, filePath, contextMode) : []

        const result = {
          symbol: symbol || null,
          file: filePath,
          line: symLine,
          change_type: changeType,
          callers: allCallers.slice(0, maxCallers),
          importers: importers.slice(0, maxCallers),
          callees: callees.slice(0, maxCallers),
          cross_language_matches: crossLanguageMatches.slice(0, maxCallers),
          cross_language_count: crossLanguageMatches.length,
          truncated,
          caller_count: {
            direct: directCallers.length,
            indirect: indirectCallers.length,
            test: testCallers.length,
            import: importers.length,
          },
          risk_level: self._calculateRisk(directCallers.length, testCallers.length, changeType),
          limitations: ['dynamic_calls_invisible', 'method_dispatch_by_name', 'cross_language_segregated'],
          // r54(P1): symbol 不在给定文件、用了跨文件同名兜底——显式标注，防 LLM 误以为是本文件符号的影响面
          ...(symbolNotInFile ? { symbol_not_in_file: true, note: `symbol "${symbol}" not found in ${filePath}; results are for a same-named symbol in another file` } : {}),
        }

        self._impactCache.set(cacheKey, result)
        if (self._impactCache.size > self._impactCacheMax) {
          const oldest = self._impactCache.keys().next().value
          self._impactCache.delete(oldest)
        }
        return _attachFreshness({ ...result }, freshness)
      },

      // r12.5：注释行 import ref 防御——refs 表可能含陈旧/误提取行（旧解析器或增量索引残留曾把
      // 注释里的 import('./x.js') 当真依赖）；读取源文件对应行，行首是 // /* * 的过滤掉。
      // 每文件行缓存，避免重复读；读失败/文件已删时放行（保守，宁可多报不可漏报）。
      _filterCommentImports(rows) {
        if (!rows || !rows.length || !self._currentWorkspace) return rows || []
        const lineCache = new Map()
        const out = []
        for (const r of rows) {
          let lines = lineCache.get(r.source_file_id)
          if (lines === undefined) {
            const f = self._db.prepare('SELECT path FROM files WHERE id = ?').get(r.source_file_id)
            try {
              lines = f ? readFileSync(join(self._currentWorkspace, f.path), 'utf-8').split('\n') : null
            } catch { lines = null }
            lineCache.set(r.source_file_id, lines)
          }
          if (!lines) { out.push(r); continue }
          const raw = lines[(r.line || 1) - 1] || ''
          const s = raw.trimStart()
          if (s.startsWith('//') || s.startsWith('/*') || s.startsWith('*')) continue
          out.push(r)
        }
        return out
      },

      async getModuleDependencies(filePath, { depth = 3 } = {}) {
        // 16：file 参数共用守卫——无效时 file_error 归因，不再静默空对象
        const fileArg = resolveFileArg({ db: self._db, workspaceDir: self._currentWorkspace, file: filePath })
        if (!fileArg.ok) return { file: filePath, imports: [], transitive: [], file_error: fileArg.error }
        const f = { id: fileArg.fileId }
        const imports = this._filterCommentImports(self._db.prepare("SELECT r.target_name AS module, r.source_file_id, r.line FROM refs r WHERE r.source_file_id = ? AND r.kind = 'import' AND (r.call_expr IS NULL OR r.call_expr != ?)").all(f.id, ALIAS_LOCAL_MARKER))
        const transitive = []
        if (depth > 1) {
          const visited = new Set([filePath])
          let queue = imports.map(i => i.module).filter(m => m && !m.startsWith('node:'))
          for (let d = 1; d < depth && queue.length; d++) {
            const next = []
            for (const mod of queue) {
              if (visited.has(mod)) continue
              visited.add(mod)
              const cleanMod = mod.replace(/^\.\.?\//, '')
              // R22-⑯：LIKE 通配符转义——模块名含 _/% 时全表匹配（R7 修了 searchSymbols，此处漏）
              const pat = `%${escapeLike(cleanMod)}%`
              let mf = self._db.prepare("SELECT id, path FROM files WHERE path LIKE ? ESCAPE '\\'").get(pat)
              if (!mf && cleanMod.includes('.')) {
                const slashed = cleanMod.replace(/\./g, '/')
                const pat2 = `%${escapeLike(slashed)}%`
                mf = self._db.prepare("SELECT id, path FROM files WHERE path LIKE ? ESCAPE '\\'").get(pat2)
              }
              if (!mf) continue
              const sub = this._filterCommentImports(self._db.prepare("SELECT r.target_name AS module, r.source_file_id, r.line FROM refs r WHERE r.source_file_id = ? AND r.kind = 'import' AND (r.call_expr IS NULL OR r.call_expr != ?)").all(mf.id, ALIAS_LOCAL_MARKER))
              for (const s of sub) {
                if (!visited.has(s.module) && !s.module.startsWith('node:')) {
                  transitive.push({ depth: d, from: mf.path, module: s.module })
                  next.push(s.module)
                }
              }
            }
            queue = next
          }
        }
        return { file: filePath, directImports: imports, transitiveDeps: transitive }
      },

      // B13 缺口四：全项目模块图 + 环检测（基于 refs 表 import 边，不重新扫描磁盘）
      // 节点 = 已索引文件；边 = import 引用（target 按基名/相对路径 LIKE 解析到文件）
      buildModuleGraph() {
        const files = self._db.prepare('SELECT id, path FROM files').all()
        const nodes = files.map(f => ({ path: f.path }))
        const fileById = new Map(files.map(f => [f.id, f.path]))
        // R22-⑮：basename→路径 索引替代逐边 files.find（O(E×V) 线性查找——大仓边数×文件数可达百万级比较，最慢路径）
        const byBase = new Map()
        for (const f of files) {
          const base = f.path.split('/').pop().replace(/\.[^.]+$/, '')
          if (!byBase.has(base)) byBase.set(base, [])
          byBase.get(base).push(f.path)
        }
        const edges = []
        const rows = this._filterCommentImports(self._db.prepare("SELECT r.source_file_id, r.target_name, r.line FROM refs r WHERE r.kind = 'import' AND (r.call_expr IS NULL OR r.call_expr != ?)").all(ALIAS_LOCAL_MARKER))
        for (const r of rows) {
          const from = fileById.get(r.source_file_id)
          if (!from || !r.target_name) continue
          if (r.target_name.startsWith('node:') || r.target_name.startsWith('@types/')) continue
          const base = r.target_name.replace(/^\.\.?\//, '').split('/').pop().replace(/\.[^.]+$/, '')
          const targetFile = (byBase.get(base) || []).find(p => p !== from)
          if (targetFile) {
            edges.push({ from, to: targetFile })
          }
        }
        return { nodes, edges }
      },

      // 全项目环检测：DFS 栈环查找，返回去重后的环列表
      findModuleCycles(nodes, edges) {
        const adj = new Map()
        for (const n of nodes) adj.set(n.path, [])
        for (const e of edges) {
          if (adj.has(e.from) && adj.has(e.to)) adj.get(e.from).push(e.to)
        }
        const visited = new Set()
        const stack = new Set()
        const cycles = []
        const seenCycles = new Set()
        const dfs = (path, trail) => {
          visited.add(path)
          stack.add(path)
          trail.push(path)
          for (const next of adj.get(path) || []) {
            if (stack.has(next)) {
              const idx = trail.indexOf(next)
              const cycle = trail.slice(idx).concat(next)
              const key = [...cycle].sort().join('\0')
              if (!seenCycles.has(key)) {
                seenCycles.add(key)
                cycles.push({ cycle, length: cycle.length - 1 })
              }
            } else if (!visited.has(next)) {
              dfs(next, trail)
            }
          }
          stack.delete(path)
          trail.pop()
        }
        for (const n of nodes) {
          if (!visited.has(n.path)) dfs(n.path, [])
        }
        return cycles
      },

      async detectDeadCode({ minUseCount = 1, scopePrefix = null } = {}) {
        // 14：usage 计数同时认 target_name 和 target_symbol_id——CJS 别名重绑定后
        // 调用点 ref 的 target_name 是本地别名（libProcess≠process），只按名计数会把
        // 被别名调用的函数误报为死代码
        // R22-㉒：scopePrefix 时先按目录过滤再 LIMIT——旧实现 LIMIT 50 在 scope 过滤前执行，
        // 大仓库子目录扫描时死函数候选被全仓 top50 截断（ansible 实测：modules 内 17 个死函数只命中 1 个）
        let sql = "SELECT s.name, s.type, f.path AS file, s.start_line, (SELECT COUNT(*) FROM refs WHERE (target_name = s.name OR target_symbol_id = s.id)) AS ref_count FROM symbols s JOIN files f ON s.file_id = f.id WHERE s.type IN ('function','method') AND (SELECT COUNT(*) FROM refs WHERE (target_name = s.name OR target_symbol_id = s.id) AND (source_file_id != s.file_id OR kind != 'import')) < ?"
        const params = [minUseCount]
        if (scopePrefix) {
          sql += " AND f.path LIKE ? ESCAPE '\\'"
          params.push(scopePrefix.replace(/[%_\\]/g, m => '\\' + m) + '%')
        }
        sql += " ORDER BY ref_count ASC LIMIT 50"
        const dead = self._db.prepare(sql).all(...params)
        // r29：注册/导出形态引用过滤——refs 只记调用与 import，`extract: extractBlocksFromLLM`
        // 这类「对象字面量属性值引用」（registerService/registerTool 回调挂载）零 ref → 被误报死代码
        // r10d：再加属性访问（getter）形态豁免——`svc.indexProgress` 属性读取同样零 ref
        return dead.filter(s => !isExportReferenced(s.name, join(self._currentWorkspace || process.cwd(), s.file))
          && !isPropertyAccessed(s.name, join(self._currentWorkspace || process.cwd(), s.file))
          && !isValueReferenced(s.name, join(self._currentWorkspace || process.cwd(), s.file)))
      },

      async getComplexity(symbolName, { filePath } = {}) {
        if (filePath) {
          const f = self._db.prepare('SELECT id FROM files WHERE path = ?').get(filePath)
          if (!f) return null
          const sym = self._db.prepare("SELECT s.id, s.start_line, s.end_line, s.type, f.path AS file FROM symbols s JOIN files f ON s.file_id = f.id WHERE s.name = ? AND s.file_id = ?").get(symbolName, f.id)
          return sym ? _calcComplexity(sym) : null
        }
        const sym = self._db.prepare("SELECT s.id, s.start_line, s.end_line, s.type, f.path AS file FROM symbols s JOIN files f ON s.file_id = f.id WHERE s.name = ? LIMIT 1").get(symbolName)
        return sym ? _calcComplexity(sym) : null
      },

      async indexProject(rootDir, { timeout = 60000 } = {}) {
        if (self._indexing) return { status: 'already indexing' }
        self._indexing = true
        self._core.log('info', `[code-index] indexing ${rootDir}...`)
        const t0 = Date.now()
        try {
          const results = await self.walkAndIndex(rootDir)
          const elapsed = Date.now() - t0
          self._core.log('info', `[code-index] indexed ${results.length} files in ${elapsed}ms`)
          return { status: 'done', files: results.length, elapsed }
        } catch (e) {
          self._core.log('error', `[code-index] indexProject failed: ${e.message}`)
          throw e
        } finally {
          // 7：失败也必须复位——旧：抛错后 _indexing 永真，所有 reindex 永久返回 already indexing
          self._indexing = false
        }
      },

      getStats() {
        const files = self._db.prepare('SELECT COUNT(*) as cnt FROM files').get().cnt
        const symbols = self._db.prepare('SELECT COUNT(*) as cnt FROM symbols').get().cnt
        const refs = self._db.prepare('SELECT COUNT(*) as cnt FROM refs').get().cnt
        const dbPath = self._currentWorkspace ? join(self._core.getWorkspaceDir(self._currentWorkspace), 'code-index.db') : null
        const fileSize = dbPath && existsSync(dbPath) ? statSync(dbPath).size : 0 // 7：整读 DB 只为取字节数 → statSync
        return { files, symbols, refs, dbSize: fileSize, indexing: self._indexing }
      },

      getFileMtime(filePath) {
        const f = self._db.prepare('SELECT mtime FROM files WHERE path = ?').get(filePath)
        return f ? f.mtime : 0
      },

      // R19：service 层薄包装——class 方法（self.ensureFreshFile）供查询出口接线
      ensureFreshFile(filePath) {
        return self.ensureFreshFile(filePath)
      },

      clearCachesForFile(filePath) {
        const absPath = self._currentWorkspace ? join(self._currentWorkspace, filePath) : filePath
        self._contextCache.delete(absPath)
        for (const key of self._outlineCache.keys()) {
          if (key.includes(`\0${filePath}\0`)) self._outlineCache.delete(key)
        }
        for (const key of self._impactCache.keys()) {
          if (key.includes(`\0${filePath}\0`)) self._impactCache.delete(key)
        }
        // r8(D2)：export 引用缓存同步失效——否则 sweep_dead_code 用旧内容把活函数报成死代码
        _exportRefCache.delete(absPath)
      },

      // 原语化 P1：版本锚点查询（附录 A/C/E）
      getSymbolByStableId(stableId) {
        return self.getSymbolByStableId(stableId)
      },

      findSymbolsInFile(filePath, name, kind) {
        return self.findSymbolsInFile(filePath, name, kind)
      },

      getFileByPath(filePath) {
        return self.getFileByPath(filePath)
      },

      // r11(L6)：非代码文件 content_hash 更新公共方法——write-runtime 旧实现直取 _db 私有字段（service stop 后 TypeError）
      updateContentHash(filePath, hash) {
        const r = self._db.prepare("UPDATE files SET content_hash = ?, index_state = 'fresh' WHERE path = ?").run(hash, filePath)
        return r.changes > 0
      },

      markIndexDirty(filePath, reason) {
        return self.markIndexDirty(filePath, reason)
      },

      async getFileOutline(filePath, { depth = 1, includeRefs = false, includeTestRefs = false, maxItems = 50 } = {}) {
        const freshness = await self.ensureFreshFile(filePath)
        // 16：复用守卫的路径归一化（绝对路径/./前缀/尾斜杠 → 相对），保留原有更丰富的错误语义
        const normPath = normalizeFilePath(filePath, self._currentWorkspace)
        const cacheKey = `${self._currentWorkspace || ''}\0${normPath}\0${depth}\0${includeRefs}\0${includeTestRefs}\0${maxItems}`
        if (self._outlineCache.has(cacheKey)) {
          return self._outlineCache.get(cacheKey)
        }

        const f = self._db.prepare('SELECT id, size, mtime FROM files WHERE path = ?').get(normPath)
        if (!f) {
          const absPath = self._currentWorkspace ? join(self._currentWorkspace, normPath) : normPath
          if (existsSync(absPath)) {
            try {
              if (statSync(absPath).isDirectory()) {
                return { error: 'dir_as_file', message: `"${filePath}" is a directory, not a file`, suggestion: 'Pass a file path relative to workspace_dir, or omit the file parameter for project-wide search' }
              }
            } catch {}
            return { error: 'not_indexed_yet', message: `File exists but is not indexed yet: ${normPath}`, suggestion: `Re-run the tool (auto-indexes on demand) or call reindex(workspace_dir=...)` }
          }
          return { error: 'file_not_found', message: `File not found: ${normPath}`, suggestion: `Check the path is relative to workspace_dir and the file exists on disk` }
        }

        const symbols = self._db.prepare('SELECT id, name, type, signature, start_line, end_line FROM symbols WHERE file_id = ? ORDER BY start_line').all(f.id)

        const docstrings = self._extractDocstrings(filePath, symbols)
        const decorators = self._extractDecorators(filePath, symbols)

        const rootSymbols = symbols.filter(s => !symbols.some(c => c.start_line <= s.start_line && c.end_line >= s.end_line && c.id !== s.id))
        const truncated = maxItems > 0 && rootSymbols.length > maxItems
        const slice = truncated ? rootSymbols.slice(0, maxItems) : rootSymbols

        const outline = await Promise.all(slice.map(s => buildOutlineNode(s, symbols, depth - 1, includeRefs, includeTestRefs)))

        const result = {
          file: normPath,
          lines: symbols.length > 0 ? Math.max(...symbols.map(s => s.end_line)) : 0,
          tokens_estimate: f.size ? Math.ceil(f.size / 3) : 0,
          mtime: f.mtime || 0,
          truncated,
          outline
        }

        self._outlineCache.set(cacheKey, result)
        if (self._outlineCache.size > self._outlineCacheMax) {
          const oldest = self._outlineCache.keys().next().value
          self._outlineCache.delete(oldest)
        }

        return _attachFreshness(result, freshness)

        async function buildOutlineNode(sym, allSyms, remainingDepth, countRefs, countTestRefs) {
          const children = allSyms.filter(c => c.id !== sym.id && c.start_line >= sym.start_line && c.end_line <= sym.end_line && !allSyms.some(g => g.id !== sym.id && g.id !== c.id && g.start_line <= c.start_line && g.end_line >= c.end_line))
          const node = { type: sym.type, name: sym.name, line: sym.start_line, end_line: sym.end_line }
          if (sym.signature) node.signature = sym.signature
          if (sym.name.startsWith('_') && !sym.name.startsWith('__')) node.private = true
          if (docstrings[sym.start_line]) node.docstring = docstrings[sym.start_line]
          if (decorators[sym.start_line]) node.decorators = decorators[sym.start_line]
          if (children.length > 0 && remainingDepth >= 0) {
            node.children = await Promise.all(children.map(c => buildOutlineNode(c, allSyms, remainingDepth - 1, countRefs, countTestRefs)))
          }
          if (countRefs) {
            const refCount = self._db.prepare('SELECT COUNT(*) as cnt FROM refs WHERE target_name = ? AND (source_file_id != ? OR kind != \'import\')').get(sym.name, f.id)
            node.refs = refCount.cnt
          }
          if (countTestRefs && !self._isTestFile(filePath)) {
            node.test_refs = self._db.prepare("SELECT COUNT(*) as cnt FROM refs r JOIN files f2 ON r.source_file_id = f2.id WHERE r.target_name = ? AND f2.path LIKE '%test%'").get(sym.name).cnt
          }
          return node
        }
      },
    })
    core.log('info', `[code-index] service registered`)

    const udsPath = core.get('codeIndex.udsPath', join(process.cwd(), 'data', 'code-index.sock'))
    const udsToken = core.get('codeIndex.udsToken', '')
    const isWin = process.platform === 'win32'
    let listenPath = udsPath
    if (isWin) {
      let h = 5381
      for (const ch of udsPath) h = ((h << 5) + h + ch.charCodeAt(0)) >>> 0
      listenPath = `\\\\.\\pipe\\malong-code-index-${h.toString(16)}`
    }
    if (!isWin) { try { unlinkSync(udsPath) } catch {} }
    // r37-fix3: 宿主（codex/claude/opencode 等）以任意 cwd 启动时 data/ 可能不存在——
    // UDS listen 到不存在父目录会抛 EACCES → uncaughtException 进程崩溃。确保目录存在。
    if (!isWin) { try { mkdirSync(dirname(listenPath), { recursive: true }) } catch {} }
    this._udsServer = createServer((req, res) => {
      if (udsToken) {
        const token = new URL(req.url, 'http://localhost').searchParams.get('token') || req.headers['x-auth-token'] || ''
        if (token !== udsToken) {
          res.statusCode = 401
          res.end(JSON.stringify({ error: 'unauthorized' }))
          return
        }
      }
      let body = ''
      req.on('data', c => body += c)
      req.on('end', async () => {
        const url = new URL(req.url, 'http://localhost')
        const parts = url.pathname.split('/').filter(Boolean)
        res.setHeader('Content-Type', 'application/json')
        try {
          const svc = core.services.codeIndex
          let result
          if (req.method === 'POST' && parts[0] === 'classify') {
            result = await svc.classifyMessage(JSON.parse(body).content)
          } else if (req.method === 'POST' && parts[0] === 'extract-symbols') {
            result = await svc.extractSymbols(JSON.parse(body).content)
          } else if (req.method === 'GET' && parts[0] === 'symbols' && parts[1]) {
            result = await svc.getSymbols(decodeURIComponent(parts[1]))
          } else if (req.method === 'GET' && parts[0] === 'references' && parts[1]) {
            result = await svc.getReferences(decodeURIComponent(parts[1]))
          } else if (req.method === 'GET' && parts[0] === 'stats') {
            result = svc.getStats()
          } else if (req.method === 'POST' && parts[0] === 'density') {
            result = await svc.getSemanticDensity(JSON.parse(body).content)
          } else if (req.method === 'GET' && parts[0] === 'callers' && parts[1]) {
            result = await svc.getCallers(decodeURIComponent(parts[1]))
          } else if (req.method === 'GET' && parts[0] === 'callees' && parts[1]) {
            result = await svc.getCallees(decodeURIComponent(parts[1]))
          } else if (req.method === 'GET' && parts[0] === 'impact' && parts[1]) {
            result = await svc.getImpactAnalysis(decodeURIComponent(parts[1]))
          } else if (req.method === 'GET' && parts[0] === 'deps' && parts[1]) {
            result = await svc.getModuleDependencies(decodeURIComponent(parts[1]))
          } else if (req.method === 'GET' && parts[0] === 'deadcode') {
            result = await svc.detectDeadCode()
          } else if (req.method === 'GET' && parts[0] === 'complexity' && parts[1]) {
            result = await svc.getComplexity(decodeURIComponent(parts[1]))
          } else if (req.method === 'GET' && parts[0] === 'search') {
            const q = url.searchParams.get('q') || ''
            result = await svc.searchSymbols(q)
          } else {
            res.statusCode = 404
            result = { error: 'not_found', path: url.pathname }
          }
          res.end(JSON.stringify(result))
        } catch (e) {
          res.statusCode = 400
          res.end(JSON.stringify({ error: e.message }))
        }
      })
    })
    // r54(P2): listen 失败（如 Windows 管道名冲突 EADDRINUSE）无 error handler 会 uncaughtException 崩进程
    this._udsServer.on('error', (e) => {
      core.log('error', `[code-index] UDS server error: ${e.message}`)
    })
    this._udsServer.listen(listenPath, () => {
      if (!isWin) { try { chmodSync(udsPath, 0o600) } catch {} }
      core.log('info', `[code-index] UDS server on ${listenPath}`)
    })
  }

  // ===== 原语化 P1：版本锚点（附录 A/C/E）=====

  _backfillFileAnchors(relPath, insertedSyms) {
    if (!insertedSyms || insertedSyms.length === 0) return
    const absPath = this._currentWorkspace ? join(this._currentWorkspace, relPath) : relPath
    let anchors = null
    try {
      anchors = computeFileAnchors(absPath, relPath, insertedSyms)
    } catch { return }
    if (!anchors || anchors.length === 0) return
    const upd = this._db.prepare('UPDATE symbols SET parent_id = ?, signature = ?, stable_id = ?, body_hash = ?, signature_hash = ? WHERE id = ?')
    for (const a of anchors) {
      upd.run(a.parentId, a.signature, a.stableId, a.bodyHash, a.signatureHash, a.id)
    }
  }

  getSymbolByStableId(stableId) {
    if (!stableId || !this._db) return null
    return this._db.prepare('SELECT s.id, s.file_id, s.name, s.type, s.signature, s.start_line, s.end_line, s.stable_id, s.body_hash, s.signature_hash, f.path AS file_path FROM symbols s JOIN files f ON s.file_id = f.id WHERE s.stable_id = ?').get(stableId) || null
  }

  findSymbolsInFile(filePath, name, kind) {
    if (!this._db) return []
    let rows = this._db.prepare('SELECT s.id, s.file_id, s.name, s.type, s.signature, s.start_line, s.end_line, s.stable_id, s.body_hash, s.signature_hash, f.path AS file_path FROM symbols s JOIN files f ON s.file_id = f.id WHERE f.path = ? AND s.name = ?').all(filePath, name)
    if (kind && rows.length > 1) {
      const k = rows.filter(r => r.type === kind)
      if (k.length > 0) rows = k
    }
    return rows
  }

  getFileByPath(filePath) {
    if (!this._db) return null
    return this._db.prepare('SELECT * FROM files WHERE path = ?').get(filePath) || null
  }

  markIndexDirty(filePath, reason) {
    if (!this._db) return
    this._db.prepare("UPDATE files SET index_state = 'dirty', content_hash = '' WHERE path = ?").run(filePath)
    if (reason) this._core?.log?.('warn', `[code-index] index dirty: ${filePath} (${reason})`)
    this.clearCachesForFile(filePath)
  }

  // 13#5：force 重抽入口——全量标 dirty，下次 indexBatch 无视 mtime 重抽所有文件（清陈旧/可疑数据）
  markAllDirty() {
    // r8(D2)：全量失效时 export 引用缓存一并清空（sweep_dead_code 依赖它判断活引用）
    _exportRefCache.clear()
    if (!this._db) return 0
    const r = this._db.prepare("UPDATE files SET index_state = 'dirty', content_hash = ''").run()
    this._core?.log?.('info', `[code-index] marked ${r.changes} files dirty (force re-extract on next reindex)`)
    return r.changes
  }

  // 13#4：开库自检——比对 DB 存的提取器版本戳 vs 当前二进制 sha256。
  // 不一致（含首次无戳的既有库）→ 全量标 dirty，下次 reindex 自动重抽清陈旧数据（懒清理，不阻塞）。
  // currentVer 可注入（测试用）；默认取 extractorVersion()。binary 不可解析（'unknown'）时跳过，避免误标。
  _reconcileExtractorVersion(currentVer = extractorVersion()) {
    if (!this._db) return { changed: false, markedDirty: 0, skipped: 'no_db' }
    if (currentVer === 'unknown') return { changed: false, markedDirty: 0, skipped: 'binary_not_resolvable' }
    const stored = this._db.prepare('SELECT value FROM meta WHERE key = ?').get('extractor_version')?.value
    const changed = stored !== currentVer
    let markedDirty = 0
    if (changed) {
      markedDirty = this._db.prepare("UPDATE files SET index_state = 'dirty', content_hash = ''").run().changes
      this._core?.log?.('info', `[code-index] extractor ${stored ? stored.slice(0, 8) : '(none)'} → ${currentVer.slice(0, 8)}: marked ${markedDirty} files dirty; run reindex to re-extract`)
    }
    this._db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('extractor_version', currentVer)
    return { changed, markedDirty, stored: stored || null, current: currentVer }
  }

  async start() {
    this._core.log('info', `[code-index] ready (db: ${this._db ? 'opened' : 'none'})`)
  }

  async stop() {
    if (this._watcher) { this._watcher.close(); this._watcher = null }
    if (this._watcherTimer) { clearTimeout(this._watcherTimer); this._watcherTimer = null }
    // r54(P2): 清 _watchedDir/_currentWorkspace——在途 watcher 回调（await 解析中）见 _db=null 但
    // _watchedDir 非空会重新 _initWorkspaceDb → 停止后僵尸开库
    this._watchedDir = null
    this._currentWorkspace = null
    if (this._udsServer) { this._udsServer.close(); this._udsServer = null }
    if (this._db) { this._db.close(); this._db = null }
    this._langParser = null
    this._core.log('info', '[code-index] stopped')
  }
}

const instance = new CodeIndex()
const name = 'malong-code-index'
const version = '0.3.0'
const init = (core) => instance.init(core)
const start = () => instance.start()
const stop = () => instance.stop()
export { isPropertyAccessed, isValueReferenced, name, version, init, start, stop }
export default instance
