// test-r4-file-target-budget.js — R4/H02（0.5.14）显式文件目标直达 + 入口可见文本预算
// R4 现场：中文 document 任务给了 target.file=README.md，却因「无代码符号」退到结构浏览，
// 响应约 43.7k 序列化字符、下一步读无关代码文件；手动 code_read 同文件立刻成功。
// 本测试锁定：① 四类文件目标（中文 Markdown/配置/无符号脚本/代码函数）第一 next_action 均直达目标；
// ② 文件目标入口 ≤6000 可见字符、一般入口 ≤12000（按 JSON 字符串长度计）；③ 目标缺失明确提示；
// ④ fitVisibleBudget 超预算逐级降级且显式记录截断字段（不静默删）。
import { join, dirname } from 'node:path'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP = join(os.tmpdir(), 'opencode', 'r4-entry-budget')
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
process.env.MALONG_STATE_DIR = join(TMP, 'state')
process.env.MALONG_ENTRY_STATE = '1'

let pass = 0, fail = 0
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  FAIL:', msg) } }
const imp = (p) => import(pathToFileURL(p).href)

const WS = join(TMP, 'ws')
mkdirSync(join(WS, 'src'), { recursive: true })
mkdirSync(join(WS, 'scripts'), { recursive: true })
mkdirSync(join(WS, 'config'), { recursive: true })
writeFileSync(join(WS, 'README.md'), '# 项目\n\n## 安装\n\nnpm i\n' + '详细说明。'.repeat(300) + '\n')
writeFileSync(join(WS, 'config', 'app.json'), JSON.stringify({ name: 'app', retries: 3 }))
writeFileSync(join(WS, 'scripts', 'run.cjs'), 'const x = 1\nconsole.log(x)\n')
writeFileSync(join(WS, 'src', 'a.js'), 'export function greet(name) { return "hi " + name }\n')

function mockIndex() {
  return {
    async initWorkspace() {},
    async indexBatch() { return ['src/a.js'] },
    async findDefinitions(name) { return name === 'greet' ? [{ name: 'greet', type: 'function', start_line: 1, end_line: 1, path: 'src/a.js' }] : [] },
    async searchSymbols() { return [] },
    findSymbolsInFile() { return [] },
    async getFileOutline(file) { return { outline: file === 'src/a.js' ? [{ name: 'greet', type: 'function', line: 1, end_line: 1 }] : [] } },
    async getSymbolsAtLine() { return [] },
    getSymbolByStableId() { return null },
    getFileByPath(file) { return { path: file, index_state: 'fresh' } },
  }
}
const ctx = { codeIndexService: mockIndex(), getWorkspaceDir: (w) => w }
const taskMod = await imp(join(__dirname, '..', 'tools', 'tool-code-task', 'handler.js'))
const budget = await imp(join(__dirname, '..', 'workflow', 'output-budget.js'))

// ── ① 四类文件目标直达 + 预算 ──
const cases = [
  { name: '中文 Markdown（无符号文档）', goal: '更新 README 的安装说明', file: 'README.md' },
  { name: '配置', goal: '调整 app 配置', file: 'config/app.json' },
  { name: '无符号脚本', goal: '改 run 脚本', file: 'scripts/run.cjs' },
  { name: '代码函数', goal: '修改 greet 函数', file: 'src/a.js' },
]
for (const c of cases) {
  const r = await taskMod.handle({ workspace_dir: WS, goal: c.goal, target: { file: c.file } }, ctx)
  // N1（0.5.14 Windows 复核）：预算口径是模型最终可见文本（MCP 边界 JSON.stringify(result, null, 2)）
  const len = JSON.stringify(r, null, 2).length
  assert(r.ok === true, `${c.name}: ok（得 ${JSON.stringify(r.error)}）`)
  assert(r.observation?.target_file?.readable === true, `${c.name}: target_file readable`)
  assert(r.next_action?.tool === 'code_read' && r.next_action?.args?.locator?.file_path === c.file, `${c.name}: next_action 指向目标文件（得 ${JSON.stringify(r.next_action?.args?.locator)}）`)
  assert(len <= budget.CODE_TASK_FILE_TARGET_BUDGET, `${c.name}: 可见文本 ≤ ${budget.CODE_TASK_FILE_TARGET_BUDGET} 字符（得 ${len}）`)
  // N1：若声明了预算元信息，其 actual 必须等于最终可见文本长度（含元信息自身）
  const vb = r.observation?.visible_char_budget
  assert(!vb || vb.actual === len, `${c.name}: 声明 actual(${vb?.actual}) = 最终可见长度(${len})`)
  assert(!vb || typeof vb.unit === 'string' && /final_model_visible_text/.test(vb.unit), `${c.name}: 预算单位声明口径（得 ${vb?.unit}）`)
  assert(!(r.observation?.structure || []).length && !r.observation?.navigation, `${c.name}: 文件目标直达不展开结构/导航`)
  assert(String(r.next_step || '').includes('code_read'), `${c.name}: next_step 是可执行读取`)
  if (c.file === 'README.md') assert(String(r.observation?.summary || '').includes('read it directly'), '中文文档任务说明直达原因')
}

