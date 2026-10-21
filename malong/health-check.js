import { existsSync, readdirSync, readFileSync, writeFileSync, accessSync, constants, unlinkSync, statSync, rmSync, realpathSync } from 'node:fs'
import net from 'node:net'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'


const __dirname = dirname(fileURLToPath(import.meta.url))
const SCHEMA_VERSION = 1

import { readStateFile } from './host-config.js'

// r37：宿主中立——默认 ~/.config/malong，读取兼容旧 ~/.config/opencode/ 回退（数据不丢）
// Y001 债务3：双路径聚合——0AIT 等旧副本仍写旧路径（无 host-config 的版本滞后），
// readStateFile 单路径回退会在新路径有数据时忽略旧路径 253K 条；此处两处都读、合并统计。
// 注：两处若出现同一调用被复制到两文件（极端迁移场景）会双计，风险接受（只读聚合不做迁移）
// Y002-S0 复盘发现（2026-08-03）：`lines.push(...arr)` 对 25 万行 spread 展开
// 触发 Maximum call stack size exceeded 被 catch{} 静默吞掉——旧路径 253K 条从未进聚合，
// 债务3 的双路径统计实际失效。改为逐行 push（concat 同因新建数组也无益）。
function readUsageLines() {
  // r10d：迁移完成后单一数据源——只读新路径。legacy（~/.config/opencode，通天侧旧版进程仍在写）
  // 不再并入统计，避免双源混淆（其存量已一次性迁移并备份 .pre-migrate-<date>）。
  const p = readStateFile('malong-usage.jsonl')
  if (!existsSync(p)) return []
  const lines = []
  try {
    const content = readFileSync(p, 'utf-8').trim()
    if (content) {
      for (const l of content.split('\n')) {
        if (!l) continue
        // r10：过滤历史故障注入测试污染——08-01 stress-fixture EACCES 风暴 251K 条
        // 把 success_rate 拖到 0.01% 失真（legacy 文件合并统计必现）
        try {
          const r = JSON.parse(l)
          if (typeof r.error_code === 'string' && r.error_code.includes('stress-fixture')) continue
        } catch {}
        lines.push(l)
      }
    }
  } catch {}
  return lines
}

export function readUsageStats() {
  const lines = readUsageLines()
  if (lines.length === 0) return null
  try {
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
        // r10：迁移后 legacy 数据 append 在新路径尾部——首尾行≠时间极值，用 min/max
        if (!firstTs || (r.ts && r.ts < firstTs)) firstTs = r.ts
        if (!lastTs || (r.ts && r.ts > lastTs)) lastTs = r.ts
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
    // r34-fix: 旧 `(total - crash)/total` 把 error 状态也计入成功率——
    // success_rate 应为 ok/total（error 是失败调用）
    const okCount = breakdown.ok
    // r10：edit_batch 的节省走独立 stats 文件（estimated_tokens_saved = (numEdits-1)*fileSize/4），
    // 与 usage 遥测的 tokens_saved（read_outline「省读文件」口径）是不同概念——独立字段展示，不混入 value
    const editBatchStats = { calls: 0, edits: 0, tokens_saved: 0 }
    try {
      const ep = readStateFile('edit-batch-stats.jsonl')
      if (existsSync(ep)) {
        for (const l of readFileSync(ep, 'utf-8').split('\n')) {
          if (!l) continue
          try {
            const r = JSON.parse(l)
            editBatchStats.calls++
            editBatchStats.edits += r.num_edits || 0
            editBatchStats.tokens_saved += r.estimated_tokens_saved || 0
          } catch {}
        }
      }
    } catch {}
    return {
      total_calls: totalCalls,
      success_rate: totalCalls ? Math.round(okCount / totalCalls * 100) / 100 : 1,
      status_breakdown: breakdown,
      total_duration_ms: totalDuration,
      period: firstTs && lastTs ? `${firstTs.slice(0, 10)} ~ ${lastTs.slice(0, 10)}` : null,
      value,
      by_tool: byTool,
      edit_batch_stats: editBatchStats,
    }
  } catch { return null }
}

