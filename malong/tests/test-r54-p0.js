// test-r54-p0.js — 第七轮审计 P0 修复锁定（沙箱逃逸 / 数据完整性 / 原子性守卫）
// 覆盖：mock-syncer 路径守卫、rename-symbol symbol 消毒、transaction-store begin 消毒、
//       security-review exec-cmd-member + SKIP_DIRS、尾斜杠 workspace 归一化。
import { join, dirname } from 'node:path'
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MALONG = dirname(__dirname)
const imp = (p) => import(pathToFileURL(p).href)

let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++; console.log(`  \u2713 ${msg}`) } else { fail++; console.error(`  \u2717 FAIL: ${msg}`) }
}

const tmp = (tag) => {
  const ws = join(os.tmpdir(), 'opencode', `r54-p0-${tag}-${process.pid}`)
  rmSync(ws, { recursive: true, force: true })
  mkdirSync(ws, { recursive: true })
  return ws
}

// ── P0-3: mock-syncer file 路径守卫 ──
console.log('\u2500\u2500 P0-3 mock-syncer \u8def\u5f84\u5b88\u536b \u2500\u2500')
{
  const { handle } = await imp(join(MALONG, 'tools/tool-mock-syncer/handler.js'))
  const ws = tmp('mocksync')
  writeFileSync(join(ws, 'src.js'), 'function target(a){return a}\n')
  writeFileSync(join(dirname(ws), 'escape.js'), 'function secret(){}\n')
  let r = await handle({ workspace_dir: ws, file: '../escape.js', function: 'secret' }, {})
  assert(r.error === 'PATH_BLOCKED', `../escape.js \u5e94 PATH_BLOCKED\uff08\u5f97 ${r.error}\uff09`)
  r = await handle({ workspace_dir: ws, file: 'src.js', function: 'target' }, {})
  assert(!r.error, `\u5408\u6cd5\u6587\u4ef6\u4e0d\u5e94\u88ab\u8bef\u62e6\uff08\u5f97 ${r.error}\uff09`)
  // r10c：零参数函数签名提取（`(.+)` → `([^)]*)` 修复，旧正则空括号必报 symbol_not_found）
  writeFileSync(join(ws, 'noparam.js'), 'export function noParam() { return 1 }\nexport function withParams(a, b) { return a + b }\n')
  r = await handle({ workspace_dir: ws, file: 'noparam.js', function: 'noParam' }, {})
  assert(!r.error && r.target.signature === '()', `\u96f6\u53c2\u51fd\u6570\u5e94\u63d0\u53d6\u4e3a () \u800c\u975e symbol_not_found\uff08\u5f97 ${r.error || r.target.signature}\uff09`)
  r = await handle({ workspace_dir: ws, file: 'noparam.js', function: 'withParams' }, {})
  assert(!r.error && r.target.signature === '(a, b)', `\u5e26\u53c2\u51fd\u6570\u63d0\u53d6\u4e0d\u53d7\u5f71\u54cd\uff08\u5f97 ${r.error || r.target.signature}\uff09`)
  rmSync(ws, { recursive: true, force: true }); rmSync(join(dirname(ws), 'escape.js'), { force: true })
}

// ── P0-2: rename-symbol symbol 消毒 ──
console.log('\u2500\u2500 P0-2 rename-symbol symbol \u6d88\u6bd2 \u2500\u2500')
{
  const { handle } = await imp(join(MALONG, 'tools/tool-rename-symbol/handler.js'))
  const ws = tmp('rename')
  let r = await handle({ workspace_dir: ws, symbol: '../../etc/passwd', new_name: 'validName', file: 'a.js' }, {})
  assert(r.error === 'invalid_input', `symbol \u542b .. \u5e94 invalid_input\uff08\u5f97 ${r.error}\uff09`)
  r = await handle({ workspace_dir: ws, symbol: 'a/b', new_name: 'validName', file: 'a.js' }, {})
  assert(r.error === 'invalid_input', `symbol \u542b / \u5e94 invalid_input\uff08\u5f97 ${r.error}\uff09`)
  rmSync(ws, { recursive: true, force: true })
}

// ── P0-2: transaction-store begin 消毒（纵深防御）──
console.log('\u2500\u2500 P0-2 transaction-store begin \u6d88\u6bd2 \u2500\u2500')
{
  const { TransactionStore } = await imp(join(MALONG, 'tools/tool-edit-transaction/transaction-store.js'))
  const ws = tmp('txnstore')
  const store = new TransactionStore(ws)
  const txnId = store.begin('rename_../../etc/x_to_y')
  assert(!txnId.includes('..') && !txnId.includes('/') && !txnId.includes('\\'), `txnId \u65e0\u8def\u5f84\u5206\u9694\u7b26/..\uff08\u5f97 ${txnId}\uff09`)
  const txnRoot = join(ws, '.ai-transactions')
  const entries = existsSync(txnRoot) ? readdirSync(txnRoot) : []
  assert(entries.some(e => e === txnId), `\u4e8b\u52a1\u76ee\u5f55\u5728 .ai-transactions \u5185`)
  assert(!existsSync(join(ws, 'etc')), `\u672a\u9003\u9038\u5230 workspace/etc`)
  rmSync(ws, { recursive: true, force: true })
}

