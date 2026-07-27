// 六合工具集 — symbol_search handler

export async function handle(args, context) {
  const { codeIndexService } = context

  if (!codeIndexService) {
    return { error: 'codeIndex service not available' }
  }

  const query = args?.query || ''
  const limit = args?.limit || 30

  if (!query) {
    return { error: 'query parameter required' }
  }

  const results = await codeIndexService.searchSymbols(query, { limit })
  return { results, count: results.length, query }
}
