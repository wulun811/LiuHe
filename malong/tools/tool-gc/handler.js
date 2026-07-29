export async function handle(args, context) {
  const memBefore = process.memoryUsage()

  if (typeof global.gc !== 'function') {
    return {
      error: 'gc_not_available',
      message: 'GC not available. Start server with: node --expose-gc mcp-server.js',
      memory: {
        rss_mb: Math.round(memBefore.rss / 1024 / 1024),
        heap_used_mb: Math.round(memBefore.heapUsed / 1024 / 1024),
        heap_total_mb: Math.round(memBefore.heapTotal / 1024 / 1024)
      }
    }
  }

  global.gc()

  const memAfter = process.memoryUsage()
  return {
    status: 'collected',
    memory_before: {
      rss_mb: Math.round(memBefore.rss / 1024 / 1024),
      heap_used_mb: Math.round(memBefore.heapUsed / 1024 / 1024),
      heap_total_mb: Math.round(memBefore.heapTotal / 1024 / 1024)
    },
    memory_after: {
      rss_mb: Math.round(memAfter.rss / 1024 / 1024),
      heap_used_mb: Math.round(memAfter.heapUsed / 1024 / 1024),
      heap_total_mb: Math.round(memAfter.heapTotal / 1024 / 1024)
    },
    collected: {
      rss_mb: Math.round((memBefore.rss - memAfter.rss) / 1024 / 1024),
      heap_mb: Math.round((memBefore.heapUsed - memAfter.heapUsed) / 1024 / 1024)
    }
  }
}
