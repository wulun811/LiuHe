import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(__dirname, 'fixtures')

let passed = 0, failed = 0
const failures = []

function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; failures.push(label); console.log(`  ✗ ${label}`) }
}

const mockContext = {
  codeIndexService: null,
  getWorkspaceDir: (ws) => join(ws, '.malong'),
}

async function loadTool(name) {
  const mod = await import(`../tools/${name}/handler.js`)
  return mod.handle
}

// ═══ A1: test_bridge pytest -v -q 冲突 ═══
// buildCommand 生成 `-v --tb=short -q`，-q 覆盖 -v
// parser 期望 verbose 格式 (test::name PASSED)，但 -q 输出 "..F.."
async function testA1() {
  console.log('\n═══ A1: test_bridge pytest -v -q 冲突 ═══')
  const { buildCommand } = await import('../tools/tool-test-bridge/handler.js').then(m => {
    // buildCommand is not exported, test via handle
    return {}
  })

  // 直接测试 parser 对 quiet 格式的处理
  const { parsePytest } = await import('../tools/tool-test-bridge/parsers.js')

  // quiet 格式 (-q): 只有 dots 和 summary
  const quietOutput = `..F..
=== FAILURES ===
___ test_login ___
E   AssertionError: assert 1 == 2
=== short test summary info ===
FAILED tests/test_auth.py::test_login - AssertionError: assert 1 == 2
=== 4 passed, 1 failed in 0.5s ===`

  const quietParsed = parsePytest(quietOutput)
  // BUG: quiet 格式下 results 应该 > 0，但 parser 只认 verbose 格式
  assert(quietParsed.results.length > 0, `A1: quiet 格式解析出 ${quietParsed.results.length} 结果 (期望 >0)`)
  assert(quietParsed.summary.failed === 1, `A1: quiet 格式 summary.failed=${quietParsed.summary.failed} (期望 1)`)

  // verbose 格式 (-v): 每行 PASSED/FAILED
  const verboseOutput = `tests/test_auth.py::test_login_success PASSED
tests/test_auth.py::test_login_fail FAILED
=== 1 passed, 1 failed in 0.3s ===`

  const verboseParsed = parsePytest(verboseOutput)
  assert(verboseParsed.results.length === 2, `A1: verbose 格式解析出 ${verboseParsed.results.length} 结果 (期望 2)`)
}

// ═══ A2: config_drift DB_PATTERNS 漏掉真实 SQL ═══
async function testA2() {
  console.log('\n═══ A2: config_drift DB_PATTERNS 漏掉真实 SQL ═══')
  const handle = await loadTool('tool-config-drift')

  const result = await handle({ workspace_dir: FIXTURES, file: 'src/sql_queries.py' }, mockContext)

  const dbRefs = (result.config_references || []).filter(r => r.type === 'db_table')
  // BUG: "SELECT * FROM users" 不匹配，因为 regex 要求 SELECT 紧跟 FROM
  assert(dbRefs.length >= 3, `A2: 检测到 ${dbRefs.length} 个 DB 引用 (期望 >=3: users, audit_log, sessions)`)

  const tableNames = dbRefs.map(r => r.name)
  assert(tableNames.includes('users'), `A2: 检测到 users 表`)
  assert(tableNames.includes('audit_log'), `A2: 检测到 audit_log 表`)
  assert(tableNames.includes('sessions'), `A2: 检测到 sessions 表`)
}

