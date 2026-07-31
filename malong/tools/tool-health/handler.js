import { readUsageStats, cleanupStaleWorkspaces } from '../../health-check.js'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

export async function handle(args, context) {
  const { runHealthCheck, stateDir } = context
  if (!runHealthCheck) {
    return { error: 'service_unavailable', message: 'health check service not available' }
  }

  const action = args?.action || 'check'

  if (action === 'restart') {
    // 软重启：重置服务状态，不杀进程
    const restartLog = join(stateDir || '/tmp', 'restart.log')
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
        next_step: 'If issues persist, consider restarting opencode.',
      }

      appendFileSync(restartLog, `[${ts}] restart completed, RSS: ${result.before.memory.rss_mb}MB -> ${result.after.memory.rss_mb}MB\n`)

      return result
    } catch (e) {
      return {
        status: 'restart_failed',
        error: e.message,
        message: 'Soft restart failed. Consider restarting opencode.',
      }
    }
  }

  if (action === 'cleanup') {
    const maxAgeDays = Number(args?.max_age_days) > 0 ? Number(args.max_age_days) : 14
    const dryRun = args?.dry_run === true
    const result = cleanupStaleWorkspaces(context.workspacesDir, { maxAgeDays, dryRun })
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
