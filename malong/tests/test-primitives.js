// test-primitives.js — 原语化 P1+P2+P3 端到端验证（附录 F：冲突矩阵/幂等/同步重抽/降级）
// 依赖：malong-parse 服务在跑（真实 parse 校验）。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const imp = (p) => import(pathToFileURL(p).href)
const MALONG_DIR = join(__dirname, '..')
const TOOLS_DIR = join(MALONG_DIR, 'tools')

let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}

const WS = join(tmpdir(), 'opencode', 'prim-ws')
const DATA = join(tmpdir(), 'opencode', 'prim-data')
const SOCK = join(tmpdir(), 'opencode', 'prim-code-index.sock')

try { rmSync(WS, { recursive: true, force: true }) } catch {}
try { rmSync(DATA, { recursive: true, force: true }) } catch {}
for (const d of [`${WS}/src`, DATA]) mkdirSync(d, { recursive: true })

// ── fixture：Python 嵌套 + 装饰器 + 同名兄弟 ──
writeFileSync(`${WS}/src/auth.py`, `class AuthService:
    def __init__(self, backend):
        self.backend = backend

    def login(self, username, password):
        """Login user."""
        token = self.backend.issue(username)
        return token

    def login(self, username, password, remember=False):
        """Overload stub."""
        return False

def helper(x):
    def inner(y):
        return x + y
    return inner

def helper(x, scale=1):
    return x * scale
`)

// ── fixture：非代码文件（降级路径，附录 E）──
writeFileSync(`${WS}/README.md`, `# Test

Some doc line.

## Section

Config value: 42
`)
writeFileSync(`${WS}/long.txt`, 'line\n'.repeat(300))

// ── fixture：JS（同文件同名方法消歧）──
writeFileSync(`${WS}/src/client.js`, `class SessionManager {
  create(session) {
    return session;
  }
  destroy(session) {
    return session;
  }
}
`)

// ── 起真实 code-index ──
const pc = await imp(join(MALONG_DIR, 'parse-client.js'))
await pc.init({ log: () => {} })
const connected = await pc.connect()
assert(connected, 'parse-client 连接到 malong-parse')

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

const absFiles = ['src/auth.py', 'src/client.js'].map(f => join(WS, f))
await svc.indexBatch(absFiles, WS)
svc.resolveCrossFileRefs()

// 手工回填 README 的 file 行（非代码不建索引；用 code-index 跟踪 content_hash 需行存在）
// —— 直接验证：非代码文件无 files 行 → not_indexed

// ══════════════ P1：符号锚点 ══════════════

console.log('── P1 锚点 ──')
const authSyms = codeIndex._db.prepare('SELECT s.id AS id, s.name, s.type, s.start_line, s.end_line, s.stable_id, s.body_hash, s.signature, s.signature_hash, s.parent_id FROM symbols s JOIN files f ON s.file_id = f.id WHERE f.path = ? ORDER BY s.start_line').all('src/auth.py')
const loginSyms = authSyms.filter(s => s.name === 'login')
assert(loginSyms.length === 2, `P1 两个 login 符号都在（得 ${loginSyms.length}）`)
assert(loginSyms[0].stable_id !== loginSyms[1].stable_id, 'P1 同名 login 消歧后 stable_id 不同')
assert(loginSyms.every(s => s.stable_id.startsWith('py:src/auth.py::AuthService.login#')), `P1 stable_id 格式 lang:path::qualified#kind（得 ${loginSyms.map(s => s.stable_id).join(' / ')}）`)
assert(loginSyms.every(s => s.body_hash && s.signature_hash), 'P1 login 有 body_hash + signature_hash')
assert(loginSyms.every(s => s.parent_id), 'P1 login 的 parent 是 AuthService（嵌套重建）')
assert(loginSyms.every(s => s.signature.includes('def login')), `P1 signature 提取为定义行（得 ${JSON.stringify(loginSyms.map(s => s.signature))}）`)

const helperSyms = authSyms.filter(s => s.name === 'helper')
assert(helperSyms.length === 2 && helperSyms[0].stable_id !== helperSyms[1].stable_id, 'P1 顶层同名 helper 消歧（sig 或 ordinal）')
assert(helperSyms.some(s => s.signature.includes('scale=1')), 'P1 helper(scale=1) 签名区分')

const byStable = svc.getSymbolByStableId(loginSyms[0].stable_id)
assert(byStable && byStable.file_path === 'src/auth.py' && byStable.name === 'login', 'P1 getSymbolByStableId 命中')

const jsSyms = codeIndex._db.prepare('SELECT name, stable_id FROM symbols s JOIN files f ON s.file_id = f.id WHERE f.path = ? AND s.type = ? ORDER BY start_line').all('src/client.js', 'method')
assert(jsSyms.length === 2 && jsSyms.every(s => s.stable_id.startsWith('js:src/client.js::SessionManager.')), `P1 JS 方法 qualified_name（得 ${jsSyms.map(s => s.stable_id).join(' / ')}）`)

// ══════════════ P2：read_symbol ══════════════

console.log('── P2 read_symbol ──')
const readHandler = (await imp(join(TOOLS_DIR, 'tool-read-symbol', 'handler.js'))).handle
const ctx = { codeIndexService: svc, getWorkspaceDir: () => DATA }