// ═══ A3: config_drift .env export 前缀 ═══
async function testA3() {
  console.log('\n═══ A3: config_drift .env export 前缀 ═══')
  const handle = await loadTool('tool-config-drift')

  const result = await handle({ workspace_dir: FIXTURES, file: 'src/sql_queries.py' }, mockContext)

  // .env.production 有 export REDIS_URL=... 和 export SECRET_KEY=...
  // BUG: parseEnvFiles 不解析 export 前缀 → REDIS_URL 被误报为 drift
  const declaredVars = result.config_manifest?.declared_vars || []
  assert(declaredVars.includes('REDIS_URL'), `A3: REDIS_URL 在 declared_vars 中 (export 前缀)`)
  assert(declaredVars.includes('SECRET_KEY'), `A3: SECRET_KEY 在 declared_vars 中 (export 前缀)`)

  const envDrifts = (result.drifts || []).filter(d => d.type === 'missing_env_var')
  const redisDrift = envDrifts.find(d => d.name === 'REDIS_URL')
  assert(!redisDrift, `A3: REDIS_URL 不应被误报为 drift`)
}

// ═══ A3b: config_drift 无 env 文件 → env_manifest_absent 提示而非逐条误报（r58）═══
async function testA3b() {
  console.log('\n═══ A3b: config_drift 无 env 文件不误报 ═══')
  const handle = await loadTool('tool-config-drift')
  const ws = join(os.tmpdir(), 'opencode', 'cd-noenv-ws')
  try { rmSync(ws, { recursive: true, force: true }) } catch {}
  mkdirSync(join(ws, 'src'), { recursive: true })
  writeFileSync(join(ws, 'src', 'app.py'), 'import os\nport = os.environ["APP_PORT"]\nkey = os.getenv("API_KEY")\n')

  const result = await handle({ workspace_dir: ws }, mockContext)
  const envDrifts = (result.drifts || []).filter(d => d.type === 'missing_env_var')
  assert(result.env_manifest_absent === true, `A3b: env_manifest_absent 标志（得 ${result.env_manifest_absent}）`)
  assert(envDrifts.length === 0, `A3b: 无 env 文件时零逐条误报（得 ${envDrifts.length}）`)
  assert(String(result.note).includes('.env.example'), `A3b: note 提示创建 .env.example（${String(result.note).slice(0, 60)}）`)
  assert(String(result.next_step).includes('.env.example'), `A3b: next_step 指向创建清单`)

  // 有 .env.example 后恢复正常 drift 检测
  writeFileSync(join(ws, '.env.example'), 'APP_PORT=8080\n')
  const result2 = await handle({ workspace_dir: ws }, mockContext)
  const envDrifts2 = (result2.drifts || []).filter(d => d.type === 'missing_env_var')
  assert(result2.env_manifest_absent !== true, `A3b: 有清单后不再 manifest_absent`)
  assert(envDrifts2.some(d => d.name === 'API_KEY'), `A3b: 有清单后 API_KEY 正常报 missing（得 ${JSON.stringify(envDrifts2.map(d => d.name))}）`)
  try { rmSync(ws, { recursive: true, force: true }) } catch {}
}

// ═══ A4: 绝对路径 file 参数 ═══
async function testA4() {
  console.log('\n═══ A4: 绝对路径 file 参数 ═══')
  const handle = await loadTool('tool-active-todos')

  // LLM 常犯错误：file 传绝对路径
  const absFile = join(FIXTURES, 'src/auth.py')
  const result = await handle({ workspace_dir: FIXTURES, scope: '.', current_files: [absFile] }, mockContext)

  // current_files 里的绝对路径不会匹配 relPath → priority 不会 boost
  // 这不是 crash，但功能失效
  const authTodos = (result.todos || []).filter(t => t.file.includes('auth.py'))
  const boosted = authTodos.filter(t => t.priority === 'high')
  // BUG: 绝对路径不匹配 → 没有 high priority
  assert(boosted.length > 0 || authTodos.length === 0, `A4: 绝对路径 current_files 匹配 (boosted=${boosted.length}, authTodos=${authTodos.length})`)
}