// ── ② 一般定位入口（无目标）：预算 ≤12000 ──
{
  const r = await taskMod.handle({ workspace_dir: WS, goal: '更新 README 的安装说明' }, ctx)
  const len = JSON.stringify(r, null, 2).length
  assert(r.ok === true, '一般入口: ok')
  assert(len <= budget.CODE_TASK_GENERAL_BUDGET, `一般定位入口 ≤ ${budget.CODE_TASK_GENERAL_BUDGET} 字符（得 ${len}）`)
  const vb = r.observation?.visible_char_budget
  assert(!vb || vb.actual === len, `一般入口: 声明 actual(${vb?.actual}) = 最终可见长度(${len})`)
  assert(!!r.next_action || !!r.observation?.next_candidates, '一般入口: 给出下一步或下一批候选')
}

// ── ③ 目标缺失：明确提示，不用无关结构掩盖 ──
{
  const r = await taskMod.handle({ workspace_dir: WS, goal: '更新缺失文件', target: { file: 'nope/missing.md' } }, ctx)
  assert(r.observation?.target_file?.readable === false, '缺失目标: target_file.readable=false')
  assert(String(r.observation?.summary || '').includes('NOT found'), '缺失目标: summary 明确提示（得 ' + String(r.observation?.summary).slice(0, 160) + '）')
  assert(r.next_action?.args?.locator?.file_path !== 'nope/missing.md', '缺失目标: 不把不存在文件当可读目标推荐')
}

// ── ⑤ N1（专家 012）：精确 target + 密集候选/测试候选——首屏仍须 ≤6000，
// 只削重复/辅助信息（next_step 重复、候选条数、summary/scope），不丢下一步与安全字段 ──
{
  const richFiles = []
  for (let i = 0; i < 6; i++) richFiles.push('src/m' + i + '.js')
  for (let i = 0; i < 4; i++) richFiles.push('tests/fixtures/case_' + i + '.js')
  for (const f of richFiles) {
    mkdirSync(join(WS, dirname(f)), { recursive: true })
    writeFileSync(join(WS, f), 'export function ' + (f.includes('tests') ? 'fixtureHelper' : 'ledgerLookup') + 'X() { return 1 }\n')
  }
  const richIndex = {
    ...mockIndex(),
    async indexBatch() { return richFiles },
    async findDefinitions(name) {
      if (name !== 'ledgerLookup') return []
      const rows = richFiles.filter(f => !f.includes('tests')).map((f, i) => ({ name: 'ledgerLookup' + i, type: 'function', start_line: 1, end_line: 1, path: f }))
      return rows
    },
    async searchSymbols(term) {
      if (!/ledgerLookup|behavior|rename/i.test(String(term))) return []
      return richFiles.map((f, i) => ({ name: (f.includes('tests') ? 'fixtureHelper' : 'ledgerLookup') + i, type: 'function', path: f, start_line: 1, end_line: 1 }))
    },
    async getFileOutline(file) { return { outline: [{ name: 'ledgerLookup', type: 'function', line: 1, end_line: 1 }] } },
  }
  const richCtx = { codeIndexService: richIndex, getWorkspaceDir: (w) => w }
  const r = await taskMod.handle({
    workspace_dir: WS, goal: 'rename ledgerLookup without changing its behavior', route: 'change',
    target: { file: 'src/m0.js', symbol: 'ledgerLookup' },
  }, richCtx)
  const len = JSON.stringify(r, null, 2).length
  assert(r.ok === true, '⑤ 精确 target: ok（得 ' + JSON.stringify(r.error) + '）')
  assert(len <= budget.CODE_TASK_FILE_TARGET_BUDGET, '⑤ 精确 target: 可见文本 ≤ ' + budget.CODE_TASK_FILE_TARGET_BUDGET + '（得 ' + len + '）')
  assert(r.observation?.visible_char_budget?.actual === len, '⑤ 声明 actual = 最终可见长度（得 ' + r.observation?.visible_char_budget?.actual + ' vs ' + len + '）')
  assert(r.observation?.visible_char_budget?.over_budget_after_steps !== true, '⑤ 降级后确实落入预算（不能只标注超预算）')
  assert(r.next_action?.tool === 'code_read' && (r.next_action?.args?.locator?.file_path === 'src/m0.js' || r.next_action?.args?.locator?.symbol_id), '⑤ 下一步仍直达目标文件/符号（得 ' + JSON.stringify(r.next_action?.args?.locator) + '）')
  const c = r.observation?.candidates || []
  assert(c.length >= 1 && c.length <= 3, '⑤ 候选有界但至少保留 1 条（得 ' + c.length + '）')
  assert(!r.observation?.candidates_truncated || r.observation.candidates_total >= c.length, '⑤ 候选截断有总数可追溯')
  const t = r.observation?.test_path_candidates
  const folded = String(r.observation?.test_path_candidates_omitted || '')
  assert(Array.isArray(t) || t === undefined, '⑤ 测试候选要么保留清单要么显式折叠（得 ' + JSON.stringify(t?.length) + '）')
  assert(!folded || r.observation?.test_path_candidates_total >= 1, '⑤ 折叠时必须给 test_path_candidates_total（得 ' + folded + '）')
}

