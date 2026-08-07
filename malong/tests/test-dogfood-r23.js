// r23：通天组件整合 5 新工具 dogfood 测试
// code_review / style_sniffer / security_review / git_worktree / debug_runner
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const imp = (p) => import(pathToFileURL(p).href)
const MALONG = join(__dirname, '..')
const WS = join(tmpdir(), `r23-${Date.now()}`)

let passed = 0, failed = 0
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`) }
  else { failed++; console.log(`  ✗ FAIL: ${msg}`) }
}

mkdirSync(WS, { recursive: true })

// ── 1. code_review ──
const codeReview = (await imp(join(MALONG, 'tools/tool-code-review/handler.js'))).handle
{
  const badSource = `function processUserData(name) {\n  if (name === 'a') { return name }\n  if (name === 'b') { return name }\n  if (name === 'c') { return name }\n  const tmp = name + 'x'\n  const tmp2 = name + 'y'\n  const tmp3 = name + 'z'\n  return tmp + tmp2 + tmp3\n}\n`
  const r = await codeReview({ workspace_dir: WS, source: badSource, file: 'bad_file_name.js' })
  assert(r.mode === 'source', 'code_review: source 模式')
  assert(typeof r.summary.shape_score === 'number' && r.summary.shape_score >= 0 && r.summary.shape_score <= 100, `code_review: shape_score 在 0-100（得 ${r.summary.shape_score}）`)
  assert(r.summary.warnings >= 0, 'code_review: warnings 汇总存在')

  // diff 模式
  const diff = `<<<<<<< SEARCH\nfunction old() {\n  return 1\n}\n=======\nfunction newFn() {\n  return 2\n}\n>>>>>>> REPLACE`
  const rd = await codeReview({ workspace_dir: WS, diff })
  assert(rd.mode === 'diff' && rd.blocks_reviewed === 1, `code_review: diff 模式解析 1 块（得 ${rd.blocks_reviewed}）`)

  // 长函数检测
  let long = 'function longFn() {\n'
  for (let i = 0; i < 60; i++) long += `  const v${i} = ${i}\n`
  long += '  return v0\n}\n'
  const rl = await codeReview({ workspace_dir: WS, source: long, file: 'ok.js' })
  assert(rl.issues.some(i => i.category === 'complexity'), `code_review: 长函数被检出（得 ${JSON.stringify(rl.issues.map(i => i.category))}）`)

  // r10e：语言惯例感知——Python snake_case 文件名不再报命名；注释率规则删除（>100 行无注释不再 info 噪声）
  const rPy = await codeReview({ workspace_dir: WS, source: 'def build_gat_dataset():\n    return 1\n', file: 'build_gat_dataset.py' })
  assert(!rPy.issues.some(i => i.category === 'naming'), `code_review: Python snake_case 文件名零命名噪声（得 ${JSON.stringify(rPy.issues.map(i => i.category))}）`)
  const rNoComment = await codeReview({ workspace_dir: WS, source: Array.from({ length: 120 }, (_, i) => `const v${i} = ${i}`).join('\n'), file: 'no_comment.js' })
  assert(!rNoComment.issues.some(i => i.category === 'documentation' && i.message.includes('注释比')), `code_review: 注释率规则已删（得 ${JSON.stringify(rNoComment.issues.map(i => i.message.slice(0, 30)))}）`)
  const rJsSnake = await codeReview({ workspace_dir: WS, source: 'const a = 1\n', file: 'bad_file_name.js' })
  assert(rJsSnake.issues.some(i => i.category === 'naming'), `code_review: JS snake_case 文件名仍报（语言惯例只豁免 Python）`)
}

// ── 2. style_sniffer ──
const styleSniffer = (await imp(join(MALONG, 'tools/tool-style-sniffer/handler.js'))).handle
{
  writeFileSync(join(WS, 'a.js'), `export function alpha(x) {\n  if (x > 1) {\n    return 'ok'\n  }\n  return 'no'\n}\n`)
  writeFileSync(join(WS, 'b.js'), `export function beta(x) {\n  return x + 1\n}\n`)
  writeFileSync(join(WS, 'c.js'), `export function gamma(x) {\n  const y = x * 2\n  return y\n}\n`)
  writeFileSync(join(WS, 'd.py'), `def alpha_fn(x):\n    if x > 1:\n        return True\n    return False\n`)
  writeFileSync(join(WS, 'e.py'), `def beta_fn(x):\n    return x + 1\n`)

  const r = await styleSniffer({ workspace_dir: WS })
  assert(r.status === 'done', `style_sniffer: 抽样完成（得 ${r.status}，files=${r.files}）`)
  assert(r.files === 5, 'style_sniffer: 抽样 5 个文件')
  assert(typeof r.project_rules === 'string' && r.project_rules.includes('# PROJECT_RULES'), 'style_sniffer: 生成 PROJECT_RULES 内容')
  assert(r.styles.indent && r.styles.indent.style === 'space', `style_sniffer: 缩进检测（得 ${JSON.stringify(r.styles.indent)}）`)
  assert(r.styles.quotes === 'single', `style_sniffer: 引号检测 single（得 ${r.styles.quotes}）`)

  // 确定性：两次调用抽样一致
  const r2 = await styleSniffer({ workspace_dir: WS })
  assert(JSON.stringify(r.sampled) === JSON.stringify(r2.sampled), 'style_sniffer: 确定性抽样（两次一致）')

  // output 写文件
  const r3 = await styleSniffer({ workspace_dir: WS, output: '.' })
  assert(r3.rules_path && existsSync(r3.rules_path), `style_sniffer: output 写文件（得 ${r3.rules_path}）`)

  // 文件不足
  mkdirSync(join(WS, 'tiny'), { recursive: true })
  writeFileSync(join(WS, 'tiny', 'x.js'), 'export const a = 1\n')
  const r4 = await styleSniffer({ workspace_dir: WS, scope: 'tiny' })
  assert(r4.status === 'insufficient_files', `style_sniffer: 文件不足检测（得 ${r4.status}）`)
}

// ── 3. security_review ──
const securityReview = (await imp(join(MALONG, 'tools/tool-security-review/handler.js'))).handle
{
  const vuln = `const password = 'hunter2'\nconst apiKey = 'sk-abcdef1234567890'\neval(userInput)\n`
  const r = await securityReview({ workspace_dir: WS, source: vuln, file: 'app.js' })
  assert(r.summary.high >= 3, `security_review: 高危≥3（密码/密钥/eval）（得 high=${r.summary.high}）`)
  assert(r.findings.some(f => f.id === 'eval'), 'security_review: eval 检出')
  assert(r.findings.some(f => f.id === 'password-hardcode'), 'security_review: 硬编码密码检出')
  assert(r.findings.some(f => f.id === 'api-key-hardcode'), 'security_review: API key 检出')

  // 目录模式
  const r2 = await securityReview({ workspace_dir: WS, scope: '.' })
  assert(r2.mode === 'directory' && r2.files_scanned > 0, `security_review: 目录模式（扫 ${r2.files_scanned} 文件）`)

  // 干净代码
  const clean = `export function add(a, b) {\n  return a + b\n}\n`
  const r3 = await securityReview({ workspace_dir: WS, source: clean, file: 'clean.js' })
  // r12：score→shape_score 语义降级——0 命中≠安全/干净（C1 教训）；干净代码 shape_score 应满且总数为 0
  assert(r3.summary.total === 0 && r3.summary.shape_score === 100, `security_review: 干净代码 shape_score 100 分（得 ${r3.summary.shape_score}）`)
}

// ── 4. git_worktree ──
const gitWorktree = (await imp(join(MALONG, 'tools/tool-git-worktree/handler.js'))).handle
{
  const gitRepo = join(WS, 'gitrepo')
  mkdirSync(gitRepo, { recursive: true })
  const { execSync } = await import('node:child_process')
  execSync('git init -q -b main .', { cwd: gitRepo })
  execSync('git config user.email test@test.local && git config user.name test', { cwd: gitRepo })
  writeFileSync(join(gitRepo, 'a.txt'), 'hello\n')
  execSync('git add -A && git commit -qm init', { cwd: gitRepo })

  // 非 git 目录
  const r0 = await gitWorktree({ workspace_dir: WS, changes: [{ path: 'x.txt', new_content: 'x' }] })
  assert(r0.error === 'not_a_git_repo', `git_worktree: 非 git 仓库拒绝（得 ${r0.error}）`)

  // 成功事务
  const r = await gitWorktree({
    workspace_dir: gitRepo,
    changes: [{ path: 'a.txt', new_content: 'hello v2\n' }, { path: 'b.txt', new_content: 'new file\n' }],
    message: 'r23 test change',
  })
  assert(r.success === true, `git_worktree: 事务成功（得 ${JSON.stringify(r)?.slice(0, 120)}）`)
  assert(existsSync(join(gitRepo, 'b.txt')), 'git_worktree: 新文件已落地')
  assert(!existsSync(join(gitRepo, '.git/worktrees'), 'x'), 'git_worktree: worktree 已清理')
  const log = execSync('git log --oneline -1', { cwd: gitRepo, encoding: 'utf-8' })
  assert(log.includes('r23 test change'), `git_worktree: 提交信息正确（得 ${log.trim()}）`)

  // verify_cmd 失败回滚
  const rv = await gitWorktree({
    workspace_dir: gitRepo,
    changes: [{ path: 'c.txt', new_content: 'should roll back\n' }],
    verify_cmd: 'exit 1',
  })
  assert(rv.success === false && rv.error === 'transaction_rolled_back', `git_worktree: verify 失败回滚（得 ${rv.error}）`)
  assert(!existsSync(join(gitRepo, 'c.txt')), 'git_worktree: 回滚后无 c.txt')
  const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: gitRepo, encoding: 'utf-8' }).trim()
  assert(branch === 'main', `git_worktree: 回滚后回到原分支（得 ${branch}）`)

  // 路径穿越防护
  const rp = await gitWorktree({ workspace_dir: gitRepo, changes: [{ path: '../escape.txt', new_content: 'x' }] })
  assert(rp.error === 'invalid_parameter', `git_worktree: 路径穿越拒绝（得 ${rp.error}）`)
}

// ── 5. debug_runner ──
const debugRunner = (await imp(join(MALONG, 'tools/tool-debug-runner/handler.js'))).handle
{
  writeFileSync(join(WS, 'boom.js'), `function crash() {\n  return undefinedVar + 1\n}\ncrash()\n`)
  const r = await debugRunner({ workspace_dir: WS, script: 'boom.js' })
  assert(r.mode === 'script', 'debug_runner: script 模式')
  assert(r.exit_code !== 0, `debug_runner: 失败退出码（得 ${r.exit_code}）`)
  assert(r.error_type === 'ReferenceError', `debug_runner: 错误分类 ReferenceError（得 ${r.error_type}）`)
  assert(r.suggested_action && r.suggested_action.length > 0, 'debug_runner: 建议动作存在')

  writeFileSync(join(WS, 'ok.js'), `console.log('hello from ok')\n`)
  const r2 = await debugRunner({ workspace_dir: WS, script: 'ok.js' })
  assert(r2.exit_code === 0 && r2.error_type === null, `debug_runner: 成功运行（exit=${r2.exit_code}, type=${r2.error_type}）`)
  assert(r2.stdout.includes('hello from ok'), 'debug_runner: stdout 捕获')

  // command 模式
  const r3 = await debugRunner({ workspace_dir: WS, command: `node -e "throw new TypeError('bad type')"` })
  assert(r3.mode === 'command' && r3.error_type === 'TypeError', `debug_runner: command 模式错误分类（得 ${r3.error_type}）`)

  // 不存在的脚本
  const r4 = await debugRunner({ workspace_dir: WS, script: 'nope.js' })
  assert(r4.error === 'file_not_found', 'debug_runner: 文件不存在检测')
}

// ── 6. r23-fix 审查修复验证（P0 穿越 / P1 逻辑 / P2 盲区） ──
{
  // 路径穿越全拒
  writeFileSync(join(WS, 'hack-target.js'), 'const s = "x"\n')
  const esc1 = await codeReview({ workspace_dir: join(WS, 'nope'), file: '../hack-target.js' })
  assert(esc1.error === 'path_escape', `code_review: 穿越拒绝（得 ${esc1.error}）`)
  const esc2 = await securityReview({ workspace_dir: join(WS, 'nope'), file: '../hack-target.js' })
  assert(esc2.error === 'path_escape', 'security_review: 穿越拒绝')
  const esc3 = await styleSniffer({ workspace_dir: join(WS, 'nope'), scope: '../' })
  assert(esc3.error === 'path_escape', 'style_sniffer: scope 穿越拒绝')
  const esc4 = await debugRunner({ workspace_dir: join(WS, 'nope'), script: '../hack-target.js' })
  assert(esc4.error === 'path_escape', 'debug_runner: script 穿越拒绝')
  const esc5 = await styleSniffer({ workspace_dir: WS, scope: '.', output: '../evad' })
  assert(esc5.error === 'path_escape', 'style_sniffer: output 穿越写拒绝')

  // if 块不误报（控制语句排除）
  let ifBlock = 'function real() {\n'
  for (let i = 0; i < 5; i++) ifBlock += `  const v${i} = ${i}\n`
  ifBlock += '}\nif (condition) {\n'
  for (let i = 0; i < 60; i++) ifBlock += `  const w${i} = ${i}\n`
  ifBlock += '}\n'
  const ri = await codeReview({ workspace_dir: WS, source: ifBlock, file: 'x.js' })
  assert(!ri.issues.some(i => i.category === 'complexity' && /函数 "if"/.test(i.message)), 'code_review: if 块不误报')

  // 尾逗号 1 处 vs 4 处 → no（独立目录避免抽样干扰）
  const tc = join(WS, 'tc')
  mkdirSync(tc, { recursive: true })
  writeFileSync(join(tc, 'a.js'), 'export const list = [\n  1,\n  2,\n  3,\n]\n')
  writeFileSync(join(tc, 'b.js'), 'export const b = {\n  a: 1\n}\n')
  writeFileSync(join(tc, 'c.js'), 'export const c = 1\n')
  writeFileSync(join(tc, 'd.py'), 'def f():\n    return 1\n')
  writeFileSync(join(tc, 'e.go'), 'package main\nfunc main() {}\n')
  const td1 = await styleSniffer({ workspace_dir: WS, scope: 'tc' })
  assert(td1.styles.trailingCommas === 'no', `style_sniffer: 尾逗号 no（得 ${td1.styles.trailingCommas}）`)

  // script 模式 cwd=workspace_dir
  writeFileSync(join(WS, 'rel.js'), `const fs = require('node:fs')\nconsole.log('rel:', fs.existsSync('tc'))\n`)
  const rd = await debugRunner({ workspace_dir: WS, script: 'rel.js' })
  assert(rd.stdout.includes('rel: true'), `debug_runner: 脚本内相对路径可见（得 ${rd.stdout.trim()}）`)

  // rust 并发互不覆盖
  writeFileSync(join(WS, 'a.rs'), 'fn main() { println!("A"); }\n')
  writeFileSync(join(WS, 'b.rs'), 'fn main() { println!("B"); }\n')
  const [ra, rb] = await Promise.all([debugRunner({ workspace_dir: WS, script: 'a.rs' }), debugRunner({ workspace_dir: WS, script: 'b.rs' })])
  assert(ra.stdout.includes('A') && rb.stdout.includes('B'), `debug_runner: rust 并发互不覆盖（A=${ra.stdout.trim()}, B=${rb.stdout.trim()}）`)

  // timeout → TimeoutError
  writeFileSync(join(WS, 'sleep.js'), 'setTimeout(() => console.log("done"), 5000)\n')
  const ts = await debugRunner({ workspace_dir: WS, script: 'sleep.js', timeout: 400 })
  assert(ts.error_type === 'TimeoutError', `debug_runner: timeout→TimeoutError（得 ${ts.error_type}）`)

  // .env 安全盲区修复
  const secdir = join(WS, 'secdir')
  mkdirSync(secdir, { recursive: true })
  writeFileSync(join(secdir, '.env'), 'SECRET_TOKEN=hunter2-super-secret\n')
  writeFileSync(join(secdir, 'app.js'), 'const a = 1\n')
  const sd = await securityReview({ workspace_dir: WS, scope: 'secdir' })
  assert(sd.total_findings >= 1, `security_review: .env 密钥扫到（total=${sd.total_findings}）`)

  // git_worktree：合法名含".."不再误拒 / 真穿越仍拒绝 / dirty / detached
  const { execSync } = await import('node:child_process')
  const fixRepo = join(WS, 'fixrepo')
  mkdirSync(fixRepo)
  execSync('git init -q -b main .', { cwd: fixRepo })
  execSync('git config user.email t@t && git config user.name t', { cwd: fixRepo })
  writeFileSync(join(fixRepo, 'a.txt'), 'x\n')
  execSync('git add -A && git commit -qm init', { cwd: fixRepo })
  const gf = await gitWorktree({ workspace_dir: fixRepo, changes: [{ path: 'foo..bar.txt', new_content: 'x\n' }] })
  assert(gf.success === true, `git_worktree: foo..bar.txt 合法名提交（${gf.success}）`)
  const ge = await gitWorktree({ workspace_dir: fixRepo, changes: [{ path: '../esc.txt', new_content: 'x' }] })
  assert(ge.error === 'invalid_parameter', 'git_worktree: 真穿越仍拒绝')
  writeFileSync(join(fixRepo, 'dirty.txt'), 'x\n')
  const gd = await gitWorktree({ workspace_dir: fixRepo, changes: [{ path: 'b.txt', new_content: 'x\n' }] })
  assert(gd.error === 'dirty_workspace', `git_worktree: dirty 拒绝（得 ${gd.error}）`)
  execSync('git clean -f -q', { cwd: fixRepo })
  execSync('git checkout -q --detach HEAD', { cwd: fixRepo })
  const gdd = await gitWorktree({ workspace_dir: fixRepo, changes: [{ path: 'd.txt', new_content: 'x\n' }] })
  assert(gdd.error === 'detached_head', `git_worktree: detached 拒绝（得 ${gdd.error}）`)
  execSync('git checkout -q main', { cwd: fixRepo })

  // 负数 max_issues clamp
  let src = ''
  for (let i = 0; i < 10; i++) src += `const t${i} = ${i} // ${'c'.repeat(50)}\n`
  const rc = await codeReview({ workspace_dir: WS, source: src, file: 'm.js', max_issues: -3 })
  assert(!rc.truncated, 'code_review: 负数 max_issues clamp 不尾截')
}

