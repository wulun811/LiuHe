import { existsSync, readdirSync, readFileSync, writeFileSync, accessSync, constants, unlinkSync, statSync, rmSync } from 'node:fs'
import net from 'node:net'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCHEMA_VERSION = 1

export function readUsageStats() {
  const usagePath = join(homedir(), '.config', 'opencode', 'malong-usage.jsonl')
  if (!existsSync(usagePath)) return null
  try {
    const lines = readFileSync(usagePath, 'utf-8').trim().split('\n').filter(Boolean)
    const byTool = {}
    let totalCalls = 0, totalDuration = 0
    const breakdown = { ok: 0, error: 0, crash: 0 }
    const value = { tokens_saved: 0, tokens_served: 0, reads_saved: 0, searches_saved: 0, issues_caught: 0, collisions_detected: 0, rollbacks: 0, edits_automated: 0, tests_verified: 0 }
    let firstTs = null, lastTs = null
    for (const line of lines) {
      try {
        const r = JSON.parse(line)
        totalCalls++
        totalDuration += r.duration_ms || 0
        if (!firstTs) firstTs = r.ts
        lastTs = r.ts
        const st = r.status || (r.success ? 'ok' : 'error')
        breakdown[st] = (breakdown[st] || 0) + 1
        if (!byTool[r.tool]) byTool[r.tool] = { calls: 0, ok: 0, error: 0, crash: 0, total_ms: 0 }
        const t = byTool[r.tool]
        t.calls++
        t[st] = (t[st] || 0) + 1
        t.total_ms += r.duration_ms || 0
        if (r.metrics) {
          for (const [k, v] of Object.entries(r.metrics)) {
            if (k in value) value[k] += v
          }
        }
      } catch {}
    }
    for (const t of Object.values(byTool)) {
      t.avg_ms = Math.round(t.total_ms / t.calls)
      delete t.total_ms
    }
    const crashFree = totalCalls - breakdown.crash
    return {
      total_calls: totalCalls,
      success_rate: totalCalls ? Math.round(crashFree / totalCalls * 100) / 100 : 1,
      status_breakdown: breakdown,
      total_duration_ms: totalDuration,
      period: firstTs && lastTs ? `${firstTs.slice(0, 10)} ~ ${lastTs.slice(0, 10)}` : null,
      value,
      by_tool: byTool,
    }
  } catch { return null }
}

