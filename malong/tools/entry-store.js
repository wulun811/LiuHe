// entry-store.js — S2 任务状态持久化（ADR-001）。
// 位置：$MALONG_STATE_DIR/entry-tasks/<wsHash>/（不污染用户仓库）。
// 模型：事件先行（jsonl 权威）→ 原子写快照（物化缓存）；revision/CAS；request_id 去重。
// 崩溃窗口 W1（快照旧/事件新 → 重建）、W2（原子写无半截）、W3（jsonl 尾部半行丢弃）、W4（仅索引无快照 → 忽略）。
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import {
  existsSync, mkdirSync, readFileSync, readdirSync, rmSync, mkdtempSync,
  openSync, writeSync, fsyncSync, closeSync, statSync, readSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { atomicWrite } from '../path-guard.js'
import { getStateDir } from '../host-config.js'

const TASK_ROOT = 'entry-tasks'

// E2 stateless 臂：MALONG_ENTRY_EPHEMERAL=1 → 每进程一个临时根，进程重启即丢（同进程内仍持久）。
// 与 stateful 臂共用同一套 store 逻辑（不改写路径），仅后端根不同——保证能力匹配、只差“跨重启存活”。
let EPHEMERAL_ROOT = null

function baseDir(workspaceDir) {
  if (process.env.MALONG_ENTRY_EPHEMERAL === '1') {
    if (!EPHEMERAL_ROOT) {
      EPHEMERAL_ROOT = mkdtempSync(join(tmpdir(), 'malong-eph-'))
      // 进程退出时清理临时根（best-effort；泄漏仅是 /tmp 残留，不影响正确性）
      process.once('exit', () => { try { rmSync(EPHEMERAL_ROOT, { recursive: true, force: true }) } catch {} })
    }
    return join(EPHEMERAL_ROOT, TASK_ROOT, wsHash(workspaceDir))
  }
  return join(getStateDir(), TASK_ROOT, wsHash(workspaceDir))
}

export function wsHash(workspaceDir) {
  // resolve 对齐 mcp-server.getWorkspaceDir（相对/绝对路径必须映射到同一命名空间）
  return createHash('md5').update(resolve(workspaceDir)).digest('hex').slice(0, 12) // malong-ignore: 仅用于缓存目录名
}
function ensureBase(workspaceDir) { const d = baseDir(workspaceDir); if (!existsSync(d)) mkdirSync(d, { recursive: true }); return d }
function taskPath(workspaceDir, taskId) { return join(baseDir(workspaceDir), `${taskId}.json`) }
function eventsPath(workspaceDir, taskId) { return join(baseDir(workspaceDir), `${taskId}.events.jsonl`) }
function reqIndexPath(workspaceDir) { return join(baseDir(workspaceDir), 'by-request.json') }

function endsWithNewline(p) {
  try {
    const st = statSync(p)
    if (st.size === 0) return true
    const fd = openSync(p, 'r')
    try { const b = Buffer.alloc(1); readSync(fd, b, 0, 1, st.size - 1); return b[0] === 0x0a } finally { closeSync(fd) }
  } catch { return true }
}

function appendEventFile(workspaceDir, taskId, event) {
  ensureBase(workspaceDir)
  const p = eventsPath(workspaceDir, taskId)
  // W3 修复：上一条若为撕裂半行（无换行），先补换行，避免后续事件被半行吞掉
  const prefix = existsSync(p) && !endsWithNewline(p) ? '\n' : ''
  const fd = openSync(p, 'a')
  try {
    writeSync(fd, prefix + JSON.stringify(event) + '\n')
    try { fsyncSync(fd) } catch {}
  } finally { closeSync(fd) }
}

// W3 语义（第二轮审查复核）：append 崩溃的残行会被后续 appendEventFile 的补 '\n' 修复，
// 残行不可解析但**后续行是崩溃后合法追加**（test-s2-store 固化：半行后事件必须仍可读）——
// 因此跳过不可解析行、不毒化后续是正确行为；旧注释「中间损坏则停止」与实现不符，已修正。
export function readEvents(workspaceDir, taskId) {
  const p = eventsPath(workspaceDir, taskId)
  if (!existsSync(p)) return []
  const out = []
  for (const line of readFileSync(p, 'utf-8').split('\n')) {
    if (!line) continue
    try { out.push(JSON.parse(line)) } catch { continue } // W3：跳过不可解析行（残行），不毒化后续合法事件
  }
  return out
}

// 事件回放重建快照（事件为权威）。
export function rebuildTask(workspaceDir, taskId) {
  let t = null
  for (const ev of readEvents(workspaceDir, taskId)) {
    if (ev.type === 'task_created') {
      t = {
        ...ev.task,
        materials: Array.isArray(ev.task?.materials) ? ev.task.materials.slice() : [],
        operations: Array.isArray(ev.task?.operations) ? ev.task.operations.slice() : [],
        evidence: Array.isArray(ev.task?.evidence) ? ev.task.evidence.slice() : [],
      }
    } else if (!t) {
      continue
    } else if (ev.type === 'material_added') {
      t.materials.push(ev.material)
      if (ev.revision != null) t.revision = ev.revision
      if (ev.node) t.node = ev.node
    } else if (ev.type === 'operation') {
      // S2.1：操作事件重放——按 operation_id 覆盖/追加（崩溃后状态可核对）
      t.operations = upsertById(t.operations, ev.operation, 'operation_id')
      applyRevisionFields(t, ev)
    } else if (ev.type === 'evidence') {
      // S2.1b：证据事件重放（+ 同事件携带的操作终态）
      for (const e of (ev.evidences || [])) t.evidence = upsertById(t.evidence, e, 'evidence_id')
      if (ev.operation) t.operations = upsertById(t.operations, ev.operation, 'operation_id')
      applyRevisionFields(t, ev)
    } else if (ev.type === 'node_changed') {
      t.node = ev.node
      if (ev.revision != null) t.revision = ev.revision
    } else if (ev.type === 'route_changed') {
      if (ev.route) t.route = ev.route
      if (ev.goal != null) t.goal = ev.goal
      if (ev.goal_revision != null) t.goal_revision = ev.goal_revision
      applyRevisionFields(t, ev)
    } else if (ev.type === 'lifecycle') {
      t.lifecycle = ev.lifecycle
      applyRevisionFields(t, ev)
    }
  }
  return t
}

// 按主键 upsert（事件重放用；保持原数组不变）
function upsertById(arr, item, key) {
  const list = Array.isArray(arr) ? arr.slice() : []
  if (!item) return list
  const i = list.findIndex(x => x[key] === item[key])
  if (i >= 0) list[i] = item; else list.push(item)
  return list
}

function applyRevisionFields(t, ev) {
  if (ev.revision != null) t.revision = ev.revision
  if (ev.node) t.node = ev.node
  if (ev.result_kind) t.result_kind = ev.result_kind
}

function writeTaskSnapshot(workspaceDir, task) {
  ensureBase(workspaceDir)
  atomicWrite(taskPath(workspaceDir, task.task_id), JSON.stringify(task, null, 2), { fsync: true })
}

// 事件中的最新 revision（W1b 快照落后检测用）；无 revision 事件返回 null
function latestEventRevision(events) {
  let rev = null
  for (const ev of events) {
    const r = typeof ev.revision === 'number' ? ev.revision : (typeof ev.task?.revision === 'number' ? ev.task.revision : null)
    if (r != null && (rev == null || r > rev)) rev = r
  }
  return rev
}

export function getTask(workspaceDir, taskId) {
  const p = taskPath(workspaceDir, taskId)
  let snap = null
  if (existsSync(p)) {
    try { snap = JSON.parse(readFileSync(p, 'utf-8')) } catch {}
  }
  if (snap) {
    const evRev = latestEventRevision(readEvents(workspaceDir, taskId))
    // W1b：快照落后于事件（快照写失败/丢失而事件已落盘）→ 必须重建，不得返回旧快照
    if (evRev == null || (typeof snap.revision === 'number' && snap.revision >= evRev)) return snap
  }
  // W1/W2：快照缺失、损坏或落后 → 由事件重建并回填
  const rebuilt = rebuildTask(workspaceDir, taskId)
  if (rebuilt) { try { writeTaskSnapshot(workspaceDir, rebuilt) } catch {} }
  return rebuilt
}

export function putTask(workspaceDir, task, event = null) {
  const ev = event || { type: 'task_created', task }
  appendEventFile(workspaceDir, task.task_id, { ts: new Date().toISOString(), ...ev })
  writeTaskSnapshot(workspaceDir, task)
  if (task.request_id) putRequestIndex(workspaceDir, task.request_id, task.task_id)
  return task
}

export function listTasks(workspaceDir) {
  const d = baseDir(workspaceDir)
  if (!existsSync(d)) return []
  const out = []
  for (const f of readdirSync(d)) {
    if (!f.endsWith('.json') || f === 'by-request.json') continue
    const id = f.slice(0, -5)
    try {
      let t = JSON.parse(readFileSync(join(d, f), 'utf-8'))
      // 第二轮审查：快照可能落后于事件（W1b）——与 getTask 同语义，用事件重建避免列表展示旧 revision
      try {
        const evRev = latestEventRevision(readEvents(workspaceDir, id))
        if (evRev != null && typeof t.revision === 'number' && t.revision < evRev) t = rebuildTask(workspaceDir, id) || t
      } catch {}
      out.push(t)
    } catch {}
  }
  return out
}

// CAS 更新：expectedRevision 必须等于当前 revision，否则不写并返回冲突。
// mutate(next) 返回 { type, data }（决定事件类型与字段）。
export function updateTaskCas(workspaceDir, taskId, expectedRevision, mutate, eventType = 'mutation') {
  const cur = getTask(workspaceDir, taskId)
  if (!cur) return { ok: false, code: 'TASK_NOT_FOUND' }
  if (expectedRevision != null && cur.revision !== expectedRevision) {
    return { ok: false, code: 'REVISION_CONFLICT', current: cur.revision }
  }
  const next = { ...cur, materials: Array.isArray(cur.materials) ? cur.materials.slice() : [] }
  const ev = mutate(next) || {}
  next.revision = (cur.revision || 1) + 1
  appendEventFile(workspaceDir, taskId, {
    ts: new Date().toISOString(), type: ev.type || eventType, revision: next.revision, ...(ev.data || {}),
  })
  writeTaskSnapshot(workspaceDir, next)
  return { ok: true, task: next }
}

export function putRequestIndex(workspaceDir, requestId, taskId) {
  ensureBase(workspaceDir)
  let idx = {}
  try { idx = JSON.parse(readFileSync(reqIndexPath(workspaceDir), 'utf-8')) } catch {}
  idx[requestId] = taskId
  atomicWrite(reqIndexPath(workspaceDir), JSON.stringify(idx, null, 2), { fsync: true })
}
export function findByRequestId(workspaceDir, requestId) {
  try { return JSON.parse(readFileSync(reqIndexPath(workspaceDir), 'utf-8'))[requestId] || null } catch { return null }
}

// 单命名空间目录的 TTL 清扫：终态任务超龄删；活跃任务永不自动删。
function pruneTaskDir(d, { maxAgeHours = 24, dryRun = false } = {}) {
  if (!existsSync(d)) return { pruned: 0, kept: 0, dry_run: dryRun }
  const cutoff = Date.now() - maxAgeHours * 3600 * 1000
  let pruned = 0, kept = 0
  const deletedIds = []
  for (const f of readdirSync(d)) {
    if (!f.endsWith('.json') || f === 'by-request.json') continue
    const p = join(d, f)
    let task = null
    try { task = JSON.parse(readFileSync(p, 'utf-8')) } catch {}
    // S3 审查修复：真实 Task 终态为 cancelled/completed（§7.1）；保留 done/abandoned 兼容旧数据
    const terminal = task && ['cancelled', 'completed', 'done', 'abandoned'].includes(task.lifecycle)
    let tsMs = NaN
    try { tsMs = statSync(p).mtimeMs } catch {}
    if (!terminal || !(tsMs < cutoff)) { kept++; continue }
    const id = f.replace(/\.json$/, '')
    if (!dryRun) {
      try { rmSync(p, { force: true }) } catch { kept++; continue }
      try { rmSync(join(d, `${id}.events.jsonl`), { force: true }) } catch {}
      deletedIds.push(id)
    }
    pruned++
  }
  // 清理指向已删任务的去重索引项（防 dedup 命中幽灵任务）
  if (!dryRun && deletedIds.length) {
    try {
      const idx = JSON.parse(readFileSync(join(d, 'by-request.json'), 'utf-8'))
      let changed = false
      for (const [k, v] of Object.entries(idx)) if (deletedIds.includes(v)) { delete idx[k]; changed = true }
      if (changed) atomicWrite(join(d, 'by-request.json'), JSON.stringify(idx, null, 2), { fsync: true })
    } catch {}
  }
  return { pruned, kept, dry_run: dryRun }
}

export function pruneTasks(workspaceDir, opts = {}) {
  return pruneTaskDir(baseDir(workspaceDir), opts)
}

// TTL 清扫全部 workspace 命名空间（health(action=cleanup) 的调用方）。
// 此前 pruneTasks 无调用方 → 终态任务快照永不自动清（债务③）。
export function pruneAllTaskNamespaces({ maxAgeHours = 24, dryRun = false, tasksRoot = null } = {}) {
  const root = tasksRoot || join(getStateDir(), TASK_ROOT)
  if (!existsSync(root)) return { pruned: 0, kept: 0, namespaces: 0, dry_run: dryRun }
  let pruned = 0, kept = 0, namespaces = 0
  for (const name of readdirSync(root)) {
    const d = join(root, name)
    try { if (!statSync(d).isDirectory()) continue } catch { continue }
    const r = pruneTaskDir(d, { maxAgeHours, dryRun })
    pruned += r.pruned; kept += r.kept; namespaces++
  }
  return { pruned, kept, namespaces, dry_run: dryRun }
}