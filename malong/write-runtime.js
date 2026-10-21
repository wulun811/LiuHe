// 码龙 — write 运行时（原语化 P3）
// 附录 C 冲突状态机 + 附录 D write pipeline（锁/journal/原子写/写后同步重抽）
// 单符号 replace_symbol / 亚符号 patch / 非代码降级（附录 E）

import { join, basename, extname, dirname } from 'node:path'
import {
  readFileSync, writeFileSync, existsSync, mkdirSync,
  openSync, closeSync, writeSync, unlinkSync, statSync, readdirSync, appendFileSync, utimesSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { sha256 } from './hash-utils.js'
import { validateFilePath } from './error-codes.js'
import { guardRealPath } from './path-guard.js'
import { extractSignatureLine, langOf } from './symbol-anchors.js'
import { checkFileStaleness } from './staleness.js'
import { countOccurrences, makeSimpleDiff, applyReplace, applyBodyEdit, applyInsertAfter, checkBracketBalance } from './write-edit.js'
import { createJournal, updateJournalState, auditLog, recoverJournals, recoverTransactions, pruneJournals, JOURNAL_ROOT, JOURNAL_RETENTION_HOURS, createBatchMarker, updateBatchMarker, finishBatchMarker } from './write-journal.js'
import { registerWriter } from './writer-registry.js'
import { replaceFilePreservingMetadataSync } from './windows-file-replace.js'

const LOCK_TIMEOUT_MS = 35000 // r9(F3)：心跳续租使合法持锁可达 30s+——旧 2s 等待超时在长持有下高频 FILE_LOCKED（锁内 validateSyntax 可 30s）；等待者应给足健康长持有时间
// WP06：受控故障场景注入（仅测试 env，仿 KILL_AFTER_WRITE 先例）——同步冻结→盗锁窗口用缩短 STALE 实证，不在生产路径等待 30s+
const STALE_LOCK_MS = Number(process.env.MALONG_TEST_STALE_LOCK_MS) || 30000 // 7：10s 太短——锁内 await validateSyntax 异步解析可能 >10s，第二进程盗锁 → 双写覆盖
const HEARTBEAT_MS = Number(process.env.MALONG_TEST_HEARTBEAT_MS) || 15000
const MAX_LIVE_READ = 1024 * 1024

// 测试提速旋钮（仅测试 env，默认值不变）：运行时读取，避免 ESM 静态导入把 env 固化在模块加载时。
// 生产不设置这些变量 → 行为与旧版一致。
const lockTimeoutMs = () => {
  const n = Number(process.env.MALONG_TEST_LOCK_TIMEOUT_MS)
  return Number.isFinite(n) && n > 0 ? n : LOCK_TIMEOUT_MS
}
const heartbeatMs = () => {
  const n = Number(process.env.MALONG_TEST_HEARTBEAT_MS)
  return Number.isFinite(n) && n > 0 ? n : HEARTBEAT_MS
}

export function traceId() {
  return `trc_${Date.now()}_${randomBytes(3).toString('hex')}`
}

// P0 修复（2026-10-12 狗粮发现）：旧实现以 syntax pass 为权威把 bracket fail 降级为 pass——动机是
// stripper 不识别正则字面量的假阳性；但 daemon has_errors 对 EOF 未闭合括号（JS/TS 删 }/删 ] 到文件尾）
// 漏报（实测 daemon v0.3.37 返回 has_errors=false），降级把真失败一并吞掉 → 坏文件静默落盘
//（node --check exit 1 而写路径 Preview OK）。现剥离器已补正则识别（write-edit.js，假阳性动机消失），
// 保守语义：不一致时保留 bracket fail（阻断），仅标注 syntax_disagreement 供诊断；
// 确需放行用 safety.block_on_validation_error=false 显式覆盖。
export function reconcileBracketWithSyntax(validation) {
  if (validation?.syntax?.status === 'pass' && validation?.bracket?.status === 'fail') {
    validation.bracket.syntax_disagreement = true
  }
  return validation
}

// Q3：验证拦截策略——显式 flag 优先；默认 standard 只拦硬错误（syntax/bracket fail，
// 不拦 skip/unavailable，避免误伤非 JS/Python 文本）；strict 含 skip；fast 不拦。
export function shouldBlockValidation(safety, validation) {
  if (!validation) return false
  const explicit = safety?.block_on_validation_error
  if (explicit === false) return false
  const hardFail = validation.syntax?.status === 'fail' || validation.bracket?.status === 'fail'
  if (explicit === true) return hardFail || validation.syntax?.status === 'skip'
  const profile = safety?.profile || 'standard'
  if (profile === 'fast') return false
  if (profile === 'strict') return hardFail || validation.syntax?.status === 'skip'
  return hardFail
}

// ---------- 锁（附录 D：OS advisory 优先，fallback lockfile + pid；2s 超时） ----------

export async function acquireLock(absPath, timeoutMs = lockTimeoutMs()) {
  const lockPath = `${absPath}.mlock`
  const start = Date.now()
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx')
      // r54(P1): 归属用随机 token 而非 pid——同进程并发(MCP 并行工具调用)pid 相同，pid 校验无法
      // 区分持锁者：A 持锁超 30s 被 B 盗锁后，A release 见 pid 相等会删掉 B 的新锁 → C 闯入双写覆盖
      const token = randomBytes(8).toString('hex')
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, token, ts: Date.now() }))
      } finally {
        closeSync(fd) // 9（F3）：writeSync 抛错（ENOSPC）时旧实现跳过 closeSync → fd 泄漏 + 空锁文件残留
      }
      let released = false
      // r8(E1)：持锁续租——锁内 await validateSyntax 可达 30s（恰等于 STALE_LOCK_MS），
      // 无续租则活跃持锁者被误判陈旧 → 第二进程盗锁双写覆盖。每 15s 触摸锁 mtime。
      const heartbeat = setInterval(() => {
        try {
          if (JSON.parse(readFileSync(lockPath, 'utf-8')).token === token) {
            const now = new Date()
            utimesSync(lockPath, now, now)
          }
        } catch {}
      }, heartbeatMs())
      // r9(F2 注)：心跳是 JS 定时器，锁区内同步长操作（>1GB 文件 sha256/慢盘 writeFileSync）会冻结事件循环
      // 导致心跳无法触发、锁被误判陈旧盗走——本地盘场景 <1s 不受影响；慢盘/超大文件需 await 化后才算完整覆盖
      if (heartbeat.unref) heartbeat.unref()
      return {
        release() {
          if (released) return
          released = true
          clearInterval(heartbeat)
          // r54(P1): token 比对——只删「自己还持有」的锁；锁已被盗/重建（token 不同）则不删
          try {
            const content = readFileSync(lockPath, 'utf-8')
            const holder = JSON.parse(content)
            if (holder.token !== token) return // 他人持有，不删
            unlinkSync(lockPath)
          } catch {
            // r54(P1): 读不到/解析失败不盲删——可能正是他人刚建好的新锁（旧 catch 盲删是盗锁帮凶）
          }
        },
      }
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      try {
        const st = statSync(lockPath)
        if (Date.now() - st.mtimeMs > STALE_LOCK_MS) {
          try { unlinkSync(lockPath) } catch {}
          continue
        }
      } catch { continue }
      if (Date.now() - start > timeoutMs) return { locked: true, release: () => {} } // r9(P1)：超时对象带安全空释放——防任何漏检 .locked 的调用方 finally 调 release() 抛 TypeError
      await new Promise(r => setTimeout(r, 50))
    }
  }
}

// r8(B5)：唯一 tmp 名——植入的 `<file>.tmp` symlink 会被 writeFileSync 穿写到外部；随机后缀永不同名
function _uniqueTmp(absPath, tag) {
  return `${absPath}.${tag}-${randomBytes(4).toString('hex')}`
}

// N3（0.5.14 Windows 复核，Linux 侧复验）：tmp+rename 不得重置权限位——
// 旧实现 writeFileSync(tmp) 用 umask 默认（644/664），编辑 755 可执行脚本后丢 +x（实测 755→664）。
// 目标已存在时继承其 mode；新建文件仍走默认（不擅自给可执行位）。
function _writeTmpPreservingMode(tmpPath, content, absPath) {
  let mode = null
  try { mode = statSync(absPath).mode & 0o777 } catch { mode = null }
  writeFileSync(tmpPath, content, mode != null ? { mode } : undefined)
}

// ---------- crash recovery（附录 D：启动扫 journal，未完成 txn 按 state 回滚） ----------


// ---------- 冲突状态机（附录 C） ----------

export function classifyConflict(base, cur, isSymbolMode) {
  if (!base?.file?.hash) return { type: 'NO_BASE' }
  if (isSymbolMode && !cur.symbol) return { type: 'SYMBOL_DELETED' }
  // r11(M5)：read_symbol 对 >1MB 文件只读前 1MB 算哈希（truncated_hash），与 write-runtime 的全量哈希无可比性——
  // 文件级模式恒比对必 FAIL → 跳过（符号级模式仍靠 body_hash 判定，截断 base 的 body 与前 1MB 内符号自洽）
  if (base.file.truncated_hash && !isSymbolMode) {
    return { type: 'CLEAN', warning: 'truncated_hash_base: file-level conflict check skipped (>1MB truncated read)' }
  }
  const fileSame = base.file.hash === cur.file.hash
  if (fileSame) {
    if (!isSymbolMode) return { type: 'CLEAN' }
    if (base.symbol?.body_hash && cur.symbol?.body_hash && base.symbol.body_hash === cur.symbol.body_hash) return { type: 'CLEAN' }
    if (!base.symbol?.body_hash) return { type: 'CLEAN', warning: 'no_base_body_hash' }
    return { type: 'SYMBOL_CHANGED' }
  }
  // 文件变了：符号级还要看符号自身
  if (!isSymbolMode) return { type: 'FILE_CHANGED' }
  const bodySame = base.symbol?.body_hash && cur.symbol?.body_hash && base.symbol.body_hash === cur.symbol.body_hash
  if (bodySame) return { type: 'FILE_CHANGED_SYMBOL_STABLE' }
  if (base.symbol?.signature_hash && cur.symbol?.signature_hash && base.symbol.signature_hash !== cur.symbol.signature_hash) {
    return { type: 'SYMBOL_SIGNATURE_CHANGED' }
  }
  return { type: 'SYMBOL_CHANGED' }
}

