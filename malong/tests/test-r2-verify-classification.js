// test-r2-verify-classification.js — F2（0.5.14 Windows 复核）/ P2：验证类统计统一分类（不把未执行计成 PASS）
// 现场：官方 G3 把 `verify_pipeline_lint` 记为 PASS，而产品实际输出
//   status=not_run; verification.executed=0; passed=0; skipped=1; reason=lint_not_found
// ——统计器只给 typecheck 设了 unavailableIf，lint 仍用「有返回且无 error 就 PASS」。
// 本测试锁定 7 类：①全跳过 ②零目标 ③部分通过+部分未执行 ④全部真通过 ⑤真实失败 ⑥缺命令 fallback 成功 ⑦缺命令且 fallback 真失败；
// 并覆盖「失败优先于缺件」、无 verification 块的阶段回退、tsc_check / test_bridge 同类假绿。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  FAIL: ' + msg) } }
const cls = await import(pathToFileURL(join(__dirname, 'lib', 'verify-classify.js')).href)

const lintMissingStage = { ran: false, passed: null, skipped: true, unavailable: 'lint_not_found', errorCount: 0 }
const vNotRun = (reason, skipped) => ({ status: 'not_run', executed: 0, passed: 0, failed: 0, skipped: skipped == null ? 1 : skipped, complete: false, reason })

// ── ① 全跳过（typecheck 环境缺件）→ NOT_RUN ──
{
  const r = { status: 'not_run', verification: vNotRun('nothing executed: typecheck:tsc_not_found'), results: { typecheck: { ran: false, passed: null, skipped: true, unavailable: 'tsc_not_found' } } }
  const c = cls.classifyVerifyPipeline(r)
  assert(c.classification === 'NOT_RUN', '① 全跳过 → NOT_RUN（得 ' + JSON.stringify(c) + '）')
  assert(/not executed/i.test(c.reason), '① reason 说明未执行（得 ' + c.reason + '）')
}

// ── ② 零目标（syntax checked=0）→ NOT_RUN ──
{
  const r = { status: 'not_run', verification: vNotRun('nothing executed: syntax:no_files'), results: { syntax: { ran: false, passed: null, skipped: true, checked: 0, unavailable: 'no_files' } } }
  assert(cls.classifyVerifyPipeline(r).classification === 'NOT_RUN', '② 零目标语法检查 → NOT_RUN')
}

// ── ③ 部分通过 + 部分未执行 → NOT_RUN（不伪装全通过），并给出未执行项 ──
{
  const r = {
    status: 'partial',
    verification: { status: 'partial', executed: 1, passed: 1, failed: 0, skipped: 1, complete: false, reason: 'partial: passed test; not executed lint:lint_not_found' },
    results: { test: { ran: true, passed: true }, lint: lintMissingStage },
  }
  const c = cls.classifyVerifyPipeline(r)
  assert(c.classification === 'NOT_RUN', '③ 部分执行 → NOT_RUN（得 ' + JSON.stringify(c) + '）')
  assert(/not executed|partial/i.test(c.reason) && /lint/.test(c.reason), '③ reason 点出未执行阶段（得 ' + c.reason + '）')
}

// ── ④ 全部真通过 → PASS ──
{
  const r = { status: 'pass', verification: { status: 'pass', executed: 2, passed: 2, failed: 0, skipped: 0, complete: true }, results: { test: { ran: true, passed: true }, lint: { ran: true, passed: true } } }
  assert(cls.classifyVerifyPipeline(r).classification === 'PASS', '④ 真跑真过 → PASS')
}

// ── ⑤ 真实失败 → FAIL ──
{
  const r = { status: 'fail', verification: { status: 'fail', executed: 1, passed: 0, failed: 1, skipped: 0, complete: false, reason: 'stage(s) failed: test' }, results: { test: { ran: true, passed: false } } }
  assert(cls.classifyVerifyPipeline(r).classification === 'FAIL', '⑤ 真实失败 → FAIL')
}

// ── ⑥ 缺命令 fallback 成功（lint 缺件 + test 真过）→ NOT_RUN（不因部分通过就 PASS）──
{
  const r = {
    status: 'partial',
    verification: { status: 'partial', executed: 1, passed: 1, failed: 0, skipped: 1, complete: false, reason: 'partial: passed test; not executed lint:lint_not_found' },
    results: { lint: lintMissingStage, test: { ran: true, passed: true } },
  }
  assert(cls.classifyVerifyPipeline(r).classification === 'NOT_RUN', '⑥ 缺命令 fallback 成功 → NOT_RUN（不伪装全通过）')
}

