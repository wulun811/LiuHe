// test-crossfile-resolve.js — dogfood-050 r5：跨文件引用解析准确性
// 覆盖：成员调用本地误绑（path.join/db.close）/ this.x 白名单保留 / 同语言多候选 import 消歧 /
//      外部 import 不回落（ESM+CJS）/ CJS 解构别名模块内绑定 / Python 跨语言误绑清零 + 相对导入正绑 /
//      resolve rules 版本 reconcile（旧错绑经重索引重建修正）
// 依赖：malong-parse 服务在跑。起真实 code-index（mock core + parse-client 做 langParser）+ 直查 DB 断言绑定。
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { createDb } from '../db-adapter.js'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const imp = (p) => import(pathToFileURL(p).href)
const MALONG_DIR = join(__dirname, '..')

let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}

const WS = join(tmpdir(), 'opencode', 'r5x-ws')
const DATA = join(tmpdir(), 'opencode', 'r5x-data')
const SOCK = join(tmpdir(), 'opencode', 'r5x-code-index.sock')
try { rmSync(WS, { recursive: true, force: true }) } catch {}
try { rmSync(DATA, { recursive: true, force: true }) } catch {}
for (const d of [WS, DATA, join(WS, 'mods'), join(WS, 'pkg')]) mkdirSync(d, { recursive: true })

writeFileSync(join(WS, 'mods', 'util.js'), 'export function parse(s) { return s }\nexport function join(a, b) { return a + b }\n')
writeFileSync(join(WS, 'mods', 'other.js'), 'export function parse(s) { return s + 1 }\n')
writeFileSync(join(WS, 'main.js'), "import { parse } from './mods/other.js'\nfunction join(a, b) { return a + b }\nexport function run(x) {\n  const p = parse(x)\n  return p + join(1, 2)\n}\n")
writeFileSync(join(WS, 'pathuser.js'), "import path from 'node:path'\nfunction join(a, b) { return a + b }\nexport function full(p) { return path.join('/root', p) }\n")
writeFileSync(join(WS, 'thiscase.js'), 'export class Reader {\n  close() { return 1 }\n  helper() { return this.close() }\n  use(db) { return db.close() }\n}\n')
writeFileSync(join(WS, 'extmain.js'), "import { createRequire } from 'node:module'\nexport function mk() { return createRequire(import.meta.url) }\n")
writeFileSync(join(WS, 'extdup.js'), 'export function createRequire(x) { return x }\n')
writeFileSync(join(WS, 'cjsmain.js'), "const { join: j } = require('./mods/util.js')\nconst { tmpdir } = require('node:os')\nexport function go() { return j(1, 2) + String(tmpdir()) }\n")
writeFileSync(join(WS, 'osdup.js'), "export function tmpdir() { return 'dup' }\n")
writeFileSync(join(WS, 'jsdup.js'), 'export function patch(x) { return x }\n')
writeFileSync(join(WS, 'pkg', 'auth.py'), 'def login(user):\n    return user\n')
writeFileSync(join(WS, 'pkg', 'main.py'), "from unittest.mock import patch\nfrom .auth import login\n\ndef go():\n    return login('u') + patch('x')\n")

const pc = await imp(join(MALONG_DIR, 'parse-client.js'))
await pc.init({ log: () => {} })
assert(await pc.connect(), 'parse-client 连接到 malong-parse')

const { default: codeIndex } = await imp(join(MALONG_DIR, 'code-index.js'))
const langParser = {
  extractAllAsync: (source, ext, filePath, ws) => pc.extractAll(source, ext, filePath, ws),
  extractReferencesAsync: (source, ext) => pc.extractReferences(source, ext),
  batchExtractAsync: (files, ws) => pc.batchExtract(files, ws),
}
const services = { langParser }
const core = {
  services,
  getService: (n) => services[n],
  registerService: (n, svc) => { services[n] = svc },
  getWorkspaceDir: () => DATA,
  log: () => {},
  emit: () => {},
  get: (key, def) => key === 'codeIndex.udsPath' ? SOCK : (key === 'codeIndex.udsToken' ? '' : def),
}
await codeIndex.init(core)
const svc = services.codeIndex
await svc.initWorkspace(WS)

const FILES = ['mods/util.js', 'mods/other.js', 'jsdup.js', 'osdup.js', 'extdup.js', 'main.js', 'pathuser.js', 'thiscase.js', 'extmain.js', 'cjsmain.js', 'pkg/auth.py', 'pkg/main.py'].map((f) => join(WS, f))
await svc.indexBatch(FILES, WS)

