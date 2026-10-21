// test-s3-schema-gc.js — S3.3：T20 任务 schema/graph 版本 + T14 GC 活跃资产护栏
// 覆盖：新建任务盖章；更新版本显式拒绝；旧任务（无版本）兼容；GC 不删保留名/含 journal 标记的目录。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, rmSync, existsSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP = join(tmpdir(), 'opencode', 's3-schema-gc-test')
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
const WS = join(TMP, 'ws'); mkdirSync(WS, { recursive: true })
process.env.MALONG_STATE_DIR = join(TMP, 'state')

let pass = 0, fail = 0
const assert = (c, m) => { if (c) pass++; else { fail++; console.error('  FAIL:', m) } }
const imp = (p) => import(pathToFileURL(p).href)

const shared = await imp(join(__dirname, '..', 'tools', 'entry-shared.js'))
const store = await imp(join(__dirname, '..', 'tools', 'entry-store.js'))
const taskH = await imp(join(__dirname, '..', 'tools', 'tool-code-task', 'handler.js'))
const control = await imp(join(__dirname, '..', 'tools', 'tool-code-control', 'handler.js'))
const readH = await imp(join(__dirname, '..', 'tools', 'tool-code-read', 'handler.js'))
const patchH = await imp(join(__dirname, '..', 'tools', 'tool-code-patch', 'handler.js'))
const { cleanupStaleWorkspaces } = await imp(join(__dirname, '..', 'health-check.js'))

const mockIndex = () => ({
  async initWorkspace() {}, async indexBatch() { return [] },
  async findDefinitions() { return [] }, async searchSymbols() { return [] },
  findSymbolsInFile() { return [] }, getSymbolByStableId() { return null }, getFileByPath() { return null },
})
const ctx = { codeIndexService: mockIndex(), langParserService: null }

// ── T20：新建任务盖章 ──
let r = await taskH.handle({ workspace_dir: WS, goal: 'understand login' }, ctx)
assert(r.ok === true, 'code_task 成功')
const tid = r.task.task_id
const t = store.getTask(WS, tid)
assert(t.schema_version === shared.TASK_SCHEMA_VERSION && t.graph_version === shared.GRAPH_VERSION, `新任务盖章（schema=${t.schema_version}, graph=${t.graph_version}）`)

// ── T20：更新版本显式拒绝 ──
const newer = { task_id: 'task_newer', revision: 1, schema_version: 99, graph_version: '9.9.9', route: 'change', lifecycle: 'active', node: 'read', materials: [], operations: [], evidence: [], workspace_dir: WS }
shared.putTask(WS, newer, { type: 'task_created', task: newer })
assert((await control.handle({ workspace_dir: WS, task_id: 'task_newer', action: 'status' })).error === 'task_version_unsupported', 'code_control 拒更新版本')
assert((await readH.handle({ workspace_dir: WS, task_id: 'task_newer', locator: { file_path: 'x.js' } }, ctx)).error === 'task_version_unsupported', 'code_read 拒更新版本')
assert((await patchH.handle({ workspace_dir: WS, task_id: 'task_newer', locator: { file_path: 'x.js' }, edit_mode: 'patch', patch: { old_string: 'a', new_string: 'b' } }, ctx)).error === 'task_version_unsupported', 'code_patch 拒更新版本')

// ── T20：旧任务（无版本）兼容 ──
const legacy = { task_id: 'task_legacy', revision: 1, route: 'change', lifecycle: 'active', node: 'read', materials: [], operations: [], evidence: [], workspace_dir: WS }
shared.putTask(WS, legacy, { type: 'task_created', task: legacy })
assert((await control.handle({ workspace_dir: WS, task_id: 'task_legacy', action: 'status' })).ok === true, '旧任务（无版本）兼容')

// ── T14：GC 不删活跃资产 ──
const ROOT = join(TMP, 'idxcache')
const DAY = 86400000
const now = Date.now()
function mk(marker) {
  const d = join(ROOT, marker)
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, 'metadata.json'), JSON.stringify({ workspace_dir: '/x/' + marker, last_accessed: new Date(now - 30 * DAY).toISOString() }))
  writeFileSync(join(d, 'code-index.db'), 'x'.repeat(2048))
  utimesSync(join(d, 'metadata.json'), (now - 30 * DAY) / 1000, (now - 30 * DAY) / 1000)
  utimesSync(join(d, 'code-index.db'), (now - 30 * DAY) / 1000, (now - 30 * DAY) / 1000)
}
mk('stalehash0000')
mk('keepmarker00')
mkdirSync(join(ROOT, 'entry-tasks'), { recursive: true }); writeFileSync(join(ROOT, 'entry-tasks', 'keep.json'), '{}')
mkdirSync(join(ROOT, 'jobs'), { recursive: true }); writeFileSync(join(ROOT, 'jobs', 'keep.json'), '{}')
mkdirSync(join(ROOT, 'hashwithtail'), { recursive: true }); writeFileSync(join(ROOT, 'hashwithtail', 'metadata.json'), '{}'); mkdirSync(join(ROOT, 'hashwithtail', 'journal'), { recursive: true })
utimesSync(join(ROOT, 'hashwithtail'), (now - 30 * DAY) / 1000, (now - 30 * DAY) / 1000)

const res = cleanupStaleWorkspaces(ROOT, { maxAgeDays: 14, dryRun: false })
assert(res.deleted.some(d => d.workspace === 'stalehash0000'), 'T14：普通 stale 仍删')
assert(existsSync(join(ROOT, 'entry-tasks')) && existsSync(join(ROOT, 'jobs')), 'T14：entry-tasks/jobs 保留名不删')
assert(existsSync(join(ROOT, 'hashwithtail', 'journal')), 'T14：含 journal 标记的目录不删')

console.log(`\n=== test-s3-schema-gc: ${pass} passed, ${fail} failed ===`)
process.exit(fail > 0 ? 1 : 0)