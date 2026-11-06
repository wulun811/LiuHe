// test-feedback-recent-order.js — R16B-FB01（专家 2026-10-31 r16b 复审 P1）
//
// 缺陷（真机复现）：readFeedbackFiles() 的拼接顺序是「主文件（新）→ .1 → .2 → .3」，
// 每个文件内部是追加序（旧→新）；listFeedback() 却用 filtered.slice(-limit).reverse()
// 取「最近」。数组尾部其实是最旧的轮转档 → 主文件与 .1 同时存在时，limit=1 返回 OLD，
// 把开发者复盘注意力引向旧摩擦，甚至掩盖最近一次失败。
//
// 本文件把 recent 语义钉成合同（专家修复合同逐条）：
//   ① 跨轮转 limit=1 → 必须是主文件最新条目
//   ② 跨多档 limit=N → 主文件新→旧，再 .1 新→旧，再 .2 …（写入位置口径）
//   ③ 无 timestamp 的条目按写入位置排序（轮转档早于主文件），不得因缺字段丢位
//   ④ 有效时间戳优先于非法/缺失时间戳；非法值与缺失值彼此按位置确定性排序
//   ⑤ 同时间戳：后写入者在前（主文件 > .1；同文件后行 > 前行）
//   ⑥ tool 过滤保持同样的跨档顺序
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) pass++
  else { fail++; console.error('  FAIL:', msg) }
}

const root = join(os.tmpdir(), 'opencode', 'fb-recent-' + process.pid)
try { rmSync(root, { recursive: true, force: true }) } catch {}
mkdirSync(root, { recursive: true })

const saved = { state: process.env.MALONG_STATE_DIR, home: process.env.HOME, sid: process.env.MCP_SESSION_ID }
const { handle } = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-feedback', 'handler.js')).href)

function freshState(tag) {
  const stateDir = join(root, 'state-' + tag)
  const home = join(root, 'home-' + tag)
  mkdirSync(stateDir, { recursive: true })
  mkdirSync(home, { recursive: true })
  process.env.MALONG_STATE_DIR = stateDir
  process.env.HOME = home
  return { main: join(stateDir, 'malong-feedback.jsonl') }
}

function line(entry) {
  return JSON.stringify(entry) + '\n'
}
function add(obj) {
  const e = { tool: 'demo', note: '' }
  for (const k of Object.keys(obj)) e[k] = obj[k]
  return e
}

