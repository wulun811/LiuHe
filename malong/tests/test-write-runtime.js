// test-write-runtime.js — write-runtime 关键路径（r36）
// 覆盖：renameRetry 重试语义（winfix 新增，此前零测试）——
//   EPERM 重试成功 / EBUSY 重试后放弃 / 非重试错误立即抛 / 成功路径一次调用
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}
const wr = await import(pathToFileURL(join(__dirname, '..', 'write-runtime.js')).href)

const TMP = join(os.tmpdir(), 'opencode', 'write-runtime-test')
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
mkdirSync(TMP, { recursive: true })

// ── 成功路径：一次调用 ──
{
  const from = join(TMP, 'a.txt'), to = join(TMP, 'b.txt')
  writeFileSync(from, 'x')
  let calls = 0
  await wr.renameRetry(from, to, () => { calls++ })
  assert(calls === 1, '成功路径恰好调用一次')
}

// ── EPERM 重试成功后继续 ──
{
  const from = join(TMP, 'c.txt'), to = join(TMP, 'd.txt')
  writeFileSync(from, 'x')
  let attempts = 0
  const flaky = () => {
    attempts++
    if (attempts <= 2) { const e = new Error('perm'); e.code = 'EPERM'; throw e }
  }
  await wr.renameRetry(from, to, flaky)
  assert(attempts === 3, `EPERM 重试 2 次后成功（共 3 次尝试，实际 ${attempts}）`)
}

// ── EPERM 超过上限放弃 ──
{
  const from = join(TMP, 'e.txt'), to = join(TMP, 'f.txt')
  writeFileSync(from, 'x')
  let attempts = 0
  const always = () => {
    attempts++
    const e = new Error('perm'); e.code = 'EPERM'; throw e
  }
  let threw = null
  try { await wr.renameRetry(from, to, always) } catch (e) { threw = e }
  assert(threw && threw.code === 'EPERM', 'EPERM 连续 4 次后上抛')
  assert(attempts === 4, `重试上限 = 首次 + 3 次重试（实际 ${attempts} 次尝试）`)
}

// ── EBUSY 同样重试 ──
{
  let attempts = 0
  const busyOnce = () => {
    attempts++
    if (attempts === 1) { const e = new Error('busy'); e.code = 'EBUSY'; throw e }
  }
  const from = join(TMP, 'g.txt'), to = join(TMP, 'h.txt')
  writeFileSync(from, 'x')
  await wr.renameRetry(from, to, busyOnce)
  assert(attempts === 2, 'EBUSY 重试 1 次后成功')
}

// ── 非重试错误立即抛（不浪费重试）──
{
  const from = join(TMP, 'i.txt'), to = join(TMP, 'j.txt')
  writeFileSync(from, 'x')
  let attempts = 0
  const notRetryable = () => {
    attempts++
    const e = new Error('noent'); e.code = 'ENOENT'; throw e
  }
  let threw = null
  try { await wr.renameRetry(from, to, notRetryable) } catch (e) { threw = e }
  assert(threw && threw.code === 'ENOENT', '非重试错误上抛')
  assert(attempts === 1, `非重试错误只尝试 1 次（实际 ${attempts}）`)
}

// ── R22-⑦（并发拷打）：patch 缺省 new_string 挂 warning（显式空串/显式 new_string 不挂）──
{
  const wsMod = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-write-symbols', 'handler.js')).href)
  const wsDir = join(TMP, 'patch-warn')
  mkdirSync(wsDir, { recursive: true })
  writeFileSync(join(wsDir, 'f.js'), 'const a = 1\nconst b = 2\n')
  const ctx = { getWorkspaceDir: (w) => w }
  const r1 = await wsMod.handle({ workspace_dir: wsDir, writes: [{ file_path: 'f.js', edit_mode: 'patch', patch: { old_string: 'const a = 1' } }], allow_unsafe_no_base: true }, ctx)
  assert(r1.success === true && typeof r1.items?.[0]?.warning === 'string' && r1.items[0].warning.includes('new_string omitted'), `缺省 new_string 挂 warning（得 ${r1.items?.[0]?.warning?.slice(0, 40)}）`)
  const r2 = await wsMod.handle({ workspace_dir: wsDir, writes: [{ file_path: 'f.js', edit_mode: 'patch', patch: { old_string: 'const b = 2', new_string: 'const b = 3' } }], allow_unsafe_no_base: true }, ctx)
  assert(r2.success === true && !r2.items?.[0]?.warning, '显式 new_string 不挂 warning')
  const r3 = await wsMod.handle({ workspace_dir: wsDir, writes: [{ file_path: 'f.js', edit_mode: 'patch', patch: { old_string: 'const b = 3', new_string: '' } }], allow_unsafe_no_base: true }, ctx)
  assert(r3.success === true && !r3.items?.[0]?.warning && !readFileSync(join(wsDir, 'f.js'), 'utf-8').includes('const b = 3'), '显式空串（合法删除）不挂 warning 且删除生效')
}

try { rmSync(TMP, { recursive: true, force: true }) } catch {}
console.log(`== test-write-runtime: ${pass} passed, ${fail} failed ==`)
if (fail > 0) process.exit(1)
