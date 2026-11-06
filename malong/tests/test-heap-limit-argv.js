// test-heap-limit-argv.js — `--max-old-space-size` 必须真的传给 V8（B8）
//
// 背景（本轮最实质的一条）：dsh-bridge.mjs 这样启动 mcp-server：
//
//   spawn(process.execPath, [serverPath, '--workspace', stateDir, '--max-old-space-size=512'])
//
// node 把**脚本名之后**的一切交给脚本（process.argv），V8 收不到。
// 实测验证：
//   node -e '...' --max-old-space-size=512    → execArgv 里没有它，argv 里有
//   node --max-old-space-size=512 -e '...'    → execArgv 里有它
//
// 于是 DSH 侧那台进程从来没有堆上限（argv 还能作证，见 last-crash-dump.json）：
//   "/usr/local/bin/node .../mcp-server.js --workspace ... --max-old-space-size=512"
//
// 更糟的是 checkV8HeapLimit() 读的是 process.argv，恰好读到这串，
// 日志打印 "server ready, V8 heap=512MB" ——**报告了一个实际不存在的上限**。
// 这属于"说了等于做了"：后续所有内存判断都建立在一个假前提上。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MALONG = join(__dirname, '..')
let pass = 0, fail = 0
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  FAIL:', msg) } }

const TMP = join(os.tmpdir(), 'opencode', 'heap-argv')
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })

/** 启动真实 mcp-server，读它打印的 heap 行与告警行，然后关闭 stdin 让它退出。 */
function boot(extraArgs, nodeArgs = []) {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [...nodeArgs, join(MALONG, 'mcp-server.js'), '--workspace', join(TMP, 'ws'), ...extraArgs],
      { timeout: 25000, env: { ...process.env, MALONG_STATE_DIR: join(TMP, 'state') } },
      (err, stdout, stderr) => {
        resolve({ out: String(stdout || '') + String(stderr || ''), code: err ? (err.code ?? 1) : 0 })
      },
    )
    // 读完初始化日志就关 stdin，走"正常客户端断开"路径
    setTimeout(() => { try { child.stdin.end() } catch {} }, 8000)
  })
}

console.log('== ① 正确传参（脚本前）→ 报出真实的 512MB ==')
{
  const r = await boot([], ['--max-old-space-size=512'])
  assert(/V8 heap=512MB/.test(r.out), `应报 V8 heap=512MB（输出片段: ${
    (r.out.match(/.*V8 heap=.*/) || [''])[0].trim()}）`)
  assert(!/AFTER the script path/.test(r.out), '正确传参时不得出现"位置错"告警')
}

console.log('== ② 错误传参（脚本后）→ 必须警告 V8 没收到，且不得报 512MB ==')
{
  const r = await boot(['--max-old-space-size=512'], [])
  assert(/V8 heap=0MB/.test(r.out),
    `脚本后的参数未生效，必须报 0MB 而不是 512MB（输出: ${
      (r.out.match(/.*V8 heap=.*/) || [''])[0].trim()}）`)
  assert(/AFTER the script path/.test(r.out),
    '必须明确说明"参数位置错了，V8 忽略了它"')
  assert(/unlimited/.test(r.out), '必须说明实际上限是无限制')
  assert(!/V8 heap=512MB/.test(r.out), '绝不能报告一个不存在的上限')
}

console.log('== ③ 完全不传 → 明确提示无上限 ==')
{
  const r = await boot([], [])
  assert(/V8 heap=0MB/.test(r.out), `未传时必须报 0MB（得 ${
    (r.out.match(/.*V8 heap=.*/) || [''])[0].trim()}）`)
  assert(/unlimited/.test(r.out), '必须说明无上限')
  assert(/Start with --max-old-space-size=512/.test(r.out), '必须给出正确用法')
}

console.log('== ④ dsh-bridge 必须把该参数放在脚本路径之前 ==')
{
  const src = readFileSync(join(MALONG, 'dsh', 'dsh-bridge.mjs'), 'utf-8')
  // 定位 spawn(process.execPath, [...]) 那一行
  const m = src.match(/spawn\(process\.execPath,\s*\[([^\]]*)\]/)
  assert(m, '应能找到 dsh-bridge 的 spawn 调用')
  const argList = m ? m[1] : ''
  assert(/--max-old-space-size=512/.test(argList), '参数应出现（得 ' + argList + '）')
  // 关键：它必须排在 serverPath 变量之前
  const idxHeap = argList.indexOf('--max-old-space-size')
  const idxServer = argList.indexOf('serverPath')
  assert(idxServer >= 0, '应能在参数表里找到 serverPath')
  assert(idxHeap >= 0 && idxHeap < idxServer,
    `--max-old-space-size 必须排在 serverPath 之前（得 heap@${idxHeap} / serverPath@${idxServer}）`)
}

console.log('== ⑤ checkV8HeapLimit 必须读 execArgv，不能读 argv ==')
{
  // Windows 复核（2026-11-06）：CRLF 检出下字面 `\n}\n` 切片恒失败 → 先归一化行尾。
  const src = readFileSync(join(MALONG, 'mcp-server.js'), 'utf-8').replace(/\r\n/g, '\n')
  const fn = src.slice(src.indexOf('function checkV8HeapLimit()'))
  const body = fn.slice(0, fn.indexOf('\n}\n') + 2)
  assert(/process\.execArgv\.find/.test(body),
    '必须用 process.execArgv 判断生效的堆上限')
  // 它可以读 argv，但只能用来报"位置错了"，不能用来当作生效值
  assert(/fromExec/.test(body), '应以 execArgv 的结果为准')
}

rmSync(TMP, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