// ── P0-4 + P1: security-review exec-cmd-member / SKIP_DIRS / \u5c3e\u659c\u6760 ──
console.log('\u2500\u2500 security-review exec-cmd-member + SKIP_DIRS \u2500\u2500')
{
  const { handle } = await imp(join(MALONG, 'tools/tool-security-review/handler.js'))
  // exec-cmd-member：child_process.exec 拼接必抓
  let r = await handle({ workspace_dir: MALONG, source: "child_process.exec('rm -rf ' + dir)" }, {})
  assert((r.findings || []).some(f => f.id === 'exec-cmd-member'), `child_process.exec \u62fc\u63a5\u5e94\u62a5 exec-cmd-member`)
  // RegExp.exec 不误报
  r = await handle({ workspace_dir: MALONG, source: "const m = pathRe.exec(a + b)" }, {})
  assert(!(r.findings || []).some(f => f.id === 'exec-cmd' || f.id === 'exec-cmd-member'), `RegExp.exec \u4e0d\u5e94\u8bef\u62a5`)
  // SKIP_DIRS：node_modules 内的漏洞不扫出
  const ws = tmp('secrev')
  mkdirSync(join(ws, 'node_modules', 'dep'), { recursive: true })
  writeFileSync(join(ws, 'node_modules', 'dep', 'bad.js'), "const password = 'hunter2secret'\n")
  writeFileSync(join(ws, 'app.js'), "const x = 1\n")
  r = await handle({ workspace_dir: ws, scope: '.' }, {})
  const files = (r.results || []).map(x => x.file_path || x.file)
  assert(!(r.findings || []).length && !(r.results || []).some(x => (x.findings || []).length), `node_modules \u5185\u6f0f\u6d1e\u4e0d\u5e94\u88ab\u626b\u51fa`)
  // 尾斜杠 workspace：scope 扫描仍工作
  r = await handle({ workspace_dir: ws + '/', scope: '.' }, {})
  assert(!r.error, `\u5c3e\u659c\u6760 workspace \u4e0d\u5e94\u62a5\u9519\uff08\u5f97 ${r.error}\uff09`)
  rmSync(ws, { recursive: true, force: true })
}

// ── P0-4: spec-gen / config-drift \u5c3e\u659c\u6760\u5f52\u4e00\u5316\uff08\u65e0 daemon \u4e0b\u4ec5\u9a8c\u8bc1\u4e0d\u8bef\u62a5\u9003\u9038\uff09──
console.log('\u2500\u2500 P0-4 config-drift \u5c3e\u659c\u6760\u4e0d\u8bef\u62e6 \u2500\u2500')
{
  const { handle } = await imp(join(MALONG, 'tools/tool-config-drift/handler.js'))
  const ws = tmp('cfgdrift')
  writeFileSync(join(ws, 'app.py'), "import os\nval = os.environ['MISSING_VAR_XYZ']\n")
  // 尾斜杠 workspace + 合法 file：不应报 "File escapes workspace"
  const r = await handle({ workspace_dir: ws + '/', file: 'app.py' }, {})
  assert(!r.error, `\u5c3e\u659c\u6760 + \u5408\u6cd5 file \u4e0d\u5e94\u8bef\u62a5\u9003\u9038\uff08\u5f97 ${r.error}:${r.message}\uff09`)
  // R22-⑱：全扫模式 + \u5c3e\u659c\u6760 \u4e0d\u5f97\u9759\u9ed8\u7a7a\u7ed3\u679c\uff08\u65e7 wsPrefix \u62fc // \u6052\u4e0d\u5339\u914d → ENOENT \u5ffd\u7565\u5168\u90e8 → \u5047\u62a5 in_sync\uff09
  const rScan = await handle({ workspace_dir: ws + '/' }, {})
  const refs = (rScan.config_references || []).filter(x => x.type === 'env_var')
  assert(refs.length === 1, `R22-⑱ \u5168\u626b+\u5c3e\u659c\u6760 \u6b63\u5e38\u63d0\u53d6 refs\uff08\u5f97 ${refs.length}\uff09`)
  rmSync(ws, { recursive: true, force: true })
}

console.log(`\n=== test-r54-p0: ${pass} passed, ${fail} failed ===`)
process.exit(fail > 0 ? 1 : 0)
