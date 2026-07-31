// test-mvp-batch.js — P4 write_symbols 批量（§6.4 隐式事务 + §16.1 聚合重定位 + §16.4 锁序）
// 场景：批量成功 / 同文件多符号（行偏移重定位）/ 部分冲突全回滚 / dry_run /
//       already_applied 幂等 / NO_BASE / patch 混用 / 冲突后重读整批重试
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MALONG_DIR = join(__dirname, '..')
const TOOLS_DIR = join(MALONG_DIR, 'tools')

let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}

const WS = '/tmp/opencode/mvp-batch-ws'
const DATA = '/tmp/opencode/mvp-batch-data'
const SOCK = '/tmp/opencode/mvp-batch.sock'

rmSync(WS, { recursive: true, force: true })
rmSync(DATA, { recursive: true, force: true })
mkdirSync(`${WS}/src`, { recursive: true })
mkdirSync(DATA, { recursive: true })

writeFileSync(`${WS}/src/auth.py`, `class AuthService:
    def login(self, username, password):
        """Login user."""
        token = self._hash(username, password)
        return token

    def logout(self, session_id):
        """Logout session."""
        return session_id is not None

    def _hash(self, salt, value):
        return salt + value
`)
writeFileSync(`${WS}/src/api.py`, `from auth import AuthService

def handle_login(username, password):
    svc = AuthService()
    return svc.login(username, password)

def handle_logout(session_id):
    svc = AuthService()
    return svc.logout(session_id)
`)

const pc = await import(join(MALONG_DIR, 'parse-client.js'))
await pc.init({ log: () => {} })
const connected = await pc.connect()
assert(connected, 'parse-client 连接')

const { default: codeIndex } = await import(join(MALONG_DIR, 'code-index.js'))
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
svc.initWorkspace(WS)
await svc.indexBatch([`${WS}/src/auth.py`, `${WS}/src/api.py`], WS)
svc.resolveCrossFileRefs()

const { writeSymbols } = await import(join(MALONG_DIR, 'write-runtime.js'))
const wctx = { codeIndexService: svc, getWorkspaceDir: () => DATA, langParserService: langParser }
const readHandler = (await import(join(TOOLS_DIR, 'tool-read-symbol', 'handler.js'))).handle
const rctx = { codeIndexService: svc, getWorkspaceDir: () => DATA }

async function currentVersion(filePath) {
  const r = await readHandler({ workspace_dir: WS, locator: { file_path: filePath } }, rctx)
  return r.version
}

const authLogin = svc.findSymbolsInFile('src/auth.py', 'login')[0]
const authLogout = svc.findSymbolsInFile('src/auth.py', 'logout')[0]
const apiLogin = svc.findSymbolsInFile('src/api.py', 'handle_login')[0]

// ── 场景 1：跨 2 文件批量成功 ──
console.log('── 场景 1: 跨文件批量成功 ──')
const vAuth = await currentVersion('src/auth.py')
const vApi = await currentVersion('src/api.py')
const newLogin = `    def login(self, username, password):
        """Login user (v2)."""
        token = self._hash(username, password)
        if not token:
            raise ValueError("empty token")
        return token
`
const r1 = await writeSymbols({ workspace_dir: WS, writes: [
  { file_path: 'src/auth.py', locator: { symbol_id: authLogin.stable_id }, base_version: vAuth, content: newLogin },
  { file_path: 'src/api.py', locator: { symbol_id: apiLogin.stable_id }, base_version: vApi, content: `def handle_login(username, password):\n    svc = AuthService()\n    return svc.login(username, password, remember=False)\n` },
] }, wctx)
assert(r1.success === true, `批量成功（得 ${r1.error?.code || r1.error?.message || 'ok'}）`)
assert(r1.items?.length === 2 && r1.items.every(i => i.status === 'ok'), `2 项全部 ok（得 ${JSON.stringify(r1.items?.map(i => i.status))}）`)
assert(!!r1.txn_id && !!r1.undo?.txn_id, `返回 txn_id + undo token`)
assert(r1.undo?.reverse?.length === 2, `undo 含 2 个文件 backup`)
const authAfter = readFileSync(`${WS}/src/auth.py`, 'utf-8')
assert(authAfter.includes('Login user (v2)') && authAfter.includes('empty token'), `auth.py 新内容已写入`)