const r1 = await readHandler({ workspace_dir: WS, locator: { file_path: 'src/auth.py', symbol_id: loginSyms[0].stable_id }, budget_hint: 400 }, ctx)
assert(r1.symbol?.symbol_id === loginSyms[0].stable_id, 'P2 symbol_id 解析命中')
assert(r1.symbol?.text.includes('backend.issue'), 'P2 正文含真实 body')
assert(r1.version?.file?.hash?.startsWith('sha256:'), 'P2 version.file.hash 是 sha256')
assert(r1.version?.symbol?.body_hash?.startsWith('sha256:'), 'P2 version.symbol.body_hash 是 sha256')
assert(r1.index_status?.state === 'fresh' || r1.index_status?.state === 'dirty' || r1.index_status?.state === 'not_indexed', `P2 index_status 状态（得 ${r1.index_status?.state}）`)
assert(Array.isArray(r1.pipeline) && r1.pipeline.length >= 2, 'P2 pipeline 返回')
assert(!!r1.trace_id, 'P2 trace_id 返回')
assert(r1.budget?.truncated === true || r1.symbol?.text.length <= 400 + 20, 'P2 budget 截断生效（400 字符内）')
// R22-⑨：budget_hint=0 曾被 `|| 1200` 吞为默认——0 = 不截断（effective=100000；LH-011 起 requested 保留原值、增 effective/floor）
const r0 = await readHandler({ workspace_dir: WS, locator: { file_path: 'src/auth.py', symbol_id: loginSyms[0].stable_id }, budget_hint: 0 }, ctx)
assert(r0.budget?.requested === 0 && r0.budget?.effective === 100000 && r0.budget?.truncated === false, `P2 budget_hint=0 → requested=0/effective=100000 不截断（得 requested=${r0.budget?.requested} effective=${r0.budget?.effective} truncated=${r0.budget?.truncated}）`)
const r1200 = await readHandler({ workspace_dir: WS, locator: { file_path: 'src/auth.py', symbol_id: loginSyms[0].stable_id } }, ctx)
assert(r1200.budget?.requested === 1200 && r1200.budget?.effective === 1200, `P2 不传 budget_hint → 默认 1200（得 ${r1200.budget?.requested}/${r1200.budget?.effective}）`)
assert(r1.outline === null, 'P2 core 模式默认不带 outline（省 token）')
const r1Rich = await readHandler({ workspace_dir: WS, locator: { file_path: 'src/auth.py', symbol_id: loginSyms[0].stable_id }, mode: 'rich', budget_hint: 400 }, ctx)
assert(r1Rich.outline?.items?.length > 0, 'P2 rich 模式带 outline 摘要')
assert(r1Rich.navigation?.callers_count !== undefined, 'P2 rich 模式带 navigation')
const r1Force = await readHandler({ workspace_dir: WS, locator: { file_path: 'src/auth.py', symbol_id: loginSyms[0].stable_id }, include_outline: true }, ctx)
assert(r1Force.outline?.items?.length > 0, 'P2 include_outline=true 显式强制带 outline')

const rAmb = await readHandler({ workspace_dir: WS, locator: { file_path: 'src/auth.py', name: 'login' } }, ctx)
// R22-⑯：错误 shape 扁平化——error/code 顶层字段
assert(rAmb.success === false && (rAmb.code === 'AMBIGUOUS_SYMBOL' || rAmb.error?.code === 'AMBIGUOUS_SYMBOL'), 'P2 同名 login → AMBIGUOUS_SYMBOL 不自动选')
assert(Array.isArray(rAmb.candidates || rAmb.error?.candidates) && (rAmb.candidates || rAmb.error?.candidates).length === 2, 'P2 歧义返回 2 个候选（含 symbol_id）')

const rMiss = await readHandler({ workspace_dir: WS, locator: { file_path: 'src/auth.py', name: 'no_such_fn' } }, ctx)
assert(rMiss.success === false && (rMiss.code === 'SYMBOL_NOT_FOUND' || rMiss.error?.code === 'SYMBOL_NOT_FOUND'), 'P2 不存在 → SYMBOL_NOT_FOUND')

const rDeg = await readHandler({ workspace_dir: WS, locator: { file_path: 'README.md', line_range: [3, 5] } }, ctx)
assert(rDeg.symbol?.symbol_id === null && rDeg.symbol?.text.includes('Some doc line'), 'P2 非代码 line_range 降级读')

const rFile = await readHandler({ workspace_dir: WS, locator: { file_path: 'long.txt' }, budget_hint: 200 }, ctx)
assert(rFile.symbol?.text.includes('truncated'), `P2 file 模式降级读 + budget 截断标记（得 ${(rFile.symbol?.text || '').slice(-40)}）`)

// ══════════════ P3：write_symbol ══════════════

console.log('── P3 write_symbol ──')
const { writeSymbol } = await imp(join(MALONG_DIR, 'write-runtime.js'))
const wctx = { codeIndexService: svc, getWorkspaceDir: () => DATA, langParserService: langParser }

// 3.0 无 base_version → NO_BASE 拒（用 patch 模式避免同名歧义干扰）
const wNoBase = await writeSymbol({
  workspace_dir: WS,
  locator: { file_path: 'README.md' },
  edit_mode: 'patch',
  patch: { old_string: 'Config value: 43', new_string: 'Config value: 44' },
  content: 'x',
}, wctx)
assert(wNoBase.success === false && wNoBase.error?.conflict_type === 'NO_BASE', `P3 无 base_version → NO_BASE 拒（得 ${JSON.stringify(wNoBase.error)}）`)
assert(wNoBase.error?.next_action?.tool === 'read_symbol' && wNoBase.error?.next_action?.params?.locator?.file_path === 'README.md', `P3 NO_BASE 带 next_action.read_symbol 指引`)

// 3.1 CLEAN 写入（replace_symbol full，改第二个 login 的 body）
const secondLogin = loginSyms[1]
const rBody1 = await readHandler({ workspace_dir: WS, locator: { symbol_id: secondLogin.stable_id } }, ctx)
const cleanContent = `    def login(self, username, password, remember=False):
        return True
`
const wClean = await writeSymbol({
  workspace_dir: WS,
  locator: { file_path: 'src/auth.py', symbol_id: secondLogin.stable_id },
  base_version: { file: rBody1.version.file, symbol: rBody1.version.symbol },
  content: cleanContent,
  edit_mode: 'replace_symbol',
  boundary: 'full',
}, wctx)
assert(wClean.success === true, `P3 CLEAN 写入成功（得 ${JSON.stringify(wClean.error || wClean.safety_report)}）`)
assert(wClean.txn_id && wClean.undo?.token === wClean.txn_id, 'P3 undo token 返回')
assert(wClean.diff?.patch?.includes('@@'), 'P3 diff 返回 hunk')
assert(wClean.pipeline?.some(p => p.step === 'atomic_write'), 'P3 pipeline 含 atomic_write')
assert(wClean.pipeline?.some(p => p.step === 'reindex'), 'P3 pipeline 含 reindex（同步重抽）')

