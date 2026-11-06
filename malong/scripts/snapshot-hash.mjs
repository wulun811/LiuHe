// snapshot-hash.mjs — 送审包源码快照哈希（确定性、可第三方复算）
//
// 用法：node scripts/snapshot-hash.mjs <pkg-root>
//
// 规则（MANIFEST.md 与本脚本必须一致）：
//   1. 范围：<pkg-root>/code/<tree>/ 下全部文件（递归），tree ∈ {malong, malong-parse}
//   2. 逐文件：<小写 hex sha256 of file bytes> + 两个空格 + code/<tree>/<相对路径>
//   3. 全部行按【整行字节序】排序（等价 LC_ALL=C sort）——两个 tree 放在同一序列里排
//   4. 各行用 \n 连接，最后一行【不加】末尾换行（加了会得到不同的错误值）
//   5. 对整个字节串取 SHA256 = 合并快照 SHA256
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { createHash } from 'node:crypto'

const root = process.argv[2]
if (!root) {
  console.error('usage: node scripts/snapshot-hash.mjs <pkg-root>')
  process.exit(2)
}

const TREES = ['malong', 'malong-parse']
const perTree = {}
const allLines = []

for (const tree of TREES) {
  const base = join(root, 'code', tree)
  const files = []
  try {
    ;(function walk(dir) {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (e.isFile()) files.push(relative(base, p).split('\\').join('/'))
      }
    })(base)
  } catch {
    console.error(`missing tree: code/${tree}`)
    process.exit(2)
  }
  files.sort()
  const lines = files.map((rel) => {
    const digest = createHash('sha256').update(readFileSync(join(base, rel))).digest('hex')
    return `${digest}  code/${tree}/${rel}`
  })
  perTree[tree] = {
    files: files.length,
    sha256: createHash('sha256').update(lines.join('\n')).digest('hex'),
  }
  allLines.push(...lines)
}

allLines.sort()
const combined = createHash('sha256').update(allLines.join('\n')).digest('hex')
const combinedWithNl = createHash('sha256').update(allLines.join('\n') + '\n').digest('hex')

for (const tree of TREES) {
  console.log(`code/${tree}`)
  console.log(`  files  : ${perTree[tree].files}`)
  console.log(`  sha256 : ${perTree[tree].sha256}`)
}
console.log('combined')
console.log(`  files  : ${allLines.length}`)
console.log(`  sha256 : ${combined}`)
console.log(`(with a trailing newline the combined value would be ${combinedWithNl} — that is NOT the snapshot hash)`)
