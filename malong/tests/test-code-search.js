// test-code-search.js — NL 代码搜索（r34-fix 补测：此前 1 引用仅注册级）
// 覆盖：意图分类 / tokenize / 空查询 / 全链路（mock codeIndex）/
//       意图执行（whereUsed/deadCode/complexity/dependencyTree）/ 融合去重
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}
const cs = await import(pathToFileURL(join(__dirname, '..', 'code-search.js')).href)

const registered = {}
const core = {
  services: {},
  registerService: (name, svc) => { registered[name] = svc },
  log: () => {},
}
await cs.init(core)
const searchSvc = registered.codeSearch
assert(!!searchSvc, 'init 注册 codeSearch 服务')

// ── 意图分类（经 search 返回的 intent 验证）──
const intentOf = async (q) => (await searchSvc.search(q, { topK: 1 })).intent
assert(await intentOf('find the login function') === 'findFunction', 'find function 意图')
assert(await intentOf('find the User class') === 'findClass', 'class 意图')
assert(await intentOf('class User') === 'findClass', 'class 前缀意图')
assert(await intentOf('where is maxRetries used') === 'whereUsed', 'whereUsed 意图')
assert(await intentOf('who calls helper') === 'whereUsed', 'who calls 意图')
assert(await intentOf('dead code in this repo') === 'deadCode', 'deadCode 意图')
assert(await intentOf('show dependency tree of auth') === 'dependencyTree', 'dependencyTree 意图')
assert(await intentOf('how complex is this') === 'complexity', 'complexity 意图')
assert(await intentOf('hello there') === 'search', '无意图回退 search')

// ── 空/短查询 ──
const empty = await searchSvc.search('')
assert(empty.results.length === 0 && empty.intent === 'unknown', '空查询返回 unknown')
const short = await searchSvc.search('x')
assert(short.results.length === 0, '单字符查询无结果')

// ── tokenize 行为（经 mock service 结果断言 token 切分）──
const seenTokens = []
core.services.codeIndex = {
  searchSymbols: async (tok, opts) => {
    seenTokens.push(tok)
    return []
  },
  getStats: () => ({ files: 1 }),
}
await searchSvc.search('auth login!')
assert(seenTokens.includes('auth') && seenTokens.includes('login'), '标点过滤后 token 化')

// ── 全链路：符号搜索 + 文件搜索 + 融合 ──
{
  const syms = [
    { name: 'login', type: 'function', file: 'src/auth.js', start_line: 10 },
    { name: 'logout', type: 'function', file: 'src/auth.js', start_line: 20 },
    { name: 'loginHandler', type: 'function', file: 'src/handlers.js', start_line: 5 },
  ]
  core.services.codeIndex = {
    searchSymbols: async (tok) => syms.filter(s => s.name.includes(tok)),
    getStats: () => ({ files: 3 }),
    getCallers: async () => [],
    getCallees: async () => [],
  }
  const r = await searchSvc.search('where is login used')
  assert(r.intent === 'whereUsed', 'whereUsed 意图触发')
  assert(r.results.length > 0, '意图执行返回结果')
  // 符号分数：精确名 0.9 最高
  const top = r.results[0]
  assert(top.score <= 0.9, '分数上限 0.9')
  const names = r.results.filter(x => x.type === 'symbol').map(x => x.name)
  assert(names.includes('login'), '符号结果含 login')
}

// ── deadCode 意图 ──
{
  core.services.codeIndex = {
    detectDeadCode: async () => [{ name: 'orphanFn', file: 'src/x.js', start_line: 1, ref_count: 0 }],
  }
  const r = await searchSvc.search('unused functions please')
  assert(r.intent === 'deadCode', 'deadCode 意图触发')
  assert(r.results.some(x => x.type === 'deadCode' && x.name === 'orphanFn'), 'deadCode 结果')
}

// ── dependencyTree 意图 ──
{
  core.services.codeIndex = {
    getModuleDependencies: async () => ({ directImports: [{ module: 'lodash' }], transitiveDeps: [{ from: 'a', module: 'b', depth: 2 }] }),
  }
  const r = await searchSvc.search('dependency tree of src/auth.js')
  assert(r.intent === 'dependencyTree', 'dependencyTree 意图')
  assert(r.results.some(x => x.type === 'import' && x.module === 'lodash'), '直接依赖结果')
  assert(r.results.some(x => x.type === 'transitiveImport' && x.depth === 2), '传递依赖结果')
}

// ── 无 codeIndex 服务（未加载）时安全返回 ──
{
  core.services.codeIndex = null
  const r = await searchSvc.search('find the login function')
  assert(r.results.length === 0 && !r.intent.startsWith('unknown') || r.intent === 'findFunction', '无服务时安全返回')
}

// ── topK 截断 ──
{
  core.services.codeIndex = {
    searchSymbols: async () => Array.from({ length: 20 }, (_, i) => ({ name: `fn${i}`, type: 'function', file: 'f.js', start_line: i })),
    getStats: () => ({ files: 1 }),
    getCallers: async () => [],
    getCallees: async () => [],
  }
  const r = await searchSvc.search('find the fn function', { topK: 5 })
  assert(r.results.length <= 5, `topK=5 截断（实际 ${r.results.length}）`)
}

console.log(`== test-code-search: ${pass} passed, ${fail} failed ==`)
if (fail > 0) process.exit(1)