// 3.2 写后一致性：立刻读回，body 已是新内容（附录 D 同步重抽）
const rAfter = await readHandler({ workspace_dir: WS, locator: { symbol_id: secondLogin.stable_id } }, ctx)
assert(rAfter.symbol?.text.includes('return True'), 'P3 写完立刻可读（同步重抽，未读到旧 range 错内容）')

// 3.3 用旧 base 再写 → SYMBOL_CHANGED 拒
const wStale = await writeSymbol({
  workspace_dir: WS,
  locator: { file_path: 'src/auth.py', symbol_id: secondLogin.stable_id },
  base_version: { file: rBody1.version.file, symbol: rBody1.version.symbol },
  content: cleanContent,
}, wctx)
assert(wStale.success === false && wStale.error?.conflict_type === 'SYMBOL_CHANGED', 'P3 旧 base 再写 → SYMBOL_CHANGED 拒（静默覆盖=0）')
assert(wStale.error?.next_action?.tool === 'read_symbol', 'P3 冲突带 next_action 恢复指引')

// 3.4 SYMBOL_DELETED：符号不存在
const wDel = await writeSymbol({
  workspace_dir: WS,
  locator: { file_path: 'src/auth.py', name: 'ghost_fn' },
  base_version: { file: rBody1.version.file },
  content: 'x',
}, wctx)
assert(wDel.success === false && (wDel.error?.code === 'SYMBOL_NOT_FOUND' || wDel.error?.conflict_type === 'SYMBOL_DELETED'), 'P3 符号不存在 → 拒绝')

// 3.5 FILE_CHANGED_SYMBOL_STABLE：改文件其他位置后写目标符号 → 允许+warn
const helper0 = helperSyms[0]
const before5 = await readHandler({ workspace_dir: WS, locator: { file_path: 'src/auth.py', symbol_id: helper0.stable_id } }, ctx)
// 先改一个无关位置（第一行前插注释）使文件 hash 变，但不动 helper0
const curAuth = readFileSync(`${WS}/src/auth.py`, 'utf-8')
writeFileSync(`${WS}/src/auth.py`, `# note: touched\n${curAuth}`)
const wStable = await writeSymbol({
  workspace_dir: WS,
  locator: { file_path: 'src/auth.py', symbol_id: helper0.stable_id },
  base_version: { file: before5.version.file, symbol: before5.version.symbol },
  content: `def helper(x):
    return x + 100
`,
}, wctx)
assert(wStable.success === true, `P3 文件变/符号未变 → FILE_CHANGED_SYMBOL_STABLE 允许（得 ${JSON.stringify(wStable.error || wStable.safety_report?.collision)}）`)
assert(wStable.safety_report?.collision?.status === 'FILE_CHANGED_SYMBOL_STABLE', 'P3 冲突类型标注 FILE_CHANGED_SYMBOL_STABLE')

// 3.6 patch 幂等：第一次成功，第二次 already_applied
const rH = await readHandler({ workspace_dir: WS, locator: { file_path: 'src/auth.py', symbol_id: helper0.stable_id } }, ctx)
const wP1 = await writeSymbol({
  workspace_dir: WS,
  locator: { file_path: 'src/auth.py', symbol_id: helper0.stable_id },
  base_version: { file: rH.version.file, symbol: rH.version.symbol },
  edit_mode: 'patch',
  patch: { old_string: 'return x + 100', new_string: 'return x + 999' },
}, wctx)
assert(wP1.success === true && !wP1.status, `P3 patch 唯一匹配写入（得 ${JSON.stringify(wP1.error || wP1.diff?.lines_changed)}）`)
const wP2 = await writeSymbol({
  workspace_dir: WS,
  locator: { file_path: 'src/auth.py', symbol_id: helper0.stable_id },
  base_version: { file: wP1.new_version.file, symbol: wP1.new_version.symbol },
  edit_mode: 'patch',
  patch: { old_string: 'return x + 100', new_string: 'return x + 999' },
}, wctx)
assert(wP2.success === true && wP2.status === 'already_applied', `P3 patch 重试 → already_applied（幂等，§16.7）（得 ${JSON.stringify(wP2.error || wP2.status)}）`)

// 3.6b boundary=body 链式写（9-F2：new_version body_hash 须含签名行、与索引约定一致，否则同符号链式写误判 SYMBOL_CHANGED）
const helper1 = helperSyms[1] // helper(x, scale=1)，前序测试未触碰
const rB = await readHandler({ workspace_dir: WS, locator: { file_path: 'src/auth.py', symbol_id: helper1.stable_id } }, ctx)
const wB1 = await writeSymbol({
  workspace_dir: WS,
  locator: { file_path: 'src/auth.py', symbol_id: helper1.stable_id },
  base_version: { file: rB.version.file, symbol: rB.version.symbol },
  edit_mode: 'replace_symbol',
  boundary: 'body',
  content: `    return x * scale + 100\n`,
}, wctx)
assert(wB1.success === true, `P3 3.6b boundary=body 写入成功（得 ${JSON.stringify(wB1.error || 'ok')}）`)
// 拿 new_version 直接链式写同一符号（不重读）—— 旧实现 body_hash 只算 body（不含签名）→ 与预写 full 约定不一致 → 误判 SYMBOL_CHANGED
const wB2 = await writeSymbol({
  workspace_dir: WS,
  locator: { file_path: 'src/auth.py', symbol_id: helper1.stable_id },
  base_version: { file: wB1.new_version.file, symbol: wB1.new_version.symbol },
  edit_mode: 'replace_symbol',
  boundary: 'body',
  content: `    return x * scale + 200\n`,
}, wctx)
assert(wB2.success === true, `P3 3.6b boundary=body 链式写不误判 SYMBOL_CHANGED（9-F2）（得 ${JSON.stringify(wB2.error || wB2.status)}）`)
assert(wB2.safety_report?.collision?.status !== 'SYMBOL_CHANGED', `P3 3.6b 冲突类型非 SYMBOL_CHANGED（得 ${wB2.safety_report?.collision?.status}）`)

