// test-workspace-gc.js — 工作区索引库自清理（治本 B）回归
// 纯 fs 逻辑，不依赖 parse daemon。验证：dryRun 只报告 / 真删 stale / 保留 fresh / protect 豁免 / no-op 安全。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, rmSync, existsSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const imp = (p) => import(pathToFileURL(p).href)
const { cleanupStaleWorkspaces } = await imp(join(__dirname, '..', 'health-check.js'))

let pass = 0, fail = 0
function assert(c, m) { if (c) { pass++ } else { fail++; console.error('  FAIL:', m) } }

const ROOT = join(tmpdir(), 'opencode', 'ws-gc-test')
const WS = join(ROOT, 'workspaces')
rmSync(ROOT, { recursive: true, force: true })

const DAY = 86400000
const now = Date.now()
function mkWs(hash, lastAccessMs, sizeKB) {
  const dir = join(WS, hash)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'metadata.json'), JSON.stringify({ workspace_dir: '/x/' + hash, last_accessed: new Date(lastAccessMs).toISOString() }))
  writeFileSync(join(dir, 'code-index.db'), 'x'.repeat(sizeKB * 1024))
  const t = lastAccessMs / 1000
  utimesSync(join(dir, 'metadata.json'), t, t)
  utimesSync(join(dir, 'code-index.db'), t, t)
}

mkWs('stale0000000', now - 30 * DAY, 512)   // 30 天前 512KB → 应删
mkWs('fresh0000000', now - 1 * DAY, 4)      // 1 天前 → 保留
mkWs('protect00000', now - 60 * DAY, 4)     // 60 天前但受保护 → 保留

// ① dry run：报告不删（protect 豁免 60 天的 protect00000）
const dry = cleanupStaleWorkspaces(WS, { maxAgeDays: 14, dryRun: true, protect: ['protect00000'] })
assert(dry.status === 'dry_run', `① dry status（得 ${dry.status}）`)
assert(dry.deleted_count === 1, `① dry 报告 1 个 stale（得 ${dry.deleted_count}）`)
assert(dry.deleted.some(d => d.workspace === 'stale0000000'), '① dry 报告含 stale0000000')
assert(existsSync(join(WS, 'stale0000000')), '① dry 不真删 stale')

// ② 真删 + protect 豁免
const real = cleanupStaleWorkspaces(WS, { maxAgeDays: 14, dryRun: false, protect: ['protect00000'] })
assert(real.status === 'cleaned', `② real status（得 ${real.status}）`)
assert(real.deleted_count === 1, `② real 删 1 个（得 ${real.deleted_count}）`)
assert(!existsSync(join(WS, 'stale0000000')), '② stale 已删')
assert(existsSync(join(WS, 'fresh0000000')), '② fresh 保留')
assert(existsSync(join(WS, 'protect00000')), '② protected 保留（尽管 60 天）')
assert(real.freed_mb >= 0.4, `② freed_mb ≥ 0.4（得 ${real.freed_mb}）`)

// ③ 二次跑（带 protect）：无 stale 0 删
const again = cleanupStaleWorkspaces(WS, { maxAgeDays: 14, protect: ['protect00000'] })
assert(again.deleted_count === 0, `③ 二次跑 0 删（得 ${again.deleted_count}）`)
assert(again.kept_count === 2, `③ 二次跑保留 2（fresh+protect，得 ${again.kept_count}）`)

// ⑥ 无 protect 时老库会被删（证明 protect 是护栏）
const noProtect = cleanupStaleWorkspaces(WS, { maxAgeDays: 14, dryRun: true })
assert(noProtect.deleted.some(d => d.workspace === 'protect00000'), '⑥ 无 protect 时 60 天老库会被标记删')

// ④ 不存在目录：安全 no-op
const noop = cleanupStaleWorkspaces(join(tmpdir(), 'opencode', 'no-such-ws-dir-xyz'), { maxAgeDays: 14 })
assert(noop.status === 'no_workspaces_dir', `④ 不存在目录 no-op（得 ${noop.status}）`)
assert(noop.deleted_count === 0, '④ no-op 0 删')

// ⑤ 阈值边界：maxAgeDays=45 时 30 天前的不算 stale
mkWs('stale0000000', now - 30 * DAY, 4)
const wide = cleanupStaleWorkspaces(WS, { maxAgeDays: 45, dryRun: true })
assert(!wide.deleted.some(d => d.workspace === 'stale0000000'), '⑤ 阈值 45d 时 30 天前不算 stale')

rmSync(ROOT, { recursive: true, force: true })
console.log(`\n=== test-workspace-gc: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
