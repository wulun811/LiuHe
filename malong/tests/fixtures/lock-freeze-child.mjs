// WP06 受控故障场景 fixture：子进程持锁后同步忙等（冻结事件循环，心跳无法触发），
// 用于实证 write-runtime.js r9(F2 注) 描述的「同步长操作延误锁心跳 → 锁被误判陈旧盗走」窗口。
// 仅测试用；env 注入 MALONG_TEST_STALE_LOCK_MS / MALONG_TEST_HEARTBEAT_MS 缩短窗口。
import { acquireLock } from '../../write-runtime.js'

const target = process.argv[2]
const freezeMs = Number(process.argv[3]) || 4000
const lock = await acquireLock(target, 5000)
if (lock.locked) { console.log('CHILD_LOCKED'); process.exit(2) }
console.log('CHILD_READY')
// 同步忙等：事件循环冻结，setInterval 心跳不会触发
const until = Date.now() + freezeMs
while (Date.now() < until) { /* spin */ }
lock.release()
console.log('CHILD_DONE')
process.exit(0)
