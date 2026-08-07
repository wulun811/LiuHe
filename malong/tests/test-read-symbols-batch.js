// test-read-symbols-batch.js — 批量 read_symbols 原语（Y002-S5/D3）
// 覆盖：多 locator 批量读取 / 逐条独立失败（不阻断其他）/ 缺 workspace 校验 /
//       batch 标记与 summary 计数 / file 模式批量（无索引降级）
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}
const { handle } = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-read-symbol', 'handler.js')).href)

const ws = join(os.tmpdir(), 'opencode', 'rsb-test-ws')
try { rmSync(ws, { recursive: true, force: true }) } catch {}
mkdirSync(ws, { recursive: true })
writeFileSync(join(ws, 'a.js'), 'function alpha() {\n  return 1\n}\nfunction beta() {\n  return 2\n}\n')
writeFileSync(join(ws, 'b.py'), 'def gamma():\n    return 3\n')

// 无索引环境：file 模式降级（locator 只有 file_path，不带 name → 走 file 模式）
const ctx = {}

// ── ① 批量多文件 file 模式 ──
{
  const r = await handle({
    workspace_dir: ws,
    locators: [
      { file_path: 'a.js' },
      { file_path: 'b.py' },
    ],
  }, ctx)
  assert(r.batch === true, `① batch 标记（得 ${r.batch}）`)
  assert(r.summary?.total === 2 && r.summary?.success === 2 && r.summary?.failed === 0, `① summary 2/2/0（得 ${JSON.stringify(r.summary)}）`)
  assert(Array.isArray(r.symbols) && r.symbols.length === 2, `① symbols 数组 2 条`)
  assert(r.symbols[0].symbol?.text?.includes('alpha'), `① a.js 读到 alpha（得 ${r.symbols[0]?.symbol?.text?.slice(0, 30)}）`)
  assert(r.symbols[1].symbol?.text?.includes('gamma'), `① b.py 读到 gamma（得 ${r.symbols[1]?.symbol?.text?.slice(0, 30)}）`)
}

// ── ② 逐条独立失败：一条 FILE_NOT_FOUND 不阻断其他 ──
{
  const r = await handle({
    workspace_dir: ws,
    locators: [
      { file_path: 'a.js' },
      { file_path: 'missing.js' },
      { file_path: 'b.py' },
    ],
  }, ctx)
  assert(r.summary?.total === 3 && r.summary?.success === 2 && r.summary?.failed === 1, `② summary 3/2/1（得 ${JSON.stringify(r.summary)}）`)
  const missing = r.symbols[1]
  assert(missing.error === 'FILE_NOT_FOUND', `② 缺文件条目 error=FILE_NOT_FOUND（得 ${missing.error}）`)
  assert(r.symbols[0].symbol?.text?.includes('alpha') && r.symbols[2].symbol?.text?.includes('gamma'), `② 成功条目内容完整`)
  assert(r.failed_entries?.length === 1 && r.failed_entries[0].error_code === 'FILE_NOT_FOUND', `② failed_entries 汇总（得 ${JSON.stringify(r.failed_entries)}）`)
}

// ── ③ 参数校验：缺 workspace_dir ──
{
  const r = await handle({ locators: [{ file_path: 'a.js' }] }, ctx)
  assert(r.error === 'missing_parameter', `③ 缺 workspace_dir → missing_parameter（得 ${r.error}）`)
}

// ── ④ 空 locators → 走单条路径（file 缺失报错） ──
{
  const r = await handle({ workspace_dir: ws }, ctx)
  assert(r.error === 'missing_parameter', `④ 无 locators 回落单条 → 缺 locator（得 ${r.error}）`)
}

// ── ⑤ 单条 locator 兼容：与旧行为一致 ──
{
  const r = await handle({ workspace_dir: ws, locator: { file_path: 'a.js' } }, ctx)
  assert(r.symbol?.text?.includes('alpha'), `⑤ 单条路径不受影响（得 ${r.symbol?.text?.slice(0, 30)}）`)
}

// ── ⑥ R22-⑮ 错误 shape 统一 + 目录语义化 ──
{
  mkdirSync(join(ws, 'adir'), { recursive: true })
  const rDir = await handle({ workspace_dir: ws, locator: { file_path: 'adir' } }, ctx)
  assert(rDir.error === 'DIR_AS_FILE' && rDir.code === 'DIR_AS_FILE', `⑥ 目录 → DIR_AS_FILE（得 ${rDir.error}）`)
  const rMiss = await handle({ workspace_dir: ws, locator: { file_path: 'no-such-file.js' } }, ctx)
  assert(rMiss.code === 'FILE_NOT_FOUND', `⑥ FILE_NOT_FOUND 带 code（得 ${rMiss.code}）`)
}

try { rmSync(ws, { recursive: true, force: true }) } catch {}
console.log(`== test-read-symbols-batch: ${pass} passed, ${fail} failed ==`)
if (fail > 0) process.exit(1)
