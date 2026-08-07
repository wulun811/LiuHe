// test-health-check.js — 健康检查与用量统计（r34-fix 补测）
// 覆盖：readUsageStats 解析/聚合/success_rate 口径（error 不计成功）、runHealthCheck 检查项
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}
const hc = await import(pathToFileURL(join(__dirname, '..', 'health-check.js')).href)

const TMP = join(os.tmpdir(), 'opencode', 'health-check-test')
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
mkdirSync(join(TMP, '.config', 'malong'), { recursive: true })

// ── readUsageStats：聚合与 success_rate ──
{
  const oldHome = process.env.HOME
  process.env.HOME = TMP
  const usagePath = join(TMP, '.config', 'malong', 'malong-usage.jsonl')
  const goodLines = [
    { ts: '2026-08-01T10:00:00Z', tool: 'read_symbol', success: true, status: 'ok', duration_ms: 10, metrics: { reads_saved: 3 } },
    { ts: '2026-08-01T11:00:00Z', tool: 'read_symbol', success: false, status: 'error', error_code: 'X', duration_ms: 5 },
    { ts: '2026-08-01T12:00:00Z', tool: 'edit_batch', success: false, status: 'crash', duration_ms: 20 },
    { ts: '2026-08-02T09:00:00Z', tool: 'read_symbol', success: true, status: 'ok', duration_ms: 15, metrics: { reads_saved: 5 } },
  ]
  writeFileSync(usagePath, goodLines.map(l => JSON.stringify(l)).join('\n') + '\nthis is not json\n')

  const s = hc.readUsageStats()
  assert(s.total_calls === 4, `忽略坏行，统计 4 条（实际 ${s.total_calls}）`)
  assert(s.success_rate === 0.5, `success_rate=2/4=0.5（error 不计成功，实际 ${s.success_rate}）`)
  assert(s.status_breakdown.ok === 2 && s.status_breakdown.error === 1 && s.status_breakdown.crash === 1, '状态分解 ok/error/crash')
  assert(s.total_duration_ms === 50, `总耗时 10+5+20+15=50（实际 ${s.total_duration_ms}）`)
  assert(s.value.reads_saved === 8, `metrics 聚合 reads_saved=3+5（实际 ${s.value.reads_saved}）`)
  assert(s.by_tool.read_symbol.calls === 3 && s.by_tool.read_symbol.ok === 2, '按工具聚合 read_symbol')
  assert(s.by_tool.read_symbol.avg_ms === 10, `avg_ms=(10+5+15)/3=10（实际 ${s.by_tool.read_symbol.avg_ms}）`)
  assert(s.period === '2026-08-01 ~ 2026-08-02', `period 首末日期（实际 ${s.period}）`)

  // 无文件 → null
  rmSync(usagePath, { force: true })
  assert(hc.readUsageStats() === null, '无 usage 文件返回 null')
  process.env.HOME = oldHome
}

// ── readUsageStats 空文件 ──
{
  const oldHome = process.env.HOME
  process.env.HOME = TMP
  const usagePath = join(TMP, '.config', 'malong', 'malong-usage.jsonl')
  writeFileSync(usagePath, '')
  const s = hc.readUsageStats()
  assert(s === null || s.total_calls === 0, '空文件返回 null 或 0 调用')
  process.env.HOME = oldHome
}

// ── runHealthCheck：状态聚合与 FAIL 触发 ok=false ──
{
  const mem = process.memoryUsage()
  const sem = {
    getStatus: () => ({ current: 2, max: 3, queue: [] }),
  }
  const active = new Map([
    ['r1', { name: 'edit_batch', startTime: Date.now() - 120000 }],
    ['r2', { name: 'read_symbol', startTime: Date.now() - 5000 }],
  ])
  const r = await hc.runHealthCheck({
    stateDir: TMP,
    workspacesDir: join(TMP, 'ws'),
    semaphore: sem,
    activeRequests: active,
    log: () => {},
  })
  const names = r.checks.map(c => c.name)
  assert(names.includes('Memory RSS'), '内存检查存在')
  assert(names.includes('Semaphore'), '信号量检查存在')
  assert(names.includes('Active Requests'), '卡死请求检查存在')
  const stuck = r.checks.find(c => c.name === 'Active Requests')
  assert(stuck.status === 'WARN' && stuck.detail.includes('edit_batch'), '>60s 请求标记 WARN 且列出工具')
  assert(names.includes('stateDir writable'), 'stateDir 可写检查')
  assert(r.checks.every(c => c.status), '所有检查都有状态')

  // 死锁检测
  const dead = await hc.runHealthCheck({
    stateDir: TMP, workspacesDir: join(TMP, 'ws'),
    semaphore: { getStatus: () => ({ current: 4, max: 3, queue: [] }) },
    activeRequests: new Map(), log: () => {},
  })
  const semCheck = dead.checks.find(c => c.name === 'Semaphore')
  assert(semCheck.status === 'FAIL', 'current>max 标记死锁 FAIL')

  // R2: 槽位泄漏探针——activeWeight < current → FAIL（weight 感知）
  {
    const leak = await hc.runHealthCheck({
      stateDir: TMP, workspacesDir: join(TMP, 'ws'),
      semaphore: { getStatus: () => ({ current: 2, max: 3, queue: [] }) },
      activeRequests: new Map([['r1', { name: 'read_symbol', startTime: Date.now() }]]),
      log: () => {},
    })
    const lc = leak.checks.find(c => c.name === 'Semaphore')
    assert(lc.status === 'FAIL' && lc.detail.includes('leaked'), `泄漏探针 FAIL（${lc.detail}）`)
  }

  // R2: weight 模型合法并行不误报——activeWeight === current 不触发泄漏
  {
    const ok = await hc.runHealthCheck({
      stateDir: TMP, workspacesDir: join(TMP, 'ws'),
      semaphore: { getStatus: () => ({ current: 3, max: 3, queue: [] }) },
      activeRequests: new Map([['r1', { name: 'reindex', startTime: Date.now(), weight: 3 }]]),
      log: () => {},
    })
    const oc = ok.checks.find(c => c.name === 'Semaphore')
    assert(oc.status === 'PASS', `weight 3 单请求占满 3 槽不误报（${oc.detail}）`)
  }

  // r48: DB integrity 恒 WARN 回归——workspaces 有 db 文件时不得抛 "cannot scan: Database is not defined"
  //（原代码引用未定义变量 Database → ReferenceError 被 catch 吞 → 永假 WARN）
  {
    const wsDir = join(TMP, 'ws-real')
    try { rmSync(wsDir, { recursive: true, force: true }) } catch {}
    mkdirSync(join(wsDir, 'w1'), { recursive: true })
    writeFileSync(join(wsDir, 'w1', 'code-index.db'), 'not a real db')
    const r2 = await hc.runHealthCheck({
      stateDir: TMP, workspacesDir: wsDir, semaphore: sem, activeRequests: active, log: () => {},
    })
    const dbc = r2.checks.find(c => c.name === 'DB integrity')
    assert(dbc && !String(dbc.detail).includes('cannot scan'), `DB integrity 不再恒 WARN cannot scan（得 ${dbc?.status} | ${dbc?.detail}）`)
    try { rmSync(wsDir, { recursive: true, force: true }) } catch {}
  }
}

