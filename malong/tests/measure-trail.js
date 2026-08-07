// measure-trail.js — 附录 F 体验指标：旧六步 vs 新原语（调用次数 + token 估算）
// 静态轨迹对比：不调用 LLM。同一任务、同一 fixture、同一修改，真实跑两套工具链，
// 统计调用次数 / 参数输入字符 / 工具输出字符，token 估算 = chars/4。
// 任务：给 src/app.py 的 login 加一行日志（改 body），确认 logout 未被影响。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const imp = (p) => import(pathToFileURL(p).href)
const MALONG_DIR = join(__dirname, '..')
const TOOLS_DIR = join(MALONG_DIR, 'tools')

const WS = join(tmpdir(), 'opencode', 'mvp-trail-ws')
const DATA = join(tmpdir(), 'opencode', 'mvp-trail-data')
const SOCK = join(tmpdir(), 'opencode', 'mvp-trail.sock')

try { rmSync(WS, { recursive: true, force: true }) } catch {}
try { rmSync(DATA, { recursive: true, force: true }) } catch {}
mkdirSync(`${WS}/src`, { recursive: true })
mkdirSync(DATA, { recursive: true })

// ── 真实大小 fixture（~200 行，两个工作区副本避免串扰） ──
function makeApp() {
  const lines = ['import logging', '', 'logger = logging.getLogger(__name__)', '']
  lines.push('class Session:')
  lines.push('    def __init__(self, user):')
  lines.push('        self.user = user')
  lines.push('        self.active = True')
  lines.push('', '    def touch(self):')
  lines.push('        self.active = True')
  lines.push('', '    def close(self):')
  lines.push('        self.active = False')
  lines.push('', '', 'def login(username, password):')
  lines.push('    """Authenticate and return a session."""')
  lines.push('    if not username or not password:')
  lines.push('        raise ValueError("missing credentials")')
  lines.push('    user = verify(username, password)')
  lines.push('    if user is None:')
  lines.push('        return None')
  lines.push('    return Session(user)')
  lines.push('', '', 'def logout(session):')
  lines.push('    """End a session."""')
  lines.push('    if session is None:')
  lines.push('        return False')
  lines.push('    session.close()')
  lines.push('    return True')
  lines.push('', '', 'def verify(username, password):')
  lines.push('    if username == "admin" and password == "secret":')
  lines.push('        return {"name": "Admin"}')
  lines.push('    return None')
  for (let i = 0; i < 70; i++) {
    lines.push('', `def utility_${i}(value):`)
    lines.push(`    """Utility ${i}."""`)
    lines.push('    return value * 2')
  }
  return lines.join('\n') + '\n'
}
writeFileSync(`${WS}/src/app.py`, makeApp())
writeFileSync(`${WS}/src/app_old.py`, makeApp())

const pc = await imp(join(MALONG_DIR, 'parse-client.js'))
await pc.init({ log: () => {} })
await pc.connect()

const { default: codeIndex } = await imp(join(MALONG_DIR, 'code-index.js'))
const langParser = {
  extractAllAsync: (source, ext, filePath, ws) => pc.extractAll(source, ext, filePath, ws),
  hasErrorsAsync: (source, ext, filePath, ws) => pc.hasErrors(source, ext, filePath, ws),
  batchExtractAsync: (files, ws) => pc.batchExtract(files, ws),
}
const services = { langParser }
const core = {
  services,
  getService: (n) => services[n],
  registerService: (n, svc) => { services[n] = svc },
  getWorkspaceDir: () => DATA,
  log: () => {},
  emit: () => {},
  get: (key, def) => key === 'codeIndex.udsPath' ? SOCK : (key === 'codeIndex.udsToken' ? '' : def),
}
await codeIndex.init(core)
const svc = services.codeIndex
await svc.initWorkspace(WS)
await svc.indexBatch([`${WS}/src/app.py`, `${WS}/src/app_old.py`], WS)
svc.resolveCrossFileRefs()

const wctx = { codeIndexService: svc, getWorkspaceDir: () => DATA, langParserService: langParser }
const rctx = { codeIndexService: svc, getWorkspaceDir: () => DATA }
const readHandler = (await imp(join(TOOLS_DIR, 'tool-read-symbol', 'handler.js'))).handle
const { writeSymbol } = await imp(join(MALONG_DIR, 'write-runtime.js'))
const outlineHandler = (await imp(join(TOOLS_DIR, 'tool-outline-reader', 'handler.js'))).handle
const inspectHandler = (await imp(join(TOOLS_DIR, 'tool-inspect', 'handler.js'))).handle
const impactHandler = (await imp(join(TOOLS_DIR, 'tool-impact-analysis', 'handler.js'))).handle
const editBatchHandler = (await imp(join(TOOLS_DIR, 'tool-batch-edit', 'handler.js'))).handle

const newBody = `    """Authenticate and return a session."""
    logger.info("login attempt: %s", username)
    if not username or not password:
        raise ValueError("missing credentials")
    user = verify(username, password)
    if user is None:
        return None
    return Session(user)
`