// ── 7. r23-fix2 LLM 使用者视角（patch 格式 / 截断标记 / 覆盖保护 / 见性成佛） ──
{
  // unified diff 解析
  const unified = `--- a/src/foo.js
+++ b/src/foo.js
@@ -1,3 +1,4 @@
-const badName = 1
+const goodName = 1
+// comment line
+const another_one = 2
`
  const ru = await codeReview({ workspace_dir: WS, diff: unified })
  assert(ru.mode === 'diff' && ru.format === 'unified' && ru.blocks_reviewed === 1 && ru.files[0] === 'src/foo.js', `code_review: unified diff 解析（format=${ru.format}, blocks=${ru.blocks_reviewed}, files=${JSON.stringify(ru.files)}）`)

  // 垃圾 diff 明确报错（不再静默 blocks=0）
  const rg = await codeReview({ workspace_dir: WS, diff: 'not a real diff' })
  assert(rg.error === 'invalid_diff_format', `code_review: 垃圾 diff 报错（${rg.error}）`)

  // 截断标记 + cwd 返回
  writeFileSync(join(WS, 'big.js'), `for (let i = 0; i < 3000; i++) console.log('line ' + i)\n`)
  const db = await debugRunner({ workspace_dir: WS, script: 'big.js' })
  assert(db.truncated?.stdout === true && db.stdout_full_length > 6000, `debug_runner: 截断标记（${JSON.stringify(db.truncated)}, full=${db.stdout_full_length}）`)
  const dc = await debugRunner({ workspace_dir: WS, command: 'echo hi' })
  assert(dc.cwd === WS, `debug_runner: command 返回 cwd（${dc.cwd}）`)

  // timeout 下限（LLM 传秒单位不秒超时）
  writeFileSync(join(WS, 'quick.js'), 'console.log("fast")\n')
  const dq = await debugRunner({ workspace_dir: WS, script: 'quick.js', timeout: 1 })
  assert(dq.exit_code === 0, `debug_runner: timeout=1 clamp 1000ms（exit=${dq.exit_code}）`)

  // style_sniffer 覆盖保护 + force
  writeFileSync(join(WS, 'PROJECT_RULES.md'), '# PROJECT_RULES\n## 人工维护\n')
  const se = await styleSniffer({ workspace_dir: WS, output: '.' })
  assert(se.status === 'exists', `style_sniffer: 已存在不覆盖（status=${se.status}）`)
  const sf = await styleSniffer({ workspace_dir: WS, output: '.', force: true })
  assert(sf.status === 'done', 'style_sniffer: force=true 覆盖')

  // 无虚假占位
  const sp = await styleSniffer({ workspace_dir: WS })
  assert(!sp.project_rules.includes('auto-detected from package.json'), 'style_sniffer: 无虚假占位')

  // git_worktree 分支名无时间戳 + 回滚指引
  const { execSync } = await import('node:child_process')
  const fix2Repo = join(WS, 'fix2repo')
  mkdirSync(fix2Repo)
  execSync('git init -q -b main .', { cwd: fix2Repo })
  execSync('git config user.email t@t && git config user.name t', { cwd: fix2Repo })
  writeFileSync(join(fix2Repo, 'a.txt'), 'x\n')
  execSync('git add -A && git commit -qm init', { cwd: fix2Repo })
  const g2 = await gitWorktree({ workspace_dir: fix2Repo, changes: [{ path: 'b.txt', new_content: 'y\n' }] })
  assert(/^tongtian-multi-[0-9a-f]{12}$/.test(g2.branch), `git_worktree: 分支名无 Date.now（${g2.branch}）`)
  assert(g2.next_step.includes('git revert'), 'git_worktree: 回滚指引')

  // findings 总量上限
  const many = join(WS, 'many2')
  mkdirSync(many)
  for (let i = 0; i < 40; i++) writeFileSync(join(many, `f${i}.js`), `const x${i} = ${i}\neval(userInput${i})\n`)
  const sf2 = await securityReview({ workspace_dir: WS, scope: 'many2' })
  assert(sf2.total_findings <= 200, `security_review: findings 上限（total=${sf2.total_findings}）`)

  // TODO 行号
  const rt = await codeReview({ workspace_dir: WS, source: '// TODO: fix\nconst a = 1\n', file: 't.js' })
  const todoIssue = rt.issues.find(i => i.category === 'maintainability')
  assert(todoIssue && todoIssue.line === 1, `code_review: TODO 行号（line=${todoIssue?.line}）`)
}

