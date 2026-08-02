import { appendFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

function getFeedbackPath() {
  // r35-fix: Windows 上 homedir() 忽略 HOME（读 USERPROFILE），沙盒/测试靠 HOME 定向 → HOME 优先
  const dir = join(process.env.HOME || homedir(), '.config', 'opencode')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, 'malong-feedback.jsonl')
}

export async function handle(args, context) {
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
    session: process.env.OPENCODE_SESSION || '',
  }

  try {
    const path = getFeedbackPath()
    appendFileSync(path, JSON.stringify(entry) + '\n')
    return { status: 'recorded', message: 'Feedback saved. Thank you!', path }
  } catch (e) {
    return { error: 'write_failed', message: `Cannot write feedback: ${e.message}` }
  }
}