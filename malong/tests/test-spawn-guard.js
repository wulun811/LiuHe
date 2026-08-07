// test-spawn-guard.js — R14 进程组杀回归
// spawnWithGroup detached:true 超时 kill(-pid) 杀全组——孙进程（bash -c 里 & 的后台）不得存活
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0
let fail = 0
function assert(cond, msg) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`) }
  else { fail++; console.log(`  ✗ ${msg}`) }
}
const { spawnWithGroup } = await import(pathToFileURL(join(__dirname, '..', 'spawn-guard.js')).href)

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// ① 超时杀全组：bash -c 起孙进程 sleep 100，超时后孙进程不得存活
{
  const marker = `/tmp/opencode/sp-guard-${Date.now()}.pid`
  const t0 = Date.now()
  const res = await spawnWithGroup('bash', ['-c', `sleep 100 & echo $! > ${marker}; wait`], { timeout: 800 })
  const elapsed = Date.now() - t0
  assert(res.killed === true, `超时 killed=true（elapsed ${elapsed}ms）`)
  assert(elapsed < 10000, `超时在合理窗口内返回（${elapsed}ms）`)
  await sleep(500) // 等 SIGTERM/SIGKILL 落地
  const childPid = execFileSync('cat', [marker]).toString().trim()
  const alive = spawnSync('kill', ['-0', childPid])
  assert(alive.status === 1, `孙进程（bash 后台 sleep 100, pid=${childPid}）已被杀（kill -0 返回 ${alive.status}）`)
  spawnSync('rm', ['-f', marker])
}

// ② 正常完成：killed=false，输出收集
{
  const res = await spawnWithGroup('printf', ['hello'], { timeout: 5000 })
  assert(res.killed === false && res.code === 0, `正常完成 killed=false code=0`)
  assert(res.stdout === 'hello', `stdout 收集正确（${JSON.stringify(res.stdout)}）`)
}

// ③ 命令不存在：reject（ENOENT）
{
  let threw = false
  try { await spawnWithGroup('definitely_not_a_cmd_xyz', [], { timeout: 2000 }) } catch (e) { threw = e.code === 'ENOENT' }
  assert(threw, `命令不存在 reject ENOENT`)
}

// ④ maxBuffer 限流：超量输出被截断 + truncated
{
  const res = await spawnWithGroup('bash', ['-c', 'for i in $(seq 1 5000); do echo "xxxxxxxxxxxxxxxxxxxx"; done'], { timeout: 5000, maxBuffer: 2048 })
  assert(res.truncated === true, `超过 maxBuffer 标记 truncated`)
  assert(res.stdout.length <= 2048, `stdout 被限制在 maxBuffer 内（${res.stdout.length}）`)
}

console.log(`== test-spawn-guard: ${pass} passed, ${fail} failed ==`)
process.exit(fail > 0 ? 1 : 0)