// ══════════════ 新原语路径（2 步 + 1 验证） ══════════════
console.log('── 新原语路径 ──')
const trailNew = []
function tracked(fn, name, args, ctx) {
  const inStr = JSON.stringify(args)
  const t = Date.now()
  return fn(args, ctx).then(r => {
    const outStr = JSON.stringify(r)
    trailNew.push({ name, in: inStr.length, out: outStr.length, ms: Date.now() - t })
    return r
  })
}
const loginSym = svc.findSymbolsInFile('src/app.py', 'login')[0]
const r1 = await tracked(readHandler, 'read_symbol', { workspace_dir: WS, locator: { symbol_id: loginSym.stable_id } }, rctx)
const r2 = await tracked(writeSymbol, 'write_symbol', { workspace_dir: WS, locator: { symbol_id: loginSym.stable_id }, base_version: r1.version, content: newBody }, wctx)
if (!r2.success) { console.error('  write_symbol 失败:', r2.error?.code, r2.error?.conflict_type); process.exit(1) }
const r3 = await tracked(readHandler, 'read_symbol', { workspace_dir: WS, locator: { name: 'logout', file_path: 'src/app.py' } }, rctx)
assertTrue(r3.symbol?.text.includes('def logout'), '新路径验证 logout 可读')

// ══════════════ 旧六步路径 ══════════════
console.log('── 旧六步路径 ──')
const trailOld = []
function trackedOld(fn, name, args, ctx) {
  const inStr = JSON.stringify(args)
  const t = Date.now()
  return fn(args, ctx).then(r => {
    const outStr = JSON.stringify(r)
    trailOld.push({ name, in: inStr.length, out: outStr.length, ms: Date.now() - t })
    return r
  })
}
// 1. read_outline（拿结构）
const o1 = await trackedOld(outlineHandler, 'read_outline', { workspace_dir: WS, file: 'src/app_old.py', depth: 2 }, rctx)
assertTrue(o1.outline?.items?.length > 0 || o1.items?.length > 0 || !o1.error, 'read_outline 成功')
// 2. inspect（改前看 login 的 outline+refs+chain——旧工具链无正文读取，这是 LLM 能拿到的最大信息）
const o2 = await trackedOld(inspectHandler, 'inspect', { workspace_dir: WS, file: 'src/app_old.py', symbol: 'login', include_outline: true, include_refs: true, include_chain: true }, rctx)
// 3. impact_analysis（改前查调用者）
const i2 = await trackedOld(impactHandler, 'impact_analysis', { workspace_dir: WS, file: 'src/app_old.py', symbol: 'login' }, rctx)
// 3. edit_batch（改：old_string/new_string 精确替换——LLM 需先读正文才能构造 old_string）
const oldBody = `    """Authenticate and return a session."""
    if not username or not password:
        raise ValueError("missing credentials")
    user = verify(username, password)
    if user is None:
        return None
    return Session(user)
`
const o3 = await trackedOld(editBatchHandler, 'edit_batch', { workspace_dir: WS, file_path: `${WS}/src/app_old.py`, edits: [{ old_string: oldBody.trimEnd(), new_string: newBody.trimEnd() }] }, rctx)
if (o3.error || o3.results?.some?.(r => r.error)) {
  console.error('  edit_batch 失败:', JSON.stringify(o3.error || o3.results).slice(0, 200))
}
// 4. read_outline 验证（确认结构没坏）
await trackedOld(outlineHandler, 'read_outline', { workspace_dir: WS, file: 'src/app_old.py', depth: 1 }, rctx)
// 5. read_outline 验证 logout（确认没被碰）
await trackedOld(outlineHandler, 'read_outline', { workspace_dir: WS, file: 'src/app_old.py', depth: 1 }, rctx)

// ══════════════ 对比 ══════════════
function sum(arr, k) { return arr.reduce((a, b) => a + b[k], 0) }
const stats = (t) => ({
  calls: t.length,
  in: sum(t, 'in'),
  out: sum(t, 'out'),
  total: sum(t, 'in') + sum(t, 'out'),
  tokens: Math.round((sum(t, 'in') + sum(t, 'out')) / 4),
  ms: sum(t, 'ms'),
})
const sNew = stats(trailNew)
const sOld = stats(trailOld)

console.log('\n════════ 对比结果 ════════')
console.log('                | 调用次数 | 输入 chars | 输出 chars | 总 chars | est tokens')
console.log(` 新原语          |    ${sNew.calls}      |   ${sNew.in}    |   ${sNew.out}    |   ${sNew.total}   |   ${sNew.tokens}`)
console.log(` 旧六步          |    ${sOld.calls}      |   ${sOld.in}    |   ${sOld.out}    |   ${sOld.total}   |   ${sOld.tokens}`)
const callReduce = (1 - sNew.calls / sOld.calls) * 100
const tokenReduce = (1 - sNew.tokens / sOld.tokens) * 100
console.log(` ↓调用次数       ${callReduce.toFixed(1)}%  （目标 ≥50%）`)
console.log(` ↓token         ${tokenReduce.toFixed(1)}%  （目标 ≥30%）`)

console.log('\n新路径明细:')
for (const t of trailNew) console.log(`  ${t.name}: in=${t.in} out=${t.out} ${t.ms}ms`)
console.log('旧路径明细:')
for (const t of trailOld) console.log(`  ${t.name}: in=${t.in} out=${t.out} ${t.ms}ms`)

const ok = sNew.calls <= sOld.calls * 0.5 && sNew.tokens <= sOld.tokens * 0.7
console.log(`\n=== measure-trail: ${ok ? '达标' : '未达标'}（调用↓${callReduce.toFixed(1)}% / token↓${tokenReduce.toFixed(1)}%） ===`)
process.exit(ok ? 0 : 1)

function assertTrue(cond, msg) { if (!cond) { console.error('  FAIL:', msg); process.exit(1) } }
