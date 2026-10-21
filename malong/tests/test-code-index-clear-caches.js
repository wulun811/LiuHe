// test-code-index-clear-caches.js — 回归：class CodeIndex 必须有 clearCachesForFile
// 背景：clearCachesForFile 曾只在 service 包装层；class.markIndexDirty 调 this.clearCachesForFile
// → 写后 reindex 失败路径（write-runtime 兜底 markIndexDirty）抛 TypeError，并发下偶发（~20%）。
// 断言：class 实例具备该方法；markIndexDirty 清空三类缓存且不抛；包装层委托同一实现。
import { pathToFileURL } from 'node:url'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  FAIL:', msg) } }

const mod = await import(pathToFileURL(join(__dirname, '..', 'code-index.js')).href)
const inst = mod.default

// ── 1. 方法存在（修复前为 undefined → class.markIndexDirty 抛错）──
assert(typeof inst.clearCachesForFile === 'function', 'CodeIndex 实例具备 clearCachesForFile')

// ── 2. markIndexDirty 在 _db 存在时清缓存且不抛（失败路径：旧实现此处抛 TypeError）──
// 第三轮 Windows 复验：产品 _handles 以 resolve(ws) 为键；夹具旧用硬编码 /tmp 键 → Windows 失配（3 缓存断言假失败）。
// 统一 resolve(os.tmpdir())：Linux 下值与旧路径等义，Windows 下与产品键一致。
const WS = resolve(join(os.tmpdir(), 'opencode', 'ci-clear-caches'))
const FILE = 'src/a.js'
// T2：per-ws 句柄表——注入 mock 以代替旧 `inst._db = mock`
inst._handles.set(WS, { db: { prepare: () => ({ run: () => ({ changes: 1 }) }) }, refs: 0, lastUsed: Date.now() })
inst._currentWorkspace = WS
inst._contextCache.set(join(WS, FILE), ['x'])
inst._outlineCache.set(`k\0${FILE}\0o`, { a: 1 })
inst._impactCache.set(`k\0${FILE}\0i`, { b: 2 })
let threw = null
try { inst.markIndexDirty(FILE, 'test') } catch (e) { threw = e }
assert(threw === null, `markIndexDirty 不抛（得 ${threw && threw.message}）`)
assert(!inst._contextCache.has(join(WS, FILE)), 'contextCache 已清')
assert(inst._outlineCache.size === 0, 'outlineCache 已清（含 filePath 键）')
assert(inst._impactCache.size === 0, 'impactCache 已清（含 filePath 键）')

// ── 3. 不误删其它文件缓存 ──
inst._contextCache.set(join(WS, 'src/b.js'), ['y'])
inst._outlineCache.set(`k\0src/b.js\0o`, {})
inst.markIndexDirty(FILE, 'test')
assert(inst._contextCache.has(join(WS, 'src/b.js')), '不误删其它文件 contextCache')
assert(inst._outlineCache.has(`k\0src/b.js\0o`), '不误删其它文件 outlineCache')

// ── 4. _db 为空时安全返回 ──
inst._handles.clear()
inst._contextCache.set(join(WS, FILE), ['z'])
threw = null
try { inst.markIndexDirty(FILE, 'test') } catch (e) { threw = e }
assert(threw === null, '_db 为空时不抛')
assert(inst._contextCache.has(join(WS, FILE)), '_db 为空时不触碰缓存')

