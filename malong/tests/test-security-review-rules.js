// test-security-review-rules.js — security_review 规则黄金测试（r27 新增）
// 背景：规则此前零测试覆盖。r27 dogfooding 自扫 27 条全误报，治理 exec-cmd/sql-concat 两条规则，
// 本测试固化「真注入必抓 + 误报模式必免」，防回归。
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const imp = (p) => import(pathToFileURL(p).href)
const MALONG = dirname(__dirname)
const { handle } = await imp(join(MALONG, 'tools/tool-security-review/handler.js'))

let passed = 0
let failed = 0
function assert(label, ok, detail) {
  if (ok) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; console.log(`  ✗ ${label}: ${detail || ''}`) }
}

async function scan(source) {
  const r = await handle({ workspace_dir: MALONG, source }, {})
  return r.findings || []
}
const has = (findings, id) => findings.some(f => f.id === id)

// ── 真注入：必须抓到 ──
console.log('── 真注入必抓 ──')
const vuln = [
  ['eval', 'const r = eval(userInput)', 'eval'],
  ['Function 构造', 'const f = new Function(code)', 'Function-ctor'],
  ['独立 exec 拼接', "exec('rm -rf ' + dir)", 'exec-cmd'],
  ['execSync 拼接', "execSync('ls ' + path)", 'exec-cmd'],
  ['SQL 拼接', 'const q = "SELECT * FROM users WHERE id = " + uid', 'sql-concat'],
  ['innerHTML', 'el.innerHTML = html', 'innerHTML'],
  ['密码硬编码', "const password = 'hunter2secret'", 'password-hardcode'],
  ['spawn shell=true', "spawn('cmd', args, { shell: true })", 'spawn-shell'],
  // r12（C1 教训）：模板字符串 ${} / $() 命令替换 / execFile+shell 拼接——旧规则只认 `+` 拼接全漏
  ['exec 模板插值', 'execSync(`rm -rf ${dir}`)', 'exec-cmd-tpl'],
  ['member exec 模板插值', 'child_process.execSync(`echo ${x}`)', 'exec-cmd-tpl-member'],
  ['exec 命令替换', "execSync('cat $(ls)')", 'exec-cmd-subst'],
  ['member exec 命令替换', 'child_process.exec("echo $(whoami)")', 'exec-cmd-subst-member'],
  ['execFile 拼接+shell', 'execFile("node" + script, args, { shell: true })', 'exec-file-shell-concat'],
  // r12.4（边界内自查）：裸 spawn/execFile 命令名拼接/插值（import 解构形态，非 child_process 成员）
  ["裸 spawn 命令名拼接", "spawn('node' + script, args)", 'cmd-name-concat'],
  ['裸 spawn 命令名插值', 'spawnSync(`node ${script}`, args)', 'cmd-name-tpl'],
  ["裸 execFile 命令名拼接", "execFile('/usr/bin/' + name, args)", 'cmd-name-concat'],
]
for (const [name, src, id] of vuln) {
  const f = await scan(src)
  assert(`${name} → 抓到 ${id}`, has(f, id), JSON.stringify(f.map(x => x.id)))
}

// ── 误报模式：必须豁免 ──
console.log('── 误报模式必免 ──')

// r27#1：RegExp.exec 成员调用带拼接（旧规则 \bexec 误报）
let f = await scan("while ((m = pathRe.exec(a + '\\n' + b)) !== null) { names.add(m[1]) }")
assert('r27: RegExp.exec(a+b) 不误报 exec-cmd', !has(f, 'exec-cmd'), JSON.stringify(f.map(x => x.id)))

// r27#1 对照：正则 exec 无拼接（本来就安全）
f = await scan('const m = re.exec(str)')
assert('RegExp.exec(str) 无拼接不误报', !has(f, 'exec-cmd'), JSON.stringify(f.map(x => x.id)))

// r27#2：散文 update 词跨行（旧规则 s 标志跨行误配）
f = await scan([
  'function suggest(rt) {',
  '  const msg = `update return_value to ${rt} object`',
  '  doSomething()',
  '  const y = helper("str" + val)',
  '  return msg',
  '}',
].join('\n'))
assert('r27: 散文 update 跨行不误报 sql-concat', !has(f, 'sql-concat'), JSON.stringify(f.map(x => x.id)))

// r27#2 对照：真 SQL 拼接即便跨行仍抓（\s 可跨行）
f = await scan('const q = "SELECT * FROM t WHERE x = " +\n  userId')
assert('真 SQL 跨行拼接仍抓 sql-concat', has(f, 'sql-concat'), JSON.stringify(f.map(x => x.id)))

