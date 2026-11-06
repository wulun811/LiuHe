// test-query-actionability.js — F23（2026-11-05 极限风暴）
//
// 真机实测两条“照做就失败”的建议：
//  ① references 无 file 过滤时 next_step 生成 find_tests(file="") —— 空文件参数不可执行；
//  ② callers 的 misuse_warning 教用户 impact_analysis(symbol="add")，但 impact 必填 file，
//     照做直接 missing_parameter。修法：无 file 时不再输出空参数建议；impact 建议带 file。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP = join(os.tmpdir(), 'opencode', 'query-actionability-test')
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
mkdirSync(TMP, { recursive: true })
writeFileSync(join(TMP, 'code-index.db'), '')
process.env.MALONG_STATE_DIR = join(TMP, 'state')

let pass = 0, fail = 0
const assert = (cond, msg) => { if (cond) pass++; else { fail++; console.error('  FAIL:', msg) } }
const imp = (p) => import(pathToFileURL(p).href)
const refs = await imp(join(__dirname, '..', 'tools', 'tool-references', 'handler.js'))
const chain = await imp(join(__dirname, '..', 'tools', 'tool-call-chain', 'handler.js'))
const { sanitizeAdvisory } = await imp(join(__dirname, '..', 'tools', 'tool-code-query', 'handler.js'))

const ctx = {
  getWorkspaceDir: () => TMP,
  codeIndexService: {
    initWorkspace: async () => {},
    getReferences: async () => [{ path: 'src/b.js', kind: 'call', target_name: 'add', line: 4 }],
    getImpactAnalysis: async () => ({
      target_symbol: 'add',
      callers: [{ file: 'src/b.js', line: 4, function: 'total', depth: 1 }],
      callees: [],
      caller_count: { direct: 1, indirect: 0 },
    }),
  },
}

// ── ① references 无 file 过滤：不得产出 file="" 的死建议 ──
{
  const r = await refs.handle({ workspace_dir: TMP, symbol: 'add' }, ctx)
  assert(r.count === 1, '① references 返回 1 条（得 ' + JSON.stringify(r.error || r.count) + '）')
  const ns = String(r.next_step || '')
  assert(!/file=""/.test(ns), '① next_step 不得含空 file（得 ' + JSON.stringify(ns) + '）')
  assert(!ns || /file="[^"]+"/.test(ns), '① next_step 若存在必须带非空 file（得 ' + JSON.stringify(ns) + '）')
}

// ── ①b references 带 file 过滤：next_step 必须带该 file ──
{
  const r = await refs.handle({ workspace_dir: TMP, symbol: 'add', file: 'src/b.js' }, ctx)
  assert(r.count === 1, '①b references(file) 返回 1 条（得 ' + JSON.stringify(r.error || r.count) + '）')
  assert(/file="src\/b\.js"/.test(String(r.next_step || '')), '①b next_step 必须使用真实 file（得 ' + JSON.stringify(r.next_step) + '）')
}

// ── ② callers 的 impact 建议必须带 file，且清洗后仍可执行 ──
{
  const r = await chain.handle({ workspace_dir: TMP, file: 'src/a.js', symbol: 'add' }, ctx)
  const sug = String(r.misuse_warning?.suggestion || '')
  assert(/file="src\/a\.js"/.test(sug), '② misuse_warning 必须带 file（得 ' + JSON.stringify(sug) + '）')
  const clean = sanitizeAdvisory(sug)
  assert(/code_query\(mode='impact'/.test(clean), '② 清洗后应指向 code_query impact（得 ' + JSON.stringify(clean) + '）')
  assert(/file="src\/a\.js"/.test(clean), '② 清洗后仍保留 file（得 ' + JSON.stringify(clean) + '）')
}

try { rmSync(TMP, { recursive: true, force: true }) } catch {}
console.log('== test-query-actionability: ' + pass + ' passed, ' + fail + ' failed ==')
process.exit(fail > 0 ? 1 : 0)
