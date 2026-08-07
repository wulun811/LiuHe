// migrate-usage-data.js — r10：一次性数据迁移——旧路径（~/.config/opencode，r37 前状态目录）的
// usage / edit-batch-stats 存量合并到新路径（~/.config/malong），迁移后旧文件备份为 .pre-migrate-<date>。
// 之后所有写者（新版 mcp-server）只写新路径，health 统计单一数据源。
// 用法：node scripts/migrate-usage-data.js [--dry-run]
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFileSync, appendFileSync, existsSync, renameSync } from 'node:fs'

const HOME = process.env.HOME || homedir()
const NEW = join(HOME, '.config', 'malong')
const LEGACY = join(HOME, '.config', 'opencode')
const DRY = process.argv.includes('--dry-run')
const STAMP = new Date().toISOString().slice(0, 10)

function migrate(name, { filterStress }) {
  const src = join(LEGACY, name)
  const dst = join(NEW, name)
  if (!existsSync(src)) return { name, skipped: 'no legacy file' }
  const raw = readFileSync(src, 'utf-8').split('\n').filter(Boolean)
  let kept = 0, dropped = 0, tokens = 0
  const out = []
  for (const l of raw) {
    let e = null
    try { e = JSON.parse(l) } catch { dropped++; continue }
    if (filterStress && typeof e.error_code === 'string' && e.error_code.includes('stress-fixture')) { dropped++; continue }
    kept++
    if (e.estimated_tokens_saved) tokens += e.estimated_tokens_saved
    out.push(l)
  }
  if (DRY) {
    console.log(`[dry-run] ${name}: src=${raw.length} lines -> dst=${out.length} (+${kept}, drop ${dropped} stress/invalid), tokens_saved=${tokens}`)
    return
  }
  const existing = existsSync(dst) ? readFileSync(dst, 'utf-8').trim().split('\n').filter(Boolean).length : 0
  appendFileSync(dst, (existsSync(dst) && readFileSync(dst, 'utf-8').length > 0 && !readFileSync(dst, 'utf-8').endsWith('\n') ? '\n' : '') + out.join('\n') + (out.length ? '\n' : ''))
  renameSync(src, `${src}.pre-migrate-${STAMP}`)
  console.log(`migrated ${name}: legacy ${raw.length} -> appended ${kept} (dropped ${dropped}), dst now ${existing + kept} lines, tokens_saved=${tokens}`)
}

console.log(DRY ? '== DRY RUN ==' : '== migrate legacy usage data ==')
migrate('malong-usage.jsonl', { filterStress: true })
migrate('edit-batch-stats.jsonl', { filterStress: false })
console.log('done.')