// ── ⑥ M4（2026-10-19 专家 Windows 复核）：精确单文件目标 + 密集高熵候选仍须 ≤6000；
// 若安全字段使预算无法满足，建议不得再叫用户「Narrow with target」（目标已是最小单位）。
// 另测：未索引/新建的中文单文件目标（getFileOutline 返回空、无符号）同样直达且不因候选爆炸超预算。
{
  const TARGET = '中文 新 文件.js'
  writeFileSync(join(WS, TARGET), 'export function value() { return 1 }\n')
  const PROD = []
  for (let i = 0; i < 8; i++) {
    const f = 'tools/tool-code-query/change-value-handler-' + i + '.js'
    mkdirSync(join(WS, dirname(f)), { recursive: true })
    writeFileSync(join(WS, f), 'export function changeValue' + i + '(v) { return v }\n')
    PROD.push(f)
  }
  const symsOf = (f, i) => [
    { name: 'changeValue' + i, type: 'function', start_line: 1, end_line: 1, signature: 'export function changeValue' + i + '(value: unknown): unknown' },
    { name: 'verifyValue' + i, type: 'function', start_line: 2, end_line: 2, signature: 'export function verifyValue' + i + '(value: unknown): boolean' },
  ]
  const denseIndex = {
    ...mockIndex(),
    async indexBatch() { return PROD },
    async findDefinitions() { return [] },
    async searchSymbols() { return PROD.flatMap((f, i) => symsOf(f, i).map(s => ({ ...s, path: f }))) },
    async getFileOutline(f) {
      const i = PROD.indexOf(f)
      if (i >= 0) return { outline: symsOf(f, i).map(s => ({ ...s, line: s.start_line })) }
      return { outline: [] } // 目标未索引 / 新建：无符号
    },
    findSymbolsInFile(f, name) {
      const i = PROD.indexOf(f)
      return i >= 0 ? [{ name, type: 'function', start_line: 1, end_line: 1, signature: 'export function ' + name + '(v: unknown): unknown', stable_id: 'js:' + f + '::' + name + '#function' }] : []
    },
    async getSymbolsAtLine(f) { const i = PROD.indexOf(f); return i >= 0 ? symsOf(f, i) : [] },
  }
  const denseCtx = { codeIndexService: denseIndex, getWorkspaceDir: (w) => w }
  const r = await taskMod.handle({
    workspace_dir: WS, goal: 'Change value to 2 and verify', route: 'change',
    target: { file: TARGET }, search_terms: ['change', 'value', 'verify', 'set'],
  }, denseCtx)
  const len = JSON.stringify(r, null, 2).length
  assert(r.ok === true, '⑥ M4 中文未索引单文件目标: ok（得 ' + JSON.stringify(r.error) + '）')
  assert(r.observation?.target_file?.readable === true && r.observation.target_file.symbols === 0, '⑥ 目标可读且无索引符号（新建/未索引；得 ' + JSON.stringify(r.observation?.target_file) + '）')
  assert(r.next_action?.tool === 'code_read' && r.next_action?.args?.locator?.file_path === TARGET, '⑥ 下一步直达该文件（得 ' + JSON.stringify(r.next_action?.args?.locator) + '）')
  assert(len <= budget.CODE_TASK_FILE_TARGET_BUDGET, '⑥ M4 可见文本 ≤ ' + budget.CODE_TASK_FILE_TARGET_BUDGET + '（专家现场 6270；得 ' + len + '）')
  const vb = r.observation?.visible_char_budget
  assert(!vb || vb.actual === len, '⑥ 声明 actual = 最终可见长度（得 ' + vb?.actual + ' vs ' + len + '）')
  // 关键：假设安全字段底限仍超预算，建议不得再要求 Narrow 同一个 target
  assert(!vb || vb.over_budget_after_steps !== true || !/Narrow with target/i.test(String(vb.suggestion || '')), '⑥ 超预算建议不得自指 target（得 ' + JSON.stringify(vb?.suggestion) + '）')
  assert(!vb || vb.over_budget_after_steps !== true, '⑥ 本场景应实际落入预算，而非只标注超预算（得 ' + JSON.stringify(vb) + '）')
  // 候选与文件目标无关时可折叠，但必须可追溯
  const folded = String(r.observation?.candidates_folded || r.observation?.candidates_detail_omitted || '')
  const kept = r.observation?.candidates
  assert(kept === undefined || (Array.isArray(kept) && kept.length <= 3), '⑥ 候选有界或显式折叠（得 ' + JSON.stringify(kept && kept.length) + '）')
  assert(!folded || (r.observation?.candidates_total || 0) >= 1, '⑥ 折叠时给 candidates_total（得 ' + JSON.stringify({ f: folded, t: r.observation?.candidates_total }) + '）')
  // 单位/降级清单仍透明
  assert(!vb || (Array.isArray(vb.truncated_fields) && vb.truncated_fields.length >= 1), '⑥ 预算元信息记录降级字段（得 ' + JSON.stringify(vb?.truncated_fields) + '）')
}

