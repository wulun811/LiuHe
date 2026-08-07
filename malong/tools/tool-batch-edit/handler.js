// 六合工具集 — batch_edit handler（P5 委托：匹配留 Python，落盘走 write runtime）
// 委托范围（§16.6 向后兼容，不破坏显式 API）：
//   - 匹配/诊断/partial 逻辑保留 Python batch_edit_mvp.py（lenient/replace_all/空白诊断）
//   - 写入环节改道 write-runtime：锁（并发安全）+ TOCTOU 检测（Python 读后文件被改 → 拒）
//     + 原子写（temp+rename）+ 写后同步重抽 + undo journal（可选 workspace_dir）

import { execFile } from 'node:child_process'
import { join, dirname, relative, isAbsolute, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileSync, unlinkSync, statSync, appendFileSync, readFileSync, existsSync, renameSync } from 'node:fs'
import { renameRetry } from '../../write-runtime.js'

import { validateFilePath, ErrorCodes, makeError } from '../../error-codes.js'
import { acquireLock } from '../../write-runtime.js'
import { guardRealPath } from '../../path-guard.js'
import { createJournal, updateJournalState, pruneJournals } from '../../write-journal.js'
import { registerWriter } from '../../writer-registry.js'
import { sha256 } from '../../hash-utils.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
import { ensureStateDir, resolveStateFile, readStateFile } from '../../host-config.js'

// r37-fix2：动态求值（模块级常量在测试定向/运行时 env 变化后失效——同 LEGACY_DIR 教训）
function getStatsFile() {
  ensureStateDir()
  return resolveStateFile('edit-batch-stats.jsonl')
}

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
    ensureStateDir()
    appendFileSync(getStatsFile(), JSON.stringify(record) + '\n')
  } catch {}
}

// r40: 写后语法自检（警告不阻断）——实测 LLM 生成 tool-call JSON 时正则字面量（如 /^\\.\\.?\\//）
// 反斜杠转义双写会写坏代码（SyntaxError），链路本身无二次转义（2026-08-03 复现验证），
// 自检让坏代码当场可见：node --check / py_compile / JSON.parse，失败附提示
// r11(H2)：异步化（await）——旧 execFileSync 同步子进程最长 3s 冻结事件循环；错误对象带 _out/_err 兼容旧 catch
function runCheck(cmd, argsList) {
  return new Promise((resolve) => {
    execFile(cmd, argsList, { timeout: 3000, stdio: 'pipe' }, (err, _so, se) => resolve(err ? String(se || err.message).slice(0, 300) : null))
  })
}

async function syntaxCheck(filePath) {
  const ext = extname(filePath).toLowerCase()
  const SUGGESTION = '可能反斜杠转义双写——含正则字面量（如 /^\\.\\.?\\//）的编辑建议改回内置 edit 并核对 old_string/new_string 的 \\ 转义'
  if (['.js', '.mjs', '.cjs'].includes(ext)) {
    const err = await runCheck('node', ['--check', filePath])
    return err ? { ok: false, error: err, suggestion: SUGGESTION } : { ok: true }
  }
  if (ext === '.py') {
    // r43: py_compile 会在项目里生成 __pycache__/*.pyc 垃圾文件（实测副作用）——改内存 ast.parse 零副作用
    const err = await runCheck('python3', ['-c', 'import ast,sys; ast.parse(open(sys.argv[1], encoding="utf-8").read())', filePath])
    return err ? { ok: false, error: err, suggestion: SUGGESTION } : { ok: true }
  }
  if (ext === '.json') {
    try {
      JSON.parse(readFileSync(filePath, 'utf-8'))
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e.message.slice(0, 300), suggestion: SUGGESTION }
    }
  }
  return null
}

