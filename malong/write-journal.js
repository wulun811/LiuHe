// write-journal.js — undo journal + 审计 + crash recovery（附录 D）
// 从 write-runtime.js 拆分（P4 批量后运行时已近千行）
import { join, basename } from 'node:path'
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, renameSync, appendFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

export const JOURNAL_ROOT = '.malong'
const AUDIT_LOG = 'audit.log'

export function createJournal(workspaceDir, filePath, absPath, originalContent, state) {
  const txnId = `txn_${Date.now()}_${randomBytes(4).toString('hex')}`
  const dir = join(workspaceDir, JOURNAL_ROOT, 'journal', txnId)
  mkdirSync(join(dir, 'backup'), { recursive: true })
  writeFileSync(join(dir, 'backup', basename(filePath)), originalContent)
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    txn_id: txnId, file: filePath, edit_mode: state.editMode, created_at: new Date().toISOString(),
  }, null, 2))
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ txn_id: txnId, state: 'created', ...state }, null, 2))
  return { txnId, dir }
}

export function updateJournalState(dir, state) {
  try {
    const cur = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf-8'))
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ ...cur, ...state }, null, 2))
  } catch {}
}

export function auditLog(workspaceDir, entry) {
  try {
    appendFileSync(join(workspaceDir, JOURNAL_ROOT, AUDIT_LOG), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n')
  } catch {}
}

export function recoverJournals(workspaceDir) {
  const root = join(workspaceDir, JOURNAL_ROOT, 'journal')
  if (!existsSync(root)) return []
  const recovered = []
  for (const txnDir of readdirSync(root)) {
    const dir = join(root, txnDir)
    let state = null
    try { state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf-8')) } catch { continue }
    if (state.state === 'committed' || state.state === 'rolled_back') continue
    // created/staged → 回滚（未 rename 则删除，已 rename 则恢复 backup）
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf-8'))
      const absPath = join(workspaceDir, manifest.file)
      const backup = join(dir, 'backup', basename(manifest.file))
      if (state.state === 'staged' && existsSync(backup) && existsSync(absPath)) {
        renameSync(backup, absPath)
      }
      writeFileSync(join(dir, 'state.json'), JSON.stringify({ ...state, state: 'rolled_back', rolled_back_at: new Date().toISOString() }))
      recovered.push({ txn_id: txnDir, file: manifest.file, action: 'rolled_back' })
    } catch (e) {
      writeFileSync(join(dir, 'state.json'), JSON.stringify({ ...state, state: 'failed', reason: e.message }))
      recovered.push({ txn_id: txnDir, file: null, action: 'rollback_failed', reason: e.message })
    }
  }
  return recovered
}
