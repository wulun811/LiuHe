import { readUsageStats } from '../../health-check.js'

export async function handle(args, context) {
  const { runHealthCheck } = context
  if (!runHealthCheck) {
    return { error: 'service_unavailable', message: 'health check service not available' }
  }
  const result = await runHealthCheck()
  if (args?.stats) {
    result.usage_stats = readUsageStats()
  }
  return result
}