const ANSI_RE = /\x1b\[[0-9;]*m/g

function stripAnsi(s) {
  return s.replace(ANSI_RE, '')
}

export function parsePytest(output) {
  const raw = stripAnsi(output)
  const lines = raw.split('\n')
  const results = []
  const failures = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const m = /^(.+?)::(.+?)\s+(PASSED|FAILED|ERROR|SKIPPED|XFAIL|XPASS)/.exec(line)
    if (m) {
      const status = m[3].toLowerCase()
      const entry = { file: m[1].trim(), test: m[2].trim(), status: status === 'xfail' ? 'skipped' : status === 'xpass' ? 'passed' : status }
      results.push(entry)
      if (status === 'failed' || status === 'error') {
        const tb = extractPytestTraceback(lines, i)
        failures.push({ ...entry, ...tb })
      }
    }
  }

  if (results.length === 0) {
    const shortFailRe = /^FAILED\s+(.+?)::(.+?)(?:\s+-\s+(.+))?$/gm
    let fm
    while ((fm = shortFailRe.exec(raw)) !== null) {
      const entry = { file: fm[1].trim(), test: fm[2].trim(), status: 'failed' }
      results.push(entry)
      failures.push({ ...entry, error: fm[3] || '', error_type: extractPytestErrorType(fm[3] || ''), file: fm[1].trim(), line: 0, traceback: '' })
    }

    const dotLine = raw.match(/^([.FsxXE]+)\s*$/m)
    if (dotLine && results.length === 0) {
      const dots = dotLine[1]
      const summary = parsePytestSummary(raw)
      return { results: [], failures, summary, raw_hint: raw.slice(0, 500) }
    }
  }

  return { results, failures, summary: parsePytestSummary(raw) }
}

function extractPytestErrorType(msg) {
  const m = /(\w+(?:\.\w+)*(?:Error|Exception))/.exec(msg || '')
  return m ? m[1] : 'AssertionError'
}

function extractPytestTraceback(lines, startIdx) {
  const tbLines = []
  let errorType = '', error = '', file = '', line = 0

  for (let i = startIdx + 1; i < Math.min(startIdx + 40, lines.length); i++) {
    const l = lines[i]
    // 7（T2）：旧只认 (PASSED|FAILED|ERROR|=+ ) 开头行——verbose 里下一个测试头是
    // `path::test FAILED`（路径开头），扫过它后其 E/帧行会覆盖前一个失败的归因
    if (i > startIdx + 1 && (/^(PASSED|FAILED|ERROR|=+ )/.test(l) || /^\S+::[^\s]+?\s+(PASSED|FAILED|ERROR)\s*$/.test(l))) break
    tbLines.push(l)

    const em = /^E\s+(\w+(?:\.\w+)*):\s*(.+)/.exec(l)
    if (em) { errorType = em[1]; error = em[2].trim() }

    const fm = /^\s*(.+?):(\d+):/.exec(l)
    if (fm && !fm[1].startsWith('E ')) { file = fm[1].trim(); line = parseInt(fm[2]) }
  }

  return { error_type: errorType, error, file, line, traceback: tbLines.slice(0, 15).join('\n') }
}

function parsePytestSummary(output) {
  const summary = { total: 0, passed: 0, failed: 0, error: 0, skipped: 0 }
  // 逐行扫描带计数的 ==== 行：开头 `test session starts` 也是 ==== 行，且 stderr（如
  // pytest-asyncio warnings）可能追加在尾部——首行匹配/尾锚都会选错或落空
  for (const line of output.split('\n')) {
    const m = /^=+\s*(.+?)\s*(?:in\s+[\d.]+s)?\s*=+\s*$/.exec(line)
    if (m && /\d+\s+(passed|failed|error|skipped)/.test(m[1])) {
      const parts = m[1]
      const passed = parts.match(/(\d+) passed/)
      const failed = parts.match(/(\d+) failed/)
      const error = parts.match(/(\d+) error/)
      const skipped = parts.match(/(\d+) skipped/)
      if (passed) summary.passed = parseInt(passed[1])
      if (failed) summary.failed = parseInt(failed[1])
      if (error) summary.error = parseInt(error[1])
      if (skipped) summary.skipped = parseInt(skipped[1])
      summary.total = summary.passed + summary.failed + summary.error + summary.skipped
      break
    }
  }
  return summary
}

