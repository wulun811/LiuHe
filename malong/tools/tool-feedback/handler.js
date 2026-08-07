import { appendFileSync, readFileSync, existsSync, statSync, renameSync, rmSync } from 'node:fs'

// R22-⑮：jsonl 无界增长防护——>MAX_FEEDBACK_BYTES 轮转，保留 MAX_ROTATIONS 个历史轮转文件
const MAX_FEEDBACK_BYTES = 5 * 1024 * 1024
const MAX_ROTATIONS = 3

function rotateIfNeeded(path) {
  try {
    if (statSync(path).size < MAX_FEEDBACK_BYTES) return
    for (let i = MAX_ROTATIONS; i >= 1; i--) {
      const older = `${path}.${i + 1}`
      if (existsSync(older)) rmSync(older, { force: true })
      const cur = `${path}.${i}`
      if (existsSync(cur)) renameSync(cur, `${path}.${i + 1}`)
    }
    renameSync(path, `${path}.1`)
  } catch {}
}



import { ensureStateDir, getSessionId, readStateFile, resolveStateFile } from '../../host-config.js'

function getFeedbackPath() {
  ensureStateDir()
  return resolveStateFile('malong-feedback.jsonl')
}

// Y001-S5: list 聚合端——feedback 有去无回问题；读 readStateFile（新路径优先，回退旧路径，
// 兼容 0AIT 等旧副本写入 ~/.config/opencode/ 的数据），按工具聚合 + 最近 N 条
function listFeedback(toolFilter, limit) {
  const path = readStateFile('malong-feedback.jsonl')
  const entries = []
  if (existsSync(path)) {
    for (const line of readFileSync(path, 'utf-8').split('\n').filter(Boolean)) {
      try { entries.push(JSON.parse(line)) } catch {}
    }
  }
  const byTool = Object.create(null)
  for (const e of entries) byTool[e.tool] = (byTool[e.tool] || 0) + 1
  const filtered = toolFilter ? entries.filter(e => e.tool === toolFilter) : entries
  return { path, total: entries.length, total_filtered: filtered.length, by_tool: byTool, recent: filtered.slice(-limit).reverse() }
}

export async function handle(args, context) {
  if (args?.action === 'list') {
    const toolFilter = args?.tool || ''
    const rawLimit = parseInt(args?.limit)
    const limit = Number.isNaN(rawLimit) ? 50 : Math.min(500, Math.max(1, rawLimit))
    const { path, total, total_filtered, by_tool, recent } = listFeedback(toolFilter, limit)
    return {
      status: 'ok',
      total,
      total_filtered,
      by_tool,
      recent,
      path,
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
    // R22-⑮：写前检查轮转（防单文件无限增长）；list 端 readStateFile 只读主文件，轮转后主文件重置为最新反馈
    rotateIfNeeded(path)
    appendFileSync(path, JSON.stringify(entry) + '\n')
    return { status: 'recorded', message: 'Feedback saved. Thank you!', path }
  } catch (e) {
    return { error: 'write_failed', message: `Cannot write feedback: ${e.message}` }
  }
}