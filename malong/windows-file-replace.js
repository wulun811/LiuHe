// MoveFileEx (Node's rename) replaces a Windows file's DACL with the temp
// file's inherited DACL. ReplaceFile preserves the destination's security
// metadata. Use the inbox .NET wrapper without shell interpolation or a new
// native dependency. Never fall back to rename after a replacement failure.
import { existsSync, statSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
  # Directory FILE_DELETE_CHILD can authorize replacement despite a file-level
  # deny-write ACE. Check the target's write access without truncating it first.
  $share = [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
  $check = [IO.File]::Open($env:MALONG_REPLACE_TARGET, [IO.FileMode]::Open, [IO.FileAccess]::Write, $share)
  $check.Dispose()
  [IO.File]::Replace($env:MALONG_REPLACE_SOURCE, $env:MALONG_REPLACE_TARGET, [System.Management.Automation.Language.NullString]::Value)
} catch {
  $e = $_.Exception
  while ($e.InnerException) { $e = $e.InnerException }
  [Console]::Error.WriteLine(('MALONG_REPLACE_ERROR:{0}:{1}' -f ($e.HResult -band 65535), $e.Message))
  exit 1
}
`
const ENCODED_SCRIPT = Buffer.from(SCRIPT, 'utf16le').toString('base64')

export function replaceFilePreservingMetadataSync(from, to) {
  // New files and directory renames have no existing file metadata to merge.
  if (process.platform !== 'win32' || !existsSync(to) || !statSync(to).isFile()) {
    return renameSync(from, to)
  }
  const executable = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const r = spawnSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', ENCODED_SCRIPT], {
    windowsHide: true, encoding: 'utf8', timeout: 10000,
    env: { ...process.env, MALONG_REPLACE_SOURCE: from, MALONG_REPLACE_TARGET: to },
  })
  if (r.error) throw r.error
  if (r.status !== 0) {
    const nativeCode = Number((r.stderr || '').match(/MALONG_REPLACE_ERROR:(\d+):/)?.[1])
    const error = new Error(`Windows metadata-preserving replacement failed: ${(r.stderr || '').trim() || 'exit ' + r.status}`)
    error.code = nativeCode === 5 ? 'EACCES' : [32, 33].includes(nativeCode) ? 'EBUSY' : 'EIO'
    error.syscall = 'ReplaceFile'
    error.path = from
    error.dest = to
    throw error
  }
}
