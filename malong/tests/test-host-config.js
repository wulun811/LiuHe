// test-host-config.js — MCP 宿主中立状态目录（r37）
// 覆盖：MALONG_STATE_DIR 定向 / 默认 ~/.config/malong / 旧 ~/.config/opencode 回退读取 /
//       会话 ID 通用探测（OPENCODE_SESSION / MCP_SESSION_ID / SESSION_ID）
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}
const hc = await import(pathToFileURL(join(__dirname, '..', 'host-config.js')).href)

const TMP = join(os.tmpdir(), 'opencode', 'host-config-test')
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
mkdirSync(TMP, { recursive: true })
const oldHome = process.env.HOME
const oldState = process.env.MALONG_STATE_DIR

// ── 默认目录：~/.config/malong（HOME 定向下）──
{
  process.env.HOME = TMP
  delete process.env.MALONG_STATE_DIR
  assert(hc.getStateDir() === join(TMP, '.config', 'malong'), `默认状态目录（${hc.getStateDir()}）`)
  assert(hc.resolveStateFile('x.jsonl') === join(TMP, '.config', 'malong', 'x.jsonl'), 'resolveStateFile 默认目录')
}

// ── MALONG_STATE_DIR 覆盖 ──
{
  const custom = join(TMP, 'custom-state')
  process.env.MALONG_STATE_DIR = custom
  assert(hc.getStateDir() === custom, 'MALONG_STATE_DIR 覆盖生效')
  assert(hc.resolveStateFile('x.jsonl') === join(custom, 'x.jsonl'), 'resolveStateFile 跟随覆盖')
}

// ── ensureStateDir 创建目录 ──
{
  const custom = join(TMP, 'ensure-dir')
  process.env.MALONG_STATE_DIR = custom
  hc.ensureStateDir()
  assert(existsSync(custom), 'ensureStateDir 创建目录')
}

// ── 旧路径回退读取：新文件缺失时读 ~/.config/opencode/ 同名文件 ──
{
  process.env.HOME = TMP
  delete process.env.MALONG_STATE_DIR
  mkdirSync(join(TMP, '.config', 'opencode'), { recursive: true })
  const legacy = join(TMP, '.config', 'opencode', 'malong-usage.jsonl')
  writeFileSync(legacy, '{"legacy":true}\n')
  assert(hc.readStateFile('malong-usage.jsonl') === legacy, '新文件缺失时回退旧 opencode 路径')
  const p = hc.readStateFile('nonexistent.jsonl')
  assert(p === join(TMP, '.config', 'malong', 'nonexistent.jsonl'), '新旧均缺失时返回新路径')
}

// ── 新路径优先：两处都有时读新 ──
{
  process.env.HOME = TMP
  delete process.env.MALONG_STATE_DIR
  mkdirSync(join(TMP, '.config', 'malong'), { recursive: true })
  writeFileSync(join(TMP, '.config', 'malong', 'malong-usage.jsonl'), '{"new":true}\n')
  writeFileSync(join(TMP, '.config', 'opencode', 'malong-usage.jsonl'), '{"legacy":true}\n')
  const p = hc.readStateFile('malong-usage.jsonl')
  assert(p === join(TMP, '.config', 'malong', 'malong-usage.jsonl'), '新路径优先')
}

// ── 会话 ID 通用探测 ──
{
  const oldOs = process.env.OPENCODE_SESSION
  const oldMs = process.env.MCP_SESSION_ID
  const oldS = process.env.SESSION_ID
  delete process.env.OPENCODE_SESSION; delete process.env.MCP_SESSION_ID; delete process.env.SESSION_ID
  assert(hc.getSessionId() === '', '无任何会话 env 时为空串')
  process.env.OPENCODE_SESSION = 'oc-1'
  assert(hc.getSessionId() === 'oc-1', 'OPENCODE_SESSION 优先')
  delete process.env.OPENCODE_SESSION
  process.env.MCP_SESSION_ID = 'mcp-2'
  assert(hc.getSessionId() === 'mcp-2', 'MCP_SESSION_ID 探测')
  delete process.env.MCP_SESSION_ID
  process.env.SESSION_ID = 's-3'
  assert(hc.getSessionId() === 's-3', 'SESSION_ID 探测')
  if (oldOs) process.env.OPENCODE_SESSION = oldOs
  if (oldMs) process.env.MCP_SESSION_ID = oldMs
  if (oldS) process.env.SESSION_ID = oldS
}

