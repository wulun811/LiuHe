// test-file-arg-doc-ext.js — 文档文件未索引不得再建议 reindex（reindex 永远不会收录）
//
// 2026-11-02 DSH 实测：code_query(mode="outline", file="README.md") 返回 FILE_NOT_INDEXED，
// 建议写着「Call reindex(...)」——而 .md 根本不在 CACHED_EXT 里，重跑多少次 reindex 都不会收录，
// 调用方会照建议白烧一轮。文档的支持路径是 mode=body（直读）和 code_search 的 doc_results。
import { join, dirname } from 'node:path'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  FAIL:', msg) } }

const { resolveFileArg } = await import(pathToFileURL(join(__dirname, '..', 'file-arg.js')).href)

const WS = join(os.tmpdir(), 'opencode', 'file-arg-doc')
try { rmSync(WS, { recursive: true, force: true }) } catch {}
mkdirSync(join(WS, 'docs'), { recursive: true })
writeFileSync(join(WS, 'README.md'), '# 文档\n')
writeFileSync(join(WS, 'docs', 'guide.rst'), 'guide\n')
writeFileSync(join(WS, 'src.js'), 'export const a = 1\n')

// ── ① .md：设计边界，不得再建议 reindex ──
{
  const r = resolveFileArg({ db: null, workspaceDir: WS, file: 'README.md' })
  assert(r.ok === false, `① .md 未索引应返回 ok:false（得 ${JSON.stringify(r.ok)}）`)
  const e = r.error || {}
  assert(e.code === 'FILE_NOT_INDEXED', `① 错误码保持 FILE_NOT_INDEXED（得 ${JSON.stringify(e.code)}）`)
  assert(/mode="body"/.test(e.suggestion || ''), `① 必须给出可执行的读法 mode="body"（得 ${JSON.stringify(e.suggestion)}）`)
  assert(!/Call reindex/.test(e.suggestion || ''), `① 不得再建议 reindex（得 ${JSON.stringify(e.suggestion)}）`)
}

// ── ② .rst 同样走文档分支 ──
{
  const r = resolveFileArg({ db: null, workspaceDir: WS, file: 'docs/guide.rst' })
  assert(/mode="body"/.test((r.error || {}).suggestion || ''), `② .rst 也走文档分支（得 ${JSON.stringify((r.error || {}).suggestion)}）`)
}

// ── ③ 反例：代码文件未索引仍保留 reindex 建议（文档分支不得外溢）──
{
  const r = resolveFileArg({ db: null, workspaceDir: WS, file: 'src.js' })
  assert((r.error || {}).code === 'FILE_NOT_INDEXED', `③ 代码文件未索引（得 ${JSON.stringify((r.error || {}).code)}）`)
  assert(/Call reindex/.test((r.error || {}).suggestion || ''), `③ 代码文件仍保留 reindex 建议（得 ${JSON.stringify((r.error || {}).suggestion)}）`)
}

try { rmSync(WS, { recursive: true, force: true }) } catch {}
console.log(`== test-file-arg-doc-ext: ${pass} passed, ${fail} failed ==`)
process.exit(fail > 0 ? 1 : 0)