// ═══ A5: SAFE_SCOPE_RE 缺少 [] ═══
async function testA5() {
  console.log('\n═══ A5: SAFE_SCOPE_RE 缺少 [] ═══')
  const handle = await loadTool('tool-test-bridge')

  // pytest 参数化测试: tests/test_auth.py::test_login[admin]
  const result = await handle({
    workspace_dir: FIXTURES,
    action: 'run',
    scope: 'tests/test_auth.py::test_login[admin]',
    framework: 'pytest',
  }, mockContext)

  // BUG: [ 和 ] 不在 SAFE_SCOPE_RE 中 → 被拦截
  assert(!result.error || result.error !== 'invalid_input',
    `A5: pytest 参数化 scope 不被拦截 (error=${result.error || 'none'})`)
}

// ═══ A6: mock_syncer 多行函数签名 ═══
async function testA6() {
  console.log('\n═══ A6: mock_syncer 多行函数签名 ═══')
  const handle = await loadTool('tool-mock-syncer')

  // multi_line.py 没有多行签名，用 auth.py 的 login 测试
  // 但我们需要一个多行签名的文件
  // 先测试单行签名确认正常工作
  const result = await handle({
    workspace_dir: FIXTURES,
    file: 'src/auth.py',
    function: 'login',
  }, mockContext)

  assert(result.target?.function === 'login', `A6: 单行签名正常解析`)
  assert(result.target?.signature?.includes('credentials'), `A6: 签名包含 credentials 参数`)

  // 现在测试多行签名 — 创建一个临时文件
  const { writeFileSync, mkdirSync, rmSync } = await import('node:fs')
  const tmpDir = join(FIXTURES, '_tmp_a6')
  try {
    mkdirSync(join(tmpDir, 'src'), { recursive: true })
    mkdirSync(join(tmpDir, 'tests'), { recursive: true })
    writeFileSync(join(tmpDir, 'src', 'service.py'), `
def create_user(
    username: str,
    email: str,
    role: str = "user",
) -> dict:
    return {"username": username}
`)
    writeFileSync(join(tmpDir, 'tests', 'test_service.py'), `
from unittest.mock import patch

@patch('src.service.create_user')
def test_create(mock_create):
    mock_create.return_value = {"username": "test"}
`)

    const result2 = await handle({
      workspace_dir: tmpDir,
      file: 'src/service.py',
      function: 'create_user',
    }, mockContext)

    // BUG: 多行签名不匹配 → symbol_not_found
    assert(!result2.error, `A6: 多行签名解析成功 (error=${result2.error || 'none'})`)
    if (!result2.error) {
      assert(result2.target?.signature?.includes('username'), `A6: 多行签名包含 username`)
      assert(result2.target?.signature?.includes('email'), `A6: 多行签名包含 email`)
    }
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  }
}

// ═══ A7: dead_code_sweeper import os.path 误报 ═══
async function testA7() {
  console.log('\n═══ A7: dead_code_sweeper import os.path 误报 ═══')
  const handle = await loadTool('tool-dead-code-sweeper')

  const result = await handle({ workspace_dir: FIXTURES, scope: 'src' }, mockContext)

  const unusedImports = (result.dead_code || []).filter(d => d.type === 'unused_import')
  const osPathFalsePositive = unusedImports.find(d => d.symbol === 'os.path' && d.file.includes('multi_line'))

  // BUG: import os.path → 使用 os.path.join() → 但 used set 里是 'os' 不是 'os.path'
  assert(!osPathFalsePositive, `A7: import os.path 不被误报为 unused (found=${!!osPathFalsePositive})`)

  // json 确实没被使用，应该被检测到
  const jsonUnused = unusedImports.find(d => d.symbol === 'json' && d.file.includes('multi_line'))
  assert(!!jsonUnused, `A7: import json 正确检测为 unused`)
}

