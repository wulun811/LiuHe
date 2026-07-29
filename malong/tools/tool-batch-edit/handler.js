// 六合工具集 — batch_edit handler
// 适配层：MCP → Python batch_edit_mvp.py

import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileSync, unlinkSync, statSync, appendFileSync, readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { validateFilePath, ErrorCodes, makeError } from '../../error-codes.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const STATS_FILE = join(homedir(), '.config', 'opencode', 'edit-batch-stats.jsonl')

function recordStats(fileSize, numEdits) {
  const record = {
    timestamp: Date.now(),
    file_size_bytes: fileSize,
    num_edits: numEdits,
    estimated_tokens_saved: Math.ceil((numEdits - 1) * (fileSize / 4))
  }
  try {
    appendFileSync(STATS_FILE, JSON.stringify(record) + '\n')
  } catch {}
}

function getCumulativeStats() {
  if (!existsSync(STATS_FILE)) return { totalCalls: 0, totalEdits: 0, totalTokensSaved: 0 }
  try {
    const lines = readFileSync(STATS_FILE, 'utf-8').trim().split('\n').filter(Boolean)
    let totalCalls = 0, totalEdits = 0, totalTokensSaved = 0
    for (const line of lines) {
      try {
        const r = JSON.parse(line)
        totalCalls++
        totalEdits += r.num_edits
        totalTokensSaved += r.estimated_tokens_saved
      } catch {}
    }
    return { totalCalls, totalEdits, totalTokensSaved }
  } catch { return { totalCalls: 0, totalEdits: 0, totalTokensSaved: 0 } }
}

export async function handle(args, context) {
  const filePath = args?.file_path || ''
  const editsRaw = args?.edits || ''
  const dryRun = !!args?.dry_run

  if (!filePath) return { error: 'missing_parameter', message: 'file_path is required', suggestion: 'Provide the absolute path to the file to edit' }
  if (!editsRaw) return { error: 'missing_parameter', message: 'edits is required', suggestion: 'Provide a JSON array of edits: [{"old_string": "...", "new_string": "..."}]' }

  const pathCheck = validateFilePath(filePath)
  if (pathCheck.blocked) {
    return makeError(ErrorCodes.PATH_BLOCKED, pathCheck.detail, { file: filePath, reason: pathCheck.reason })
  }

  const pythonScript = join(__dirname, 'batch_edit_mvp.py')
  const tmpFile = join(__dirname, `.edit_batch_tmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`)

  try {
    writeFileSync(tmpFile, typeof editsRaw === 'string' ? editsRaw : JSON.stringify(editsRaw), 'utf-8')

    const cmdArgs = [pythonScript, filePath, '--edits-file', tmpFile]
    if (dryRun) cmdArgs.push('--dry-run')

    const stdout = execFileSync('python3', cmdArgs, {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    })

    const delimiter = '---MALONG_BATCH_EDIT_JSON_END---'
    const delimIdx = stdout.indexOf(delimiter)
    const jsonStr = delimIdx >= 0 ? stdout.slice(0, delimIdx).trim() : stdout.trim()

    let result
    try {
      result = JSON.parse(jsonStr)
    } catch {
      return { result: stdout.trim() }
    }

    if (result.success && !dryRun) {
      try {
        const fileStats = statSync(filePath)
        recordStats(fileStats.size, result.edits_applied || 0)
      } catch {}
    }

    const stats = getCumulativeStats()
    result.cumulative_stats = stats

    return result

  } catch (e) {
    if (e.stdout) {
      const out = typeof e.stdout === 'string' ? e.stdout : e.stdout.toString('utf-8')
      const delimIdx = out.indexOf('---MALONG_BATCH_EDIT_JSON_END---')
      const jsonStr = delimIdx >= 0 ? out.slice(0, delimIdx).trim() : out.trim()
      try {
        return JSON.parse(jsonStr)
      } catch {}
    }
    return { error: e.message || String(e) }
  } finally {
    try { unlinkSync(tmpFile) } catch {}
  }
}
