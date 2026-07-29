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
    const shortMatch = raw.match(/(\d+) passed/)
    const failMatch = raw.match(/(\d+) failed/)
    if (shortMatch || failMatch) {
      return { results: [], failures: [], summary: { total: 0, passed: 0, failed: 0 }, raw_hint: raw.slice(0, 500) }
    }
  }

  return { results, failures, summary: parsePytestSummary(raw) }
}

function extractPytestTraceback(lines, startIdx) {
  const tbLines = []
  let errorType = '', error = '', file = '', line = 0

  for (let i = startIdx + 1; i < Math.min(startIdx + 40, lines.length); i++) {
    const l = lines[i]
    if (/^(PASSED|FAILED|ERROR|=+ )/.test(l) && i > startIdx + 1) break
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
  const m = output.match(/=+\s*(.+?)\s*(?:in\s+[\d.]+s)?\s*=+\s*$/)
  if (m) {
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

export function parseOutput(output, framework) {
  switch (framework) {
    case 'pytest': return parsePytest(output)
    case 'jest': return parseJest(output)
    case 'vitest': return parseJest(output)
    case 'go_test': return parseGoTest(output)
    default: return { results: [], failures: [], summary: { total: 0, passed: 0, failed: 0 }, raw_hint: stripAnsi(output).slice(0, 1000) }
  }
}
