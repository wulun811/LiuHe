import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, statSync, readdirSync, renameSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { ErrorCodes, makeError, validateFilePath, findClosestMatch } from '../../error-codes.js'

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
    const pathCheck = validateFilePath(fileRel)
    if (pathCheck.blocked) {
      return makeError(ErrorCodes.PATH_BLOCKED, pathCheck.detail, { file: fileRel, reason: pathCheck.reason })
    }

    const manifest = this._readManifest(txnId)
    if (manifest.files[fileRel]) return

    const srcPath = join(this.projectRoot, fileRel)
    if (!existsSync(srcPath)) {
      return makeError(ErrorCodes.FILE_NOT_FOUND, `File does not exist: ${fileRel}`, { file: fileRel })
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
    const pathCheck = validateFilePath(fileRel)
    if (pathCheck.blocked) {
      return makeError(ErrorCodes.PATH_BLOCKED, pathCheck.detail, { file: fileRel, reason: pathCheck.reason })
    }

    const absPath = join(this.projectRoot, fileRel)
    if (!existsSync(absPath)) {
      return makeError(ErrorCodes.FILE_NOT_FOUND, `File does not exist: ${fileRel}`, { file: fileRel })
    }

    const content = readFileSync(absPath, 'utf-8')
    let result = content
    let applied = 0
    const failedEdits = []

    for (let i = 0; i < edits.length; i++) {
      const edit = edits[i]
      const oldStr = edit.old_string
      const newStr = edit.new_string ?? ''
      if (!oldStr) continue

      if (edit.replace_all) {
        const replaced = result.replaceAll(oldStr, newStr)
        if (replaced !== result) {
          applied++
          result = replaced
        } else {
          const failed = { index: i, old_string: oldStr, reason: 'not_found', error_code: ErrorCodes.OLD_STRING_NOT_FOUND }
          const closest = findClosestMatch(result, oldStr)
          if (closest) failed.closest_match = closest
          failedEdits.push(failed)
        }
      } else {
        const idx = result.indexOf(oldStr)
        if (idx === -1) {
          const failed = { index: i, old_string: oldStr, reason: 'not_found', error_code: ErrorCodes.OLD_STRING_NOT_FOUND }
          const closest = findClosestMatch(result, oldStr)
          if (closest) failed.closest_match = closest
          failedEdits.push(failed)
          continue
        }
        result = result.slice(0, idx) + newStr + result.slice(idx + oldStr.length)
        applied++
      }
    }

    if (applied === 0 && failedEdits.length > 0) {
      return makeError(ErrorCodes.NO_MATCH, 'No edits matched in file', { file: fileRel, failed_edits: failedEdits })
    }

    const validationWarnings = checkBracketBalance(result)

    writeFileSync(absPath, result, 'utf-8')
    const res = { status: 'staged', file: fileRel, edits_applied: applied }
    if (failedEdits.length > 0) {
      res.failed_edits = failedEdits
      res.warning = `${failedEdits.length} edit(s) did not match`
    }
    if (validationWarnings.length > 0) {
      res.validation_warnings = validationWarnings
    }
    return res
  }

  commit(txnId) {
    const txnPath = this._txnPath(txnId)
    if (!existsSync(txnPath)) {
      return makeError(ErrorCodes.TXN_NOT_FOUND, `Transaction not found: ${txnId}`, { txnId })
    }
    const manifest = this._readManifest(txnId)
    rmSync(txnPath, { recursive: true, force: true })
    return { status: 'committed', files_changed: Object.keys(manifest.files).length }
  }

  rollback(txnId) {
    const txnPath = this._txnPath(txnId)
    if (!existsSync(txnPath)) {
      return makeError(ErrorCodes.TXN_NOT_FOUND, `Transaction not found: ${txnId}`, { txnId })
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

function checkBracketBalance(content) {
  const warnings = []
  const pairs = { ')': '(', ']': '[', '}': '{' }
  const opens = new Set(['(', '[', '{'])
  const stack = []
  let inString = null
  let inLineComment = false
  let inBlockComment = false

  for (let i = 0; i < content.length; i++) {
    const ch = content[i]
    const next = content[i + 1]

    if (inLineComment) {
      if (ch === '\n') inLineComment = false
      continue
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') { inBlockComment = false; i++ }
      continue
    }
    if (inString) {
      if (ch === '\\') { i++; continue }
      if (ch === inString) inString = null
      continue
    }

    if (ch === '/' && next === '/') { inLineComment = true; continue }
    if (ch === '/' && next === '*') { inBlockComment = true; i++; continue }
    if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue }
    if (ch === '#') { inLineComment = true; continue }

    if (opens.has(ch)) {
      stack.push({ char: ch, line: content.slice(0, i).split('\n').length })
    } else if (pairs[ch]) {
      if (stack.length === 0) {
        warnings.push({ type: 'bracket_imbalance', bracket: ch, detail: `extra closing "${ch}"` })
      } else {
        const top = stack.pop()
        if (top.char !== pairs[ch]) {
          warnings.push({ type: 'bracket_mismatch', detail: `"${top.char}" at line ${top.line} closed by "${ch}"` })
        }
      }
    }
  }

  for (const unclosed of stack) {
    warnings.push({ type: 'bracket_imbalance', bracket: unclosed.char, detail: `unclosed "${unclosed.char}" opened at line ${unclosed.line}` })
  }

  return warnings
}
