// code_query 契约测试（P2 切片2）：参数校验失败路径 + graph 可见性 + 只读边界。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { handle, sanitizeAdvisory, sanitizeGraphActions } from '../tools/tool-code-query/handler.js'
import ToolRegistry from '../tool-registry.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  FAIL:', msg) } }

const ctx = {} // 参数校验在触碰 context 前返回，故空 context 安全

// 1. 缺 workspace_dir
let r = await handle({ mode: 'outline', file: 'a.js' }, ctx)
assert(r.ok === false && r.error === 'missing_parameter', '缺 workspace_dir → missing_parameter')

// 2. 非法 mode
r = await handle({ workspace_dir: '/x', mode: 'nope' }, ctx)
assert(r.ok === false && r.error === 'missing_parameter' && /mode must be one of/.test(r.message), '非法 mode → missing_parameter（列合法值）')
assert(typeof r.suggestion === 'string' && r.suggestion.length > 0, '非法 mode 带 suggestion 示例')

// 3. 各 mode 缺必填锚点
r = await handle({ workspace_dir: '/x', mode: 'outline' }, ctx)
assert(r.ok === false && /outline requires file/.test(r.message), 'outline 缺 file → 报错')
r = await handle({ workspace_dir: '/x', mode: 'symbols' }, ctx)
assert(r.ok === false && /symbols requires query/.test(r.message), 'symbols 缺 query → 报错')
r = await handle({ workspace_dir: '/x', mode: 'references' }, ctx)
assert(r.ok === false && /references requires symbol/.test(r.message), 'references 缺 symbol → 报错')
r = await handle({ workspace_dir: '/x', mode: 'callers' }, ctx)
assert(r.ok === false && /callers requires file/.test(r.message), 'callers 缺 file → 报错')
r = await handle({ workspace_dir: '/x', mode: 'impact' }, ctx)
assert(r.ok === false && /impact requires file/.test(r.message), 'impact 缺 file → 报错')
r = await handle({ workspace_dir: '/x', mode: 'search' }, ctx)
assert(r.ok === false && /search requires query/.test(r.message), 'G2-A search 缺 query → 报错')
r = await handle({ workspace_dir: '/x', mode: 'tests' }, ctx)
assert(r.ok === false && /tests requires file/.test(r.message), 'G2-A tests 缺 file → 报错')
r = await handle({ workspace_dir: '/x', mode: 'validate' }, ctx)
assert(r.ok === false && /validate requires file/.test(r.message), 'G2-A validate 缺 file → 报错')
r = await handle({ workspace_dir: '/x', mode: 'validate', file: 'a.js' }, ctx)
assert(r.ok === false && /new_content/.test(r.message), 'G2-A validate 缺 new_content → 报错')

// 4. 所有失败都带 trace_id（可诊断）
assert(typeof r.trace_id === 'string' && r.trace_id.length > 0, '失败含 trace_id')

// 5. graph 可见性（read-only，无 state 也可见）
const toolsDir = join(__dirname, '..', 'tools')
const prev = process.env.MALONG_INTERFACE
process.env.MALONG_INTERFACE = 'graph'
delete process.env.MALONG_ENTRY_STATE
const reg = new ToolRegistry(toolsDir, { log: () => {} })
await reg.loadAll()
assert(reg.hasTool('code_query'), 'graph env（无 state）加载 code_query（只读入口）')
process.env.MALONG_INTERFACE = prev === undefined ? '' : prev
if (prev === undefined) delete process.env.MALONG_INTERFACE

