// test-g3-acceptance.js — G3 运行级验收（44 项）
// 真实 MCP stdio（graph+state）+ 临时工作区 + 实际进程：
//   1) 发现：code_query(mode="capabilities") 枚举 44；逐项 describe（schema/call_template）
//   2) 执行：invoke_capability 逐项委派原实现；每项至少一条“发现→成功调用”链证据
//   3) NOT_RUN 单列（环境缺件），不计通过
// 产出：reports/g3-acceptance/latest.json（原始）+ reports/g3-acceptance/G3-运行级验收-<运行日期>.md（人读；按日期命名，历史留档不被覆盖）
// 注：报告落在 gitignored 的 reports/——发布仓不含内部计划目录，报告不污染开源仓
// 运行：node tests/test-g3-acceptance.js
import { spawn, execSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
// F2（0.5.14 Windows 复核）：验证类用例的统一分类器（verify_pipeline / tsc_check / test_bridge）
import { classifyVerifyPipeline, classifyTscCheck, classifyTestBridge } from './lib/verify-classify.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MALONG_ROOT = join(__dirname, '..')
const REPO_ROOT = join(MALONG_ROOT, '..')
const WS = join(os.tmpdir(), 'opencode', 'g3-acceptance-ws')
const STATE = join(os.tmpdir(), 'opencode', 'g3-acceptance-state')
const OUT_JSON = join(REPO_ROOT, 'reports', 'g3-acceptance', 'latest.json')
const OUT_MD = join(REPO_ROOT, 'reports', 'g3-acceptance', 'G3-运行级验收-' + new Date().toISOString().slice(0, 10) + '.md')

const sha256 = (p) => { try { return createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16) } catch { return null } }
const trim = (v, n = 400) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s == null ? '' : (s.length > n ? s.slice(0, n) + '…' : s) }

// ── fixture 工作区 ──
function buildFixture() {
  rmSync(WS, { recursive: true, force: true })
  rmSync(STATE, { recursive: true, force: true })
  mkdirSync(join(WS, 'src'), { recursive: true })
  mkdirSync(join(WS, 'test'), { recursive: true })
  mkdirSync(join(WS, 'scratch'), { recursive: true })
  writeFileSync(join(WS, 'src', 'a.js'), [
    'export function alpha(x) {',
    '  return x + 1',
    '}',
    'export class Helper {',
    '  run() { return alpha(1) }',
    '}',
    '// TODO: g3 acceptance todo marker',
    '',
  ].join('\n'))
  writeFileSync(join(WS, 'src', 'b.js'), [
    "import { alpha, Helper } from './a.js'",
    "import { util } from './util.js'",
    '',
    'export function beta() {',
    '  return alpha(2)',
    '}',
    'export const h = new Helper()',
    'function neverUsed() { return 0 }',
    '',
  ].join('\n'))
  writeFileSync(join(WS, 'src', 'util.js'), 'export function util() { return 2 }\n')
  writeFileSync(join(WS, 'src', 'types.ts'), 'export function tadd(a: number, b: number): number {\n  return a + b\n}\n')
  writeFileSync(join(WS, 'tsconfig.json'), JSON.stringify({ compilerOptions: { noEmit: true, strict: true }, include: ['src/**/*.ts'] }, null, 2) + '\n')
  writeFileSync(join(WS, 'scratch', 'hello.js'), 'console.log("g3 hello")\n')
  writeFileSync(join(WS, 'test', 'a.test.js'), [
    "import { test } from 'node:test'",
    "import assert from 'node:assert'",
    "import { alpha } from '../src/a.js'",
    '',
    "test('alpha adds one', () => {",
    '  assert.strictEqual(alpha(1), 2)',
    '})',
    '',
  ].join('\n'))
  writeFileSync(join(WS, 'package.json'), JSON.stringify({ name: 'g3-fixture', private: true, type: 'module', scripts: { test: 'node --test test/a.test.js', typecheck: 'tsc --noEmit' } }, null, 2) + '\n')
  writeFileSync(join(WS, '.gitignore'), 'scratch/\n.ai-transactions/\n.malong/\nnode_modules/\n')
  // 真 tsc 工具链（一次性缓存 /tmp/opencode/g3-toolchain；缺则本用例诚实 NOT_RUN）
  const TC = join(os.tmpdir(), 'opencode', 'g3-toolchain')
  if (existsSync(join(TC, 'node_modules', 'typescript'))) {
    mkdirSync(join(WS, 'node_modules', '.bin'), { recursive: true })
    try { symlinkSync(join(TC, 'node_modules', 'typescript'), join(WS, 'node_modules', 'typescript'), 'dir') } catch {}
    try { symlinkSync(join(TC, 'node_modules', '.bin', 'tsc'), join(WS, 'node_modules', '.bin', 'tsc')) } catch {}
  }
  writeFileSync(join(WS, 'README.md'), '# g3 fixture\n\nTODO: acceptance notes\n')
  execSync('git init -q && git config user.email g3@local && git config user.name g3 && git add -A && git commit -q -m "g3 fixture baseline"', { cwd: WS, stdio: 'ignore' })
}