export function parseJest(output) {
  const raw = stripAnsi(output)
  try {
    const jsonStart = raw.indexOf('{')
    if (jsonStart === -1) return { results: [], failures: [], summary: { total: 0, passed: 0, failed: 0 }, raw_hint: raw.slice(0, 500) }
    const data = JSON.parse(raw.slice(jsonStart))

    const results = []
    const failures = []

    for (const suite of data.testResults || []) {
      const file = suite.testFilePath || suite.name || ''
      for (const t of suite.testResults || suite.assertionResults || []) {
        const entry = {
          file: file.replace(/.*\//, ''),
          test: t.fullName || t.title || t.name || 'unknown',
          status: (t.status || 'unknown').toLowerCase(),
          duration_ms: t.duration || 0,
        }
        results.push(entry)
        if (entry.status === 'failed') {
          const msgs = t.failureMessages || t.failureMessage || []
          const msg = Array.isArray(msgs) ? msgs.join('\n') : msgs
          failures.push({
            ...entry,
            error_type: extractJestErrorType(msg),
            error: extractJestError(msg),
            traceback: stripAnsi(msg).slice(0, 1000),
          })
        }
      }
    }

    return {
      results,
      failures,
      summary: {
        total: data.numTotalTests || results.length,
        passed: data.numPassedTests || results.filter(r => r.status === 'passed').length,
        failed: data.numFailedTests || failures.length,
        skipped: data.numPendingTests || 0,
      },
    }
  } catch {
    return { results: [], failures: [], summary: { total: 0, passed: 0, failed: 0 }, raw_hint: raw.slice(0, 500) }
  }
}

function extractJestErrorType(msg) {
  const m = /(\w+Error|\w+Exception)/.exec(msg || '')
  return m ? m[1] : 'Error'
}

function extractJestError(msg) {
  const lines = stripAnsi(msg || '').split('\n')
  for (const l of lines) {
    const trimmed = l.trim()
    if (trimmed && !trimmed.startsWith('at ') && !trimmed.startsWith('●')) return trimmed
  }
  return lines[0]?.trim() || 'unknown error'
}

export function parseGoTest(output) {
  const raw = stripAnsi(output)
  const lines = raw.split('\n')
  const results = []
  const failures = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    let m

    m = /^--- (PASS|FAIL|SKIP):\s+(\S+)\s+\(([\d.]+)s\)/.exec(line)
    if (m) {
      const entry = {
        test: m[2],
        file: '',
        status: m[1].toLowerCase(),
        duration_ms: Math.round(parseFloat(m[3]) * 1000),
      }
      results.push(entry)
      if (m[1] === 'FAIL') {
        const tb = extractGoFailure(lines, i)
        failures.push({ ...entry, ...tb })
      }
    }
  }

  const passed = results.filter(r => r.status === 'pass').length
  const failed = results.filter(r => r.status === 'fail').length
  return {
    results,
    failures,
    summary: { total: results.length, passed, failed, skipped: results.filter(r => r.status === 'skip').length },
  }
}

function extractGoFailure(lines, startIdx) {
  const tbLines = []
  let file = '', line = 0, error = ''
  for (let i = startIdx - 5; i < startIdx; i++) {
    if (i < 0) continue
    const l = lines[i]
    tbLines.push(l)
    const fm = /^\s+(.+?):(\d+):\s*(.+)/.exec(l)
    if (fm) { file = fm[1].trim(); line = parseInt(fm[2]); error = fm[3].trim() }
  }
  return { file, line, error, error_type: 'TestFailure', traceback: tbLines.join('\n') }
}