function getCumulativeStats() {
  const statsPath = readStateFile('edit-batch-stats.jsonl')
  if (!existsSync(statsPath)) return { totalCalls: 0, totalEdits: 0, totalTokensSaved: 0 }
  try {
    const lines = readFileSync(statsPath, 'utf-8').trim().split('\n').filter(Boolean)
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
// Y001 债务2：导出供单测直接注入（VERSION_CONFLICT / ATOMIC_WRITE_FAILED 分支）
export async function delegateWrite({ absPath, filePath, workspaceDir, originalContent, finalContent, codeIndexService }) {
  // r9(P2)：batch-edit 主写路径 realpath 守卫（与 write_symbol/edit_transaction 对齐）——
  // workspace 内 symlink 指向外部时字符串校验全通过 → 写穿仓库 + 锁文件建到外部。
  // 注意：调用方传的 filePath 可能是绝对路径（python 协议侧归一化），守卫须用 workspace-relative 形态
  if (workspaceDir) {
    const rel = isAbsolute(filePath) ? relative(workspaceDir, filePath) : filePath
    const guardW = guardRealPath(workspaceDir, rel)
    if (guardW.blocked) {
      return { error: { code: 'PATH_BLOCKED', message: guardW.detail } }
    }
  }
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
      // r52: 缺 new_hash——recoverJournals 的 committed 判定依赖 state.new_hash（write-runtime 同位置都写），崩溃在 committed 标记前会把已落盘写入误判 needs_review（永不自动清理）
      updateJournalState(journal.dir, { state: 'staged', new_hash: sha256(finalContent) })
    }

    // Y001 债务2: writeFileSync 移入 try——旧实现在 try 外，tmp 写入失败（如 tmp 为已存在目录）
    // 直接抛异常到 handler 顶层，ATOMIC_WRITE_FAILED 分支不可达（READ_FAILED/裸异常），journal 无 failed 标记
    // r9(P3)：唯一 tmp 名——固定 `${absPath}.tmp` 可被恶意仓库预置同名 symlink → 写穿外部 + rename 把 symlink 本体移到目标位
    const tmpPath = `${absPath}.bte-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`
    try {
      writeFileSync(tmpPath, finalContent)
      // R22-⑮：renameRetry 对齐 write-runtime（Windows 杀软 EPERM/EBUSY 偶发）——旧裸 renameSync 一次失败即 ATOMIC_WRITE_FAILED
      await renameRetry(tmpPath, absPath)
    } catch (e) {
      try { unlinkSync(tmpPath) } catch {}
      if (journal) updateJournalState(journal.dir, { state: 'failed', reason: e.message })
      return { error: { code: 'ATOMIC_WRITE_FAILED', message: e.message } }
    }
    if (journal) updateJournalState(journal.dir, { state: 'committed', committed_at: new Date().toISOString() })
    // Y002-S1：batch 写后登记写者（collision_guard classify 识别 batch_edit）
    if (workspaceDir) registerWriter(workspaceDir, filePath, 'batch_edit')

    let reindex = null
    if (codeIndexService && workspaceDir) {
      try {
        const r = await codeIndexService.indexFile(absPath, workspaceDir)
        reindex = { status: 'ok', symbols: r?.symbols ?? 0 }
      } catch (e) {
        reindex = { status: 'failed', reason: e.message }
        try { codeIndexService.markIndexDirty(filePath, 'write_pending_reindex') } catch {}
        // R18：batch-edit 自实现 journal 同记 index_pending（有 state 文件，recoverJournals 可补抽）
        try { updateJournalState(journal.dir, { index_pending: true, index_pending_reason: e.message }) } catch {}
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

  // r43: 非字符串 file/file_path 会让 join() 抛 TypeError（r23-fix3 同教训）——写路径主力更需输入卫生
  // r44: != null 让 null 与 undefined 一致视为「缺省」（回退 file_path/报错），只拒真·非字符串值
  if (args?.file != null && typeof args.file !== 'string') {
    return { error: 'invalid_input', message: 'file must be a string', suggestion: 'Provide a file path relative to workspace_dir.' }
  }
  if (args?.file_path != null && typeof args.file_path !== 'string') {
    return { error: 'invalid_input', message: 'file_path must be a string', suggestion: 'Provide an absolute path inside workspace_dir.' }
  }

  // 契约统一：file（相对）+ workspace_dir 为主；file_path（绝对）为兼容别名（deprecated）
  let filePath = ''
  if (fileRel) {
    if (!workspaceDir) return { error: 'missing_parameter', message: 'file requires workspace_dir', suggestion: 'Provide workspace_dir + file (relative), e.g. workspace_dir="/repo", file="src/auth.py"' }
    const abs = join(workspaceDir, fileRel)
    if (!isInsideWorkspace(workspaceDir, abs)) return makeError(ErrorCodes.PATH_BLOCKED, `file escapes workspace: ${abs}`, { file: fileRel, reason: 'outside_workspace' })
    filePath = abs
  } else if (filePathAbs) {
    // 宽容输入：绝对路径可用，但 workspace_dir 提供时必须在其内（防越界写）
    // r46: 前端（opencode MCP client）会把 file 别名成 file_path 且值仍为相对路径——
    //      若按绝对路径判 isInsideWorkspace，resolve 会基于进程 cwd 而误判越界
    //      （cwd==workspace 时碰巧通过，cwd 在外则恒 path_blocked）。相对值按 workspace-relative 解析。
    // 相对值按 workspace-relative 解析（r48: workspace_dir 为 null 时不做 join——join(null, x) 抛 TypeError）
    const candidate = isAbsolute(filePathAbs) ? filePathAbs : (workspaceDir ? join(workspaceDir, filePathAbs) : filePathAbs)
    if (workspaceDir && !isInsideWorkspace(workspaceDir, candidate)) return makeError(ErrorCodes.PATH_BLOCKED, `file_path outside workspace_dir: ${candidate}`, { file: filePathAbs, reason: 'outside_workspace' })
    filePath = candidate
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

    // r11(H2)：execFile 异步化——旧 execFileSync 同步子进程最长 30s 冻结整个 MCP 事件循环
    // （含 120s 请求超时定时器、parse-client 心跳、stdin 分发），所有并发请求静默排队
    const { stdout } = await new Promise((resolve, reject) => {
      execFile('python3', cmdArgs, {
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
        timeout: 30_000,
      }, (err, stdout, stderr) => {
        if (err) return reject(Object.assign(err, { _out: stdout || '', _err: stderr || '' }))
        resolve({ stdout: stdout || '' })
      })
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
      const sc = await syntaxCheck(filePath)
      if (sc) result.syntax_check = sc
      if (dw.journal) result.txn_id = dw.journal.txnId
      if (dw.reindex) result.reindex = dw.reindex
      if (workspaceDir) {
        const pruned = pruneJournals(workspaceDir)
        if (pruned.pruned > 0) result.journal_prune = { pruned: pruned.pruned, kept: pruned.kept }
      }
      try {
        const fileStats = statSync(filePath)
        recordStats(fileStats.size, result.edits_applied || 0)
      } catch {}
    } else if (result.success && !dryRun) {
      // P2-C10：final_content 缺失（脚本直接写盘路径，兼容旧脚本）——旧实现静默当成功，
      // 若脚本尊重 --no-write 却漏输出 final_content，编辑被丢弃仍报成功。显式警告
      try {
        const fileStats = statSync(filePath)
        recordStats(fileStats.size, result.edits_applied || 0)
        result.warning = 'final_content missing in script response (compat path); edits may not have been applied to disk'
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
      // Y002-S2：写路径闭环——diff_facts（batch_edit 走 write-journal，无 .ai-transactions 时 diff_facts 无法读，
      // 给 test_bridge → debug_runner 链为主，diff_facts 条件性提示）
      result.next_step = 'workflow: test_bridge(action="run") → debug_runner on failure; if edits went through edit_transaction, also diff_facts(since="last_txn"). TypeScript project? Also tsc_check(workspace_dir=...)'
    }

    return result

  } catch (e) {
    const out = e._out ?? e.stdout
    if (out) {
      try {
        return JSON.parse(String(out).trim())
      } catch {}
    }
    return { error: { code: 'INTERNAL', message: e.message || String(e), suggestion: 'Check batch_edit_mvp.py stderr for details.' } }
  } finally {
    try { unlinkSync(tmpFile) } catch {}
  }
}
