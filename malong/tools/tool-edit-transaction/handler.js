import { join } from 'node:path'
import { TransactionStore } from './transaction-store.js'

export async function handle(args, context) {
  const workspaceDir = args?.workspace_dir
  if (!workspaceDir) {
    return { error: 'missing_parameter', message: 'workspace_dir is required', suggestion: 'Provide the absolute path to the project root directory.' }
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
      if (!txnId) return { error: 'missing_parameter', message: 'txn_id is required' }
      if (!file) return { error: 'missing_parameter', message: 'file is required' }
      if (!edits || !Array.isArray(edits)) return { error: 'missing_parameter', message: 'edits array is required' }

      const backupResult = store.backupFile(txnId, file)
      if (backupResult?.error) return backupResult

      const editResult = store.applyEdits(txnId, file, edits)
      if (editResult.error) {
        store.rollback(txnId)
        return { status: 'rolled_back', error: editResult.error, file, message: editResult.message }
      }

      return { status: 'staged', file, edits_applied: editResult.edits_applied }
    }

    case 'edit_multi': {
      const txnId = args?.txn_id
      const files = args?.files
      const edits = args?.edits
      const atomic = args?.atomic !== false
      if (!txnId) return { error: 'missing_parameter', message: 'txn_id is required' }
      if (!files || !Array.isArray(files)) return { error: 'missing_parameter', message: 'files array is required' }
      if (!edits || !Array.isArray(edits)) return { error: 'missing_parameter', message: 'edits array is required' }

      const results = []
      let hasError = false

      for (const file of files) {
        const backupResult = store.backupFile(txnId, file)
        if (backupResult?.error) {
          results.push({ file, status: 'error', message: backupResult.message })
          hasError = true
          if (atomic) break
          continue
        }

        const editResult = store.applyEdits(txnId, file, edits)
        if (editResult.error) {
          results.push({ file, status: 'error', message: editResult.message })
          hasError = true
          if (atomic) break
        } else {
          results.push({ file, status: 'success', edits_applied: editResult.edits_applied })
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
      if (!txnId) return { error: 'missing_parameter', message: 'txn_id is required' }
      return store.commit(txnId)
    }

    case 'rollback': {
      const txnId = args?.txn_id
      if (!txnId) return { error: 'missing_parameter', message: 'txn_id is required' }
      return store.rollback(txnId)
    }

    case 'info': {
      const txnId = args?.txn_id
      if (txnId) {
        const info = store.getInfo(txnId)
        return info ? { status: 'ok', transaction: info } : { error: 'transaction_not_found', txnId }
      }
      return { status: 'ok', transactions: store.listTransactions() }
    }

    default:
      return { error: 'invalid_action', message: 'action must be: begin, edit, edit_multi, commit, rollback, info', suggestion: 'See docs/P0/02-edit-transaction.md for details' }
  }
}