// dogfood-050 修复：node --test TAP 解析器（旧实现 framework=node 落 default 分支 →
// 失败时 results/failures 全空，原始 TAP 塞 run_error 且截断——最需失败富化时丢失）
export function parseNodeTap(output) {
  const raw = stripAnsi(output)
  const lines = raw.split('\n')
  const results = []
  const failures = []

  for (let i = 0; i < lines.length; i++) {
    const m = /^(ok|not ok)\s+(\d+)\s+-\s+(.+?)\s*$/.exec(lines[i])
    if (!m) continue
    let name = m[3]
    let status = m[1] === 'ok' ? 'passed' : 'failed'
    const skipM = /#\s*(SKIP|TODO)\b/i.exec(name)
    if (skipM) { status = 'skipped'; name = name.slice(0, skipM.index).trim() }

    const block = []
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]
      if (/^\S/.test(l)) break
      block.push(l)
      if (l.trim() === '...') break
    }

    const entry = { test: name, file: '', status }
    const dm = block.map(l => /^\s+duration_ms:\s*([\d.]+)/.exec(l)).find(Boolean)
    if (dm) entry.duration_ms = Math.round(parseFloat(dm[1]))

    if (status === 'failed') {
      const failure = { ...entry, error: '', error_type: 'TestFailure', traceback: '' }
      const loc = block.map(l => /^\s+location:\s*'?(.+?)'?\s*$/.exec(l)).find(Boolean)
      if (loc) {
        const lm = /^(.+):(\d+):\d+$/.exec(loc[1])
        if (lm) { failure.file = lm[1]; failure.line = parseInt(lm[2]) }
      }
      const nm = block.map(l => /^\s+name:\s*'?(.+?)'?\s*$/.exec(l)).find(Boolean)
      const errIdx = block.findIndex(l => /^\s+error:\s*/.test(l))
      if (errIdx !== -1) {
        const ev = /^\s+error:\s*(.*)$/.exec(block[errIdx])[1].trim()
        if (ev === '|-' || ev === '|') {
          const more = []
          for (let k = errIdx + 1; k < block.length; k++) {
            if (/^\s{6,}\S/.test(block[k])) more.push(block[k].trim())
            else break
          }
          failure.error = more.join(' ').slice(0, 300)
        } else {
          failure.error = ev.replace(/^'/, '').replace(/'$/, '')
        }
      }
      if (nm) {
        const nv = nm[1].trim().replace(/^'/, '').replace(/'$/, '')
        if (/Error|Exception/.test(nv)) failure.error_type = nv
      }
      if (!failure.error) {
        const exp = block.map(l => /^\s+expected:\s*(.+?)\s*$/.exec(l)).find(Boolean)
        const act = block.map(l => /^\s+actual:\s*(.+?)\s*$/.exec(l)).find(Boolean)
        if (exp && act) failure.error = 'expected ' + exp[1] + ', actual ' + act[1]
      }
      const stIdx = block.findIndex(l => /^\s+stack:\s*\|/.test(l))
      if (stIdx !== -1) {
        const st = []
        for (let k = stIdx + 1; k < block.length; k++) {
          if (/^\s{6,}\S/.test(block[k])) st.push(block[k].trim())
          else break
        }
        failure.traceback = st.join('\n').slice(0, 1000)
      }
      failures.push(failure)
    }
    results.push(entry)
  }

  const summary = parseTapSummary(lines, results)
  if (results.length === 0) {
    return { results, failures, summary, raw_hint: raw.slice(0, 1000) }
  }
  return { results, failures, summary }
}

function parseTapSummary(lines, results) {
  let passed = 0, failed = 0, skipped = 0, total = 0
  for (const l of lines) {
    let m
    if ((m = /^#\s*pass\s+(\d+)\b/i.exec(l))) passed = parseInt(m[1])
    else if ((m = /^#\s*fail\s+(\d+)\b/i.exec(l))) failed = parseInt(m[1])
    else if ((m = /^#\s*skipped\s+(\d+)\b/i.exec(l))) skipped = parseInt(m[1])
    else if ((m = /^#\s*tests\s+(\d+)\b/i.exec(l))) total = parseInt(m[1])
  }
  if (passed === 0 && failed === 0 && results.length > 0) {
    passed = results.filter(r => r.status === 'passed').length
    failed = results.filter(r => r.status === 'failed').length
    if (skipped === 0) skipped = results.filter(r => r.status === 'skipped').length
  }
  if (total === 0) total = passed + failed + skipped
  const summary = { total, passed, failed }
  if (skipped > 0) summary.skipped = skipped
  return summary
}

export function parseOutput(output, framework) {
  switch (framework) {
    case 'pytest': return parsePytest(output)
    case 'jest': return parseJest(output)
    case 'vitest': return parseJest(output)
    case 'go_test': return parseGoTest(output)
    case 'node': return parseNodeTap(output)
    default: return { results: [], failures: [], summary: { total: 0, passed: 0, failed: 0 }, raw_hint: stripAnsi(output).slice(0, 1000) }
  }
}
