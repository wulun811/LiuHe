import { TransactionStore } from './transaction-store.js'
import { ErrorCodes, makeError, validateFilePath } from '../../error-codes.js'
import { recoverTransactions } from '../../write-journal.js'
import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

export async function handle(args, context) {
  const workspaceDir = args?.workspace_dir
  if (!workspaceDir) {
    return makeError(ErrorCodes.INVALID_INPUT, 'workspace_dir is required', { suggestion: 'Provide the absolute path to the project root directory.' })
  }

  const action = args?.action || ''
  const store = new TransactionStore(workspaceDir)

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
      if (!txnId) return makeError(ErrorCodes.INVALID_INPUT, 'txn_id is required', { suggestion: 'Provide the transaction ID returned by begin()' })
      if (!file) return makeError(ErrorCodes.INVALID_INPUT, 'file is required', { suggestion: 'Provide a file path relative to workspace_dir' })
      if (!edits || !Array.isArray(edits)) return makeError(ErrorCodes.INVALID_INPUT, 'edits array is required', { suggestion: 'Provide an array of edits: [{"old_string": "...", "new_string": "..."}]' })

      const pathCheck = validateFilePath(file)
      if (pathCheck.blocked) {
        return makeError(ErrorCodes.PATH_BLOCKED, pathCheck.detail, { file, reason: pathCheck.reason })
      }

      const backupResult = await store.backupFile(txnId, file)
      if (backupResult?.error_code) return backupResult

      const editResult = await store.applyEdits(txnId, file, edits)
      if (editResult.error_code) {
        // r54(P1): 单次 edit 失败（如 NO_MATCH）不连坐——applyEdits 仅在 applied===0 时返回 error（文件未被修改），
        // 旧实现 rollback 整事务会摧毁已 stage 的其他文件编辑且 txn_id 作废。保留事务，仅报本次失败。
        return { status: 'edit_failed', error_code: editResult.error_code, error: editResult.error, file, message: editResult.message, failed_edits: editResult.failed_edits, txn_id: txnId, suggestion: 'Transaction preserved (other staged edits intact). Fix this edit and retry, or call action=rollback to discard all staged changes.' }
      }

      const res = { status: 'staged', file, edits_applied: editResult.edits_applied }
      if (editResult.validation_warnings?.length) res.validation_warnings = editResult.validation_warnings
      if (editResult.failed_edits?.length) res.failed_edits = editResult.failed_edits

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

      let workItems
      if (fileEdits && Array.isArray(fileEdits) && fileEdits.length > 0) {
        if (!fileEdits.every(fe => fe.file && Array.isArray(fe.edits))) {
          return makeError(ErrorCodes.INVALID_INPUT, 'file_edits must be array of {file, edits}', { suggestion: 'Each item needs file (string) and edits (array)' })
        }
        workItems = fileEdits.map(fe => ({ file: fe.file, edits: fe.edits }))
      } else if (files && Array.isArray(files) && edits && Array.isArray(edits)) {
        workItems = files.map(f => ({ file: f, edits }))
      } else {
        return makeError(ErrorCodes.INVALID_INPUT, 'Provide either file_edits (per-file) or files+edits (broadcast)', { suggestion: 'file_edits: [{file, edits}] for different edits per file; files+edits for same edits across files' })
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

        const backupResult = await store.backupFile(txnId, file)
        if (backupResult?.error_code) {
          results.push({ file, status: 'error', error_code: backupResult.error_code, message: backupResult.message })
          hasError = true
          if (atomic) break
          continue
        }

        const editResult = await store.applyEdits(txnId, file, fe)
        if (editResult.error_code) {
          results.push({ file, status: 'error', error_code: editResult.error_code, message: editResult.message, failed_edits: editResult.failed_edits })
          hasError = true
          if (atomic) break
        } else {
          const r = { file, status: 'success', edits_applied: editResult.edits_applied }
          if (editResult.validation_warnings?.length) r.validation_warnings = editResult.validation_warnings
          if (editResult.failed_edits?.length) r.failed_edits = editResult.failed_edits
          results.push(r)
        }
      }

      if (hasError && atomic) {
        await store.rollback(txnId)
        return {
          status: 'rolled_back',
          reason: 'atomic edit failed',
          files: results,
          summary: { total: workItems.length, success: results.filter(r => r.status === 'success').length, failed: results.filter(r => r.status === 'error').length }
        }
      }

      return {
        status: 'staged',
        files: results,
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
        if (codeIndexService && files.length > 0) {
          const indexPending = []
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
        commitResult.next_step = `workflow: diff_facts(workspace_dir="${args?.workspace_dir}", since="txn:${txnId}") → test_bridge(action="run") → debug_runner on failure`
      }
      return commitResult
    }

    case 'undo_commit': {
      const txnId = args?.txn_id
      if (!txnId) return makeError(ErrorCodes.INVALID_INPUT, 'txn_id is required', { suggestion: 'Provide the transaction ID to undo' })
      return await store.undoCommit(txnId)
    }

    case 'rollback': {
      const txnId = args?.txn_id
      if (!txnId) return makeError(ErrorCodes.INVALID_INPUT, 'txn_id is required', { suggestion: 'Provide the transaction ID to rollback' })
      return await store.rollback(txnId)
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

    default:
      return makeError(ErrorCodes.INVALID_ACTION, 'action must be: begin, edit, edit_multi, commit, undo_commit, rollback, info', { suggestion: 'See docs/P0/02-edit-transaction.md for details' })
  }
}