// 3.7 patch 歧义：old_string 多处匹配 → AMBIGUOUS（先写入含重复行的 body）
const r7prep = await readHandler({ workspace_dir: WS, locator: { file_path: 'src/auth.py', symbol_id: helper0.stable_id } }, ctx)
const w7prep = await writeSymbol({
  workspace_dir: WS,
  locator: { file_path: 'src/auth.py', symbol_id: helper0.stable_id },
  base_version: { file: r7prep.version.file, symbol: r7prep.version.symbol },
  content: `def helper(x):
    return x + 1
    return x + 1
`,
}, wctx)
assert(w7prep.success === true, 'P3 3.7 准备：写入含重复行的 body')
const r7 = await readHandler({ workspace_dir: WS, locator: { file_path: 'src/auth.py', symbol_id: helper0.stable_id } }, ctx)
const wAmb = await writeSymbol({
  workspace_dir: WS,
  locator: { file_path: 'src/auth.py', symbol_id: helper0.stable_id },
  base_version: { file: r7.version.file, symbol: r7.version.symbol },
  edit_mode: 'patch',
  patch: { old_string: 'return x + 1', new_string: 'return y' },
}, wctx)
assert(wAmb.success === false && wAmb.error?.code === 'PATCH_OLD_STRING_AMBIGUOUS', 'P3 patch 多匹配 → PATCH_OLD_STRING_AMBIGUOUS')

// 3.8 patch 未找到：base 新鲜但 old_string 不存在 → NOT_FOUND（不撞 SYMBOL_CHANGED）
const wMiss = await writeSymbol({
  workspace_dir: WS,
  locator: { file_path: 'src/auth.py', symbol_id: helper0.stable_id },
  base_version: { file: r7.version.file, symbol: r7.version.symbol },
  edit_mode: 'patch',
  patch: { old_string: 'return x + 100', new_string: 'return x + 7' },
}, wctx)
assert(wMiss.success === false && wMiss.error?.code === 'PATCH_OLD_STRING_NOT_FOUND', `P3 patch 找不到 old_string → PATCH_OLD_STRING_NOT_FOUND（得 ${JSON.stringify(wMiss.error || wMiss.status)}）`)

// 3.9 非代码降级：README.md patch + 唯一匹配（附录 E）
const rReadme = await readHandler({ workspace_dir: WS, locator: { file_path: 'README.md' } }, ctx)
const wMd = await writeSymbol({
  workspace_dir: WS,
  locator: { file_path: 'README.md' },
  base_version: { file: rReadme.version.file },
  edit_mode: 'patch',
  patch: { old_string: 'Config value: 42', new_string: 'Config value: 43' },
}, wctx)
assert(wMd.success === true, `P3 非代码 patch 写入（得 ${JSON.stringify(wMd.error || wMd.safety_report?.validation)}）`)
assert(readFileSync(`${WS}/README.md`, 'utf-8').includes('Config value: 43'), 'P3 非代码文件内容真实变更')

// 3.10 非代码 patch 幂等
const wMd2 = await writeSymbol({
  workspace_dir: WS,
  locator: { file_path: 'README.md' },
  base_version: { file: wMd.new_version.file },
  edit_mode: 'patch',
  patch: { old_string: 'Config value: 42', new_string: 'Config value: 43' },
}, wctx)
assert(wMd2.success === true && wMd2.status === 'already_applied', 'P3 非代码 patch 幂等 already_applied')

// 3.11 dry_run 不写盘（用未改过的 login[0]）
const login0 = loginSyms[0]
const rDry = await readHandler({ workspace_dir: WS, locator: { file_path: 'src/auth.py', symbol_id: login0.stable_id } }, ctx)
const beforeDry = readFileSync(`${WS}/src/auth.py`, 'utf-8')
const wDry = await writeSymbol({
  workspace_dir: WS,
  locator: { file_path: 'src/auth.py', symbol_id: login0.stable_id },
  base_version: { file: rDry.version.file, symbol: rDry.version.symbol },
  edit_mode: 'patch',
  patch: { old_string: 'return token', new_string: 'return token_id' },
  dry_run: true,
}, wctx)
assert(wDry.success === true && wDry.dry_run === true, 'P3 dry_run 成功')
assert(readFileSync(`${WS}/src/auth.py`, 'utf-8') === beforeDry, 'P3 dry_run 不写盘')
// 3.11b dry_run 不残留 staged journal（残留 staged 会被下次 recoverJournals 当崩溃事务
// 回滚 → 覆盖后来合法写入，数据丢失 —— 递归进化第 4 轮修复）
const journalRoot = join(WS, '.malong', 'journal')
const stagedAfterDry = existsSync(journalRoot) ? readdirSync(journalRoot).filter(d => {
  try { return JSON.parse(readFileSync(join(journalRoot, d, 'state.json'), 'utf-8')).state === 'staged' } catch { return false }
}) : []
assert(stagedAfterDry.length === 0, `P3 dry_run 不残留 staged journal（得 ${stagedAfterDry.length}）`)

// 3.12 undo journal 落盘 + 状态
assert(existsSync(journalRoot), 'P3 journal 根目录存在')
const txnDirs = readdirSync(journalRoot)
assert(txnDirs.length >= 4, `P3 journal txn 目录存在（得 ${txnDirs.length}）`)
const committedTxns = txnDirs.filter(d => {
  try { return JSON.parse(readFileSync(join(journalRoot, d, 'state.json'), 'utf-8')).state === 'committed' } catch { return false }
})
assert(committedTxns.length >= 4, `P3 committed txn 数 >= 4（得 ${committedTxns.length}）`)
assert(committedTxns.every(d => !stagedAfterDry.includes(d)), 'P3 committed 与 dry_run 残留无交集')
const lastCommitted = committedTxns[committedTxns.length - 1]
assert(existsSync(join(journalRoot, lastCommitted, 'backup')), 'P3 journal backup 存在')

