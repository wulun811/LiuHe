// git-exclude.js — dogfood-050 P3：把工具产物目录（.malong/、.ai-transactions/）写进 .git/info/exclude，
// 避免污染用户 git status；不改动被跟踪的 .gitignore。best-effort、幂等、兼容 worktree（.git 是文件）。
import { existsSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const EXCLUDE_LINES = ['.malong/', '.ai-transactions/']
const _ensured = new Set()

// dogfood-050：git 目录解析抽为独立导出——transaction-store 判断「git 仓内优先 info/exclude」同源复用，
// 避免双机制（.gitignore vs info/exclude）在 git 仓里制造未跟踪 .gitignore 噪声
export function resolveGitDir(workspaceDir) {
  try {
    const key = resolve(workspaceDir)
    const gitPath = join(key, '.git')
    if (!existsSync(gitPath)) return null
    if (statSync(gitPath).isDirectory()) return gitPath
    const content = readFileSync(gitPath, 'utf-8')
    const m = content.match(/^gitdir:\s*(.+)$/m)
    if (!m) return null
    const gitDir = resolve(key, m[1].trim())
    return existsSync(gitDir) ? gitDir : null
  } catch { return null }
}

export function isGitRepo(workspaceDir) {
  return resolveGitDir(workspaceDir) !== null
}

export function ensureGitExclude(workspaceDir) {
  try {
    const key = resolve(workspaceDir)
    if (_ensured.has(key)) return false
    _ensured.add(key)
    const gitDir = resolveGitDir(key)
    if (!gitDir) return false
    const infoDir = join(gitDir, 'info')
    if (!existsSync(infoDir)) mkdirSync(infoDir, { recursive: true })
    const excludeFile = join(infoDir, 'exclude')
    const cur = existsSync(excludeFile) ? readFileSync(excludeFile, 'utf-8') : ''
    const lines = cur.split(/\r?\n/).map(l => l.trim())
    const missing = EXCLUDE_LINES.filter(e => !lines.includes(e))
    if (missing.length === 0) return false
    const head = cur.length > 0 && !cur.endsWith('\n') ? cur + '\n' : cur
    writeFileSync(excludeFile, head + '# malong artifacts (auto-added)\n' + missing.join('\n') + '\n')
    return true
  } catch { return false }
}