const db = await createDb(join(DATA, 'code-index.db'))
// 未绑（target_symbol_id NULL）经 LEFT JOIN 出全 null 行——归一为 null 便于断言
const bindOf = (srcPath, name, callExpr) => {
  const row = db.prepare(
    'SELECT s.name AS tname, tf.path AS tpath FROM refs r JOIN files sf ON sf.id = r.source_file_id ' +
    'LEFT JOIN symbols s ON s.id = r.target_symbol_id LEFT JOIN files tf ON tf.id = s.file_id ' +
    "WHERE sf.path = ? AND r.target_name = ? AND r.kind = 'call' AND r.call_expr = ? LIMIT 1"
  ).get(srcPath, name, callExpr)
  return row && row.tname && row.tpath ? row : null
}

// ── ① 同语言多候选同名：consumer 只 import other.js → 必须绑 other（旧实现任取 candidates[0]=util）──
const parseCall = bindOf('main.js', 'parse', '')
assert(parseCall && parseCall.tpath === 'mods/other.js' && parseCall.tname === 'parse', '① import 图消歧 → mods/other.js::parse（得 ' + (parseCall ? parseCall.tpath + '::' + parseCall.tname : 'null') + '）')

// ── ② 本地裸调用仍绑本地（回归）──
const joinCall = bindOf('main.js', 'join', '')
assert(joinCall && joinCall.tpath === 'main.js', '② 本地裸调用 join 仍绑本地（得 ' + (joinCall ? joinCall.tpath : 'null') + '）')

// ── ③ 成员调用本地误绑：path.join 不得绑本地 join ──
const pj = bindOf('pathuser.js', 'join', 'path.join')
assert(pj === null, '③ path.join 不绑本地 join（得 ' + (pj ? pj.tpath : 'null') + '）')

// ── ④ this.x 白名单保留 / db.close 不绑 ──
const tc = bindOf('thiscase.js', 'close', 'this.close')
assert(tc && tc.tpath === 'thiscase.js', '④a this.close 白名单保留本地绑定（得 ' + (tc ? tc.tpath : 'null') + '）')
const dc = bindOf('thiscase.js', 'close', 'db.close')
assert(dc === null, '④b db.close 不绑本地 close（得 ' + (dc ? dc.tpath : 'null') + '）')

// ── ⑤ 外部 ESM import 不回落工作区同名（旧实现单候选照绑）──
const cr = bindOf('extmain.js', 'createRequire', '')
assert(cr === null, '⑤ 外部 node:module import 不绑 extdup.js（得 ' + (cr ? cr.tpath : 'null') + '）')

// ── ⑥ CJS：解构别名模块内正绑 / 外部 require 不绑 ──
const tj = bindOf('cjsmain.js', 'j', '')
assert(tj && tj.tpath === 'mods/util.js' && tj.tname === 'join', '⑥a CJS 别名 j → mods/util.js::join（得 ' + (tj ? tj.tpath + '::' + tj.tname : 'null') + '）')
const tt = bindOf('cjsmain.js', 'tmpdir', '')
assert(tt === null || tt.tpath === 'cjsmain.js', '⑥b 外部 node:os require 不绑同名 osdup.js（得 ' + (tt ? tt.tpath : 'null') + '）')

// ── ⑦ Python：相对导入正绑 / 外部导入不跨语言绑 ──
const lg = bindOf('pkg/main.py', 'login', '')
assert(lg && lg.tpath === 'pkg/auth.py', '⑦a from .auth import login → pkg/auth.py::login（得 ' + (lg ? lg.tpath : 'null') + '）')
const pt = bindOf('pkg/main.py', 'patch', '')
assert(pt === null, '⑦b unittest.mock.patch 不跨语言绑 jsdup.js（得 ' + (pt ? pt.tpath : 'null') + '）')

// ── ⑧ resolve rules 版本 reconcile：模拟旧错绑 → 版本回退 → 重索引修正 ──
{
  const utilRow = db.prepare("SELECT id FROM files WHERE path = 'mods/util.js'").get()
  const parseSym = db.prepare("SELECT id FROM symbols WHERE name = 'parse' AND file_id = ?").get(utilRow.id)
  db.prepare(
    "UPDATE refs SET target_symbol_id = ?, target_file_id = ? WHERE id = (" +
    "SELECT r.id FROM refs r JOIN files f ON f.id = r.source_file_id " +
    "WHERE f.path = 'main.js' AND r.target_name = 'parse' AND r.kind = 'call' LIMIT 1)"
  ).run(parseSym.id, utilRow.id)
  db.prepare("INSERT INTO meta (key, value) VALUES ('resolve_rules_version', '0') ON CONFLICT(key) DO UPDATE SET value = '0'").run()
  const rec = typeof codeIndex._reconcileResolveRules === 'function' ? codeIndex._reconcileResolveRules() : { changed: false, markedDirty: 0 }
  assert(rec.changed === true && rec.markedDirty > 0, '⑧a reconcile 版本回退标记 dirty（marked=' + rec.markedDirty + '）')
  const verAfter = db.prepare("SELECT value FROM meta WHERE key = 'resolve_rules_version'").get()?.value
  assert(verAfter === '1', '⑧a2 reconcile 后版本戳回写（得 ' + verAfter + '）')
  await svc.indexBatch(FILES, WS)
  const after = bindOf('main.js', 'parse', '')
  assert(after && after.tpath === 'mods/other.js', '⑧b reconcile 后重索引修正错绑（得 ' + (after ? after.tpath : 'null') + '）')
}