export async function runHealthCheck({ stateDir, toolsDir, workspacesDir, registry, log, semaphore, activeRequests, parseService }) {
  const checks = []
  let ok = true

  function add(name, status, detail) {
    checks.push({ name, status, detail })
    if (status === 'FAIL') ok = false
  }

  // 运行时健康检查
  if (semaphore && activeRequests) {
    const mem = process.memoryUsage()
    const rssMB = Math.round(mem.rss / 1048576)
    const heapMB = Math.round(mem.heapUsed / 1048576)
    const heapTotalMB = Math.round(mem.heapTotal / 1048576)

    // 内存检查
    if (rssMB > 800) {
      add('Memory RSS', 'FAIL', `${rssMB}MB > 800MB threshold`)
    } else if (rssMB > 600) {
      add('Memory RSS', 'WARN', `${rssMB}MB > 600MB (consider restart)`)
    } else {
      add('Memory RSS', 'PASS', `${rssMB}MB RSS, ${heapMB}/${heapTotalMB}MB heap`)
    }

    // 信号量检查（死锁检测）
    const semStatus = semaphore.getStatus()
    if (semStatus.current > semStatus.max) {
      add('Semaphore', 'FAIL', `current=${semStatus.current} > max=${semStatus.max} (deadlock?)`)
    } else if (semStatus.queue.length > 10) {
      add('Semaphore', 'WARN', `queue=${semStatus.queue.length} (stuck requests?)`)
    } else {
      add('Semaphore', 'PASS', `${semStatus.current}/${semStatus.max} slots, queue=${semStatus.queue.length}`)
    }

    // 卡死请求检查
    const now = Date.now()
    const stuckRequests = []
    for (const [id, req] of activeRequests.entries()) {
      const elapsed = now - req.startTime
      if (elapsed > 60000) { // 超过 60 秒
        stuckRequests.push({ id, tool: req.name, elapsed_ms: elapsed })
      }
    }
    if (stuckRequests.length > 0) {
      add('Active Requests', 'WARN', `${stuckRequests.length} stuck >60s: ${stuckRequests.map(r => `${r.tool}(${Math.round(r.elapsed_ms/1000)}s)`).join(', ')}`)
    } else {
      add('Active Requests', 'PASS', `${activeRequests.size} active, none stuck`)
    }

    // 进程运行时间
    const uptime = Math.round(process.uptime())
    add('Uptime', 'INFO', `${Math.round(uptime/3600)}h ${Math.round((uptime%3600)/60)}m`)

    // 解析服务检查（Rust malong-parse）
    if (parseService) {
      const mode = parseService.getMode()
      const isRust = parseService.isRustService()
      if (isRust) {
        add('Parse Service', 'PASS', `rust-service mode, config=${parseService.getConfigMode?.() || '?'}`)
      } else if (mode === 'builtin') {
        add('Parse Service', 'INFO', `builtin mode (fallback), env=${parseService.getConfigMode?.() || '?'}`)
      } else {
        add('Parse Service', 'WARN', `unexpected mode: ${mode}`)
      }
    }
  }

  try {
    accessSync(stateDir, constants.W_OK)
    add('stateDir writable', 'PASS', stateDir)
  } catch {
    add('stateDir writable', 'FAIL', `${stateDir} is not writable`)
  }

  if (existsSync(workspacesDir)) {
    try {
      const entries = readdirSync(workspacesDir, { withFileTypes: true })
      let dbCount = 0
      let badCount = 0
      let totalSizeMB = 0
      const databases = []
      let Database
      try { Database = (await import('better-sqlite3')).default } catch {}
      for (const e of entries) {
        if (!e.isDirectory()) continue
        const dbPath = join(workspacesDir, e.name, 'code-index.db')
        if (existsSync(dbPath)) {
          dbCount++
          let sizeMB = 0, lastAccess = null
          try {
            const st = statSync(dbPath)
            sizeMB = Math.round(st.size / 1024 / 1024 * 10) / 10
            totalSizeMB += sizeMB
            const ageMs = Date.now() - st.mtimeMs
            lastAccess = ageMs < 3600000 ? `${Math.round(ageMs / 60000)}min ago`
              : ageMs < 86400000 ? `${Math.round(ageMs / 3600000)}h ago`
              : `${Math.round(ageMs / 86400000)}d ago`
          } catch {}
          databases.push({ workspace: e.name, size_mb: sizeMB, last_access: lastAccess })
          if (Database) {
            try {
              // 7（#18）：busy_timeout——恰逢 indexBatch 的 DROP/CREATE INDEX（schema 锁）时
              // SQLITE_BUSY 被旧实现当损坏计 WARN
              const db = new Database(dbPath, { timeout: 5000 })
              const r = db.pragma('integrity_check')
              const integrityOk = Array.isArray(r) && r.length === 1 && r[0]?.integrity_check === 'ok'
              db.close()
              if (!integrityOk) badCount++
            } catch { badCount++ }
          }
        }
      }
      if (Database) {
        add('DB integrity', badCount === 0 ? 'PASS' : 'WARN', `${dbCount} workspace(s), ${badCount} corrupted, total ${Math.round(totalSizeMB)}MB`)
      } else {
        add('DB integrity', 'PASS', `${dbCount} workspace(s), total ${Math.round(totalSizeMB)}MB — sqlite3 not available for integrity check`)
      }
      if (databases.length > 0) {
        checks.push({ name: 'Workspace databases', status: 'INFO', detail: `${databases.length} database(s)`, databases })
      }
    } catch (e) {
      add('DB integrity', 'WARN', `cannot scan: ${e.message}`)
    }
  } else {
    add('DB integrity', 'PASS', 'no workspaces yet')
  }

  if (existsSync(toolsDir)) {
    const entries = readdirSync(toolsDir, { withFileTypes: true })
    let total = 0
    let bad = 0
    const badNames = []
    for (const e of entries) {
      if (!e.isDirectory() || !e.name.startsWith('tool-')) continue
      total++
      const mf = join(toolsDir, e.name, 'manifest.json')
      if (!existsSync(mf)) { bad++; badNames.push(`${e.name}/manifest.json`); continue }
      try {
        const m = JSON.parse(readFileSync(mf, 'utf-8'))
        if (!m.name || !m.handler) { bad++; badNames.push(`${e.name}/bad manifest`); continue }
        const hp = join(toolsDir, e.name, m.handler)
        if (!existsSync(hp)) { bad++; badNames.push(`${e.name}/handler missing`); continue }
      } catch { bad++; badNames.push(`${e.name}/invalid JSON`) }
    }
    add('Tool manifests', bad === 0 ? 'PASS' : 'WARN', `${total} tools, ${bad} issues: ${badNames.join(', ')}`)
  } else {
    add('Tool manifests', 'FAIL', `tools dir not found: ${toolsDir}`)
  }

  const schemaPath = join(stateDir, 'schema-version')
  if (existsSync(schemaPath)) {
    try {
      const stored = parseInt(readFileSync(schemaPath, 'utf-8').trim())
      if (stored === SCHEMA_VERSION) {
        add('Schema version', 'PASS', `v${stored}`)
      } else {
        add('Schema version', 'WARN', `stored v${stored}, expected v${SCHEMA_VERSION}`)
      }
    } catch {
      add('Schema version', 'WARN', 'cannot read schema-version file')
    }
  } else {
    try {
      writeFileSync(schemaPath, String(SCHEMA_VERSION))
      add('Schema version', 'PASS', `initialized v${SCHEMA_VERSION}`)
    } catch {
      add('Schema version', 'WARN', 'cannot write schema-version file')
    }
  }

  // 7：先探测 socket 是否活着再删——旧：直接 unlinkSync 会把正在监听的 UDS 删掉，
  // 之后所有新连接 ENOENT 直到重启（stateDir 的 .. 恰好等于 code-index 的 socket 目录）
  const sockPath = join(stateDir, '..', 'code-index.sock')
  if (existsSync(sockPath)) {
    const alive = await new Promise((resolve) => {
      const s = net.connect(sockPath)
      s.once('connect', () => { s.destroy(); resolve(true) })
      s.once('error', () => resolve(false))
      setTimeout(() => { s.destroy(); resolve(false) }, 500).unref()
    })
    if (alive) {
      add('Stale socket', 'PASS', `active socket ${sockPath}`)
    } else {
      try { unlinkSync(sockPath); add('Stale socket', 'CLEANED', sockPath) }
      catch (e) { add('Stale socket', 'WARN', `cannot remove: ${e.message}`) }
    }
  } else {
    add('Stale socket', 'PASS')
  }

  if (registry) {
    const count = registry.getToolCount()
    add('Tool registry', count > 0 ? 'PASS' : 'WARN', `${count} tools loaded`)
  }

  return { status: ok ? 'ok' : 'warn', checks, timestamp: Date.now() }
}