// ── ⑦ M4 补充（2026-10-19）：极长嵌套路径 + 密集候选——scope/target 与 target_file/next_action 的重复信息
// 必须可折叠（旧链路实测 6770 字符超预算）。锁定：仍 ≤6000、target 可追溯（target_file + next_action）、
// 折叠声明给出总数/展开出口，且不丢安全/恢复锚点（index、read_refs、allowed_actions、预算元信息）。
{
  const seg = 'very-long-directory-segment-name-for-budget-pressure-testing'
  const LONG = `packages/${seg}/${seg}/${seg}/src`
  const TARGET = `${LONG}/中文 新建 文件.js`
  mkdirSync(join(WS, LONG), { recursive: true })
  writeFileSync(join(WS, TARGET), 'export function value() { return 1 }\n')
  const PROD = []
  for (let i = 0; i < 8; i++) {
    const f = `${LONG}/change-value-handler-${i}-${seg}.js`
    writeFileSync(join(WS, f), 'export function changeValue' + i + '(v) { return v }\n')
    PROD.push(f)
  }
  const sig = (n) => `export function ${n}(value: unknown, options?: { deep: boolean; strict?: boolean; retries?: number; trace?: (msg: string) => void }): Promise<{ ok: boolean; value: unknown }>`
  const syms = (f, i) => [
    { name: 'changeValue' + i, type: 'function', start_line: 1, end_line: 1, signature: sig('changeValue' + i) },
    { name: 'verifyValue' + i, type: 'function', start_line: 2, end_line: 2, signature: sig('verifyValue' + i) },
  ]
  const longIdx = {
    ...mockIndex(),
    async indexBatch() { return PROD },
    async findDefinitions() { return [] },
    async searchSymbols() { return PROD.flatMap((f, i) => syms(f, i).map(s => ({ ...s, path: f }))) },
    async getFileOutline(f) { const i = PROD.indexOf(f); return i >= 0 ? { outline: syms(f, i).map(s => ({ ...s, line: s.start_line })) } : { outline: [] } },
    findSymbolsInFile(f, name) {
      const i = PROD.indexOf(f)
      return i >= 0 ? [{ name, type: 'function', start_line: 1, end_line: 1, signature: sig(name), stable_id: 'js:' + f + '::' + name + '#function', matched_terms: ['change', 'value', 'verify', 'set', 'update'] }] : []
    },
    async getSymbolsAtLine(f) { const i = PROD.indexOf(f); return i >= 0 ? syms(f, i) : [] },
  }
  const r = await taskMod.handle({ workspace_dir: WS, goal: 'Change value to 2 and verify', target: { file: TARGET }, search_terms: ['change', 'value', 'verify', 'set', 'update'] }, { codeIndexService: longIdx, getWorkspaceDir: (w) => w })
  const len = JSON.stringify(r, null, 2).length
  const o = r.observation || {}
  const vb = o.visible_char_budget
  assert(r.ok === true, '⑦ 极长路径精确目标: ok（得 ' + JSON.stringify(r.error) + '）')
  assert(len <= budget.CODE_TASK_FILE_TARGET_BUDGET, '⑦ 极长路径精确目标 ≤ ' + budget.CODE_TASK_FILE_TARGET_BUDGET + '（旧链路 6770；得 ' + len + '）')
  assert(!vb || vb.over_budget_after_steps !== true, '⑦ 折叠后实际落入预算（得 ' + JSON.stringify(vb) + '）')
  assert(!vb || vb.actual === len, '⑦ 声明 actual = 最终可见长度（得 ' + vb?.actual + ' vs ' + len + '）')
  assert(o.target_file?.file === TARGET, '⑦ target_file 仍可追溯真实目标（得 ' + JSON.stringify(o.target_file) + '）')
  assert(r.next_action?.tool === 'code_read' && r.next_action?.args?.locator?.file_path === TARGET, '⑦ next_action 仍直达目标（得 ' + JSON.stringify(r.next_action?.args?.locator) + '）')
  // 折叠必须显式（可追溯、可展开），不能静默删
  if (o.scope === undefined) assert(/folded/.test(String(o.scope_folded || '')) && /code_query/.test(String(o.scope_folded || '')), '⑦ scope 折叠时给出口（得 ' + JSON.stringify(o.scope_folded) + '）')
  if (o.target === undefined) assert(/duplicate/.test(String(o.target_omitted || '')), '⑦ target 折叠时说明是重复信息（得 ' + JSON.stringify(o.target_omitted) + '）')
  // 安全/恢复锚点不因折叠丢失
  assert(o.index && typeof o.index.files_scanned === 'number', '⑦ index 覆盖度锚点保留（得 ' + JSON.stringify(o.index) + '）')
  assert(Array.isArray(o.read_refs) && Array.isArray(r.allowed_actions), '⑦ read_refs/allowed_actions 保留')
  assert(o.progress === undefined || typeof o.progress === 'string', '⑦ 未引入额外错误字段')
}

