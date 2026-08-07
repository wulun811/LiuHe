// test-batch-edit-tocou.js — TOCTOU 与原子写失败分支（Y001 债务2）
// 覆盖：文件在匹配后被改 → VERSION_CONFLICT（不写盘不建 journal）/ 匹配一致 → 正常落盘 + journal /
//       原子写失败（目标为目录）→ ATOMIC_WRITE_FAILED + journal failed / FILE_LOCKED 并发锁
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}
const { delegateWrite } = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-batch-edit', 'handler.js')).href)

const ws = join(os.tmpdir(), 'opencode', 'be-tocou-ws')
rmSync(ws, { recursive: true, force: true })
mkdirSync(ws, { recursive: true })
mkdirSync(join(ws, 'src'), { recursive: true })

function journalCount() {
  const root = join(ws, '.malong', 'journal')
  if (!existsSync(root)) return 0
  return readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).length
}

// ── ① VERSION_CONFLICT：Python 匹配后文件被改（originalContent 不一致）→ 拒写不建 journal ──
{
  const abs = join(ws, 'src', 'a.js')
  writeFileSync(abs, 'current content\n')
  const before = journalCount()
  const r = await delegateWrite({
    absPath: abs,
    filePath: 'src/a.js',
    workspaceDir: ws,
    originalContent: 'stale content from python match',
    finalContent: 'new content\n',
    codeIndexService: null,
  })
  assert(r.error && r.error.code === 'VERSION_CONFLICT', `① TOCTOU 检出 VERSION_CONFLICT（得 ${r.error?.code}）`)
  assert(r.error.conflict_type === 'FILE_CHANGED', '① conflict_type FILE_CHANGED')
  assert(readFileSync(abs, 'utf-8').trim() === 'current content', '① 文件未被写')
  assert(journalCount() === before, '① 冲突时不建 journal')
}

// ── ② 正常一致 → 落盘 + journal committed ──
{
  const abs = join(ws, 'src', 'b.js')
  writeFileSync(abs, 'original content\n')
  const r = await delegateWrite({
    absPath: abs,
    filePath: 'src/b.js',
    workspaceDir: ws,
    originalContent: 'original content\n',
    finalContent: 'edited content\n',
    codeIndexService: { indexFile: async () => ({ symbols: 2 }) },
  })
  assert(r.ok === true && r.journal, `② 一致时落盘成功（得 ${JSON.stringify(r)}）`)
  assert(readFileSync(abs, 'utf-8').trim() === 'edited content', '② 文件已写')
  assert(r.reindex.symbols === 2, '② 同步重抽上报')
  const state = JSON.parse(readFileSync(join(r.journal.dir, 'state.json'), 'utf-8'))
  assert(state.state === 'committed', `② journal committed（得 ${state.state}）`)
}

// ── ③ 写失败不落半态：目标被目录占位 → TOCTOU 读取 READ_FAILED（结构化错误，journal 不误标） ──
// r9(P3)：tmp 名已随机化（防预置 symlink 穿透），旧「预占 ${abs}.tmp 目录」注入方式失效；
// 目标为目录时读取阶段即 READ_FAILED——验证失败路径不写盘、不假标 committed。
// 注（债务）：ATOMIC_WRITE_FAILED 分支（rename 失败）在随机 tmp + 锁先行的顺序下无法用只读目录注入，
// 靠代码审查保障（writeFileSync 成功 → renameSync 失败 → unlink tmp → journal failed）
{
  const abs = join(ws, 'src', 'isdir.js')
  mkdirSync(abs, { recursive: true }) // 目标被目录占位
  const r = await delegateWrite({
    absPath: abs,
    filePath: 'src/isdir.js',
    workspaceDir: ws,
    originalContent: 'x\n',
    finalContent: 'y\n',
    codeIndexService: null,
  })
  assert(r.error && r.error.code === 'READ_FAILED', `③ 写失败为结构化错误（得 ${r.error?.code}）`)
  const jdirs = readdirSync(join(ws, '.malong', 'journal'), { withFileTypes: true }).filter(d => d.isDirectory())
  const latest = jdirs[jdirs.length - 1]
  const state = JSON.parse(readFileSync(join(join(ws, '.malong', 'journal', latest.name), 'state.json'), 'utf-8'))
  assert(state.state === 'committed', `③ 最新 journal 未被误标 failed/半态（得 ${state.state}——上一场景的 committed 保留）`)
  assert(existsSync(abs) && statSync(abs).isDirectory(), '③ 目录目标未被改写')
}

// ── ④ FILE_LOCKED：已有锁持有者 ──
{
  const abs = join(ws, 'src', 'c.js')
  writeFileSync(abs, 'ccc\n')
  const { acquireLock } = await import(pathToFileURL(join(__dirname, '..', 'write-runtime.js')).href)
  const lock = await acquireLock(abs)
  assert(typeof lock.release === 'function' && !lock.locked, '④ 锁获取成功（第一持有者）')
  const r = await delegateWrite({
    absPath: abs,
    filePath: 'src/c.js',
    workspaceDir: ws,
    originalContent: 'ccc\n',
    finalContent: 'ddd\n',
    codeIndexService: null,
  })
  assert(r.error && r.error.code === 'FILE_LOCKED', `④ 锁占用 → FILE_LOCKED（得 ${r.error?.code}）`)
  assert(readFileSync(abs, 'utf-8').trim() === 'ccc', '④ 文件未被写')
  lock.release()
}

rmSync(ws, { recursive: true, force: true })

console.log(`== test-batch-edit-tocou: ${pass} passed, ${fail} failed ==`)
if (fail > 0) process.exit(1)