// 3.13 语法校验：写坏 Python 语法 + block_on_validation_error → 拒写
const rBad = await readHandler({ workspace_dir: WS, locator: { file_path: 'src/auth.py', symbol_id: login0.stable_id } }, ctx)
const wBad = await writeSymbol({
  workspace_dir: WS,
  locator: { file_path: 'src/auth.py', symbol_id: login0.stable_id },
  base_version: { file: rBad.version.file, symbol: rBad.version.symbol },
  content: 'def login(self, username, password):\n  this is not python :::\n',
  safety: { block_on_validation_error: true },
}, wctx)
assert(wBad.success === false && wBad.error?.code === 'VALIDATION_FAILED', `P3 block_on_validation_error 拒写（得 ${JSON.stringify(wBad.error || wBad.validation || wBad.safety_report?.validation)}）`)
// dogfood-050（P2 修复）：校验失败必须带装配片段自证（旧实现只有 "syntax errors detected"，无法区分内容/传输问题）
assert(typeof wBad.error?.assembled_excerpt === 'string' && wBad.error.assembled_excerpt.includes('login'), `P3 校验失败带装配片段（得 ${JSON.stringify(wBad.error?.assembled_excerpt)?.slice(0, 80)}）`)
assert(!wBad.error?.hint, 'P3 真实换行内容不误报转义 hint')

// 3.13b Q3：默认拦截策略——standard 拦 fail / skip 不拦 / 显式开关 / fast / strict
const { shouldBlockValidation } = await imp(join(MALONG_DIR, 'write-runtime.js'))
assert(shouldBlockValidation({}, { syntax: { status: 'fail' }, bracket: { status: 'pass' } }) === true, 'Q3 默认 standard 拦 fail')
assert(shouldBlockValidation({}, { syntax: { status: 'skip' }, bracket: { status: 'pass' } }) === false, 'Q3 默认 skip 不拦（避免误伤非 JS/Python）')
assert(shouldBlockValidation({ block_on_validation_error: false }, { syntax: { status: 'fail' }, bracket: { status: 'fail' } }) === false, 'Q3 显式 false 放行')
assert(shouldBlockValidation({ block_on_validation_error: true }, { syntax: { status: 'skip' }, bracket: { status: 'pass' } }) === true, 'Q3 显式 true 含 skip')
assert(shouldBlockValidation({ profile: 'strict' }, { syntax: { status: 'skip' }, bracket: { status: 'pass' } }) === true, 'Q3 strict 含 skip')
assert(shouldBlockValidation({ profile: 'fast' }, { syntax: { status: 'fail' }, bracket: { status: 'fail' } }) === false, 'Q3 fast 不拦')
const wBadDefault = await writeSymbol({
  workspace_dir: WS,
  locator: { file_path: 'src/auth.py', symbol_id: login0.stable_id },
  base_version: { file: rBad.version.file, symbol: rBad.version.symbol },
  content: 'def login(self, username, password):\n  this is not python :::\n',
}, wctx)
const beforeQ3 = readFileSync(`${WS}/src/auth.py`, 'utf-8')
assert(wBadDefault.success === false && wBadDefault.error?.code === 'VALIDATION_FAILED', `Q3 默认（无 safety）坏语法也拒写（得 ${JSON.stringify(wBadDefault.error?.code || wBadDefault.success)}）`)
assert(readFileSync(`${WS}/src/auth.py`, 'utf-8') === beforeQ3, 'Q3 拒写后文件未被破坏')
// dogfood-050（P2 修复）：字面 \n 转义（无真实换行）→ hint 提示 caller 转义问题
const wEsc = await writeSymbol({
  workspace_dir: WS,
  locator: { file_path: 'src/auth.py', symbol_id: login0.stable_id },
  base_version: { file: rBad.version.file, symbol: rBad.version.symbol },
  content: 'def login(self, username, password):\\n  this is not python :::\\n',
}, wctx)
assert(wEsc.success === false && wEsc.error?.code === 'VALIDATION_FAILED', `P3 字面转义内容仍被拦（得 ${JSON.stringify(wEsc.error?.code || wEsc.success)}）`)
assert(typeof wEsc.error?.hint === 'string' && wEsc.error.hint.includes('real newlines'), `P3 字面 \\n 触发转义 hint（得 ${JSON.stringify(wEsc.error?.hint)}）`)

// 3.14 锁：假锁文件 → acquireLock 超时返回 locked（FILE_LOCKED 语义）
const wrMod = await imp(join(MALONG_DIR, 'write-runtime.js'))
const { acquireLock } = wrMod
const fakeLock = `${WS}/src/auth.py.mlock`
writeFileSync(fakeLock, JSON.stringify({ pid: 999999, ts: Date.now() }))
const lock2 = await acquireLock(`${WS}/src/auth.py`, 100)
assert(lock2.locked === true, 'P3 锁存在 → FILE_LOCKED 语义（超时返回 locked）')
unlinkSync(fakeLock)

// 3.15 写后索引同步：重抽后两个 helper 的 body_hash 都应更新（64 hex）
const hNow = codeIndex._db.prepare("SELECT body_hash FROM symbols s JOIN files f ON s.file_id = f.id WHERE f.path = 'src/auth.py' AND s.name = 'helper' AND s.type = 'function'").all()
assert(hNow.length === 2 && hNow.every(h => h.body_hash && h.body_hash.length === 64), `P3 重抽后 helper body_hash 更新（得 ${JSON.stringify(hNow)}）`)

