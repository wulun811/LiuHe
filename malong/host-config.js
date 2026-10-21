// host-config.js — MCP 宿主中立状态目录（r37：去 opencode 专用化）
// MCP 协议本身通用（JSON-RPC 2.0 + stdio），任何 MCP 客户端可连；
// 本文件统一托管「宿主相关的数据位置」——默认 ~/.config/malong，
// 可用 MALONG_STATE_DIR 环境变量覆盖（测试/沙盒定向）。
// 兼容：0.3.36 及更早版本的统计/反馈数据写在 ~/.config/opencode/，
// readStateFile 读取时自动回退旧路径（写入只写新目录，旧数据不丢）。
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, appendFileSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'

// r35-fix 同款：Windows 上 homedir() 忽略 HOME（读 USERPROFILE），HOME 优先
// 注意：函数内动态求值（模块级常量会在 HOME 变更/测试定向后失效）
// Y001 债务3：导出供 readUsageStats 双路径聚合（旧副本数据仍计入）
export function getLegacyDir() {
  return join(process.env.HOME || homedir(), '.config', 'opencode')
}

export function getStateDir() {
  return process.env.MALONG_STATE_DIR || join(process.env.HOME || homedir(), '.config', 'malong')
}

export function ensureStateDir() {
  const dir = getStateDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

// 新路径（写入方用）
export function resolveStateFile(name) {
  return join(getStateDir(), name)
}

// 版本解析：优先 <dir>/package.json；否则回退 <dir>/../package.json。
// 打包副本（如 DSH bundle 把 server/ 与其上级 package.json 分离）需要回退，
// 否则 npm 安装副本会报告 0.0.0（DSH 狗粮 2026-10-13 发现）。
export function readPackageVersion(startDir) {
  for (const p of [join(startDir, 'package.json'), join(startDir, '..', 'package.json')]) {
    try { const v = JSON.parse(readFileSync(p, 'utf-8')).version; if (v) return v } catch {}
  }
  return '0.0.0'
}

// 读取兼容旧版：新路径不存在时回退 ~/.config/opencode/ 下的同名文件
export function readStateFile(name) {
  const p = resolveStateFile(name)
  if (existsSync(p)) return p
  const legacy = join(getLegacyDir(), name)
  return existsSync(legacy) ? legacy : p
}

// 会话 ID：通用探测各 MCP 宿主注入的 env（opencode 注入 OPENCODE_SESSION；空串无副作用）
export function getSessionId() {
  return process.env.OPENCODE_SESSION || process.env.MCP_SESSION_ID || process.env.SESSION_ID || ''
}

// LH-002（2026-10-07）：迁移在**子进程**执行（Windows 跨盘 cpSync 硬崩 0xC0000409 不带走宿主），
// 子进程内部 rename→copy→verify→delete（见 state-migrate.js；复制未校验绝不删源）。
// 父进程 fail-soft：子进程崩溃/超时/非零 → 告警 + crash.log 记录 + 源保留 + 继续启动。
// `MALONG_SKIP_STATE_MIGRATION=1` 显式跳过；opts.runChild 仅测试注入。
// 7-D（2026-10-07 专家复测）：状态可见 + 受控重试——marker state-migration.json（incomplete/complete
// + attempts）；自动重试上限 3 次后需 MALONG_RETRY_STATE_MIGRATION=1 显式放行；失败清理 staging 残留。
const MIGRATION_MAX_AUTO_ATTEMPTS = 3
const MIGRATION_MARKER = 'state-migration.json'

function readMigrationMarker(nextDir) {
  try { return JSON.parse(readFileSync(join(nextDir, MIGRATION_MARKER), 'utf-8')) } catch { return null }
}

function writeMigrationMarker(nextDir, data) {
  try {
    mkdirSync(nextDir, { recursive: true })
    writeFileSync(join(nextDir, MIGRATION_MARKER), JSON.stringify(data, null, 2))
  } catch {}
}

// 崩溃的子进程会留下 {dst}.malong-migrating-{pid} staging 残渣——下次尝试前/后都清掉
function cleanupMigrationStaging(nextDir) {
  try {
    for (const e of readdirSync(nextDir)) {
      if (e.includes('.malong-migrating-')) { try { rmSync(join(nextDir, e), { recursive: true, force: true }) } catch {} }
    }
  } catch {}
}

export function migrateLegacyStateDir(legacyDir, nextDir, log = () => {}, opts = {}) {
  if (process.env.MALONG_SKIP_STATE_MIGRATION === '1') {
    log('info', 'state migration skipped (MALONG_SKIP_STATE_MIGRATION=1)')
    return { moved: [], skipped: [], failed: [], skipped_env: true }
  }
  if (!legacyDir || !nextDir || legacyDir === nextDir) return { moved: [], skipped: [], failed: [] }
  if (!existsSync(legacyDir)) return { moved: [], skipped: [], failed: [] }
  const prior = readMigrationMarker(nextDir)
  const attempts = (prior?.attempts || 0) + 1
  // 7-D：连续失败达上限后不再自动重试（每次启动都崩 0xC0000409 是环境问题，自动重试只刷噪声）
  if (prior?.status === 'incomplete' && prior.attempts >= MIGRATION_MAX_AUTO_ATTEMPTS && process.env.MALONG_RETRY_STATE_MIGRATION !== '1') {
    log('warn', `state migration auto-retry skipped (attempts=${prior.attempts} >= ${MIGRATION_MAX_AUTO_ATTEMPTS}); set MALONG_RETRY_STATE_MIGRATION=1 to retry (source kept)`)
    return { moved: [], skipped: [], failed: prior.failed || [], retry_skipped: true, marker: prior }
  }
  cleanupMigrationStaging(nextDir)
  const runChild = opts.runChild || defaultRunMigrationChild
  let r
  try { r = runChild(legacyDir, nextDir) } catch (e) { r = { ok: false, reason: e?.message || String(e) } }
  let result, marker
  if (r && r.ok) {
    for (const m of (r.moved || [])) log('info', `state migration moved ${m}`)
    for (const s of (r.skipped || [])) log('info', `state migration skipped ${s}`)
    for (const f of (r.failed || [])) log('warn', `state migration failed for ${f.entry}: ${f.error}`)
    result = { moved: r.moved || [], skipped: r.skipped || [], failed: r.failed || [] }
    if (result.failed.length) {
      recordMigrationFailure(nextDir, result.failed)
      marker = { schema: 1, status: 'incomplete', legacy_dir: legacyDir, next_dir: nextDir, moved: result.moved, skipped: result.skipped, failed: result.failed, attempts, last_error: result.failed.map(f => `${f.entry}(${f.error})`).join(', '), updated_at: new Date().toISOString() }
    } else {
      // 完成条件：子进程 ok 且零 failed（copy→verify→delete；未校验绝不删源）；skipped=目标已有，非失败
      marker = { schema: 1, status: 'complete', legacy_dir: legacyDir, next_dir: nextDir, moved: result.moved, skipped: result.skipped, failed: [], attempts, updated_at: new Date().toISOString() }
    }
  } else {
    const reason = r?.reason || 'child failed'
    log('warn', `state migration child failed (${reason}); continuing without migration (source kept)`)
    recordMigrationFailure(nextDir, [{ entry: '*', error: reason }])
    result = { moved: [], skipped: [], failed: [{ entry: '*', error: reason }] }
    marker = { schema: 1, status: 'incomplete', legacy_dir: legacyDir, next_dir: nextDir, moved: [], skipped: [], failed: result.failed, attempts, last_error: reason, updated_at: new Date().toISOString() }
  }
  cleanupMigrationStaging(nextDir)
  writeMigrationMarker(nextDir, marker)
  return { ...result, marker }
}

function defaultRunMigrationChild(legacyDir, nextDir) {
  const cli = join(dirname(fileURLToPath(import.meta.url)), 'state-migrate-cli.js')
  // 超时内子进程被 SIGKILL——父进程只收到 signal/status，崩溃隔离成立
  const res = spawnSync(process.execPath, [cli, legacyDir, nextDir], { timeout: 60_000, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 })
  if (res.error) return { ok: false, reason: res.error.code || res.error.message }
  if (res.signal) return { ok: false, reason: `signal ${res.signal} (child crashed)` }
  if (res.status !== 0) return { ok: false, reason: `exit ${res.status}${res.stderr ? ': ' + String(res.stderr).slice(0, 200) : ''}` }
  try { return { ok: true, ...JSON.parse(res.stdout || '{}') } } catch { return { ok: false, reason: 'unparseable child output' } }
}

// 失败可见：health 读 crash.log；目录不存在先建；写入失败不抛出
function recordMigrationFailure(nextDir, failed) {
  try {
    mkdirSync(nextDir, { recursive: true })
    const line = `[state-migration] ${new Date().toISOString()} failed: ${failed.map(f => `${f.entry}(${f.error})`).join(', ')}\n`
    appendFileSync(join(nextDir, 'crash.log'), line)
  } catch {}
}
