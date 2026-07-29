import { join } from 'node:path'
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
      return res
    }

    case 'edit_multi': {
      const txnId = args?.txn_id
      const files = args?.files
      const edits = args?.edits
      const atomic = args?.atomic !== false
      if (!txnId) return makeError(ErrorCodes.INVALID_INPUT, 'txn_id is required', { suggestion: 'Provide the transaction ID returned by begin()' })
      if (!files || !Array.isArray(files)) return makeError(ErrorCodes.INVALID_INPUT, 'files array is required', { suggestion: 'Provide an array of file paths relative to workspace_dir' })
      if (!edits || !Array.isArray(edits)) return makeError(ErrorCodes.INVALID_INPUT, 'edits array is required', { suggestion: 'Provide an array of edits: [{"old_string": "...", "new_string": "..."}]' })

      const results = []
      let hasError = false

      for (const file of files) {
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

        const editResult = store.applyEdits(txnId, file, edits)
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
          summary: { total: files.length, success: results.filter(r => r.status === 'success').length, failed: results.filter(r => r.status === 'error').length }
        }
      }

      return {
        status: 'staged',
        files: results,
        summary: { total: files.length, success: results.filter(r => r.status === 'success').length, failed: results.filter(r => r.status === 'error').length }
      }
    }

    case 'commit': {
      const txnId = args?.txn_id
      if (!txnId) return makeError(ErrorCodes.INVALID_INPUT, 'txn_id is required', { suggestion: 'Provide the transaction ID to commit' })
      return store.commit(txnId)
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
      return makeError(ErrorCodes.INVALID_ACTION, 'action must be: begin, edit, edit_multi, commit, rollback, info', { suggestion: 'See docs/P0/02-edit-transaction.md for details' })
  }
}
