// test-patch-parser.js — B13 patch_parser 工具测试
// 覆盖：契约（缺 text）/ SEARCH/REPLACE 解析（标准 + patch 包裹）/
//       插入块 / 应用到文件（精确匹配、fuzzy、no-match 错误）/
//       文件不存在错误 / 纯解析模式
import { join, dirname } from 'node:path'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}

const WS = join(os.tmpdir(), 'opencode', 'b13-pp-ws')
try { rmSync(WS, { recursive: true, force: true }) } catch {}
mkdirSync(WS, { recursive: true })
writeFileSync(join(WS, 'a.js'), 'const x = 1\nconsole.log(x)\n')

const { handle } = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-patch-parser', 'handler.js')).href)
const ctx = { getWorkspaceDir: (d) => d }

// ① 契约：缺 text
{
  const r = await handle({ workspace_dir: WS }, ctx)
  assert(r.error === 'missing_parameter', `① 缺 text → missing_parameter（得 ${r.error}）`)
}
// ② 标准 SEARCH/REPLACE 解析
{
  const text = '<<<<<<< SEARCH\nconst x = 1\n=======\nconst x = 2\n>>>>>>> REPLACE'
  const r = await handle({ workspace_dir: WS, text }, ctx)
  assert(r.block_count === 1, `② 解析 1 块（得 ${r.block_count}）`)
  assert(r.blocks[0].old_string === 'const x = 1', `② old_string 正确（得 ${JSON.stringify(r.blocks[0].old_string)}）`)
  assert(r.blocks[0].new_string === 'const x = 2', `② new_string 正确`)
  assert(r.blocks[0].insert_only === false, `② 非插入块`)
}
// ③ 纯解析模式：不要求文件存在
{
  const r = await handle({ workspace_dir: WS, text: '<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE' }, ctx)
  assert(r.block_count === 1 && !r.file, `③ 纯解析无 file 字段（得 ${JSON.stringify(r.file)}）`)
}
// ④ 应用到文件：精确匹配
{
  const text = '<<<<<<< SEARCH\nconst x = 1\n=======\nconst x = 2\n>>>>>>> REPLACE'
  const r = await handle({ workspace_dir: WS, text, file: 'a.js' }, ctx)
  assert(r.file === 'a.js', `④ 返回 file`)
  assert(r.applied === 1, `④ applied=1（得 ${r.applied}）`)
  assert(r.errors.length === 0, `④ 无错误`)
  assert(r.dry_run === true, `④ dry_run=true（不写盘，写盘由调用方决定）`)
  const orig = await (await import('node:fs/promises')).readFile(join(WS, 'a.js'), 'utf-8')
  assert(orig === 'const x = 1\nconsole.log(x)\n', `④ 文件未被工具修改（得 ${JSON.stringify(orig)}）`)
}
// ⑤ no-match 错误：应用失败但错误列表有值
{
  const text = '<<<<<<< SEARCH\nnonexistent_line_zzz\n=======\nreplaced\n>>>>>>> REPLACE'
  const r = await handle({ workspace_dir: WS, text, file: 'a.js' }, ctx)
  assert(r.applied === 0, `⑤ applied=0（得 ${r.applied}）`)
  assert(r.errors.length === 1 && r.errors[0].message === 'no match found', `⑤ no match 错误（得 ${JSON.stringify(r.errors)}）`)
}
// ⑥ 插入块（search 为空）
{
  const text = '<<<<<<< SEARCH\n\n=======\n// appended\n>>>>>>> REPLACE'
  const r = await handle({ workspace_dir: WS, text }, ctx)
  assert(r.blocks[0].insert_only === true, `⑥ insert_only=true（得 ${r.blocks[0].insert_only}）`)
}
// ⑦ 文件不存在
{
  const text = '<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE'
  const r = await handle({ workspace_dir: WS, text, file: 'nope.js' }, ctx)
  assert(r.error === 'file_not_found', `⑦ file_not_found（得 ${r.error}）`)
}
// ⑧ 无法识别的文本 → 0 块
{
  const r = await handle({ workspace_dir: WS, text: 'just some random prose without patch markers' }, ctx)
  assert(r.block_count === 0, `⑧ 无标记 → 0 块（得 ${r.block_count}）`)
  assert(r.parse_errors.length === 0, `⑧ parse_errors 为空数组`)
  assert(r.note?.includes('no SEARCH/REPLACE markers'), `⑧ note 提示无标记（得 ${r.note}）`)
}
// ⑧b R22-⑦（拷打发现）：未闭合 block 必须显式报错，不得静默丢弃
{
  const r = await handle({ workspace_dir: WS, text: '<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE\n<<<<<<< SEARCH\nc\n=======\nd' }, ctx)
  assert(r.block_count === 1, `⑧b 未闭合丢弃已闭合 block 保留（得 ${r.block_count}）`)
  assert(r.parse_errors.some(e => e.includes('unclosed_block')), `⑧b 未闭合显式标注（得 ${JSON.stringify(r.parse_errors)}）`)
}
{
  const text = '<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE'
  const r = await handle({ workspace_dir: WS, text, file: '../outside.js' }, ctx)
  assert(r.error === 'path_blocked', `⑨ file 逃逸 → path_blocked（得 ${r.error}）`)
}

try { rmSync(WS, { recursive: true, force: true }) } catch {}
console.log(`== test-patch-parser: ${pass} passed, ${fail} failed ==`)
process.exit(fail > 0 ? 1 : 0)
