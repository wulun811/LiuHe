// watchdog-log.js — watchdog 日志格式化（纯函数，可单测）
//
// B8 背景：`~/.config/malong/crash.log` 与 `~/.local/state/malong-dsh/crash.log`
// 里出现过大量这样的行：
//
//   WATCHDOG: 1 FAIL checks: Memory RSS
//
// 只有检查项名字，**没有 detail 里的数值**。现场看到"内存超了"，
// 但不知道超多少，也分不清是堆涨还是堆外涨——实测同一时刻
// RSS 530MB / heap 75MB 差 7 倍，而进程以 --max-old-space-size=512 启动，
// 堆上限参数对这种堆外超限完全无效。诊断日志没有数值等于没有日志。
//
// 抽成独立模块的原因：这些逻辑原本内嵌在 mcp-server.js 的 setInterval 里，
// 而 mcp-server.js 没有 main 守卫（import 即启动服务器），无法单测。
// 提取后用 tests/test-watchdog-log.js 直接锁死格式契约。

/** 把 FAIL 检查项格式化成 `name(detail)`，detail 缺失时退回 status。 */
export function formatFailChecks(failChecks) {
  return (failChecks || [])
    .map(c => (c && c.name ? `${c.name}(${c.detail || c.status || 'no-detail'})` : String(c)))
    .join(', ')
}

/** watchdog 报内存 FAIL 但进程没带 --expose-gc 时的说明（自救手段不可用，不是"已尝试"）。 */
export function gcUnavailableNotice() {
  return 'WATCHDOG: GC self-rescue unavailable (started without --expose-gc); '
    + 'RSS overrun here is mostly off-heap — restart the MCP process to reclaim it'
}

/** 重启额度耗尽后的说明（自救援已放弃，需要宿主重启）。 */
export function restartExhaustedNotice(used, max) {
  return `WATCHDOG: restart budget exhausted (${used}/${max}) — `
    + 'self-rescue abandoned; the host must restart this MCP process to clear the FAIL state'
}

/**
 * 判断"额度耗尽通知"该不该发。
 * 每小时最多一次——旧实现在额度耗尽后彻底静默，现场分不清"还在处理"与"已放弃"。
 * 注意这里用独立时间戳，不复用 lastAutoRestart：那个变量同时给信号量分支用，
 * 共用会让两条分支互相推迟。
 */
export function shouldNoticeExhausted(nowMs, lastNoticeMs, used, max, intervalMs = 3_600_000) {
  if (used < max) return false
  return nowMs - lastNoticeMs > intervalMs
}

/**
 * 内存阈值（唯一真相）。
 *
 * B8：这三个数字此前分散在两处、彼此没有交叉引用：
 *   - mcp-server.js  MEMORY_DANGER_MB = 480（每 30s 软告警）
 *   - health-check.js  > 600 → WARN，> 800 → FAIL
 * 于是日志里 "danger threshold=480MB" 与 "RSS=901MB > 800MB threshold"
 * 看起来像两套互不相干的规则；现场无法判断"现在离 FAIL 还有多远"。
 * 集中到一处，任何一处要改都必须同时改这里。
 *
 * 这些值本身**本轮不动**：改阈值需要多机多时段实测基线，没有基线就改
 * 属于"看起来对"，比不改更糟。
 */
export const MEMORY_THRESHOLDS = Object.freeze({
  softMB: 480, // 软告警：开始记录（不代表要动手）
  warnMB: 600, // WARN：考虑重启
  failMB: 800, // FAIL：进 watchdog FAIL 名单
})

/**
 * 内存软告警文本。
 *
 * 三处阈值必须同时写出来，否则现场无法判断"离 FAIL 还有多远"：
 *   - 480MB：本条软告警（mcp-server MEMORY_DANGER_MB）
 *   - 600MB：health-check WARN
 *   - 800MB：health-check FAIL（只有这条会进 watchdog 的 FAIL 名单）
 * 旧实现只说 "danger threshold=480MB"，读者不知道 800MB 才是 FAIL 线。
 *
 * 另外必须点明堆内/堆外占比：实测 RSS 571MB 配 heap 74MB（91% 堆外），
 * 而部署参数是 --max-old-space-size=512——调那个参数对堆外超限完全无效。
 * 不写这句，现场会去调一个不相干的参数。
 */
export function formatMemoryWarning({ rssMB, heapMB, activeRequests = 0,
  softMB = MEMORY_THRESHOLDS.softMB,
  warnMB = MEMORY_THRESHOLDS.warnMB,
  failMB = MEMORY_THRESHOLDS.failMB }) {
  const offHeapMB = Math.max(0, Math.round(rssMB - heapMB))
  const offHeapDominated = offHeapMB > rssMB / 2
  return `MEMORY WARNING: RSS=${Math.round(rssMB)}MB (soft threshold=${softMB}MB, `
    + `WARN=${warnMB}MB, FAIL=${failMB}MB), heap=${Math.round(heapMB)}MB, `
    + `off-heap≈${offHeapMB}MB, active_requests=${activeRequests}`
    + (offHeapDominated ? ' — dominated by off-heap; GC/heap-limit will not help' : '')
}
