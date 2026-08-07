// test-semaphore.js — Semaphore 排队信号量单测（超时兜底 + weight + 防泄漏）
import { Semaphore, heavyToolWeight } from '../semaphore.js'

let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// ── 1. 基础 FIFO：满时排队，release 后放行 ──
{
  const s = new Semaphore(2)
  await s.acquire()
  await s.acquire()
  const t0 = Date.now()
  let third = false
  const p = (async () => { await s.acquire(); third = true })()
  await sleep(50)
  assert(third === false, '满时第 3 个等待')
  s.release()
  await p
  assert(third === true, 'release 后第 3 个放行')
  assert(s.getStatus().current === 2, `current=2（得 ${s.getStatus().current}）`)
  s.release(); s.release()
  assert(s.getStatus().current === 0, '全部释放后 current=0')
}

// ── 2. 超时兜底：等待超时返回 timedOut，不无限挂起 ──
{
  const s = new Semaphore(1)
  await s.acquire()
  const t0 = Date.now()
  const r = await s.acquire(1, 100)
  const wait = Date.now() - t0
  assert(r?.timedOut === true, `超时返回 timedOut（得 ${JSON.stringify(r)}）`)
  assert(wait >= 90 && wait < 1000, `等待约 100ms（实际 ${wait}ms）`)
  assert(s.getStatus().queue.length === 0, `超时项已出队（queue=${s.getStatus().queue.length}）`)
  assert(s.getStatus().current === 1, `超时后 current 不变（得 ${s.getStatus().current}）`)
  s.release()
  assert(s.getStatus().current === 0, '超时请求未泄漏 weight（release 后 current=0）')
}

// ── 3. 超时竞态：release 与 timeout 竞争，weight 不双计 ──
{
  const s = new Semaphore(1)
  await s.acquire()
  const r = await s.acquire(1, 100)
  assert(r?.timedOut === true, '占满时快速超时')
  s.release()
  // 队列空，current 归零——若 timeout 路径误 release 会变 -1
  assert(s.getStatus().current === 0, `无 weight 泄漏（current=${s.getStatus().current}）`)
}

// ── 4. weight 语义：weight=2 需等两个都放 ──
{
  const s = new Semaphore(2)
  await s.acquire()
  let heavy = false
  const p = (async () => { await s.acquire(2); heavy = true })()
  await sleep(30)
  assert(heavy === false, 'weight=2 在 1 空闲时不能进（2 > 1）')
  s.release()
  await p
  assert(heavy === true, '2 空闲后 weight=2 进入')
  assert(s.getStatus().current === 2, 'heavy 占满 2（current=2）')
  s.release(2)
  assert(s.getStatus().current === 0, 'heavy 释放后归零')
}

// ── 5. release 空队列不炸（幂等） ──
// R22-⑰：下界保护——超发 release 钳制在 0（负计数会让 acquire 永不排队 → 并发超限静默）
{
  const s = new Semaphore(1)
  s.release()
  assert(s.getStatus().current === 0, '空 release 钳制在 0（不得下溢为负）')
  s.release(3)
  assert(s.getStatus().current === 0, '超发 release 仍钳制在 0')
  const r = await s.acquire(1, 50)
  assert(!(r && r.timedOut), '钳制后 acquire 正常授予（不排队挂死）')
}

// ── 6. 无超时路径保持旧行为（timeoutMs=0） ──
{
  const s = new Semaphore(1)
  await s.acquire()
  let second = false
  const p = (async () => { await s.acquire(); second = true })()
  await sleep(30)
  assert(second === false, '无超时 acquire 排队等待')
  s.release()
  await p
  assert(second === true, '无超时 acquire 最终放行')
}

// ── 7. r11(H1): 重工具权重恒小于并发槽数（reindex 与普通工具永可并行） ──
{
  assert(heavyToolWeight(5) === 3, `并发 5 → 权重 3（得 ${heavyToolWeight(5)}）`)
  assert(heavyToolWeight(3) === 3, `并发 3 → 权重 3（得 ${heavyToolWeight(3)}）`)
  assert(heavyToolWeight(8) === 4, `并发 8 → 权重 4（得 ${heavyToolWeight(8)}）`)
  assert(heavyToolWeight(10) === 5, `并发 10 → 权重 5（得 ${heavyToolWeight(10)}）`)
  for (const n of [2, 3, 4, 5, 6, 8, 10, 16]) {
    const w = heavyToolWeight(n)
    assert(w <= n, `并发 ${n} 时权重 ${w} ≤ ${n}（可 acquire）`)
    if (n >= 5) assert(w < n, `并发 ${n} 时权重 ${w} < ${n}（普通工具总能并行）`)
  }
  assert(heavyToolWeight(2) === 2, `并发 2 → 权重 2（cap，得 ${heavyToolWeight(2)}）`)
  // 行为验证：5 槽下重工具占 3 后，普通 weight=1 仍能进入
  {
    const s = new Semaphore(5)
    await s.acquire(3)
    let light = false
    const p = (async () => { await s.acquire(1); light = true })()
    await sleep(30)
    assert(light === true, '重工具占 3 槽时普通工具仍可进入')
    s.release(3)
    s.release(1)
  }
}

console.log(`\n=== test-semaphore: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
