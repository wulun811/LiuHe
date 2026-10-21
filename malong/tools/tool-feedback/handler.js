import { appendFileSync, readFileSync, existsSync, statSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'

// R22-⑮：jsonl 无界增长防护——>MAX_FEEDBACK_BYTES 轮转，保留 MAX_ROTATIONS 个历史轮转文件
const MAX_FEEDBACK_BYTES = 5 * 1024 * 1024
const MAX_ROTATIONS = 3

function rotateIfNeeded(path) {
  try {
    if (statSync(path).size < MAX_FEEDBACK_BYTES) return { rotated: false }
    for (let i = MAX_ROTATIONS; i >= 1; i--) {
      const older = `${path}.${i + 1}`
      if (existsSync(older)) rmSync(older, { force: true })
      const cur = `${path}.${i}`
      if (existsSync(cur)) renameSync(cur, `${path}.${i + 1}`)
    }
    renameSync(path, `${path}.1`)
    return { rotated: true }
  } catch (e) {
    if (e && e.code === 'ENOENT') return { rotated: false } // 首次写入：主文件尚不存在
    // 2026-10-04：轮转失败不再静默（此前 catch {} 全吞，磁盘无界增长无任何信号）
    return { rotated: false, error: e?.message || String(e) }
  }
}



import { ensureStateDir, getLegacyDir, getSessionId, resolveStateFile } from '../../host-config.js'

function getFeedbackPath() {
  ensureStateDir()
  return resolveStateFile('malong-feedback.jsonl')
}

// Y001-S5 + 2026-10-04 修复：list 聚合端同时读取新路径与旧路径（0AIT 旧副本
// ~/.config/opencode/）——此前 readStateFile 在新路径存在时完全遮蔽旧数据；
// 坏行不静默：计入 skipped_malformed。
function readFeedbackFiles() {
  const current = resolveStateFile('malong-feedback.jsonl')
  const legacy = join(getLegacyDir(), 'malong-feedback.jsonl')
  const candidates = [current]
  if (legacy !== current) candidates.push(legacy)
  const entries = []
  const sources = []
  let skipped = 0
  for (const p of candidates) {
    if (!existsSync(p)) { sources.push({ path: p, entries: 0 }); continue }
    let n = 0
    for (const line of readFileSync(p, 'utf-8').split('\n').filter(Boolean)) {
      try { entries.push(JSON.parse(line)); n++ } catch { skipped++ }
    }
    sources.push({ path: p, entries: n })
  }
  return { entries, sources, skipped, path: existsSync(current) ? current : legacy }
}

function listFeedback(toolFilter, limit) {
  const { entries, sources, skipped, path } = readFeedbackFiles()
  const byTool = Object.create(null)
  for (const e of entries) byTool[e.tool] = (byTool[e.tool] || 0) + 1
  const filtered = toolFilter ? entries.filter(e => e.tool === toolFilter) : entries
  return { path, total: entries.length, total_filtered: filtered.length, by_tool: byTool, recent: filtered.slice(-limit).reverse(), sources, skipped_malformed: skipped }
}

export async function handle(args, context) {
  // 第二轮审查：未知 action 不再静默降级为 record（与 code_* 家族对齐）
  if (args?.action != null && args.action !== 'record' && args.action !== 'list') {
    return { error: 'invalid_input', message: `Unknown action: ${args.action}`, valid_actions: ['record', 'list'], suggestion: 'Omit action for record, or use action="list".' }
  }
  if (args?.action === 'list') {
    const toolFilter = args?.tool || ''
    const rawLimit = parseInt(args?.limit)
    const limit = Number.isNaN(rawLimit) ? 50 : Math.min(500, Math.max(1, rawLimit))
    const { path, total, total_filtered, by_tool, recent, sources, skipped_malformed } = listFeedback(toolFilter, limit)
    return {
      status: 'ok',
      total,
      total_filtered,
      by_tool,
      recent,
      path,
      sources,
      skipped_malformed,
      next_step: total > 0
        ? 'Review and fix top issues. Usage insights: health(action="check", stats=true)'
        : 'No feedback yet. Tools are on probation until exercised — report issues to improve them.',
    }
  }

  const tool = args?.tool || 'unknown'
  const issue = args?.issue || ''
  const note = args?.note || ''
  const errorCode = args?.error_code || ''

  if (!issue) {
    return { error: 'missing_parameter', message: 'issue is required', suggestion: 'Describe what went wrong or could be improved' }
  }

  const entry = {
    timestamp: new Date().toISOString(),
    tool,
    issue,
    note,
    error_code: errorCode,
    session: getSessionId(),
  }

  try {
    const path = getFeedbackPath()
    // R22-⑮：写前检查轮转（防单文件无限增长）；list 端只读主文件，轮转后主文件重置为最新反馈
    const rotation = rotateIfNeeded(path)
    appendFileSync(path, JSON.stringify(entry) + '\n')
    return {
      status: 'recorded', message: 'Feedback saved. Thank you!', path,
      ...(rotation.rotated ? { rotated: true } : {}),
      ...(rotation.error ? { rotation_warning: rotation.error } : {}),
    }
  } catch (e) {
    return { error: 'write_failed', message: `Cannot write feedback: ${e.message}` }
  }
}