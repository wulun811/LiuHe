import { TransactionStore } from './transaction-store.js'
import { ErrorCodes, makeError, validateFilePath } from '../../error-codes.js'
import { recoverTransactions } from '../../write-journal.js'
import { serializeReceipt } from '../../workflow/receipt.js'
import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

export async function handle(args, context) {
  const workspaceDir = args?.workspace_dir
  // 审查修复（M2）：workspace_dir 非字符串 → new TransactionStore 内 join 抛 TypeError 裸崩 MCP
  if (workspaceDir != null && typeof workspaceDir !== 'string') {
    return makeError(ErrorCodes.INVALID_INPUT, 'workspace_dir must be a string', { suggestion: 'Provide the absolute path to the project root directory.' })
  }
  if (!workspaceDir) {
    return makeError(ErrorCodes.INVALID_INPUT, 'workspace_dir is required', { suggestion: 'Provide the absolute path to the project root directory.' })
  }

  const action = args?.action || ''
  const store = new TransactionStore(workspaceDir, { langParser: context?.langParserService, safety: args?.safety })

  // 审查修复（M1）：顶层兜底——唯一无 catch 的写路径，edits=[null] 等异常输入裸崩 MCP
  try {
  switch (action) {
    case 'begin': {
      // R4a：begin 时自愈——崩溃残留的 staged 事务先恢复（幂等）
      // R22-④：补传 codeIndexService——recent/ 下已提交事务的 index_pending 也在此补抽（第 5 处调用点，原漏）
      try { await recoverTransactions(workspaceDir, { codeIndexService: context?.codeIndexService }) } catch {}
      // name 直接拼进 txnId 目录名：仅允许安全字符（`../` 穿越可写 workspace 外文件）
      // R22-②：保留 CJK（合法 POSIX 路径字符），与 store.begin 的 sanitize 统一为替换策略——
      // 旧实现剥中文后残留纯符号（如 "试用-回滚验证" → "-"），调用方拿到的 name 与传入不一致
      const rawName = args?.name || 'unnamed'
      const name = String(rawName).replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '_').replace(/_{2,}/g, '_').slice(0, 60) || 'unnamed'
      const txnId = store.begin(name)
      return { status: 'ok', txnId, name }
    }

    case 'edit': {
      const txnId = args?.txn_id
      const file = args?.file
      const edits = args?.edits
      const create = args?.create === true
      const dryRun = args?.dry_run === true
      // 13-A：dry_run 预览不要求 txn（先验证可匹配性再决定 begin/edit）；其余路径 txn 必填
      if (!txnId && !dryRun) return makeError(ErrorCodes.INVALID_INPUT, 'txn_id is required', { suggestion: 'Provide the transaction ID returned by begin()' })
      if (!file) return makeError(ErrorCodes.INVALID_INPUT, 'file is required', { suggestion: 'Provide a file path relative to workspace_dir' })
      if (dryRun && create) return makeError(ErrorCodes.INVALID_INPUT, 'dry_run applies to edits, not create', { suggestion: 'create writes directly; validate content by creating then rollback if needed' })
      if (!create) {
        if (!edits || !Array.isArray(edits)) return makeError(ErrorCodes.INVALID_INPUT, 'edits array is required', { suggestion: 'Provide an array of edits: [{"old_string": "...", "new_string": "..."}]' })
        // 审查修复（M1）：元素级校验——edits=[null] 会让 applyEdits 的 edit.old_string 抛 TypeError 裸崩 MCP
        if (!edits.every(e => e && typeof e === 'object' && (typeof e.old_string === 'string' || (e.line_span && typeof e.line_span === 'object')))) {
          return makeError(ErrorCodes.INVALID_INPUT, 'each edit needs old_string (string) or line_span (object)', { suggestion: 'edits: [{"old_string":"...","new_string":"..."}] or [{"line_span":{"start_line":2,"end_line":2},"new_lines":[...]}]' })
        }
      } else if (typeof args?.content !== 'string') {
        return makeError(ErrorCodes.INVALID_INPUT, 'content (string) is required when create=true', { suggestion: 'edit_transaction(action="edit", create=true, file="new.js", content="...")' })
      }

      const pathCheck = validateFilePath(file)
      if (pathCheck.blocked) {
        return makeError(ErrorCodes.PATH_BLOCKED, pathCheck.detail, { file, reason: pathCheck.reason })
      }

      // 13-A：dry-run——只读预览（不 ensureActive，避免 committed 续接产生写副作用）
      if (dryRun) {
        return await store.previewEdits(file, edits, { txnId: txnId || null })
      }

      const active = store.ensureActive(txnId)
      if (active.error) return active.error
      const activeTxnId = active.txnId

      // 13-A：事务内新建文件
      if (create) {
        const created = await store.createFile(activeTxnId, file, args.content)
        if (created.error_code) return created
        return { ...created, txn_id: activeTxnId, ...(active.continued_from ? { continued_from: active.continued_from } : {}) }
      }

      const backupResult = await store.backupFile(activeTxnId, file)
      if (backupResult?.error_code) return backupResult

      const editResult = await store.applyEdits(activeTxnId, file, edits)
      if (editResult.error_code) {
        // r54(P1): 单次 edit 失败（如 NO_MATCH）不连坐——applyEdits 仅在 applied===0 时返回 error（文件未被修改），
        // 旧实现 rollback 整事务会摧毁已 stage 的其他文件编辑且 txn_id 作废。保留事务，仅报本次失败。
        const failRes = { status: 'edit_failed', error_code: editResult.error_code, error: editResult.error, file, message: editResult.message, failed_edits: editResult.failed_edits, txn_id: activeTxnId, suggestion: 'Transaction preserved (other staged edits intact). Fix this edit and retry, or call action=rollback to discard all staged changes.' }
        if (editResult.validation) failRes.validation = editResult.validation
        if (editResult.diagnostics) failRes.diagnostics = editResult.diagnostics
        return failRes
      }

      const res = { status: 'staged', file, edits_applied: editResult.edits_applied, txn_id: activeTxnId }
      if (editResult.anchor_checked_lines?.length) res.anchor_checked_lines = editResult.anchor_checked_lines
      if (active.continued_from) res.continued_from = active.continued_from
      if (editResult.validation) res.validation = editResult.validation
      if (editResult.validation_warnings?.length) res.validation_warnings = editResult.validation_warnings
      if (editResult.failed_edits?.length) res.failed_edits = editResult.failed_edits
      // 12-D：非唯一 old_string 回执透传（store 侧已有，handler 白名单漏传 → 静默取首不可见）
      if (editResult.warning) res.warning = editResult.warning
      if (editResult.ambiguous_edits?.length) res.ambiguous_edits = editResult.ambiguous_edits

      const codeIndex = context?.codeIndexService
      if (codeIndex && edits.length > 0) {
        try {
          const syms = (await codeIndex.getSymbols(file)) || []
          const fnSyms = syms.filter(s => ['function', 'method'].includes(s.type))
          const affected = []
          for (const e of edits) {
            for (const sym of fnSyms) {
              if (e.old_string && e.old_string.includes(sym.name) &&
                  /(?:def |function |func |fn |async )\s/.test(e.old_string)) {
                const callers = (await codeIndex.getCallers(sym.name)) || []
                if (callers.length > 0) {
                  affected.push({
                    function: sym.name,
                    caller_count: callers.length,
                    callers: callers.slice(0, 5).map(c => ({ file: c.caller_file })),
                  })
                }
              }
            }
          }
          if (affected.length > 0) {
            res.affected_callers = affected
            const total = affected.reduce((s, a) => s + a.caller_count, 0)
            res.hint = `you modified ${affected.map(a => `'${a.function}'`).join(', ')} — ${total} caller(s) may need updating`
          }
        } catch {}
      }

      return res
    }

    case 'edit_multi': {
      const txnId = args?.txn_id
      const fileEdits = args?.file_edits
      const files = args?.files
      const edits = args?.edits
      const atomic = args?.atomic !== false
      if (!txnId) return makeError(ErrorCodes.INVALID_INPUT, 'txn_id is required', { suggestion: 'Provide the transaction ID returned by begin()' })

      const activeM = store.ensureActive(txnId)
      if (activeM.error) return activeM.error
      const activeTxnId = activeM.txnId

      let workItems
      if (fileEdits && Array.isArray(fileEdits) && fileEdits.length > 0) {
        if (!fileEdits.every(fe => fe && typeof fe === 'object' && typeof fe.file === 'string' && Array.isArray(fe.edits) && fe.edits.every(e => e && typeof e === 'object' && (typeof e.old_string === 'string' || (e.line_span && typeof e.line_span === 'object'))))) {
          return makeError(ErrorCodes.INVALID_INPUT, 'file_edits must be array of {file, edits} with valid edit objects', { suggestion: 'Each edit needs old_string (string) or line_span (object). To create a new file in a transaction use action=edit with create:true (one call per new file); edit_multi does not create files.' })
        }
        workItems = fileEdits.map(fe => ({ file: fe.file, edits: fe.edits }))
      } else if (files && Array.isArray(files) && edits && Array.isArray(edits)) {
        workItems = files.map(f => ({ file: f, edits }))
      } else {
        return makeError(ErrorCodes.INVALID_INPUT, 'Provide either file_edits (per-file) or files+edits (broadcast)', { suggestion: 'file_edits: [{file, edits}] for different edits per file; files+edits for same edits across files' })
      }

      // 13-A：dry_run 预览——逐文件模拟匹配，不落盘/不备份/不 rollback
      if (args?.dry_run === true) {
        const previews = []
        for (const { file, edits: fe } of workItems) {
          const p = await store.previewEdits(file, fe, { txnId: activeTxnId })
          previews.push(p.error_code
            ? { file, status: 'error', error_code: p.error_code, message: p.message, failed_edits: p.failed_edits }
            : { file, status: 'preview', would_apply: p.would_apply, matches: p.matches, failed_edits: p.failed_edits, ambiguous_edits: p.ambiguous_edits, validation: p.validation, would_block: p.would_block })
        }
        return {
          status: 'preview',
          dry_run: true,
          files: previews,
          txn_id: activeTxnId,
          summary: { total: workItems.length, would_apply: previews.filter(p => p.status === 'preview' && p.would_apply > 0).length, failed: previews.filter(p => p.status === 'error' || (p.failed_edits && p.failed_edits.length)).length },
        }
      }

      const results = []
      let hasError = false

      for (const { file, edits: fe } of workItems) {
        const pathCheck = validateFilePath(file)
        if (pathCheck.blocked) {
          results.push({ file, status: 'error', error_code: ErrorCodes.PATH_BLOCKED, message: pathCheck.detail })
          hasError = true
          if (atomic) break
          continue
        }

        const backupResult = await store.backupFile(activeTxnId, file)
        if (backupResult?.error_code) {
          results.push({ file, status: 'error', error_code: backupResult.error_code, message: backupResult.message })
          hasError = true
          if (atomic) break
          continue
        }

        const editResult = await store.applyEdits(activeTxnId, file, fe)
        if (editResult.error_code) {
          const rErr = { file, status: 'error', error_code: editResult.error_code, message: editResult.message, failed_edits: editResult.failed_edits }
          if (editResult.validation) rErr.validation = editResult.validation
          if (editResult.diagnostics) rErr.diagnostics = editResult.diagnostics
          results.push(rErr)
          hasError = true
          if (atomic) break
        } else {
          const r = { file, status: 'success', edits_applied: editResult.edits_applied }
          if (editResult.anchor_checked_lines?.length) r.anchor_checked_lines = editResult.anchor_checked_lines
          if (editResult.validation) r.validation = editResult.validation
          if (editResult.validation_warnings?.length) r.validation_warnings = editResult.validation_warnings
          if (editResult.failed_edits?.length) r.failed_edits = editResult.failed_edits
          if (editResult.warning) r.warning = editResult.warning
          if (editResult.ambiguous_edits?.length) r.ambiguous_edits = editResult.ambiguous_edits
          results.push(r)
        }
      }

      if (hasError && atomic) {
        // 审查修复（M4）：rollback 返回值透传——旧实现丢弃，partial（锁忙/外部修改跳过项）时
        // 用户以为全部还原，实际部分文件未动且事务目录保留
        const rb = await store.rollback(activeTxnId)
        if (rb?.status && rb.status !== 'rolled_back') {
          return { status: rb.status, error_code: rb.error_code, message: rb.message, skipped: rb.skipped, files: results, txn_id: txnId, suggestion: 'Partial rollback: some files not restored (external change / lock busy). Transaction preserved for manual review.' }
        }
        return {
          status: 'rolled_back',
          reason: 'atomic edit failed',
          files: results,
          txn_id: activeTxnId,
          ...(activeM.continued_from ? { continued_from: activeM.continued_from } : {}),
          summary: { total: workItems.length, success: results.filter(r => r.status === 'success').length, failed: results.filter(r => r.status === 'error').length }
        }
      }

      return {
        status: 'staged',
        files: results,
        txn_id: activeTxnId,
        ...(activeM.continued_from ? { continued_from: activeM.continued_from } : {}),
        summary: { total: workItems.length, success: results.filter(r => r.status === 'success').length, failed: results.filter(r => r.status === 'error').length }
      }
    }

    case 'commit': {
      const txnId = args?.txn_id
      if (!txnId) return makeError(ErrorCodes.INVALID_INPUT, 'txn_id is required', { suggestion: 'Provide the transaction ID to commit' })
      const commitResult = await store.commit(txnId)
      if (commitResult && !commitResult.error) {
        // R4b：commit 后逐文件重抽索引（对齐 rename-symbol 已做逻辑）——失败记 warning 提示 reindex
        const files = commitResult.files || []
        const codeIndexService = context?.codeIndexService
        let indexPending = []
        if (codeIndexService && files.length > 0) {
          indexPending = []
          for (const f of files) {
            try {
              const abs = join(workspaceDir, f)
              if (existsSync(abs)) await codeIndexService.indexFile(abs, workspaceDir)
            } catch { indexPending.push(f) }
          }
          if (indexPending.length > 0) {
            commitResult.warning = `${indexPending.length} file(s) index pending: ${indexPending.join(', ')} — run reindex(workspace_dir=...) to refresh`
            // 审核修复（R18 对齐）：失败记 manifest index_pending——recoverTransactions 启动补抽（与 write-runtime 系同模型）
            // R22-④：commit() 已把事务 rename 到 recent/——写顶层恒失败（静默死代码）。必须写 recent/<txnId>/manifest.json
            const manifestPath = join(workspaceDir, '.ai-transactions', 'recent', txnId, 'manifest.json')
            try {
              if (existsSync(manifestPath)) {
                const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
                manifest.index_pending = true
                manifest.index_pending_files = indexPending
                writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
              }
            } catch {}
          }
        }
        // Y002-S2：LLM 工作流闭环——edit → diff_facts → test_bridge → debug_runner
        commitResult.next_step = `workflow: code_check(run=true) to validate the committed change; caller sync via code_query(mode=references|impact); AST diff facts via invoke_capability(name=diff_facts, since="txn:${txnId}"); classic test_bridge/debug_runner also reachable via invoke_capability`
        // WP04：统一 receipt（effect/state_commit 分离；恢复资产=recent backup 目录存在性查实，
        // recent 仅保留最近 3 个 commit，超过即被清理——如实声明而非承诺可撤销）
        commitResult.receipt = serializeReceipt({
          kind: 'txn_commit', operation_id: txnId, request_id: null,
          files: files.map(f => ({ file: f, status: 'committed' })),
          committed: true,
          index_sync: indexPending.length ? { state: 'partial', pending: indexPending, note: 'run reindex to refresh' } : { state: codeIndexService ? 'synced' : 'not_reported' },
          recovery: {
            available: existsSync(join(workspaceDir, '.ai-transactions', 'recent', txnId, 'backup')),
            checked: 'backup_dir_present',
            note: 'undo_commit restores from recent/<txn>/backup; only the last 3 commits are retained',
          },
          txn_id: txnId,
        })
      }
      return commitResult
    }

    case 'undo_commit': {
      const txnId = args?.txn_id
      if (!txnId) return makeError(ErrorCodes.INVALID_INPUT, 'txn_id is required', { suggestion: 'Provide the transaction ID to undo' })
      const ur = await store.undoCommit(txnId)
      if (ur && !ur.error && !ur.error_code && ur.status) {
        // WP04：统一 receipt——撤销本身是写动作；恢复资产是否仍存在按目录查实，不冒充
        ur.receipt = serializeReceipt({
          kind: 'txn_undo', operation_id: txnId, request_id: null,
          files: (ur.files || []).map(f => ({ file: typeof f === 'string' ? f : (f?.file || String(f)), status: ur.status === 'undone_partial' ? 'partially_restored' : 'restored' })),
          committed: true,
          ...(ur.failures ? { partial_failures: ur.failures } : {}),
          recovery: {
            available: existsSync(join(workspaceDir, '.ai-transactions', 'recent', txnId)) || existsSync(join(workspaceDir, '.ai-transactions', txnId)),
            checked: 'txn_dir_present',
            note: 'undo restored from backups; remaining recovery assets verified by directory presence',
          },
          txn_id: txnId,
        })
        // P6（0.5.17 狗粮）+ P2（0.5.18 Windows 复核）：undo 也是写动作——回执必须与实际索引一致。
        // 旧实现只对 existsSync 为真的文件补抽；undo create 是删除，条件为假直接跳过，
        // 索引仍留 files/symbols 行，却因服务有 indexFile 方法回 synced（Windows 两次复现）。
        // 现在分两路：存在 → indexFile；不存在 → removeFile（删除同步）。任一失败进 pending，
        // 只有全部成功才 synced；服务缺失回 not_reported，不再用 unknown/synced 冒充。
        {
          const codeIndexService = context?.codeIndexService
          const hasIndex = typeof codeIndexService?.indexFile === 'function'
          const hasRemove = typeof codeIndexService?.removeFile === 'function'
          const restored = []
          const deleted = []
          for (const f of (ur.files || [])) {
            const rel = typeof f === 'string' ? f : (f?.file || null)
            if (!rel) continue
            if (existsSync(join(workspaceDir, rel))) restored.push(rel)
            else deleted.push(rel)
          }
          if (!hasIndex && !hasRemove) {
            // 根本没有索引服务：未尝试 → not_reported（不冒充没发生过的事）
            ur.receipt.index_sync = { state: 'not_reported', note: 'codeIndex service unavailable in this context; next read will refresh lazily' }
          } else {
            const indexPending = []
            if (hasIndex) {
              for (const f of restored) {
                try { await codeIndexService.indexFile(join(workspaceDir, f), workspaceDir) }
                catch { indexPending.push(f) }
              }
            } else {
              indexPending.push(...restored)
            }
            if (deleted.length > 0) {
              if (!hasRemove) {
                // 服务没有删除出口：不能宣称已同步（旧实现就在这里绿灯）
                indexPending.push(...deleted)
              } else {
                for (const f of deleted) {
                  try {
                    const r = await codeIndexService.removeFile(join(workspaceDir, f), workspaceDir)
                    // not_indexed = 本来就没索引，视为成功；outside_workspace/异常 → 未完成
                    if (r && r.removed === false && r.reason && r.reason !== 'not_indexed') indexPending.push(f)
                  } catch { indexPending.push(f) }
                }
              }
            }
            ur.receipt.index_sync = indexPending.length
              ? { state: 'partial', pending: indexPending, note: 'run reindex to refresh' }
              : { state: 'synced' }
          }
        }
      }
      return ur
    }

    case 'rollback': {
      const txnId = args?.txn_id
      if (!txnId) return makeError(ErrorCodes.INVALID_INPUT, 'txn_id is required', { suggestion: 'Provide the transaction ID to rollback' })
      const rb = await store.rollback(txnId)
      if (rb && !rb.error && !rb.error_code && rb.status) {
        // WP04：统一 receipt——full rollback 消费备份并删事务目录；partial 保留目录供重试（查实）
        const txnDirGone = !existsSync(join(workspaceDir, '.ai-transactions', txnId))
        rb.receipt = serializeReceipt({
          kind: 'txn_rollback', operation_id: txnId, request_id: null,
          files: (rb.skipped || []).map(s => ({ file: s.file, status: `skipped:${s.reason}` })),
          committed: true,
          recovery: {
            available: !txnDirGone,
            checked: 'txn_dir_present',
            note: rb.status === 'rolled_back_partial' ? 'transaction dir preserved for retry (skipped files listed)' : 'backups consumed; transaction dir removed after full rollback',
          },
          txn_id: txnId,
        })
      }
      return rb
    }

    case 'info': {
      const txnId = args?.txn_id
      if (txnId) {
        const info = store.getInfo(txnId)
        if (!info) return makeError(ErrorCodes.TXN_NOT_FOUND, `Transaction not found: ${txnId}`, { txnId })
        return { status: 'ok', transaction: info }
      }
      return { status: 'ok', transactions: store.listTransactions() }
    }

    case 'edit_chunk': {
      const txnId = args?.txn_id
      const file = args?.file
      if (!txnId) return makeError(ErrorCodes.INVALID_INPUT, 'txn_id is required', { suggestion: 'Provide the transaction ID returned by begin()' })
      if (!file) return makeError(ErrorCodes.INVALID_INPUT, 'file is required', { suggestion: 'Provide a file path relative to workspace_dir' })
      const activeC = store.ensureActive(txnId)
      if (activeC.error) return activeC.error
      const r = await store.writeChunk(activeC.txnId, file, args?.seq, args?.lines, args?.total)
      if (r.error_code) return r
      return { ...r, txn_id: activeC.txnId, ...(activeC.continued_from ? { continued_from: activeC.continued_from } : {}) }
    }

    case 'assemble': {
      const txnId = args?.txn_id
      const file = args?.file
      if (!txnId) return makeError(ErrorCodes.INVALID_INPUT, 'txn_id is required', { suggestion: 'Provide the transaction ID returned by begin()' })
      if (!file) return makeError(ErrorCodes.INVALID_INPUT, 'file is required', { suggestion: 'Provide a file path relative to workspace_dir' })
      const activeA = store.ensureActive(txnId)
      if (activeA.error) return activeA.error
      const r = await store.assemble(activeA.txnId, file, { expect_sha: args?.expect_sha })
      if (r.error_code) return r
      // WP04：assemble 是写盘动作（备份登记后落盘）——挂统一 receipt；恢复资产按事务 backup 目录查实
      return { ...r, txn_id: activeA.txnId,
        receipt: serializeReceipt({
          kind: 'txn_assemble', operation_id: activeA.txnId, request_id: null,
          files: [{ file, status: 'assembled', result_file_hash: r.new_hash || null }],
          committed: true,
          index_sync: { state: 'not_reported', note: 'reindex after commit refreshes the index' },
          recovery: {
            available: existsSync(join(workspaceDir, '.ai-transactions', activeA.txnId, 'backup')),
            checked: 'backup_dir_present',
            note: 'assemble registered a per-file backup before writing; rollback restores it',
          },
          txn_id: activeA.txnId,
        }),
        ...(activeA.continued_from ? { continued_from: activeA.continued_from } : {}) }
    }

    default:
      return makeError(ErrorCodes.INVALID_ACTION, 'action must be: begin, edit, edit_multi, edit_chunk, assemble, commit, undo_commit, rollback, info', { suggestion: 'See docs/P0/02-edit-transaction.md for details' })
  }
  } catch (e) {
    return makeError(ErrorCodes.INTERNAL, `edit_transaction failed: ${e.message}`, { suggestion: 'Check arguments; if edits contain invalid entries, validate each {old_string, new_string} pair.' })
  }
}
