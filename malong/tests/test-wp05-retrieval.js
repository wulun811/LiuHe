#!/usr/bin/env node
// test-wp05-retrieval.js — WP05 Tier-0 检索到证据衔接收口
// 覆盖：候选→阅读→支持结论链路指标（projectEffectiveState.pipeline 纯投影 + code_status 透出）、
//       索引忽略与 Git 忽略明确区分（code_task index_scope.ignore_scope 声明）。
// AC22/AC32 的检索评分/分组预算/留出题冻结已在 test-retrieval-bench 锁定（52 断言），此处不重复调分。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP = join(os.tmpdir(), 'opencode', 'wp05-retrieval')
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
mkdirSync(join(TMP, 'src'), { recursive: true })
process.env.MALONG_STATE_DIR = join(TMP, 'state')
process.env.MALONG_ENTRY_STATE = '1'

let pass = 0, fail = 0
function assert(cond, msg) { if (cond) { pass++; console.log(`  ✓ ${msg}`) } else { fail++; console.log(`  ✗ ${msg}`) } }

const shared = await import(pathToFileURL(join(__dirname, '..', 'tools', 'entry-shared.js')).href)
const { projectEffectiveState } = await import(pathToFileURL(join(__dirname, '..', 'workflow', 'effective-state.js')).href)
const status = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-code-status', 'handler.js')).href)
const ctx = {}
const WS = TMP

writeFileSync(join(WS, 'alpha.js'), 'export function alphaFind() { return 1 }\n')

function mkTask(id, extra = {}) {
  const t = { task_id: id, revision: 1, route: 'understand', lifecycle: 'active', node: 'orient', goal: 'g', materials: [], operations: [], evidence: [], candidates: [], workspace_dir: WS, ...extra }
  shared.putTask(WS, t, { type: 'task_created', task: t })
  return t
}

console.log('== 链路指标：候选→阅读→支持结论（纯投影）==')
{
  mkTask('task_pipe', {
    candidates: [
      { name: 'alphaFind', kind: 'function', file_path: 'src/alpha.js', symbol_id: null, range: [1, 1], rank_reason: 'exact_name' },
      { name: 'betaHelper', kind: 'function', file_path: 'src/beta.js', symbol_id: null, range: [1, 1], rank_reason: 'fuzzy' },
    ],
    materials: [{ read_ref: 'read_1', canonical_path: 'src/alpha.js', locator: { file_path: 'src/alpha.js' } }],
  })
  const p = projectEffectiveState(WS, shared.getTask(WS, 'task_pipe'))
  assert(p.pipeline && p.pipeline.candidates === 2, `pipeline.candidates=2（得 ${p.pipeline?.candidates}）`)
  assert(p.pipeline.candidates_read === 1 && p.pipeline.reads === 1, `候选被读 1/2（得 ${p.pipeline?.candidates_read}）`)
  assert(p.pipeline.evidence === 0, '证据 0（未检查不冒充结论）')
  // 支持结论出现后 evidence 入账 → 链路三环齐全
  const t = shared.getTask(WS, 'task_pipe')
  t.evidence = [{ evidence_id: 'ev1', kind: 'read:file', result: 'passed', goal_revision: 1 }]
  shared.putTask(WS, t, { type: 'evidence', data: {} })
  const p2 = projectEffectiveState(WS, shared.getTask(WS, 'task_pipe'))
  assert(p2.pipeline.evidence === 1, '候选→阅读→证据全链计数（得 ' + JSON.stringify(p2.pipeline) + '）')
  // 纯投影：不涨 revision、不落盘
  const revBefore = shared.getTask(WS, 'task_pipe').revision
  projectEffectiveState(WS, shared.getTask(WS, 'task_pipe'))
  assert(shared.getTask(WS, 'task_pipe').revision === revBefore, '投影不涨 revision（WP01 纪律）')
}

console.log('== code_status 透出 pipeline ==')
{
  const r = await status.handle({ workspace_dir: WS, task_id: 'task_pipe' }, ctx)
  assert(r.ok === true && r.observation?.pipeline?.candidates === 2 && r.observation.pipeline.evidence === 1, 'status 出口带链路指标')
}

console.log('== 索引忽略与 Git 忽略明确区分（code_task 声明）==')
{
  const task = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-code-task', 'handler.js')).href)
  const idxMock = {
    async initWorkspace() {},
    async indexBatch(files) { return [] },
    async findDefinitions() { return [] },
    async searchSymbols() { return [] },
    async getSymbolsAtLine() { return [] },
    async getFileOutline() { return { outline: [] } },
  }
  const r = await task.handle({ workspace_dir: WS, goal: 'alphaFind pipeline', route: 'understand' }, { codeIndexService: idxMock })
  assert(r.ok === true, 'code_task 真跑成功（mock 索引）')
  // index_scope 持久化在 task 上
  const t = shared.listTasks(WS).find(x => x.goal === 'alphaFind pipeline')
  assert(t?.index_scope?.ignore_scope && /malongignore/.test(t.index_scope.ignore_scope) && /git\/info\/exclude/.test(t.index_scope.ignore_scope), 'index_scope.ignore_scope 声明两类忽略分离（.malongignore 管扫描 / .git/info/exclude 管 git）')
}

console.log(`\n=== test-wp05-retrieval: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