// ── U：migrateLegacyStateDir 状态目录迁移（2026-10-05 live 债务） ──
{
  const legacy = join(TMP, 'legacy-state')
  const next = join(TMP, 'next-state')
  mkdirSync(join(legacy, 'workspaces', 'w1'), { recursive: true })
  writeFileSync(join(legacy, 'workspaces', 'w1', 'code-index.db'), 'x')
  writeFileSync(join(legacy, 'crash.log'), 'old')
  mkdirSync(next, { recursive: true })
  writeFileSync(join(next, 'schema-version'), 'v2')
  writeFileSync(join(legacy, 'schema-version'), 'v1')
  const r1 = hc.migrateLegacyStateDir(legacy, next, () => {})
  assert(existsSync(join(next, 'workspaces', 'w1', 'code-index.db')), 'U 迁移 workspaces 目录树')
  assert(existsSync(join(next, 'crash.log')), 'U 迁移 crash.log')
  assert(!existsSync(join(legacy, 'workspaces')), 'U 迁移后旧 workspaces 移除')
  assert(r1.skipped.includes('schema-version'), 'U 同名已有 → skip')
  assert(readFileSync(join(next, 'schema-version'), 'utf-8') === 'v2', 'U skip 不覆盖内容')
  const r2 = hc.migrateLegacyStateDir(legacy, next, () => {})
  assert(r2.moved.length === 0, 'U 幂等：二次迁移无移动')
  const r3 = hc.migrateLegacyStateDir('', next)
  assert(r3.moved.length === 0, 'U 空 legacy 安全')
  const r4 = hc.migrateLegacyStateDir(next, next)
  assert(r4.moved.length === 0, 'U 同目录安全')
}

// ── U2：目标 workspaces 已存在（ensureStateDir 预建）→ 按条目合并，同名保留目标 ──
{
  const legacy2 = join(TMP, 'legacy-state2')
  const next2 = join(TMP, 'next-state2')
  mkdirSync(join(legacy2, 'workspaces', 'a'), { recursive: true })
  writeFileSync(join(legacy2, 'workspaces', 'a', 'code-index.db'), 'a')
  mkdirSync(join(legacy2, 'workspaces', 'b'), { recursive: true })
  writeFileSync(join(legacy2, 'workspaces', 'b', 'code-index.db'), 'b')
  mkdirSync(join(next2, 'workspaces', 'b'), { recursive: true })
  writeFileSync(join(next2, 'workspaces', 'b', 'code-index.db'), 'new-b')
  const r5 = hc.migrateLegacyStateDir(legacy2, next2, () => {})
  assert(existsSync(join(next2, 'workspaces', 'a', 'code-index.db')), 'U2 目标已存在 → a 条目迁入')
  assert(readFileSync(join(next2, 'workspaces', 'b', 'code-index.db'), 'utf-8') === 'new-b', 'U2 同名条目保留目标不覆盖')
  assert(r5.skipped.some(s => s === 'workspaces/b'), 'U2 同名条目记 skip')
  assert(r5.moved.some(s => s === 'workspaces/a'), 'U2 迁入条目记 moved')
  assert(!existsSync(join(legacy2, 'workspaces', 'a')), 'U2 迁入条目从旧目录清除')
  assert(existsSync(join(legacy2, 'workspaces', 'b', 'code-index.db')), 'U2 skip 条目保留在旧目录（不丢数据）')
  assert(existsSync(join(legacy2, 'workspaces')), 'U2 有 skip 时旧目录不删空壳')
}

