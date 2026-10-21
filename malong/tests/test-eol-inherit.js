// test-eol-inherit.js — 15-B：line_span/new_lines 行尾继承（CRLF 文件不静默产生混合行尾）
// 覆盖：CRLF 替换/插入/new_string 变体/删除 / LF 保持 LF / 混合文件按锚点行继承 / 预置 \r 归一 / 回滚字节一致
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import crypto from 'node:crypto'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) { if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) } }
const { handle } = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-edit-transaction', 'handler.js')).href)

const TMP = join(os.tmpdir(), 'opencode', 'eol-inherit-test')
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
mkdirSync(TMP, { recursive: true })
const ctx = { codeIndexService: null }
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')
let n = 0
const mkCase = (name, content) => {
  const ws = join(TMP, 'ws' + (++n) + '-' + name)
  mkdirSync(ws, { recursive: true })
  writeFileSync(join(ws, 'f.txt'), content)
  return ws
}
const read = (ws) => readFileSync(join(ws, 'f.txt'), 'utf-8')

// ① CRLF 替换（专家 621f6f8 §4.2 反例）：新行必须全为 CRLF，不许混合
{
  const orig = 'alpha\r\nbeta\r\ngamma\r\n'
  const ws = mkCase('crlf-replace', orig)
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'e1' }, ctx)
  const r = await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 'f.txt', edits: [{ line_span: { start_line: 2, end_line: 2, expect_sha: sha(orig) }, new_lines: ['BETA', 'MORE'] }] }, ctx)
  assert(r.status === 'staged' && r.edits_applied === 1, '① 编辑成功（得 ' + JSON.stringify({ s: r.status, n: r.edits_applied }) + '）')
  assert(read(ws) === 'alpha\r\nBETA\r\nMORE\r\ngamma\r\n', '① 新行继承 CRLF（得 ' + JSON.stringify(read(ws)) + '）')
  await handle({ workspace_dir: ws, action: 'rollback', txn_id: b.txnId }, ctx)
  assert(read(ws) === orig, '① 回滚字节还原')
}

// ② CRLF 纯插入（end_line 缺省）：插入行同 CRLF
{
  const orig = 'alpha\r\nbeta\r\ngamma\r\n'
  const ws = mkCase('crlf-insert', orig)
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'e2' }, ctx)
  const r = await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 'f.txt', edits: [{ line_span: { start_line: 2 }, new_lines: ['NEW'] }] }, ctx)
  assert(r.status === 'staged', '② 插入成功（得 ' + r.status + '）')
  assert(read(ws) === 'alpha\r\nNEW\r\nbeta\r\ngamma\r\n', '② 插入行 CRLF（得 ' + JSON.stringify(read(ws)) + '）')
}

// ③ new_string 变体（\n 分隔）在 CRLF 文件同样继承
{
  const orig = 'alpha\r\nbeta\r\ngamma\r\n'
  const ws = mkCase('crlf-newstring', orig)
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'e3' }, ctx)
  const r = await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 'f.txt', edits: [{ line_span: { start_line: 2, end_line: 2 }, new_string: 'BETA\nMORE' }] }, ctx)
  assert(r.status === 'staged', '③ new_string 成功（得 ' + r.status + '）')
  assert(read(ws) === 'alpha\r\nBETA\r\nMORE\r\ngamma\r\n', '③ new_string 继承 CRLF（得 ' + JSON.stringify(read(ws)) + '）')
}

// ④ 预置 \r 归一：CRLF 文件传入带 \r 的 new_lines 不产生双 \r
{
  const orig = 'alpha\r\nbeta\r\n'
  const ws = mkCase('crlf-normalize', orig)
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'e4' }, ctx)
  const r = await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 'f.txt', edits: [{ line_span: { start_line: 2, end_line: 2 }, new_lines: ['X\r', 'Y'] }] }, ctx)
  assert(r.status === 'staged', '④ 归一编辑成功（得 ' + r.status + '）')
  assert(read(ws) === 'alpha\r\nX\r\nY\r\n', '④ 无双 \r（得 ' + JSON.stringify(read(ws)) + '）')
}

// ⑤ 删除行：CRLF 保留
{
  const orig = 'alpha\r\nbeta\r\ngamma\r\n'
  const ws = mkCase('crlf-delete', orig)
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'e5' }, ctx)
  const r = await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 'f.txt', edits: [{ line_span: { start_line: 2, end_line: 2 }, new_lines: [] }] }, ctx)
  assert(r.status === 'staged', '⑤ 删除成功（得 ' + r.status + '）')
  assert(read(ws) === 'alpha\r\ngamma\r\n', '⑤ 删除后仍全 CRLF（得 ' + JSON.stringify(read(ws)) + '）')
}

// ⑥ LF 文件保持 LF
{
  const orig = 'alpha\nbeta\ngamma\n'
  const ws = mkCase('lf', orig)
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'e6' }, ctx)
  const r = await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 'f.txt', edits: [{ line_span: { start_line: 2, end_line: 2 }, new_lines: ['BETA', 'MORE'] }] }, ctx)
  assert(r.status === 'staged', '⑥ LF 编辑成功（得 ' + r.status + '）')
  assert(read(ws) === 'alpha\nBETA\nMORE\ngamma\n', '⑥ LF 保持 LF（得 ' + JSON.stringify(read(ws)) + '）')
}

// ⑦ 混合行尾文件：按锚点行继承（第 1 行 CRLF → CRLF；第 2 行 LF → LF），未触碰行不改
{
  const orig = 'a\r\nb\nc\n'
  const ws = mkCase('mixed-1', orig)
  const b = await handle({ workspace_dir: ws, action: 'begin', name: 'e7' }, ctx)
  const r = await handle({ workspace_dir: ws, action: 'edit', txn_id: b.txnId, file: 'f.txt', edits: [{ line_span: { start_line: 1, end_line: 1 }, new_lines: ['A1', 'A2'] }] }, ctx)
  assert(r.status === 'staged', '⑦ CRLF 锚点编辑成功（得 ' + r.status + '）')
  assert(read(ws) === 'A1\r\nA2\r\nb\nc\n', '⑦ 锚点 CRLF 继承且未触碰行不动（得 ' + JSON.stringify(read(ws)) + '）')
  const ws2 = mkCase('mixed-2', orig)
  const b2 = await handle({ workspace_dir: ws2, action: 'begin', name: 'e8' }, ctx)
  const r2 = await handle({ workspace_dir: ws2, action: 'edit', txn_id: b2.txnId, file: 'f.txt', edits: [{ line_span: { start_line: 2, end_line: 2 }, new_lines: ['B1', 'B2'] }] }, ctx)
  assert(r2.status === 'staged', '⑦ LF 锚点编辑成功（得 ' + r2.status + '）')
  assert(read(ws2) === 'a\r\nB1\nB2\nc\n', '⑦ 锚点 LF 继承且未触碰行不动（得 ' + JSON.stringify(read(ws2)) + '）')
}

console.log('test-eol-inherit: ' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)