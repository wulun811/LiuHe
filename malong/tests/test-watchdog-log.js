// test-watchdog-log.js — watchdog 日志必须带可诊断信息（B8）
//
// 背景：两个状态目录的 crash.log 里都有大量这样的行（实测）：
//
//   ~/.local/state/malong-dsh/crash.log
//   [2026-11-01T15:53:13.593Z] WATCHDOG: 1 FAIL checks: Memory RSS
//   [2026-11-01T15:53:43.830Z] WATCHDOG: 1 FAIL checks: Memory RSS     ← 30s 一次，全是同一句
//
// 同时 ~/.config/malong/crash.log 里有数值的那条是：
//   MEMORY WARNING: RSS=530MB (danger threshold=480MB), heap=75MB, active_requests=0
//
// 两条一对比就看出问题：**告警阈值 480MB 那条带了完整数值，800MB FAIL 那条什么数值都没有**。
// 现场只知道"内存超了"，不知道超多少，更分不清堆内/堆外——
// 530MB RSS 配 75MB heap 差 7 倍，而进程是 --max-old-space-size=512 启动的，
// 那个参数对这种堆外超限完全无效。诊断日志没有数值等于没有日志。
//
// 另外两件事同源：
//   ① 内存 FAIL 时的 GC 自救分支要求 `global.gc`，但进程没带 --expose-gc → 恒为 undefined，
//      **该分支从未执行过**，且旧实现静默跳过（现场像是"试过 GC 但没用"）。
//   ② restart 额度（3 次）耗尽后彻底静默，只剩 30s 一行的 FAIL，
//      分不清"还在尝试"与"已放弃"。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  FAIL:', msg) } }
const imp = (p) => import(pathToFileURL(join(__dirname, '..', p)).href)

const wl = await imp('watchdog-log.js')

console.log('== ① FAIL 行必须带 detail 数值 ==')
{
  const checks = [{ name: 'Memory RSS', status: 'FAIL', detail: '901MB > 800MB threshold' }]
  const line = wl.formatFailChecks(checks)
  assert(/Memory RSS/.test(line), `应含检查项名（得 ${line}）`)
  assert(/901MB/.test(line), `必须含实际数值——这正是旧实现丢掉的（得 ${line}）`)
  assert(!/^Memory RSS$/.test(line), '不得只输出检查项名')
}

console.log('== ② 多个 FAIL 项都要带 detail，不能只带第一个 ==')
{
  const checks = [
    { name: 'Memory RSS', status: 'FAIL', detail: '901MB > 800MB threshold' },
    { name: 'Semaphore', status: 'FAIL', detail: 'current=3 max=3 queue=7 (deadlock suspected)' },
  ]
  const line = wl.formatFailChecks(checks)
  assert(/901MB/.test(line) && /deadlock suspected/.test(line),
    `两个 FAIL 项的 detail 都要出现（得 ${line}）`)
  assert(/,\s/.test(line), '多项之间应有分隔')
}

console.log('== ③ detail 缺失时不得输出 undefined（要退回 status）==')
{
  const line = wl.formatFailChecks([{ name: 'Weird', status: 'FAIL' }])
  assert(!/undefined/.test(line), `不得出现 undefined（得 ${line}）`)
  assert(/Weird/.test(line), `仍应含检查项名（得 ${line}）`)
}

console.log('== ④ 空输入不炸 ==')
{
  assert(wl.formatFailChecks([]) === '', '空数组 → 空串')
  assert(wl.formatFailChecks(null) === '', 'null → 空串')
}

console.log('== ⑤ 无 --expose-gc 时必须说明"自救不可用"，不能静默 ==')
{
  const n = wl.gcUnavailableNotice()
  assert(/--expose-gc/.test(n), `必须点名缺的启动参数（得 ${n}）`)
  assert(/unavailable/.test(n), '必须说明自救不可用（不是"试过了"）')
  assert(/restart/i.test(n), '必须给出可操作处置（重启进程）')
  assert(/off-heap/i.test(n), '必须说明这类超限是堆外——GC 本来救不了')
}

