// test-feedback-list.js — feedback 聚合端（Y001-S5）
// 覆盖：list 聚合 by_tool / tool 过滤 / limit 钳制 / 旧路径回退（0AIT 旧副本数据）/ 空反馈文案
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, appendFileSync, existsSync, rmSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}

const root = join(os.tmpdir(), 'opencode', 'fb-list-test')
try { rmSync(root, { recursive: true, force: true }) } catch {}
const stateDir = join(root, 'state')        // 新路径（MALONG_STATE_DIR）
const legacyHome = join(root, 'home')       // 旧路径家目录（HOME）
mkdirSync(legacyHome, { recursive: true })

const saved = { state: process.env.MALONG_STATE_DIR, home: process.env.HOME }
process.env.MALONG_STATE_DIR = stateDir
process.env.HOME = legacyHome

const { handle } = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-feedback', 'handler.js')).href)

try {
  // ── ① record + list 聚合 ──
  {
    await handle({ tool: 'debug_runner', issue: 'false positive', note: 'exit 0' }, {})
    await handle({ tool: 'debug_runner', issue: 'second issue' }, {})
    await handle({ tool: 'fix_imports', issue: 'multi-line import' }, {})
    const r = await handle({ action: 'list' }, {})
    assert(r.status === 'ok' && r.total === 3, `① total=3（得 ${r.total}）`)
    assert(r.by_tool.debug_runner === 2 && r.by_tool.fix_imports === 1, `① by_tool 聚合（得 ${JSON.stringify(r.by_tool)}）`)
    assert(r.recent.length === 3 && r.recent[0].issue === 'multi-line import', '① recent 最近在前')
  }

  // ── ② tool 过滤 ──
  {
    const r = await handle({ action: 'list', tool: 'fix_imports' }, {})
    assert(r.total_filtered === 1 && r.recent.length === 1, `② 过滤 fix_imports（得 ${r.total_filtered}）`)
  }

  // ── ③ limit 钳制 ──
  {
    const r = await handle({ action: 'list', limit: -5 }, {})
    assert(r.recent.length === 1, `③ limit=-5 钳制 1（得 ${r.recent.length}）`)
    const big = await handle({ action: 'list', limit: 99999 }, {})
    assert(big.recent.length === 3, `③ limit=99999 钳制 500（得 ${big.recent.length}）`)
  }

  // ── ④ 旧路径回退：新路径无数据时读 ~/.config/opencode/（0AIT 旧副本场景） ──
  {
    const legacy = join(legacyHome, '.config', 'opencode')
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, 'malong-feedback.jsonl'), '{"timestamp":"2026-08-01T00:00:00.000Z","tool":"edit_collision_guard","issue":"legacy issue"}\n')
    rmSync(stateDir, { recursive: true, force: true }) // 新路径不存在 → 回退
    const r = await handle({ action: 'list' }, {})
    assert(r.total === 1 && r.by_tool.edit_collision_guard === 1 && r.recent[0].issue === 'legacy issue', `④ 旧路径回退读取（得 ${r.total} ${JSON.stringify(r.by_tool)}）`)
  }

  // ── ⑤ 空反馈文案（隔离 HOME + 新路径均无数据） ──
  {
    const bareHome = join(root, 'bare-home')
    mkdirSync(bareHome, { recursive: true })
    process.env.MALONG_STATE_DIR = join(root, 'bare-state')
    process.env.HOME = bareHome
    const r = await handle({ action: 'list' }, {})
    assert(r.status === 'ok' && r.total === 0 && r.next_step.includes('No feedback'), `⑤ 空反馈文案（得 ${r.total}/${r.next_step.slice(0, 20)}）`)
  }

  // ── ⑥ 双路径聚合：新路径存在时旧路径不再被遮蔽（2026-10-04 修复） ──
  {
    process.env.MALONG_STATE_DIR = stateDir
    process.env.HOME = legacyHome
    await handle({ tool: 'new_tool', issue: 'new-path issue' }, {}) // ④ 已删新路径，这里补 1 条
    const r = await handle({ action: 'list' }, {})
    assert(r.total === 2, `⑥ 新旧路径聚合 total=2（得 ${r.total}）`)
    assert(r.by_tool.edit_collision_guard === 1 && r.by_tool.new_tool === 1, `⑥ 两路径 by_tool 合并（得 ${JSON.stringify(r.by_tool)}）`)
    assert(Array.isArray(r.sources) && r.sources.length === 2, `⑥ sources 列出两路径（得 ${JSON.stringify(r.sources)}）`)
  }

  // ── ⑦ 坏行不静默：计入 skipped_malformed，且不污染 total ──
  {
    appendFileSync(join(stateDir, 'malong-feedback.jsonl'), 'this is not json\n')
    const r = await handle({ action: 'list' }, {})
    assert(r.total === 2 && r.skipped_malformed === 1, `⑦ 坏行计数 total=2 skipped=1（得 ${r.total}/${r.skipped_malformed}）`)
  }

  // ── ⑧ 轮转：主文件超阈值 → 记录前轮转为 .1（此前零测试） ──
  {
    const rotState = join(root, 'rot-state')
    process.env.MALONG_STATE_DIR = rotState
    process.env.HOME = join(root, 'rot-home')
    mkdirSync(rotState, { recursive: true })
    const p = join(rotState, 'malong-feedback.jsonl')
    writeFileSync(p, 'x'.repeat(5 * 1024 * 1024 + 16))
    const rec = await handle({ tool: 'rot_tool', issue: 'after rotation' }, {})
    assert(rec.status === 'recorded' && rec.rotated === true, `⑧ 触发轮转（得 ${rec.status}/${rec.rotated}）`)
    assert(existsSync(p + '.1'), '⑧ 旧主文件轮转为 .1')
    const r = await handle({ action: 'list' }, {})
    assert(r.total === 1 && r.recent[0].issue === 'after rotation', `⑧ 轮转后 list 只见新条目（得 ${r.total}）`)
  }

  // ── ⑨ 轮转失败不静默：返回 rotation_warning（此前 catch {} 全吞） ──
  {
    const rotState = join(root, 'rot-fail-state')
    process.env.MALONG_STATE_DIR = rotState
    mkdirSync(join(rotState, 'malong-feedback.jsonl.4', 'block'), { recursive: true }) // 非空目录 → rmSync 失败
    const p = join(rotState, 'malong-feedback.jsonl')
    writeFileSync(p, 'y'.repeat(5 * 1024 * 1024 + 16))
    const rec = await handle({ tool: 'rot_fail', issue: 'rotation blocked' }, {})
    assert(rec.status === 'recorded' && typeof rec.rotation_warning === 'string', `⑨ 轮转失败透出 warning（得 ${JSON.stringify(rec.rotation_warning)}）`)
  }
} finally {
  process.env.MALONG_STATE_DIR = saved.state
  process.env.HOME = saved.home
  try { rmSync(root, { recursive: true, force: true }) } catch {}
}

console.log(`== test-feedback-list: ${pass} passed, ${fail} failed ==`)
if (fail > 0) process.exit(1)
