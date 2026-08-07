// test-feedback-list.js — feedback 聚合端（Y001-S5）
// 覆盖：list 聚合 by_tool / tool 过滤 / limit 钳制 / 旧路径回退（0AIT 旧副本数据）/ 空反馈文案
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}

const root = join(os.tmpdir(), 'opencode', 'fb-list-test')
rmSync(root, { recursive: true, force: true })
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
} finally {
  process.env.MALONG_STATE_DIR = saved.state
  process.env.HOME = saved.home
  rmSync(root, { recursive: true, force: true })
}

console.log(`== test-feedback-list: ${pass} passed, ${fail} failed ==`)
if (fail > 0) process.exit(1)