console.log('== ⑥ 额度耗尽要明确"已放弃"，且每小时最多一次 ==')
{
  const n = wl.restartExhaustedNotice(3, 3)
  assert(/3\/3/.test(n), `必须报额度用尽比例（得 ${n}）`)
  assert(/exhausted|abandoned/.test(n), '必须明确已放弃自救')
  assert(/host must restart/i.test(n), '必须说明需要宿主重启')

  // 额度未耗尽 → 不发。注意必须用**超过间隔**的时间差，否则"额度判断"和"间隔判断"
  // 同时为假，测不出额度判断是否存在（第一次写的就是这个假测试：now-last=1000 时
  // 去掉 used<max 的守卫也照样返回 false）。
  assert(wl.shouldNoticeExhausted(3_600_001, 0, 2, 3) === false,
    '额度未耗尽时不得发（即使已超过间隔）')
  assert(wl.shouldNoticeExhausted(9_999_999, 0, 0, 3) === false,
    '一次都没用过时不得报"额度耗尽"')
  // 刚发过 → 不发
  assert(wl.shouldNoticeExhausted(1000, 500, 3, 3) === false, '间隔不足时不得发')
  // 超过 1 小时 → 发
  assert(wl.shouldNoticeExhausted(3_600_001, 0, 3, 3) === true, '超过 1 小时应发')
}

console.log('== ⑦ 额度耗尽通知不得占用 lastAutoRestart（两条分支不得耦合）==')
{
  // 这是真实风险：内存 FAIL 与信号量 FAIL 共用 lastAutoRestart，
  // 若耗尽通知也写它，会把信号量分支的 5 分钟窗口顺带推开。
  // 判据：shouldNoticeExhausted 是纯函数，只读传参，不碰外部状态。
  const a = wl.shouldNoticeExhausted(3_600_001, 0, 3, 3)
  const b = wl.shouldNoticeExhausted(3_600_001, 0, 3, 3)
  assert(a === b, '同一输入必须同一输出（纯函数）')
  // 且签名里必须是独立的时间戳参数，不接受 lastAutoRestart 语义
  assert(wl.shouldNoticeExhausted.length >= 4, '必须收 4 个以上参数（now/last/used/max）')
}

console.log('== ⑧ 内存软告警：三处阈值都要写出来，并点明堆外主导 ==')
{
  // 实测值：RSS=571MB 配 heap=74MB（~/.config/malong/crash.log 2026-10-22）
  const line = wl.formatMemoryWarning({ rssMB: 571, heapMB: 74, activeRequests: 0 })
  assert(/RSS=571MB/.test(line), `必须含实际 RSS（得 ${line}）`)
  assert(/heap=74MB/.test(line), `必须含实际 heap（得 ${line}）`)
  // 三处阈值：不写全，现场不知道离 FAIL 还有多远（旧实现只说 480）
  assert(/480/.test(line), `必须含软阈值 480（得 ${line}）`)
  assert(/WARN=600|600/.test(line), `必须含 WARN 阈值 600（得 ${line}）`)
  assert(/FAIL=800|800/.test(line), `必须含 FAIL 阈值 800（得 ${line}）`)
  // 堆外占比：571-74=497，占 87% → 必须点明 GC 无效
  assert(/off-heap/.test(line), `必须点明堆外占用（得 ${line}）`)
  assert(/will not help|not help/i.test(line),
    `堆外主导时必须说明 GC/heap-limit 无效（得 ${line}）`)
}

console.log('== ⑨ 堆内主导时不得误报"GC 无效" ==')
{
  // heap=300 / rss=520 → 堆外 220，不到一半 → 不该说 GC 无效
  const line = wl.formatMemoryWarning({ rssMB: 520, heapMB: 300, activeRequests: 2 })
  assert(!/will not help/i.test(line),
    `堆内占比高时不应说 GC 无效（得 ${line}）`)
  assert(/active_requests=2/.test(line), '应带上并发请求数')
}