// ── LH-002（2026-10-07）：迁移子进程隔离 + 复制校验删源 + fail-soft + 逃生开关 ──
{
  const sm = await import(pathToFileURL(join(__dirname, '..', 'state-migrate.js')).href)
  // ① verifyTrees：路径集/大小一致才 true
  const vs = join(TMP, 'verify-src'), vd = join(TMP, 'verify-dst')
  mkdirSync(join(vs, 'sub'), { recursive: true })
  writeFileSync(join(vs, 'a.txt'), '12345')
  writeFileSync(join(vs, 'sub', 'b.txt'), 'x')
  mkdirSync(join(vd, 'sub'), { recursive: true })
  writeFileSync(join(vd, 'a.txt'), '12345')
  writeFileSync(join(vd, 'sub', 'b.txt'), 'x')
  assert(sm.verifyTrees(vs, vd) === true, 'LH-002 verifyTrees 一致通过')
  writeFileSync(join(vd, 'sub', 'b.txt'), 'xx')
  assert(sm.verifyTrees(vs, vd) === false, 'LH-002 大小不一致校验失败')
  rmSync(join(vd, 'sub', 'b.txt'))
  assert(sm.verifyTrees(vs, vd) === false, 'LH-002 缺文件校验失败')

  // ② 复制路径：校验失败绝不删源（forceCopy 走 copy 分支；注入 verify=false）
  const ls = join(TMP, 'mig-src'), ln = join(TMP, 'mig-dst')
  mkdirSync(join(ls, 'workspaces', 'w'), { recursive: true })
  writeFileSync(join(ls, 'workspaces', 'w', 'code-index.db'), 'data')
  const rf = sm.runMigration(ls, ln, { forceCopy: true, verify: () => false })
  assert(rf.failed.length === 1 && rf.moved.length === 0, 'LH-002 校验失败 → failed 且不算 moved（得 ' + JSON.stringify(rf) + '）')
  assert(existsSync(join(ls, 'workspaces', 'w', 'code-index.db')), 'LH-002 校验失败源保留（不删源）')
  assert(!existsSync(join(ln, 'workspaces')), 'LH-002 校验失败目标不就位')
  assert(!existsSync(join(ln, 'workspaces.malong-migrating-' + process.pid)), 'LH-002 校验失败清 staging')

  // ③ 复制路径正常：verify 通过 → 就位 + 删源
  const ls2 = join(TMP, 'mig2-src'), ln2 = join(TMP, 'mig2-dst')
  mkdirSync(join(ls2, 'workspaces', 'w2'), { recursive: true })
  writeFileSync(join(ls2, 'workspaces', 'w2', 'code-index.db'), 'data2')
  const rCopy = sm.runMigration(ls2, ln2, { forceCopy: true })
  assert(rCopy.moved.includes('workspaces') && rCopy.failed.length === 0, 'LH-002 复制+校验通过 → moved（得 ' + JSON.stringify(rCopy) + '）')
  assert(existsSync(join(ln2, 'workspaces', 'w2', 'code-index.db')), 'LH-002 数据落新目录')
  assert(!existsSync(join(ls2, 'workspaces')), 'LH-002 校验通过才删源')

  // ④ 父进程 fail-soft：子进程崩溃（模拟 Windows 0xC0000409 signal）→ 源保留 + 告警 + crash.log
  const ls3 = join(TMP, 'mig3-src'), ln3 = join(TMP, 'mig3-dst')
  mkdirSync(ls3, { recursive: true })
  writeFileSync(join(ls3, 'crash.log'), 'keep')
  const warns = []
  const r3 = hc.migrateLegacyStateDir(ls3, ln3, (lvl, m) => warns.push(`${lvl}:${m}`), { runChild: () => ({ ok: false, reason: 'signal SIGABRT (child crashed)' }) })
  assert(r3.moved.length === 0 && r3.failed.length === 1, 'LH-002 子进程崩溃 → fail-soft 结果（得 ' + JSON.stringify(r3) + '）')
  assert(existsSync(join(ls3, 'crash.log')), 'LH-002 崩溃后源完整（不迁移不删源）')
  assert(warns.some(w => w.startsWith('warn:') && /child failed/.test(w)), 'LH-002 崩溃告警可见')
  assert(existsSync(join(ln3, 'crash.log')) && /state-migration/.test(readFileSync(join(ln3, 'crash.log'), 'utf-8')), 'LH-002 失败写 crash.log（health 可见）')

  // ⑤ runChild 抛异常也 fail-soft
  const r4 = hc.migrateLegacyStateDir(ls3, ln3, () => {}, { runChild: () => { throw new Error('spawn EPERM') } })
  assert(r4.failed.length === 1, 'LH-002 runChild 抛异常 → fail-soft')

  // ⑥ MALONG_SKIP_STATE_MIGRATION=1 逃生开关：不调 child
  const ls4 = join(TMP, 'mig4-src')
  mkdirSync(ls4, { recursive: true })
  writeFileSync(join(ls4, 'schema-version'), 'v1')
  let called = false
  process.env.MALONG_SKIP_STATE_MIGRATION = '1'
  const rSkip = hc.migrateLegacyStateDir(ls4, join(TMP, 'mig4-dst'), () => {}, { runChild: () => { called = true; return { ok: true, moved: [], skipped: [], failed: [] } } })
  delete process.env.MALONG_SKIP_STATE_MIGRATION
  assert(rSkip.skipped_env === true && called === false, 'LH-002 SKIP 开关生效且不 spawn 子进程')
  assert(existsSync(join(ls4, 'schema-version')), 'LH-002 SKIP 后源完整')
}