// ── 8. r23-fix3 三轮审查：输入类型健壮性 / 性能上限 / 确定性 ──
{
  // 非字符串路径参数 → 明确错误而非 TypeError 崩溃
  const ft1 = await codeReview({ workspace_dir: WS, file: 123 })
  assert(ft1.error === 'path_escape', `code_review: file=123 不崩溃（${ft1.error || ft1.mode}）`)
  const ft2 = await styleSniffer({ workspace_dir: WS, scope: 123 })
  assert(ft2.error === 'path_escape', `style_sniffer: scope=123 不崩溃（${ft2.error || ft2.status}）`)
  const ft3 = await debugRunner({ workspace_dir: WS, script: 123 })
  assert(ft3.error === 'path_escape', `debug_runner: script=123 不崩溃（${ft3.error || ft3.mode}）`)
  const ft4 = await securityReview({ workspace_dir: WS, scope: 123 })
  assert(ft4.error === 'path_escape', `security_review: scope=123 不崩溃（${ft4.error || ft4.mode}）`)
  const ft5 = await styleSniffer({ workspace_dir: WS, output: 123 })
  assert(ft5.error === 'path_escape', `style_sniffer: output=123 不崩溃（${ft5.error || ft5.status}）`)
  const ft6 = await codeReview({ workspace_dir: 123, source: 'const a = 1\n' })
  assert(!ft6.crash, `code_review: workspace_dir=123 不崩溃（${ft6.error || ft6.mode}）`)

  // git_worktree new_content 类型污染（对象会被静默写成 '[object Object]' 并提交）
  const { execSync } = await import('node:child_process')
  const ftRepo = join(WS, 'ftrepo')
  mkdirSync(ftRepo)
  execSync('git init -q -b main .', { cwd: ftRepo })
  execSync('git config user.email t@t && git config user.name t', { cwd: ftRepo })
  writeFileSync(join(ftRepo, 'a.txt'), 'x\n')
  execSync('git add -A && git commit -qm init', { cwd: ftRepo })
  const ftg = await gitWorktree({ workspace_dir: ftRepo, changes: [{ path: 'b.txt', new_content: { evil: 1 } }] })
  assert(ftg.error === 'invalid_parameter', `git_worktree: new_content=对象拒绝（${ftg.error}）`)
  const ftg2 = await gitWorktree({ workspace_dir: ftRepo, changes: [{ path: 'b.txt', new_content: 'ok\n' }] })
  assert(ftg2.success === true, 'git_worktree: 正常 string 仍可提交')
  const ftg3 = await gitWorktree({ workspace_dir: ftRepo, changes: [{ path: 'c.txt', delete: 'yes' }] })
  assert(ftg3.error === 'invalid_parameter', `git_worktree: delete=非 boolean 拒绝（${ftg3.error}）`)

  // 大目录 walk 上限（5000 截断不卡）
  const big = join(WS, 'bigdir')
  mkdirSync(big)
  for (let i = 0; i < 6000; i++) writeFileSync(join(big, `f${i}.js`), `export const v${i} = ${i}\n`)
  const fb = await styleSniffer({ workspace_dir: WS, scope: 'bigdir' })
  assert(fb.status === 'done', `style_sniffer: 6000 文件 walk 上限生效（status=${fb.status}）`)

  // 确定性：同输入两次输出一致
  const det1 = await codeReview({ workspace_dir: WS, source: 'function longName() {\n  const someVar = 1\n  return someVar\n}\n// TODO x\n', file: 'det.js' })
  const det2 = await codeReview({ workspace_dir: WS, source: 'function longName() {\n  const someVar = 1\n  return someVar\n}\n// TODO x\n', file: 'det.js' })
  assert(JSON.stringify(det1.issues) === JSON.stringify(det2.issues), 'code_review: 确定性一致')
}