console.log('== ⑩ off-heap 不得算出负数（heap > rss 的异常采样）==')
{
  const line = wl.formatMemoryWarning({ rssMB: 100, heapMB: 200, activeRequests: 0 })
  assert(!/off-heap≈-/.test(line), `不得出现负的 off-heap（得 ${line}）`)
}

console.log('== ⑪ 三处阈值必须同源（不得各自写死）==')
{
  // 旧状况：mcp-server 写 480，health-check 写 600/800，日志里看起来像两套规则。
  // 现在集中到 MEMORY_THRESHOLDS，任何一处改都必须同时改它。
  const T = wl.MEMORY_THRESHOLDS
  assert(T && typeof T === 'object', 'MEMORY_THRESHOLDS 必须导出')
  assert(T.softMB === 480, `softMB 应为 480（得 ${T?.softMB}）`)
  assert(T.warnMB === 600, `warnMB 应为 600（得 ${T?.warnMB}）`)
  assert(T.failMB === 800, `failMB 应为 800（得 ${T?.failMB}）`)
  assert(T.softMB < T.warnMB && T.warnMB < T.failMB,
    '阈值必须严格递增（soft < warn < fail）')
  // 冻结：防止运行时被改
  assert(Object.isFrozen(T), 'MEMORY_THRESHOLDS 必须冻结')

  // health-check 必须引用同一处，而不是自己写死数字
  const fs = await import('node:fs')
  const hcSrc = fs.readFileSync(join(__dirname, '..', 'health-check.js'), 'utf-8')
  assert(/MEMORY_THRESHOLDS\.failMB/.test(hcSrc),
    'health-check 的 FAIL 判定必须引用 MEMORY_THRESHOLDS.failMB')
  assert(/MEMORY_THRESHOLDS\.warnMB/.test(hcSrc),
    'health-check 的 WARN 判定必须引用 MEMORY_THRESHOLDS.warnMB')
  assert(!/rssMB > 800/.test(hcSrc), 'health-check 不得再写死 800')
  assert(!/rssMB > 600/.test(hcSrc), 'health-check 不得再写死 600')

  // ── 内存监控必须与 --expose-gc 解耦 ──
  // 真实影响：dsh-bridge 只用 --max-old-space-size=512 启动（无 --expose-gc），
  // 旧实现把 setInterval 套在 `if (typeof global.gc === 'function')` 里，
  // 于是那种部署里 480MB 软告警一次都不会出现
  // （实测 ~/.local/state/malong-dsh/crash.log: MEMORY WARNING 0 次、expose-gc 0 次），
  // 内存从 480 涨到 800 之间完全没有信号。
  // Windows 复核（2026-11-06）：检出的是 CRLF，字面 `\n` 的 indexOf 恒 -1；先归一化行尾。
  const srvSrc = fs.readFileSync(join(__dirname, '..', 'mcp-server.js'), 'utf-8').replace(/\r\n/g, '\n')
  // 找到 setInterval 内存监控那段，确认它不在 gc 守卫的块内
  const idxGcIf = srvSrc.indexOf("if (typeof global.gc === 'function') {\n    safeLog('[mcp] --expose-gc detected")
  const idxInterval = srvSrc.indexOf('// 内存监控与 GC 解耦')
  assert(idxGcIf > 0, `应能找到 gc 判断块（得 ${idxGcIf}）`)
  assert(idxInterval > idxGcIf,
    `内存监控必须在 gc 判断块**之后**、同层级（得 gc@${idxGcIf} / monitor@${idxInterval}）`)
  // gc 块必须独立闭合（后面紧跟 else 分支），不能把监控吞进去
  assert(/if \(typeof global\.gc === 'function'\) \{\s*safeLog\('\[mcp\] --expose-gc detected[\s\S]{0,400}?\} else \{/.test(srvSrc),
    'gc 判断必须写成 if/else 且只包 safeLog，不包 setInterval')
  assert(/if \(typeof global\.gc === 'function'\) global\.gc\(\)/.test(srvSrc),
    '监控循环内部仍应在有 gc 时调用 gc()（保留原功能）')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