// r12（C1 教训）：误报模式必免——RegExp.exec 模板插值 / 无插值模板 / spawn·execFile 参数数组
f = await scan('while ((m = re.exec(`${a}${b}`)) !== null) { names.add(m[1]) }')
assert('r12: RegExp.exec 模板插值不误报 exec-cmd-tpl', !has(f, 'exec-cmd-tpl'), JSON.stringify(f.map(x => x.id)))
f = await scan('const out = execSync(`git status --porcelain`)')
assert('r12: 无插值模板不误报 exec-cmd-tpl', !has(f, 'exec-cmd-tpl'), JSON.stringify(f.map(x => x.id)))
f = await scan("spawn('cmd', [`--x=${v}`])")
assert('r12: spawn 参数数组插值不误报（不经 shell）', !has(f, 'exec-cmd-tpl') && !has(f, 'exec-cmd-tpl-member'), JSON.stringify(f.map(x => x.id)))
f = await scan("execFile('node', [`--name=${x}`], opts)")
assert('r12: execFile 参数数组插值不误报（不经 shell）', !has(f, 'exec-cmd-tpl'), JSON.stringify(f.map(x => x.id)))
f = await scan("execFile('a' + b, ['c'])")
assert('r12: execFile 拼接无 shell:true 不误报', !has(f, 'exec-file-shell-concat'), JSON.stringify(f.map(x => x.id)))
f = await scan("execFile('a', args, { shell: false })")
assert('r12: execFile shell:false 不误报', !has(f, 'exec-file-shell-concat'), JSON.stringify(f.map(x => x.id)))
f = await scan("spawn('cmd', ['a' + b, `--x=${v}`])")
assert('r12.4: spawn 参数数组拼接/插值不误报（不经 shell）', !has(f, 'cmd-name-concat') && !has(f, 'cmd-name-tpl'), JSON.stringify(f.map(x => x.id)))
f = await scan("execFile('node', ['--name=' + x])")
assert('r12.4: execFile 参数数组拼接不误报', !has(f, 'cmd-name-concat'), JSON.stringify(f.map(x => x.id)))
f = await scan("spawn('git', ['status'])")
assert('r12.4: spawn 常量命令名不误报', !has(f, 'cmd-name-concat') && !has(f, 'cmd-name-tpl'), JSON.stringify(f.map(x => x.id)))
f = await scan("spawn('cmd', args, { shell: true })")
assert('r12.4: spawn shell:true 无拼接不报 cmd-name-concat（spawn-shell 已管）', !has(f, 'cmd-name-concat'), JSON.stringify(f.map(x => x.id)))

// 观测项：参数化 .prepare（r25 豁免逻辑实际行为，非 r27 断言）
f = await scan('db.prepare("SELECT * FROM t WHERE id = " + CONST).run()')
console.log(`  [观测] .prepare 参数化单行 → ${has(f, 'sql-concat') ? '仍报(豁免未覆盖此形态)' : '已豁免'}`)

