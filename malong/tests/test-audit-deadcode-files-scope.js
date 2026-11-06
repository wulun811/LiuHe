// test-audit-deadcode-files-scope.js — dead_code 必须尊重 files 参数（B5）
//
// 背景：DSH 实录 2026-11-02 §2.3/§2.5 实测——
//   传 files: [3 个文件] 给 code_audit，code_review / exception_guard / code_quality
//   都只扫这 3 个文件（scope.kind="files"），唯独 dead_code 无视 files、扫全库
//   （scope.kind="workspace"），报 88 条与传入文件无关的 info，需人肉筛掉。
//
// 判据：传 files 时，dead_code 的发现必须全部落在这些文件里；不传时行为不变。
//
// 注意：死代码扫描在"临时小目录 + 无 import 图"下返回 0 条（实测），
// 那样测不出任何东西。本测试因此对**真实仓库自身**取基线（只读，不写工作区）。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, rmSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = join(__dirname, '..', '..')          // liuhe/（真实仓库根，含 malong/）
const TMP = join(os.tmpdir(), 'opencode', 'audit-dc-files')
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
mkdirSync(TMP, { recursive: true })
process.env.MALONG_STATE_DIR = join(TMP, 'state')
process.env.MALONG_ENTRY_STATE = '1'

let pass = 0, fail = 0
const assert = (c, m) => { if (c) pass++; else { fail++; console.error('  FAIL:', m) } }
const imp = (p) => import(pathToFileURL(p).href)

const store = await imp(join(__dirname, '..', 'tools', 'entry-store.js'))
const audit = await imp(join(__dirname, '..', 'tools', 'tool-code-audit', 'handler.js'))

const WS = REPO
const tid = 'task_dcf'
const task = {
  task_id: tid, revision: 1, lifecycle: 'active', route: 'review', node: 'read', workspace_dir: WS,
  materials: [], operations: [], evidence: [],
}
store.putTask(WS, task, { type: 'task_created', task })

const dcFindings = (r) => (r.observation?.findings || []).filter(x => x.check === 'dead_code')
const norm = (p) => String(p || '').replace(/\\/g, '/')

// ── ① 基线：不传 files → 全库扫描（可能跨多文件）──
const base = await audit.handle({ workspace_dir: WS, task_id: tid, checks: ['dead_code'] }, {})
assert(base.ok === true, `① 全库扫描成功（得 ${JSON.stringify(base.error || null)}）`)
const baseF = dcFindings(base)
const baseFiles = [...new Set(baseF.map(x => norm(x.file)).filter(Boolean))]
// 若真实仓库当前零死代码，本测试无法区分两种语义 → 明确跳过而不是假装通过
if (baseFiles.length < 2) {
  console.log(`\n  SKIP: 真实仓库死代码发现仅涉及 ${baseFiles.length} 个文件，无法区分 files/scope 语义`)
  rmSync(TMP, { recursive: true, force: true })
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
assert(baseFiles.length >= 2, `① 基线应涉及多个文件（得 ${baseFiles.length}）`)

// ── ② 传单个 files：发现必须全部落在该文件内 ──
{
  const target = baseFiles[0]
  const r = await audit.handle({ workspace_dir: WS, task_id: tid, checks: ['dead_code'], files: [target] }, {})
  assert(r.ok === true, '② 传 files 时正常返回')
  const f = dcFindings(r)
  const outside = f.filter(x => norm(x.file) !== target)
  assert(outside.length === 0,
    `② dead_code 发现必须落在传入 files 内（越界 ${outside.length} 条，例：${JSON.stringify(outside.slice(0, 3).map(x => x.file))}）`)
  assert(f.length < baseF.length,
    `② 传单文件应比全库少（全库 ${baseF.length} 条 → 单文件 ${f.length} 条）`)
}

// ── ③ 传多个 files：不得越界到第三个文件 ──
if (baseFiles.length >= 3) {
  const two = baseFiles.slice(0, 2)
  const r = await audit.handle({ workspace_dir: WS, task_id: tid, checks: ['dead_code'], files: two }, {})
  const f = dcFindings(r)
  const outside = f.filter(x => !two.includes(norm(x.file)))
  assert(outside.length === 0,
    `③ 多 files 时不得越界（越界 ${outside.length} 条：${JSON.stringify(outside.slice(0, 3).map(x => x.file))}）`)
}

// ── ④ 显式 scope 优先于 files（与 security_review 优先级一致）──
//    选一个"目录内有 ≥2 个死代码文件"的目录，否则 scope 结果与单文件相同、区分不出优先级。
{
  // 找出包含最多死代码文件的目录
  const byDir = new Map()
  for (const x of baseF) {
    const f = norm(x.file)
    const d = f.split('/').slice(0, -1).join('/')
    if (!d) continue
    if (!byDir.has(d)) byDir.set(d, new Set())
    byDir.get(d).add(f)
  }
  const multi = [...byDir.entries()].filter(([, s]) => s.size >= 2).sort((a, b) => b[1].size - a[1].size)[0]
  if (!multi) {
    console.log('  SKIP ④: 无"目录内 ≥2 个死代码文件"的目录，无法区分 scope/files 优先级')
  } else {
    const [dir, set] = multi
    const target = [...set][0]
    const r = await audit.handle({ workspace_dir: WS, task_id: tid, checks: ['dead_code'], files: [target], scope: dir }, {})
    assert(r.ok === true, '④ scope+files 同时给时不报错')
    const f = dcFindings(r)
    const scoped = f.filter(x => norm(x.file).startsWith(dir + '/'))
    const onlyTarget = f.length > 0 && f.every(x => norm(x.file) === target)
    assert(!onlyTarget,
      `④ 显式 scope 应优先于 files（目录 ${dir} 有 ${set.size} 个死代码文件，结果不得被收窄成只剩 ${target}）`)
    assert(scoped.length === f.length, '④ scope 结果必须全部落在该目录内')
  }
}

rmSync(TMP, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
