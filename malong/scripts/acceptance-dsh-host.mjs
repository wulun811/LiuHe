#!/usr/bin/env node
// acceptance-dsh-host.mjs — 真实 DSH 宿主挂载验收（专家 R20 §4 最后一条）
//
// 为什么需要它：MCP server 能跑，不等于 **bridge 插件入口** 能挂进 dsh 宿主。
// 专家明确要求「再增加一次真实 DSH 宿主挂载与工作区注入，防止
// '仅 MCP server 可用但 Bridge 插件入口坏了'」。test-dsh-bridge.js 只测适配器
// 源码逻辑，不启动真实宿主。
//
// 做这些事，任何一件不成立就判 FAIL：
//   1. 把产物装进一个【隔离的 DSH_HOME】profile（不碰用户正在跑的实例）
//   2. 处理 pnpm 10 的 onlyBuiltDependencies（否则 better-sqlite3 无原生模块）
//   3. 启动真实 `dsh --profile web`，断言 bridge 初始化 + 工具装载 + HTTP 在听
//   4. 断言 MCP 子进程确实由 bridge 拉起（不是宿主直连）
//
// 明确不做：不登录、不驱动浏览器、不验模型对话——只验「入口挂得上、工具在」。
//
// 用法：node scripts/acceptance-dsh-host.mjs --tgz <bridge.tgz> [--parse-bin <bin>] [--json]
// 退出码：0 全通过 / 1 有失败 / 2 环境问题（如没有 dsh）

import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
import net from 'node:net'

const argv = process.argv.slice(2)
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }
const TGZ = arg('--tgz')
const PARSE_BIN = arg('--parse-bin')
const AS_JSON = argv.includes('--json')
const TIMEOUT_S = Number(arg('--timeout', '180'))

if (!TGZ || !existsSync(TGZ)) {
  console.error('缺少 --tgz <bridge.tgz>（文件不存在）')
  process.exit(2)
}

const which = spawnSync('sh', ['-c', 'command -v dsh'], { encoding: 'utf-8' })
if (which.status !== 0 || !which.stdout.trim()) {
  console.error('环境问题：PATH 上没有 dsh，无法做宿主验收（跳过而非假装通过）')
  process.exit(2)
}
const DSH_BIN = which.stdout.trim()

const ROOT = join(os.tmpdir(), 'opencode', 'dsh-host-accept-' + process.pid)
rmSync(ROOT, { recursive: true, force: true })
const DSH_HOME = join(ROOT, 'dshhome')
const WS = join(ROOT, 'workspace')
mkdirSync(join(DSH_HOME, 'profiles'), { recursive: true })
mkdirSync(join(WS, 'src'), { recursive: true })
writeFileSync(join(WS, 'src', 'probe.js'),
  'export function hostProbe(x) { return x * 2 }\ntry { const inTry = 7 } catch (e) {}\n', 'utf-8')

const steps = []
const record = (name, ok, detail) => {
  steps.push({ step: name, ok: !!ok, detail })
  if (!AS_JSON) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const env = {
  ...process.env,
  DSH_HOME,
  MALONG_STATE_DIR: join(ROOT, 'malong-state'),
}
if (PARSE_BIN) env.MALONG_PARSE_BIN = PARSE_BIN

const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { env, encoding: 'utf-8', timeout: (opts.timeout || 300) * 1000, cwd: opts.cwd || ROOT })

const freePort = () => new Promise((res, rej) => {
  const srv = net.createServer()
  srv.listen(0, '127.0.0.1', () => {
    const p = srv.address().port
    srv.close(() => res(p))
  })
  srv.on('error', rej)
})