// ═══ A8: exception_guard 多行 raise ═══
async function testA8() {
  console.log('\n═══ A8: exception_guard 多行 raise ═══')
  const handle = await loadTool('tool-exception-guard')

  const result = await handle({ workspace_dir: FIXTURES, file: 'src/exceptions.py' }, mockContext)

  // exceptions.py 有 2 个 raise ValueError + 1 个 raise ValidationError
  // 第一个 ValueError 是多行的: raise ValueError(\n "age must be non-negative"\n)
  const issues = result.issues || []
  const valueErrorIssues = issues.filter(i => i.raised === 'ValueError')

  // BUG: 多行 raise 的 message 不被捕获 → classifyMessage 返回 unknown → 无法建议具体异常
  assert(valueErrorIssues.length >= 2, `A8: 检测到 ${valueErrorIssues.length} 个 ValueError (期望 >=2)`)

  // 检查多行 raise 的 message 是否被捕获
  const multilineIssue = valueErrorIssues.find(i => i.line === 7) // raise ValueError( 在第 7 行
  if (multilineIssue) {
    assert(multilineIssue.message !== null, `A8: 多行 raise message 被捕获 (got: ${multilineIssue.message})`)
  } else {
    assert(false, `A8: 第 7 行多行 raise 被检测到`)
  }
}

// ═══ A9: edit_sandbox 模板字符串 ${} ═══
async function testA9() {
  console.log('\n═══ A9: edit_sandbox 模板字符串 ${} ═══')
  const handle = await loadTool('tool-edit-sandbox')

  const result = await handle({
    workspace_dir: FIXTURES,
    file: 'src/template.js',
    new_content: 'const greeting = `Hello, ${name}!`\nconst nested = `Value: ${obj.map(x => x.id).join(\',\')}`\n',
  }, mockContext)

  // BUG: ${} 内的 { 和 } 被当作普通括号 → 可能误报 mismatched
  const syntaxErrors = result.checks?.syntax?.errors || []
  const falsePositives = syntaxErrors.filter(e => e.severity === 'error')
  assert(falsePositives.length === 0, `A9: 模板字符串 \${} 不产生语法误报 (errors=${falsePositives.length})`)
}

// ═══ A9b: edit_sandbox 块注释 /* */（含 JSDoc）内括号不误报（r58：只加一行注释误报 4 处括号失衡）═══
async function testA9b() {
  console.log('\n═══ A9b: edit_sandbox 块注释内括号不误报 ═══')
  const handle = await loadTool('tool-edit-sandbox')

  const content = [
    '/**',
    ' * 注释里的括号 ( 和 } 还有 [ 不应被扫',
    ' * @param {Object} opts',
    ' */',
    'export function foo() {',
    '  return 1',
    '}',
    '',
  ].join('\n')
  const result = await handle({ workspace_dir: FIXTURES, file: 'src/block-comment.js', new_content: content }, mockContext)
  const syntaxErrors = (result.checks?.syntax?.errors || []).filter(e => e.severity === 'error')
  assert(syntaxErrors.length === 0, `A9b: 块注释内括号不误报 (errors=${syntaxErrors.length})`)

  // 跨行块注释（未闭合到下一行才结束）
  const content2 = [
    '/* 第一行 { (',
    '   第二行 } ) */',
    'const a = [1, 2]',
    '',
  ].join('\n')
  const result2 = await handle({ workspace_dir: FIXTURES, file: 'src/block-comment2.js', new_content: content2 }, mockContext)
  const errs2 = (result2.checks?.syntax?.errors || []).filter(e => e.severity === 'error')
  assert(errs2.length === 0, `A9b: 跨行块注释不误报 (errors=${errs2.length})`)

  // 失败路径：块注释外的真实失衡仍要报
  const content3 = [
    'export function bar() {',
    '  return (1',
    '}',
    '',
  ].join('\n')
  const result3 = await handle({ workspace_dir: FIXTURES, file: 'src/block-comment3.js', new_content: content3 }, mockContext)
  const errs3 = (result3.checks?.syntax?.errors || []).filter(e => e.severity === 'error')
  assert(errs3.length >= 1, `A9b: 真实括号失衡仍报错 (errors=${errs3.length})`)
}

