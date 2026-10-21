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

// ── live 审查 G4：文件级删除 patch 后，同文件后续符号项必须计入删除 delta（旧实现 offset 丢账错位）──
{
  const wsMod = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-write-symbols', 'handler.js')).href)
  const wsDir = join(TMP, 'delta-del')
  mkdirSync(wsDir, { recursive: true })
  writeFileSync(join(wsDir, 'd.js'), [
    'const del = 1',
    'function keep() {',
    '  return 1',
    '}',
    'function target() {',
    '  return 2',
    '}',
  ].join('\n') + '\n')
  const idx = {
    initWorkspace: async () => {},
    findSymbolsInFile: (file, name) => name === 'target'
      ? [{ name: 'target', type: 'function', start_line: 5, end_line: 7, stable_id: 'js:d.js::target#function', signature: 'function target() {' }]
      : [],
    getSymbolByStableId: () => null,
    updateContentHash: () => {},
    markIndexDirty: () => {},
    getFileByPath: () => null,
    indexFile: async () => ({ symbols: 2 }),
  }
  const r = await wsMod.handle({
    workspace_dir: wsDir,
    writes: [
      { file_path: 'd.js', edit_mode: 'patch', patch: { old_string: 'const del = 1\n' } },
      { file_path: 'd.js', edit_mode: 'replace_symbol', locator: { name: 'target' }, content: 'function target() {\n  return 3\n}' },
    ],
    allow_unsafe_no_base: true,
  }, { getWorkspaceDir: (w) => w, codeIndexService: idx })
  const out = readFileSync(join(wsDir, 'd.js'), 'utf-8')
  assert(r.success === true, `G4 批量成功（得 ${JSON.stringify(r.error || r.success)}）`)
  assert(out.includes('return 3') && out.includes('function keep()') && out.includes('return 1'), 'G4 删除后同文件符号项定位正确')
  assert((out.match(/function target\(\)/g) || []).length === 1, `G4 target 签名不重复（旧 offset 丢账会重签名；得 ${JSON.stringify(out)}）`)
  assert(!out.includes('return 2'), 'G4 旧 body 已被替换')
}

// ── live 审查 H1：同批重复编辑同一符号 → DUPLICATE_SYMBOL_EDIT（拒绝而非静默错位）──
{
  const wsMod = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-write-symbols', 'handler.js')).href)
  const wsDir = join(TMP, 'dup-sym')
  mkdirSync(wsDir, { recursive: true })
  writeFileSync(join(wsDir, 'e.js'), 'function target() {\n  return 1\n}\n')
  const idx = {
    initWorkspace: async () => {},
    findSymbolsInFile: (file, name) => name === 'target' ? [{ name: 'target', type: 'function', start_line: 1, end_line: 3, stable_id: 'js:e.js::target#function', signature: 'function target() {' }] : [],
    getSymbolByStableId: () => null,
    updateContentHash: () => {},
    markIndexDirty: () => {},
    getFileByPath: () => null,
    indexFile: async () => ({ symbols: 1 }),
  }
  const r = await wsMod.handle({
    workspace_dir: wsDir,
    writes: [
      { file_path: 'e.js', edit_mode: 'replace_symbol', locator: { name: 'target' }, content: 'function target() {\n  return 2\n}' },
      { file_path: 'e.js', edit_mode: 'replace_symbol', locator: { name: 'target' }, content: 'function target() {\n  return 3\n}' },
    ],
    allow_unsafe_no_base: true,
  }, { getWorkspaceDir: (w) => w, codeIndexService: idx })
  const code = r?.error?.code || r?.error
  assert(r.success === false && code === 'DUPLICATE_SYMBOL_EDIT', `同符号重复编辑被拒（得 success=${r.success} error=${JSON.stringify(r.error)}）`)
  assert(r.error?.itemIndex === 1 || r.error?.item_index === 1, `拒绝时给出输入下标 1（得 ${r.error?.itemIndex ?? r.error?.item_index}）`)
  assert(/file-level read_ref/.test(r.error?.suggestion || ''), `DUPLICATE 建议改为 file 级 read_ref 重试（不再诱导逐处拆分；得 ${r.error?.suggestion}）`)
}