// ── ④ fitVisibleBudget 单元：逐级降级 + 显式截断 + 无法降入预算时显式标记 ──
{
  const big = { observation: { navigation: { map: 'x'.repeat(3000) }, structure: Array.from({ length: 30 }, (_, i) => ({ file: 'f' + i + '.js', symbols: Array.from({ length: 6 }, () => ({ name: 's'.repeat(20) })) })), candidates: Array.from({ length: 12 }, (_, i) => ({ name: 'c' + i, detail: 'd'.repeat(50) })), next_candidates: ['a', 'b', 'c', 'd'], scan_warnings: ['w1', 'w2', 'w3', 'w4'] } }
  const steps = [
    { name: 'navigation', apply: (o) => { if (o.observation.navigation) o.observation.navigation = { omitted: true } } },
    { name: 'structure_symbols', apply: (o) => { o.observation.structure = o.observation.structure.slice(0, 8).map(m => ({ file: m.file, symbols: m.symbols.slice(0, 2) })) } },
    { name: 'candidates', apply: (o) => { const c = o.observation.candidates; if (c.length > 3) { o.observation.candidates_total = c.length; o.observation.candidates = c.slice(0, 3) } } },
  ]
  const beforeLen = JSON.stringify(big, null, 2).length
  const out = budget.fitVisibleBudget(JSON.parse(JSON.stringify(big)), 1500, steps)
  const len2 = JSON.stringify(out, null, 2).length
  assert(len2 < beforeLen, '单元: 降级后可见文本确实变小（得 ' + len2 + ' < ' + beforeLen + '）')
  assert(len2 <= 1500 || out.observation.visible_char_budget?.over_budget_after_steps === true, '单元: 落入预算或显式标记超预算（得 ' + len2 + '）')
  assert(Array.isArray(out.observation.visible_char_budget?.truncated_fields) && out.observation.visible_char_budget.truncated_fields.length >= 2, '单元: 记录降级字段名（得 ' + JSON.stringify(out.observation.visible_char_budget) + '）')
  assert(String(out.observation.visible_char_budget?.note || '').includes('Partial view'), '单元: 截断给可展开说明')
  // N1 核心：声明计数与最终可见文本一致（含预算元信息自身）
  assert(out.observation.visible_char_budget?.actual === len2, 'N1 单元: 声明 actual = 最终可见文本长度（得 ' + out.observation.visible_char_budget?.actual + ' vs ' + len2 + '）')
  const out2 = budget.fitVisibleBudget({ observation: { blob: 'y'.repeat(5000) } }, 100, [])
  assert(out2.observation.visible_char_budget?.over_budget_after_steps === true, '单元: 无法降到预算内时显式标记（不静默）')
  const len3 = JSON.stringify(out2, null, 2).length
  assert(out2.observation.visible_char_budget?.actual === len3, 'N1 单元: 超预算时声明计数仍等于最终可见文本（得 ' + out2.observation.visible_char_budget?.actual + ' vs ' + len3 + '）')
  // N1：未超预算的响应不应凭空添加预算元信息（不改写正常输出）
  const small = budget.fitVisibleBudget({ observation: { a: 1 } }, 10000, steps)
  assert(!small.observation.visible_char_budget, 'N1 单元: 预算内响应不增加元信息字段')
  // M4 单元：overSuggestion 生效且未传时保留旧文案（一般入口的 Narrow 建议不能被误删）
  const custom = budget.fitVisibleBudget({ observation: { blob: 'z'.repeat(5000) } }, 100, [], { overSuggestion: 'Expand with code_query(mode="outline").' })
  assert(custom.observation.visible_char_budget?.suggestion === 'Expand with code_query(mode="outline").', 'M4 单元: 自定义超预算建议生效（得 ' + JSON.stringify(custom.observation.visible_char_budget?.suggestion) + '）')
  const legacy = budget.fitVisibleBudget({ observation: { blob: 'z'.repeat(5000) } }, 100, [])
  assert(/Narrow with target/.test(String(legacy.observation.visible_char_budget?.suggestion || '')), 'M4 单元: 未传 overSuggestion 时保留旧文案（得 ' + JSON.stringify(legacy.observation.visible_char_budget?.suggestion) + '）')
  // M4-续（实包复验 6364）：预算元信息在降级循环后才写入，其自身长度（~500）会把响应重新顶出预算。
  // 锁死：单个降级步只能把串压到「limit - 元信息」附近时，仍必须继续跑后续步，最终落入预算。
  {
    const near = { observation: { blob: 'q'.repeat(6200), extra: 'e'.repeat(200) } }
    const twoSteps = [
      { name: 'trim_blob', apply: (o) => { if (typeof o.observation.blob === 'string' && o.observation.blob.length > 5100) o.observation.blob = o.observation.blob.slice(0, 5100) } },
      { name: 'drop_extra', apply: (o) => { if (o.observation.extra) { o.observation.extra_omitted = true; delete o.observation.extra } } },
      { name: 'trim_blob_more', apply: (o) => { if (typeof o.observation.blob === 'string' && o.observation.blob.length > 4400) o.observation.blob = o.observation.blob.slice(0, 4400) } },
      { name: 'trim_blob_final', apply: (o) => { if (typeof o.observation.blob === 'string' && o.observation.blob.length > 3800) o.observation.blob = o.observation.blob.slice(0, 3800) } },
    ]
    const fixed = budget.fitVisibleBudget(near, 6000, twoSteps)
    const flateLen = JSON.stringify(fixed, null, 2).length
    assert(fixed.observation.visible_char_budget?.over_budget_after_steps !== true, 'M4-续 单元: 计入元信息后仍能落入预算（旧实现 5600+元信息 悬空；得 ' + flateLen + '）')
    assert(flateLen <= 6000, 'M4-续 单元: 最终长度 ≤ limit（得 ' + flateLen + '）')
    assert(fixed.observation.visible_char_budget?.actual === flateLen, 'M4-续 单元: actual 与最终长度一致（得 ' + fixed.observation.visible_char_budget?.actual + ' vs ' + flateLen + '）')
  }
}

console.log('\n=== test-r4-file-target-budget: ' + pass + ' passed, ' + fail + ' failed ===')
process.exit(fail > 0 ? 1 : 0)