// 6. 只读合同：handler 源码不得含写路径调用（静态自检，防未来误接写）
import { readFileSync } from 'node:fs'
const src = readFileSync(join(__dirname, '..', 'tools', 'tool-code-query', 'handler.js'), 'utf-8')
assert(!/import[\s\S]*?from\s+['"][^'"]*tool-(batch-edit|write-symbol|write-symbols|edit-transaction|code-batch|code-patch)[^'"]*['"]/.test(src), 'code_query 不导入写路径 handler（只读合同）')
assert(!/\b(writeSymbols|writeSymbol|batchEdit|editTransaction|updateTaskCas)\s*\(/.test(src), 'code_query 不调用写原语（只读合同；建议文本里提到工具名不算写路径）')

// 7. F2（接线核对 L02）：建议字段不得点名 graph 隐藏工具
const HIDDEN = ['impact_analysis', 'call_chain', 'code_search', 'read_symbol', 'sandbox_validate', 'references', 'find_tests', 'test_bridge', 'reindex', 'symbol_search', 'repo_map', 'outline_reader']
// G2-A（ADR-019 D1）例外裁定：原名仅允许出现在保底出口的 name= 位置（invoke_capability/describe）；
// 先刮掉 name=xxx、name="xxx"、name='xxx' 再检查——裸呼/裸名仍判失败（防挂名回归）。
function noHidden(s) {
  const scrubbed = String(s).replace(/name\s*=\s*['"]?[A-Za-z_][A-Za-z0-9_]*['"]?/g, 'name=<cap>')
  return !HIDDEN.some(h => new RegExp('(?<![A-Za-z0-9_])' + h + '(?![A-Za-z0-9_])').test(scrubbed))
}
const samples = [
  'Before editing, check callers: impact_analysis(file="a.js", symbol="foo")',
  'Try a shorter substring, or use code_search with a natural-language query.',
  'Before modifying found symbols, check blast radius: impact_analysis(symbol="bar")',
  'For test refs: find_tests(file="a.js")',
  'After modifying, verify: test_bridge(action="run")',
  'High risk. Before modifying: sandbox_validate(workspace_dir="/w", file="a.js", new_content=...) ... test_bridge(action="run")',
  'reindex(workspace_dir="/w") if files were recently added',
]
for (const s of samples) assert(noHidden(sanitizeAdvisory(s)), 'F2 清洗后无隐藏工具: ' + s.slice(0, 44))
const wrapped = sanitizeGraphActions({ next_step: 'see impact_analysis(x)', suggestion: 'use find_tests(file="a")', results: [{ context: 'foo(impact_analysis)' }] })
assert(noHidden(wrapped.next_step), 'F2 next_step 已清洗')
assert(noHidden(wrapped.suggestion), 'F2 suggestion 已清洗')
assert(wrapped.results[0].context === 'foo(impact_analysis)', 'F2 正文 context 保持原样（只改建议字段，不误改代码片段）')
// 7b. G2-A（ADR-019 D1）：假替代修正——有真分支走真分支，无真分支指向 ADR-018 保底出口
const g2aSamples = [
  ['Before writing: sandbox_validate(workspace_dir="/w", file="a.js", new_content=c) ran?', "code_query(mode='validate'"],
  ['Related tests: find_tests(file="src/a.js")', "code_query(mode='tests'"],
  ['No symbol hit; try code_search("token refresh") for intent search.', "code_query(mode='search'"],
  ['Scoped run: test_bridge(action="run", scope="src")', "invoke_capability(name='test_bridge'"],
  ['Stale index: reindex(workspace_dir="/w") then retry.', "invoke_capability(name='reindex'"],
]
for (const [srcS, want] of g2aSamples) {
  const out = sanitizeAdvisory(srcS)
  assert(out.includes(want), 'G2-A 真分支持久: ' + srcS.slice(0, 40) + ' → ' + want)
  assert(noHidden(out), 'G2-A 改写后无裸隐藏名: ' + out.slice(0, 60))
}
// 狗粮r3（P2）：括号内参数被保留为具体 args（旧实现丢成 args={...} 不可执行占位）
assert(sanitizeAdvisory('Run: test_bridge(action="run", scope="src/a.test.js")').includes('args={"action":"run","scope":"src/a.test.js"}'), '狗粮r3 test_bridge 参数保留为具体 args')
assert(!sanitizeAdvisory('Next: test_bridge(action="run")').includes('...'), '狗粮r3 不再输出 args={...} 占位')
assert(!/mode='symbols'/.test(sanitizeAdvisory('Use code_search("auth flow") please')), 'G2-A 不再把 code_search 冒充 mode=symbols')
assert(!/code_check\(checks=\['test'\]\)/.test(sanitizeAdvisory('Next: find_tests(file="a.js")')), 'G2-A 不再把 find_tests 冒充 code_check(test)')
assert(/invoke_capability\(name='reindex'\)/.test(sanitizeAdvisory('run reindex now')), 'G2-A 裸名 reindex 也指向保底出口')
assert(!/invoke_capability\(name='invoke_capability/.test(sanitizeAdvisory('Stale index: reindex(workspace_dir="/w") then retry.')), 'G2-A 二次回写不自套（lookbehind 防双击）')

// 8. F1/F5 manifest 契约
const mf = JSON.parse(readFileSync(join(__dirname, '..', 'tools', 'tool-code-query', 'manifest.json'), 'utf-8'))
assert(mf.inputSchema.properties.kind, 'F5 manifest 声明 kind')
assert(Array.isArray(mf.inputSchema.allOf) && mf.inputSchema.allOf.length >= 1, 'F1 manifest 条件必填 allOf（callers/callees/impact 需 file）')

// 9. F3/F4（Phase2-b2）：mode=map/body 接线（参数校验层）
r = await handle({ workspace_dir: '/x', mode: 'body' }, ctx)
assert(r.ok === false && /body requires/.test(r.message), 'F4 body 缺 file/symbol → 报错')
// 狗粮r3（P3）：callers/callees 缺 symbol/line → 明确报错（不再下沉 call_chain 的模糊信息）
const ccNoSym = await handle({ workspace_dir: '/x', mode: 'callers', file: 'a.js' }, ctx)
assert(ccNoSym.ok === false && /requires symbol/.test(ccNoSym.message), '狗粮r3 callers 缺 symbol/line → 明确报错（得 ' + (ccNoSym.message || ccNoSym.error) + '）')
r = await handle({ workspace_dir: '/x', mode: 'map' }, ctx)
assert(r.ok === false && r.error === 'capability_unavailable', 'F3 map 无 repoMapService → capability_unavailable')
const badMode = await handle({ workspace_dir: '/x', mode: 'nope' }, ctx)
assert(/\bmap\b/.test(badMode.message) && /\bbody\b/.test(badMode.message), 'F3/F4 非法 mode 提示含 map/body')
assert(mf.inputSchema.properties.max_tokens && mf.inputSchema.properties.page_size, 'F3 manifest 声明 map 参数')
assert(mf.inputSchema.properties.budget_hint && mf.inputSchema.properties.rich, 'F4 manifest 声明 body 参数')
// 8b. G2-A：manifest 声明 search/tests/validate 与 new_content
const modeEnum = mf.inputSchema.properties.mode.enum || []
for (const mm of ['search', 'tests', 'validate']) assert(modeEnum.includes(mm), 'G2-A manifest mode 含 ' + mm)
assert(mf.inputSchema.properties.new_content, 'G2-A manifest 声明 new_content')
assert((mf.inputSchema.allOf || []).some(x => JSON.stringify(x).includes('validate')), 'G2-A allOf 覆盖 validate')

// 10. F4 运行路径守卫（R22 失败路径）：mode=body 不得因缺 import 抛 ReferenceError
import { mkdtempSync, mkdirSync, writeFileSync as _wf } from 'node:fs'
import { tmpdir } from 'node:os'
const _dir = mkdtempSync(join(tmpdir(), 'cq-body-'))
_wf(join(_dir, 'a.js'), 'export function foo(x) { return x + 1 }\n')
const _stubCtx = { codeIndexService: new Proxy({}, { get: () => (async () => ({})) }) }
let _threw = null, _bodyRes
try { _bodyRes = await handle({ workspace_dir: _dir, mode: 'body', file: 'a.js', symbol: 'foo' }, _stubCtx) } catch (e) { _threw = e }
assert(_threw === null, 'F4 body 不抛异常（import 完整；曾因缺 readSymbolHandle 崩）: ' + (_threw && _threw.message))
assert(_bodyRes && typeof _bodyRes === 'object', 'F4 body 返回对象')
if (_bodyRes && _bodyRes.ok) assert(_bodyRes.boundaries && _bodyRes.boundaries.read_only === true, 'F4 body 结果含 boundaries（诚实边界，不回归）')

// 11. F6（专家 §9.7）：callers/callees 不得只取数组——须保留底层覆盖说明（截断/元数据/target）
const _ccDir = mkdtempSync(join(tmpdir(), 'cq-cc-'))
_wf(join(_ccDir, 'code-index.db'), '')
const _ccCtx = {
  getWorkspaceDir: () => _ccDir,
  codeIndexService: {
    initWorkspace: async () => {},
    resolveFileArg: (f) => ({ ok: true, path: f }),
    getSymbolsAtLine: async () => [],
    getImpactAnalysis: async () => ({
      target_symbol: 'foo', risk_level: 'low',
      callers: [{ file: 'b.js', line: 3, function: 'bar', type: 'call' }],
      callees: [{ file: 'c.js', line: 5, function: 'baz' }],
      truncated_callers: true, truncated_callees: false,
      caller_count: { direct: 1, indirect: 0 }, freshness: null,
    }),
  },
}
const _cc = await handle({ workspace_dir: _ccDir, mode: 'callers', file: 'a.js', symbol: 'foo', line: 1 }, _ccCtx)
assert(_cc.ok === true, 'F6 callers 正常返回')
assert(Array.isArray(_cc.result.callers) && _cc.result.callers.length === 1, 'F6 callers 数组保留')
assert(_cc.result.truncated_callers === true, 'F6 保留 truncated_callers（覆盖说明不丢）')
assert(_cc.result.metadata && typeof _cc.result.metadata.total_callers === 'number', 'F6 保留 metadata')
assert(_cc.result.target && _cc.result.target.symbol === 'foo', 'F6 保留 target')
assert(!('callees' in _cc.result), 'F6 非请求数组（callees）不外泄')
assert(_cc.boundaries && /Static call graph/.test(_cc.boundaries.note), 'F6 boundaries 明示静态调用图扫描范围（非通用 note）')

// 12. G2-A 运行级：tests/validate/search 真委派（失败路径先红后绿）
const _g2Dir = mkdtempSync(join(tmpdir(), 'cq-g2a-'))
mkdirSync(join(_g2Dir, 'src'), { recursive: true })
_wf(join(_g2Dir, 'src', 'a.js'), 'export function foo(x) { return x + 1 }\n')
_wf(join(_g2Dir, 'src', 'a.test.js'), '// tests\n')
const _tRes = await handle({ workspace_dir: _g2Dir, mode: 'tests', file: 'src/a.js' }, {})
assert(_tRes.ok === true && Array.isArray(_tRes.result.by_convention), 'G2-A tests 正常返回候选')
assert(_tRes.result.by_convention.some(c => c.path === 'src/a.test.js' && c.exists === true), 'G2-A tests 命中约定测试文件')
const _vOk = await handle({ workspace_dir: _g2Dir, mode: 'validate', file: 'src/a.js', new_content: 'export function foo(x) { return x + 1 }\n' }, {})
assert(_vOk.ok === true && _vOk.result.valid === true, 'G2-A validate 候选内容合法 → valid:true')
const _vBad = await handle({ workspace_dir: _g2Dir, mode: 'validate', file: 'src/a.js', new_content: 'export function foo(x { return }\n' }, {})
assert(_vBad.ok === true && _vBad.result.valid === false && _vBad.result.summary.errors >= 1, 'G2-A validate 坏内容 → valid:false + errors')
assert(_vBad.boundaries && _vBad.boundaries.read_only === true, 'G2-A validate 明示只读边界')
const _srch = await handle({ workspace_dir: _g2Dir, mode: 'search', query: 'foo' }, {})
assert(_srch.ok === false && _srch.error === 'capability_unavailable', 'G2-A search 无服务 → capability_unavailable（typed，不裸崩）')

// 13. G2-B（ADR-019 D2）：options 校验透传（黑名单/白名单/运行级)
let _o = await handle({ workspace_dir: '/x', mode: 'outline', options: 'nope' }, ctx)
assert(_o.ok === false && _o.error === 'invalid_input', 'G2-B options 非对象 → invalid_input')
_o = await handle({ workspace_dir: '/x', mode: 'outline', options: { workspace_dir: '/evil' } }, ctx)
assert(_o.ok === false && /protected key/.test(_o.message) && /workspace_dir/.test(_o.message), 'G2-B options 不可覆盖受保护键')
_o = await handle({ workspace_dir: '/x', mode: 'outline', options: { nope: 1 } }, ctx)
assert(_o.ok === false && /unknown options/.test(_o.message) && /include_refs/.test(_o.suggestion || ''), 'G2-B 未知 option → invalid_input 且列白名单')
_o = await handle({ workspace_dir: '/x', mode: 'validate', options: { max_items: 1 } }, ctx)
assert(_o.ok === false && /takes no options/.test(_o.suggestion || ''), 'G2-B 无 options 的 mode → 明示不接受')
let _ocap = null
_wf(join(_g2Dir, 'code-index.db'), '')
const _oCtx = {
  getWorkspaceDir: () => _g2Dir,
  codeIndexService: {
    initWorkspace: async () => {},
    resolveFileArg: (f) => ({ ok: true, path: f }),
    getSymbolsAtLine: async () => [],
    getImpactAnalysis: async (ff, o) => { _ocap = { ff, o }; return { target_symbol: 'foo', risk_level: 'low', callers: [{ file: 'b.js', line: 1, function: 'bar', type: 'call' }], callees: [], caller_count: { direct: 1, indirect: 0 }, freshness: null } },
  },
}
const _oc = await handle({ workspace_dir: _g2Dir, mode: 'callers', file: 'src/a.js', symbol: 'foo', line: 1, options: { max_callers: 3, max_callees: 7 } }, _oCtx)
assert(_oc.ok === true, 'G2-B options callers 运行正常')
assert(_ocap && _ocap.o && _ocap.o.maxCallers === 7, 'G2-B options.max_callers/max_callees 透传到原工具（服务收到 max=7）')

// 14. R22 失败路径（真阳性修复 #2，2026-10-12）：mode=map 冷启动必须走「自动索引后重试」，不得直接报死胡同
// 背景：map 分支把 workspace_not_indexed 包成 {fail} 提前返回，永不触达入口自带的 ensureIndexed 重试
// （outline 等模式为 {r:{error}} 形状，可自愈；map 是唯一漏网路径——真机上表现为冷工作区首个 map 必失败）
const _mapDir = mkdtempSync(join(tmpdir(), 'cq-mapretry-'))
_wf(join(_mapDir, 'z.js'), 'export const z = 9\n')
let _mapCalls = 0, _indexCalls = 0
const _mapCtx = {
  codeIndexService: {
    initWorkspace: async () => {},
    indexBatch: async () => { _indexCalls++; return [] },
  },
  repoMapService: {
    generateCompact: async () => {
      _mapCalls++
      if (_mapCalls === 1) return { error: 'workspace_not_indexed', message: 'Workspace not indexed: ' + _mapDir, suggestion: 'Call reindex' }
      return { map: 'z/', tokens: 1, skeleton: [], truncated: false }
    },
  },
}
const _mr = await handle({ workspace_dir: _mapDir, mode: 'map' }, _mapCtx)
assert(_mr.ok === true && _mr.result && _mr.result.map === 'z/', 'map 冷启动自动索引后重试成功（得 ok=' + _mr.ok + ' err=' + _mr.error + '）')
assert(_mapCalls === 2 && _indexCalls === 1, 'map 重试 1 次且 ensureIndexed 执行 1 次（得 calls=' + _mapCalls + ' index=' + _indexCalls + '）')
let _mapCalls2 = 0
const _mapCtx2 = {
  codeIndexService: { initWorkspace: async () => {}, indexBatch: async () => { return [] } },
  repoMapService: { generateCompact: async () => { _mapCalls2++; return { error: 'workspace_not_indexed', message: 'still not indexed', suggestion: 'x' } } },
}
const _mr2 = await handle({ workspace_dir: _mapDir, mode: 'map' }, _mapCtx2)
assert(_mr2.ok === false && _mr2.error === 'workspace_not_indexed', 'map 重试仍失败 → 保留 typed 错误不吞（得 ok=' + _mr2.ok + ' err=' + _mr2.error + '）')

// 15. P1 修复（2026-10-12 狗粮）：repo_map 陈旧检测只比「应被索引的代码文件」——
// 旧实现遍历磁盘全部文件，非代码文件（README/package.json，永不进索引）mtime 恒大于索引基线 → 永久误报且 reindex 清不掉
import { statSync as _stat } from 'node:fs'
import { pathToFileURL } from 'node:url'
const { checkRepoMapStaleness } = await import(pathToFileURL(join(__dirname, '..', 'repo-map.js')).href)
const _stDir = mkdtempSync(join(tmpdir(), 'cq-stale-'))
_wf(join(_stDir, 'a.js'), 'export const a = 1\n')
_wf(join(_stDir, 'README.md'), '# doc\n')
const _aMtime = _stat(join(_stDir, 'a.js')).mtimeMs
const _dbStub = (m) => ({ prepare: () => ({ get: () => ({ m }) }) })
assert(checkRepoMapStaleness(_dbStub(_aMtime + 1000), _stDir) === null, 'P1 陈旧检测：非代码文件更新不算 stale（旧实现误报）')
assert(checkRepoMapStaleness(_dbStub(_aMtime - 1000), _stDir) !== null, 'P1 陈旧检测：代码文件比索引新 → 报 stale')
_wf(join(_stDir, 'README.md'), '# doc v2\n')
assert(checkRepoMapStaleness(_dbStub(_aMtime + 1000), _stDir) === null, 'P1 陈旧检测：只更新 README 仍不报 stale')

console.log('=== test-code-query: ' + pass + ' passed, ' + fail + ' failed ===')
process.exit(fail ? 1 : 0)
