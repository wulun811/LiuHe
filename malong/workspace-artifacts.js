// workspace-artifacts.js — LH-WO-005A: choose where malong's bookkeeping lives.
//
// Default (both switches off): historical behavior — journal/backups live under the
// business workspace (`.malong/`, `.ai-transactions/`) and `initWorkspace()` writes
// `.git/info/exclude` so git status stays clean.
//
// MALONG_NO_GIT_EXCLUDE=1 (005A): the workspace is read-only from the git-metadata
// point of view. Journal/backups and transaction state move under
// `$MALONG_STATE_DIR/workspace-artifacts/<workspace-hash>/`, so no `.malong/` or
// `.ai-transactions/` directory is created in the business tree.
//
// MALONG_READONLY=1 (005B): writes are rejected before handlers run. We still route
// any state-only bookkeeping to the external root as a defense-in-depth measure so a
// future read-only path can never accidentally create workspace artifacts.
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { getStateDir, noGitExcludeMode, readonlyMode } from './host-config.js'

export const ARTIFACT_ROOT = 'workspace-artifacts'

export function externalWorkspaceArtifacts() {
  return noGitExcludeMode() || readonlyMode()
}

export function artifactWorkspaceRoot(workspaceDir) {
  const ws = resolve(workspaceDir)
  if (!externalWorkspaceArtifacts()) return ws
  const key = createHash('md5').update(ws).digest('hex').slice(0, 12) // malong-ignore: cache-dir name only
  return join(getStateDir(), ARTIFACT_ROOT, key)
}

export function journalRoot(workspaceDir) {
  return join(artifactWorkspaceRoot(workspaceDir), '.malong')
}

export function txnRoot(workspaceDir) {
  return join(artifactWorkspaceRoot(workspaceDir), '.ai-transactions')
}