/**
 * 工作区索引库自清理（治本 B）：按 last activity 超 maxAgeDays 删除 stale 工作区缓存。
 * 索引库是可重建缓存（删了下次 reindex 即恢复），故 prune 安全——源码不受影响。
 * 判据取多信号最新值：目录内所有文件 mtime + metadata.json 的 last_accessed 字段，
 * 避免误删「只读查询、未重新索引」的活跃库；无法判定时间一律保守保留。
 * @param {string} workspacesDir - stateDir/workspaces
 * @param {object} [opts]
 * @param {number} [opts.maxAgeDays=14] - 超期阈值（天）
 * @param {boolean} [opts.dryRun=false] - 只报告不删
 * @param {string[]} [opts.protect=[]] - 永不删除的工作区 hash 列表
 */
export function cleanupStaleWorkspaces(workspacesDir, opts = {}) {
  const { maxAgeDays = 14, dryRun = false, protect = [] } = opts
  if (!workspacesDir || !existsSync(workspacesDir)) {
    return { status: 'no_workspaces_dir', max_age_days: maxAgeDays, deleted_count: 0, freed_mb: 0, deleted: [], kept_count: 0 }
  }
  const maxAgeMs = maxAgeDays * 86400000
  const now = Date.now()
  const deleted = []
  let keptCount = 0
  let freedBytes = 0
  for (const e of readdirSync(workspacesDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    if (protect.includes(e.name)) { keptCount++; continue }
    const wsDir = join(workspacesDir, e.name)
    let files
    try { files = readdirSync(wsDir) } catch { keptCount++; continue }
    let lastActivity = 0
    let sizeBytes = 0
    for (const f of files) {
      try {
        const st = statSync(join(wsDir, f))
        if (st.mtimeMs > lastActivity) lastActivity = st.mtimeMs
        sizeBytes += st.size
      } catch {}
    }
    try {
      const meta = JSON.parse(readFileSync(join(wsDir, 'metadata.json'), 'utf-8'))
      if (meta.last_accessed) {
        const t = new Date(meta.last_accessed).getTime()
        if (Number.isFinite(t) && t > lastActivity) lastActivity = t
      }
    } catch {}
    if (lastActivity === 0) { keptCount++; continue }
    const ageMs = now - lastActivity
    if (ageMs > maxAgeMs) {
      const sizeMB = Math.round(sizeBytes / 1048576 * 10) / 10
      if (!dryRun) {
        try { rmSync(wsDir, { recursive: true, force: true }) } catch { keptCount++; continue }
      }
      deleted.push({ workspace: e.name, age_days: Math.round(ageMs / 86400000 * 10) / 10, size_mb: sizeMB })
      freedBytes += sizeBytes
    } else {
      keptCount++
    }
  }
  return {
    status: dryRun ? 'dry_run' : 'cleaned',
    max_age_days: maxAgeDays,
    deleted_count: deleted.length,
    freed_mb: Math.round(freedBytes / 1048576 * 10) / 10,
    deleted,
    kept_count: keptCount,
  }
}