// ── 7-D（2026-10-07 专家复测 LH-002）：迁移状态可见 + 受控重试闭环 ──
{
  const mk = (name) => { const d = join(TMP, name); mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'crash.log'), 'keep'); return d }
  // ① 崩溃 → 结构化 marker incomplete + attempts=1 + 源保留
  const s1 = mk('m7d-src1'), d1 = mk('m7d-dst1')
  const rd = (p) => existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : null
  const r1 = hc.migrateLegacyStateDir(s1, d1, () => {}, { runChild: () => ({ ok: false, reason: 'signal SIGABRT' }) })
  const m1 = rd(join(d1, 'state-migration.json'))
  assert(m1 && m1.status === 'incomplete' && m1.attempts === 1 && m1.failed.length >= 1, '7-D 崩溃 → marker incomplete/attempts=1（得 ' + JSON.stringify(m1) + '）')
  assert(existsSync(join(s1, 'crash.log')), '7-D marker 写入后源保留')
  assert(r1.marker && r1.marker.status === 'incomplete', '7-D 返回值带 marker')

  // ② 重试上限 3：连续失败后第 4 次不再自动重试（runChild 不被调）；env 显式重试可放行
  let calls = 0
  const crash = () => { calls++; return { ok: false, reason: 'crash#' + calls } }
  hc.migrateLegacyStateDir(s1, d1, () => {}, { runChild: crash })
  hc.migrateLegacyStateDir(s1, d1, () => {}, { runChild: crash })
  const before = calls
  const rSkip = hc.migrateLegacyStateDir(s1, d1, () => {}, { runChild: crash })
  assert(calls === before && rSkip.retry_skipped === true, '7-D attempts≥3 → 自动重试跳过（得 calls=' + calls + ' skipped=' + rSkip.retry_skipped + '）')
  process.env.MALONG_RETRY_STATE_MIGRATION = '1'
  const rRetry = hc.migrateLegacyStateDir(s1, d1, () => {}, { runChild: crash })
  delete process.env.MALONG_RETRY_STATE_MIGRATION
  assert(calls === before + 1 && rRetry.retry_skipped !== true, '7-D env 显式重试放行（得 calls=' + calls + '）')
  const m2 = rd(join(d1, 'state-migration.json'))
  assert(m2 && m2.attempts === 4, '7-D attempts 递增到 4（得 ' + JSON.stringify(m2) + '）')

  // ③ 成功 → marker complete
  const s3 = mk('m7d-src3'), d3 = mk('m7d-dst3')
  hc.migrateLegacyStateDir(s3, d3, () => {}, { runChild: () => ({ ok: true, moved: ['workspaces'], skipped: [], failed: [] }) })
  const m3 = rd(join(d3, 'state-migration.json'))
  assert(m3 && m3.status === 'complete' && m3.moved.includes('workspaces'), '7-D 成功 → marker complete（得 ' + JSON.stringify(m3) + '）')

  // ④ staging 残留清理：崩溃后 next 下的 *.malong-migrating-* 必须清掉
  const s4 = mk('m7d-src4'), d4 = mk('m7d-dst4')
  mkdirSync(join(d4, 'workspaces.malong-migrating-99999'), { recursive: true })
  writeFileSync(join(d4, 'workspaces.malong-migrating-99999', 'x'), 'stale')
  hc.migrateLegacyStateDir(s4, d4, () => {}, { runChild: () => ({ ok: false, reason: 'crash' }) })
  assert(!existsSync(join(d4, 'workspaces.malong-migrating-99999')), '7-D 崩溃后清理 staging 残留')
}