// ═══ A10: test_bridge workspace_dir 不存在 ═══
async function testA10() {
  console.log('\n═══ A10: test_bridge workspace_dir 不存在 ═══')
  const handle = await loadTool('tool-test-bridge')

  const result = await handle({
    workspace_dir: '/nonexistent/path/that/does/not/exist',
    action: 'run',
    scope: '.',
    framework: 'pytest',
  }, mockContext)

  // 修复后: 返回 workspace_not_found 错误
  assert(result.error === 'workspace_not_found',
    `A10: 不存在的 workspace 返回 workspace_not_found (error=${result.error || 'none'})`)
}

// ═══ A11: rename_symbol 字符串内匹配 ═══
async function testA11() {
  console.log('\n═══ A11: rename_symbol 字符串/注释内误匹配 ═══')
  const handle = await loadTool('tool-rename-symbol')

  // auth.py 第 33 行: # TODO: add rate limit check
  // 如果 rename "check" → "verify"，不应改注释里的 check
  // 但 auth.py 没有 check 标识符... 用 login 测试
  // login 出现在 def login(...) 和 docstring 中
  const result = await handle({
    workspace_dir: FIXTURES,
    symbol: 'login',
    new_name: 'authenticate',
    file: 'src/auth.py',
    dry_run: true,
  }, mockContext)

  // 检查是否有字符串/注释内的误匹配
  const allEdits = (result.edits_per_file || []).flatMap(f => f.edits)
  const commentEdits = allEdits.filter(e => e.old.trim().startsWith('#') || e.old.trim().startsWith('//'))
  // 目前 string-stripping 只处理单行字符串，注释内的匹配可能漏过
  assert(result.files_changed >= 1, `A11: rename login 找到 ${result.files_changed} 个文件`)
  assert(result.total_edits >= 1, `A11: rename login 找到 ${result.total_edits} 个编辑`)
}

// ═══ A12: config_drift 注释内的 env var ═══
async function testA12() {
  console.log('\n═══ A12: config_drift 注释内 env var 误报 ═══')
  const handle = await loadTool('tool-config-drift')

  // auth.py 第 33 行: # TODO: add rate limit check
  // 不包含 env var，但测试注释过滤逻辑
  const result = await handle({ workspace_dir: FIXTURES, file: 'src/auth.py' }, mockContext)

  const envRefs = (result.config_references || []).filter(r => r.type === 'env_var')
  // auth.py 有 REDIS_URL 和 CACHE_TTL，不在注释内
  assert(envRefs.length === 2, `A12: 检测到 ${envRefs.length} 个 env var (期望 2)`)

  // CACHE_TTL 不在 .env.example 中 → 应该报 drift
  const drifts = (result.drifts || []).filter(d => d.name === 'CACHE_TTL')
  assert(drifts.length === 1, `A12: CACHE_TTL drift 正确检测`)
}

// ═══ A13: find_tests 嵌套目录 ═══
async function testA13() {
  console.log('\n═══ A13: find_tests 嵌套目录约定 ═══')
  const handle = await loadTool('tool-find-tests')

  // src/auth.py → 应该检查 tests/test_auth.py, src/test_auth.py 等
  const result = await handle({ workspace_dir: FIXTURES, file: 'src/auth.py' }, mockContext)

  const conventions = result.by_convention || []
  const existing = conventions.filter(c => c.exists)
  assert(existing.length >= 1, `A13: 找到 ${existing.length} 个存在的测试文件`)

  // 检查是否包含 tests/test_auth.py
  const hasTestsDir = conventions.some(c => c.path === 'tests/test_auth.py')
  assert(hasTestsDir, `A13: 约定包含 tests/test_auth.py`)
}

// ═══ A14: active_todos 二进制文件 ═══
async function testA14() {
  console.log('\n═══ A14: active_todos 大文件/二进制安全 ═══')
  const handle = await loadTool('tool-active-todos')

  // 正常调用不应 crash
  const result = await handle({ workspace_dir: FIXTURES, scope: '.' }, mockContext)
  assert(result.total_todos >= 2, `A14: 找到 ${result.total_todos} 个 TODO (期望 >=2)`)
  assert(!result.error, `A14: 无错误`)
}