// ── r9: insecure-compare 死规则重写 + f-string SQL + .prepare 豁免强化 + .env 钳制 ──
console.log('── r9 规则重写 ──')
// 真形态：敏感凭证与变量直接比较（时序攻击）——分号 + 换行结尾（正则前瞻要求）
f = await scan(['function check(stored, input) {', '  return stored === input;', '}'].join('\n'))
assert('r9: stored === input 命中 insecure-compare', has(f, 'insecure-compare'), JSON.stringify(f.map(x => x.id)))
f = await scan(['const ok = expected === userToken;', 'doSomething(ok)'].join('\n'))
assert('r9: expected === userToken 命中 insecure-compare', has(f, 'insecure-compare'), JSON.stringify(f.map(x => x.id)))
f = await scan(['const ok = savedCred === req.body.pass;', 'next()'].join('\n'))
assert('r9: savedCred === 成员右值命中（含==）', has(f, 'insecure-compare'), JSON.stringify(f.map(x => x.id)))
// 合法形态：右值为字面量（常量比较不泄露时序）
f = await scan(['const ok = user.name === "x";', 'next()'].join('\n'))
assert('r9: user.name === 字面量不误报', !has(f, 'insecure-compare'), JSON.stringify(f.map(x => x.id)))
f = await scan(['if (stored === 3) break;', 'next()'].join('\n'))
assert('r9: 数字字面量右值不误报', !has(f, 'insecure-compare'), JSON.stringify(f.map(x => x.id)))
f = await scan(['if (stored === null) return;', 'next()'].join('\n'))
assert('r9: null 右值不误报', !has(f, 'insecure-compare'), JSON.stringify(f.map(x => x.id)))
f = await scan(['const ok = token === true;', 'next()'].join('\n'))
assert('r9: true 右值不误报', !has(f, 'insecure-compare'), JSON.stringify(f.map(x => x.id)))
f = await scan(['function x() {', '  const a = stored === input;', '  return a', '}'].join('\n'))
assert('r9: const 赋值形态命中 insecure-compare', has(f, 'insecure-compare'), JSON.stringify(f.map(x => x.id)))
// R22-⑦（拷打发现）：单行形态漏报——后视原要求分号后必须换行，单行 if/同行分号漏检；修后命中，且成员调用右值/三元仍不误报
f = await scan(['function check(stored, input) {', '  if (stored === input) { return ok }', '  return 0', '}'].join('\n'))
assert('R22-⑦: 单行 if 形态命中 insecure-compare', has(f, 'insecure-compare'), JSON.stringify(f.map(x => x.id)))
f = await scan(['const a = stored === input; next()'].join('\n'))
assert('R22-⑦: 同行分号形态命中', has(f, 'insecure-compare'), JSON.stringify(f.map(x => x.id)))
f = await scan(['const ok = stored === input.map(x => x.id);', 'next()'].join('\n'))
assert('R22-⑦: 成员调用右值不误报', !has(f, 'insecure-compare'), JSON.stringify(f.map(x => x.id)))
f = await scan(['const ok = stored === input ? a : b;', 'next()'].join('\n'))
assert('R22-⑦: 三元右值不误报', !has(f, 'insecure-compare'), JSON.stringify(f.map(x => x.id)))
// 已知误报锁定（方案声明）：sessionId === req.query.sid 命中属预期，用 suppressed 豁免
f = await scan(['const isSid = sessionId === req.query.sid;', 'next()'].join('\n'))
assert('r9: sessionId === 成员右值命中（已知误报，接受并锁定）', has(f, 'insecure-compare'), JSON.stringify(f.map(x => x.id)))
// f-string SQL 注入（动词在前形态）
f = await scan('query = f"SELECT * FROM users WHERE id = {uid}"')
assert('r9: f-string 插值拼 SQL 命中 sql-fstring', has(f, 'sql-fstring'), JSON.stringify(f.map(x => x.id)))
f = await scan('msg = f"INSERT INTO log VALUES ({x})"')
assert('r9: f-string INSERT 命中 sql-fstring', has(f, 'sql-fstring'), JSON.stringify(f.map(x => x.id)))
f = await scan('s = f"SELECTED {item} for you"')
assert('r9: f-string SELECTED 不误报（动词词边界）', !has(f, 'sql-fstring'), JSON.stringify(f.map(x => x.id)))
// .prepare 多段拼接豁免（span 前移 40 字符覆盖）
f = await scan('db.prepare("SELECT * FROM t WHERE a = " + x + " AND b = " + y).run()')
assert('r9: .prepare 多段拼接已豁免 sql-concat', !has(f, 'sql-concat'), JSON.stringify(f.map(x => x.id)))
// 对照：非参数化 db.exec 拼接仍报
f = await scan('db.exec("SELECT * FROM t WHERE a = " + x).run()')
assert('r9: db.exec 拼接仍报 sql-concat（豁免只覆盖 .prepare）', has(f, 'sql-concat'), JSON.stringify(f.map(x => x.id)))
// .env max_findings 钳制：max_findings=1 时 .env 大量密钥只报 1 条
{
  const envSrc = Array.from({ length: 10 }, (_, i) => `KEY_${i}=secret_value_${i}`).join('\n')
  const envR = await handle({ workspace_dir: MALONG, file: '.env', max_findings: 1, source: envSrc }, {})
  assert('r9: .env 受 max_findings 钳制（max=1 只报 1 条）', (envR.findings || []).length === 1, `got ${(envR.findings || []).length}`)
  assert('r9: 截断时 findings_capped 标记', envR.summary?.findings_capped === true, `got ${envR.summary?.findings_capped}`)
}

// ── r12.1: 预期管理锁定——无旧 score 字段、next_step 条件句、coverage 边界字段 ──
console.log('── r12.1 预期管理 ──')
{
  const r = await handle({ workspace_dir: MALONG, source: 'export const add = (a, b) => a + b' }, {})
  assert('r12.1: summary 无旧 score 字段（只剩 shape_score）', r.summary.score === undefined && typeof r.summary.shape_score === 'number', `score=${r.summary.score}`)
  assert('r12.1: 0 命中 next_step 为条件句（非 Clean）', /NOT a security guarantee/.test(r.next_step), r.next_step)
  assert('r12.1: 响应带 coverage 边界字段', typeof r.coverage === 'string' && /NOT covered/.test(r.coverage), r.coverage)
}