// ── 5. indexBatch prune 语义（live 审查 H2）：子集清单 + prune:false 不得删清单外已索引文件 ──
{
  const { mkdirSync, writeFileSync, statSync } = await import('node:fs')
  const ws = resolve(join(os.tmpdir(), 'opencode', 'ci-prune'))
  mkdirSync(join(ws, 'src'), { recursive: true })
  const absA = join(ws, 'src', 'a.js')
  writeFileSync(absA, 'const a = 1\n')
  const st = statSync(absA)
  const deletes = []
  const rows = [
    { id: 1, path: 'src/a.js', mtime: st.mtimeMs, index_state: 'fresh' },
    { id: 2, path: 'src/b.js', mtime: 1, index_state: 'fresh' },
  ]
  inst._currentWorkspace = ws
  const mockDb = {
    prepare: (sql) => {
      if (sql.startsWith('SELECT path, mtime')) return { all: () => rows }
      if (sql.startsWith('SELECT id, path')) return { all: () => rows }
      if (sql.startsWith('DELETE FROM')) return { run: (id) => deletes.push([sql.split(' ')[2], id]) }
      return { all: () => [], run: () => ({ changes: 0 }) }
    },
    transaction: (fn) => (() => fn()),
    pragma: () => {},
  }
  inst._handles.set(ws, { db: mockDb, refs: 0, lastUsed: Date.now() })
  await inst.indexBatch([absA], ws, undefined, { prune: false })
  assert(deletes.length === 0, `H2: prune:false 不删清单外文件（得 ${JSON.stringify(deletes)}）`)
  await inst.indexBatch([absA], ws, undefined, { prune: true })
  assert(deletes.some(d => d[0] === 'files' && d[1] === 2), `H2: prune:true 保留默认删除语义（得 ${JSON.stringify(deletes)}）`)
  // 5b. facade 透传 opts（第二轮审查 P1：旧 3 参 wrapper 丢弃 prune:false → H2 生产空心）
  {
    const services = {}
    let udsDef = null
    // W17-01（第四轮 Windows 复验）：Core.get 契约恒返回默认值（mcp-server.js:274）——旧 `get: () => null`
    // 使 init 的 udsPath=null → Windows 管道名 hash 遍历 null 裸 TypeError（code-index.js:2154）
    await mod.init({
      getService: (n) => (n === 'langParser' ? {} : services[n] || null),
      registerService: (n, s) => { services[n] = s },
      getWorkspaceDir: () => ws,
      get: (k, def) => { if (k === 'codeIndex.udsPath') udsDef = def; return def },
      log: () => {}, emit: () => {},
    })
    assert(typeof udsDef === 'string' && udsDef.length > 0, `W17-01: codeIndex.udsPath 默认值为非空字符串（Windows 管道 hash 需可迭代；得 ${JSON.stringify(udsDef)}）`)
    inst._currentWorkspace = ws
    inst._handles.set(ws, { db: mockDb, refs: 0, lastUsed: Date.now() })
    const captured = []
    const orig = inst.indexBatch.bind(inst)
    inst.indexBatch = async (...a) => { captured.push(a); return orig(...a) }
    await services.codeIndex.indexBatch([absA], ws, undefined, { prune: false })
    inst.indexBatch = orig
    assert(captured.length === 1 && captured[0][3]?.prune === false, `H2: facade 透传第 4 参 opts（旧 3 参 wrapper 丢弃；得 ${JSON.stringify(captured[0]?.[3])}）`)
  }
}

// ── 6. live 审查 K2：>1MB 文件 ensureFreshFile 显式标注 index_skipped_large（与 fresh 区分）──
{
  const { mkdirSync, writeFileSync, statSync, utimesSync } = await import('node:fs')
  const ws = resolve(join(os.tmpdir(), 'opencode', 'ci-bigfile'))
  mkdirSync(ws, { recursive: true })
  writeFileSync(join(ws, 'big.js'), 'x'.repeat(1024 * 1024 + 16))
  inst._currentWorkspace = ws
  inst._handles.clear()
  const fr = await inst.ensureFreshFile('big.js')
  assert(fr && fr.index_skipped_large === true, `K2: >1MB 标注 index_skipped_large（得 ${JSON.stringify(fr)}）`)
  // 6b. 第二轮审查：曾缓存的小文件涨过 1MB（mtime 变）→ 必须先清缓存再标 skipped（旧实现早退留 stale cache）
  const ws2 = resolve(join(os.tmpdir(), 'opencode', 'ci-bigfile2'))
  mkdirSync(ws2, { recursive: true })
  const small = join(ws2, 'small.js')
  writeFileSync(small, 'const s = 1\n')
  const oldMtime = statSync(small).mtimeMs - 10_000
  inst._currentWorkspace = ws2
  inst._handles.set(ws2, { db: { prepare: () => ({ get: () => ({ mtime: oldMtime }) }) }, refs: 0, lastUsed: Date.now() })
  inst._outlineCache.set(`k\0small.js\0o`, { stale: true })
  writeFileSync(small, 'x'.repeat(1024 * 1024 + 16))
  utimesSync(small, new Date(), new Date())
  const fr2 = await inst.ensureFreshFile('small.js')
  assert(fr2 && fr2.index_skipped_large === true, `K2: 涨过 1MB 仍标 index_skipped_large（得 ${JSON.stringify(fr2)}）`)
  assert(!inst._outlineCache.has(`k\0small.js\0o`), 'K2: 涨过 1MB 时旧 outline 缓存被清（旧实现永久 stale）')
}

console.log(`\n=== test-code-index-clear-caches: ${pass} passed, ${fail} failed ===`)
process.exit(fail > 0 ? 1 : 0)