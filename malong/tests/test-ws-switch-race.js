// test-ws-switch-race.js — Q4（2026-10-05 live 实测 P0）：workspace 切换不得留 null db 窗口
// 旧实现 _db=null → await initDb 窗口内，并发另一 workspace 的读操作（searchSymbols
// 直接 self._db.prepare）撞窗 TypeError（MCP -32603）；且 initDb 失败会留永久损坏态。
// 本测试：A 就绪后发起切 B（不 await），在 initDb 仍为途中的微任务窗口断言：
//   ① _db 不得为 null；② 窗口内 searchSymbols 不得抛。
import { join, dirname, basename } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const imp = (p) => import(pathToFileURL(p).href)
const MALONG_DIR = join(__dirname, '..')

let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}

const ROOT = join(tmpdir(), 'opencode', 'ws-switch-race')
const DATA = join(ROOT, 'data')
const wsA = join(ROOT, 'wsA')
const wsB = join(ROOT, 'wsB')
try { rmSync(ROOT, { recursive: true, force: true }) } catch {}
mkdirSync(DATA, { recursive: true })
mkdirSync(wsA, { recursive: true })
mkdirSync(wsB, { recursive: true })

const wsDir = (ws) => join(DATA, String(ws).replace(/[^a-zA-Z0-9]/g, '_'))
mkdirSync(wsDir(wsA), { recursive: true })
mkdirSync(wsDir(wsB), { recursive: true })

const services = {
  langParser: {
    extractAllAsync: async (source, ext, filePath) => {
      if (filePath.includes('slow')) await new Promise((r) => setTimeout(r, 15))
      return {
        symbols: [{ name: basename(filePath).replace(/\.[^.]+$/, ''), type: 'function', startLine: 1, endLine: 1 }],
        refs: [],
      }
    },
    hasErrorsAsync: async () => false,
    batchExtractAsync: async () => ({}),
  },
}
const core = {
  services,
  getService: (n) => services[n],
  registerService: (n, svc) => { services[n] = svc },
  getWorkspaceDir: (ws) => wsDir(ws),
  log: () => {},
  emit: () => {},
  get: (key, def) => def,
}

const { default: codeIndex } = await imp(join(MALONG_DIR, 'code-index.js'))
await codeIndex.init(core)
const svc = services.codeIndex

await svc.initWorkspace(wsA)
assert(svc.getCurrentWorkspaceHash() === wsDir(wsA).split('/').pop(), 'A 初始化后 currentWorkspace=A')

// 发起切 B（不 await）——第一个微任务时 initDb 仍在途（旧实现已把 _db 置 null）
const pSwitch = svc.initWorkspace(wsB)
await Promise.resolve()

let threw = null
try { await svc.searchSymbols('anything') } catch (e) { threw = e }
assert(threw === null, '切换窗口 searchSymbols 不得抛（旧实现 TypeError）: ' + (threw && threw.message))

await pSwitch
assert(svc.getCurrentWorkspaceHash() === wsDir(wsB).split('/').pop(), '切换完成后 currentWorkspace=B')
const after = await svc.searchSymbols('anything')
assert(Array.isArray(after), '切换后 searchSymbols 正常返回数组')

