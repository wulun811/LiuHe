// test-invoke-ledger-concurrency.js — R1（0.5.14）出口账本并发丢账回归
// 旧实现：单本 JSON 整本 read-modify-write —— 两个进程用不同 request_id 并发写互相覆盖（丢条目），
// 幂等复读随之失效（专家实测：A 完成、B 用旧快照覆盖整本、A 原样重试二次执行）。
// 新实现：每 request_id 独立记录文件 + 旧格式只读回退 + 目录 mtime FIFO 保留。
// 本测试锁定：① 记录互不干扰 ② 保留封顶 ③ 旧格式回退 ④ 跨进程不同 id 并发全量不丢（真实子进程）。
import { join, dirname } from 'node:path'
import { mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, utimesSync } from 'node:fs'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}
async function imp(p) { return import(pathToFileURL(p).href) }

const TMP = join(os.tmpdir(), 'opencode', 'invoke-ledger-concurrency')
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })
process.env.MALONG_STATE_DIR = join(TMP, 'state')

const ledger = await imp(join(__dirname, '..', 'tools', 'outlet-ledger.js'))
const store = await imp(join(__dirname, '..', 'tools', 'entry-store.js'))
const recDir = join(process.env.MALONG_STATE_DIR, 'outlet-requests', store.wsHash(TMP))

// ── ① 每 request_id 独立记录：写 A 不触及 B 的文件；prepared→终态合并保留 created ──
{
  const t0 = '2026-10-18T00:00:00.000Z'
  ledger.ledgerRecord(TMP, { request_id: 'rec-A', tool: 'x', payload_hash: 'h', effects: ['command'], state: 'prepared', ok: null, created: t0 })
  ledger.ledgerRecord(TMP, { request_id: 'rec-B', tool: 'y', payload_hash: 'h2', effects: ['command'], state: 'succeeded', ok: true, created: new Date().toISOString() })
  const pa = ledger.ledgerRecordPath(TMP, 'rec-A')
  const pb = ledger.ledgerRecordPath(TMP, 'rec-B')
  const aBefore = readFileSync(pa, 'utf-8')
  ledger.ledgerRecord(TMP, { request_id: 'rec-A', tool: 'x', payload_hash: 'h', effects: ['command'], state: 'succeeded', ok: true })
  const aAfter = readFileSync(pa, 'utf-8')
  const bAfter = readFileSync(pb, 'utf-8')
  assert(aBefore !== aAfter, '① A 的终态写入确实更新了 A 自己的记录')
  assert(JSON.parse(aAfter).state === 'succeeded', '① A 记录终态正确（得 ' + JSON.parse(aAfter).state + '）')
  assert(JSON.parse(aAfter).created === t0, '① prepared→终态合并保留 created（得 ' + JSON.parse(aAfter).created + '）')
  assert(JSON.parse(bAfter).state === 'succeeded' && JSON.parse(bAfter).tool === 'y', '① B 的记录仍是 B 自己的终态（写 A 不触及 B）')
  assert(ledger.ledgerLookup(TMP, 'rec-A')?.state === 'succeeded' && ledger.ledgerLookup(TMP, 'rec-B')?.state === 'succeeded', '① 两 id 均可查得')
}

// ── ② 保留封顶：目录内超过 500 条按 mtime 淘汰最旧，最新保留 ──
{
  const old = new Date('2020-01-01T00:00:00Z')
  for (let i = 0; i < 10; i++) ledger.ledgerRecord(TMP, { request_id: 'ret-' + i, tool: 'x', payload_hash: 'h', effects: ['command'], state: 'succeeded', ok: true })
  for (let i = 0; i < 10; i++) {
    const p = ledger.ledgerRecordPath(TMP, 'ret-' + i)
    utimesSync(p, old, old)
  }
  for (let i = 10; i < 510; i++) ledger.ledgerRecord(TMP, { request_id: 'ret-' + i, tool: 'x', payload_hash: 'h', effects: ['command'], state: 'succeeded', ok: true })
  const files = readdirSync(recDir).filter(f => f.endsWith('.json'))
  assert(files.length === 500, '② 账本封顶 500 条（得 ' + files.length + '）')
  assert(ledger.ledgerLookup(TMP, 'ret-0') === null && ledger.ledgerLookup(TMP, 'ret-9') === null, '② 最旧 10 条被淘汰')
  assert(ledger.ledgerLookup(TMP, 'ret-10')?.state === 'succeeded' && ledger.ledgerLookup(TMP, 'ret-509')?.state === 'succeeded', '② 边界内最新记录保留')
}

