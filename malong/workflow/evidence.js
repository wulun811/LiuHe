// workflow/evidence.js — S4.1 证据依赖 DAG（局部失效，计划 §7.3/§7.4）
// 依赖只沿显式 depends_on（文件 + 采集时版本）传播：被依赖资源版本变了 → 该证据 stale。
// 不猜业务影响、不做全量清空；无 depends_on 的证据（纯分析）永不因文件变化失效。
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

// 单次调用内共享哈希缓存（多个证据依赖同一文件时不重复读盘；不跨调用缓存——
// 同毫秒重写 mtime 不变会假新鲜，跨调用必须重读）
function hashFile(workspaceDir, rel, cache) {
  try {
    const key = join(workspaceDir, rel)
    if (cache && cache.has(key)) return cache.get(key)
    // malong-ignore: 版本锚定哈希，非密码学用途
    const hash = `sha256:${createHash('sha256').update(readFileSync(key, 'utf-8')).digest('hex')}`
    if (cache) cache.set(key, hash)
    return hash
  } catch {
    if (cache) cache.set(join(workspaceDir, rel), null)
    return null
  }
}

// 由「成功写操作」推导证据依赖的文件清单（patch→file；batch→files[]；maintain→files[]）
export function writeFilesOf(task) {
  const out = []
  for (const o of (task?.operations || [])) {
    if (o.state !== 'succeeded') continue
    if (o.kind === 'batch' || o.kind === 'maintain') for (const f of (o.files || [])) out.push(f)
    else if (o.kind === 'patch' && o.file) out.push(o.file)
  }
  return [...new Set(out)]
}

// dogfood-050 P3：依赖上限护栏——超长任务不再把全量哈希重复到每条证据（防止状态膨胀）；
// 截断时数组挂 truncated 属性（JSON 序列化会丢，采集方显式透出 depends_on_truncated）
export const MAX_EVIDENCE_DEPS = 50

// 资源配置版本快照（§7.3 Evidence「资源配置版本」）
export function resourceVersions(workspaceDir, files) {
  const uniq = [...new Set(files || [])]
  const capped = uniq.slice(0, MAX_EVIDENCE_DEPS)
  const cache = new Map()
  const out = capped.map(file => ({ file, hash: hashFile(workspaceDir, file, cache) }))
  if (uniq.length > MAX_EVIDENCE_DEPS) out.truncated = true
  return out
}

// LH-009：工作区/目录扫描范围指纹（stat-only、有界、确定性）——工作区型分析器（dead_code/
// config_drift）的结果覆盖未列入 files 的文件，必须把「扫描范围」也作为证据依赖。
// 返回 { hash, files, truncated }；同目录同内容（名字+size+取整 mtime）必同哈希。
export const MAX_SCOPE_FILES = 5000
const SCOPE_SKIP_DIRS = new Set(['node_modules', '.git', '.malong', '.ai-transactions', '__pycache__'])
export function workspaceScopeSignature(workspaceDir, scope = '') {
  const root = scope ? join(workspaceDir, scope) : workspaceDir
  const entries = []
  const walk = (dir, rel, depth) => {
    if (entries.length >= MAX_SCOPE_FILES || depth > 12) return
    let list = []
    try { list = readdirSync(dir, { withFileTypes: true }) } catch { return }
    list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const e of list) {
      if (entries.length >= MAX_SCOPE_FILES) { entries.truncated = true; return }
      if (SCOPE_SKIP_DIRS.has(e.name)) continue
      const abs = join(dir, e.name)
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(abs, r, depth + 1)
      else if (e.isFile()) {
        try { const st = statSync(abs); entries.push(`${r}:${st.size}:${Math.round(st.mtimeMs)}`) } catch { entries.push(`${r}:stat_failed`) }
      }
    }
  }
  walk(root, '', 0)
  const h = createHash('sha256')
  for (const line of entries) h.update(line).update('\n')
  return { hash: `sha256:${h.digest('hex')}`, files: entries.length, truncated: !!entries.truncated }
}

export function isEvidenceStale(workspaceDir, ev, cache) {
  const deps = ev?.depends_on
  if (!Array.isArray(deps) || deps.length === 0) return false
  return deps.some(d => {
    if (!d) return false
    if (d.file) return hashFile(workspaceDir, d.file, cache) !== d.hash
    if (d.scope !== undefined) {
      const key = `ws-scope:${d.scope}`
      let sig = cache ? cache.get(key) : null
      if (!sig) { sig = workspaceScopeSignature(workspaceDir, d.scope); if (cache) cache.set(key, sig) }
      return sig.hash !== d.hash
    }
    return false
  })
}