let child = null
try {
  const add = run(DSH_BIN, ['plugin', '--profile', 'web', 'add', 'file:' + TGZ], { timeout: 600 })
  const profPkg = join(DSH_HOME, 'profiles', 'web', 'package.json')
  const added = existsSync(profPkg) && /dsh-malong-bridge/.test(readFileSync(profPkg, 'utf-8'))
  record('① 装进隔离 profile', added,
    added ? 'profile 已声明依赖' : `plugin add 失败：${(add.stderr || add.stdout || '').slice(-300)}`)
  if (!added) throw new Error('install failed')

  const wsYaml = join(DSH_HOME, 'profiles', 'web', 'pnpm-workspace.yaml')
  if (existsSync(wsYaml)) {
    const cur = readFileSync(wsYaml, 'utf-8')
    if (!/onlyBuiltDependencies/.test(cur)) {
      writeFileSync(wsYaml, cur.trimEnd() + '\nonlyBuiltDependencies:\n  - better-sqlite3\n', 'utf-8')
    }
    run('pnpm', ['install'], { cwd: join(DSH_HOME, 'profiles', 'web'), timeout: 600 })
  }
  const nativeOk = spawnSync('sh', ['-c', `find "${DSH_HOME}" -name better_sqlite3.node | head -1`], { encoding: 'utf-8' })
    .stdout.trim().length > 0
  record('② better-sqlite3 原生模块就位', nativeOk,
    nativeOk ? 'better_sqlite3.node 存在' : '未构建（pnpm 10 默认拦截 build script）')

  const port = await freePort()
  child = spawn(DSH_BIN, ['--profile', 'web', '--no-open', '--port', String(port)], {
    env, cwd: WS, stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.setEncoding('utf-8')
  child.stderr.setEncoding('utf-8')
  const chunks = []
  child.stdout.on('data', (d) => chunks.push(d))
  child.stderr.on('data', (d) => chunks.push(d))
  const text = () => chunks.join('')

  const started = Date.now()
  let listening = false
  while (Date.now() - started < TIMEOUT_S * 1000) {
    if (new RegExp('http://127\\.0\\.0\\.1:' + port).test(text())) { listening = true; break }
    if (spawnSync('sh', ['-c', `ss -ltn 2>/dev/null | grep -q ':${port}'`]).status === 0) { listening = true; break }
    await new Promise((r) => setTimeout(r, 1000))
  }
  const out1 = text()
  record('③ 宿主 HTTP 已监听', listening, `port=${port}`)

  if (!listening) {
    record('④ bridge 初始化', false, '宿主未起来，无法判断')
    record('⑤ 工具装载', false, '宿主未起来')
    record('⑥ MCP 子进程归属 bridge', false, '宿主未起来')
  } else {
    const initOk = /\[malong-dsh-bridge\] initialized protocol=/.test(out1)
    const proto = (out1.match(/\[malong-dsh-bridge\] initialized protocol=([^\s]+)/) || [])[1] || '-'
    record('④ bridge 初始化', initOk, `protocol=${proto}`)

    const loaded = [...out1.matchAll(/\[mcp\] \[info\] loaded: (\w+)/g)].map((m) => m[1])
    record('⑤ 工具装载', loaded.length >= 10, `${loaded.length} 个：${loaded.slice(0, 6).join(',')}`)

    const spawnOk = /\[malong-dsh-bridge\] server:/.test(out1)
    record('⑥ MCP 子进程归属 bridge', spawnOk, spawnOk ? 'bridge 转发的 server 日志存在' : '未见 bridge→server 日志')
  }
} catch (e) {
  record('执行异常', false, (e.code ? e.code + ' ' : '') + e.message)
} finally {
  if (child) { try { child.kill('SIGTERM') } catch {} }
  await new Promise((r) => setTimeout(r, 800))
  if (child) { try { child.kill('SIGKILL') } catch {} }
}

const failed = steps.filter((s) => !s.ok)
const exitCode = failed.length ? 1 : 0
if (AS_JSON) {
  console.log(JSON.stringify({
    tgz: TGZ, parse_bin: PARSE_BIN || null, dsh_home: DSH_HOME, steps,
    failed: failed.length, exitCode,
  }, null, 2))
} else {
  console.log(`\n== dsh-host: ${steps.length - failed.length}/${steps.length} passed ==`)
}
rmSync(ROOT, { recursive: true, force: true })
process.exit(exitCode)