// 3.16 crash recovery 哈希三方判定（staged 不再盲目回滚 —— 递归进化第 4 轮修复）
const { recoverJournals, createJournal, updateJournalState } = await imp(join(MALONG_DIR, 'write-journal.js'))
const { sha256 } = await imp(join(MALONG_DIR, 'hash-utils.js'))
const recWS = `${WS}/rec`
try { rmSync(recWS, { recursive: true, force: true }) } catch {}
mkdirSync(join(recWS, '.malong', 'journal'), { recursive: true })
// 14-C：恢复语义要求写者已死（pid 存活 = 在途事务不处理）——模拟崩溃用已退出子进程的 pid
const { spawnSync } = await import('node:child_process')
const deadPid = spawnSync(process.execPath, ['-e', '']).pid
function deadWriter(dir) { writeFileSync(join(dir, 'pid'), String(deadPid)) }
// 场景 A：当前 == 写前（dryRun 残留/崩溃在 rename 前）→ abandoned，文件不动
writeFileSync(`${recWS}/a.txt`, 'v1')
const ja = createJournal(recWS, 'a.txt', `${recWS}/a.txt`, 'v1', { editMode: 'patch', state: 'staged' })
updateJournalState(ja.dir, { state: 'staged', new_hash: sha256('v2') })
deadWriter(ja.dir)
let rec = await recoverJournals(recWS)
assert(rec.some(r => r.txn_id === ja.txnId && r.action === 'abandoned'), `P3 recovery: staged+当前==写前 → abandoned（得 ${JSON.stringify(rec)}）`)
assert(readFileSync(`${recWS}/a.txt`, 'utf-8') === 'v1', 'P3 recovery: abandoned 不覆盖文件')
// 场景 B：当前 == new_hash（rename 成功、崩溃在 committed 前）→ 补标 committed，文件不动
writeFileSync(`${recWS}/b.txt`, 'v2')
const jb = createJournal(recWS, 'b.txt', `${recWS}/b.txt`, 'v1', { editMode: 'patch', state: 'staged' })
updateJournalState(jb.dir, { state: 'staged', new_hash: sha256('v2') })
deadWriter(jb.dir)
rec = await recoverJournals(recWS)
assert(rec.some(r => r.txn_id === jb.txnId && r.action === 'committed'), `P3 recovery: staged+当前==写后 → committed（得 ${JSON.stringify(rec)}）`)
assert(readFileSync(`${recWS}/b.txt`, 'utf-8') === 'v2', 'P3 recovery: committed 不覆盖新内容')
// 场景 C：当前既非写前也非写后（外部修改过）→ needs_review，绝不覆盖
writeFileSync(`${recWS}/c.txt`, 'EXTERNAL')
const jc = createJournal(recWS, 'c.txt', `${recWS}/c.txt`, 'v1', { editMode: 'patch', state: 'staged' })
updateJournalState(jc.dir, { state: 'staged', new_hash: sha256('v2') })
deadWriter(jc.dir)
rec = await recoverJournals(recWS)
assert(rec.some(r => r.txn_id === jc.txnId && r.action === 'kept_external_change'), `P3 recovery: staged+外部修改 → kept_external_change（得 ${JSON.stringify(rec)}）`)
assert(readFileSync(`${recWS}/c.txt`, 'utf-8') === 'EXTERNAL', 'P3 recovery: 外部修改不被回滚覆盖')
// 场景 D：旧语义回归（真实崩溃在 rename 前 → staged + 当前==写前，旧代码会 rename 覆盖；新代码标 abandoned 同样安全）
assert((await recoverJournals(recWS)).length === 0, 'P3 recovery: 二次运行无重复处理')

// 3.17 括号平衡校验字符串感知（字符串/注释里的括号不是代码结构 —— 递归进化第 4 轮修复）
const { checkBracketBalance } = await imp(join(MALONG_DIR, 'write-edit.js'))
assert(checkBracketBalance('print(")")').ok === true, 'P3 字符串含 ) 不误报 unbalanced')
assert(checkBracketBalance("const s = '(not closed'").ok === true, 'P3 单引号串含 ( 不误报')
assert(checkBracketBalance('const t = `template with }`').ok === true, 'P3 模板串含 } 不误报')
assert(checkBracketBalance('// comment with )').ok === true, 'P3 行注释含 ) 不误报')
assert(checkBracketBalance('/* block ) */ x = 1').ok === true, 'P3 块注释含 ) 不误报')
assert(checkBracketBalance('function f() { return 1 }').ok === true, 'P3 正常代码仍 pass')
assert(checkBracketBalance('function f( { return 1 }').ok === false, 'P3 真不平衡仍报')

// R22 修复 #3b（2026-10-12）：合法 JSON 含 URL 不误报（旧实现先跑 // 注释 regex，吞引号级联误判）
assert(checkBracketBalance('{"resolved":"https://u","integrity":"sha512-abc","version":"1.0.0"}').ok === true, 'R22 #3b 合法 JSON 含 URL 不误报')
assert(checkBracketBalance('const u = "https://x/y"; f(1)').ok === true, 'R22 #3b JS 字符串内 // 不误报')
assert(checkBracketBalance('const u = "https://x/y"; f(1').ok === false, 'R22 #3b 修正后真不平衡仍报')

// 3.18 正则字面量识别 + bracket/syntax 不一致仲裁（P0 修复 2026-10-12：旧降级在 daemon EOF 漏报时吞真失败）
const { reconcileBracketWithSyntax } = await imp(join(MALONG_DIR, 'write-runtime.js'))
assert(checkBracketBalance("function f(x) { return /['\"]/ }\nconst b = /['\"]/").ok === true, 'P0 含引号字符类的正则不再误报（stripper 识别正则）')
assert(checkBracketBalance('const re = /[/]/; f(1)').ok === true, 'P0 字符类内斜杠不提前闭合')
assert(checkBracketBalance('const x = a / b; f(1)').ok === true, 'P0 除法不误判为正则')
assert(checkBracketBalance('function mul(a, b) {\n  return a * b;\n\nmodule.exports = { add, sub, mul };\n').ok === false, 'P0 EOF 未闭合 { 必须报（daemon 漏报类）')
const v1 = reconcileBracketWithSyntax({ syntax: { status: 'pass' }, bracket: { status: 'fail', errors: ['unclosed: {'] } })
assert(v1.bracket.status === 'fail' && v1.bracket.syntax_disagreement === true, 'P0 syntax pass + bracket fail → 保留 fail 并标注 disagreement（不降级）')
assert(shouldBlockValidation({}, v1) === true, 'P0 不一致时 standard 档阻断（防坏文件落盘）')
assert(shouldBlockValidation({ block_on_validation_error: false }, v1) === false, 'P0 显式 override 可放行')
const v2 = reconcileBracketWithSyntax({ syntax: { status: 'skip', reason: 'non-code file' }, bracket: { status: 'fail', errors: ['x'] } })
assert(v2.bracket.status === 'fail', 'P3 syntax skip（非代码）→ bracket 是唯一信号，保留 fail')
const v3 = reconcileBracketWithSyntax({ syntax: { status: 'fail' }, bracket: { status: 'fail', errors: ['x'] } })
assert(v3.bracket.status === 'fail', 'P3 syntax fail → bracket 保留 fail（佐证）')
const v4 = reconcileBracketWithSyntax({ syntax: { status: 'pass' }, bracket: { status: 'pass' } })
assert(v4.bracket.status === 'pass' && !v4.bracket.syntax_disagreement, 'P3 双 pass 不动')

