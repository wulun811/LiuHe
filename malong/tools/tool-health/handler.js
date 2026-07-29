export async function handle(args, context) {
  const { runHealthCheck } = context
  if (!runHealthCheck) {
    return { error: 'service_unavailable', message: 'health check service not available' }
  }
  return await runHealthCheck()
}