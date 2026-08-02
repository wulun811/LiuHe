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
rmSync(TMP, { recursive: true, force: true })
mkdirSync(join(TMP, '.config', 'opencode'), { recursive: true })

// ── readUsageStats：聚合与 success_rate ──
{
  const oldHome = process.env.HOME
  process.env.HOME = TMP
  const usagePath = join(TMP, '.config', 'opencode', 'malong-usage.jsonl')
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
  const usagePath = join(TMP, '.config', 'opencode', 'malong-usage.jsonl')
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
}

rmSync(TMP, { recursive: true, force: true })
console.log(`== test-health-check: ${pass} passed, ${fail} failed ==`)
if (fail > 0) process.exit(1)