// 3.19 shell / #-语义（2026-10-27 修）：旧 stripLiteralsForBracket 无条件把 # 当注释——bash 的
// ${VAR#pat}/${#ARR[@]} 与 JS 的 #private 被吞到行尾，左侧 { 失衡 → 合法文件被判 bracket fail。
// 真阳性：给含 ${ROOT#/home} 的 ci.sh 只插一行纯注释也遭 VALIDATION_FAILED，报错行号全在未改动处。
// 决策：shell 的括号配对本原理上不可判（${…#…}、case 的 )、heredoc），整体 skip 交语法层；
// # 仅在 Python 系当注释。
assert(checkBracketBalance('P=${ROOT#/home}\n', 'bash').not_applicable === true, 'shell ${VAR#pat} → not_applicable（不得误报）')
assert(checkBracketBalance('P=${ROOT##*/}\nN=${#ARR[@]}\n', 'bash').not_applicable === true, 'shell ${VAR##pat}/${#ARR[@]} → not_applicable')
assert(checkBracketBalance('case "$1" in\n  a) echo a ;;\nesac\n', 'bash').not_applicable === true, 'shell case 的 ) → not_applicable')
assert(checkBracketBalance('cat <<EOF\n{\n(\nEOF\n', 'bash').not_applicable === true, 'shell heredoc 内任意括号 → not_applicable')
assert(checkBracketBalance('#!/bin/bash\nset -euo pipefail\nROOT="$(cd "$(dirname "$0")/.." && pwd)"\n', 'bash').not_applicable === true, 'shell $() 嵌套引号 → not_applicable')
assert(checkBracketBalance('class A {\n  #x = 1\n  get() { return this.#x }\n}\n', 'js').ok === true, 'JS #private 字段不再被当注释吞行')
assert(checkBracketBalance('class A {\n  #x = (1\n}\n', 'js').ok === false, 'JS #private 行内的真失衡仍报')
assert(checkBracketBalance('x = 1  # note (\n', 'py').ok === true, 'Python # 注释仍正常剥离（语义未回退）')
assert(checkBracketBalance('x = {1: 2  # oops (\n', 'py').ok === false, 'Python 真失衡 + 行尾注释仍报')
assert(checkBracketBalance('function f( { return 1 }', 'js').ok === false, 'JS 真失衡仍报（守卫未因分派而失效）')

