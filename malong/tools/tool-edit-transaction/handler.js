import { TransactionStore } from './transaction-store.js'
import { ErrorCodes, makeError, validateFilePath } from '../../error-codes.js'

export async function handle(args, context) {
  const workspaceDir = args?.workspace_dir
  if (!workspaceDir) {
    return makeError(ErrorCodes.INVALID_INPUT, 'workspace_dir is required', { suggestion: 'Provide the absolute path to the project root directory.' })
  }

  const action = args?.action || ''
  const store = new TransactionStore(workspaceDir)

  switch (action) {
    case 'begin': {
      const name = args?.name || 'unnamed'
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

      const backupResult = store.backupFile(txnId, file)
      if (backupResult?.error_code) return backupResult

      const editResult = store.applyEdits(txnId, file, edits)
      if (editResult.error_code) {
        store.rollback(txnId)
        return { status: 'rolled_back', error_code: editResult.error_code, error: editResult.error, file, message: editResult.message, failed_edits: editResult.failed_edits }
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

        const backupResult = store.backupFile(txnId, file)
        if (backupResult?.error_code) {
          results.push({ file, status: 'error', error_code: backupResult.error_code, message: backupResult.message })
          hasError = true
          if (atomic) break
          continue
        }

        const editResult = store.applyEdits(txnId, file, fe)
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
        store.rollback(txnId)
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
      const commitResult = store.commit(txnId)
      if (commitResult && !commitResult.error) {
        commitResult.next_step = 'Verify changes: test_bridge(action="run")'
      }
      return commitResult
    }

    case 'undo_commit': {
      const txnId = args?.txn_id
      if (!txnId) return makeError(ErrorCodes.INVALID_INPUT, 'txn_id is required', { suggestion: 'Provide the transaction ID to undo' })
      return store.undoCommit(txnId)
    }

    case 'rollback': {
      const txnId = args?.txn_id
      if (!txnId) return makeError(ErrorCodes.INVALID_INPUT, 'txn_id is required', { suggestion: 'Provide the transaction ID to rollback' })
      return store.rollback(txnId)
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
