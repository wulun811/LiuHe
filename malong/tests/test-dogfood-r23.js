// r23：通天组件整合 5 新工具 dogfood 测试
// code_review / style_sniffer / security_review / git_worktree / debug_runner
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MALONG = join(__dirname, '..')
const WS = join(tmpdir(), `r23-${Date.now()}`)

let passed = 0, failed = 0
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`) }
  else { failed++; console.log(`  ✗ FAIL: ${msg}`) }
}

mkdirSync(WS, { recursive: true })

// ── 1. code_review ──
const codeReview = (await import(join(MALONG, 'tools/tool-code-review/handler.js'))).handle
{
  const badSource = `function processUserData(name) {\n  if (name === 'a') { return name }\n  if (name === 'b') { return name }\n  if (name === 'c') { return name }\n  const tmp = name + 'x'\n  const tmp2 = name + 'y'\n  const tmp3 = name + 'z'\n  return tmp + tmp2 + tmp3\n}\n`
  const r = await codeReview({ workspace_dir: WS, source: badSource, file: 'bad_file_name.js' })
  assert(r.mode === 'source', 'code_review: source 模式')
  assert(typeof r.summary.score === 'number' && r.summary.score >= 0 && r.summary.score <= 100, `code_review: score 在 0-100（得 ${r.summary.score}）`)
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
}

// ── 2. style_sniffer ──
const styleSniffer = (await import(join(MALONG, 'tools/tool-style-sniffer/handler.js'))).handle
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
const securityReview = (await import(join(MALONG, 'tools/tool-security-review/handler.js'))).handle
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
  assert(r3.summary.total === 0 && r3.summary.score === 100, `security_review: 干净代码 100 分（得 ${r3.summary.score}）`)
}

// ── 4. git_worktree ──
const gitWorktree = (await import(join(MALONG, 'tools/tool-git-worktree/handler.js'))).handle
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
const debugRunner = (await import(join(MALONG, 'tools/tool-debug-runner/handler.js'))).handle
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

rmSync(WS, { recursive: true, force: true })
console.log(`\n== test-dogfood-r23: ${passed} passed, ${failed} failed ==`)
process.exit(failed ? 1 : 0)