try {
  // ── ① 跨轮转 limit=1：主文件最新条目胜出（旧实现返回 OLD） ──
  {
    const { main } = freshState('limit1')
    // 主文件 = 轮转后新写入的（最新）；.1 = 被轮转走的（较早）
    writeFileSync(main, line(add({ timestamp: '2026-05-02T00:00:00.000Z', issue: 'LATEST' })))
    writeFileSync(main + '.1', line(add({ timestamp: '2026-05-01T00:00:00.000Z', issue: 'OLD' })))
    const r = await handle({ action: 'list', limit: 1 }, {})
    assert(r.recent.length === 1, '① limit=1 只回 1 条（得 ' + r.recent.length + '）')
    assert(r.recent[0] && r.recent[0].issue === 'LATEST', '① limit=1 必须是最新写入的 LATEST（得 ' + (r.recent[0] && r.recent[0].issue) + '）')
    assert(r.total === 2, '① total 仍含轮转历史（得 ' + r.total + '）')
  }

  // ── ② 多档跨轮转 limit=N：主文件新→旧，再 .1 新→旧，再 .2 ──
  {
    const { main } = freshState('multirot')
    writeFileSync(main, line(add({ timestamp: '2026-05-03T00:00:02.000Z', issue: 'main-new' })) + line(add({ timestamp: '2026-05-03T00:00:01.000Z', issue: 'main-old' })))
    writeFileSync(main + '.1', line(add({ timestamp: '2026-05-02T00:00:02.000Z', issue: 'rot1-new' })) + line(add({ timestamp: '2026-05-02T00:00:01.000Z', issue: 'rot1-old' })))
    writeFileSync(main + '.2', line(add({ timestamp: '2026-05-01T00:00:00.000Z', issue: 'rot2-only' })))
    const r = await handle({ action: 'list', limit: 5 }, {})
    const got = r.recent.map(x => x.issue)
    const want = ['main-new', 'main-old', 'rot1-new', 'rot1-old', 'rot2-only']
    assert(JSON.stringify(got) === JSON.stringify(want), '② 跨档顺序应为 ' + JSON.stringify(want) + '（得 ' + JSON.stringify(got) + '）')
  }

  // ── ③ 缺 timestamp：按写入位置（轮转档早于主文件） ──
  {
    const { main } = freshState('nots')
    writeFileSync(main, line(add({ issue: 'no-ts-main' })))
    writeFileSync(main + '.1', line(add({ issue: 'no-ts-rot1' })))
    writeFileSync(main + '.2', line(add({ issue: 'no-ts-rot2' })))
    const r = await handle({ action: 'list', limit: 2 }, {})
    const got = r.recent.map(x => x.issue)
    assert(JSON.stringify(got) === JSON.stringify(['no-ts-main', 'no-ts-rot1']), '③ 缺时间戳按写入位置倒序（得 ' + JSON.stringify(got) + '）')
  }

  // ── ④ 非法/缺失 timestamp 与有效时间戳并存：有效者优先，非法者不抢位 ──
  {
    const { main } = freshState('badts')
    writeFileSync(main, line(add({ timestamp: 'not-a-date', issue: 'bad-ts-main' })))
    writeFileSync(main + '.1', line(add({ timestamp: '2026-05-01T00:00:00.000Z', issue: 'valid-ts-rot1' })))
    const r = await handle({ action: 'list', limit: 1 }, {})
    assert(r.recent[0] && r.recent[0].issue === 'valid-ts-rot1', '④ 有效时间戳优先于非法值（得 ' + (r.recent[0] && r.recent[0].issue) + '）')
    const all = await handle({ action: 'list', limit: 9 }, {})
    assert(all.recent.length === 2, '④ 两条都在（得 ' + all.recent.length + '）')
  }

  // ── ⑤ 同时间戳：后写入者在前（确定性，不靠文件名猜） ──
  {
    const { main } = freshState('samets')
    const ts = '2026-06-01T00:00:00.000Z'
    writeFileSync(main, line(add({ timestamp: ts, issue: 'main-a' })) + line(add({ timestamp: ts, issue: 'main-b' })))
    writeFileSync(main + '.1', line(add({ timestamp: ts, issue: 'rot1-a' })))
    const r = await handle({ action: 'list', limit: 3 }, {})
    const got = r.recent.map(x => x.issue)
    assert(JSON.stringify(got) === JSON.stringify(['main-b', 'main-a', 'rot1-a']), '⑤ 同时间戳按写入位置倒序（得 ' + JSON.stringify(got) + '）')
    // 重复调用必须稳定（同一份数据两次结果一致）
    const again = await handle({ action: 'list', limit: 3 }, {})
    assert(JSON.stringify(again.recent.map(x => x.issue)) === JSON.stringify(got), '⑤ 同一输入两次结果一致（确定性）')
  }

  // ── ⑥ tool 过滤保持跨档顺序 ──
  {
    const { main } = freshState('filter')
    writeFileSync(main, line(add({ timestamp: '2026-07-02T00:00:00.000Z', tool: 'want', issue: 'want-main' })) + line(add({ timestamp: '2026-07-02T00:00:01.000Z', tool: 'other', issue: 'other-main' })))
    writeFileSync(main + '.1', line(add({ timestamp: '2026-07-01T00:00:00.000Z', tool: 'want', issue: 'want-rot1' })))
    const r = await handle({ action: 'list', tool: 'want', limit: 5 }, {})
    const got = r.recent.map(x => x.issue)
    assert(JSON.stringify(got) === JSON.stringify(['want-main', 'want-rot1']), '⑥ 过滤后仍按新→旧（得 ' + JSON.stringify(got) + '）')
    assert(r.total_filtered === 2 && r.total === 3, '⑥ total_filtered=2 / total=3（得 ' + r.total_filtered + '/' + r.total + '）')
  }
} finally {
  process.env.MALONG_STATE_DIR = saved.state
  process.env.HOME = saved.home
  if (saved.sid === undefined) delete process.env.MCP_SESSION_ID
  else process.env.MCP_SESSION_ID = saved.sid
  try { rmSync(root, { recursive: true, force: true }) } catch {}
}

console.log('\n== test-feedback-recent-order: ' + pass + ' passed, ' + fail + ' failed ==')
if (fail > 0) process.exitCode = 1