// ── ⑨ OBS-01（0.5.15 Windows 复核）：分片 resolve 的旧快照不得触发 FK 失败 ──
// 分片间 await setImmediate 让出事件循环，watcher/并发 indexFile 可在这窗口 DELETE+重插目标文件符号。
// 旧实现直接 UPDATE target_symbol_id（快照里的 id 已被删）→ FOREIGN KEY constraint failed →
// code_task 报 index_failed。修复要求：① 不抛错 ② 不留悬空引用 ③ 下一轮能收口。
{
  // 造 unbound：清掉 beta* 的 target（等价于目标文件尚未索引的现场）
  writeFileSync(join(WS, 'obs01b.js'), Array.from({ length: 40 }, (_, i) => `export function gamma${i}(x) { return x + ${i} }`).join('\n') + '\n')
  writeFileSync(join(WS, 'obs01c.js'), Array.from({ length: 40 }, (_, i) => `export function call${i}() { return gamma${i}(${i}) }`).join('\n') + '\n')
  await svc.indexBatch([join(WS, 'obs01b.js'), join(WS, 'obs01c.js')], WS, undefined, { prune: false })
  db.prepare("UPDATE refs SET target_symbol_id = NULL, target_file_id = NULL WHERE target_name LIKE 'gamma%'").run()
  const unboundBefore = db.prepare("SELECT COUNT(*) c FROM refs WHERE target_symbol_id IS NULL AND target_name LIKE 'gamma%'").get().c
  assert(unboundBefore > 0, '⑨a 夹具建立 unbound 快照（' + unboundBefore + ' 条）')

  // 并发：分片 resolve（yieldEvery=1）与目标文件重抽（符号全删）交错
  const pResolve = codeIndex._resolveCrossFileRefs({ yieldEvery: 1 })
  const pReindex = (async () => {
    for (let i = 0; i < 3; i++) await new Promise(r => setImmediate(r))
    writeFileSync(join(WS, 'obs01b.js'), 'export const replaced = 1\n')
    return svc.indexFile(join(WS, 'obs01b.js'), WS)
  })()
  const settled = await Promise.allSettled([pResolve, pReindex])
  const rejected = settled.filter(s => s.status === 'rejected').map(s => String(s.reason?.message || s.reason))
  assert(rejected.length === 0, '⑨b 分片 resolve 与并发重抽不抛 FK 错误（rejected=' + JSON.stringify(rejected) + '）')
  assert(!rejected.some(m => /FOREIGN KEY/i.test(m)), '⑨c 错误里没有 FOREIGN KEY constraint failed')

  // 不留悬空引用（FK 完整性）
  const fkBad = db.pragma('foreign_key_check')
  assert(Array.isArray(fkBad) && fkBad.length === 0, '⑨d 结束后 foreign_key_check 为空（得 ' + JSON.stringify(fkBad) + '）')
  const dangling = db.prepare("SELECT COUNT(*) c FROM refs WHERE target_symbol_id IS NOT NULL AND target_symbol_id NOT IN (SELECT id FROM symbols)").get().c
  assert(dangling === 0, '⑨e 无悬空 target_symbol_id（得 ' + dangling + '）')

  // 快照过期跳过的条目仍可在幂等下一轮收口：把目标符号补回来再 resolve
  writeFileSync(join(WS, 'obs01b.js'), Array.from({ length: 40 }, (_, i) => `export function gamma${i}(x) { return x + ${i} }`).join('\n') + '\n')
  await svc.indexFile(join(WS, 'obs01b.js'), WS)
  await codeIndex._resolveCrossFileRefs()
  const unboundAfter = db.prepare("SELECT COUNT(*) c FROM refs WHERE target_symbol_id IS NULL AND target_name LIKE 'gamma%'").get().c
  assert(unboundAfter === 0, '⑨f 目标符号回补后幂等 resolve 能收口（剩余 unbound=' + unboundAfter + '）')
}

console.log('\n== test-crossfile-resolve: ' + pass + ' passed, ' + fail + ' failed ==')
process.exit(fail > 0 ? 1 : 0)
