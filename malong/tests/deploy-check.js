// deploy-check.js — 部署一致性检查（本地仓库 ↔ 0AIT 插件副本）
// 输出两类差异：
//   MISSING_IN_TARGET：本地有、部署无 → 需 rsync（代码漂移）
//   ORPHAN_IN_TARGET ：部署有、本地无 → 未注册孤儿/历史遗留（人工判定）
// 忽略：数据/缓存/运行态文件（data、node_modules、.malong、*.db*、__pycache__、*.pyc、.git）

import { readdirSync, existsSync, statSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC = dirname(__dirname) // tests/ 的父 = malong/ 根
const TARGET = process.argv[2] || '/home/chen/1q/0AIT/plugins/malong'

const IGNORE = new Set(['data', 'node_modules', '.malong', '.git', '__pycache__'])
const IGNORE_EXT = ['.db', '.db-journal', '.pyc', '.sock']

function isIgnored(name) {
  return IGNORE.has(name) || IGNORE_EXT.some(e => name.endsWith(e))
}

function walk(dir, base) {
  const out = []
  let entries = []
  try { entries = readdirSync(dir) } catch { return out }
  for (const name of entries) {
    if (isIgnored(name)) continue
    const p = join(dir, name)
    const rel = relative(base, p)
    if (statSync(p).isDirectory()) out.push(...walk(p, base))
    else out.push(rel)
  }
  return out
}

const srcFiles = new Set(walk(SRC, SRC))
const tgtFiles = new Set(walk(TARGET, TARGET))
const missing = [...srcFiles].filter(f => !tgtFiles.has(f))
const orphan = [...tgtFiles].filter(f => !srcFiles.has(f))
const differ = [...srcFiles].filter(f => {
  if (!tgtFiles.has(f)) return false
  try {
    const a = readFileSync(join(SRC, f))
    const b = readFileSync(join(TARGET, f))
    return !a.equals(b)
  } catch { return true }
})

console.log(`部署一致性：本地 ${srcFiles.size} 文件 vs ${TARGET.split('/').pop()} ${tgtFiles.size} 文件\n`)
if (missing.length === 0) console.log('✓ 无漏同步文件')
else {
  console.log(`✗ MISSING_IN_TARGET（${missing.length}）→ 需 rsync：`)
  missing.forEach(f => console.log(`  ${f}`))
}
if (differ.length === 0) console.log('✓ 无内容差异文件')
else {
  console.log(`✗ CONTENT_DIFF（${differ.length}）→ 需 rsync：`)
  differ.slice(0, 20).forEach(f => console.log(`  ${f}`))
  if (differ.length > 20) console.log(`  ... 等 ${differ.length - 20} 个`)
}
if (orphan.length === 0) console.log('✓ 无孤儿文件')
else {
  console.log(`⚠ ORPHAN_IN_TARGET（${orphan.length}）→ 未注册/历史遗留，人工判定：`)
  orphan.forEach(f => console.log(`  ${f}`))
}
const hasIssue = missing.length > 0 || differ.length > 0
console.log(`\n${hasIssue ? '结论：部署漂移，需 rsync + 重启 MCP' : '结论：一致'}`)
process.exit(hasIssue ? 1 : 0)
