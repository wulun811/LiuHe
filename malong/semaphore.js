// semaphore.js — 工具调用排队信号量（FIFO，weight 模型）

// r11(H1)：重工具（reindex）权重 = max(3, ceil(concurrency/2))，**恒小于并发槽数**。
// 教训：旧实现 weight=concurrency（并发 3→5 后 weight 从 3 变 5），任一普通工具占 1 槽时
// 重工具永远凑不齐槽 → 排队 60s 超时（r10e 想修的问题原样存在且更糟）。
// 规则：并发 ≥5 时 weight 必须 < concurrency（普通请求总能和重工具并行）；并发 ≤3 时 cap 到槽数（旧语义）。
export function heavyToolWeight(concurrency) {
  return Math.min(concurrency, Math.max(3, Math.floor(concurrency / 2)))
}

export class Semaphore {
  constructor(max) {
    this.max = max
    this.current = 0
    this.queue = []
  }

  async acquire(weight = 1, timeoutMs = 0) {
    if (this.current + weight <= this.max && this.queue.length === 0) {
      this.current += weight
      return
    }
    if (timeoutMs > 0) {
      const promise = new Promise(resolve => {
        const item = { resolve, weight, waitTime: Date.now(), timer: null }
        this.queue.push(item)
        item.timer = setTimeout(() => {
          const idx = this.queue.indexOf(item)
          if (idx >= 0) this.queue.splice(idx, 1)
          resolve('timeout')
        }, timeoutMs)
      })
      const r = await promise
      if (r === 'timeout') return { timedOut: true, waitTimeMs: timeoutMs }
      return
    }
    await new Promise(resolve => this.queue.push({ resolve, weight, waitTime: Date.now() }))
  }

  release(weight = 1) {
    // R22-⑰（第四轮审核 P1）：下界保护——release 超发（weight 超过已 acquire 量）不得把
    // 计数打成负数：负计数会让后续 acquire 永远不排队（并发超限静默）。钳制在 0。
    this.current = Math.max(0, this.current - weight)
    while (this.queue.length > 0) {
      const next = this.queue[0]
      if (this.current + next.weight <= this.max) {
        this.queue.shift()
        if (next.timer) clearTimeout(next.timer) // P2-C6：授予后清 timer，防超时回调晚到空转
        this.current += next.weight
        next.resolve()
      } else {
        break
      }
    }
  }

  getStatus() {
    return {
      current: this.current,
      max: this.max,
      queue: this.queue.map(q => ({ weight: q.weight, waiting: Date.now() - q.waitTime })),
    }
  }

  // watchdog 死锁兜底：清空队列并复位计数（排队中的 acquire 会挂起直到自身超时，
  // 但信号量账本恢复可让新请求进入）
  reset() {
    const drained = this.queue.length
    for (const item of this.queue) {
      if (item.timer) clearTimeout(item.timer)
      item.resolve('timeout')
    }
    this.queue = []
    this.current = 0
    return { drained }
  }
}