// ── 场景 2：同文件多符号（写 login 改变行数 → logout 行偏移重定位） ──
console.log('── 场景 2: 同文件多符号重定位 ──')
const vAuth2 = await currentVersion('src/auth.py')
const r2 = await writeSymbols({ workspace_dir: WS, writes: [
  { file_path: 'src/auth.py', locator: { symbol_id: authLogin.stable_id }, base_version: vAuth2, content: `    def login(self, username, password):
        """Login user (v3)."""
        return self._hash(username, password)
` },
  { file_path: 'src/auth.py', locator: { symbol_id: authLogout.stable_id }, content: `    def logout(self, session_id):
        """Logout session (v2)."""
        return session_id is not None
` },
] }, wctx)
assert(r2.success === true, `同文件批量成功（得 ${r2.error?.code || 'ok'}）`)
const authAfter2 = readFileSync(`${WS}/src/auth.py`, 'utf-8')
assert(authAfter2.includes('Login user (v3)'), `login v3 写入`)
assert(authAfter2.includes('Logout session (v2)'), `logout v2 写入（行偏移重定位正确）`)
assert(!authAfter2.includes('Logout session.') || authAfter2.includes('v3') && authAfter2.includes('v2'), `旧内容被替换无残留`)
// 写后立刻可读（同步重抽 + 重新 resolve）
const rr2 = await readHandler({ workspace_dir: WS, locator: { symbol_id: authLogout.stable_id } }, rctx)
assert(rr2.symbol?.text?.includes('Logout session (v2)'), `写后立刻可读 logout v2`)

// ── 场景 3：部分冲突 → 全回滚（锁序 api<auth：api 先写成功，auth 冲突 → 回滚 api） ──
console.log('── 场景 3: 部分冲突全回滚 ──')
const vApi3 = await currentVersion('src/api.py')
const vAuth3 = await currentVersion('src/auth.py')
const beforeAuth3 = readFileSync(`${WS}/src/auth.py`, 'utf-8')
const beforeApi3 = readFileSync(`${WS}/src/api.py`, 'utf-8')
// 外部改 auth.py（模拟并发写者改 login）→ auth 的 base 过期
writeFileSync(`${WS}/src/auth.py`, beforeAuth3.replace('"""Login user (v3)."""', '"""Login user (v3-ext)."""'))
const r3 = await writeSymbols({ workspace_dir: WS, writes: [
  { file_path: 'src/api.py', locator: { symbol_id: apiLogin.stable_id }, base_version: vApi3, content: `def handle_login(username, password):\n    svc = AuthService()\n    return svc.login(username, password)\n` },
  { file_path: 'src/auth.py', locator: { symbol_id: authLogin.stable_id }, base_version: vAuth3, content: newLogin },
] }, wctx)
assert(r3.success === false, `批量失败（得 ${r3.error?.code}）`)
assert(Array.isArray(r3.rolled_back) && r3.rolled_back.includes('src/api.py'), `已写的 api.py 被回滚（得 ${JSON.stringify(r3.rolled_back)}）`)
assert(readFileSync(`${WS}/src/api.py`, 'utf-8') === beforeApi3, `api.py 恢复原内容（补偿事务）`)
assert(readFileSync(`${WS}/src/auth.py`, 'utf-8') !== beforeAuth3, `auth.py 保留外部改动（未被覆盖）`)

// ── 场景 4：dry_run 不写 ──
console.log('── 场景 4: dry_run ──')
const vAuth4 = await currentVersion('src/auth.py')
const beforeAuth4 = readFileSync(`${WS}/src/auth.py`, 'utf-8')
const r4 = await writeSymbols({ workspace_dir: WS, policy: { dry_run: true }, writes: [
  { file_path: 'src/auth.py', locator: { symbol_id: authLogin.stable_id }, base_version: vAuth4, content: newLogin },
] }, wctx)
assert(r4.success === true && r4.dry_run === true, `dry_run 成功`)
assert(readFileSync(`${WS}/src/auth.py`, 'utf-8') === beforeAuth4, `dry_run 未写文件`)
assert(Array.isArray(r4.diff) && r4.diff.length >= 1, `dry_run 返回整批 diff`)

