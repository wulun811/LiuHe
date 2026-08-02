// test-dogfood-r13.js — 第 13 轮：索引自愈闭环回归
// ① extractorVersion=二进制sha256 ② meta版本戳 ③ indexBatch认dirty ④ 开库自检reconcile ⑤ markAllDirty/force入口
// 依赖：malong-parse 服务在跑。起真实 code-index（mock core + parse-client 做 langParser）+ 第二个 DB 连接检视。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createDb } from '../db-adapter.js'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const imp = (p) => import(pathToFileURL(p).href)
const MALONG_DIR = join(__dirname, '..')

let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}

const WS = join(tmpdir(), 'opencode', 'r13-ws')
const DATA = join(tmpdir(), 'opencode', 'r13-data')
const SOCK = join(tmpdir(), 'opencode', 'r13-code-index.sock')

rmSync(WS, { recursive: true, force: true })
rmSync(DATA, { recursive: true, force: true })
for (const d of [WS, DATA]) mkdirSync(d, { recursive: true })

writeFileSync(`${WS}/a.js`, `function alpha() { return 1 }\nfunction beta() { return alpha() }\n`)
writeFileSync(`${WS}/b.js`, `function gamma() { return 2 }\n`)
const aJs = join(WS, 'a.js')
const bJs = join(WS, 'b.js')

const pc = await imp(join(MALONG_DIR, 'parse-client.js'))
await pc.init({ log: () => {} })
const connected = await pc.connect()
assert(connected, 'parse-client 连接到 malong-parse')

const { default: codeIndex, extractorVersion, resolveExtractorBin } = await imp(join(MALONG_DIR, 'code-index.js'))
const langParser = {
  extractAllAsync: (source, ext, filePath) => pc.extractAll(source, ext, filePath),
  batchExtractAsync: (files) => pc.batchExtract(files),
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
await svc.indexBatch([aJs, bJs], WS)

const db2 = await createDb(join(DATA, 'code-index.db'))
db2.pragma('busy_timeout=5000')
const symIds = (p) => db2.prepare('SELECT id FROM symbols WHERE file_id=(SELECT id FROM files WHERE path=?)').all(p).map(r => r.id).sort((x, y) => x - y)
const fileRow = (p) => db2.prepare('SELECT content_hash, index_state FROM files WHERE path=?').get(p)

// ── ① extractorVersion = 二进制 sha256 ──
const bin = resolveExtractorBin()
assert(!!bin && existsSync(bin), `① resolveExtractorBin 找到二进制（${bin}）`)
const v1 = extractorVersion()
assert(/^[0-9a-f]{64}$/.test(v1), `① extractorVersion 返回 64-hex sha256（得 ${String(v1).slice(0, 12)}）`)
assert(extractorVersion() === v1, '① extractorVersion 稳定（两次相等）')
const expected = createHash('sha256').update(readFileSync(bin)).digest('hex')
assert(v1 === expected, '① extractorVersion == 独立计算的二进制 sha256')
assert(extractorVersion('/nonexistent/malong-parse') === 'unknown', '① extractorVersion 缺失二进制 → unknown')

// ── ② 开库已盖戳当前二进制版本 ──
const stamped = db2.prepare("SELECT value FROM meta WHERE key='extractor_version'").get()?.value
assert(stamped === v1, `② initWorkspace 开库自检已盖戳当前版本（得 ${String(stamped).slice(0, 12)}）`)

// ── ④ reconcileExtractorVersion 版本仲裁 ──
const rSame = svc.reconcileExtractorVersion(v1)
assert(rSame.changed === false && rSame.markedDirty === 0, '④ reconcile 同版本 → 不标 dirty')
const fake = 'deadbeef'.repeat(8)
const rNew = svc.reconcileExtractorVersion(fake)
assert(rNew.changed === true && rNew.markedDirty >= 2, `④ reconcile 版本变更 → 标 dirty（${rNew.markedDirty} 文件）`)
const dirtyAfter = db2.prepare("SELECT COUNT(*) c FROM files WHERE index_state='dirty'").get().c
assert(dirtyAfter >= 2, `④ 版本变更后文件全 dirty（${dirtyAfter}）`)
const stampedFake = db2.prepare("SELECT value FROM meta WHERE key='extractor_version'").get()?.value
assert(stampedFake === fake, '④ reconcile 后戳更新为新版本')
const rBack = svc.reconcileExtractorVersion(v1)
assert(rBack.changed === true && rBack.stored === fake, '④ reconcile 改回 v1 → changed 且记录 stored=fake')
const rUnk = svc.reconcileExtractorVersion('unknown')
assert(rUnk.skipped === 'binary_not_resolvable', '④ reconcile unknown → 跳过不误标')
const stampedStill = db2.prepare("SELECT value FROM meta WHERE key='extractor_version'").get()?.value
assert(stampedStill === v1, '④ unknown 跳过后戳保持 v1 不被覆盖')

// ── ③ indexBatch 认 dirty（无视 mtime 重抽）──
await svc.indexBatch([aJs, bJs], WS) // 清掉 ④ 留下的 dirty，恢复 fresh
const a0 = fileRow('a.js')
assert(a0.index_state === 'fresh' && a0.content_hash, '③ 重索引后 a.js fresh + 有 content_hash')
const aIds0 = symIds('a.js')
const bIds0 = symIds('b.js')
db2.prepare("UPDATE files SET index_state='dirty', content_hash='' WHERE path='a.js'").run() // 只标脏 a.js，不动 mtime
await svc.indexBatch([aJs, bJs], WS) // mtime 均未变
const a1 = fileRow('a.js')
assert(a1.index_state === 'fresh' && a1.content_hash === a0.content_hash, '③ dirty 的 a.js 无视 mtime 被重抽（content_hash 恢复、回 fresh）')
const aIds1 = symIds('a.js')
assert(JSON.stringify(aIds1) !== JSON.stringify(aIds0), '③ a.js 符号 id 变化 → 确实重抽了')
const bIds1 = symIds('b.js')
assert(JSON.stringify(bIds1) === JSON.stringify(bIds0), '③ fresh 未改的 b.js 被跳过（符号 id 不变）')

// ── ⑤ markAllDirty / force 入口 ──
const n = svc.markAllDirty()
assert(n >= 2, `⑤ markAllDirty 标 ${n} 文件 dirty`)
const allDirty = db2.prepare("SELECT COUNT(*) c FROM files WHERE index_state='dirty'").get().c
assert(allDirty >= 2, '⑤ markAllDirty 后全部 dirty')
await svc.indexBatch([aJs, bJs], WS)
const freshAfter = db2.prepare("SELECT COUNT(*) c FROM files WHERE index_state='fresh'").get().c
assert(freshAfter >= 2, '⑤ force 重抽后全部恢复 fresh')

db2.close()
await codeIndex.stop()
try { const { disconnect } = pc; await disconnect() } catch {}

console.log(`\n=== test-dogfood-r13: ${pass} passed, ${fail} failed ===`)
process.exit(fail > 0 ? 1 : 0)