const CONFLICT_POLICY = {
  CLEAN: 'allow',
  FILE_CHANGED_SYMBOL_STABLE: 'allow_warn',
  // 附录 C/E：patch/file 模式无符号锚，文件变了必须重读（§16.3：>1MB 中间被改必报 VERSION_CONFLICT）
  FILE_CHANGED: 'reject',
  SYMBOL_CHANGED: 'reject',
  SYMBOL_SIGNATURE_CHANGED: 'reject',
  SYMBOL_DELETED: 'reject',
  AMBIGUOUS_SYMBOL: 'reject',
  NO_BASE: 'reject',
}

// ---------- 编辑应用 ----------


// ---------- journal（附录 D） ----------


// ---------- 校验（附录：sandbox + 语法，尽力而为） ----------


export async function validateSyntax(langParser, source, ext) {
  if (!langParser?.hasErrorsAsync) return { status: 'skip', reason: 'langParser unavailable' }
  try {
    // 注意：不传 filePath —— 校验的是内存中的 newContent，不是磁盘文件
    const res = await langParser.hasErrorsAsync(source, ext, null)
    // r9(A1)：兼容布尔（旧 mock/实现）与 {has_errors, truncated}（r9 起 Rust daemon 返回）
    const hasErr = res === true || (res && res.has_errors === true)
    const truncated = res && res.truncated === true
    if (hasErr) return { status: 'fail', errors: ['syntax errors detected by parser'] }
    // r9(A1)：深度截断 = 未能完整验证——宁可拒绝写盘（用户决策：截断时报错不静默放行）
    if (truncated) return { status: 'fail', errors: ['file too deeply nested to verify syntax (depth > 512); refusing write'] }
    return { status: 'pass' }
  } catch (e) {
    return { status: 'skip', reason: `parse unavailable: ${e.message}` }
  }
}

// dogfood-050（P2 修复）：校验失败必带「装配结果」自证——旧实现只回 "syntax errors detected"，
// caller 无法区分「内容真坏了」与「传输/装配问题」（实测 \n 被字面化时需 override 才看到 diff）。
// 另附 hint：incoming 内容无真实换行但含字面 \n/\t 转义 → 典型 caller 参数转义问题。
const VALIDATION_EXCERPT_MAX = 600
function buildValidationFailure(code, message, validation, newContent, incoming) {
  const error = { code, message, validation }
  try {
    const text = String(newContent || '')
    error.assembled_excerpt = text.length > VALIDATION_EXCERPT_MAX ? text.slice(0, VALIDATION_EXCERPT_MAX) + '\n…[truncated]' : text
    const inc = typeof incoming === 'string' ? incoming : ''
    if (inc && !inc.includes('\n') && (inc.includes('\\n') || inc.includes('\\t'))) {
      error.hint = 'incoming content has no real newlines but contains literal escape sequences (\\n/\\t) — likely caller-side parameter escaping; re-send with actual newline characters.'
    }
  } catch {}
  return error
}

// ---------- 主编排 ----------