// ── 9. r23-fix4 四轮审查：manifest↔handler 契约 ──
{
  // source+file 同传：行为 source 优先，返回 file=undefined（避免 LLM 误以为审查的是磁盘文件）
  writeFileSync(join(WS, 'ct.js'), 'const realFileContent = 1\n')
  const ct1 = await codeReview({ workspace_dir: WS, source: 'const goodName = 1\n', file: 'ct.js' })
  assert(ct1.file === undefined && ct1.source_provided === true, `code_review: source 优先返回一致（file=${ct1.file}, source_provided=${ct1.source_provided}）`)
  const ct2 = await securityReview({ workspace_dir: WS, source: 'const goodName = 1\n', file: 'ct.js' })
  assert(ct2.file === undefined && ct2.source_provided === true, `security_review: source 优先返回一致（file=${ct2.file}, source_provided=${ct2.source_provided}）`)
  const ct3 = await codeReview({ workspace_dir: WS, file: 'ct.js' })
  assert(ct3.file === 'ct.js' && ct3.source_provided === false, `code_review: file 模式标记（file=${ct3.file}, source_provided=${ct3.source_provided}）`)
  const ct4 = await codeReview({ workspace_dir: WS, source: 'const snake_case_name = 1\n', file: 'ct.js' })
  assert(ct4.issues.some(i => i.category === 'naming' && i.severity === 'warn'), 'code_review: 审查内容确实是 source 而非磁盘文件')
}