// 3.20 shell 语法真校验（2026-10-27）：tree-sitter 对 .sh 几乎空转（missing fi/done、未闭合 $(
// 全 has_errors:false），括号启发式又原理性不可判——两侧都不管 = shell 零校验。故 shell 走 bash -n。
// 失败路径：坏写法必须 fail（否则等于没兜底）；合法写法必须 pass（否则又回到误拦）。
const { validateShellSyntax, getShellCmd, _resetShellCmdCache } = await imp(join(MALONG_DIR, 'shell-syntax.js'))
const shellCmd = getShellCmd()
if (!shellCmd) {
  // Windows 无 bash：如实声明未验证，不伪造通过
  console.log('  [SKIP] shell syntax: no bash/sh on this host — 真实校验 NOT_RUN')
} else {
  const shellBad = [
    ['if true; then\n  echo a\n', 'missing fi'],
    ['for i in 1 2; do\n  echo $i\n', 'missing done'],
    ['X=$(date\n', 'unclosed $('],
    ['f() {\n  echo a\n', 'unclosed {'],
    ['echo "abc\n', 'unclosed quote'],
    ['if true\n  echo a\nfi\n', 'missing then'],
    ['case "$1" in\n  a) echo a ;;\n', 'missing esac'],
    ['fi\n', 'stray fi'],
  ]
  for (const [src, name] of shellBad) {
    const r = await validateShellSyntax(src, '.sh')
    assert(r.status === 'fail', `shell 坏写法必须 fail（${name}）—— 得 ${r.status}`)
  }
  const shellGood = [
    ['if true; then\n  for i in 1 2; do\n    echo "$i"\n  done\nfi\n', 'nested if/for'],
    ['P=${ROOT#/home}\nN=${#ARR[@]}\n', '${VAR#pat} / ${#ARR[@]}'],
    ['case "$1" in\n  a) echo a ;;\n  *) echo b ;;\nesac\n', 'case/esac'],
    ['cat <<EOF\n{\n(\nEOF\n', 'heredoc 内任意括号'],
    ['n=$((1 + 2))\nif (( n > 0 )); then echo ok; fi\n', '$(( ))'],
  ]
  for (const [src, name] of shellGood) {
    const r = await validateShellSyntax(src, '.sh')
    assert(r.status === 'pass', `shell 合法写法必须 pass、零误报（${name}）—— 得 ${r.status}${r.errors ? ': ' + r.errors[0].slice(0, 60) : ''}`)
  }
  // 安全：-n 只解析不执行，待校验内容里的命令不得产生副作用
  const canary = join(tmpdir(), `malong-sh-canary-${process.pid}`)
  const r = await validateShellSyntax(`echo x > ${canary}\nif true; then\n`, '.sh')
  assert(r.status === 'fail', 'shell 含副作用的坏脚本仍必须 fail')
  assert(!existsSync(canary), 'bash -n 不得执行待校验内容（canary 文件不应被创建）')
  // .bash 扩展名同路径
  assert((await validateShellSyntax('if true; then\n', '.bash')).status === 'fail', '.bash 扩展名同样走真校验')

  // 3.21 全面审查补修（2026-10-27，用户要求「升 5.29 就把它做扎实」后实测出 4 处真阳性）
  // P0-1 CRLF：malong 在 transaction-store 里刻意保留 CRLF→CRLF（15-B Windows 行尾继承），
  //   而 bash -n 把 `then\r` 当非法 token → Windows 上每个 .sh 的每次编辑都被 VALIDATION_FAILED 拦。
  //   这是 0.5.29 自己引入的新误拦，与它要修的「合法文件被拦」同型，必须同版修掉。
  const lfScript = '#!/bin/bash\nif true; then\n  echo a\nfi\n'
  const crlfScript = lfScript.replace(/\n/g, '\r\n')
  const crlfOk = await validateShellSyntax(crlfScript, '.sh', 'win.sh')
  assert(crlfOk.status === 'pass', `P0-1 合法 CRLF 脚本不得误拦（得 ${crlfOk.status}${crlfOk.errors ? ': ' + crlfOk.errors[0] : ''}）`)
  assert(typeof crlfOk.notice === 'string' && crlfOk.notice.includes('CRLF'), 'P0-1 CRLF 以 notice 如实告知，不静默隐藏')
  // 规范化只去行尾噪声，真语法错仍必须照报（否则等于把 CRLF 文件全放行）
  const crlfBad = '#!/bin/bash\r\nif true; then\r\n  echo a\r\n'
  const crlfBadR = await validateShellSyntax(crlfBad, '.sh', 'win-bad.sh')
  assert(crlfBadR.status === 'fail', `P0-1 CRLF 下真缺 fi 仍必须 fail（得 ${crlfBadR.status}）`)

  // P0-2 缓存必须返回副本：旧实现返回同一对象引用，调用方改写 status 就污染后续同内容校验
  // （实测能把 fail 改成 pass —— 等于永久放行一个坏脚本）。
  const polluteSrc = 'if true; then\n  echo pollute\n'
  const first = await validateShellSyntax(polluteSrc, '.sh', 'p.sh')
  assert(first.status === 'fail', 'P0-2 前置：该内容本身是坏脚本')
  first.status = 'pass'
  first.errors = null
  const second = await validateShellSyntax(polluteSrc, '.sh', 'p.sh')
  assert(second.status === 'fail', `P0-2 调用方改结果不得污染缓存（得 ${second.status}）`)
  assert(Array.isArray(second.errors) && second.errors.length > 0, 'P0-2 缓存命中仍返回完整 errors')

  // P1-3 错误消息不得带已删除的临时路径：bash -n 报错默认是 /tmp/malong-sh-XXXX/snippet.sh，
  // 该目录在返回前已删，用户无法据此定位——正是最初「报错指向未改动处」的同类体验问题。
  const named = await validateShellSyntax('if true; then\n  echo a\n', '.sh', 'ci.sh')
  assert(!/malong-sh-/.test(named.errors[0]), `P1-3 错误消息不得泄露临时路径（得 ${named.errors[0]}）`)
  assert(named.errors[0].includes('ci.sh'), `P1-3 错误消息须含真实文件名（得 ${named.errors[0]}）`)

  // P0-3 环境缺失（unavailable）在 strict / 显式 true 下不得当硬错：
  // 否则 Windows（无 bash）上 strict 档等于让所有 .sh 编辑永久失败；但普通 skip（解析服务挂）仍须拦。
  assert(shouldBlockValidation({ profile: 'strict' }, { syntax: { status: 'skip', unavailable: true }, bracket: { status: 'skip' } }) === false, 'P0-3 strict 下无 bash（unavailable）不拦')
  assert(shouldBlockValidation({ block_on_validation_error: true }, { syntax: { status: 'skip', unavailable: true }, bracket: { status: 'skip' } }) === false, 'P0-3 显式 true 下无 bash 不拦')
  assert(shouldBlockValidation({ profile: 'strict' }, { syntax: { status: 'skip', reason: 'parse unavailable' }, bracket: { status: 'pass' } }) === true, 'P0-3 普通 skip（解析服务挂）strict 仍拦（语义未回退）')
  assert(shouldBlockValidation({ profile: 'strict' }, { syntax: { status: 'fail' }, bracket: { status: 'skip' } }) === true, 'P0-3 真语法错 strict 仍拦（语义未回退）')
}

// P1-4 临时目录不可用（只读 TMPDIR / 配额满）不得炸穿写盘：旧实现直接 throw ENOENT，
// 而写盘主路径无 catch → 用户得到裸异常而非 VALIDATION_FAILED 语义。
if (shellCmd) {
  // Windows 复核（2026-10-27）：os.tmpdir() 在 win32 读 TEMP/TMP 而非 TMPDIR——
  // 只改 TMPDIR 会让这个 mock 在 Windows 上静默失效（临时目录仍可用 → 校验照跑 → 得 fail 而非 skip）。
  const TMP_VARS = process.platform === 'win32' ? ['TMPDIR', 'TEMP', 'TMP'] : ['TMPDIR']
  const oldTmp = Object.fromEntries(TMP_VARS.map((k) => [k, process.env[k]]))
  const noSuch = join(tmpdir(), `malong-no-such-dir-${process.pid}`)
  for (const k of TMP_VARS) process.env[k] = noSuch
  let tmpRes = null, tmpThrew = null
  try {
    tmpRes = await validateShellSyntax('if true; then\n  echo a\n', '.sh', 'tmpfail.sh')
  } catch (e) {
    tmpThrew = e
  } finally {
    for (const k of TMP_VARS) {
      if (oldTmp[k] === undefined) delete process.env[k]
      else process.env[k] = oldTmp[k]
    }
  }
  assert(tmpThrew === null, `P1-4 临时目录不可用不得抛裸异常（得 ${tmpThrew && tmpThrew.message}）`)
  assert(tmpRes && tmpRes.status === 'skip' && tmpRes.unavailable === true, `P1-4 临时目录不可用 → skip+unavailable（得 ${JSON.stringify(tmpRes)}）`)
  assert(tmpRes && String(tmpRes.reason || '').includes('NOT a syntax error'), 'P1-4 如实声明这不是语法错，不伪装 pass')
}

// ══════════════ 汇总 ══════════════
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0) // 9（F8）：成功也要显式退出——否则 parse-client 的常驻 socket 挂住 event loop，进程不退（并行跑表现为超时）
