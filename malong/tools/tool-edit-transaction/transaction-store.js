import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, statSync, readdirSync, renameSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

const LARGE_FILE_BYTES = 100 * 1024 * 1024

export class TransactionStore {
  constructor(projectRoot) {
    this.projectRoot = projectRoot
    this.txnRoot = join(projectRoot, '.ai-transactions')
    if (!existsSync(this.txnRoot)) {
      mkdirSync(this.txnRoot, { recursive: true })
    }
  }

  begin(name) {
    const txnId = `${name}-${randomUUID().split('-')[0]}`
    const txnPath = this._txnPath(txnId)
    const tmpPath = txnPath + '.tmp'
    mkdirSync(join(tmpPath, 'backup'), { recursive: true })
    writeFileSync(join(tmpPath, 'manifest.json'), JSON.stringify({
      name,
      txnId,
      created: Date.now(),
      files: {}
    }, null, 2))
    renameSync(tmpPath, txnPath)
    this._ensureGitignore()
    return txnId
  }

  backupFile(txnId, fileRel) {
    const manifest = this._readManifest(txnId)
    if (manifest.files[fileRel]) return

    const srcPath = join(this.projectRoot, fileRel)
    if (!existsSync(srcPath)) {
      return { error: 'file_not_found', file: fileRel }
    }

    const stat = statSync(srcPath)
    if (stat.size > LARGE_FILE_BYTES) {
      manifest.files[fileRel] = { skipped: true, size: stat.size, hash: this._fastHash(srcPath) }
      this._writeManifest(txnId, manifest)
      return { skipped: true, size: stat.size }
    }

    const backupName = fileRel.replace(/[/\\]/g, '__')
    const backupPath = join(this._txnPath(txnId), 'backup', backupName)
    copyFileSync(srcPath, backupPath)
    manifest.files[fileRel] = { backupName, size: stat.size }
    this._writeManifest(txnId, manifest)
    return { backedUp: true }
  }

  applyEdits(txnId, fileRel, edits) {
    const absPath = join(this.projectRoot, fileRel)
    if (!existsSync(absPath)) {
      return { error: 'file_not_found', file: fileRel, message: `File does not exist: ${fileRel}` }
    }

    const content = readFileSync(absPath, 'utf-8')
    let result = content
    let applied = 0

    for (const edit of edits) {
      const oldStr = edit.old_string
      const newStr = edit.new_string ?? ''
      if (!oldStr) continue

      if (edit.replace_all) {
        const replaced = result.replaceAll(oldStr, newStr)
        if (replaced !== result) applied++
        result = replaced
      } else {
        const idx = result.indexOf(oldStr)
        if (idx === -1) continue
        result = result.slice(0, idx) + newStr + result.slice(idx + oldStr.length)
        applied++
      }
    }

    if (applied === 0) {
      return { error: 'no_match', file: fileRel, message: 'No edits matched in file' }
    }

    writeFileSync(absPath, result, 'utf-8')
    return { status: 'staged', file: fileRel, edits_applied: applied }
  }

  commit(txnId) {
    const txnPath = this._txnPath(txnId)
    if (!existsSync(txnPath)) {
      return { error: 'transaction_not_found', txnId }
    }
    const manifest = this._readManifest(txnId)
    rmSync(txnPath, { recursive: true, force: true })
    return { status: 'committed', files_changed: Object.keys(manifest.files).length }
  }

  rollback(txnId) {
    const txnPath = this._txnPath(txnId)
    if (!existsSync(txnPath)) {
      return { error: 'transaction_not_found', txnId }
    }
    const manifest = this._readManifest(txnId)
    const backupDir = join(txnPath, 'backup')

    for (const [fileRel, meta] of Object.entries(manifest.files)) {
      if (meta.skipped) continue
      const backupPath = join(backupDir, meta.backupName)
      const destPath = join(this.projectRoot, fileRel)
      if (existsSync(backupPath)) {
        copyFileSync(backupPath, destPath)
      }
    }

    rmSync(txnPath, { recursive: true, force: true })
    return { status: 'rolled_back', files_restored: Object.keys(manifest.files).length }
  }

  getInfo(txnId) {
    try {
      return this._readManifest(txnId)
    } catch {
      return null
    }
  }

  listTransactions() {
    if (!existsSync(this.txnRoot)) return []
    return readdirSync(this.txnRoot, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => {
        try {
          return this._readManifest(d.name)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  }

  _txnPath(txnId) {
    return join(this.txnRoot, txnId)
  }

  _readManifest(txnId) {
    const path = join(this._txnPath(txnId), 'manifest.json')
    return JSON.parse(readFileSync(path, 'utf-8'))
  }

  _writeManifest(txnId, data) {
    writeFileSync(join(this._txnPath(txnId), 'manifest.json'), JSON.stringify(data, null, 2))
  }

  _ensureGitignore() {
    const gitignorePath = join(this.projectRoot, '.gitignore')
    const entry = '.ai-transactions/'
    if (existsSync(gitignorePath)) {
      const content = readFileSync(gitignorePath, 'utf-8')
      if (content.includes(entry)) return
      writeFileSync(gitignorePath, content + (content.endsWith('\n') ? '' : '\n') + entry + '\n')
    } else {
      writeFileSync(gitignorePath, entry + '\n')
    }
  }

  _fastHash(filePath) {
    const content = readFileSync(filePath, 'utf-8')
    let hash = 0
    for (let i = 0; i < content.length; i++) {
      hash = ((hash << 5) - hash) + content.charCodeAt(i)
      hash |= 0
    }
    return hash
  }
}
