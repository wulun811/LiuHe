#!/usr/bin/env node
// test-p2-read-race.js — P2 修复（2026-10-12 狗粮）：同任务并发 code_read 的 CAS 冲突有界重试
// 旧实现：Promise.all 并发读同一任务 → 后者 revision_conflict（报文含未传参数 undefined）；
// 读是幂等追加材料，应自动重试成功；写路径仍不自动重试（防覆盖）。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP = join(os.tmpdir(), 'opencode', 'p2-read-race')
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
process.env.MALONG_STATE_DIR = join(TMP, 'state')
process.env.MALONG_ENTRY_STATE = '1'

let pass = 0, fail = 0
function assert(cond, msg) { if (cond) { pass++; console.log(`  ✓ ${msg}`) } else { fail++; console.log(`  ✗ ${msg}`) } }
const imp = (p) => import(pathToFileURL(p).href)

const shared = await imp(join(__dirname, '..', 'tools', 'entry-shared.js'))
const read = await imp(join(__dirname, '..', 'tools', 'tool-code-read', 'handler.js'))

const ws = join(TMP, 'ws')
mkdirSync(ws, { recursive: true })
writeFileSync(join(ws, 'a.js'), 'export const a = 1\n')
writeFileSync(join(ws, 'b.js'), 'export const b = 2\n')
const task = { task_id: 'task_race', revision: 1, route: 'change', lifecycle: 'active', node: 'orient', materials: [], operations: [], evidence: [], candidates: [], workspace_dir: ws }
shared.putTask(ws, task, { type: 'task_created', task })

const ctx = { getWorkspaceDir: () => ws, codeIndexService: { getFileByPath: () => null, getSymbolByStableId: () => null, initWorkspace: async () => {} } }
const reads = await Promise.all([
  read.handle({ workspace_dir: ws, task_id: 'task_race', locator: { file_path: 'a.js' } }, ctx),
  read.handle({ workspace_dir: ws, task_id: 'task_race', locator: { file_path: 'a.js' } }, ctx),
  read.handle({ workspace_dir: ws, task_id: 'task_race', locator: { file_path: 'b.js' } }, ctx),
])
const oks = reads.filter(r => r.ok === true)
assert(oks.length === 3, `P2 并发 3 读全部成功（得 ${oks.length}；errors=${JSON.stringify(reads.filter(r => !r.ok).map(r => r.error))}）`)
const refs = oks.map(r => r.observation?.read_refs?.[0])
assert(new Set(refs).size === 3 && refs.every(Boolean), `P2 材料互异不覆盖（得 ${JSON.stringify(refs)}）`)

console.log(`\n=== test-p2-read-race: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
