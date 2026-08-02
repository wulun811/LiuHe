import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const imp = (p) => import(pathToFileURL(p).href)
const FIXTURES = join(__dirname, 'fixtures')
const TOOLS = join(__dirname, '..', 'tools')

let passed = 0, failed = 0, errors = []
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`) }
  else { failed++; errors.push(msg); console.error(`  ✗ ${msg}`) }
}

const mockContext = {
  codeIndexService: null,
  getWorkspaceDir: () => join(tmpdir(), 'malong-test-ws'),
}

async function loadTool(name) {
  return (await imp(join(TOOLS, name, 'handler.js'))).handle
}

// ═══════════════════════════════════════════
console.log('\n═══ T1: active_todos ═══')
{
  const handle = await loadTool('tool-active-todos')
  const r = await handle({ workspace_dir: FIXTURES, scope: '.' }, mockContext)
  assert(r.total_todos >= 2, `T1: found ${r.total_todos} TODOs (expect >=2: TODO + FIXME)`)
  assert(r.todos.some(t => t.type === 'TODO'), 'T1: has TODO type')
  assert(r.todos.some(t => t.type === 'FIXME'), 'T1: has FIXME type')
  assert(r.summary.high + r.summary.medium + r.summary.low === r.total_todos, 'T1: summary counts match')
  assert(r.scanned_files > 0, `T1: scanned ${r.scanned_files} files`)

  const r2 = await handle({ workspace_dir: FIXTURES, scope: '.', current_files: ['src/auth.py'] }, mockContext)
  const highTodos = r2.todos.filter(t => t.priority === 'high')
  assert(highTodos.length > 0, 'T1: current_files boosts priority to high')
}

// ═══════════════════════════════════════════
console.log('\n═══ T2: exception_guard ═══')
{
  const handle = await loadTool('tool-exception-guard')
  const r = await handle({ workspace_dir: FIXTURES, file: 'src/auth.py' }, mockContext)
  assert(r.issues.length >= 2, `T2: found ${r.issues.length} issues (expect >=2: ValueError + Exception)`)
  assert(r.issues.some(i => i.raised === 'ValueError'), 'T2: catches ValueError')
  assert(r.issues.some(i => i.raised === 'Exception'), 'T2: catches bare Exception')
  assert(r.summary.raises_checked >= 2, `T2: checked ${r.summary.raises_checked} raises`)

  const r2 = await handle({ workspace_dir: FIXTURES, file: 'nonexist.py' }, mockContext)
  assert(r2.error === 'file_not_found', 'T2: missing file returns error')
}

// ═══════════════════════════════════════════
console.log('\n═══ T2b: exception_guard Rust panic-family（第 8 轮） ═══')
{
  const handle = await loadTool('tool-exception-guard')
  const RWS = join(tmpdir(), 'opencode', 'eg-rust-ws')
  rmSync(RWS, { recursive: true, force: true })
  mkdirSync(join(RWS, 'src'), { recursive: true })
  mkdirSync(join(RWS, 'tests'), { recursive: true })
  writeFileSync(join(RWS, 'src/lib.rs'), `use std::fs::File;

pub fn load(p: &str) -> String {
    let mut f = File::open(p).unwrap();
    let cfg = read_cfg().expect("cfg");
    if cfg.is_empty() { panic!("empty cfg") }
    cfg
}

fn read_cfg() -> String { String::new() }

fn main() {
    let x = File::open("x").unwrap();
}

#[cfg(test)]
mod tests {
    #[test]
    fn t() { let y = File::open("y").unwrap(); }
}
`)
  writeFileSync(join(RWS, 'tests/it.rs'), `#[test]\nfn it() { let z = std::fs::File::open("z").unwrap(); }\n`)
  const r = await handle({ workspace_dir: RWS, file: 'src/lib.rs' }, mockContext)
  const lines = r.issues.map(i => i.line)
  assert(r.paradigm === 'result', 'T2b: Rust 返回 result 范式')
  assert(lines.includes(4) && lines.includes(5) && lines.includes(6), `T2b: load 内 unwrap/expect/panic 全报告（得 ${JSON.stringify(lines)}）`)
  assert(!lines.includes(13), `T2b: fn main 内 unwrap 跳过（得 ${JSON.stringify(lines)}）`)
  assert(!lines.includes(19), `T2b: #[cfg(test)] mod 内 unwrap 跳过（得 ${JSON.stringify(lines)}）`)
  assert(r.issues.every(i => i.confidence === 'heuristic' && i.note), 'T2b: 全带 heuristic caveat（指向 clippy）')
  const rt = await handle({ workspace_dir: RWS, file: 'tests/it.rs' }, mockContext)
  assert(rt.summary.skipped === 'test file' && rt.issues.length === 0, 'T2b: tests/ 文件整体跳过')
}

