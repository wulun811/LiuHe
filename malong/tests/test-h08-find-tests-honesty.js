// test-h08-find-tests-honesty.js — H08（0.5.14）find_tests 负面结论措辞 + 提及扫描兜底
// 现实（022 对照 003）：outlet-ledger.js 明明有 tests/test-invoke-outlet-crash.js（spawn 路径提及，非 import），
// 却被报 no tests found 并导向「新建测试」。
// 本测试锁定：① 命名/导入都空时做有界提及扫描，给 possible_related（标来源 mention_scan）；
// ② 零命中措辞是「当前方法与范围内没找到候选」+ 不证明不存在，不再无条件建议新建；③ convention 命中不变。
import { join, dirname } from 'node:path'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP = join(os.tmpdir(), 'opencode', 'h08-find-tests')
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
process.env.MALONG_STATE_DIR = join(TMP, 'state')

let pass = 0, fail = 0
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  FAIL:', msg) } }
const imp = (p) => import(pathToFileURL(p).href)

const WS = join(TMP, 'ws')
mkdirSync(join(WS, 'tools'), { recursive: true })
mkdirSync(join(WS, 'tests'), { recursive: true })
mkdirSync(join(WS, 'src'), { recursive: true })
writeFileSync(join(WS, 'tools', 'outlet-ledger.js'), 'export function ledgerRecord() {}\n')
writeFileSync(join(WS, 'tests', 'test-invoke-outlet-crash.js'), "// fixture: spawns tools/outlet-ledger.js by path (no import)\nconsole.log('outlet-ledger')\n")
writeFileSync(join(WS, 'src', 'math.js'), 'export function add(a, b) { return a + b }\n')
writeFileSync(join(WS, 'src', 'math.test.js'), "import { add } from './math.js'\nconsole.log(add(1, 2))\n")
writeFileSync(join(WS, 'src', 'alone.js'), 'export const alone = 1\n')

const ft = await imp(join(__dirname, '..', 'tools', 'tool-find-tests', 'handler.js'))
const ctx = {}

// ── ① 提及扫描兜底：非 import 提及 → possible_related（标来源），不再说没找到 ──
{
  const r = await ft.handle({ workspace_dir: WS, file: 'tools/outlet-ledger.js' }, ctx)
  assert(Array.isArray(r.possible_related) && r.possible_related.some(p => p.path === 'tests/test-invoke-outlet-crash.js' && p.source === 'mention_scan'), '① possible_related 命中提及文件（得 ' + JSON.stringify(r.possible_related) + '）')
  assert(r.search_methods.includes('mention_text_fallback'), '① search_methods 标注提及兜底（得 ' + JSON.stringify(r.search_methods) + '）')
  assert(/possibly-related/.test(r.coverage_hint), '① coverage_hint 措辞为可能相关（得 ' + r.coverage_hint + '）')
  assert(/inspect first/.test(r.next_step), '① next_step 先核对再跑（得 ' + r.next_step + '）')
}

// ── ② 真零命中：诚实措辞，不证明不存在、不无条件导向新建 ──
{
  const r = await ft.handle({ workspace_dir: WS, file: 'src/alone.js' }, ctx)
  assert(!r.possible_related, '② 无提及候选（得 ' + JSON.stringify(r.possible_related) + '）')
  assert(/does NOT prove absence/.test(r.coverage_hint), '② coverage_hint 说明不证明不存在（得 ' + r.coverage_hint + '）')
  assert(/verify manually/.test(r.next_step) && !/Consider creating/.test(r.next_step), '② next_step 不无条件建议新建（得 ' + r.next_step + '）')
}

// ── ③ convention 命中不变（math.js ↔ src/math.test.js）──
{
  const r = await ft.handle({ workspace_dir: WS, file: 'src/math.js' }, ctx)
  assert(r.by_convention.some(c => c.path === 'src/math.test.js' && c.exists === true), '③ convention 命中仍工作（得 ' + JSON.stringify(r.by_convention) + '）')
  assert(/test_bridge/.test(r.next_step), '③ 有命中时 next_step 给可执行运行建议')
}

console.log('\n=== test-h08-find-tests-honesty: ' + pass + ' passed, ' + fail + ' failed ===')
process.exit(fail > 0 ? 1 : 0)