export async function runHealthCheck({ stateDir, toolsDir, workspacesDir, registry, log, semaphore, activeRequests, parseService, buildInfo }) {
  const checks = []
  let ok = true
  let parserIdentity = null

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

    // 信号量检查（死锁 + 槽位泄漏检测）
    const semStatus = semaphore.getStatus()
    // R2：weight 感知——activeRequests 条目带 weight（mcp-server 写入），缺字段兜底 1。
    // 等待中的请求（acquire 未完成）已入 activeRequests 但未占槽 → activeWeight 可能 > current，不触发泄漏。
    const activeWeight = Array.from(activeRequests.values()).reduce((s, r) => s + (r.weight || 1), 0)
    if (semStatus.current > semStatus.max) {
      add('Semaphore', 'FAIL', `current=${semStatus.current} > max=${semStatus.max} (deadlock?)`)
    } else if (activeWeight < semStatus.current) {
      // 泄漏特征：槽位被占但无对应活跃请求（异常路径未 release）
      add('Semaphore', 'FAIL', `${semStatus.current - activeWeight} slots leaked (active weight ${activeWeight} < current ${semStatus.current})`)
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
        // 7-C：运行身份核验——daemon 自报告（version/pid/exe_path/exe_size/build_commit）与
        // 本 MCP 可解析二进制对比；不一致 = 部署漂移（默认 daemon 仍是旧构建）
        let identity = null
        try { identity = await parseService.getIdentity?.() } catch (e) { identity = { error: (e && e.message) || 'identity_failed' } }
        if (identity && !identity.error) {
          const d = identity.daemon
          const daemonOk = !!(d && !d.error)
          const daemonDesc = daemonOk
            ? ('daemon v' + d.version + ' pid=' + d.pid + ' uptime=' + d.uptime + 's' + (d.exe_path ? ' exe=' + d.exe_path : '') + (d.exe_size != null ? ' size=' + d.exe_size : '') + (d.build_commit && d.build_commit !== 'unknown' ? ' commit=' + d.build_commit : ''))
            : (d && d.error ? 'daemon health error: ' + d.error : 'daemon identity unavailable (not connected)')
          // 7-C 修正（2026-10-18 Windows 复核）：比较前先 realpath —— daemon 自报的是 /proc/self/exe 真路径，
          // 而 resolved_bin 来自配置/环境变量；两者经符号链接（本机 ~/.local/bin → /mnt/ssd/NAI/.local/bin）
          // 或 Windows 8.3 短名/目录联接时字符串不同 → 旧实现把「同一个二进制」误报成 DRIFT。
          const norm = (p) => {
            const raw = String(p || '')
            let real = raw
            try { real = realpathSync(raw) } catch { real = raw }
            return real.replace(/\\/g, '/').toLowerCase()
          }
          let drift = null
          if (daemonOk && d.exe_path && identity.resolved_bin) {
            if (norm(d.exe_path) !== norm(identity.resolved_bin)) {
              drift = 'daemon binary (' + d.exe_path + ') differs from resolvable binary (' + identity.resolved_bin + ') — parser upgrade pending or MALONG_PARSE_BIN mismatch'
            } else if (d.exe_size != null && identity.resolved_bin_size != null && d.exe_size !== identity.resolved_bin_size) {
              drift = 'same exe path but size mismatch (daemon ' + d.exe_size + ' vs resolved ' + identity.resolved_bin_size + ')'
            }
          }
          const oldDaemon = daemonOk && d.exe_path == null
          parserIdentity = {
            ...identity,
            drift: drift ? { detected: true, reason: drift } : { detected: false },
            ...(oldDaemon ? { note: 'daemon predates identity fields (exe_path/exe_size) — rebuild and redeploy to expose build identity' } : {}),
          }
          const resolvedDesc = identity.resolved_bin
            ? ('; resolved=' + identity.resolved_bin + (identity.resolved_bin_sha256 ? ' sha256=' + identity.resolved_bin_sha256.slice(0, 12) : ''))
            : ''
          add('Parse Service', drift ? 'WARN' : 'PASS', 'rust-service ' + identity.endpoint + ' connected=' + identity.connected + '; ' + daemonDesc + (oldDaemon ? ' (predates identity fields)' : '') + resolvedDesc + (drift ? '; DRIFT: ' + drift : ''))
        } else {
          add('Parse Service', 'PASS', 'rust-service mode, config=' + (parseService.getConfigMode?.() || '?') + (identity && identity.error ? ' (identity: ' + identity.error + ')' : ''))
        }
      } else if (mode === 'builtin') {
        add('Parse Service', 'INFO', 'builtin mode (fallback), env=' + (parseService.getConfigMode?.() || '?'))
      } else {
        add('Parse Service', 'WARN', 'unexpected mode: ' + mode)
      }
    }
  }

  // 7-C：服务器运行身份（版本/commit/pid/node）——与解析器身份并列，升级状态一眼可核
  if (buildInfo) {
    add('Server Identity', 'PASS', 'malong v' + (buildInfo.version || '?') + (buildInfo.commit ? ' commit=' + buildInfo.commit : '') + ' pid=' + (buildInfo.pid || process.pid) + ' node=' + (buildInfo.node || process.version))
  }

  // 7-D：状态目录迁移状态（LH-002 闭环）——incomplete 必须可见且给出受控重试入口
  try {
    const migPath = join(stateDir, 'state-migration.json')
    if (existsSync(migPath)) {
      let mig = null
      try { mig = JSON.parse(readFileSync(migPath, 'utf-8')) } catch {}
      if (mig?.status === 'complete') {
        add('State Migration', 'PASS', 'complete (' + (mig.moved?.length || 0) + ' moved, ' + (mig.skipped?.length || 0) + ' skipped)')
      } else if (mig?.status === 'incomplete') {
        add('State Migration', 'WARN', 'incomplete (attempts=' + (mig.attempts || 0) + '/3, last_error=' + (mig.last_error || '?') + '); source kept at ' + (mig.legacy_dir || '?') + ' — retry: MALONG_RETRY_STATE_MIGRATION=1 + restart, or node state-migrate-cli.js <legacy> <next>')
      } else {
        add('State Migration', 'PASS', 'marker unreadable/unknown — ignored')
      }
    } else {
      add('State Migration', 'PASS', 'no pending migration')
    }
  } catch (e) {
    add('State Migration', 'WARN', 'cannot read migration marker: ' + e.message)
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
      let createDb
      try { ({ createDb } = await import('./db-adapter.js')) } catch {}
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
          databases.push({ workspace: e.name, size_mb: sizeMB, last_access: lastAccess, path: dbPath })
        }
      }
      // r48: 原代码引用未定义变量 `Database`（只在 db-adapter.js 内部定义）→ 恒抛
      // ReferenceError 被外层 catch 吞 → DB integrity 永远 WARN "cannot scan: Database is not defined"
      if (createDb) {
        // 第二轮审查：integrity_check 同步全量扫（27 库实测）阻塞事件循环——每次最多查 3 个轮转，
        // 多轮扫描覆盖全部；细节注明本次覆盖面，避免 PASS 被读作全量健康
        const start = databases.length ? Math.floor(Date.now() / 30000) % databases.length : 0
        const upto = Math.min(3, databases.length)
        for (let i = 0; i < upto; i++) {
          const rec = databases[(start + i) % databases.length]
          let db = null
          try {
            // 7（#18）：busy_timeout——恰逢 indexBatch 的 DROP/CREATE INDEX（schema 锁）时
            // SQLITE_BUSY 被旧实现当损坏计 WARN
            db = await createDb(rec.path, { readonly: true, timeout: 5000 })
            const r = db.pragma('integrity_check')
            const integrityOk = Array.isArray(r) && r.length === 1 && r[0]?.integrity_check === 'ok'
            if (!integrityOk) badCount++
          } catch { badCount++ } finally { try { db?.close() } catch {} }
        }
        add('DB integrity', badCount === 0 ? 'PASS' : 'WARN', `${dbCount} workspace(s), ${badCount} corrupted (checked ${upto}/${databases.length} this scan), total ${Math.round(totalSizeMB)}MB`)
      } else {
        add('DB integrity', 'PASS', `${dbCount} workspace(s), total ${Math.round(totalSizeMB)}MB — sqlite3 not available for integrity check`)
      }
      if (databases.length > 0) {
        // S3：库列表过长（28+ 条日志刷屏）——只回传前 10 条 + 总数，完整信息在各库 path 可推
        checks.push({
          name: 'Workspace databases', status: 'INFO',
          detail: `${databases.length} database(s)` + (databases.length > 10 ? ` (showing first 10)` : ''),
          databases: databases.slice(0, 10),
          ...(databases.length > 10 ? { databases_omitted: databases.length - 10 } : {}),
        })
      }
    } catch (e) {
      add('DB integrity', 'WARN', `cannot scan: ${e.message}`)
    }
  } else {
    add('DB integrity', 'PASS', 'no workspaces yet')
  }

  if (existsSync(toolsDir)) {
    // 审查修复（三轮）：existsSync 后裸 readdirSync——EACCES/竞态删除会抛异常冒泡到启动流程崩溃
    // 审查修复（四轮）：`return results` 引用未定义变量（作用域内只有 checks）→ 修复即崩点；且 early
    // return 会跳过 Schema version/Stale socket/Tool registry 等后续检查——改 entries 有效性门控
    let entries
    try { entries = readdirSync(toolsDir, { withFileTypes: true }) } catch (e) {
      add('Tool manifests', 'FAIL', `cannot read ${toolsDir}: ${e.message}`)
    }
    let total = 0
    let bad = 0
    const badNames = []
    if (entries) {
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
    }
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

  return { status: ok ? 'ok' : 'warn', checks, ...(parserIdentity ? { parser_identity: parserIdentity } : {}), ...(buildInfo ? { build: buildInfo } : {}), timestamp: Date.now() }
}

