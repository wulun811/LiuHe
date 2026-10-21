// tests/lib/verify-classify.js — R2/F2（0.5.14 Windows 复核）：验证类用例的统一分类器
// 现场：G3 统计器只给 typecheck 单独设 unavailableIf，lint 仍用「有返回且无 error 就 PASS」；
// R2 清掉环境缺件的 error 字段后，verify_pipeline lint（status=not_run / executed=0）被计成 PASS
// （官方 90/1/3/0 里混入一项假绿；专家 g3-lint-false-pass.json 为证）。
// 合同（专家 §四 F2）：验证类用例先读 verification.status/complete/executed 与阶段 ran/skipped/passed，
// 再决定 NOT_RUN / PASS / FAIL；「动作成功」与「检查通过」严格分开；不得各写一套「无 error = 通过」。
// 分类只有三值（G3 口径）：PASS / NOT_RUN / FAIL——partial 归 NOT_RUN（不伪装全通过），真实失败优先。

// 单阶段事实 → passed | failed | skipped（不猜测：只有 ran/passed 事实才算执行过）
export function stageState(r) {
  if (!r || typeof r !== 'object') return 'skipped'
  if (r.ran === true) {
    if (r.passed === true) return 'passed'
    if (r.passed === false) return 'failed'
    return 'skipped'
  }
  if (r.passed === true) return 'passed'
  if (r.passed === false) return 'failed'
  return 'skipped'
}

export function stageReason(r) {
  if (!r || typeof r !== 'object') return 'skipped'
  return r.unavailable || (r.no_tests ? 'no_tests' : (r.skipped ? 'skipped' : 'no_verdict'))
}

export function stageStatesOf(result) {
  const results = result && typeof result === 'object' ? result.results : null
  if (!results || typeof results !== 'object' || Array.isArray(results)) return []
  return Object.entries(results).map(([stage, r]) => ({ stage, state: stageState(r), reason: stageReason(r) }))
}

const NOT_RUN = (why) => ({ classification: 'NOT_RUN', reason: why })
const FAIL = (why) => ({ classification: 'FAIL', reason: why })
const PASS = () => ({ classification: 'PASS', reason: '' })

// verify_pipeline：verification 汇总（pass/partial/not_run/fail 四值）+ 阶段事实双读
// 优先级：真实失败 > 未执行（executed=0 / not_run / 部分未执行）> 真通过
// 失败优先是有意的：缺件文本与真实诊断共存时，真实失败不得被吞（与 N04c 同口径）。
export function classifyVerifyPipeline(result) {
  if (!result || typeof result !== 'object') return FAIL('no result')
  const states = stageStatesOf(result)
  const failed = states.filter(s => s.state === 'failed').map(s => s.stage)
  const passed = states.filter(s => s.state === 'passed').map(s => s.stage)
  const skipped = states.filter(s => s.state === 'skipped')
  const unexecuted = skipped.map(s => s.stage + ':' + s.reason)
  const v = (result.verification && typeof result.verification === 'object') ? result.verification : null
  const vStatus = v && typeof v.status === 'string' ? v.status : null
  // 缺失/null/'' 一律回退到阶段事实（旧形状无 verification 块时不得把 null 当 0 执行数）
  const num = (x, d) => ((x === null || x === undefined || x === '' || !Number.isFinite(Number(x))) ? d : Number(x))
  const executed = num(v && v.executed, passed.length + failed.length)
  const vFailed = num(v && v.failed, failed.length)
  const vSkipped = num(v && v.skipped, skipped.length)
  if (vFailed > 0 || vStatus === 'fail' || failed.length > 0) {
    return FAIL('verification failed: ' + (failed.join(', ') || vStatus || (v && v.reason) || 'fail'))
  }
  if (vStatus === 'not_run' || executed === 0) {
    return NOT_RUN('not executed: ' + ((v && v.reason) || unexecuted.join(', ') || 'nothing executed'))
  }
  if (vStatus === 'partial' || vSkipped > 0 || skipped.length > 0) {
    return NOT_RUN('partial (not fully executed): ' + ((v && v.reason) || unexecuted.join(', ')))
  }
  if (v && v.complete === false) return NOT_RUN('verification not complete')
  if (passed.length === 0) return NOT_RUN('no stage reported a real pass')
  return PASS()
}

// tsc_check：status=pass/fail；no_tsconfig / tsc_not_found 属环境未执行（不计 PASS 也不计 FAIL）
export function classifyTscCheck(result) {
  if (!result || typeof result !== 'object') return FAIL('no result')
  if (result.error === 'no_tsconfig' || result.error === 'tsc_not_found') return NOT_RUN('not executed: ' + result.error)
  if (result.status === 'pass') return PASS()
  if (result.status === 'fail') return FAIL('tsc reported ' + (Array.isArray(result.errors) ? result.errors.length : '?') + ' error(s)')
  return NOT_RUN('no verdict')
}

// test_bridge(action=run)：exit_code + 解析到的用例计数；0 用例（no_totals_parsed）= 没真跑
export function classifyTestBridge(result) {
  if (!result || typeof result !== 'object') return FAIL('no result')
  const total = Number(result.summary && result.summary.total) || 0
  const failedCount = Number(result.summary && result.summary.failed) || (Array.isArray(result.failures) ? result.failures.length : 0)
  const exit = Number(result.exit_code)
  const exitKnown = Number.isFinite(exit)
  if (total === 0) {
    if (exitKnown && exit !== 0) {
      return NOT_RUN('not executed: command produced no test results (exit ' + exit + ')' + (result.run_error ? ' — ' + String(result.run_error).slice(0, 120) : ''))
    }
    return NOT_RUN('not executed: no test totals parsed (plain script or command is not a test runner)')
  }
  if (failedCount > 0) return FAIL('test failures: ' + failedCount + '/' + total)
  if (exitKnown && exit !== 0) return FAIL('non-zero exit (' + exit + ') with ' + total + ' parsed test(s)')
  return PASS()
}