// ── 10. r23-fix5 五轮审查收尾：返回一致性 / 冲突参数 / 通天遗留 ──
{
  // source 模式 issues 带 file（与 diff 模式统一，JSON 不丢字段）
  const fc1 = await codeReview({ workspace_dir: WS, source: 'const snake_case_name = 1\n// TODO x\n', file: 'f.js' })
  assert(fc1.issues.length > 0 && fc1.issues.every(i => i.file !== undefined), `code_review: source 模式 issues 带 file（${fc1.issues.map(i => i.file).join(',')}）`)
  writeFileSync(join(WS, 'f.js'), 'const realFile = 1\n// TODO later\n')
  const fc2 = await codeReview({ workspace_dir: WS, file: 'f.js' })
  assert(fc2.issues.every(i => i.file === 'f.js'), `code_review: file 模式 issues 带实际文件名（${fc2.issues.map(i => i.file).join(',')}）`)

  // new_content+delete 冲突参数报错（不再静默忽略 delete）
  const fcRepo = join(WS, 'fc-repo')
  mkdirSync(fcRepo)
  execSync('git init -q -b main .', { cwd: fcRepo })
  execSync('git config user.email t@t && git config user.name t', { cwd: fcRepo })
  writeFileSync(join(fcRepo, 'a.txt'), 'x\n')
  execSync('git add -A && git commit -qm init', { cwd: fcRepo })
  const fc3 = await gitWorktree({ workspace_dir: fcRepo, changes: [{ path: 'a.txt', new_content: 'new\n', delete: true }] })
  assert(fc3.error === 'invalid_parameter', `git_worktree: 冲突参数报错（${fc3.error}）`)

  // 无通天私有目录名遗留（通用工具不得含项目特定约定）
  const { readFileSync: rfs } = await import('node:fs')
  const ssSrc = rfs(join(MALONG, 'tools/tool-style-sniffer/handler.js'), 'utf-8')
  assert(!ssSrc.includes('tusunsun'), 'style_sniffer: 无通天私有目录名遗留')
}

rmSync(WS, { recursive: true, force: true })
console.log(`\n== test-dogfood-r23: ${passed} passed, ${failed} failed ==`)
process.exit(failed ? 1 : 0)
