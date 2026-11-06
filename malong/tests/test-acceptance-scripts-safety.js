// test-acceptance-scripts-safety.js — 验收脚本自身的安全判据（R20-F01 / R20-F02）
//
// 为什么验收脚本需要自己的测试：它们是「会被人在真实机器上跑」的工具，
// 一个 rmSync(用户传入路径) 就足以造成不可恢复的数据删除（专家 R20-F01 实测）。
// 所以这里钉两条：
//   F01  已有目录必须硬拒绝（exit 2）且一个字节都不动；不存在路径才创建
//   F02  子进程退出/错误后，在途 RPC 必须立刻结算，不得等超时
//
// 两个用例都直接跑真实脚本（不是复制逻辑），失败路径优先。

import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPTS = join(__dirname, '..', 'scripts')
const SLICE = join(SCRIPTS, 'acceptance-mcp-slice.mjs')
const CRASH = join(SCRIPTS, 'acceptance-crash-boundary.mjs')
const TMP = join(os.tmpdir(), 'opencode', 'test-accept-safety-' + process.pid)

let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}

rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })

// ── F01-a：已有目录 → 两份脚本都必须 exit 2，且内容原封不动 ──
{
  const guarded = join(TMP, 'precious')
  mkdirSync(guarded, { recursive: true })
  writeFileSync(join(guarded, 'keep.txt'), 'PRECIOUS-CONTENT', 'utf-8')
  writeFileSync(join(guarded, 'keep2.js'), 'const x = 1\n', 'utf-8')

  for (const [label, script] of [['slice', SLICE], ['crash', CRASH]]) {
    const r = spawnSync(process.execPath, [script, '--server', join(__dirname, '..', 'mcp-server.js'), '--workdir', guarded], {
      encoding: 'utf-8', timeout: 60000,
    })
    assert(r.status === 2, `${label}: 对已存在目录必须 exit=2（得 ${r.status}）`)
    assert(/拒绝执行/.test(r.stderr || ''), `${label}: 必须明确说"拒绝执行"`)
    assert(/已存在/.test(r.stderr || ''), `${label}: 必须说明原因是目标已存在`)
    assert(existsSync(join(guarded, 'keep.txt')), `${label}: 既有 keep.txt 不得被删`)
    assert(readFileSync(join(guarded, 'keep.txt'), 'utf-8') === 'PRECIOUS-CONTENT',
      `${label}: 既有文件内容不得被改`)
    assert(existsSync(join(guarded, 'keep2.js')), `${label}: 既有 keep2.js 不得被删`)
  }
}

// ── F01-b：父目录不存在 → 拒绝，且不凭空建树 ──
{
  const ghostParent = join(TMP, 'no-such-parent')
  const want = join(ghostParent, 'child')
  const r = spawnSync(process.execPath, [SLICE, '--server', join(__dirname, '..', 'mcp-server.js'), '--workdir', want], {
    encoding: 'utf-8', timeout: 60000,
  })
  assert(r.status === 2, `父目录不存在必须 exit=2（得 ${r.status}）`)
  assert(!existsSync(ghostParent), '不得替用户凭空创建父目录树')
}

// ── F01-c：不存在的路径 → 允许创建（不是一律拒绝）──
{
  const fresh = join(TMP, 'fresh-' + Date.now())
  // Windows 复核（2026-11-06）：import() 必须走 file:// URL，绝对路径会被当成协议（n:）。
  const mod = await import(pathToFileURL(join(SCRIPTS, 'acceptance-workdir.mjs')).href)
  const r = mod.prepareWorkdirOrExit(fresh, 'test-')
  assert(r.ok === true, `不存在且父目录可信时必须允许（得 ${JSON.stringify(r)}）`)
  assert(existsSync(fresh), '必须真的创建出目录')
  r.dispose()
  assert(!existsSync(fresh), 'dispose 必须能清掉自己创建的目录')
}

// ── F02：子进程自杀后，在途 RPC 必须【立刻】结算，而不是等超时 ──
{
  const dying = join(TMP, 'dying-server.mjs')
  writeFileSync(dying, [
    "import { createInterface } from 'node:readline'",
    'const rl = createInterface({ input: process.stdin })',
    "rl.once('line', () => { process.kill(process.pid, 'SIGKILL') })",
    '',
  ].join('\n'), 'utf-8')

  const started = Date.now()
  const r = spawnSync(process.execPath, [
    CRASH, '--server', dying, '--workdir', join(TMP, 'f02-run-' + Date.now()),
  ], { encoding: 'utf-8', timeout: 60000 })
  const elapsed = Date.now() - started

  // 旧实现的超时是 120s；这里只给脚本 60s。
  // 判据：必须在 20s 内结束（真结算），且报出退出原因（不是笼统超时）。
  assert(r.status !== null && elapsed < 20000,
    `F02: 强杀后必须立即结算并退出（耗时 ${elapsed}ms，status=${r.status}）`)
  const out = (r.stdout || '') + (r.stderr || '')
  assert(/server exited/i.test(out), `F02: 必须报出"server exited"而非静默等待（实际：${out.slice(0, 200)}）`)
  assert(!/timeout initialize/i.test(out), 'F02: 不得退化成 initialize 超时')
}

rmSync(TMP, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