// ═══════════════════════════════════════════
console.log('\n═══ T3: config_drift ═══')
{
  const handle = await loadTool('tool-config-drift')
  const r = await handle({ workspace_dir: FIXTURES, file: 'src/auth.py' }, mockContext)
  assert(r.config_references.length >= 2, `T3: found ${r.config_references.length} config refs`)
  assert(r.config_references.some(c => c.name === 'REDIS_URL'), 'T3: detects REDIS_URL')
  assert(r.config_references.some(c => c.name === 'CACHE_TTL'), 'T3: detects CACHE_TTL')
  const redisDrift = r.drifts.find(d => d.name === 'REDIS_URL')
  assert(!redisDrift, 'T3: REDIS_URL in .env.example → no drift')
  const cacheDrift = r.drifts.find(d => d.name === 'CACHE_TTL')
  assert(!!cacheDrift, 'T3: CACHE_TTL not in .env.example → drift detected')

  const r2 = await handle({ workspace_dir: FIXTURES, file: 'nonexist.py' }, mockContext)
  assert(r2.error === 'file_not_found', 'T3: missing file returns error')
}

// ═══════════════════════════════════════════
console.log('\n═══ T4: find_tests ═══')
{
  const handle = await loadTool('tool-find-tests')
  const r = await handle({ workspace_dir: FIXTURES, file: 'src/auth.py' }, mockContext)
  assert(r.by_convention.length > 0, 'T4: has convention candidates')
  const existing = r.by_convention.filter(c => c.exists)
  assert(existing.length > 0, `T4: found ${existing.length} existing test file(s)`)
  assert(existing.some(c => c.path.includes('test_auth')), 'T4: finds test_auth.py')
  assert(r.coverage_hint.length > 0, 'T4: has coverage hint')

  const r2 = await handle({ workspace_dir: FIXTURES, file: 'src/auth.py', symbol: 'login' }, mockContext)
  assert(r2.test_symbols && r2.test_symbols.length > 0, `T4: found ${r2.test_symbols?.length} test symbols for login`)
}

// ═══════════════════════════════════════════
console.log('\n═══ T5: sandbox_validate ═══')
{
  const handle = await loadTool('tool-edit-sandbox')
  const goodContent = 'def foo():\n    return 42\n'
  const r1 = await handle({ workspace_dir: FIXTURES, file: 'src/auth.py', new_content: goodContent }, mockContext)
  assert(r1.valid === true, 'T5: valid content passes')
  assert(r1.checks.syntax.status === 'pass', 'T5: syntax check passes')

  const badContent = 'def foo(:\n    return 42\n'
  const r2 = await handle({ workspace_dir: FIXTURES, file: 'src/auth.py', new_content: badContent }, mockContext)
  assert(r2.checks.syntax.status === 'fail', 'T5: unclosed paren detected')

  const mixedIndent = 'def foo():\n  return 42\n    x = 1\n'
  const r3 = await handle({ workspace_dir: FIXTURES, file: 'src/auth.py', new_content: mixedIndent }, mockContext)
  assert(r3.checks.indentation.status !== 'pass' || r3.checks.indentation.errors?.length > 0, 'T5: inconsistent indent detected')
}

// ═══════════════════════════════════════════
console.log('\n═══ T6: mock_sync ═══')
{
  const handle = await loadTool('tool-mock-syncer')
  const r = await handle({ workspace_dir: FIXTURES, file: 'src/auth.py', function: 'login' }, mockContext)
  assert(r.target.function === 'login', 'T6: target is login')
  assert(r.target.signature.includes('credentials'), 'T6: signature has credentials param')
  assert(r.summary.total_mocks_checked >= 1, `T6: checked ${r.summary.total_mocks_checked} mocks`)
  const retMismatch = r.mock_mismatches.find(m => m.mock_type === 'return_value')
  assert(!!retMismatch, 'T6: detects return_value mismatch (string vs dict)')

  const r2 = await handle({ workspace_dir: FIXTURES, file: 'src/auth.py', function: 'nonexist' }, mockContext)
  assert(r2.error === 'symbol_not_found', 'T6: missing function returns error')
}