// r35-fix: Windows rename 偶发 EPERM/EBUSY（杀软扫描/句柄短暂占用）→ 短暂重试后再放弃
// 可注入 renameFn 验证重试；Windows 默认保留目标 ACL，其他平台仍为 renameSync。
export async function renameRetry(from, to, renameFn = replaceFilePreservingMetadataSync) {
  for (let i = 0; ; i++) {
    try { renameFn(from, to); return } catch (e) {
      if (i >= 3 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e
      await new Promise(r => setTimeout(r, 150))
    }
  }
}

export async function writeSymbol(args, context) {
  const { codeIndexService, getWorkspaceDir, langParserService } = context
  const langParser = langParserService
  const workspaceDir = args?.workspace_dir
  const pipeline = []
  const trace_id = traceId()

  if (!workspaceDir) {
    return { success: false, error: { code: 'missing_parameter', message: 'workspace_dir is required' }, trace_id }
  }
  const locator = args?.locator || {}
  let filePath = locator?.file_path
  if (!filePath && locator?.symbol_id && codeIndexService) {
    const byId = codeIndexService.getSymbolByStableId(locator.symbol_id)
    if (byId) filePath = byId.file_path
  }
  if (!filePath) {
    return { success: false, error: { code: 'missing_parameter', message: 'locator.file_path is required (or provide a resolvable symbol_id)' }, trace_id }
  }
  const pathCheck = validateFilePath(filePath)
  if (!pathCheck.ok) {
    return { success: false, error: { code: 'PATH_BLOCKED', message: pathCheck.detail }, trace_id }
  }
  // r9(P2)：主写路径 realpath 守卫——validateFilePath 只查字符串，workspace 内 symlink 指向外部时
  // 字符串全通过 → 写穿仓库（edit_transaction 有守卫而 write_symbol 没有的不对称洞）
  const guardW = guardRealPath(workspaceDir, filePath)
  if (guardW.blocked) {
    return { success: false, error: { code: 'PATH_BLOCKED', message: guardW.detail }, trace_id }
  }

  const absPath = join(workspaceDir, filePath)
  // Q2：create:true = 新建文件（不存在才建；content 为全文；dry-run 可预览；undo=删除）
  const createMode = args?.create === true
  if (createMode) {
    if (existsSync(absPath)) {
      return { success: false, error: { code: 'FILE_EXISTS', message: `File already exists: ${filePath}`, suggestion: 'Drop create:true and edit it (read it first for base_version).' }, trace_id }
    }
    if (args?.patch || args?.base_version) {
      return { success: false, error: { code: 'invalid_input', message: 'create:true requires full content; do not pass patch/base_version' }, trace_id }
    }
    if (typeof args?.content !== 'string') {
      return { success: false, error: { code: 'missing_parameter', message: 'content is required for create:true' }, trace_id }
    }
    mkdirSync(dirname(absPath), { recursive: true })
  } else if (!existsSync(absPath)) {
    return { success: false, error: { code: 'FILE_NOT_FOUND', message: `File not found: ${filePath}`, suggestion: 'Pass create:true to create a new file, or use git_worktree/code_worktree for transactional multi-file creation.' }, trace_id }
  }

  // crash recovery 先行（r9：recoverJournals 内批次恢复已 async——取锁回滚）
  // 审核修复：补传 codeIndexService——否则 R18 的 index_pending 启动补抽分支只有测试在消费（生产死代码）
  const recovered = await recoverJournals(workspaceDir, { codeIndexService })
  if (recovered.length > 0) pipelineStep(pipeline, 'crash_recovery', 'warn', { recovered: recovered.length })
  // R4a：TransactionStore 系崩溃恢复同入口（幂等，只处理 staged）
  // 审核修复：补传 codeIndexService——R18 对齐（manifest index_pending 补抽消费）
  const txnRecovered = await recoverTransactions(workspaceDir, { codeIndexService })
  if (txnRecovered.length > 0) pipelineStep(pipeline, 'txn_crash_recovery', 'warn', { recovered: txnRecovered.length })
  const pruned = pruneJournals(workspaceDir)
  if (pruned.pruned > 0) pipelineStep(pipeline, 'journal_prune', 'ok', { pruned: pruned.pruned, kept: pruned.kept })

  const editMode = args?.edit_mode || (args?.patch ? 'patch' : 'replace_symbol')
  const boundary = args?.boundary || 'full'
  const preserveDecorators = args?.preserve_decorators !== false
  const dryRun = !!args?.dry_run
  const safety = args?.safety || {}
  const profile = safety.profile || 'standard'
  const force = !!args?.allow_unsafe_no_base || !!safety.allow_unsafe_no_base

  if (!createMode && editMode !== 'patch' && !locator?.name && !locator?.symbol_id) {
    return { success: false, error: { code: 'missing_parameter', message: 'replace_symbol requires locator.name or locator.symbol_id; for non-code files use edit_mode=patch.' }, trace_id }
  }
  if (editMode !== 'patch' && typeof args.content !== 'string') {
    // 7（F8）：content 缺失旧实现 TypeError 逃逸（undefined.split），调用方收到 throw 而非结构化错误
    return { success: false, error: { code: 'missing_parameter', message: `content is required for edit_mode=${editMode}` }, trace_id }
  }

  const t0 = Date.now()

  // 0) staleness 检查先行（附录 D：外部改动先重索引，否则 range 漂移会误报冲突）
  if (codeIndexService && !createMode) {
    const staleness = await checkFileStaleness(codeIndexService, workspaceDir, filePath)
    pipelineStep(pipeline, 'index_status_check', staleness?.auto_indexed ? 'ok' : staleness ? 'warn' : 'ok', {
      detail: staleness?.auto_indexed ? 'auto_reindexed' : staleness?.warning || 'fresh',
    })
  }

  // 1) 锁（附录 D：锁内 resolve + live read + conflict 一体，防 TOCTOU 静默覆盖）
  const lock = await acquireLock(absPath)
  if (lock.locked) {
    return { success: false, error: { code: 'FILE_LOCKED', message: `File is locked by another writer: ${filePath}`, suggestion: 'Retry after a moment.' }, trace_id }
  }
  pipelineStep(pipeline, 'lock', 'ok')

  const baseVersion = args?.base_version
  // WP08R-3 A2：dry-run 预览免 base（预览不落盘——允许先看 diff/校验，再决定是否读文件；apply 仍强制，下方闸门只对 dryRun=false 生效）
  if (!baseVersion && !force && !createMode && !dryRun) {
    lock.release()
    return {
      success: false,
      error: {
        code: 'VERSION_CONFLICT',
        conflict_type: 'NO_BASE',
        message: 'base_version is required for the first write of each file: read the FILE first with code_read (a symbol read does not establish a file base).',
        suggestion: 'Call code_read with locator {file_path} (whole file, no budget needed), then retry the same write with its read_ref.',
        next_action: { tool: 'read_symbol', params: { locator: { file_path: filePath } } },
      },
      trace_id,
    }
  }
  const base = force && !baseVersion ? null : baseVersion

  let symbol = null
  let symbolRows = []
  let content = ''
  let lines = []
  let range = null
  let curBodyHash = null
  let curSigHash = null
  let current = null
  let conflict = null
  let newContent = null
  let reindex = null
  let newVersion = null
  let diff = null
  let validation = null
  let journal = null
  let newBodyLineCount = null
  let successResult = null
  let patchNewStringOmitted = false
  try {
    // 2) 锁内 resolve locator → 符号 / 降级模式
    if (!createMode && locator.symbol_id && codeIndexService) {
      symbol = codeIndexService.getSymbolByStableId(locator.symbol_id)
      if (symbol && symbol.file_path !== filePath) symbol = null
      if (!symbol) {
        return { success: false, error: { code: 'SYMBOL_NOT_FOUND', message: `No symbol with stable_id ${locator.symbol_id} in ${filePath}` }, trace_id }
      }
    } else if (!createMode && locator.name && codeIndexService) {
      symbolRows = codeIndexService.findSymbolsInFile(filePath, locator.name, locator.kind)
      if (symbolRows.length > 1) {
        return {
          success: false,
          error: {
            code: 'AMBIGUOUS_SYMBOL',
            message: `${symbolRows.length} candidates for "${locator.name}" in ${filePath}`,
            candidates: symbolRows.map(r => ({ symbol_id: r.stable_id, name: r.name, kind: r.type, range: [r.start_line, r.end_line], signature: r.signature })),
          },
          trace_id,
        }
      }
      symbol = symbolRows[0] || null
      if (!symbol) {
        // 15（P3）：insert_after_symbol 需要已存在的锚点符号；新符号用 patch 模式创建，
        // 旧文案会让 LLM 以为符号真不存在（其实只是模式选错）
        const hint = editMode === 'insert_after_symbol'
          ? ' (insert_after_symbol needs an existing anchor symbol; use edit_mode="patch" to create a new symbol)'
          : ''
        return { success: false, error: { code: 'SYMBOL_NOT_FOUND', message: `No symbol named "${locator.name}" in ${filePath}${hint}` }, trace_id }
      }
    }
    pipelineStep(pipeline, 'resolve_locator', symbol ? 'ok' : 'ok', { via: symbol ? 'symbol' : 'degraded_patch' })

    // 3) 锁内 live 读当前文件 → current version
    try { content = createMode ? '' : readFileSync(absPath, 'utf-8') } catch (e) {
      return { success: false, error: { code: 'READ_FAILED', message: e.message }, trace_id }
    }
    const curFileHash = sha256(content)
    lines = content.split('\n')
    range = symbol ? [symbol.start_line, Math.max(symbol.start_line, symbol.end_line)] : null
    if (symbol && range) {
      const body = lines.slice(range[0] - 1, range[1]).join('\n')
      curBodyHash = sha256(body)
      const sigLine = extractSignatureLine(lines, symbol)
      curSigHash = sha256(sigLine || '')
    }
    current = {
      file: { hash: `sha256:${curFileHash}`, size: Buffer.byteLength(content, 'utf-8') },
      symbol: symbol ? { body_hash: `sha256:${curBodyHash}`, signature_hash: `sha256:${curSigHash}` } : null,
    }

    // 4) 锁内冲突判定（附录 C 状态机）
    if (base) {
      // 跨符号链式写（读 A 写 A 后拿 new_version 直接写 B）：base.symbol 是 A 的 hash，
      // 对 B 无符号级意义 → 降级为 file-level 比较（附录 C：符号级冲突只对目标符号判定）
      const baseForCheck = { ...base }
      if (symbol && base.symbol?.symbol_id && base.symbol.symbol_id !== symbol.stable_id) {
        baseForCheck.symbol = null
        pipelineStep(pipeline, 'version_check', 'ok', { note: 'cross_symbol_chain: file-level check' })
      }
      conflict = classifyConflict(
        { file: { hash: baseForCheck.file?.hash, truncated_hash: baseForCheck.file?.truncated_hash }, symbol: baseForCheck.symbol || null },
        current,
        !!symbol
      )
      pipelineStep(pipeline, 'version_check', conflict.type === 'CLEAN' ? 'ok' : 'warn', { conflict: conflict.type })
      const policy = CONFLICT_POLICY[conflict.type] || 'reject'
      if (policy === 'reject') {
        const suggestion = conflict.type === 'SYMBOL_CHANGED' || conflict.type === 'SYMBOL_SIGNATURE_CHANGED'
          ? 'Re-read the symbol and regenerate content.'
          : conflict.type === 'SYMBOL_DELETED' ? 'Symbol was deleted; re-read the file.'
          : conflict.type === 'FILE_CHANGED'
            ? 'File changed externally; re-read (read_symbol) and retry with the fresh version.'
            : 'Resolve ambiguity via symbol_id.'
        return {
          success: false,
          error: {
            code: 'VERSION_CONFLICT',
            conflict_type: conflict.type,
            message: `base_version mismatch: ${conflict.type}`,
            suggestion,
            next_action: { tool: 'read_symbol', params: { locator: { file_path: filePath, symbol_id: symbol?.stable_id || undefined, name: symbol?.name }, mode: 'core' } },
          },
          trace_id,
          current_version: current,
        }
      }
    }

    // 5) 应用编辑
    let newLines = null
    let alreadyApplied = false
    const scopeContent = symbol && range ? lines.slice(range[0] - 1, range[1]).join('\n') : content

    if (createMode) {
      // Q2：新建=整文件内容；diff 相对空文件
      newLines = args.content.split('\n')
      diff = makeSimpleDiff([], newLines)
      pipelineStep(pipeline, 'create', 'ok', { bytes: args.content.length })
    } else if (editMode === 'patch') {
      const patch = args.patch || {}
      const oldString = patch.old_string
      const newString = patch.new_string ?? ''
      // R22-⑦（并发拷打）：patch 缺 new_string = 删除 old_string——显式空串是合法删除，缺省（undefined）多为误用，挂 warning 不阻断
      patchNewStringOmitted = patch.new_string === undefined
      if (typeof oldString !== 'string' || oldString === '') {
        return { success: false, error: { code: 'missing_parameter', message: 'patch.old_string is required — patch must be an object {old_string, new_string}; got ' + (args.patch === undefined ? 'undefined' : typeof args.patch) }, trace_id }
      }
      const occurrences = countOccurrences(scopeContent, oldString)
      if (occurrences === 0) {
        if (newString && countOccurrences(scopeContent, newString) > 0) {
          alreadyApplied = true
          newLines = lines
          pipelineStep(pipeline, 'patch_match', 'ok', { status: 'already_applied' })
        } else {
          pipelineStep(pipeline, 'patch_match', 'error', { reason: 'old_string_not_found' })
          return {
            success: false,
            error: { code: 'PATCH_OLD_STRING_NOT_FOUND', message: `old_string not found in ${symbol ? 'symbol body' : 'file'}` },
            suggestion: 'Re-read the file (file changed?) and regenerate the patch.',
            trace_id,
          }
        }
      } else if (occurrences > 1) {
        return {
          success: false,
          error: { code: 'PATCH_OLD_STRING_AMBIGUOUS', message: `old_string matches ${occurrences} times`, suggestion: 'Include more surrounding context in old_string.' },
          trace_id,
        }
      } else {
        if (symbol && range) {
          const body = lines.slice(range[0] - 1, range[1]).join('\n')
          // r54(P2): 函数替换器——字符串替换会解释 newString 里的 $&/$'/`$`/$$ 序列 → 写入内容被篡改
          const patchedBody = body.replace(oldString, () => newString)
          newLines = [...lines.slice(0, range[0] - 1), ...patchedBody.split('\n'), ...lines.slice(range[1])]
          newBodyLineCount = patchedBody.split('\n').length
          diff = makeSimpleDiff(lines, newLines)
        } else {
          const patched = content.replace(oldString, () => newString)
          newLines = patched.split('\n')
          diff = makeSimpleDiff(lines, newLines)
        }
        pipelineStep(pipeline, 'patch_match', 'ok')
      }
    } else if (editMode === 'replace_symbol') {
      if (!symbol || !range) {
        return { success: false, error: { code: 'missing_parameter', message: 'replace_symbol requires a resolved symbol; use edit_mode=patch for non-code files.' }, trace_id }
      }
      // 附录 B：full = 整符号替换；body = 保留签名行
      if (boundary === 'body') {
        const r = applyBodyEdit(lines, [range[0] + 1, range[1]], args.content, preserveDecorators)
        if (r.error) return { success: false, error: r.error, trace_id }
        newLines = r.lines
        diff = r.diff
        newBodyLineCount = args.content.split('\n').length
      } else {
        const r = applyReplace(lines, range, args.content)
        newLines = r.lines
        diff = r.diff
        newBodyLineCount = args.content.split('\n').length
        const newSig = extractSignatureLine(args.content.split('\n'), { start_line: 1 })
        const newSigHash = sha256(newSig || '')
        if (newSigHash !== curSigHash) {
          pipelineStep(pipeline, 'signature_check', 'warn', { reason: 'SIGNATURE_WILL_CHANGE' })
        }
      }
      // 附录 B 护栏：装饰器检测（warn 不 block，strict block）
      if (preserveDecorators) {
        const above = (lines[range[0] - 2] || '').trim()
        if (above.startsWith('@') && !(args.content || '').trim().startsWith('@')) {
          pipelineStep(pipeline, 'decorator_guard', 'warn', { reason: 'decorator_may_be_lost', suggestion: 'Set preserve_decorators=false if intentional, or include decorator in content.' })
        }
      }
    } else if (editMode === 'insert_after_symbol') {
      if (!symbol || !range) {
        return { success: false, error: { code: 'missing_parameter', message: 'insert_after_symbol requires a resolved symbol.' }, trace_id }
      }
      const r = applyInsertAfter(lines, range, args.content)
      newLines = r.lines
      diff = r.diff
      newBodyLineCount = args.content.split('\n').length
    } else {
      return { success: false, error: { code: 'INVALID_INPUT', message: `unknown edit_mode: ${editMode}` }, trace_id }
    }

    if (alreadyApplied) {
      return {
        success: true,
        status: 'already_applied',
        message: 'The intended change is already present; treating as success (idempotent).',
        new_version: { file: { hash: `sha256:${curFileHash}` }, symbol: symbol ? { body_hash: `sha256:${curBodyHash}`, signature_hash: `sha256:${curSigHash}` } : null },
        trace_id,
      }
    }

    newContent = newLines.join('\n')

    // 6) 校验（sandbox 基础 + 语法，dry_run 也校验）
    // R22 修复 #3（2026-10-12）：括号校验仅对代码文件；非代码（json/md/txt…）与 edit_transaction 语义一致地 skip——
    // 旧实现无条件检查，合法 JSON（含 https:// 字符串）被剥离器误伤 → 误拒写（真阳性：package-lock 批改被 VALIDATION_FAILED 拦）
    const isCodeFile = !!langOf(filePath)
    const bracket = isCodeFile ? checkBracketBalance(newContent) : null
    validation = {
      bracket: isCodeFile ? (bracket.ok ? { status: 'pass' } : { status: 'fail', errors: [bracket.detail] }) : { status: 'skip', reason: 'non-code file' },
    }
    if (langOf(filePath)) {
      const syn = await validateSyntax(langParser, newContent, extname(filePath))
      validation.syntax = syn
    } else {
      validation.syntax = { status: 'skip', reason: 'non-code file' }
    }
    reconcileBracketWithSyntax(validation)
    pipelineStep(pipeline, 'validate', validation.syntax.status === 'pass' && validation.bracket.status === 'pass' ? 'ok' : 'warn', { syntax: validation.syntax.status, bracket: validation.bracket.status })
    if (shouldBlockValidation(safety, validation)) {
      return { success: false, error: buildValidationFailure('VALIDATION_FAILED', 'validation failed: syntax/bracket errors detected; refusing write. Pass safety.block_on_validation_error=false to override.', validation, newContent, args?.content ?? args?.patch?.new_string), trace_id }
    }

    if (dryRun) {
      lock.release()
      return {
        success: true,
        dry_run: true,
        diff,
        validation,
        new_version: { file: { hash: `sha256:${sha256(newContent)}` } },
        safety_report: {
          collision: conflict ? { status: conflict.type === 'CLEAN' ? 'clean' : conflict.type } : { status: 'no_base' },
          validation,
        },
        pipeline,
        trace_id,
        duration_ms: Date.now() - t0,
      }
    }

    // 7) journal（写前建，staged；dryRun 已在上面返回，不产生 staged 残留——
    //    残留 staged 会被下次 recoverJournals 当崩溃事务回滚，覆盖后来的合法写入）
    journal = createJournal(workspaceDir, filePath, absPath, content, {
      editMode, boundary, state: 'staged', base_file_hash: base?.file?.hash || null,
      ...(createMode ? { created: true } : {}),
    })
    updateJournalState(journal.dir, { state: 'staged', new_hash: sha256(newContent) })

    // 8) 原子写：temp + rename（附录 D）
    const tmpPath = _uniqueTmp(absPath, 'tmp')
    try {
      // 7（F7）：旧 writeFileSync 在 try 外——磁盘满/权限错误裸异常逃逸，tmp 半写残留，错误契约破坏
      // N3：继承原文件 mode（可执行脚本编辑后不得丢 +x）
      _writeTmpPreservingMode(tmpPath, newContent, absPath)
      await renameRetry(tmpPath, absPath)
    } catch (e) {
      try { unlinkSync(tmpPath) } catch {}
      updateJournalState(journal.dir, { state: 'failed', reason: e.message })
      lock.release()
      return { success: false, error: { code: 'ATOMIC_WRITE_FAILED', message: e.message, txn_id: journal.txnId }, trace_id }
    }
    pipelineStep(pipeline, 'atomic_write', 'ok')
    updateJournalState(journal.dir, { state: 'committed', committed_at: new Date().toISOString() })
    // WP04/AC27「应用后读取实际hash」：tmp+rename 后独立回读实测。与内存内容不一致时
    // 如实降级（success=false + READBACK_MISMATCH，journal 置 indeterminate），不冒充写入
    // 内容可信；request_id 重试的 reconcile 会按 intended hash 核对真实文件后终态收口。
    // MALONG_TEST_READBACK_MISMATCH=1 仅测试环境注入回读不一致（同 KILL_AFTER_WRITE 先例）。
    let readBackContent = null
    try { readBackContent = readFileSync(absPath, 'utf-8') } catch {}
    if (process.env.MALONG_TEST_READBACK_MISMATCH === '1' || readBackContent == null || readBackContent !== newContent) {
      updateJournalState(journal.dir, { state: 'indeterminate', reason: 'readback_mismatch' })
      lock.release()
      return { success: false, error: { code: 'READBACK_MISMATCH', message: 'post-write read-back does not match intended content; state indeterminate', txn_id: journal.txnId }, trace_id }
    }
    pipelineStep(pipeline, 'readback', 'ok')
    // Y002-S1：写后登记写者（collision_guard classify 识别 write_runtime）
    registerWriter(workspaceDir, filePath, 'write_runtime')

    // 组装 new_version（锁内，行号用 apply 后的真实值）
    newVersion = {
      file: { hash: `sha256:${sha256(newContent)}`, size: Buffer.byteLength(newContent, 'utf-8') },
      symbol: null,
    }
    if (symbol && range && newBodyLineCount != null) {
      const newLinesArr = newContent.split('\n')
      if (editMode === 'insert_after_symbol') {
        // live 审查 K4：插入不改变原符号——body_hash/range 取写前索引值（旧按替换公式算，
        // 内容行数与符号行数不一致时 range/哈希错位；写后重抽成功会校正，但索引不可用时错误版本误导链式写）
        newVersion.symbol = {
          symbol_id: symbol.stable_id || null,
          range: [symbol.start_line, symbol.end_line],
          body_hash: `sha256:${curBodyHash}`,
        }
      } else {
        // 9（F2）：body_hash/range 遵循索引约定（symbol-anchors：slice(start_line-1,end_line) 含签名行的全符号）。
        // 旧实现 boundary=body 时 symStart=range[0]+1 → body_hash 只算 body（不含签名），与 read_symbol /
        // 预写 curBodyHash 的 full 约定不一致 → 同符号链式写（拿 new_version 当下一轮 base）误判 SYMBOL_CHANGED。
        const isBodyOnly = editMode === 'replace_symbol' && boundary === 'body'
        const fullEnd = isBodyOnly ? range[0] + newBodyLineCount : range[0] + Math.max(0, newBodyLineCount - 1)
        const newRange = [range[0], fullEnd]
        newVersion.symbol = {
          symbol_id: symbol.stable_id || null,
          range: newRange,
          body_hash: `sha256:${sha256(newLinesArr.slice(range[0] - 1, fullEnd).join('\n'))}`,
        }
      }
    }

    // 10) force 写审计（附录 E）
    if (force) {
      auditLog(workspaceDir, { event: 'force_write', file: filePath, trace_id })
    }
    successResult = {
      success: true,
      symbol_id: symbol?.stable_id || null,
      txn_id: journal.txnId,
      ...(patchNewStringOmitted ? { warning: 'patch.new_string omitted — old_string will be removed (explicit empty string if deletion is intended)' } : {}),
      // Y002-S2：LLM 工作流闭环——write_symbol 走 write-journal（非 .ai-transactions，diff_facts 不适用），
      // 闭环为 test_bridge → debug_runner；经 edit_transaction 的改动才接 diff_facts
      next_step: 'workflow: test_bridge(action="run") → debug_runner on failure; if edits went through edit_transaction, also diff_facts(since="last_txn")',
      new_version: newVersion,
      diff,
      safety_report: {
        collision: conflict ? { status: conflict.type === 'CLEAN' ? 'clean' : conflict.type } : { status: 'no_base' },
        validation,
        warnings: pipeline.filter(p => p.status === 'warn').map(p => ({ step: p.step, detail: p.detail || p.reason })),
      },
      undo: {
        token: journal.txnId,
        txn_id: journal.txnId,
        expires_at: new Date(Date.now() + JOURNAL_RETENTION_HOURS * 3600 * 1000).toISOString(),
        retention_hours: JOURNAL_RETENTION_HOURS,
        via: 'edit_transaction(action=undo_commit)',
        reverse: { file: filePath, backup: `${JOURNAL_ROOT}/journal/${journal.txnId}/backup/${basename(filePath)}` },
      },
      pipeline,
      trace_id,
      duration_ms: Date.now() - t0,
    }
  } finally {
    lock.release()
  }
  if (!successResult) {
    return { success: false, error: { code: 'INTERNAL', message: 'writeSymbol completed without result', trace_id } }
  }
  // 9) 写后同步重抽（附录 D：写完立刻可读；锁外执行，缩短临界区）
  if (codeIndexService && langOf(filePath)) {
    try {
      const r = await codeIndexService.indexFile(absPath, workspaceDir)
      reindex = { status: 'ok', symbols: r?.symbols ?? 0, refs: r?.refs ?? 0 }
      pipelineStep(pipeline, 'reindex', 'ok')
      // 9（F2）：用重抽后的索引值校正 new_version.symbol——索引 body_hash/range 是 read_symbol 的权威来源。
      // 锁内算术推算（newBodyLineCount）会因 content 尾随换行与 parser end_line 对不上 →
      // 同符号链式写（拿 new_version 当下一轮 base）body_hash 不一致被误判 SYMBOL_CHANGED。
      const nvSym = successResult.new_version?.symbol
      if (nvSym?.symbol_id) {
        // 审查修复（M6）：校正前重读文件哈希比对——锁外重抽可能读到并发写者写入后的内容，
        // 用他人内容校正 body_hash/range → 链式写（拿 new_version 当下一轮 base）错误基线。
        // 仅当当前文件 == 自己写入的 newHash 才采纳重抽索引
        let mine = false
        try { mine = sha256(readFileSync(absPath)) === sha256(newContent) } catch {}
        if (mine) {
          const fresh = codeIndexService.getSymbolByStableId(nvSym.symbol_id)
          if (fresh && fresh.body_hash) {
            nvSym.body_hash = `sha256:${fresh.body_hash}`
            nvSym.range = [fresh.start_line, fresh.end_line]
          }
        }
      }
    } catch (e) {
      reindex = { status: 'failed', reason: e.message }
      codeIndexService.markIndexDirty(filePath, 'write_pending_reindex')
      // R18：journal 记 index_pending——启动恢复时 recoverJournals 补抽（不依赖显式 reindex）
      if (journal) {
        try { updateJournalState(journal.dir, { index_pending: true, index_pending_reason: e.message }) } catch {}
      }
      pipelineStep(pipeline, 'reindex', 'warn', { reason: e.message })
    }
  } else if (codeIndexService) {
    // 非代码文件：只更新 content_hash（附录 E）
    try {
      const row = codeIndexService.getFileByPath(filePath)
      if (row) {
        // r11(L6)：改用公共方法——旧实现直取 _db 私有字段（service stop 后 _db=null → TypeError）
        codeIndexService.updateContentHash(filePath, sha256(newContent))
        reindex = { status: 'ok', note: 'non-code: content_hash updated' }
      } else {
        reindex = { status: 'ok', note: 'non-code: not_indexed' }
      }
    } catch (e) { reindex = { status: 'failed', reason: e.message } }
    pipelineStep(pipeline, 'reindex', reindex.status === 'ok' ? 'ok' : 'warn', { note: reindex.note || reindex.reason })
  }
  if (reindex) successResult.reindex = reindex
  return successResult
}

function pipelineStep(pipeline, step, status, extra = {}) {
  pipeline.push({ step, status, ...extra })
}

// ---------- P4：write_symbols 批量（§6.4 隐式 all_or_nothing 事务 + §16.4 锁序 + 附录 D） ----------
// 应用层补偿事务（非 FS 级原子）：stage 全量 → 全验证 → 逐个文件原子写 → 任一失败回滚已写文件。
// 按文件聚合：同文件多符号合并为一次锁 + 一次原子写 + 一次重抽（§16.1）；
// 组内符号用行偏移（delta）修正定位，写后重抽再重新 resolve（跨调用路径）。
// 多文件锁按 workspace-relative path 字典序加锁防死锁（§16.4）。

function resolveBatchSymbol(codeIndexService, filePath, locator) {
  if (locator.symbol_id && codeIndexService) {
    const sym = codeIndexService.getSymbolByStableId(locator.symbol_id)
    if (sym && sym.file_path === filePath) return sym
    if (!sym) return { error: { code: 'SYMBOL_NOT_FOUND', message: `No symbol with stable_id ${locator.symbol_id} in ${filePath}` } }
    return { error: { code: 'SYMBOL_NOT_FOUND', message: `stable_id ${locator.symbol_id} belongs to ${sym.file_path}, not ${filePath}` } }
  }
  if (locator.name && codeIndexService) {
    const rows = codeIndexService.findSymbolsInFile(filePath, locator.name, locator.kind)
    if (rows.length > 1) {
      return { error: { code: 'AMBIGUOUS_SYMBOL', message: `${rows.length} candidates for "${locator.name}" in ${filePath}`, candidates: rows.map(r => ({ symbol_id: r.stable_id, name: r.name, kind: r.type, range: [r.start_line, r.end_line], signature: r.signature })) } }
    }
    if (rows.length === 0) return { error: { code: 'SYMBOL_NOT_FOUND', message: `No symbol named "${locator.name}" in ${filePath}` } }
    return rows[0]
  }
  return { error: { code: 'missing_parameter', message: 'each write requires locator.symbol_id or locator.name (patch mode: locator may be file-only)' } }
}

export async function writeSymbols(args, context) {
  const { codeIndexService, getWorkspaceDir, langParserService } = context
  const langParser = langParserService
  const workspaceDir = args?.workspace_dir
  const pipeline = []
  const trace_id = traceId()

  if (!workspaceDir) {
    return { success: false, error: { code: 'missing_parameter', message: 'workspace_dir is required' }, trace_id }
  }
  const writes = args?.writes
  if (!Array.isArray(writes) || writes.length === 0) {
    return { success: false, error: { code: 'missing_parameter', message: 'writes is required (non-empty array)' }, trace_id }
  }
  const policy = args?.policy || {}
  const allOrNothing = policy.all_or_nothing !== false
  const dryRun = !!policy.dry_run || !!args?.dry_run
  const safety = args?.safety || {}
  const force = !!args?.allow_unsafe_no_base || !!safety.allow_unsafe_no_base

  const t0 = Date.now()
  // 审核修复：补传 codeIndexService——R18 index_pending 启动补抽生产接线
  const recovered = await recoverJournals(workspaceDir, { codeIndexService })
  if (recovered.length > 0) pipelineStep(pipeline, 'crash_recovery', 'warn', { recovered: recovered.length })
  // R4a：TransactionStore 系崩溃恢复同入口
  // 审核修复：补传 codeIndexService——R18 对齐（manifest index_pending 补抽消费）
  const txnRecovered = await recoverTransactions(workspaceDir, { codeIndexService })
  if (txnRecovered.length > 0) pipelineStep(pipeline, 'txn_crash_recovery', 'warn', { recovered: txnRecovered.length })
  const pruned = pruneJournals(workspaceDir)
  if (pruned.pruned > 0) pipelineStep(pipeline, 'journal_prune', 'ok', { pruned: pruned.pruned, kept: pruned.kept })

  // 按 file_path 分组（保输入序），组按 workspace-relative 路径字典序排序（§16.4 锁序防死锁）
  const groups = new Map()
  for (const w of writes) {
    // 11#3：兼容 schema 文档的 locator.file_path——旧实现只认根级 file_path，
    // 按 schema 传 locator.file_path 会误报 missing_parameter
    const fp = w?.file_path || w?.locator?.file_path
    if (!fp) {
      return { success: false, error: { code: 'missing_parameter', message: 'each write requires file_path (root-level or locator.file_path)' }, trace_id }
    }
    const pathCheck = validateFilePath(fp)
    if (!pathCheck.ok) {
      return { success: false, error: { code: 'PATH_BLOCKED', message: pathCheck.detail }, trace_id }
    }
    // r9(P2)：批量主写路径同样补 realpath 守卫
    const guardW = guardRealPath(workspaceDir, fp)
    if (guardW.blocked) {
      return { success: false, error: { code: 'PATH_BLOCKED', message: guardW.detail }, trace_id }
    }
    if (!groups.has(fp)) groups.set(fp, [])
    groups.get(fp).push(w)
  }
  const groupFiles = [...groups.keys()].sort()
  const absPathOf = (fp) => join(workspaceDir, fp)

  const items = []
  const written = []   // 已写文件：{ absPath, filePath, backup, journalDir }
  const intendedFiles = {} // 每文件预期写后哈希（dry-run 也产出）——供 code_batch 崩溃核对（W3）
  const validationByFile = {} // Q3：每文件 validation（dry-run 也产出）——供 code_batch 预览诚实报告
  let failed = null
  const fileFailures = [] // r54(P1): best_effort 收集每文件失败后继续，不再首失败即停
  let allDiffs = []
  // r8(F10)：批次标记——崩溃恢复时识别「部分提交的半批」并回滚（journal 每文件独立，无批次级记录会静默留下半批）
  let batchId = null
  const batchTxnIds = []
  if (!dryRun) {
    try {
      // r9(F4)：标记批次模式——best_effort 崩溃后部分提交不回滚（用户可见的成功结果）
      batchId = createBatchMarker(workspaceDir, groupFiles, allOrNothing ? 'strict' : 'best_effort').batchId
    } catch (e) {
      // R22-⑯：批次锁忙（另一个 writeSymbols 正在运行）→ 硬失败，不降级无锚点批
      if (e?.code === 'BATCH_LOCK_BUSY') {
        return { success: false, error: { code: 'BATCH_LOCK_BUSY', message: 'Another batch write is in progress. Retry when it completes.' }, trace_id }
      }
      batchId = null
    }
  }

  // ── 逐组（文件）执行：锁 → 组内逐项 resolve+判定+apply（共享 lines）→ 一次原子写 ──
  // r54(P0-9): 整循环包 try/catch——createJournal(mkdirSync/writeFileSync ENOSPC/权限)、acquireLock(EMFILE)
  // 等未捕获 throw 会穿透跳过下方回滚段，先写文件带 committed journal 留盘，all_or_nothing 静默破坏。
  try {
  for (const fp of groupFiles) {
    if (failed && allOrNothing) break
    const absPath = absPathOf(fp)
    const groupItemsPre = groups.get(fp)
    const isCreateGroup = groupItemsPre.some(w => w?.create === true)
    let createErr = null
    if (isCreateGroup) {
      const ci = groupItemsPre.find(w => w?.create === true)
      if (groupItemsPre.length !== 1) createErr = { code: 'invalid_input', message: 'create:true requires exactly one write item for the file' }
      else if (existsSync(absPath)) createErr = { code: 'FILE_EXISTS', message: `File already exists: ${fp}` }
      else if (ci?.patch || ci?.base_version) createErr = { code: 'invalid_input', message: 'create:true requires full content; do not pass patch/base_version' }
      else if (typeof ci?.content !== 'string') createErr = { code: 'missing_parameter', message: 'content is required for create:true' }
      if (!createErr) mkdirSync(dirname(absPath), { recursive: true })
    } else if (!existsSync(absPath)) {
      createErr = { code: 'FILE_NOT_FOUND', message: `File not found: ${fp}`, suggestion: 'Pass create:true to create a new file, or use git_worktree/code_worktree.' }
    }
    if (createErr) {
      const err = { file: fp, error: createErr }
      if (allOrNothing) { failed = err; break }
      fileFailures.push(err); continue
    }
    // staleness 预热（锁外；批量内 resolve 需要新 range）
    if (codeIndexService && !isCreateGroup) {
      try { await checkFileStaleness(codeIndexService, workspaceDir, fp) } catch {}
    }

    const lock = await acquireLock(absPath)
    if (lock.locked) {
      const err = { file: fp, error: { code: 'FILE_LOCKED', message: `File is locked by another writer: ${fp}`, suggestion: 'Retry after a moment.' } }
      if (allOrNothing) { failed = err; break }
      fileFailures.push(err); continue // r54(P1): best_effort 记录后继续
    }
    try {
      let content = ''
      if (isCreateGroup) {
        content = '' // Q2：新建写前内容为空，journal backup 为空串
      } else {
        try { content = readFileSync(absPath, 'utf-8') } catch (e) {
          const err = { file: fp, error: { code: 'READ_FAILED', message: e.message } }
          if (allOrNothing) { failed = err; break }
          fileFailures.push(err); continue // r54(P1): best_effort 记录后继续
        }
      }
      let lines = content.split('\n')
      const appliedEdits = [] // {endLine(原文件坐标), delta}——偏移只对位于先前编辑点之后的符号生效
      let firstReal = true
      const groupItems = groups.get(fp)
      const groupResults = []
      const groupTargets = new Set() // live 审查 H1：同批同符号重复编辑检测

      for (let idx = 0; idx < groupItems.length; idx++) {
        const w = groupItems[idx]
        const editMode = w?.edit_mode || (w?.patch ? 'patch' : 'replace_symbol')
        const boundary = w?.boundary || 'full'
        const preserveDecorators = w?.preserve_decorators !== false

        // live 狗粮：item_index 对用户必须指向输入下标（groups 已按路径排序，组内 idx 会误导）
        const inputIndex = writes.indexOf(w) >= 0 ? writes.indexOf(w) : idx
        // resolve（索引 range + 组内行偏移修正，§16.1：不复用入参 range）
        let symbol = null
        if (isCreateGroup) {
          // Q2：新建无符号可解析——直接落到下方 apply 的 create 分支
        } else if (editMode === 'patch') {
          // patch 模式：可无符号（文件级 patch 或符号内 patch）
          if (w?.locator?.symbol_id || w?.locator?.name) {
            const rs = resolveBatchSymbol(codeIndexService, fp, w.locator)
            if (rs.error) { failed = { file: fp, itemIndex: inputIndex, error: rs.error }; break }
            symbol = rs
          }
        } else {
          if (!w?.locator) { failed = { file: fp, itemIndex: inputIndex, error: { code: 'missing_parameter', message: 'replace_symbol requires locator' } }; break }
          const rs = resolveBatchSymbol(codeIndexService, fp, w.locator)
          if (rs.error) { failed = { file: fp, itemIndex: inputIndex, error: rs.error }; break }
          symbol = rs
        }
        // 7（F1）：旧实现全局 offset 累加——批内后项目标在先前编辑点之前时位置错移 → 负 range 静默丢行/重复。
        // 偏移只累计「编辑结束于本目标之前」的项；无符号的文件级 patch 位置未知，按旧行为全量偏移
        let offset = 0
        if (symbol) {
          for (const ae of appliedEdits) {
            if (ae.endLine != null && ae.endLine < symbol.start_line) offset += ae.delta
            else if (ae.endLine == null) offset += ae.delta
          }
        } else {
          for (const ae of appliedEdits) offset += ae.delta
        }
        const range = symbol ? [symbol.start_line + offset, Math.max(symbol.start_line + offset, symbol.end_line + offset)] : null

        // live hashes（内存 lines）
        const curBodyHash = symbol && range ? `sha256:${sha256(lines.slice(range[0] - 1, range[1]).join('\n'))}` : null
        const curSigHash = symbol && range ? `sha256:${sha256(extractSignatureLine(lines, { ...symbol, start_line: symbol.start_line + offset }) || '')}` : null
        const current = {
          file: { hash: `sha256:${sha256(lines.join('\n'))}`, size: Buffer.byteLength(lines.join('\n'), 'utf-8') },
          symbol: symbol ? { body_hash: curBodyHash, signature_hash: curSigHash } : null,
        }

        // §16.7 幂等预检：目标已是意图内容 → already_applied，跳过冲突判定与 apply
        // （重试整批时 base_version 已过期，冲突判定会误拒——预检必须在冲突之前）
        // r54(P2): insert_after 的 content 是要插入的新代码、scopeText 是锚点符号自身——两者恰同时误判 already_applied 静默跳过，该模式跳过预检
        if (w?.content && symbol && range && editMode !== 'insert_after_symbol') {
          const scopeText = boundary === 'body' ? lines.slice(range[0], range[1]).join('\n') : lines.slice(range[0] - 1, range[1]).join('\n')
          if (scopeText.trim() === w.content.trim()) {
            groupResults.push({ file_path: fp, symbol_id: symbol.stable_id || null, edit_mode: editMode, status: 'already_applied', content: w.content })
            pipelineStep(pipeline, 'idempotency', 'ok', { status: 'already_applied', file: fp })
            continue
          }
        } else if (editMode === 'patch' && w?.patch?.old_string) {
          const patchScope = symbol && range ? lines.slice(range[0] - 1, range[1]).join('\n') : lines.join('\n')
          if (countOccurrences(patchScope, w.patch.old_string) === 0 && w.patch.new_string && countOccurrences(patchScope, w.patch.new_string) > 0) {
            groupResults.push({ file_path: fp, symbol_id: symbol?.stable_id || null, edit_mode: editMode, status: 'already_applied' })
            pipelineStep(pipeline, 'idempotency', 'ok', { status: 'already_applied', file: fp })
            continue
          }
        }

        // live 审查 H1：同批重复编辑同一符号——批内 offset 只修正“位于先前编辑之后”的符号，
        // 同符号第二项沿用陈旧 range → 静默覆盖/删邻行；明确拒绝，提示拆批（用户拍板方案）
        if (symbol) {
          const tkey = symbol.stable_id || ('L' + symbol.start_line + '-' + symbol.end_line)
          if (groupTargets.has(tkey)) {
            failed = { file: fp, itemIndex: inputIndex, error: { code: 'DUPLICATE_SYMBOL_EDIT', message: 'symbol ' + tkey + ' is edited more than once in the same batch', suggestion: 'Read the FILE once (file-level read_ref) so each write resolves its own symbol, then retry the batch in ONE call.' } }
            break
          }
          groupTargets.add(tkey)
        }

        // 冲突判定：组内首个真实写项做 file-level（文件基线）；后续项仅符号级（文件已在批内变更）
        const itemBase = w?.base_version
        if (firstReal && !itemBase && !force && !isCreateGroup && !dryRun) {
          failed = { file: fp, itemIndex: inputIndex, error: { code: 'VERSION_CONFLICT', conflict_type: 'NO_BASE', message: 'base_version is required for the first write of each file: read the FILE first with code_read (a symbol read does not establish a file base).', suggestion: 'Call code_read with locator {file_path} (whole file, no budget needed), then resubmit the SAME writes with that read_ref.', next_action: { tool: 'read_symbol', params: { locator: { file_path: fp } } } } }
          break
        }
        if (firstReal && itemBase) {
          const conflict = classifyConflict({ file: { hash: itemBase.file?.hash, truncated_hash: itemBase.file?.truncated_hash }, symbol: itemBase.symbol || null }, current, !!symbol)
          pipelineStep(pipeline, 'version_check', conflict.type === 'CLEAN' ? 'ok' : 'warn', { conflict: conflict.type, file: fp })
          const policy_ = CONFLICT_POLICY[conflict.type] || 'reject'
          if (policy_ === 'reject') {
            failed = { file: fp, itemIndex: inputIndex, error: { code: 'VERSION_CONFLICT', conflict_type: conflict.type, message: `base_version mismatch: ${conflict.type} (read the FILE once — symbol reads do not establish a file base)`, suggestion: 'Read the FILE (file_path) once, then resubmit the same writes with that read_ref.', next_action: { tool: 'read_symbol', params: { locator: { file_path: fp } } } } }
            break
          }
        } else if (!firstReal && itemBase?.symbol) {
          // 后续项：符号级判定（file hash 已在批内变化，无比较意义）
          const baseSymId = itemBase.symbol.symbol_id
          if (baseSymId && symbol && baseSymId === symbol.stable_id && curBodyHash && itemBase.symbol.body_hash !== curBodyHash) {
            failed = { file: fp, itemIndex: inputIndex, error: { code: 'VERSION_CONFLICT', conflict_type: 'SYMBOL_CHANGED', message: `base_version mismatch: SYMBOL_CHANGED for ${symbol.stable_id}`, suggestion: 'Re-read the symbol and regenerate content.' } }
            break
          }
          // r8(F13)：base_version 的符号与目标符号不一致（跨符号/陈旧 base）——符号级无意义，
          // 降级为「批内当前内容 vs base 文件 hash」比较（对齐单发路径 L298-304 语义），不一致即拒
          if (baseSymId && symbol && baseSymId !== symbol.stable_id && itemBase.file?.hash && itemBase.file.hash !== `sha256:${sha256(lines.join('\n'))}`) {
            failed = { file: fp, itemIndex: inputIndex, error: { code: 'VERSION_CONFLICT', conflict_type: 'FILE_CHANGED', message: `base_version symbol (${baseSymId}) does not match target (${symbol.stable_id}) and file changed since base`, suggestion: 'Re-read the file and regenerate the batch.' } }
            break
          }
        }

        // apply（Q2：新建 = 整文件内容，跳过编辑模式）
        const itemResult = isCreateGroup
          ? { lines: w.content.split('\n'), status: 'created', diff: makeSimpleDiff([], w.content.split('\n')) }
          : applyBatchItem(lines, range, w, symbol, editMode, boundary, preserveDecorators)
        if (itemResult.error) { failed = { file: fp, itemIndex: inputIndex, error: itemResult.error }; break }
        firstReal = false
        lines = itemResult.lines
        if (itemResult.delta) appliedEdits.push({ endLine: symbol ? symbol.end_line : null, delta: itemResult.delta })
        if (itemResult.diff) allDiffs.push({ file: fp, diff: itemResult.diff })
        groupResults.push({ file_path: fp, symbol_id: symbol?.stable_id || null, edit_mode: editMode, status: itemResult.status, content: w.content, ...(itemResult.warning ? { warning: itemResult.warning } : {}) })
      }
      if (failed) {
        if (allOrNothing) break
        fileFailures.push(failed); failed = null; continue // r54(P1): best_effort 记录后继续下一文件
      }

      // 全组验证（一次）
      const newContent = lines.join('\n')
      // R22 修复 #3（2026-10-12）：同单品路径——括号校验仅对代码文件，非代码 skip（edit_transaction 语义一致）
      const isCodeFile = !!langOf(fp)
      const bracket = isCodeFile ? checkBracketBalance(newContent) : null
      const validation = { bracket: isCodeFile ? (bracket.ok ? { status: 'pass' } : { status: 'fail', errors: [bracket.detail] }) : { status: 'skip', reason: 'non-code file' } }
      if (langOf(fp)) {
        validation.syntax = await validateSyntax(langParser, newContent, extname(fp))
      } else {
        validation.syntax = { status: 'skip', reason: 'non-code file' }
      }
      reconcileBracketWithSyntax(validation)
      validationByFile[fp] = validation
      pipelineStep(pipeline, 'validate', validation.syntax.status === 'pass' && validation.bracket.status === 'pass' ? 'ok' : 'warn', { syntax: validation.syntax.status, bracket: validation.bracket.status, file: fp })
      if (shouldBlockValidation(safety, validation)) {
        const lastW = groupItems[groupItems.length - 1]
        failed = { file: fp, error: buildValidationFailure('VALIDATION_FAILED', `validation failed for ${fp}: syntax/bracket errors detected; refusing write. Pass safety.block_on_validation_error=false to override.`, validation, newContent, lastW?.content ?? lastW?.patch?.new_string), groupResults }
        break
      }

      intendedFiles[fp] = `sha256:${sha256(newContent)}`
      if (dryRun) continue

      // journal + 一次原子写（组 = 文件）
      const journal = createJournal(workspaceDir, fp, absPath, content, { editMode: 'write_symbols', state: 'staged', base_file_hash: groupItems[0]?.base_version?.file?.hash || null, ...(isCreateGroup ? { created: true } : {}), ...(batchId ? { batch_id: batchId } : {}) })
      batchTxnIds.push(journal.txnId)
      if (batchId) updateBatchMarker(workspaceDir, batchId, { txnIds: batchTxnIds })
      updateJournalState(journal.dir, { state: 'staged', new_hash: sha256(newContent) })
      const tmpPath = _uniqueTmp(absPath, 'tmp')
      try {
        // 7（F7）：writeFileSync 在 try 外——异常逃逸跳过 failed 分支与回滚；r8(B5)：唯一 tmp 防 symlink 穿透
        // N3：继承原文件 mode（批量写同样保留权限位）
        _writeTmpPreservingMode(tmpPath, newContent, absPath)
        await renameRetry(tmpPath, absPath)
      } catch (e) {
        try { unlinkSync(tmpPath) } catch {}
        updateJournalState(journal.dir, { state: 'failed', reason: e.message })
        failed = { file: fp, error: { code: 'ATOMIC_WRITE_FAILED', message: e.message, txn_id: journal.txnId } }
        // 审查修复（H1）：best_effort 下写失败记录后继续下一文件（r54(P1) 同型），
        // 旧实现无条件 break → 后续文件静默跳过 + 部分成功被报整体失败
        if (allOrNothing) break
        fileFailures.push(failed); failed = null; continue
      }
      updateJournalState(journal.dir, { state: 'committed', committed_at: new Date().toISOString() })
      // WP04：回读实测（同 writeSymbol）——不一致按写失败处理，触发 all_or_nothing 补偿回滚；
      // MALONG_TEST_READBACK_MISMATCH=1 仅测试环境注入回读不一致
      let readBackContent = null
      try { readBackContent = readFileSync(absPath, 'utf-8') } catch {}
      if (process.env.MALONG_TEST_READBACK_MISMATCH === '1' || readBackContent == null || readBackContent !== newContent) {
        updateJournalState(journal.dir, { state: 'indeterminate', reason: 'readback_mismatch' })
        failed = { file: fp, error: { code: 'READBACK_MISMATCH', message: 'post-write read-back does not match intended content; state indeterminate', txn_id: journal.txnId } }
        if (allOrNothing) break
        fileFailures.push(failed); failed = null; continue
      }
      // r8(E2)：记录写后内容哈希——回滚时比对，防盖掉并行写者的合法改动
      written.push({ absPath, filePath: fp, journalDir: journal.dir, txnId: journal.txnId, groupResults, newHash: sha256(newContent), ...(isCreateGroup ? { created: true } : {}) })
      pipelineStep(pipeline, 'atomic_write', 'ok', { file: fp })
      // Y002-S1：批量写后登记写者（collision_guard classify 识别 write_runtime）
      registerWriter(workspaceDir, fp, 'write_runtime')
      items.push(...groupResults.map(r => ({ ...r, txn_id: journal.txnId })))
    } finally {
      lock.release()
    }
  }
  } catch (e) {
    // r54(P0-9): 未捕获异常（ENOSPC/EMFILE 等）——置 failed 让下方补偿回滚已写文件
    if (!failed) failed = { file: null, error: { code: 'INTERNAL', message: `unexpected error during batch write: ${e?.message || e}` } }
  }

  // ── 回滚（补偿事务，§16.4：非 FS 级原子，兜底靠 journal） ──
  let rolledBack = []
  if (failed && allOrNothing && written.length > 0) {
    pipelineStep(pipeline, 'rollback', 'warn', { files: written.length })
    for (const wf of written) {
      try {
        const backup = join(wf.journalDir, 'backup', basename(wf.filePath))
        if (!existsSync(backup)) continue
        // r8(E2)：回滚前重取锁 + 哈希比对——写后锁已释放，并行写者可能已改文件，盲覆盖会摧毁其合法改动
        const rl = await acquireLock(wf.absPath, 30000)
        // r9(P1)：30s 争用超时 {locked:true} 无 release——旧代码 finally 调 release 抛 TypeError，回滚被静默放弃
        if (rl.locked) {
          pipelineStep(pipeline, 'rollback', 'warn', { reason: `SKIPPED (lock busy 30s): ${wf.filePath}`, file: wf.filePath })
          auditLog(workspaceDir, { event: 'rollback_skipped', file: wf.filePath, reason: 'lock busy' })
          continue
        }
        if (wf.created) {
          // Q2：新建文件回滚 = 删除（写空内容会留垃圾文件）；内容被外部改过则跳过保守不动
          try {
            const cur = readFileSync(wf.absPath, 'utf-8')
            if (wf.newHash && sha256(cur) === wf.newHash) {
              unlinkSync(wf.absPath)
              updateJournalState(wf.journalDir, { state: 'rolled_back', rolled_back_at: new Date().toISOString() })
              rolledBack.push(wf.filePath)
              auditLog(workspaceDir, { event: 'batch_rollback', file: wf.filePath, action: 'created_file_removed', reason: failed.error?.code })
            } else {
              pipelineStep(pipeline, 'rollback', 'warn', { reason: `SKIPPED (file changed since creation): ${wf.filePath}`, file: wf.filePath })
            }
          } finally {
            rl.release()
          }
          continue
        }
        try {
          const cur = readFileSync(wf.absPath, 'utf-8')
          if (wf.newHash && sha256(cur) === wf.newHash) {
            const rbTmp = _uniqueTmp(wf.absPath, 'rollback')
            _writeTmpPreservingMode(rbTmp, readFileSync(backup), wf.absPath)
            await renameRetry(rbTmp, wf.absPath)
            updateJournalState(wf.journalDir, { state: 'rolled_back', rolled_back_at: new Date().toISOString() })
            rolledBack.push(wf.filePath)
            auditLog(workspaceDir, { event: 'batch_rollback', file: wf.filePath, reason: failed.error?.code })
            // 恢复索引（文件已还原）
            if (codeIndexService) {
              try { await codeIndexService.indexFile(wf.absPath, workspaceDir) } catch (e) {
                codeIndexService.markIndexDirty(wf.filePath, 'rollback_pending_reindex')
                // R18：rolled_back + index_pending——回滚后文件内容变了索引也脏，recoverJournals 启动补抽
                try { updateJournalState(wf.journalDir, { index_pending: true, index_pending_reason: e.message }) } catch {}
              }
            }
          } else {
            // 审查修复（M5）：删除无哈希记录的盲覆盖分支——newHash 恒存在（L928 必写），
            // 该分支若未来触发会无比对覆盖并行写者（与 r8(E2) 防覆盖原则矛盾），删除后统一走哈希比对
            pipelineStep(pipeline, 'rollback', 'warn', { reason: `SKIPPED (file changed since write): ${wf.filePath}`, file: wf.filePath })
            auditLog(workspaceDir, { event: 'rollback_skipped', file: wf.filePath, reason: 'concurrent modification' })
          }
        } finally {
          rl.release()
        }
      } catch (e) {
        pipelineStep(pipeline, 'rollback', 'error', { reason: `ROLLBACK_FAILED: ${e.message}`, file: wf.filePath })
        auditLog(workspaceDir, { event: 'rollback_failed', file: wf.filePath, reason: e.message })
      }
    }
  }

  // ── 写后同步重抽（锁外，附录 D；不回滚时每文件一次） ──
  let reindex = null
  if (!failed && !dryRun) {
    const perFile = {}
    for (const wf of written) {
      if (langOf(wf.filePath) && codeIndexService) {
        try {
          const r = await codeIndexService.indexFile(wf.absPath, workspaceDir)
          perFile[wf.filePath] = { status: 'ok', symbols: r?.symbols ?? 0 }
        } catch (e) {
          perFile[wf.filePath] = { status: 'failed', reason: e.message }
          codeIndexService.markIndexDirty(wf.filePath, 'write_pending_reindex')
          // R18：per-file journal 记 index_pending（批量每文件独立 txn）
          try { updateJournalState(wf.journalDir, { index_pending: true, index_pending_reason: e.message }) } catch {}
        }
      } else if (codeIndexService) {
        try {
          const row = codeIndexService.getFileByPath(wf.filePath)
          if (row) {
            // r11(L6)：改用公共方法（旧实现直取 _db 私有字段）
            codeIndexService.updateContentHash(wf.filePath, sha256(readFileSync(wf.absPath, 'utf-8')))
            perFile[wf.filePath] = { status: 'ok', note: 'non-code' }
          }
        } catch (e) {
          // live 审查修复：此分支无 catch——提交后抛出会越过 finishBatchMarker（锁/marker 泄漏 + 误报 failed）
          perFile[wf.filePath] = { status: 'failed', reason: e.message }
          try { codeIndexService.markIndexDirty?.(wf.filePath, 'write_pending_reindex') } catch {}
          try { updateJournalState(wf.journalDir, { index_pending: true, index_pending_reason: e.message }) } catch {}
        }
      }
    }
    reindex = perFile
    pipelineStep(pipeline, 'reindex', 'ok', { files: Object.keys(perFile).length })
  }

  // r54(P1): best_effort 部分失败汇总——有文件写成即算成功，全失败才整体失败
  // live 审查修复：partial_failures 补 item_index（此前只有 all_or_nothing 顶层错误带输入下标）
  const partialFailures = fileFailures.length > 0
    ? fileFailures.map(f => ({ file: f.file, ...(f.itemIndex != null ? { item_index: f.itemIndex } : {}), ...f.error }))
    : undefined
  // live 审查修复：dry-run 不产生 written——预览应完整报告“哪些能写/哪些冲突”，不得误报 ALL_FILES_FAILED
  const success = !failed && (dryRun || fileFailures.length === 0 || written.length > 0)
  const undo = written.length > 0 ? {
    token: written[0].txnId,
    txn_id: written[0].txnId,
    expires_at: new Date(Date.now() + JOURNAL_RETENTION_HOURS * 3600 * 1000).toISOString(),
    retention_hours: JOURNAL_RETENTION_HOURS,
    via: 'edit_transaction(action=undo_commit)',
    // 16-B（专家复验 §5）：批次每文件一个 journal 共享 batch_id——任一 token 的 undo = 整批撤销
    // （先全阻断预检，不部分恢复）；scope=per_file 仅出现在批次标记降级的异常路径（给出逐文件 token）。
    scope: written.length > 1 ? (batchId ? 'batch' : 'per_file') : 'single',
    ...(batchId ? { batch_id: batchId } : {}),
    ...(written.length > 1 && !batchId ? { entries: written.map(wf => ({ file: wf.filePath, txn_id: wf.txnId })), note: 'Batch marker unavailable (degraded non-lock error): undo each entry txn_id separately.' } : {}),
    reverse: written.map(wf => ({ file: wf.filePath, backup: `${JOURNAL_ROOT}/journal/${wf.txnId}/backup/${basename(wf.filePath)}` })),
  } : null

  // r8(F10)：批次正常结束 → 移除标记
  if (batchId) finishBatchMarker(workspaceDir, batchId)

  return {
    success,
    txn_id: written[0]?.txnId || null,
    mode: allOrNothing ? 'all_or_nothing' : 'best_effort',
    dry_run: dryRun || undefined,
    rolled_back: rolledBack.length > 0 ? rolledBack : undefined,
    partial_failures: partialFailures,
    items,
    diff: allDiffs,
    intended_files: Object.keys(intendedFiles).length ? intendedFiles : undefined,
    undo,
    reindex,
    ...(Object.keys(validationByFile).length ? { validation: validationByFile } : {}),
    // Y002-S2：写路径闭环（write_symbols 走 write-journal，同上）
    ...(success && !dryRun ? { next_step: 'workflow: test_bridge(action="run") → debug_runner on failure; if edits went through edit_transaction, also diff_facts(since="last_txn")' } : {}),
    pipeline,
    trace_id,
    duration_ms: Date.now() - t0,
    // 第二轮审查修复：dry-run 下 success 为预览成功（即使 0 个文件可写），ALL_FILES_FAILED 只在真实失败时出现
    error: failed ? { ...failed.error, file: failed.file, itemIndex: failed.itemIndex }
      : (!success && fileFailures.length > 0) ? { code: 'ALL_FILES_FAILED', message: `${fileFailures.length} file(s) failed in best_effort mode`, failures: partialFailures }
      : undefined,
  }
}

function applyBatchItem(lines, range, w, symbol, editMode, boundary, preserveDecorators) {
  if (editMode !== 'patch' && typeof w?.content !== 'string') {
    // 7（F8）：content 缺失时 TypeError 逃逸——批量场景组循环无 catch，回滚段不可达，
    // 已写文件 journal 保持 committed，all_or_nothing 契约被静默破坏
    return { error: { code: 'missing_parameter', message: `content is required for edit_mode=${editMode}` } }
  }
  const scopeContent = symbol && range ? lines.slice(range[0] - 1, range[1]).join('\n') : lines.join('\n')
  if (editMode === 'patch') {
    const oldString = w?.patch?.old_string
    const newString = w?.patch?.new_string ?? ''
    if (typeof oldString !== 'string' || oldString === '') {
      return { error: { code: 'missing_parameter', message: 'patch.old_string is required — each write item needs patch {old_string, new_string}; got ' + (w?.patch === undefined ? 'undefined' : typeof w.patch) } }
    }
    const occurrences = countOccurrences(scopeContent, oldString)
    if (occurrences === 0) {
      if (newString && countOccurrences(scopeContent, newString) > 0) {
        return { lines, status: 'already_applied' }
      }
      return { error: { code: 'PATCH_OLD_STRING_NOT_FOUND', message: `old_string not found in ${symbol ? 'symbol body' : 'file'}` } }
    }
    if (occurrences > 1) {
      return { error: { code: 'PATCH_OLD_STRING_AMBIGUOUS', message: `old_string matches ${occurrences} times`, suggestion: 'Include more surrounding context in old_string.' } }
    }
    const before = lines.slice(0, range ? range[0] - 1 : 0)
    if (symbol && range) {
      // r54(P2): 函数替换器防 newString 内 $&/$$ 等序列被解释
      const body = scopeContent.replace(oldString, () => newString)
      const after = lines.slice(range[1])
      const newLines = [...before, ...body.split('\n'), ...after]
      return { lines: newLines, delta: body.split('\n').length - (range[1] - range[0] + 1), diff: makeSimpleDiff(lines, newLines), status: 'ok' }
    }
    const patched = lines.join('\n').replace(oldString, () => newString)
    const newLines = patched.split('\n')
    // R22-⑦（并发拷打）：批量路径同款防御——缺省 new_string 挂 warning（显式空串 = 合法删除不提示）
    if (w?.patch?.new_string === undefined) return { lines: newLines, delta: newLines.length - lines.length, diff: makeSimpleDiff(lines, newLines), status: 'patched', warning: 'patch.new_string omitted — old_string will be removed (explicit empty string if deletion is intended)' }
    // 9（F1）：文件级 patch 也要回 delta——旧实现无 delta → 不入 appliedEdits → 批内后续符号项
    // offset 计算（line ~674 的 endLine==null 全量偏移分支）拿不到这笔 → range 错位静默改错行。
    return { lines: newLines, delta: newLines.length - lines.length, diff: makeSimpleDiff(lines, newLines), status: 'ok' }
  }
  if (editMode === 'replace_symbol') {
    if (!symbol || !range) return { error: { code: 'missing_parameter', message: 'replace_symbol requires a resolved symbol' } }
    if (boundary === 'body') {
      // 已 applied 幂等（§16.7）
      const curBody = lines.slice(range[0], range[1]).join('\n')
      if (curBody.trim() === (w.content || '').trim()) return { lines, status: 'already_applied' }
      const r = applyBodyEdit(lines, [range[0] + 1, range[1]], w.content, preserveDecorators)
      if (r.error) return { error: r.error }
      return { lines: r.lines, delta: r.lines.length - lines.length, diff: r.diff, status: 'ok' }
    }
    const curFull = lines.slice(range[0] - 1, range[1]).join('\n')
    if (curFull.trim() === (w.content || '').trim()) return { lines, status: 'already_applied' }
    const r = applyReplace(lines, range, w.content)
    return { lines: r.lines, delta: r.lines.length - lines.length, diff: r.diff, status: 'ok' }
  }
  if (editMode === 'insert_after_symbol') {
    if (!symbol || !range) return { error: { code: 'missing_parameter', message: 'insert_after_symbol requires a resolved symbol' } }
    const r = applyInsertAfter(lines, range, w.content)
    return { lines: r.lines, delta: r.lines.length - lines.length, diff: r.diff, status: 'ok' }
  }
  return { error: { code: 'INVALID_INPUT', message: `unknown edit_mode: ${editMode}` } }
}
