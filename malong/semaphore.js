// semaphore.js — 工具调用排队信号量（FIFO，weight 模型）
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
    this.current -= weight
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