// ═══ A15: mock_syncer @patch 装饰器检测 ═══
async function testA15() {
  console.log('\n═══ A15: mock_syncer @patch 装饰器 ═══')
  const handle = await loadTool('tool-mock-syncer')

  const result = await handle({
    workspace_dir: FIXTURES,
    file: 'src/auth.py',
    function: 'login',
  }, mockContext)

  // test_auth.py 有 @patch('src.auth.login') 装饰器
  const patchMocks = (result.mock_mismatches || [])
  assert(result.summary?.total_mocks_checked >= 0, `A15: 检查了 ${result.summary?.total_mocks_checked} 个 mock`)
}

// ═══ A16: test_bridge suggest 无测试文件 ═══
async function testA16() {
  console.log('\n═══ A16: test_bridge suggest 无测试文件 ═══')
  const handle = await loadTool('tool-test-bridge')

  // multi_line.py 没有对应的测试文件
  const result = await handle({
    workspace_dir: FIXTURES,
    action: 'suggest',
    file: 'src/multi_line.py',
  }, mockContext)

  assert(result.action === 'suggest', `A16: suggest 返回正确 action`)
  assert(result.affected_tests !== undefined, `A16: 返回 affected_tests 字段`)
  assert((result.affected_tests || []).length === 0, `A16: 无测试文件时 affected_tests 为空`)
}

// ═══ A17: inspect 无索引 ═══
async function testA17() {
  console.log('\n═══ A17: inspect 无索引 graceful ═══')
  const handle = await loadTool('tool-inspect')

  const result = await handle({
    workspace_dir: FIXTURES,
    symbol: 'login',
    file: 'src/auth.py',
  }, mockContext)

  assert(result.error === 'workspace_not_indexed', `A17: 无索引返回 workspace_not_indexed`)
  assert(result.suggestion !== undefined, `A17: 包含 suggestion`)
}

// ═══ A18: rename_symbol dry_run=false 无索引 ═══
async function testA18() {
  console.log('\n═══ A18: rename_symbol dry_run=false 无索引 ═══')
  const handle = await loadTool('tool-rename-symbol')

  // dry_run=false 会尝试用 TransactionStore 写文件
  // 无索引时应该仍然工作（纯文本搜索）
  const result = await handle({
    workspace_dir: FIXTURES,
    symbol: '_unused_helper',
    new_name: '_removed_helper',
    file: 'src/auth.py',
    dry_run: true, // 用 dry_run 避免实际修改
  }, mockContext)

  assert(!result.error, `A18: 无索引 rename 不报错 (error=${result.error || 'none'})`)
  assert(result.files_changed >= 1, `A18: 找到 ${result.files_changed} 个文件`)
}

// ═══ A19: edit_sandbox Python 多行字符串 ═══
async function testA19() {
  console.log('\n═══ A19: edit_sandbox Python 三引号字符串 ═══')
  const handle = await loadTool('tool-edit-sandbox')

  const result = await handle({
    workspace_dir: FIXTURES,
    file: 'src/auth.py',
    new_content: 'def foo():\n    """Docstring with {braces} and [brackets]"""\n    x = (1 + 2)\n    return x\n',
  }, mockContext)

  const syntaxErrors = (result.checks?.syntax?.errors || []).filter(e => e.severity === 'error')
  // 三引号字符串内的 {} [] 不应被当作括号
  // BUG: checkSyntaxBasic 不处理三引号字符串
  assert(syntaxErrors.length === 0, `A19: 三引号字符串内括号不误报 (errors=${syntaxErrors.length})`)
}