// ── live 审查 K4：insert_after_symbol 的 new_version 必须描述原符号（旧按替换公式算，行数不一致时错位）──
{
  const wsMod = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-write-symbol', 'handler.js')).href)
  const wsDir = join(TMP, 'ins-after')
  mkdirSync(wsDir, { recursive: true })
  writeFileSync(join(wsDir, 'g.js'), 'function anchor() {\n  return 1\n}\n')
  const idx = {
    initWorkspace: async () => {},
    findSymbolsInFile: (file, name) => name === 'anchor' ? [{ name: 'anchor', type: 'function', start_line: 1, end_line: 3, stable_id: 'js:g.js::anchor#function', signature: 'function anchor() {' }] : [],
    getSymbolByStableId: () => null,
    updateContentHash: () => {},
    markIndexDirty: () => {},
    getFileByPath: () => null,
    indexFile: async () => ({ symbols: 2 }),
  }
  const r = await wsMod.handle({
    workspace_dir: wsDir,
    edit_mode: 'insert_after_symbol',
    locator: { name: 'anchor', file_path: 'g.js' },
    content: 'export const added = 1',
    allow_unsafe_no_base: true,
  }, { getWorkspaceDir: (w) => w, codeIndexService: idx })
  const nv = r.new_version?.symbol
  assert(r.success === true && nv && nv.range[0] === 1 && nv.range[1] === 3, `K4: insert_after 的 new_version 描述原符号 range [1,3]（得 ${JSON.stringify(nv?.range)}）`)
  assert(readFileSync(join(wsDir, 'g.js'), 'utf-8').includes('export const added = 1'), 'K4: 插入内容已落盘')
}

// ── 第二轮审查 O3：atomicWrite 终败不留 .txn-* 临时文件（旧实现重试耗尽直接抛，残留用户仓库）──
{
  const { atomicWrite } = await import(pathToFileURL(join(__dirname, '..', 'path-guard.js')).href)
  const { readdirSync } = await import('node:fs')
  const dir = join(TMP, 'atomic-fail')
  mkdirSync(join(dir, 'target-as-dir'), { recursive: true })
  let threw = false
  try { atomicWrite(join(dir, 'target-as-dir'), 'x') } catch { threw = true }
  assert(threw, 'O3: rename 到目录 → 抛错（前置）')
  const leftovers = readdirSync(dir).filter(f => f.includes('.txn-'))
  assert(leftovers.length === 0, `O3: 终败无 .txn-* 残留（得 ${JSON.stringify(leftovers)}）`)
}

// ── 版本 size 必须为 UTF-8 字节（旧 String.length=码元，与读侧 statSync 字节不一致；DSH 狗粮 2026-10-13） ──
{
  const wsDir = join(TMP, 'size-bytes')
  mkdirSync(wsDir, { recursive: true })
  writeFileSync(join(wsDir, 'z.js'), '// 中文注释：字节≠码元\nconst val = 1\n')
  const idx = {
    initWorkspace: async () => {},
    findSymbolsInFile: () => [],
    getSymbolByStableId: () => null,
    updateContentHash: () => {},
    markIndexDirty: () => {},
    getFileByPath: () => null,
    indexFile: async () => ({ symbols: 0 }),
  }
  const ctx2 = { getWorkspaceDir: (w) => w, codeIndexService: idx }
  const okR = await wr.writeSymbol({
    workspace_dir: wsDir, edit_mode: 'patch', locator: { file_path: 'z.js' },
    patch: { old_string: 'const val = 1', new_string: 'const val = 2' },
    allow_unsafe_no_base: true,
  }, ctx2)
  const finalContent = readFileSync(join(wsDir, 'z.js'), 'utf-8')
  const bytes = Buffer.byteLength(finalContent, 'utf-8')
  assert(okR.success === true, `size: 写成功（得 ${JSON.stringify(okR.error)}）`)
  assert(okR.new_version?.file?.size === bytes, `size: new_version.file.size = UTF-8 字节 ${bytes}（得 ${okR.new_version?.file?.size}）`)
  assert(bytes !== finalContent.length, `size 前置：本例字节≠码元（bytes=${bytes} units=${finalContent.length}）`)
  const conflictR = await wr.writeSymbol({
    workspace_dir: wsDir, edit_mode: 'patch', locator: { file_path: 'z.js' },
    patch: { old_string: 'const val = 2', new_string: 'const val = 3' },
    base_version: { file: { hash: 'sha256:' + '0'.repeat(64) } },
  }, ctx2)
  assert(conflictR.success === false && conflictR.current_version?.file?.size === bytes, `size: 冲突 current_version.file.size = UTF-8 字节 ${bytes}（得 ${conflictR.current_version?.file?.size}）`)
}

try { rmSync(TMP, { recursive: true, force: true }) } catch {}
console.log(`== test-write-runtime: ${pass} passed, ${fail} failed ==`)
if (fail > 0) process.exit(1)