// ── ③ 旧单本格式只读回退：历史条目仍可查；同 id 新记录优先 ──
{
  const legacyPath = join(process.env.MALONG_STATE_DIR, 'outlet-requests', store.wsHash(TMP) + '.json')
  writeFileSync(legacyPath, JSON.stringify({ 'rec-legacy': { request_id: 'rec-legacy', state: 'succeeded', ok: true, tool: 'old' } }))
  assert(ledger.ledgerLookup(TMP, 'rec-legacy')?.tool === 'old', '③ 旧单本格式条目可读（回退）')
  ledger.ledgerRecord(TMP, { request_id: 'rec-legacy', tool: 'new', payload_hash: 'h3', effects: ['command'], state: 'succeeded', ok: true })
  assert(ledger.ledgerLookup(TMP, 'rec-legacy')?.tool === 'new', '③ 同 id 新独立记录优先于旧单本')
}

// ── ④ 跨进程不同 request_id 并发写：真实子进程 × 2，各 60 条（prepared→终态）全量不丢 ──
{
  const childPath = join(TMP, 'child.mjs')
  const ledgerPath = join(__dirname, '..', 'tools', 'outlet-ledger.js')
  const barrierDir = join(TMP, 'barrier')
  mkdirSync(barrierDir, { recursive: true })
  writeFileSync(childPath, [
    "import { existsSync, writeFileSync } from 'node:fs'",
    "import { join } from 'node:path'",
    "import { pathToFileURL } from 'node:url'",
    'const [ledgerPath, tag, barrierDir, ws] = process.argv.slice(2)',
    'const { ledgerRecord, ledgerLookup } = await import(pathToFileURL(ledgerPath).href)',
    'const sleep = (ms) => new Promise(r => setTimeout(r, ms))',
    "writeFileSync(join(barrierDir, 'ready-' + tag), '1')",
    'const deadline = Date.now() + 30000',
    "while (!(existsSync(join(barrierDir, 'ready-A')) && existsSync(join(barrierDir, 'ready-B')))) {",
    "  if (Date.now() > deadline) { console.error('barrier timeout'); process.exit(2) }",
    '  await sleep(5)',
    '}',
    'for (let i = 0; i < 60; i++) {',
    "  ledgerRecord(ws, { request_id: tag + '-' + i, tool: 'x', payload_hash: 'h', effects: ['command'], state: 'prepared', ok: null, created: new Date().toISOString() })",
    "  ledgerRecord(ws, { request_id: tag + '-' + i, tool: 'x', payload_hash: 'h', effects: ['command'], state: 'succeeded', ok: true })",
    '}',
    "const last = ledgerLookup(ws, tag + '-59')",
    "if (!last || last.state !== 'succeeded') { console.error('child self-check failed'); process.exit(3) }",
    'process.exit(0)',
  ].join('\n'))
  const runChild = (tag) => new Promise((resolve) => {
    const ch = spawn(process.execPath, [childPath, ledgerPath, tag, barrierDir, TMP], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } })
    let err = ''
    ch.stderr.on('data', d => { err += d })
    ch.on('exit', (code) => resolve({ code, err }))
  })
  const [ra, rb] = await Promise.all([runChild('A'), runChild('B')])
  assert(ra.code === 0, '④ 子进程 A 正常完成（code=' + ra.code + ' err=' + ra.err.slice(0, 120) + '）')
  assert(rb.code === 0, '④ 子进程 B 正常完成（code=' + rb.code + ' err=' + rb.err.slice(0, 120) + '）')
  let missing = []
  for (const tag of ['A', 'B']) {
    for (let i = 0; i < 60; i++) {
      const hit = ledger.ledgerLookup(TMP, tag + '-' + i)
      if (!hit || hit.state !== 'succeeded' || hit.tool !== 'x') missing.push(tag + '-' + i)
    }
  }
  assert(missing.length === 0, '④ 120 条跨进程并发记录全量不丢且终态正确（缺 ' + missing.length + ' 条：' + missing.slice(0, 5).join(',') + '）')
}

console.log('== test-invoke-ledger-concurrency: ' + pass + ' passed, ' + fail + ' failed ==')
process.exit(fail > 0 ? 1 : 0)
