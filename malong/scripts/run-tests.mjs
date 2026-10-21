#!/usr/bin/env node
// 测试分层运行器（0.5.18 后续，纯测试基建）
// 目的：开发时不再等 9 分钟全链；全链/快速层共用同一份 package.json test 链，避免第二份清单漂移。
//
// 用法：
//   node scripts/run-tests.mjs --lane=fast   跑 tests/fast-list.json（核心 + 快）
//   node scripts/run-tests.mjs --lane=full   等价 npm test，额外输出逐文件耗时与 top10
//   npm run test:file -- tests/test-wp04-receipts.js   单文件
//
// 失败即停（与 && 语义一致）。全链仍在发布门前手动跑 `npm test`。
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'))
const argv = process.argv.slice(2)
const laneArg = argv.find(a => a.startsWith('--lane='))
const lane = laneArg ? laneArg.split('=')[1] : 'fast'

const all = pkg.scripts.test.split('&&').map(s => s.trim()).filter(Boolean)
const fileOf = (cmd) => {
  const m = cmd.match(/tests\/([a-z0-9-]+\.js)/)
  return m ? m[1] : null
}

let selected = all
let label = 'full'
if (lane === 'fast') {
  const listPath = join(root, 'tests', 'fast-list.json')
  if (!existsSync(listPath)) {
    console.error('missing tests/fast-list.json')
    process.exit(2)
  }
  const fast = new Set(JSON.parse(readFileSync(listPath, 'utf-8')).files || [])
  selected = all.filter(cmd => fast.has(fileOf(cmd)))
  const missing = [...fast].filter(f => !all.some(cmd => fileOf(cmd) === f))
  if (missing.length) console.error(`[warn] fast-list 中不在 npm test 链：${missing.join(', ')}`)
  label = 'fast'
}

if (selected.length === 0) {
  console.error('no tests selected')
  process.exit(2)
}

const times = []
const t0 = Date.now()
let failed = 0
for (const cmd of selected) {
  const name = fileOf(cmd) || cmd
  const t = Date.now()
  const code = await new Promise((resolve) => {
    const p = spawn(cmd, { cwd: root, shell: true, stdio: 'inherit' })
    p.on('exit', (c) => resolve(c ?? 1))
    p.on('error', () => resolve(1))
  })
  const dt = (Date.now() - t) / 1000
  times.push({ name, dt, code })
  if (code !== 0) { failed = code; break }
}
const total = (Date.now() - t0) / 1000
const dumpArg = argv.find(a => a.startsWith('--dump='))
if (dumpArg) writeFileSync(dumpArg.slice('--dump='.length), JSON.stringify({ lane, total, times }, null, 2) + '\n')
const top = times.slice().sort((a, b) => b.dt - a.dt).slice(0, 10)
console.log(`\n[lane ${label}] ${times.length}/${selected.length} files, ${total.toFixed(1)}s, failed=${failed}`)
if (top.length) console.log('top: ' + top.map(x => `${x.name} ${x.dt.toFixed(1)}s`).join(' | '))
process.exit(failed ? 1 : 0)
