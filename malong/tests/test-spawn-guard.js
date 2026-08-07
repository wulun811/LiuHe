// test-spawn-guard.js — R14 进程组杀回归
// spawnWithGroup detached:true 超时 kill(-pid) 杀全组——孙进程（bash -c 里 & 的后台）不得存活
// Windows：无进程组——超时 taskkill /T 杀树（win32 分支用 node 挂起进程等价验证）
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0
let fail = 0
function assert(cond, msg) {
  if (cond) { pass++; console.log(`  ok ${msg}`) }
  else { fail++; console.log(`  FAIL ${msg}`) }
}
const { spawnWithGroup } = await import(pathToFileURL(join(__dirname, '..', 'spawn-guard.js')).href)

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const isWin = process.platform === 'win32'

// ① 超时杀全组：bash -c 起孙进程 sleep 100，超时后孙进程不得存活
//    Windows 等价：node -e 挂起 60s，超时后该进程不得存活（taskkill /T 杀树）
{
  let marker, childPid
  let res
  const t0 = Date.now()
  if (isWin) {
    marker = join(os.tmpdir(), 'opencode', `sp-guard-${Date.now()}.pid`)
    const childScript = `const{writeFileSync}=require('fs');writeFileSync(${JSON.stringify(marker)},String(process.pid));setTimeout(()=>{},60000)`
    res = await spawnWithGroup(process.execPath, ['-e', childScript, 'x'], { timeout: 800 })
    childPid = readFileSync(marker, 'utf-8').trim()
  } else {
    marker = `/tmp/opencode/sp-guard-${Date.now()}.pid`
    res = await spawnWithGroup('bash', ['-c', `sleep 100 & echo $! > ${marker}; wait`], { timeout: 800 })
    childPid = execFileSync('cat', [marker]).toString().trim()
  }
  const elapsed = Date.now() - t0
  assert(res.killed === true, `超时 killed=true（elapsed ${elapsed}ms）`)
  assert(elapsed < 10000, `超时在合理窗口内返回（${elapsed}ms）`)
  await sleep(500) // 等 kill 落地
  const alive = isWin
    ? spawnSync('tasklist', ['/fi', `PID eq ${childPid}`])
    : spawnSync('kill', ['-0', childPid])
  if (isWin) {
    assert(alive.status === 0 && alive.stdout && !alive.stdout.includes('INFO: No tasks'), `挂起进程（pid=${childPid}）已被杀（tasklist 残留 ${alive.status}）`)
  } else {
    assert(alive.status === 1, `孙进程（bash 后台 sleep 100, pid=${childPid}）已被杀（kill -0 返回 ${alive.status}）`)
  }
  try { rmSync(marker, { force: true }) } catch {}
}

// ② 正常完成：killed=false，输出收集
{
  const res = isWin
    ? await spawnWithGroup(process.execPath, ['-e', "process.stdout.write('hello')"], { timeout: 5000 })
    : await spawnWithGroup('printf', ['hello'], { timeout: 5000 })
  assert(res.killed === false && res.code === 0, `正常完成 killed=false code=0`)
  assert(res.stdout === 'hello', `stdout 收集正确（${JSON.stringify(res.stdout)}）`)
}

// ③ 命令不存在：reject（ENOENT）——Windows 下经 cmd.exe 解析，exit 1 + 提示文本（非 ENOENT reject）
{
  if (isWin) {
    const res = await spawnWithGroup('definitely_not_a_cmd_xyz', [], { timeout: 2000 }).catch(e => ({ e }))
    assert(res.code !== 0 || res.e, `命令不存在 → 非 0 退出（code=${res.code}）`)
  } else {
    let threw = false
    try { await spawnWithGroup('definitely_not_a_cmd_xyz', [], { timeout: 2000 }) } catch (e) { threw = e.code === 'ENOENT' }
    assert(threw, `命令不存在 reject ENOENT`)
  }
}

// ④ maxBuffer 限流：超量输出被截断 + truncated
{
  const res = isWin
    ? await spawnWithGroup(process.execPath, ['-e', "for(let i=0;i<5000;i++)console.log('xxxxxxxxxxxxxxxxxxxx')"], { timeout: 5000, maxBuffer: 2048 })
    : await spawnWithGroup('bash', ['-c', 'for i in $(seq 1 5000); do echo "xxxxxxxxxxxxxxxxxxxx"; done'], { timeout: 5000, maxBuffer: 2048 })
  assert(res.truncated === true, `超过 maxBuffer 标记 truncated`)
  assert(res.stdout.length <= 2048, `stdout 被限制在 maxBuffer 内（${res.stdout.length}）`)
}

console.log(`== test-spawn-guard: ${pass} passed, ${fail} failed ==`)
process.exit(fail > 0 ? 1 : 0)