// ── r10d：单一数据源——legacy（旧路径/通天侧旧版进程）存在也不并入统计（替代旧 Y001 债务3 双路径聚合）──
{
  const oldHome = process.env.HOME
  const dup = join(os.tmpdir(), 'opencode', 'health-check-dup')
  try { rmSync(dup, { recursive: true, force: true }) } catch {}
  mkdirSync(join(dup, '.config', 'malong'), { recursive: true })
  mkdirSync(join(dup, '.config', 'opencode'), { recursive: true })
  process.env.HOME = dup
  const entry = (tool, status, dur) => ({ ts: '2026-08-01T10:00:00Z', tool, success: status === 'ok', status, duration_ms: dur })
  writeFileSync(join(dup, '.config', 'malong', 'malong-usage.jsonl'), [entry('health', 'ok', 8), entry('edit_batch', 'ok', 100)].map(l => JSON.stringify(l)).join('\n') + '\n')
  writeFileSync(join(dup, '.config', 'opencode', 'malong-usage.jsonl'), [entry('read_symbol', 'ok', 10), entry('reindex', 'ok', 3), entry('read_symbol', 'error', 5)].map(l => JSON.stringify(l)).join('\n') + '\n')
  const s = hc.readUsageStats()
  assert(s.total_calls === 2, `只统计新路径 2 条（得 ${s.total_calls}）`)
  assert(s.by_tool.health.calls === 1 && s.by_tool.edit_batch.calls === 1, `by_tool 不含 legacy 工具（得 ${JSON.stringify(Object.keys(s.by_tool))}）`)
  assert(!s.by_tool.read_symbol && !s.by_tool.reindex, 'legacy 数据不混入')
  process.env.HOME = oldHome
  try { rmSync(dup, { recursive: true, force: true }) } catch {}
}

// ── Y002-S0 复盘：大 usage 文件不爆栈（旧实现 `push(...arr)` 对 25 万行 spread
// 触发 Maximum call stack size exceeded 被 catch{} 吞掉——旧路径数据从未进聚合） ──
{
  const oldHome = process.env.HOME
  const big = join(os.tmpdir(), 'opencode', 'health-check-big')
  try { rmSync(big, { recursive: true, force: true }) } catch {}
  mkdirSync(join(big, '.config', 'malong'), { recursive: true })
  mkdirSync(join(big, '.config', 'opencode'), { recursive: true })
  process.env.HOME = big
  writeFileSync(join(big, '.config', 'malong', 'malong-usage.jsonl'), '')
  const n = 150000
  const lines = []
  for (let i = 0; i < n; i++) {
    lines.push(JSON.stringify({ ts: '2026-08-01T10:00:00Z', tool: 'read_symbol', success: true, status: 'ok', duration_ms: 1 }))
  }
  writeFileSync(join(big, '.config', 'malong', 'malong-usage.jsonl'), lines.join('\n') + '\n')
  const s = hc.readUsageStats()
  assert(s !== null && s.total_calls === n, `15 万行新路径不爆栈全量统计（得 ${s?.total_calls}，期望 ${n}）`)
  assert(s.by_tool.read_symbol.calls === n, `by_tool 计数完整（得 ${s?.by_tool?.read_symbol?.calls}）`)
  process.env.HOME = oldHome
  try { rmSync(big, { recursive: true, force: true }) } catch {}
}

try { rmSync(TMP, { recursive: true, force: true }) } catch {}
console.log(`== test-health-check: ${pass} passed, ${fail} failed ==`)
if (fail > 0) process.exit(1)