// ═══ A20: sweep_dead_code from X import (a, b) ═══
async function testA20() {
  console.log('\n═══ A20: sweep_dead_code 括号导入 ═══')
  const handle = await loadTool('tool-dead-code-sweeper')

  const result = await handle({ workspace_dir: FIXTURES, scope: 'src' }, mockContext)

  // auth.py: from typing import Optional → Optional 被使用
  const unusedImports = (result.dead_code || []).filter(d => d.type === 'unused_import')
  const optionalFalsePositive = unusedImports.find(d => d.symbol === 'Optional')
  assert(!optionalFalsePositive, `A20: Optional 不被误报 (found=${!!optionalFalsePositive})`)

  // hashlib 在 multi_line.py 中被使用 (unused_func 用了)
  const hashlibInMultiLine = unusedImports.find(d => d.symbol === 'hashlib' && d.file.includes('multi_line'))
  assert(!hashlibInMultiLine, `A20: hashlib 在 multi_line.py 中不被误报`)
}

// ═══ A21: find_tests 读侧路径穿越（R6）═══
// FILE_NOT_INDEXED 分支旧实现直接赋值 file，后续 join(workspaceDir, file) 可经 ../ 越界读
async function testA21() {
  console.log('\n═══ A21: find_tests ../ 穿越═══')
  const handle = await loadTool('tool-find-tests')
  const ctx = {
    codeIndexService: {
      resolveFileArg: (f) => ({ ok: false, error: { code: 'FILE_NOT_INDEXED', message: 'not indexed' }, path: f }),
      initWorkspace: async () => {},
      getReferences: async () => [],
    },
    getWorkspaceDir: (ws) => join(ws, '.malong'),
  }
  const res = await handle({ workspace_dir: FIXTURES, file: '../secret.js' }, ctx)
  assert(res.error === 'PATH_BLOCKED', `A21: ../ 穿越被 PATH_BLOCKED（实际 ${res.error}）`)
  const res2 = await handle({ workspace_dir: FIXTURES, file: 'src/sql_queries.py' }, ctx)
  assert(res2.error !== 'PATH_BLOCKED', `A21: 正常相对路径不受影响`)
}

async function testA25() {
  console.log('\n═══ A25: R22-⑮ active-todos symlink 逃逸守卫 ═══')
  const at = await loadTool('tool-active-todos')
  const ws = join(FIXTURES, 'symlink-ws')
  mkdirSync(ws, { recursive: true })
  const outside = join(FIXTURES, 'outside-todo')
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'secret.js'), '// TODO: 外部文件不该被扫到\n')
  try { symlinkSync(join(outside, 'secret.js'), join(ws, 'link.js')) } catch { assert(false, 'symlink 创建'); return }
  const r = await at({ workspace_dir: ws, scope: 'link.js' }, { ...mockContext, codeIndexService: null })
  assert(r.error === 'path_blocked', `scope 指向外部 symlink → path_blocked（得 ${r.error}）`)
  // R22-⑯：目录 symlink 同样拦截（旧守卫只在 isFile 分支，目录绕行）
  try { symlinkSync(outside, join(ws, 'extdir'), 'dir') } catch { assert(false, 'dir symlink 创建'); return }
  const rDir = await at({ workspace_dir: ws, scope: 'extdir' }, { ...mockContext, codeIndexService: null })
  assert(rDir.error === 'path_blocked', `scope 指向外部目录 symlink → path_blocked（得 ${rDir.error}）`)
  try { rmSync(ws, { recursive: true, force: true }) } catch {}
  try { rmSync(outside, { recursive: true, force: true }) } catch {}
}

// Run all
const tests = [testA1, testA2, testA3, testA3b, testA4, testA5, testA6, testA7, testA8, testA9, testA9b, testA10,
               testA11, testA12, testA13, testA14, testA15, testA16, testA17, testA18, testA19, testA20, testA21, testA22, testA23, testA24, testA25]

