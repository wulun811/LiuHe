// test-security-review-rules.js — security_review 规则黄金测试（r27 新增）
// 背景：规则此前零测试覆盖。r27 dogfooding 自扫 27 条全误报，治理 exec-cmd/sql-concat 两条规则，
// 本测试固化「真注入必抓 + 误报模式必免」，防回归。
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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

// 观测项：参数化 .prepare（r25 豁免逻辑实际行为，非 r27 断言）
f = await scan('db.prepare("SELECT * FROM t WHERE id = " + CONST).run()')
console.log(`  [观测] .prepare 参数化单行 → ${has(f, 'sql-concat') ? '仍报(豁免未覆盖此形态)' : '已豁免'}`)

console.log(`\n═══════════════════════════════════════`)
console.log(`== test-security-review-rules: ${passed} passed, ${failed} failed ==`)
process.exit(failed > 0 ? 1 : 0)
