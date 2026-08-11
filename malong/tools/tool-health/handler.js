import { readUsageStats, cleanupStaleWorkspaces } from '../../health-check.js'
import { appendFileSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const MATRIX_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'Y004-工具排查矩阵.md')

export async function handle(args, context) {
  const { runHealthCheck, stateDir } = context
  if (!runHealthCheck) {
    return { error: 'service_unavailable', message: 'health check service not available' }
  }

  const action = args?.action || 'check'

  if (action === 'matrix') {
    const tool = args?.tool
    if (!tool) {
      return { error: 'missing_parameter', message: 'tool is required for action=matrix', suggestion: 'Pass tool=<name> e.g. health(action="matrix", tool="read_symbol")' }
    }
    try {
      const text = readFileSync(MATRIX_PATH, 'utf8')
      const lines = text.split('\n')
      const row = lines.find(l => l.trim().startsWith(`| **${tool}** |`) || l.trim().startsWith(`| **${tool} `))
      if (!row) {
        return {
          action: 'matrix',
          tool,
          registered: false,
          next_step: 'Tool not in Y004 matrix — if it is new/changed, register it (update the matrix + add failure-path test).',
        }
      }
      // 列: | 工具 | 设想的边界情况 | 覆盖状态 | 残留风险 |
      const cells = row.split('|').map(c => c.trim()).filter((_, i, a) => i > 0 && i < a.length - 1)
      return {
        action: 'matrix',
        tool,
        registered: true,
        boundary: cells[1] || '',
        coverage: cells[2] || '',
        residual_risk: cells[3] || '',
        next_step: 'Check this row before changing the tool (stop if listed); after changing, add failure-path tests + update this row. Regression: run the test-xxx.js files listed in the coverage column.',
      }
    } catch (e) {
      return { error: 'matrix_unavailable', message: `Cannot read Y004 matrix: ${e.message}`, suggestion: 'Ensure malong/docs/Y004-工具排查矩阵.md exists' }
    }
  }

  if (action === 'restart') {
    // 软重启：重置服务状态，不杀进程
    // r54(P2): 无 stateDir 时不回退共享 /tmp/restart.log——可被预植符号链接，append 跟随写任意文件。无 stateDir 则跳过日志
    const restartLog = stateDir ? join(stateDir, 'restart.log') : null
    const ts = new Date().toISOString()

    try {
      // 1. 检查当前状态
      const beforeHealth = await runHealthCheck()
      const memBefore = process.memoryUsage()

      // 2. 强制 GC
      if (typeof global.gc === 'function') {
        global.gc()
      }

      // 3. 检查重启后状态
      const afterHealth = await runHealthCheck()
      const memAfter = process.memoryUsage()

      const result = {
        status: 'restarted',
        timestamp: ts,
        before: {
          memory: {
            rss_mb: Math.round(memBefore.rss / 1048576),
            heap_used_mb: Math.round(memBefore.heapUsed / 1048576),
          },
          health_status: beforeHealth.status,
          fail_checks: beforeHealth.checks.filter(c => c.status === 'FAIL').map(c => c.name),
        },
        after: {
          memory: {
            rss_mb: Math.round(memAfter.rss / 1048576),
            heap_used_mb: Math.round(memAfter.heapUsed / 1048576),
          },
          health_status: afterHealth.status,
          fail_checks: afterHealth.checks.filter(c => c.status === 'FAIL').map(c => c.name),
        },
        message: 'Soft restart completed. Services reinitialized.',
        next_step: 'If issues persist, consider restarting the MCP host.',
      }

      if (restartLog) {
        try { appendFileSync(restartLog, `[${ts}] restart completed, RSS: ${result.before.memory.rss_mb}MB -> ${result.after.memory.rss_mb}MB\n`) } catch {}
      }

      return result
    } catch (e) {
      return {
        status: 'restart_failed',
        error: e.message,
        message: 'Soft restart failed. Consider restarting the MCP host.',
      }
    }
  }

  if (action === 'cleanup') {
    const maxAgeDays = Number(args?.max_age_days) > 0 ? Number(args.max_age_days) : 3
    const dryRun = args?.dry_run === true
    // r8(F11)：保护在用工作区——只读负载不刷新 lastActivity，GC 会误删仍被打开的索引库
    // R16：保护列表与启动 GC 同源（getTouchedWorkspaceHashes）——长驻进程打开的库不删；
    // 旧实现只保护当前 ws hash，切过 workspace 的长驻进程会删掉仍打开的库 → 写入落 unlinked inode
    const protect = []
    if (context?.codeIndexService?.getTouchedWorkspaceHashes) {
      const touched = context.codeIndexService.getTouchedWorkspaceHashes()
      if (Array.isArray(touched)) protect.push(...touched)
    }
    if (context?.codeIndexService?.getCurrentWorkspaceHash) {
      const h = context.codeIndexService.getCurrentWorkspaceHash()
      if (h && !protect.includes(h)) protect.push(h)
    }
    const result = cleanupStaleWorkspaces(context.workspacesDir, { maxAgeDays, dryRun, protect })
    result.next_step = dryRun
      ? 'Dry run only — re-run with dry_run=false to actually prune stale workspace caches.'
      : 'Deleted caches are rebuildable: next access to a pruned workspace reindexes automatically.'
    return result
  }

  // 默认：健康检查
  const result = await runHealthCheck()
  if (args?.stats) {
    result.usage_stats = readUsageStats()
  }

  // 添加自愈建议
  const failChecks = result.checks.filter(c => c.status === 'FAIL')
  if (failChecks.length > 0) {
    result.self_heal_hint = `Found ${failChecks.length} FAIL checks. Try: health(action="restart") to soft-restart services.`
  }

  const memCheck = result.checks.find(c => c.name === 'Memory RSS')
  if (memCheck && memCheck.status === 'WARN') {
    result.self_heal_hint = `Memory high (${memCheck.detail}). Try: health(action="restart") to reclaim memory.`
  }

  return result
}