// ── 场景 5：already_applied 幂等（先真写，再重复整批） ──
console.log('── 场景 5: 重复整批幂等 ──')
const r5 = await writeSymbols({ workspace_dir: WS, writes: [
  { file_path: 'src/auth.py', locator: { symbol_id: authLogin.stable_id }, base_version: vAuth4, content: newLogin },
] }, wctx)
assert(r5.success === true && r5.items?.[0]?.status === 'ok', `首次真写 ok（得 ${r5.items?.[0]?.status}）`)
const r5b = await writeSymbols({ workspace_dir: WS, writes: [
  { file_path: 'src/auth.py', locator: { symbol_id: authLogin.stable_id }, base_version: vAuth4, content: newLogin },
] }, wctx)
assert(r5b.success === true && r5b.items?.[0]?.status === 'already_applied', `重复整批 → already_applied（得 ${r5b.items?.[0]?.status}）`)

// ── 场景 6：NO_BASE 拒（首项无 base_version，内容非幂等） ──
console.log('── 场景 6: NO_BASE ──')
const newLoginV4 = newLogin.replace('v2', 'v4')
const r6 = await writeSymbols({ workspace_dir: WS, writes: [
  { file_path: 'src/auth.py', locator: { symbol_id: authLogin.stable_id }, content: newLoginV4 },
] }, wctx)
assert(r6.success === false && r6.error?.conflict_type === 'NO_BASE', `首项无 base → NO_BASE（得 ${r6.error?.conflict_type}）`)

// ── 场景 7：patch 混用（符号 + 文件级 patch 一批） ──
console.log('── 场景 7: patch 混用 ──')
const vApi7 = await currentVersion('src/api.py')
const r7 = await writeSymbols({ workspace_dir: WS, writes: [
  { file_path: 'src/api.py', locator: { symbol_id: apiLogin.stable_id }, base_version: vApi7, content: `def handle_login(username, password):\n    svc = AuthService()\n    return svc.login(username, password)\n` },
  { file_path: 'src/api.py', edit_mode: 'patch', patch: { old_string: 'return svc.logout(session_id)', new_string: 'return svc.logout(session_id, force=True)' } },
] }, wctx)
assert(r7.success === true && r7.items?.every(i => i.status === 'ok'), `patch 混用成功（得 ${JSON.stringify(r7.items?.map(i => i.status))}）`)
assert(readFileSync(`${WS}/src/api.py`, 'utf-8').includes('logout(session_id, force=True)'), `文件级 patch 生效`)

// ── 场景 8：冲突后重读 → 整批重试成功（恢复闭环） ──
console.log('── 场景 8: 冲突重试闭环 ──')
// 先外部改 login（破坏幂等预检）→ 过期 base 才会被冲突判定拒绝
const beforeAuth8 = readFileSync(`${WS}/src/auth.py`, 'utf-8')
writeFileSync(`${WS}/src/auth.py`, beforeAuth8.replace('"""Login user (v2)."""', '"""Login user (v8-ext)."""'))
const r8 = await writeSymbols({ workspace_dir: WS, writes: [
  { file_path: 'src/auth.py', locator: { symbol_id: authLogin.stable_id }, base_version: vAuth3, content: newLogin },
] }, wctx)
assert(r8.success === false, `过期 base 整批被拒`)
assert(r8.error?.next_action?.tool === 'read_symbol', `冲突响应带 next_action（${r8.error?.next_action?.tool}）`)
const reRead = await readHandler({ workspace_dir: WS, locator: r8.error.next_action.params.locator }, rctx)
const r8b = await writeSymbols({ workspace_dir: WS, writes: [
  { file_path: 'src/auth.py', locator: { symbol_id: authLogin.stable_id }, base_version: reRead.version, content: newLogin },
] }, wctx)
assert(r8b.success === true, `重读后整批重试成功（冲突恢复闭环）`)

