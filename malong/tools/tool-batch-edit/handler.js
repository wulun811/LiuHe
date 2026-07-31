// 六合工具集 — batch_edit handler（P5 委托：匹配留 Python，落盘走 write runtime）
// 委托范围（§16.6 向后兼容，不破坏显式 API）：
//   - 匹配/诊断/partial 逻辑保留 Python batch_edit_mvp.py（lenient/replace_all/空白诊断）
//   - 写入环节改道 write-runtime：锁（并发安全）+ TOCTOU 检测（Python 读后文件被改 → 拒）
//     + 原子写（temp+rename）+ 写后同步重抽 + undo journal（可选 workspace_dir）

import { execFileSync } from 'node:child_process'
import { join, dirname, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileSync, unlinkSync, statSync, appendFileSync, readFileSync, existsSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { validateFilePath, ErrorCodes, makeError } from '../../error-codes.js'
import { acquireLock } from '../../write-runtime.js'
import { createJournal, updateJournalState } from '../../write-journal.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const STATS_FILE = join(homedir(), '.config', 'opencode', 'edit-batch-stats.jsonl')

// 契约统一（合契）：file（workspace-relative）为主；file_path（绝对）兼容别名，须在 workspace 内
function isInsideWorkspace(ws, abs) {
  const rel = relative(ws, abs)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

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

// 委托写入：锁 → TOCTOU 检测 → journal → temp+rename 原子写 → 同步重抽
async function delegateWrite({ absPath, filePath, workspaceDir, originalContent, finalContent, codeIndexService }) {
  const lock = await acquireLock(absPath)
  if (lock.locked) {
    return { error: { code: 'FILE_LOCKED', message: `File is locked by another writer: ${filePath}`, suggestion: 'Retry after a moment.' } }
  }
  try {
    // TOCTOU：Python 匹配基于 originalContent，落盘前文件必须仍是它
    let current = ''
    try { current = readFileSync(absPath, 'utf-8') } catch (e) {
      return { error: { code: 'READ_FAILED', message: e.message } }
    }
    if (originalContent !== undefined && current !== originalContent) {
      return {
        error: {
          code: 'VERSION_CONFLICT',
          conflict_type: 'FILE_CHANGED',
          message: 'File changed since edits were computed (TOCTOU). Re-run edit_batch on the current content.',
          suggestion: 'Re-read the file and regenerate old_string/new_string pairs.',
        },
      }
    }

    let journal = null
    if (workspaceDir) {
      journal = createJournal(workspaceDir, filePath, absPath, current, { editMode: 'edit_batch', state: 'staged' })
      updateJournalState(journal.dir, { state: 'staged' })
    }

    const tmpPath = `${absPath}.tmp`
    writeFileSync(tmpPath, finalContent)
    try {
      renameSync(tmpPath, absPath)
    } catch (e) {
      try { unlinkSync(tmpPath) } catch {}
      if (journal) updateJournalState(journal.dir, { state: 'failed', reason: e.message })
      return { error: { code: 'ATOMIC_WRITE_FAILED', message: e.message } }
    }
    if (journal) updateJournalState(journal.dir, { state: 'committed', committed_at: new Date().toISOString() })

    let reindex = null
    if (codeIndexService && workspaceDir) {
      try {
        const r = await codeIndexService.indexFile(absPath, workspaceDir)
        reindex = { status: 'ok', symbols: r?.symbols ?? 0 }
      } catch (e) {
        reindex = { status: 'failed', reason: e.message }
        try { codeIndexService.markIndexDirty(filePath, 'write_pending_reindex') } catch {}
      }
    }
    return { ok: true, journal, reindex }
  } finally {
    lock.release()
  }
}

export async function handle(args, context) {
  const workspaceDir = args?.workspace_dir || null
  const fileRel = args?.file || ''
  const filePathAbs = args?.file_path || ''
  const editsRaw = args?.edits || ''
  const dryRun = !!args?.dry_run
  const verbose = !!args?.verbose

  // 契约统一：file（相对）+ workspace_dir 为主；file_path（绝对）为兼容别名（deprecated）
  let filePath = ''
  if (fileRel) {
    if (!workspaceDir) return { error: 'missing_parameter', message: 'file requires workspace_dir', suggestion: 'Provide workspace_dir + file (relative), e.g. workspace_dir="/repo", file="src/auth.py"' }
    const abs = join(workspaceDir, fileRel)
    if (!isInsideWorkspace(workspaceDir, abs)) return makeError(ErrorCodes.PATH_BLOCKED, `file escapes workspace: ${abs}`, { file: fileRel, reason: 'outside_workspace' })
    filePath = abs
  } else if (filePathAbs) {
    // 宽容输入：绝对路径可用，但 workspace_dir 提供时必须在其内（防越界写）
    if (workspaceDir && !isInsideWorkspace(workspaceDir, filePathAbs)) return makeError(ErrorCodes.PATH_BLOCKED, `file_path outside workspace_dir: ${filePathAbs}`, { file: filePathAbs, reason: 'outside_workspace' })
    filePath = filePathAbs
  } else {
    return { error: 'missing_parameter', message: 'file or file_path is required', suggestion: 'Prefer file (workspace-relative) + workspace_dir, e.g. { workspace_dir: "/repo", file: "src/auth.py" }; file_path (absolute) kept as deprecated alias' }
  }
  if (!editsRaw) return { error: 'missing_parameter', message: 'edits is required', suggestion: 'Provide a JSON array of edits: [{"old_string": "...", "new_string": "..."}]' }

  // filePath 是绝对路径（上面 isInsideWorkspace 已校验在 workspace 内）→ 传 workspaceDir 放行
  const pathCheck = validateFilePath(filePath, workspaceDir)
  if (pathCheck.blocked) {
    return makeError(ErrorCodes.PATH_BLOCKED, pathCheck.detail, { file: filePath, reason: pathCheck.reason })
  }

  const pythonScript = join(__dirname, 'batch_edit_mvp.py')
  const tmpFile = join(__dirname, `.edit_batch_tmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`)

  try {
    writeFileSync(tmpFile, typeof editsRaw === 'string' ? editsRaw : JSON.stringify(editsRaw), 'utf-8')

    const cmdArgs = [pythonScript, filePath, '--edits-file', tmpFile]
    if (dryRun) cmdArgs.push('--dry-run')
    if (args?.partial) cmdArgs.push('--partial')
    if (!dryRun) cmdArgs.push('--no-write')

    const stdout = execFileSync('python3', cmdArgs, {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    })

    // 协议：Python 只输出 JSON 到 stdout。不做 indexOf(delimiter) 截断——
    // 分隔符字符串可能恰好出现在被编辑文件内容里（自指冲突，2026-07-31 实测踩坑），
    // 直接 trim 后 parse；失败则提取诊断信息，绝不静默吞掉成功结果。
    let result
    try {
      result = JSON.parse(stdout.trim())
    } catch (e) {
      return { error: 'parse_failed', message: `Failed to parse batch_edit output: ${e.message}`, stdout_snippet: stdout.slice(0, 300), suggestion: 'Check batch_edit_mvp.py stdout protocol (JSON only).' }
    }

    // ── P5 委托：写入改道 write runtime（锁 + TOCTOU + 原子写 + 同步重抽） ──
    if (result.success && !dryRun && typeof result.final_content === 'string') {
      const dw = await delegateWrite({
        absPath: filePath,
        filePath,
        workspaceDir,
        originalContent: result.original_content,
        finalContent: result.final_content,
        codeIndexService: context?.codeIndexService || null,
      })
      if (dw.error) {
        return { ...result, success: false, error: dw.error, error_type: dw.error.code }
      }
      if (dw.journal) result.txn_id = dw.journal.txnId
      if (dw.reindex) result.reindex = dw.reindex
      try {
        const fileStats = statSync(filePath)
        recordStats(fileStats.size, result.edits_applied || 0)
      } catch {}
    } else if (result.success && !dryRun) {
      // final_content 缺失（脚本直接写盘路径，兼容旧脚本）
      try {
        const fileStats = statSync(filePath)
        recordStats(fileStats.size, result.edits_applied || 0)
      } catch {}
    }

    const stats = getCumulativeStats()
    result.cumulative_stats = stats

    // 合俭：默认不返回全文（original/final_content 可达 10 万字符），verbose 才带
    if (!verbose) {
      delete result.final_content
      delete result.original_content
    }

    if (result.success && !dryRun) {
      result.next_step = 'Verify: fix_imports. Run tests: test_bridge(action="run").'
    }

    return result

  } catch (e) {
    if (e.stdout) {
      const out = typeof e.stdout === 'string' ? e.stdout : e.stdout.toString('utf-8')
      try {
        return JSON.parse(out.trim())
      } catch {}
    }
    return { error: e.message || String(e), suggestion: 'Check batch_edit_mvp.py stderr for details.' }
  } finally {
    try { unlinkSync(tmpFile) } catch {}
  }
}