// ═══════════════════════════════════════════
console.log('\n═══ T7: sweep_dead_code ═══')
{
  const handle = await loadTool('tool-dead-code-sweeper')
  const r = await handle({ workspace_dir: FIXTURES, scope: '.' }, mockContext)
  assert(r.scanned_files > 0, `T7: scanned ${r.scanned_files} files`)
  const unusedImports = r.dead_code.filter(d => d.type === 'unused_import')
  assert(unusedImports.some(d => d.symbol === 'hashlib'), 'T7: detects unused import hashlib')
  assert(r.summary.unused_imports >= 1, `T7: ${r.summary.unused_imports} unused imports`)
}

// ═══════════════════════════════════════════
console.log('\n═══ T7b: sweep_dead_code Rust use（第 8 轮） ═══')
{
  const handle = await loadTool('tool-dead-code-sweeper')
  const RWS = join(tmpdir(), 'opencode', 'dc-rust-ws')
  rmSync(RWS, { recursive: true, force: true })
  mkdirSync(join(RWS, 'src'), { recursive: true })
  writeFileSync(join(RWS, 'src/lib.rs'), `use std::collections::HashMap;
use serde::Serialize;
pub use crate::api::PublicThing;
use std::io::Read;
use std::fmt::Debug as FmtDebug;

fn build() -> HashMap<String, u32> {
    let mut m = HashMap::new();
    let mut f = std::fs::File::open("x").unwrap();
    let mut buf = String::new();
    f.read_to_string(&mut buf).unwrap();
    m
}
`)
  const r = await handle({ workspace_dir: RWS, scope: 'src/lib.rs' }, mockContext)
  const ui = r.dead_code.filter(d => d.type === 'unused_import')
  const syms = ui.map(d => d.symbol)
  assert(syms.includes('Serialize'), `T7b: 未用 use Serialize 被报告（得 ${JSON.stringify(syms)}）`)
  assert(syms.includes('FmtDebug'), `T7b: use as 别名 FmtDebug 未用被报告（得 ${JSON.stringify(syms)}）`)
  assert(!syms.includes('HashMap'), `T7b: 在用 HashMap 不误报（得 ${JSON.stringify(syms)}）`)
  assert(!syms.includes('PublicThing'), `T7b: pub use re-export 不报（得 ${JSON.stringify(syms)}）`)
  assert(ui.every(d => d.confidence === 'heuristic' && d.note), 'T7b: Rust 未用导入带 heuristic caveat（trait 隐式使用）')
}

// ═══════════════════════════════════════════
console.log('\n═══ T8: test_bridge parsers ═══')
{
  const { parsePytest, parseJest, parseGoTest } = await imp(join(TOOLS, 'tool-test-bridge', 'parsers.js'))

  const pytestOut = `tests/test_auth.py::test_login_success PASSED
tests/test_auth.py::test_login_mfa FAILED
===== FAILURES =====
_____ test_login_mfa _____
    assert result["status"] == 200
E   AssertionError: expected 200, got 401
tests/test_auth.py:12: AssertionError
===== short test summary info =====
FAILED tests/test_auth.py::test_login_mfa
===== 1 passed, 1 failed in 0.46s =====`

  const pr = parsePytest(pytestOut)
  assert(pr.results.length === 2, `T8: pytest parsed ${pr.results.length} results`)
  assert(pr.results[0].status === 'passed', 'T8: first test passed')
  assert(pr.results[1].status === 'failed', 'T8: second test failed')
  assert(pr.failures.length === 1, `T8: ${pr.failures.length} failure extracted`)
  assert(pr.failures[0].error_type === 'AssertionError', `T8: error type is ${pr.failures[0].error_type}`)
  assert(pr.summary.passed === 1, 'T8: summary 1 passed')
  assert(pr.summary.failed === 1, 'T8: summary 1 failed')

  const jestOut = JSON.stringify({
    numTotalTests: 2, numPassedTests: 1, numFailedTests: 1,
    testResults: [{ testFilePath: '/tests/auth.test.js', testResults: [
      { fullName: 'login works', status: 'passed', duration: 50 },
      { fullName: 'mfa works', status: 'failed', duration: 80, failureMessages: ['Error: expected 200\n    at Object.<anonymous>'] },
    ]}]
  })
  const jr = parseJest(jestOut)
  assert(jr.results.length === 2, 'T8: jest parsed 2 results')
  assert(jr.failures.length === 1, 'T8: jest 1 failure')
  assert(jr.summary.passed === 1, 'T8: jest summary 1 passed')

  const goOut = `=== RUN   TestLogin
--- PASS: TestLogin (0.00s)
=== RUN   TestMFA
    auth_test.go:89: expected 200, got 401
--- FAIL: TestMFA (0.01s)
FAIL`
  const gr = parseGoTest(goOut)
  assert(gr.results.length === 2, 'T8: go parsed 2 results')
  assert(gr.failures.length === 1, 'T8: go 1 failure')
  assert(gr.failures[0].line === 89, `T8: go failure at line ${gr.failures[0].line}`)
}