// ── readPackageVersion：默认读本目录，缺失回退上一级（DSH bundle 打包副本；狗粮 2026-10-13） ──
{
  const pkgRoot = join(TMP, 'pkgver')
  const pkgDir = join(pkgRoot, 'pkg')
  const serverDir = join(pkgDir, 'server')
  mkdirSync(serverDir, { recursive: true })
  writeFileSync(join(serverDir, 'package.json'), JSON.stringify({ version: '9.9.9' }))
  assert(hc.readPackageVersion(serverDir) === '9.9.9', 'readPackageVersion 本目录 package.json 优先（得 ' + hc.readPackageVersion(serverDir) + '）')
  rmSync(join(serverDir, 'package.json'), { force: true })
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ version: '1.2.3' }))
  assert(hc.readPackageVersion(serverDir) === '1.2.3', 'readPackageVersion 缺失回退 ../package.json（得 ' + hc.readPackageVersion(serverDir) + '）')
  rmSync(join(pkgDir, 'package.json'), { force: true })
  assert(hc.readPackageVersion(serverDir) === '0.0.0', 'readPackageVersion 两处皆缺 → 0.0.0（得 ' + hc.readPackageVersion(serverDir) + '）')
  writeFileSync(join(serverDir, 'package.json'), '{ not json')
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ version: '2.0.0' }))
  assert(hc.readPackageVersion(serverDir) === '2.0.0', 'readPackageVersion 本目录坏 JSON → 回退上级（得 ' + hc.readPackageVersion(serverDir) + '）')
}

// ── 版本位一致性（0.5.14 复审修复：lang-parser.js 曾漏随版本点更新，0.5.14 构建里仍报 v0.5.13）──
{
  const root = join(__dirname, '..')
  const pkgVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')).version
  const lp = readFileSync(join(root, 'lang-parser.js'), 'utf-8').match(/export const version = '([^']+)'/)
  const gr = readFileSync(join(root, 'tools', 'entry-shared.js'), 'utf-8').match(/export const GRAPH_VERSION = '([^']+)'/)
  const bundleVersion = JSON.parse(readFileSync(join(root, 'dsh', 'bundle', 'package.json'), 'utf-8')).version
  const lockVersion = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf-8')).version
  assert(lp && lp[1] === pkgVersion, `lang-parser 版本位跟随 package.json（lang=${lp && lp[1]}, pkg=${pkgVersion}）`)
  assert(gr && gr[1] === pkgVersion, `GRAPH_VERSION 跟随 package.json（graph=${gr && gr[1]}, pkg=${pkgVersion}）`)
  assert(bundleVersion === pkgVersion, `bundle package.json 跟随主包（bundle=${bundleVersion}, pkg=${pkgVersion}）`)
  // 0.5.15：package-lock 也是版本位——0.5.14→0.5.15 升级时曾漏随（五处需同值）
  assert(lockVersion === pkgVersion, `package-lock.json 跟随主包（lock=${lockVersion}, pkg=${pkgVersion}）`)
}

// ── 环境还原 ──
{
  if (oldHome) process.env.HOME = oldHome
  if (oldState) process.env.MALONG_STATE_DIR = oldState
  else delete process.env.MALONG_STATE_DIR
}

try { rmSync(TMP, { recursive: true, force: true }) } catch {}
console.log(`== test-host-config: ${pass} passed, ${fail} failed ==`)
if (fail > 0) process.exit(1)