/**
 * 工作区索引库自清理（治本 B）：按 last activity 超 maxAgeDays 删除 stale 工作区缓存。
 * 索引库是可重建缓存（删了下次 reindex 即恢复），故 prune 安全——源码不受影响。
 * 判据取多信号最新值：目录内所有文件 mtime + metadata.json 的 last_accessed 字段，
 * 避免误删「只读查询、未重新索引」的活跃库；无法判定时间一律保守保留。
 * @param {string} workspacesDir - stateDir/workspaces
 * @param {object} [opts]
 * @param {number} [opts.maxAgeDays=3] - 超期阈值（天）
 * @param {boolean} [opts.dryRun=false] - 只报告不删
 * @param {string[]} [opts.protect=[]] - 永不删除的工作区 hash 列表
 */
export function cleanupStaleWorkspaces(workspacesDir, opts = {}) {
  const { maxAgeDays = 3, dryRun = false, protect = [] } = opts
  if (!workspacesDir || !existsSync(workspacesDir)) {
    return { status: 'no_workspaces_dir', max_age_days: maxAgeDays, deleted_count: 0, freed_mb: 0, deleted: [], kept_count: 0 }
  }
  const maxAgeMs = maxAgeDays * 86400000
  const now = Date.now()
  // S3.3（T14）：永不删除的目录名/内容标记——即使误传状态根，也不误删任务/日志/job 活跃资产
  const KEEP_DIR_NAMES = new Set(['entry-tasks', 'jobs', 'journal', 'batches', 'workspaces'])
  const KEEP_MARKERS = new Set(['entry-tasks', 'jobs', 'journal', 'batches'])
  const deleted = []
  let keptCount = 0
  let freedBytes = 0
  for (const e of readdirSync(workspacesDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    if (protect.includes(e.name)) { keptCount++; continue }
    if (KEEP_DIR_NAMES.has(e.name)) { keptCount++; continue } // T14 保留名
    const wsDir = join(workspacesDir, e.name)
    let files
    try { files = readdirSync(wsDir) } catch { keptCount++; continue }
    if (files.some(f => KEEP_MARKERS.has(f))) { keptCount++; continue } // T14 含活跃资产标记
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
  // R10：.corrupt-* 损坏备份文件清理——保留最近 10 个（无论 mtime），仅超龄且超上限者删除
  {
    const corruptFiles = []
    for (const e of readdirSync(workspacesDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      const wsDir = join(workspacesDir, e.name)
      let files
      try { files = readdirSync(wsDir) } catch { continue }
      for (const f of files) {
        if (!f.startsWith('code-index.db.corrupt-')) continue
        try {
          const st = statSync(join(wsDir, f))
          corruptFiles.push({ path: join(wsDir, f), mtimeMs: st.mtimeMs })
        } catch {}
      }
    }
    corruptFiles.sort((a, b) => b.mtimeMs - a.mtimeMs)
    const keepCount = 10
    corruptFiles.slice(keepCount).forEach((c, i) => {
      const ageMs = now - c.mtimeMs
      if (ageMs > maxAgeMs) {
        if (!dryRun) {
          try { rmSync(c.path, { force: true }) } catch {}
        }
        deleted.push({ corrupt_backup: c.path, age_days: Math.round(ageMs / 86400000 * 10) / 10 })
      }
    })
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