// T1（先红后绿）：并发跨 ws 读正确性——旧实现并发切换时会静默查错库（返回对方库/空）。
writeFileSync(join(wsA, 'alphaone.js'), 'export function alphaone() {}\n')
writeFileSync(join(wsB, 'betatwo.js'), 'export function betatwo() {}\n')
await svc.initWorkspace(wsA)
await svc.indexFile(join(wsA, 'alphaone.js'), wsA)
await svc.initWorkspace(wsB)
await svc.indexFile(join(wsB, 'betatwo.js'), wsB)
// 确定性交错：A 先 init（已绑定）→ 挂起等 B 完成切换 → A 再查询（旧实现此刻查到 B 库）。
const tick = (ms) => new Promise((r) => setTimeout(r, ms))
{
  const pA = (async () => {
    await svc.initWorkspace(wsA)
    await tick(8)
    return svc.searchSymbols('alphaone')
  })()
  const pB = (async () => {
    await tick(2)
    await svc.initWorkspace(wsB)
  })()
  const [ra] = await Promise.all([pA, pB])
  assert(ra.some((r) => r.name === 'alphaone'), 'T1 确定性交错：A 查询命中自身库（旧实现查错库为空）')
}
{
  const pB2 = (async () => {
    await svc.initWorkspace(wsB)
    await tick(8)
    return svc.searchSymbols('betatwo')
  })()
  const pA2 = (async () => {
    await tick(2)
    await svc.initWorkspace(wsA)
  })()
  const [rb] = await Promise.all([pB2, pA2])
  assert(rb.some((r) => r.name === 'betatwo'), 'T1 确定性交错：B 查询命中自身库（旧实现查错库为空）')
}
// 20 轮并发烟雾（覆盖绑定重入路径，不作为唯一回归）
let badA = 0, badB = 0, loopErrs = 0
for (let i = 0; i < 20; i++) {
  try {
    const [ra, rb] = await Promise.all([
      (async () => { await svc.initWorkspace(wsA); return svc.searchSymbols('alphaone') })(),
      (async () => { await svc.initWorkspace(wsB); return svc.searchSymbols('betatwo') })(),
    ])
    if (!ra.some((r) => r.name === 'alphaone')) badA++
    if (!rb.some((r) => r.name === 'betatwo')) badB++
  } catch (e) {
    loopErrs++
  }
}
assert(badA === 0, `T1 并发 20 轮 A 查询无错库（坏 ${badA} 轮）`)
assert(badB === 0, `T1 并发 20 轮 B 查询无错库（坏 ${badB} 轮）`)
assert(loopErrs === 0, `T1 并发 20 轮无未收口错误（错 ${loopErrs} 轮）`)

// ── T2：per-ws 句柄重构（先红）——句柄表/并存隔离/慢写不被切换丢弃/LRU 封顶/stop 全关 ──
{
  assert(codeIndex._handles instanceof Map, 'T2 _handles 句柄表存在')
  assert((codeIndex._handles?.size ?? 0) >= 2, `T2 A/B 两库句柄并存（得 ${codeIndex._handles?.size ?? 0}）`)
}
{
  writeFileSync(join(wsA, 'slowa.js'), 'export function slowa() {}\n')
  const pSlow = svc.indexFile(join(wsA, 'slowa.js'), wsA)
  await tick(3)
  await svc.initWorkspace(wsB)
  const rSlow = await pSlow
  assert(rSlow && rSlow.symbols >= 1, 'T2 慢写完成不被切换丢弃（T1 旧实现返回 null）: ' + JSON.stringify(rSlow))
  await svc.initWorkspace(wsA)
  const hitA = await svc.searchSymbols('slowa')
  await svc.initWorkspace(wsB)
  const hitB = await svc.searchSymbols('slowa')
  assert(hitA.some((r) => r.name === 'slowa'), 'T2 慢写落在 A 库')
  assert(!hitB.some((r) => r.name === 'slowa'), 'T2 慢写不漏进 B 库')
}
{
  const extra = []
  for (const n of ['wsC', 'wsD', 'wsE']) {
    const p = join(ROOT, n)
    mkdirSync(p, { recursive: true })
    mkdirSync(wsDir(p), { recursive: true })
    extra.push(p)
  }
  for (const p of extra) await svc.initWorkspace(p)
  assert((codeIndex._handles?.size ?? 0) >= 3, `T2 多 ws 句柄表非空（得 ${codeIndex._handles?.size ?? 0}）`)
  assert((codeIndex._handles?.size ?? 99) <= 4, `T2 LRU 封顶 4（得 ${codeIndex._handles?.size ?? 99}）`)
  const closed = [...(codeIndex._handles?.values() ?? [])].filter((h) => h.db.open === false).length
  assert(closed === 0, 'T2 表内句柄均为开启态')
}

const allDbs = [...(codeIndex._handles?.values() ?? [])].map((h) => h.db)
await codeIndex.stop().catch(() => {})
assert(allDbs.length > 0 && allDbs.every((db) => db.open === false), 'T2 stop 关闭全部句柄')
console.log('test-ws-switch-race: ' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
