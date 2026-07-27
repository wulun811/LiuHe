// 六合工具集 — references handler

export async function handle(args, context) {
  const { codeIndexService } = context

  if (!codeIndexService) {
    return { error: 'codeIndex service not available' }
  }

  const symbol = args?.symbol || ''
  if (!symbol) {
    return { error: 'symbol parameter required' }
  }

  const results = await codeIndexService.getReferences(symbol, args?.file)
  return { symbol, results, count: results.length }
}