// ── MCP 客户端（真 stdio）──
function makeClient() {
  const child = spawn(process.execPath, ['--expose-gc', join(MALONG_ROOT, 'mcp-server.js'), '--workspace', WS], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: WS,
    env: { ...process.env, MALONG_STATE_DIR: STATE, MALONG_INTERFACE: 'graph', MALONG_ENTRY_STATE: '1' },
  })
  let buffer = '', seq = 0, exited = false
  const pending = new Map()
  child.stdout.setEncoding('utf-8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let idx
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 1)
      if (!line.trim()) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
    }
  })
  child.on('exit', () => { exited = true })
  async function rpc(method, params, t = 30000) {
    const id = ++seq
    let r
    r = await new Promise((resolve, reject) => {
      if (exited) return reject(new Error('server_exited'))
      const to = setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout ' + method)) } }, t)
      pending.set(id, (m) => { clearTimeout(to); resolve(m) })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
    return r
  }
  async function rpcRetry(method, params, t) {
    for (let i = 0; ; i++) {
      const r = await rpc(method, params, t).catch((e) => ({ error: { code: -1, message: String(e.message || e) } }))
      if (r.error && r.error.code === -32000 && /still loading/i.test(String(r.error.message)) && i < 60) {
        await new Promise((res) => setTimeout(res, 500))
        continue
      }
      return r
    }
  }
  async function call(name, args, t) {
    const r = await rpcRetry('tools/call', { name, arguments: args }, t)
    if (r.error) return { _rpcError: r.error }
    const c = r.result && r.result.content && r.result.content[0]
    if (!c || c.type !== 'text') return { _rpcError: { code: 'content_not_text' } }
    try { return JSON.parse(c.text) } catch { return { _rpcError: { code: 'text_not_json', raw: trim(c.text, 200) } } }
  }
  async function invoke(name, args, extra = {}, t) {
    const r = await call('invoke_capability', { workspace_dir: WS, name, args, ...extra }, t)
    return r
  }
  return { child, rpcRetry, call, invoke, kill: () => { try { child.kill() } catch {} } }
}

// ── 用例表 ──
// 分类规则：pred(res)===true → PASS；res 报错但命中 notRunIf → NOT_RUN；res 报错 → BOUNDARY/FAIL 见 classify()
function hasError(r) { return !!r && (r.error != null || r.ok === false || r.status === 'fail') }
function errText(r) { return trim(JSON.stringify(r), 300) }

const CASES = [
  // —— 索引地基（后续分析类前置）——
  { id: 'reindex_blocking', tool: 'reindex', scenario: '阻塞建索引（后续分析前置）', args: { workspace_dir: WS, blocking: true }, timeout: 120000, pred: (r) => r && !hasError(r) },
  // —— 只读分析/查询族 ——
  { id: 'active_todos', tool: 'active_todos', scenario: '枚举 TODO 标记', args: {}, pred: (r) => r && !hasError(r) && (r.total_todos >= 1 || (Array.isArray(r.todos) && r.todos.length >= 1)) },
  { id: 'read_symbol_file', tool: 'read_symbol', scenario: '整文件读取（file 模式）', args: { locator: { file_path: 'src/a.js' } }, pred: (r) => r && !hasError(r) && !!r.version?.file?.hash, capture: (r, ctx) => { ctx.aFileVersion = r.version.file } },
  { id: 'read_symbol_sym', tool: 'read_symbol', scenario: '符号读取（name 模式）', args: { locator: { file_path: 'src/a.js', name: 'alpha' } }, pred: (r) => r && !hasError(r) },
  { id: 'read_outline', tool: 'read_outline', scenario: '文件结构大纲 depth=2', args: { file: 'src/a.js', depth: 2 }, pred: (r) => r && !hasError(r) },
  { id: 'references', tool: 'references', scenario: 'alpha 引用查询', args: { symbol: 'alpha', file: 'src/a.js' }, pred: (r) => r && !hasError(r) },
  { id: 'symbol_search', tool: 'symbol_search', scenario: '符号搜索 query=alpha', args: { query: 'alpha' }, pred: (r) => r && !hasError(r) },
  { id: 'call_chain', tool: 'call_chain', scenario: '调用链 file+symbol depth=2', args: { file: 'src/a.js', symbol: 'alpha', depth: 2 }, pred: (r) => r && !hasError(r) },
  { id: 'impact_analysis', tool: 'impact_analysis', scenario: '影响面 change_type=modify', args: { file: 'src/a.js', symbol: 'alpha', change_type: 'modify' }, pred: (r) => r && !hasError(r) },
  { id: 'inspect', tool: 'inspect', scenario: '组合查阅 outline+refs', args: { file: 'src/a.js', symbol: 'alpha', include_outline: true, include_refs: true }, pred: (r) => r && !hasError(r) },
  { id: 'trace_symbol', tool: 'trace_symbol', scenario: '符号+字面量追踪', args: { file: 'src/a.js', symbol: 'alpha', include_literals: true, max_results: 20 }, pred: (r) => r && !hasError(r) },
  { id: 'repo_map', tool: 'repo_map', scenario: '项目地图（默认）', args: {}, pred: (r) => r && !hasError(r) },
  { id: 'dep_graph', tool: 'dep_graph', scenario: '模块依赖 scope=project', args: { scope: 'project' }, pred: (r) => r && !hasError(r) },
  { id: 'find_tests', tool: 'find_tests', scenario: 'a.js 相关测试定位', args: { file: 'src/a.js' }, pred: (r) => r && !hasError(r) },
  { id: 'code_search', tool: 'code_search', scenario: '意图搜索 query=alpha', args: { query: 'alpha' }, pred: (r) => r && !hasError(r) },
  // —— 审查族 ——
  { id: 'code_quality', tool: 'code_quality', scenario: 'src/a.js 质量审查', args: { file: 'src/a.js' }, pred: (r) => r && !hasError(r) },
  { id: 'code_review', tool: 'code_review', scenario: 'src/a.js 代码审查', args: { file: 'src/a.js' }, pred: (r) => r && !hasError(r) },
  { id: 'security_review', tool: 'security_review', scenario: 'src/a.js 安全审查', args: { file: 'src/a.js' }, pred: (r) => r && !hasError(r) },
  { id: 'exception_guard', tool: 'exception_guard', scenario: '异常模式审查 src/a.js', args: { file: 'src/a.js' }, pred: (r) => r && !hasError(r) },
  { id: 'guard_patterns', tool: 'guard_patterns', scenario: '守卫模式审查 src/a.js', args: { file: 'src/a.js' }, pred: (r) => r && !hasError(r) },
  { id: 'config_drift', tool: 'config_drift', scenario: '配置漂移扫描', args: {}, pred: (r) => r && !hasError(r) },
  { id: 'dependency_gatekeeper', tool: 'dependency_gatekeeper', scenario: 'package.json 依赖审查', args: { file: 'package.json' }, pred: (r) => r && !hasError(r) },
  { id: 'sweep_dead_code', tool: 'sweep_dead_code', scenario: '死代码扫描（neverUsed）', args: {}, pred: (r) => r && !hasError(r) },
  { id: 'mock_sync', tool: 'mock_sync', scenario: 'alpha 关联 mock 查询', args: { file: 'src/a.js', function: 'alpha' }, pred: (r) => r && !hasError(r) },
  { id: 'naming_consistency', tool: 'naming_consistency', scenario: '新符号命名候选', args: { file: 'src/a.js', new_symbols: ['alphaRenamed'] }, pred: (r) => r && !hasError(r) },
  { id: 'spec_gen', tool: 'spec_gen', scenario: 'src/a.js 规范草稿', args: { file: 'src/a.js' }, pred: (r) => r && !hasError(r) },
  { id: 'style_sniffer', tool: 'style_sniffer', scenario: '风格分析 + 目录输出（写路径）', args: { scope: 'src', output: 'scratch/rules' }, hashFile: 'scratch/rules/PROJECT_RULES.md', pred: (r) => r && !hasError(r) },
  { id: 'patch_parser', tool: 'patch_parser', scenario: 'SEARCH/REPLACE 文本解析', args: { text: '<<<<<<< SEARCH\nexport function util() { return 2 }\n=======\nexport function util() { return 3 }\n>>>>>>> REPLACE' }, pred: (r) => r && !hasError(r) && r.block_count >= 1 },
  { id: 'sandbox_validate', tool: 'sandbox_validate', scenario: '候选内容验证（不落盘）', args: { file: 'src/a.js', new_content: 'export const alpha = 42\n' }, pred: (r) => r && !hasError(r) },
  { id: 'fix_imports', tool: 'fix_imports', scenario: 'src/b.js 导入分析（auto_fix 关）', args: { file: 'src/b.js' }, pred: (r) => r && !hasError(r) },
  { id: 'edit_collision_guard_record', tool: 'edit_collision_guard', scenario: '碰撞快照 record_read', args: { file: 'src/a.js', action: 'record_read' }, pred: (r) => r && !hasError(r) },
  { id: 'edit_collision_guard_check', tool: 'edit_collision_guard', scenario: '碰撞检查 check', args: { file: 'src/a.js', action: 'check' }, pred: (r) => r && !hasError(r) },
  // —— 写族（scratch 隔离）——
  { id: 'write_symbol_create', tool: 'write_symbol', scenario: 'create 新文件 scratch/w1.js', args: { locator: { file_path: 'scratch/w1.js', name: 'w1' }, create: true, content: 'export const w1 = 1\n' }, hashFile: 'scratch/w1.js', pred: (r) => r && !hasError(r) && r.success !== false },
  { id: 'read_symbol_scratch', tool: 'read_symbol', scenario: 'scratch/w1.js 读基准（写前 base）', args: { locator: { file_path: 'scratch/w1.js' } }, pred: (r) => r && !hasError(r) && !!r.version?.file?.hash, capture: (r, ctx) => { ctx.w1Version = r.version.file } },
  { id: 'write_symbol_patch', tool: 'write_symbol', scenario: '带 base_version 改写符号', args: (ctx) => ({ locator: { file_path: 'scratch/w1.js', name: 'w1' }, base_version: { file: ctx.w1Version }, content: 'export const w1 = 2\n' }), hashFile: 'scratch/w1.js', pred: (r) => r && !hasError(r) && r.success !== false },
  { id: 'edit_batch', tool: 'edit_batch', scenario: '多处替换（单文件 edits）', args: { file: 'scratch/w1.js', edits: [{ old_string: '= 2', new_string: '= 3' }] }, hashFile: 'scratch/w1.js', pred: (r) => r && !hasError(r) && r.success !== false },
  { id: 'write_symbols', tool: 'write_symbols', scenario: '批量 create 两文件', args: { writes: [{ file_path: 'scratch/ws-a.js', create: true, content: 'export const wsa = 1\n' }, { file_path: 'scratch/ws-b.js', create: true, content: 'export const wsb = 1\n' }] }, hashFile: 'scratch/ws-a.js', pred: (r) => r && !hasError(r) && r.success !== false },
  { id: 'rename_symbol_dry', tool: 'rename_symbol', scenario: '重命名 dry_run 预演（必须 hash 不变）', args: { file: 'scratch/w1.js', symbol: 'w1', new_name: 'w1x', dry_run: true }, hashFile: 'scratch/w1.js', pred: (r, h) => r && !hasError(r) && r.dry_run === true && h.after === h.before },
  { id: 'rename_symbol_real', tool: 'rename_symbol', scenario: '重命名真写（dry_run:false + hash 变化 + 内容替换，R03）', args: { file: 'scratch/w1.js', symbol: 'w1', new_name: 'w1x', dry_run: false }, hashFile: 'scratch/w1.js', capture: (r, ctx) => { ctx.renameTxn = r?.txn_id || null }, pred: (r, h) => r && !hasError(r) && r.status === 'committed' && r.dry_run === false && !!r.txn_id && h.after !== h.before && readFileSync(join(WS, 'scratch', 'w1.js'), 'utf-8').includes('w1x') },
  { id: 'rename_symbol_undo', tool: 'edit_transaction', direct: true, scenario: 'rename 真写后 undo_commit 恢复原状（R03 配套）', args: async (ctx, C) => {
      if (!ctx.renameTxn) return { error: 'no rename txn captured' }
      const u = await C.call('invoke_capability', { workspace_dir: WS, name: 'edit_transaction', args: { action: 'undo_commit', txn_id: ctx.renameTxn } })
      const content = existsSync(join(WS, 'scratch', 'w1.js')) ? readFileSync(join(WS, 'scratch', 'w1.js'), 'utf-8') : null
      return { undo_status: (u && u.result && (u.result.status || u.result.error)) || (u && u.error) || null, content_restored: !!(content && content.includes('const w1 =') && !content.includes('w1x')) }
    }, hashFile: 'scratch/w1.js', pred: (r) => !!r && r.content_restored === true && typeof r.undo_status === 'string' && r.undo_status.indexOf('undone') === 0 },
  { id: 'edit_transaction_cycle', tool: 'edit_transaction', direct: true, scenario: '事务 begin→edit→commit→undo 全链', args: async (ctx, C) => {
      const b = await C.call('invoke_capability', { workspace_dir: WS, name: 'edit_transaction', args: { action: 'begin', name: 'g3' } })
      ctx.txnId = b?.result?.txnId || b?.result?.txn_id || null
      if (!ctx.txnId) return { action: 'begin', wrapper: b }
      const e = await C.call('invoke_capability', { workspace_dir: WS, name: 'edit_transaction', args: { action: 'edit', txn_id: ctx.txnId, file: 'scratch/txn.js', create: true, content: 'export const t = 1\n' } })
      const info = await C.call('invoke_capability', { workspace_dir: WS, name: 'edit_transaction', args: { action: 'info', txn_id: ctx.txnId } })
      const c = await C.call('invoke_capability', { workspace_dir: WS, name: 'edit_transaction', args: { action: 'commit', txn_id: ctx.txnId } })
      const u = await C.call('invoke_capability', { workspace_dir: WS, name: 'edit_transaction', args: { action: 'undo_commit', txn_id: ctx.txnId } })
      const b2 = await C.call('invoke_capability', { workspace_dir: WS, name: 'edit_transaction', args: { action: 'begin', name: 'g3-keep' } })
      ctx.txnId2 = b2?.result?.txnId || b2?.result?.txn_id || null
      const e2 = await C.call('invoke_capability', { workspace_dir: WS, name: 'edit_transaction', args: { action: 'edit', txn_id: ctx.txnId2, file: 'scratch/txn2.js', create: true, content: 'export const t2 = 1\n' } })
      const c2 = await C.call('invoke_capability', { workspace_dir: WS, name: 'edit_transaction', args: { action: 'commit', txn_id: ctx.txnId2 } })
      return { action: 'cycle', txn_id: ctx.txnId, txn_id2: ctx.txnId2, steps: { edit: e?.result?.status || e?.result?.error || null, info_ok: info?.ok === true, commit: c?.result?.status || c?.result?.receipt?.state_commit || c?.result?.error || null, undo: u?.result?.status || u?.result?.receipt?.state_commit || u?.result?.error || null, edit2: e2?.result?.status || e2?.result?.error || null, commit2: c2?.result?.status || c2?.result?.receipt?.state_commit || c2?.result?.error || null }, file_exists_after_undo: existsSync(join(WS, 'scratch', 'txn.js')), txn2_exists: existsSync(join(WS, 'scratch', 'txn2.js')) }
    }, hashFile: 'scratch/txn.js', pred: (r) => r && r.txn_id && r.steps && r.steps.commit != null && r.file_exists_after_undo === false },
  { id: 'diff_facts', tool: 'diff_facts', scenario: '事务后变更事实（.ai-transactions 存在）', args: {}, pred: (r) => r && !hasError(r) },
  // —— Git 族 ——
  { id: 'git_worktree', tool: 'git_worktree', scenario: '隔离改验 + 真 Git 提交 + verify_cmd', args: { changes: [{ path: 'src/gw.js', new_content: 'export const gw = 1\n' }], message: 'g3 acceptance worktree', verify_cmd: 'node --check src/gw.js' }, hashFile: 'src/gw.js', timeout: 60000, pred: (r) => r && !hasError(r) },
  { id: 'diff_facts_after_commit', tool: 'diff_facts', scenario: '提交后变更事实', args: {}, pred: (r) => r && !hasError(r) },
  // —— 执行族 ——
  { id: 'debug_runner_ok', tool: 'debug_runner', scenario: '运行良性命令 node --version', args: { command: 'node --version' }, timeout: 60000, pred: (r) => r && !hasError(r) },
  { id: 'debug_runner_fail', tool: 'debug_runner', scenario: '失败命令错误分析（边界）', args: { command: 'definitely-not-a-command-g3 --x' }, timeout: 60000, boundary: true, pred: (r) => !!r },
  { id: 'test_bridge_discover', tool: 'test_bridge', scenario: '测试发现', args: { action: 'discover', file: 'src/a.js' }, pred: (r) => r && !hasError(r) },
  { id: 'test_bridge_suggest', tool: 'test_bridge', scenario: '测试建议', args: { action: 'suggest', file: 'src/a.js' }, pred: (r) => r && !hasError(r) },
  { id: 'test_bridge_run', tool: 'test_bridge', scenario: '运行测试（真进程）', args: { action: 'run', scope: 'test/a.test.js' }, timeout: 90000, verify: classifyTestBridge },
  { id: 'verify_pipeline_test', tool: 'verify_pipeline', scenario: '验证流水线 stages=test', args: { stages: 'test' }, timeout: 90000, verify: classifyVerifyPipeline },
  // F2：typecheck/lint 一律走统一分类（不再各写一套「有返回且无 error 就 PASS」；环境缺件 → NOT_RUN）
  { id: 'verify_pipeline_typecheck', tool: 'verify_pipeline', scenario: 'typecheck 阶段（环境受限）', args: { stages: 'typecheck' }, timeout: 90000, verify: classifyVerifyPipeline },
  { id: 'tsc_check', tool: 'tsc_check', scenario: 'TypeScript 编译检查（无本地 tsc）', args: {}, timeout: 60000, verify: classifyTscCheck },
  // —— 服务族 ——
  { id: 'feedback_record', tool: 'feedback', scenario: '记录反馈', args: { action: 'record', tool: 'g3-acceptance', issue: 'G3 smoke', note: 'acceptance harness' }, pred: (r) => r && !hasError(r) },
  { id: 'feedback_list', tool: 'feedback', scenario: '列出反馈（持久化验证）', args: { action: 'list' }, pred: (r) => r && !hasError(r) && JSON.stringify(r).includes('g3-acceptance') },
  { id: 'health', tool: 'health', scenario: '服务健康检查', args: { action: 'check' }, pred: (r) => r && !hasError(r) },
  { id: 'gc', tool: 'gc', scenario: '资源清理（真实执行）', args: {}, pred: (r) => r && !hasError(r) },
  // —— G3-B 模式扩面（逐项与设计语义对质后编写）——
  { id: 'active_todos_scope', tool: 'active_todos', scenario: 'scope+current_files 过滤', args: { scope: 'src', current_files: ['src/a.js'] }, pred: (r) => r && !hasError(r) },
  { id: 'read_symbol_batch', tool: 'read_symbol', scenario: 'locators 批读（Y002-S5）', args: { locators: [{ file_path: 'src/a.js', name: 'alpha' }, { file_path: 'src/a.js', name: 'Helper' }] }, pred: (r) => r && !hasError(r) },
  { id: 'read_symbol_rich', tool: 'read_symbol', scenario: 'mode=rich 富投影', args: { locator: { file_path: 'src/a.js', name: 'alpha' }, mode: 'rich' }, pred: (r) => r && !hasError(r) },
  { id: 'read_symbol_source_indexed', tool: 'read_symbol', scenario: 'source=indexed 快照读', args: { locator: { file_path: 'src/a.js', name: 'alpha' }, source: 'indexed' }, pred: (r) => r && !hasError(r) },
  { id: 'read_outline_refs', tool: 'read_outline', scenario: 'refs+test_refs+max_items', args: { file: 'src/a.js', include_refs: true, include_test_refs: true, max_items: 20 }, pred: (r) => r && !hasError(r) },
  { id: 'call_chain_line', tool: 'call_chain', scenario: '按行定位调用链', args: { file: 'src/b.js', line: 4 }, pred: (r) => r && !hasError(r) },
  { id: 'call_chain_limits', tool: 'call_chain', scenario: 'max_callers/max_callees 限幅', args: { file: 'src/a.js', symbol: 'alpha', max_callers: 1, max_callees: 1 }, pred: (r) => r && !hasError(r) },
  { id: 'impact_symbols', tool: 'impact_analysis', scenario: 'symbols[] 批分析+context_mode', args: { file: 'src/a.js', symbols: ['alpha', 'Helper'], context_mode: 'snippet' }, pred: (r) => r && !hasError(r) },
  { id: 'inspect_chain', tool: 'inspect', scenario: 'include_chain 调用链', args: { file: 'src/a.js', symbol: 'alpha', include_chain: true }, pred: (r) => r && !hasError(r) },
  { id: 'patch_parser_file', tool: 'patch_parser', scenario: 'file 干跑应用（SEARCH/REPLACE）', args: { file: 'src/util.js', text: '<<<<<<< SEARCH\nexport function util() { return 2 }\n=======\nexport function util() { return 2 }\nexport function util2() { return 4 }\n>>>>>>> REPLACE' }, pred: (r) => r && !hasError(r) && r.block_count >= 1 },
  { id: 'sandbox_validate_invalid', tool: 'sandbox_validate', scenario: '未闭合括号检测（设计内边界）', args: { file: 'src/a.js', new_content: 'export function broken() {\n  return 1\n' }, pred: (r) => r && (r.valid === false || hasError(r)) },
  { id: 'sweep_dead_code_files', tool: 'sweep_dead_code', scenario: 'include_files 孤儿文件', args: { include_files: true }, pred: (r) => r && !hasError(r) },
  { id: 'repo_map_dir', tool: 'repo_map', scenario: 'dir 局部地图', args: { dir: 'src' }, pred: (r) => r && !hasError(r) },
  { id: 'repo_map_focused', tool: 'repo_map', scenario: 'focused+relevantFiles', args: { focused: true, relevantFiles: ['src/a.js'], relevantEntities: ['alpha'] }, pred: (r) => r && !hasError(r) },
  { id: 'dep_graph_file', tool: 'dep_graph', scenario: '单文件传递依赖 depth=2', args: { file: 'src/b.js', depth: 2 }, pred: (r) => r && !hasError(r) },
  { id: 'find_tests_symbol', tool: 'find_tests', scenario: 'symbol 收窄测试候选', args: { file: 'src/a.js', symbol: 'alpha' }, pred: (r) => r && !hasError(r) },
  { id: 'code_review_source', tool: 'code_review', scenario: 'source 内联审查', args: { source: 'function Foo(){}\nfunction bar(){}\n', max_issues: 5 }, pred: (r) => r && !hasError(r) },
  { id: 'code_review_diff', tool: 'code_review', scenario: 'diff 分块审查', args: { diff: '<<<<<<< SEARCH\nexport function util() { return 2 }\n=======\nexport function util() { return 3 }\n>>>>>>> REPLACE' }, pred: (r) => r && !hasError(r) },
  { id: 'security_review_scope', tool: 'security_review', scenario: 'scope 目录递归扫描', args: { scope: 'src' }, pred: (r) => r && !hasError(r) },
  { id: 'debug_runner_script', tool: 'debug_runner', scenario: 'script= 运行+分析', args: { script: 'scratch/hello.js' }, timeout: 60000, pred: (r) => r && !hasError(r) },
  { id: 'debug_runner_test', tool: 'debug_runner', scenario: 'test= 测试命令', args: { test: 'node --test test/a.test.js' }, timeout: 90000, pred: (r) => r && !hasError(r) },
  { id: 'verify_pipeline_lint', tool: 'verify_pipeline', scenario: 'lint 阶段（环境受限）', args: { stages: 'lint' }, timeout: 60000, verify: classifyVerifyPipeline },
  { id: 'edit_collision_guard_session', tool: 'edit_collision_guard', scenario: 'session_id 隔离快照', args: { file: 'src/a.js', action: 'record_read', session_id: 'g3-sess' }, pred: (r) => r && !hasError(r) },
  { id: 'style_sniffer_overwrite_guard', tool: 'style_sniffer', scenario: '已存在不覆盖（边界）', args: { scope: 'src', output: 'scratch/rules' }, pred: (r) => r && r.status === 'exists' },
  { id: 'style_sniffer_force', tool: 'style_sniffer', scenario: 'force 覆盖已存在', args: { scope: 'src', output: 'scratch/rules', force: true }, hashFile: 'scratch/rules/PROJECT_RULES.md', pred: (r) => r && !hasError(r) && r.status !== 'exists' },
  { id: 'diff_facts_since', tool: 'diff_facts', scenario: 'since=txn:<id> 定向事实', args: (ctx) => ({ since: 'txn:' + ctx.txnId2 }), pred: (r) => r && !hasError(r) },
  { id: 'health_matrix', tool: 'health', scenario: 'action=matrix（查 Y004 行）', args: { action: 'matrix', tool: 'read_symbol' }, notRunIf: (r) => /matrix_unavailable/i.test(errText(r)), pred: (r) => r && !hasError(r) },
  { id: 'health_cleanup_dry', tool: 'health', scenario: 'cleanup 干跑', args: { action: 'cleanup', dry_run: true }, pred: (r) => r && !hasError(r) },
  { id: 'health_stats', tool: 'health', scenario: 'usage 统计', args: { action: 'check', stats: true }, pred: (r) => r && !hasError(r) },
  { id: 'reindex_force', tool: 'reindex', scenario: 'force 全量重抽', args: { force: true, blocking: true }, timeout: 120000, pred: (r) => r && !hasError(r) },
  { id: 'write_symbol_insert_after', tool: 'write_symbol', scenario: 'insert_after_symbol 插写', args: async (ctx, C) => {
      const rd = await C.call('invoke_capability', { workspace_dir: WS, name: 'read_symbol', args: { locator: { file_path: 'scratch/ws-a.js' } } })
      return { locator: { file_path: 'scratch/ws-a.js', name: 'wsa' }, base_version: { file: rd?.result?.version?.file }, edit_mode: 'insert_after_symbol', content: 'export const wsa2 = 2\n' }
    }, hashFile: 'scratch/ws-a.js', pred: (r) => r && !hasError(r) && r.success !== false },
  { id: 'write_symbols_policy_besteffort', tool: 'write_symbols', scenario: 'policy 最佳努力（all_or_nothing=false）', args: { writes: [{ file_path: 'scratch/pb-a.js', create: true, content: 'export const pba = 1\n' }, { file_path: 'scratch/pb-b.js', create: true, content: 'export const pbb = 1\n' }], policy: { all_or_nothing: false } }, hashFile: 'scratch/pb-a.js', pred: (r) => r && !hasError(r) && r.success !== false },
  { id: 'write_symbols_blocked_path', tool: 'write_symbols', scenario: '路径越界拒绝（边界）', boundary: true, args: { writes: [{ file_path: 'scratch/bp-a.js', create: true, content: 'export const bpa = 1\n' }, { file_path: '../escape-g3.js', create: true, content: 'x\n' }] }, pred: (r) => !existsSync(join(WS, '..', 'escape-g3.js')) && (hasError(r) || /blocked|escape|invalid/i.test(JSON.stringify(r))) },
  { id: 'edit_transaction_multi', tool: 'edit_transaction', direct: true, scenario: 'edit_multi 多文件事务', args: async (ctx, C) => {
      const b = await C.call('invoke_capability', { workspace_dir: WS, name: 'edit_transaction', args: { action: 'begin', name: 'g3-multi' } })
      const id = b?.result?.txnId
      const m = await C.call('invoke_capability', { workspace_dir: WS, name: 'edit_transaction', args: { action: 'edit_multi', txn_id: id, file_edits: [{ file: 'scratch/ws-a.js', edits: [{ old_string: 'wsa = 1', new_string: 'wsa = 11' }] }, { file: 'scratch/ws-b.js', edits: [{ old_string: 'wsb = 1', new_string: 'wsb = 11' }] }] } })
      const c = await C.call('invoke_capability', { workspace_dir: WS, name: 'edit_transaction', args: { action: 'commit', txn_id: id } })
      return { action: 'edit_multi_cycle', txn_id: id, staged: m?.result?.status || m?.result?.error || null, committed: c?.result?.status || c?.result?.error || null }
    }, pred: (r) => r && r.txn_id && r.staged === 'staged' && r.committed != null },
  { id: 'edit_transaction_chunk', tool: 'edit_transaction', direct: true, scenario: 'edit_chunk→assemble 分块装配', args: async (ctx, C) => {
      const fp = 'scratch/ws-b.js'
      const cur = readFileSync(join(WS, fp), 'utf-8')
      const sha = createHash('sha256').update(cur).digest('hex')
      const b = await C.call('invoke_capability', { workspace_dir: WS, name: 'edit_transaction', args: { action: 'begin', name: 'g3-chunk' } })
      const id = b?.result?.txnId
      const ch = await C.call('invoke_capability', { workspace_dir: WS, name: 'edit_transaction', args: { action: 'edit_chunk', txn_id: id, file: fp, seq: 1, total: 1, lines: ['export const wsb = 200'] } })
      const as = await C.call('invoke_capability', { workspace_dir: WS, name: 'edit_transaction', args: { action: 'assemble', txn_id: id, file: fp, expect_sha: sha } })
      const c = await C.call('invoke_capability', { workspace_dir: WS, name: 'edit_transaction', args: { action: 'commit', txn_id: id } })
      return { action: 'chunk_cycle', txn_id: id, chunk: ch?.result?.status || ch?.result?.error || null, assembled: as?.result?.status || as?.result?.error || null, committed: c?.result?.status || c?.result?.error || null }
    }, hashFile: 'scratch/ws-b.js', pred: (r) => r && r.chunk === 'chunk_received' && r.committed != null },
  { id: 'edit_transaction_rollback', tool: 'edit_transaction', direct: true, scenario: 'rollback 丢弃已 stage', args: async (ctx, C) => {
      const b = await C.call('invoke_capability', { workspace_dir: WS, name: 'edit_transaction', args: { action: 'begin', name: 'g3-rb' } })
      const id = b?.result?.txnId
      await C.call('invoke_capability', { workspace_dir: WS, name: 'edit_transaction', args: { action: 'edit', txn_id: id, file: 'scratch/rb.js', create: true, content: 'export const rb = 1\n' } })
      const rb = await C.call('invoke_capability', { workspace_dir: WS, name: 'edit_transaction', args: { action: 'rollback', txn_id: id } })
      return { action: 'rollback_cycle', txn_id: id, rolled_back: rb?.result?.status || rb?.result?.error || null, file_exists: existsSync(join(WS, 'scratch', 'rb.js')) }
    }, pred: (r) => r && r.txn_id && r.rolled_back != null && r.file_exists === false },
  { id: 'fix_imports_autofix', tool: 'fix_imports', scenario: 'auto_fix 真写（移除未用导入）', args: { file: 'src/b.js', auto_fix: true }, hashFile: 'src/b.js', pred: (r) => r && !hasError(r) && /imports_removed|imports_trimmed|fixes_applied|removed/i.test(JSON.stringify(r)) },
  { id: 'health_restart', tool: 'health', scenario: 'action=restart 软恢复（末例）', args: { action: 'restart' }, timeout: 60000, pred: (r) => r && (r.status === 'restarted' || !hasError(r)) },
]

// ── 主流程 ──
async function main() {
  const startedAt = Date.now()
  buildFixture()
  const gitHead = (() => { try { return execSync('git rev-parse --short HEAD', { cwd: MALONG_ROOT }).toString().trim() } catch { return null } })()
  const C = makeClient()
  const ctx = {}
  const cases = []
  let discovery = null

  try {
    await C.rpcRetry('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'g3-acceptance', version: '0' } })

    // 发现阶段
    const caps = await C.call('code_query', { workspace_dir: WS, mode: 'capabilities', limit: 100 })
    const listed = new Map((caps?.result?.items || []).map((i) => [i.name, i]))
    const toolbox = [...new Set(CASES.map((c) => c.tool))]
    const missing = toolbox.filter((n) => !listed.has(n))
    const desc = { ok: 0, schema: 0, template: 0, failed: [] }
    for (const n of toolbox) {
      const d = await C.call('code_query', { workspace_dir: WS, mode: 'capability', name: n })
      if (d?.ok === true) { desc.ok++; if (d.result?.schema) desc.schema++; if (d.result?.call_template?.full_outlet) desc.template++ }
      else desc.failed.push({ name: n, error: trim(d, 200) })
    }
    discovery = { listed_total: caps?.result?.total ?? null, listed_items: (caps?.result?.items || []).length, missing, describe: desc }

    // 执行阶段
    for (const c of CASES) {
      const t0 = Date.now()
      const before = c.hashFile ? sha256(join(WS, c.hashFile)) : null
      let res = null, classification = 'FAIL', reason = ''
      try {
        const args = typeof c.args === 'function' ? await c.args(ctx, C) : c.args
        res = c.direct ? { ok: true, delegated: true, result: args } : await C.invoke(c.tool, args, {}, c.timeout)
        // R03（0.5.10 审核修复）：pred 第二参 {before, after}——写族用例必须断言内容真的变了（初审把 dry_run 预览记成了真写）
        const hh = { before, after: c.hashFile ? sha256(join(WS, c.hashFile)) : null }
        if (res?._rpcError) { classification = 'FAIL'; reason = 'rpc: ' + trim(res._rpcError, 200) }
        else if (!res || res.ok !== true) { classification = c.boundary ? 'BOUNDARY' : 'FAIL'; reason = 'delegate: ' + errText(res) }
        else {
          if (c.capture) c.capture(res.result, ctx)
          // F2（0.5.14 Windows 复核）：验证类用例走统一分类器（先读 verification/阶段事实，再判 NOT_RUN/PASS/FAIL）——
          // 「动作成功」不推导为「检查通过」；本分支优先于旧的 hasError/pred 路径（lint 缺件曾因此被计 PASS）。
          if (typeof c.verify === 'function') {
            const v = c.verify(res.result)
            classification = v.classification
            reason = v.reason || ''
          } else if (c.unavailableIf && c.unavailableIf(res.result)) {
            classification = 'NOT_RUN'; reason = 'not executed: ' + errText(res.result)
          } else if (hasError(res.result)) {
            if (c.notRunIf && c.notRunIf(res.result)) { classification = 'NOT_RUN'; reason = 'env: ' + errText(res.result) }
            else if (c.boundary) { classification = 'BOUNDARY'; reason = errText(res.result) }
            else { classification = 'FAIL'; reason = 'result error: ' + errText(res.result) }
          } else if (c.pred(res.result, hh)) { classification = 'PASS'; reason = '' }
          else { classification = 'FAIL'; reason = 'predicate false: ' + trim(res.result, 250) }
        }
      } catch (e) {
        classification = 'FAIL'; reason = 'exception: ' + String(e?.message || e)
      }
      const after = c.hashFile ? sha256(join(WS, c.hashFile)) : null
      cases.push({
        id: c.id, tool: c.tool, scenario: c.scenario, classification, reason,
        duration_ms: Date.now() - t0,
        delegated: res?.ok === true && res?.delegated === true,
        effects: res?.effects || null,
        wiring_status: res?.wiring_status || null,
        hashes: c.hashFile ? { file: c.hashFile, before, after } : undefined,
        result_excerpt: res?._rpcError ? trim(res._rpcError, 250) : trim(res?.result, 250),
      })
      process.stdout.write(`  [${classification}] ${c.id}\n`)
    }
  } finally {
    C.kill()
  }

  const byTool = {}
  for (const c of cases) {
    byTool[c.tool] = byTool[c.tool] || { pass: 0, boundary: 0, not_run: 0, fail: 0 }
    const k = c.classification === 'PASS' ? 'pass' : c.classification === 'BOUNDARY' ? 'boundary' : c.classification === 'NOT_RUN' ? 'not_run' : 'fail'
    byTool[c.tool][k]++
  }
  const toolsNoPass = Object.entries(byTool).filter(([, v]) => v.pass === 0).map(([k]) => k)
  const summary = {
    pass: cases.filter((c) => c.classification === 'PASS').length,
    boundary: cases.filter((c) => c.classification === 'BOUNDARY').length,
    not_run: cases.filter((c) => c.classification === 'NOT_RUN').length,
    fail: cases.filter((c) => c.classification === 'FAIL').length,
    tools_covered: Object.keys(byTool).length,
    tools_without_pass: toolsNoPass,
  }
  const report = {
    schema: 'g3.acceptance.v1', generated_at: new Date().toISOString(), duration_ms: Date.now() - startedAt,
    malong_git_head: gitHead, interface: 'graph+state', fixture_ws: WS, contract_tools: 44,
    discovery, summary, by_tool: byTool, cases,
  }
  mkdirSync(dirname(OUT_JSON), { recursive: true })
  writeFileSync(OUT_JSON, JSON.stringify(report, null, 2) + '\n')

  // 人读报告
  const icon = { PASS: '✅', BOUNDARY: '◐', NOT_RUN: '⛔', FAIL: '✗' }
  const lines = []
  lines.push('# G3 运行级验收（原 44 项）', '')
  lines.push(`生成：${report.generated_at}（耗时 ${(report.duration_ms / 1000).toFixed(1)}s；malong@${gitHead || '?'}；graph+state；fixture=${WS}）`, '')
  lines.push('> 本文件由 `malong/tests/test-g3-acceptance.js` 生成，禁手改。原始记录：`reports/g3-acceptance/latest.json`。', '')
  lines.push('## 汇总', '')
  lines.push(`- 发现：枚举 ${discovery?.listed_items}/${discovery?.listed_total}（缺失 ${discovery?.missing?.length || 0}）；describe 成功 ${discovery?.describe?.ok}/${CASES.map(c=>c.tool).filter((v,i,a)=>a.indexOf(v)===i).length}（schema ${discovery?.describe?.schema}，call_template ${discovery?.describe?.template}）`)
  lines.push(`- 执行：PASS ${summary.pass} / BOUNDARY ${summary.boundary} / NOT_RUN ${summary.not_run} / FAIL ${summary.fail}；覆盖工具 ${summary.tools_covered}/44`)
  if (toolsNoPass.length) lines.push(`- **无 PASS 工具**：${toolsNoPass.join(', ')}`)
  lines.push('', '## 逐项结果', '', '| 工具 | 场景 | 判定 | 证据/原因 |', '|---|---|---|---|')
  for (const c of cases) lines.push(`| ${c.tool} | ${c.scenario} | ${icon[c.classification] || c.classification} | ${(c.classification === 'PASS' ? (c.hashes ? `hash ${c.hashes.before || '∅'}→${c.hashes.after || '∅'}` : trim(c.result_excerpt, 90)) : trim(c.reason, 160)).replace(/\n/g, ' ').replace(/\|/g, '/')} |`)
  const notRuns = cases.filter((c) => c.classification === 'NOT_RUN')
  if (notRuns.length) { lines.push('', '## NOT_RUN 单列', ''); for (const c of notRuns) lines.push(`- **${c.tool}**（${c.scenario}）：${trim(c.reason, 200)} → 下一动作：装齐环境后重跑本用例`) }
  const fails = cases.filter((c) => c.classification === 'FAIL')
  if (fails.length) { lines.push('', '## FAIL 待修', ''); for (const c of fails) lines.push(`- **${c.tool}** / ${c.id}：${trim(c.reason, 240)}`) }
  if (process.argv.includes('--report')) {
    lines.push('', '## 未覆盖模式（手工裁定，防假绿）', '')
    lines.push('- read_symbol on_ambiguous=fail 歧义分支：需同名跨文件夹具；由专项单测覆盖，未入本轮 MCP 验收')
    lines.push('- reindex 两步 confirm 流程：需超阈值夹具（>2000 文件）；单测 test-reindex-confirm.js 覆盖')
    lines.push('- verify_pipeline stages=syntax：handler 内部扩展，未在 manifest 枚举（非公开模式）')
    lines.push('- health action=restart：破坏性，置于用例末位；失败仅影响其自身用例')
    writeFileSync(OUT_MD, lines.join('\n') + '\n')
    console.log('matrix: ' + OUT_MD)
  } else {
    console.log('matrix: skipped (pass --report to regenerate reports/g3-acceptance/G3-运行级验收-<date>.md)')
  }

  console.log('\n=== G3 acceptance: PASS ' + summary.pass + ', BOUNDARY ' + summary.boundary + ', NOT_RUN ' + summary.not_run + ', FAIL ' + summary.fail + ' ===')
  console.log('report: ' + OUT_JSON)
  process.exit(summary.fail > 0 ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(2) })