// ── 场景 9：body 模式误传签名行 → BODY_CONTAINS_SIGNATURE 拒 + 整批回滚 ──
console.log('── 场景 9: body 模式误传签名行 ──')
const before9 = readFileSync(`${WS}/src/auth.py`, 'utf-8')
const v9 = await currentVersion('src/auth.py')
const wrongBody = `    def login(self, username, password):
        token = self._hash(username, password)
        return token + 'x'`
const r9 = await writeSymbols({ workspace_dir: WS, writes: [
  { file_path: 'src/auth.py', locator: { symbol_id: authLogin.stable_id }, base_version: v9, content: wrongBody, edit_mode: 'replace_symbol', boundary: 'body' },
] }, wctx)
assert(r9.success === false, `body 含签名行被拒（BODY_CONTAINS_SIGNATURE）`)
assert(r9.error?.code === 'BODY_CONTAINS_SIGNATURE', `错误码正确（得 ${r9.error?.code}）`)
assert(readFileSync(`${WS}/src/auth.py`, 'utf-8') === before9, `文件未被写入（整批回滚）`)

// ── 场景 10：MCP 重启后 _db 为 null → indexFile 懒初始化（reindex 静默失败回归） ──
console.log('── 场景 10: _db 为 null 懒初始化 ──')
// 模拟 MCP 重启（init 后未调 initWorkspace 的状态）
codeIndex._db = null
codeIndex._currentWorkspace = null
const r10 = await svc.indexFile(`${WS}/src/auth.py`, WS)
assert(r10 !== null, `_db 为 null 时 indexFile 不再抛错（懒初始化触发，得 ${JSON.stringify(r10)}）`)
assert(codeIndex._db !== null, `懒初始化后 _db 已打开`)
assert(codeIndex._currentWorkspace === WS, `_currentWorkspace 已设置（得 ${codeIndex._currentWorkspace}）`)
const r10b = await svc.getSymbols('src/auth.py')
assert(Array.isArray(r10b) && r10b.length >= 2, `懒初始化后索引可查询（${r10b.length} 个符号）`)

// ── 场景 11：文件级 patch 插行在前 + 符号替换在后（9-F1：文件级 patch 必须回 delta，否则后续符号项 offset 错位静默改错行）──
console.log('── 场景 11: 文件级 patch 插行 + 符号重定位 ──')
const vApi11 = await currentVersion('src/api.py')
const apiLogout11 = svc.findSymbolsInFile('src/api.py', 'handle_logout')[0]
const r11 = await writeSymbols({ workspace_dir: WS, writes: [
  // item 0：文件级 patch（无 locator）在文件顶部插 2 行注释 → 后续所有符号实际行号 +2
  { file_path: 'src/api.py', edit_mode: 'patch', base_version: vApi11, patch: { old_string: 'from auth import AuthService', new_string: '# hdr-1\n# hdr-2\nfrom auth import AuthService' } },
  // item 1：替换 handle_logout（位于插入点之后，需 +2 重定位；无 base_version → 不走冲突判定，错位会真改错行）
  { file_path: 'src/api.py', locator: { symbol_id: apiLogout11.stable_id }, content: `def handle_logout(session_id):\n    svc = AuthService()\n    return svc.logout(session_id, audit=True)\n` },
] }, wctx)
assert(r11.success === true, `文件级 patch + 符号替换批量成功（得 ${r11.error?.code || r11.error?.message || 'ok'}）`)
const after11 = readFileSync(`${WS}/src/api.py`, 'utf-8')
assert(after11.includes('# hdr-1\n# hdr-2\nfrom auth import AuthService'), `文件级 patch 插入 2 行生效`)
assert(after11.includes('return svc.logout(session_id, audit=True)'), `handle_logout 被正确替换（offset 重定位 +2，9-F1）`)
assert(after11.includes('def handle_login(username, password):') && after11.includes('return svc.login(username, password)'), `handle_login 未被错位编辑破坏（旧实现 offset=0 会改错行）`)

console.log(`\n=== test-mvp-batch: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