// 14-B AC18：证据 scope（depends_on 的文件集/目录 scope 集）——同 kind 取代判定用。
export function evidenceScope(ev) {
  const deps = Array.isArray(ev?.depends_on) ? ev.depends_on : []
  return {
    files: [...new Set(deps.filter(d => d?.file).map(d => d.file))].sort(),
    scopes: [...new Set(deps.filter(d => d && d.scope !== undefined).map(d => String(d.scope)))].sort(),
  }
}
function scopeSuperset(a, b) {
  return b.files.every(f => a.files.includes(f)) && b.scopes.every(s => a.scopes.includes(s))
}
// 未被「同 kind 且 scope 超集」的后续证据取代的证据（事件序、原序返回）。
// R1 保持：同 scope 的后继取代先前（先 fail 后 pass 不卡）；AC18 新增：异 scope 相互独立，
// 后查 B（不同文件集）不吞掉 A 的范围证明。
export function currentEvidence(task) {
  const evs = task?.evidence || []
  const scopes = evs.map(evidenceScope)
  const out = []
  for (let i = 0; i < evs.length; i++) {
    const kind = evs[i]?.kind || 'unknown'
    let superseded = false
    for (let j = i + 1; j < evs.length; j++) {
      if ((evs[j]?.kind || 'unknown') !== kind) continue
      if (scopeSuperset(scopes[j], scopes[i])) { superseded = true; break }
    }
    if (!superseded) out.push(evs[i])
  }
  return out
}
// 派生失效（只读、不落盘）：返回失效证据 id 列表（在 currentEvidence 上判依赖漂移）。
export function staleEvidenceIds(workspaceDir, task) {
  const cache = new Map()
  return currentEvidence(task).filter(ev => isEvidenceStale(workspaceDir, ev, cache)).map(ev => ev.evidence_id)
}

// 14-A AC30 / 14-B AC18：审查证据适用性——「历史上存在 audit」不等于「适用于当前目标」。
// 当前证据集（同 kind 按 scope 取代，见 currentEvidence）须 revision 匹配、确有运行（非 skipped）、依赖未漂移；旧记录无 revision 按 1 兼容。
// AC30 补充：runner 失败（error）/ 部分文件未扫描（errored_files）/ 扫描截断（scope_truncated、scope.truncated）
// 均为「未完整覆盖」证据——不当作适用交还完成，交给重审或决策。
export function hasApplicableAuditEvidence(workspaceDir, task) {
  const curRev = task?.goal_revision || 1
  const cache = new Map()
  return currentEvidence(task).some(ev => {
    if (!String(ev?.kind || '').startsWith('audit')) return false
    if ((ev.goal_revision ?? 1) !== curRev) return false
    if (String(ev.result || '') === 'skipped') return false
    // AC30：证据不完整（runner 失败/部分未扫/扫描截断）→ 不适用（未覆盖 → 重审，不报无需再做）
    const actual = ev.actual || {}
    if (actual.error) return false
    if (Array.isArray(actual.errored_files) && actual.errored_files.length) return false
    if (actual.scope_truncated) return false
    if (actual.scope && actual.scope.truncated) return false
    return !isEvidenceStale(workspaceDir, ev, cache)
  })
}

// 13-B（专家 c2a83e4 P2-a）：统一有效状态——code_status / code_control / buildTaskNextAction 共用同一口径
// （旧实现 code_status 只算 staleEvidenceIds，code_control 另算 goal 漂移，next_action 完全不看失效 → 三处口径不一）
// stale_reason 优先级：goal_change > file_change > pending_work；结果只读、不落盘。
export function effectiveState(workspaceDir, task) {
  const staleEvidence = staleEvidenceIds(workspaceDir, task)
  let reason = null
  if (task?.result_kind === 'validated' && task.validated_goal_revision != null && (task.goal_revision || 1) !== task.validated_goal_revision) {
    reason = 'goal_change'
  } else if (staleEvidence.length > 0) {
    reason = 'file_change'
  } else {
    // P1（0.5.17 狗粮修复）：写后哈希 fallback 只对【当前 fresh 证据未覆盖】的文件生效。
    // fresh 证据已覆盖的文件，漂移由 staleEvidence 判定；旧实现无条件拿「最后一次成功写的
    // result_hash」比当前文件——该历史值永不更新，外部改文件后即便重读 + 重跑 check 全绿，
    // 仍会永久 stale（progress=stale、next_action 反复指回 code_check，LLM 空转）。undo 后重验同样中招。
    // 注意不能用「有没有证据」粗判：纯分析证据 depends_on 为空，覆盖不到写文件（s2-control 回归）。
    const staleSet = new Set(staleEvidence)
    const freshCovered = new Set()
    for (const ev of currentEvidence(task)) {
      if (staleSet.has(ev.evidence_id)) continue
      for (const d of (ev.depends_on || [])) if (d?.file) freshCovered.add(String(d.file).replace(/\\/g, '/').replace(/^\.\//, ''))
    }
    const pKey = (p) => String(p || '').replace(/\\/g, '/').replace(/^\.\//, '')
    const last = (task?.operations || []).filter(o => (o.kind === 'patch' || o.kind === 'batch') && o.state === 'succeeded').pop()
    if (last) {
      if (last.kind === 'batch') {
        const entries = Object.entries(last.result_hashes || {})
        if (entries.some(([file, h]) => h && !freshCovered.has(pKey(file)) && hashFile(workspaceDir, file, null) !== h)) reason = 'file_change'
      } else if (last.result_file_hash && last.file) {
        if (!freshCovered.has(pKey(last.file)) && hashFile(workspaceDir, last.file, null) !== last.result_file_hash) reason = 'file_change'
      }
    }
    // 后台结果不确定（indeterminate op）——只在 validated 上影响“完成”判定
    if (!reason && task?.result_kind === 'validated' && (task.operations || []).some(o => o.state === 'indeterminate')) {
      reason = 'pending_work'
    }
  }
  return { result_stale: reason !== null, stale_reason: reason, stale_evidence: staleEvidence }
}


// 采集证据时记录依赖：依据当前任务的成功写文件（无写 → 空数组，纯分析）
export function currentDependencies(workspaceDir, task) {
  return resourceVersions(workspaceDir, writeFilesOf(task))
}