// ── ⑦ 缺命令且 fallback 真失败 → FAIL（真实失败不得被缺件吞）──
{
  const r = {
    status: 'fail',
    verification: { status: 'fail', executed: 2, passed: 1, failed: 1, skipped: 0, complete: false, reason: 'stage(s) failed: test' },
    results: { lint: lintMissingStage, test: { ran: true, passed: false } },
  }
  const c = cls.classifyVerifyPipeline(r)
  assert(c.classification === 'FAIL', '⑦ 缺命令 + fallback 真失败 → FAIL（得 ' + JSON.stringify(c) + '）')
  assert(/test/.test(c.reason), '⑦ reason 点名失败阶段（得 ' + c.reason + '）')
}

// ── ⑧ F2 官方个例原样：专家 g3-lint-false-pass.json 的 result_excerpt 形状 → NOT_RUN ──
{
  const official = {
    status: 'not_run',
    verification: { status: 'not_run', executed: 0, passed: 0, failed: 0, skipped: 1, complete: false, reason: 'nothing executed: lint:lint_not_found' },
    results: { lint: lintMissingStage },
  }
  const c = cls.classifyVerifyPipeline(official)
  assert(c.classification !== 'PASS', '⑧ 官方 lint 缺件个例不得再计 PASS（得 ' + c.classification + '）')
  assert(c.classification === 'NOT_RUN', '⑧ 应为 NOT_RUN（得 ' + c.classification + '）')
  assert(/lint_not_found/.test(c.reason), '⑧ reason 保留 lint_not_found 归因（得 ' + c.reason + '）')
}

// ── ⑨ 无 verification 块（旧形状）：退回阶段事实，不靠「无 error = 通过」──
{
  assert(cls.classifyVerifyPipeline({ results: { test: { ran: true, passed: true } } }).classification === 'PASS', '⑨a 阶段事实真过 → PASS')
  assert(cls.classifyVerifyPipeline({ results: { test: { ran: true, passed: false } } }).classification === 'FAIL', '⑨b 阶段事实真失败 → FAIL')
  assert(cls.classifyVerifyPipeline({ results: { test: { ran: false, skipped: true } } }).classification === 'NOT_RUN', '⑨c 阶段未执行 → NOT_RUN')
  assert(cls.classifyVerifyPipeline({}).classification === 'NOT_RUN', '⑨d 无阶段事实 → NOT_RUN')
}

// ── ⑩ 阶段状态纯函数边界 ──
{
  assert(cls.stageState({ ran: true, passed: null }) === 'skipped', '⑩a ran=true 但无判定 → skipped')
  assert(cls.stageState({}) === 'skipped', '⑩b 无事实 → skipped')
  assert(cls.stageState({ ran: false, passed: true }) === 'passed', '⑩c 事实报 passed → passed')
  assert(cls.stageState(null) === 'skipped', '⑩d null → skipped')
  assert(cls.stageReason({ unavailable: 'lint_not_found' }) === 'lint_not_found', '⑩e 归因取 unavailable')
  assert(cls.stageReason({ no_tests: true }) === 'no_tests', '⑩f 归因取 no_tests')
}

// ── ⑪ tsc_check 同类假绿 ──
{
  assert(cls.classifyTscCheck({ status: 'pass', exitCode: 0 }).classification === 'PASS', '⑪a tsc pass → PASS')
  assert(cls.classifyTscCheck({ status: 'fail', errors: [{}, {}] }).classification === 'FAIL', '⑪b tsc fail → FAIL')
  assert(cls.classifyTscCheck({ error: 'no_tsconfig' }).classification === 'NOT_RUN', '⑪c 无 tsconfig → NOT_RUN（不计 PASS）')
  assert(cls.classifyTscCheck({ error: 'tsc_not_found' }).classification === 'NOT_RUN', '⑪d 无 tsc → NOT_RUN')
}

// ── ⑫ test_bridge run：0 用例 / 真失败 / 真通过 ──
{
  assert(cls.classifyTestBridge({ exit_code: 0, no_totals_parsed: true, summary: { total: 0 } }).classification === 'NOT_RUN', '⑫a exit 0 但无用例计数 → NOT_RUN')
  assert(cls.classifyTestBridge({ exit_code: 1, summary: { total: 0 }, run_error: 'npx not found' }).classification === 'NOT_RUN', '⑫b 命令未跑起 → NOT_RUN')
  assert(cls.classifyTestBridge({ exit_code: 1, summary: { total: 3, passed: 2, failed: 1 }, failures: [{}] }).classification === 'FAIL', '⑫c 有失败 → FAIL')
  assert(cls.classifyTestBridge({ exit_code: 0, summary: { total: 3, passed: 3, failed: 0 } }).classification === 'PASS', '⑫d 全过 → PASS')
}

console.log('== test-r2-verify-classification: ' + pass + ' passed, ' + fail + ' failed ==')
process.exit(fail > 0 ? 1 : 0)
