// Real Windows files/DACLs: edits and undo must preserve explicit security
// metadata; failed replacements must never fall back to a permission reset.
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { replaceFilePreservingMetadataSync } from '../windows-file-replace.js'
import { atomicWrite } from '../path-guard.js'
import { writeSymbol } from '../write-runtime.js'
import { restoreJournal } from '../write-journal.js'

if (process.platform !== 'win32') {
  console.log('NOT_RUN: test-win-file-metadata requires Windows DACL semantics')
  process.exit(0)
}
let pass = 0, fail = 0
const check = (ok, msg) => { if (ok) pass++; else { fail++; console.error('FAIL: ' + msg) } }
const ws = mkdtempSync(join(tmpdir(), 'malong-win-acl-'))
const file = join(ws, '中文 文件.js')
const ps = (script) => {
  const r = spawnSync(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from("$ErrorActionPreference='Stop';" + script, 'utf16le').toString('base64')],
    { windowsHide: true, encoding: 'utf8', timeout: 15000, env: { ...process.env, MALONG_ACL_TEST_FILE: file } })
  if (r.error || r.status !== 0) throw r.error || new Error(r.stderr)
  return r.stdout.trim()
}
const acl = () => {
  // .NET only: a host running PowerShell 7 can pass a PSModulePath that makes
  // Windows PowerShell 5 module auto-loading incompatible (Get-Acl/JSON).
  const lines = ps('$a=[IO.File]::GetAccessControl($env:MALONG_ACL_TEST_FILE); [Console]::WriteLine($a.AreAccessRulesProtected); [Console]::WriteLine($a.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::All))').split(/\r?\n/)
  return { protected: lines[0] === 'True', sddl: lines[1] }
}
try {
  const initial = 'export const value = 1;\r\n'
  writeFileSync(file, initial)
  ps('$a=[IO.File]::GetAccessControl($env:MALONG_ACL_TEST_FILE); $a.SetAccessRuleProtection($true,$true); [IO.File]::SetAccessControl($env:MALONG_ACL_TEST_FILE,$a)')
  const before = acl()
  check(before.protected, 'fixture has a protected DACL')
  writeFileSync(file + '.tmp', 'export const value = 2;\r\n')
  replaceFilePreservingMetadataSync(file + '.tmp', file)
  check(readFileSync(file, 'utf8').includes('value = 2'), 'replacement edits content')
  check(acl().sddl === before.sddl, 'replacement preserves the exact DACL/owner/group')
  check(!existsSync(file + '.tmp'), 'replacement consumes the temporary file')
  atomicWrite(file, initial, { fsync: true, preservePermissions: true })
  check(readFileSync(file, 'utf8') === initial, 'journal-style atomic restore restores bytes')
  check(acl().sddl === before.sddl, 'atomic restore preserves security metadata')
  const result = await writeSymbol({ workspace_dir: ws, locator: { file_path: '中文 文件.js' }, edit_mode: 'patch', patch: { old_string: 'value = 1', new_string: 'value = 3' }, allow_unsafe_no_base: true }, { getWorkspaceDir: w => w })
  check(result.success === true, 'real writeSymbol succeeds')
  check(acl().sddl === before.sddl, 'writeSymbol preserves security metadata')
  const undo = await restoreJournal(ws, result.undo.txn_id)
  check(undo.status === 'undone', 'real journal undo succeeds')
  check(readFileSync(file, 'utf8') === initial, 'undo restores exact CRLF bytes')
  check(acl().sddl === before.sddl, 'undo preserves security metadata')
  chmodSync(file, 0o444)
  writeFileSync(file + '.denied', 'forbidden')
  let rejected = false
  try { replaceFilePreservingMetadataSync(file + '.denied', file) } catch { rejected = true }
  check(rejected, 'readonly replacement is rejected without a rename fallback')
  check(readFileSync(file, 'utf8') === initial, 'readonly rejection preserves bytes')
  chmodSync(file, 0o666)
  check(acl().sddl === before.sddl, 'readonly handling does not reset the DACL')
  ps('$a=[IO.File]::GetAccessControl($env:MALONG_ACL_TEST_FILE); $id=[Security.Principal.WindowsIdentity]::GetCurrent().User; $rule=[Security.AccessControl.FileSystemAccessRule]::new($id,[Security.AccessControl.FileSystemRights]::Write,[Security.AccessControl.AccessControlType]::Deny); $a.AddAccessRule($rule); [IO.File]::SetAccessControl($env:MALONG_ACL_TEST_FILE,$a)')
  const deniedAcl = acl().sddl
  writeFileSync(file + '.acl-denied', 'forbidden')
  let denied = null
  try { replaceFilePreservingMetadataSync(file + '.acl-denied', file) } catch (e) { denied = e }
  check(denied?.code === 'EACCES', 'file deny-write ACE is respected even if parent permits delete-child')
  check(denied?.message.includes('中文 文件.js') && !denied.message.includes('\uFFFD'), 'Chinese permission diagnostics are UTF-8, without replacement characters')
  check(readFileSync(file, 'utf8') === initial, 'deny-write rejection preserves bytes')
  check(acl().sddl === deniedAcl, 'deny-write rejection preserves the exact DACL')
  process.env.MALONG_ACL_TEST_ORIGINAL = before.sddl
  try { ps('$a=[IO.File]::GetAccessControl($env:MALONG_ACL_TEST_FILE); $a.SetSecurityDescriptorSddlForm($env:MALONG_ACL_TEST_ORIGINAL,[Security.AccessControl.AccessControlSections]::Access); [IO.File]::SetAccessControl($env:MALONG_ACL_TEST_FILE,$a)') }
  finally { delete process.env.MALONG_ACL_TEST_ORIGINAL }
  check(acl().sddl === before.sddl, 'test restores the original protected ACL')
} catch (e) { fail++; console.error(e.stack) }
console.log(`=== test-win-file-metadata: ${pass} passed, ${fail} failed ===`)
if (fail) console.error('Evidence kept at ' + ws)
process.exit(fail ? 1 : 0)