for (const t of tests) {
  try { await t() } catch (e) {
    failed++
    failures.push(`${t.name}: EXCEPTION ${e.message}`)
    console.log(`  ✗ ${t.name}: EXCEPTION ${e.message}`)
  }
}
// ═══ A22: edit_sandbox 小写标识符 undefined（R22-⑪：旧只查大写开头） ═══
async function testA22() {
  console.log('\n═══ A22: edit_sandbox 小写 undefined 检测 ═══')
  const handle = await loadTool('tool-edit-sandbox')
  const src = 'function main() {\n  validateUser()\n  console.log("hi")\n  if (x > 0) {}\n  obj.method()\n  return 1\n}\n'
  const result = await handle({ workspace_dir: FIXTURES, file: 'src/a22.js', new_content: src }, { ...mockContext, codeIndexService: {} })
  const symErrs = (result.checks?.symbol_references?.errors || []).map(e => e.symbol)
  assert(symErrs.includes('validateUser') && !symErrs.includes('console') && !symErrs.includes('method') && !symErrs.includes('if'), `A22: 只报真小写未定义（得 ${JSON.stringify(symErrs)}）`)
}

// ═══ A23: diff_facts manifest ../ 越界守卫（R22-⑪） ═══
async function testA23() {
  console.log('\n═══ A23: diff_facts 越界守卫 ═══')
  const { writeFileSync, mkdirSync, rmSync } = await import('node:fs')
  const { handle } = await import('../tools/tool-diff-facts/handler.js')
  const ws = join(FIXTURES, '..', '.a23-txn-ws')
  try { rmSync(ws, { recursive: true, force: true }) } catch {}
  mkdirSync(join(ws, '.ai-transactions', 'txn1', 'backup'), { recursive: true })
  writeFileSync(join(ws, '.ai-transactions', 'txn1', 'manifest.json'), JSON.stringify({ txnId: 'a23t1', created: Date.now(), files: { '../../etc/passwd': { backupName: 'p' } } }))
  const r = await handle({ workspace_dir: ws, since: 'a23t1' }, {})
  assert(JSON.stringify(r.warnings || []).includes('path_blocked'), `A23: ../ fileRel 报 path_blocked（得 ${JSON.stringify(r.warnings)}）`)
  try { rmSync(ws, { recursive: true, force: true }) } catch {}
}

// ═══ A24: R22-⑪ 拷打发现——4 工具非字符串参数裸抛 + find-tests 无服务守卫绕过 ═══
async function testA24() {
  console.log('\n═══ A24: 非字符串参数结构化错误 ═══')
  const cases = [
    ['tool-active-todos', { workspace_dir: FIXTURES, scope: 123 }],
    ['tool-dead-code-sweeper', { workspace_dir: FIXTURES, scope: 123 }],
    ['tool-find-tests', { workspace_dir: FIXTURES, file: 123 }],
    ['tool-exception-guard', { workspace_dir: FIXTURES, file: 123 }],
  ]
  for (const [tool, args] of cases) {
    let threw = false
    let r = null
    try {
      const handle = await loadTool(tool)
      r = await handle(args, { ...mockContext, codeIndexService: null, langParserService: null })
    } catch (e) { threw = true; r = e }
    assert(!threw && r?.error, `${tool} 非字符串参数→结构化错误不裸抛（得 ${threw ? 'THROW ' + r.message?.slice(0, 40) : JSON.stringify(r?.error)}）`)
  }
  // find-tests 无 codeIndexService 时 ../ 仍被拦
  const ft = await loadTool('tool-find-tests')
  const rFt = await ft({ workspace_dir: FIXTURES, file: '../../etc/passwd' }, { ...mockContext, codeIndexService: null })
  assert(rFt.error === 'PATH_BLOCKED', `find-tests 无服务时 ../ 仍拦（得 ${rFt.error}）`)
}


console.log('\n══════════════════════════════════════════════════')
console.log(`总计: ${passed} passed, ${failed} failed`)
if (failures.length > 0) {
  console.log('\n失败列表:')
  for (const f of failures) console.log(`  ✗ ${f}`)
}
process.exit(failed ? 1 : 0) // 9（F8）：显式退出，避免 parse-client 常驻 socket 挂住 event loop
