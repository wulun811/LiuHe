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

rmSync(WS, { recursive: true, force: true })
rmSync(DATA, { recursive: true, force: true })
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
  extractAllAsync: (source, ext, filePath) => pc.extractAll(source, ext, filePath),
  hasErrorsAsync: (source, ext, filePath) => pc.hasErrors(source, ext, filePath),
  batchExtractAsync: (files) => pc.batchExtract(files),
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
// R22-⑨：budget_hint=0 曾被 `|| 1200` 吞为默认——0 = 不截断（全文预算 100000）
const r0 = await readHandler({ workspace_dir: WS, locator: { file_path: 'src/auth.py', symbol_id: loginSyms[0].stable_id }, budget_hint: 0 }, ctx)
assert(r0.budget?.requested === 100000 && r0.budget?.truncated === false, `P2 budget_hint=0 → 全文预算 100000 不截断（得 requested=${r0.budget?.requested} truncated=${r0.budget?.truncated}）`)
const r1200 = await readHandler({ workspace_dir: WS, locator: { file_path: 'src/auth.py', symbol_id: loginSyms[0].stable_id } }, ctx)
assert(r1200.budget?.requested === 1200, `P2 不传 budget_hint → 默认 1200（得 ${r1200.budget?.requested}）`)
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
rmSync(recWS, { recursive: true, force: true })
mkdirSync(join(recWS, '.malong', 'journal'), { recursive: true })
// 场景 A：当前 == 写前（dryRun 残留/崩溃在 rename 前）→ abandoned，文件不动
writeFileSync(`${recWS}/a.txt`, 'v1')
const ja = createJournal(recWS, 'a.txt', `${recWS}/a.txt`, 'v1', { editMode: 'patch', state: 'staged' })
updateJournalState(ja.dir, { state: 'staged', new_hash: sha256('v2') })
let rec = await recoverJournals(recWS)
assert(rec.some(r => r.txn_id === ja.txnId && r.action === 'abandoned'), `P3 recovery: staged+当前==写前 → abandoned（得 ${JSON.stringify(rec)}）`)
assert(readFileSync(`${recWS}/a.txt`, 'utf-8') === 'v1', 'P3 recovery: abandoned 不覆盖文件')
// 场景 B：当前 == new_hash（rename 成功、崩溃在 committed 前）→ 补标 committed，文件不动
writeFileSync(`${recWS}/b.txt`, 'v2')
const jb = createJournal(recWS, 'b.txt', `${recWS}/b.txt`, 'v1', { editMode: 'patch', state: 'staged' })
updateJournalState(jb.dir, { state: 'staged', new_hash: sha256('v2') })
rec = await recoverJournals(recWS)
assert(rec.some(r => r.txn_id === jb.txnId && r.action === 'committed'), `P3 recovery: staged+当前==写后 → committed（得 ${JSON.stringify(rec)}）`)
assert(readFileSync(`${recWS}/b.txt`, 'utf-8') === 'v2', 'P3 recovery: committed 不覆盖新内容')
// 场景 C：当前既非写前也非写后（外部修改过）→ needs_review，绝不覆盖
writeFileSync(`${recWS}/c.txt`, 'EXTERNAL')
const jc = createJournal(recWS, 'c.txt', `${recWS}/c.txt`, 'v1', { editMode: 'patch', state: 'staged' })
updateJournalState(jc.dir, { state: 'staged', new_hash: sha256('v2') })
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

// 3.18 bracket 误报降级（全工具冒烟 r12.5 发现）：stripper 不识别正则字面量——含引号字符类如 ['"`]
// 连带破坏字符串剥离，合法文件（node --check 过）也报 unbalanced。syntax pass 是权威 ⇒ 降级防 strict 阻断/误导。
const { reconcileBracketWithSyntax } = await imp(join(MALONG_DIR, 'write-runtime.js'))
assert(checkBracketBalance("function f(x) { return /['\"]/ }\nconst b = /['\"]/").ok === false, 'P3 已知局限：含引号字符类的正则使 raw bracket 误报（锁定现状，靠 reconcile 兜底）')
const v1 = reconcileBracketWithSyntax({ syntax: { status: 'pass' }, bracket: { status: 'fail', errors: ['unbalanced: expected ) but got }'] } })
assert(v1.bracket.status === 'pass' && v1.bracket.false_positive_downgraded, 'P3 syntax pass + bracket fail → 降级为 pass（syntax 是权威）')
const v2 = reconcileBracketWithSyntax({ syntax: { status: 'skip', reason: 'non-code file' }, bracket: { status: 'fail', errors: ['x'] } })
assert(v2.bracket.status === 'fail', 'P3 syntax skip（非代码）→ bracket 是唯一信号，保留 fail')
const v3 = reconcileBracketWithSyntax({ syntax: { status: 'fail' }, bracket: { status: 'fail', errors: ['x'] } })
assert(v3.bracket.status === 'fail', 'P3 syntax fail → bracket 保留 fail（佐证）')
const v4 = reconcileBracketWithSyntax({ syntax: { status: 'pass' }, bracket: { status: 'pass' } })
assert(v4.bracket.status === 'pass' && !v4.bracket.false_positive_downgraded, 'P3 双 pass 不动')

// ══════════════ 汇总 ══════════════
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0) // 9（F8）：成功也要显式退出——否则 parse-client 的常驻 socket 挂住 event loop，进程不退（并行跑表现为超时）