// ═══════════════════════════════════════════
console.log('\n═══ T9: test_bridge handler ═══')
{
  const handle = await loadTool('tool-test-bridge')

  const r1 = await handle({ action: 'discover', workspace_dir: FIXTURES, file: 'src/auth.py' }, mockContext)
  assert(r1.action === 'discover', 'T9: discover action works')
  assert(r1.framework === 'pytest', `T9: detected framework ${r1.framework}`)
  assert(r1.tests.length >= 4, `T9: found ${r1.tests.length} tests`)
  assert(r1.tests.some(t => t.name === 'test_login_success'), 'T9: finds test_login_success')

  const r2 = await handle({ action: 'suggest', workspace_dir: FIXTURES, file: 'src/auth.py' }, mockContext)
  assert(r2.action === 'suggest', 'T9: suggest action works')
  assert(r2.affected_tests.length > 0, `T9: ${r2.affected_tests.length} affected tests`)

  const r3 = await handle({ action: 'invalid', workspace_dir: FIXTURES }, mockContext)
  assert(r3.error === 'invalid_action', 'T9: invalid action returns error')

  const r4 = await handle({ action: 'run', workspace_dir: FIXTURES, scope: '; rm -rf /' }, mockContext)
  assert(r4.error === 'invalid_input', 'T9: command injection blocked')

  const r5 = await handle({ workspace_dir: FIXTURES }, mockContext)
  assert(r5.error === 'invalid_action', 'T9: missing action returns error')
}

// ═══════════════════════════════════════════
console.log('\n═══ T10: inspect (no index) ═══')
{
  const handle = await loadTool('tool-inspect')
  const r = await handle({ workspace_dir: FIXTURES, symbol: 'login', file: 'src/auth.py' }, mockContext)
  assert(r.error === 'workspace_not_indexed' || r.symbol === 'login', 'T10: inspect handles no-index gracefully')
}

// ═══════════════════════════════════════════
console.log('\n═══ T11: rename_symbol (dry_run) ═══')
{
  const handle = await loadTool('tool-rename-symbol')
  const r = await handle({ workspace_dir: FIXTURES, symbol: 'login', new_name: 'authenticate', file: 'src/auth.py', dry_run: true }, mockContext)
  assert(r.files_changed >= 1, `T11: ${r.files_changed} files would change`)
  assert(r.total_edits >= 1, `T11: ${r.total_edits} edits`)
  assert(r.dry_run === true, 'T11: dry_run mode')

  const r2 = await handle({ workspace_dir: FIXTURES, symbol: 'login', new_name: 'login', file: 'src/auth.py' }, mockContext)
  assert(r2.error === 'invalid_input', 'T11: same name rejected')
}

// ═══════════════════════════════════════════
console.log('\n═══ T12: edit_sandbox edge cases ═══')
{
  const handle = await loadTool('tool-edit-sandbox')
  const r = await handle({ workspace_dir: FIXTURES, file: 'src/auth.py' }, mockContext)
  assert(r.error === 'missing_parameter', 'T12: missing new_content returns error')
}

