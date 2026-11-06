// test-file-arg-binary.js — 二进制文件不得报成「还没索引」
//
// 真实缺陷（2026-11-05 自用试用实测）：
//   对一个 .dat（含 0x00 字节）调 code_query(mode=outline) →
//   FILE_NOT_INDEXED + suggestion "Call reindex(...) to index it"
//   但 reindex 永远不会索引二进制文件（解析器只吃代码语言）。
//   用户会照着建议白跑一轮，然后仍然失败。
//
// 判据：二进制/资源扩展名必须报 BINARY_NOT_INDEXABLE，且建议里明确
// 说明「reindex 帮不上忙」——不能给一条走不通的路。
// 同时：文档（.md）和真代码的归因不能被这次改动破坏。

import { resolveFileArg } from '../file-arg.js'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP = join(process.env.TMPDIR || '/tmp', 'opencode', 'test-filearg-bin-' + process.pid)

let pass = 0, fail = 0
const assert = (c, m) => { if (c) pass++; else { fail++; console.error('  FAIL: ' + m) } }

rmSync(TMP, { recursive: true, force: true })
mkdirSync(join(TMP, 'src'), { recursive: true })

const BIN = join(TMP, 'src', 'blob.dat')
writeFileSync(BIN, Buffer.from([0, 1, 2, 255, 0, 0, 7]))
const PNG = join(TMP, 'src', 'logo.png')
writeFileSync(PNG, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
const DOC = join(TMP, 'src', 'guide.md')
writeFileSync(DOC, '# 标题\n')
const CODE = join(TMP, 'src', 'app.js')
writeFileSync(CODE, 'export const a = 1\n')

try {
  // ① .dat → BINARY_NOT_INDEXABLE，且建议里点明 reindex 无用
  {
    const r = resolveFileArg({ db: null, workspaceDir: TMP, file: 'src/blob.dat' })
    assert(r.ok === false, `① 二进制文件不得 ok（得 ${JSON.stringify(r)}）`)
    assert(r.error?.code === 'BINARY_NOT_INDEXABLE',
      `① 必须报 BINARY_NOT_INDEXABLE 而不是 FILE_NOT_INDEXED（得 ${r.error?.code}）`)
    assert(/reindex will NOT help|reindex\s*(会)?\s*帮不上|NOT help/i.test(String(r.error?.suggestion || '')),
      `① 建议必须说明 reindex 帮不上忙（得 ${String(r.error?.suggestion || '').slice(0, 120)}）`)
    assert(!/Call reindex\(workspace_dir/i.test(String(r.error?.suggestion || '')),
      `① 不得再给"Call reindex"这条走不通的路（得 ${String(r.error?.suggestion || '').slice(0, 120)}）`)
  }

  // ② .png 同样
  {
    const r = resolveFileArg({ db: null, workspaceDir: TMP, file: 'src/logo.png' })
    assert(r.error?.code === 'BINARY_NOT_INDEXABLE', `② .png 也必须是 BINARY_NOT_INDEXABLE（得 ${r.error?.code}）`)
  }

  // ③ 文档归因不能被破坏（仍是文档路径，不是二进制）
  {
    const r = resolveFileArg({ db: null, workspaceDir: TMP, file: 'src/guide.md' })
    assert(r.error?.code === 'FILE_NOT_INDEXED', `③ .md 仍走文档归因（得 ${r.error?.code}）`)
    assert(/document/i.test(String(r.error?.suggestion || '')),
      `③ .md 建议必须说明它是文档（得 ${String(r.error?.suggestion || '').slice(0, 100)}）`)
  }

  // ④ 代码文件不得被误判成二进制
  {
    const r = resolveFileArg({ db: null, workspaceDir: TMP, file: 'src/app.js' })
    assert(r.error?.code !== 'BINARY_NOT_INDEXABLE',
      `④ .js 绝不能被判成二进制（得 ${r.error?.code}）`)
  }

  // ⑤ 不存在与路径穿越行为不变
  {
    const r = resolveFileArg({ db: null, workspaceDir: TMP, file: 'src/nope.js' })
    assert(r.error?.code === 'FILE_NOT_FOUND', `⑤ 不存在仍报 FILE_NOT_FOUND（得 ${r.error?.code}）`)
    const t = resolveFileArg({ db: null, workspaceDir: TMP, file: '../../etc/passwd' })
    assert(t.error?.code === 'invalid_input', `⑤ 路径穿越仍被拒（得 ${t.error?.code}）`)
  }
} finally {
  rmSync(TMP, { recursive: true, force: true })
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