// ── r39: 误报抑制（行级 malong-ignore + 配置 securityIgnore；自包含 temp WS，不依赖 MALONG 配置）──
console.log('── r39: 误报抑制 ──')
const WS = join(os.tmpdir(), 'opencode', 'sec-suppress-ws')
try { rmSync(WS, { recursive: true, force: true }) } catch {}
mkdirSync(WS, { recursive: true })

// 行级（WS 无 .ai-patterns.json，纯行级行为）
let r = await handle({ workspace_dir: WS, source: 'const r = eval(userInput)' }, {})
assert('r39: 无标记 eval 必抓', r.summary.total === 1 && (r.summary.suppressed || 0) === 0, JSON.stringify(r.summary))
r = await handle({ workspace_dir: WS, source: 'const r = eval(userInput) // malong-ignore: 受控输入' }, {})
assert('r39: 行级 malong-ignore 抑制', r.summary.total === 0 && r.summary.suppressed === 1, JSON.stringify(r.summary))
r = await handle({ workspace_dir: WS, source: 'const r = eval(userInput) // malong-ignore[exec-cmd]' }, {})
assert('r39: [exec-cmd] 不殃及 eval', r.summary.total === 1 && (r.summary.suppressed || 0) === 0, JSON.stringify(r.summary))
r = await handle({ workspace_dir: WS, source: 'const r = eval(userInput) // malong-ignore[eval]' }, {})
assert('r39: [eval] 精确抑制', r.summary.total === 0 && r.summary.suppressed === 1, JSON.stringify(r.summary))

// 配置 file×rule
writeFileSync(join(WS, '.ai-patterns.json'), JSON.stringify({ rules: [], securityIgnore: [{ files: ['**/trusted.js'], rules: ['eval'] }] }))
writeFileSync(join(WS, 'trusted.js'), 'module.exports = x => eval(x)\n')
r = await handle({ workspace_dir: WS, file: 'trusted.js' }, {})
assert('r39: 配置 file×rule 抑制', r.summary.total === 0 && r.summary.suppressed === 1, JSON.stringify(r.summary))
writeFileSync(join(WS, 'untrusted.js'), 'module.exports = x => eval(x)\n')
r = await handle({ workspace_dir: WS, file: 'untrusted.js' }, {})
assert('r39: 配置不殃及其他文件', r.summary.total === 1 && (r.summary.suppressed || 0) === 0, JSON.stringify(r.summary))

// 配置 file-only（省 rules=全规则）抑制多条
writeFileSync(join(WS, '.ai-patterns.json'), JSON.stringify({ rules: [], securityIgnore: [{ files: ['**/fixture.js'] }] }))
writeFileSync(join(WS, 'fixture.js'), 'eval(a)\nprocess.exit(1)\n')
r = await handle({ workspace_dir: WS, file: 'fixture.js' }, {})
assert('r39: 配置 file-only 全规则抑制', r.summary.total === 0 && r.summary.suppressed === 2, JSON.stringify(r.summary))

// 红线：移除配置后无显式标记，注入必抓（安全姿态不被抑制机制削弱）
rmSync(join(WS, '.ai-patterns.json'))
r = await handle({ workspace_dir: WS, source: 'eval(z)' }, {})
assert('r39 红线: 无显式抑制注入必抓', r.summary.total === 1, JSON.stringify(r.summary))

// ── r43: 配置查找不越过 workspace_dir（父目录配置不得污染子 workspace 扫描） ──
console.log('── r43 配置越界防护 ──')
{
  const outer = join(os.tmpdir(), 'opencode')
  const fakeCfg = join(outer, '.ai-patterns.json')
  const prevExists = existsSync(fakeCfg)
  const prevContent = prevExists ? readFileSync(fakeCfg, 'utf-8') : null
  writeFileSync(fakeCfg, JSON.stringify({ rules: [], securityIgnore: [{ files: ['**/evil.js'], rules: ['eval'] }] }))
  writeFileSync(join(WS, 'evil.js'), 'const x = eval("1+1")\n')
  const scoped = await handle({ workspace_dir: WS, scope: '.' }, {})
  const evilResult = scoped.results?.find(r => r.file_path === 'evil.js')
  assert('r43: 父目录配置不抑制 workspace 内 eval', evilResult?.summary?.total === 1 && (evilResult?.summary?.suppressed || 0) === 0 && (scoped.suppressed || 0) === 0, JSON.stringify(evilResult?.summary))
  if (prevExists) writeFileSync(fakeCfg, prevContent); else rmSync(fakeCfg)
  rmSync(join(WS, 'evil.js'))
}

console.log(`\n═══════════════════════════════════════`)
console.log(`== test-security-review-rules: ${passed} passed, ${failed} failed ==`)
process.exit(failed > 0 ? 1 : 0)