// ═══════════════════════════════════════════
console.log('\n═══ T13: next_step assertions ═══')
{
  const handle = await loadTool('tool-active-todos')
  const r1 = await handle({ workspace_dir: FIXTURES, scope: '.' }, mockContext)
  assert(typeof r1.next_step === 'string' && r1.next_step.length > 0, 'T13: active_todos has next_step')

  const handle2 = await loadTool('tool-config-drift')
  const r2 = await handle2({ workspace_dir: FIXTURES }, mockContext)
  assert(typeof r2.next_step === 'string' && r2.next_step.length > 0, 'T13: config_drift has next_step')

  const handle3 = await loadTool('tool-exception-guard')
  const r3 = await handle3({ workspace_dir: FIXTURES, file: 'src/auth.py' }, mockContext)
  assert(typeof r3.next_step === 'string' && r3.next_step.length > 0, 'T13: exception_guard has next_step')

  const handle4 = await loadTool('tool-dead-code-sweeper')
  const r4 = await handle4({ workspace_dir: FIXTURES }, mockContext)
  assert(typeof r4.next_step === 'string' && r4.next_step.length > 0, 'T13: sweep_dead_code has next_step')

  const handle5 = await loadTool('tool-edit-sandbox')
  const r5 = await handle5({ workspace_dir: FIXTURES, file: 'src/auth.py', new_content: 'x = 1\n' }, mockContext)
  assert(typeof r5.next_step === 'string' && r5.next_step.length > 0, 'T13: sandbox_validate has next_step')

  const handle6 = await loadTool('tool-mock-syncer')
  const r6 = await handle6({ workspace_dir: FIXTURES, file: 'src/auth.py', function: 'login' }, mockContext)
  assert(typeof r6.next_step === 'string' && r6.next_step.length > 0, 'T13: mock_sync has next_step')

  const handle7 = await loadTool('tool-find-tests')
  const r7 = await handle7({ workspace_dir: FIXTURES, file: 'src/auth.py' }, mockContext)
  assert(typeof r7.next_step === 'string' && r7.next_step.length > 0, 'T13: find_tests has next_step')

  const handle8 = await loadTool('tool-rename-symbol')
  const r8 = await handle8({ workspace_dir: FIXTURES, symbol: 'login', new_name: 'authenticate', file: 'src/auth.py', dry_run: true }, mockContext)
  assert(typeof r8.next_step === 'string' && r8.next_step.length > 0, 'T13: rename_symbol has next_step')

  const handle9 = await loadTool('tool-test-bridge')
  const r9 = await handle9({ workspace_dir: FIXTURES, action: 'discover', file: 'src/auth.py' }, mockContext)
  assert(typeof r9.next_step === 'string' && r9.next_step.length > 0, 'T13: test_bridge has next_step')

  const handle10 = await loadTool('tool-inspect')
  const r10 = await handle10({ workspace_dir: FIXTURES, symbol: 'login', file: 'src/auth.py' }, mockContext)
  // inspect may return error if no index; only check next_step if success
  if (!r10.error) {
    assert(typeof r10.next_step === 'string' && r10.next_step.length > 0, 'T13: inspect has next_step')
  } else {
    assert(true, 'T13: inspect returns error (no index) - skipped')
  }

  const handle11 = await loadTool('tool-edit-collision-guard')
  const r11 = await handle11({ workspace_dir: FIXTURES, file: 'src/auth.py', action: 'record_read' }, mockContext)
  assert(typeof r11.next_step === 'string' && r11.next_step.length > 0, 'T13: collision_guard(record_read) has next_step')
  const r11b = await handle11({ workspace_dir: FIXTURES, file: 'src/auth.py', action: 'check' }, mockContext)
  assert(typeof r11b.next_step === 'string' && r11b.next_step.length > 0, 'T13: collision_guard(check) has next_step')
}

// ═══════════════════════════════════════════
console.log(`\n${'═'.repeat(50)}`)
console.log(`总计: ${passed} passed, ${failed} failed`)
if (errors.length > 0) {
  console.log('\n失败列表:')
  errors.forEach(e => console.log(`  ✗ ${e}`))
}
process.exit(failed > 0 ? 1 : 0)
