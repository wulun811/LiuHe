import { join, extname, basename } from 'node:path'
import { existsSync, readFileSync, readdirSync } from 'node:fs'

const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', 'dist', 'build'])

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isTestFile(path) {
  return /(?:^|\/)(?:tests?|__tests__)\/|\.test\.|\.spec\.|_test\./.test(path)
}

function walkTestFiles(baseDir, dir, files, maxFiles) {
  if (files.length >= maxFiles) return
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    if (files.length >= maxFiles) break
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      walkTestFiles(baseDir, fullPath, files, maxFiles)
    } else if (entry.isFile() && isTestFile(fullPath)) {
      files.push(fullPath.startsWith(baseDir + '/') ? fullPath.slice(baseDir.length + 1) : fullPath)
    }
  }
}

function extractSignature(content, functionName, ext) {
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    let m
    if (ext === '.py') {
      m = new RegExp(`^\\s*(?:async\\s+)?def\\s+${functionName}\\s*\\(([^)]*)\\)(?:\\s*->\\s*(.+?))?\\s*:`).exec(lines[i])
    } else {
      m = new RegExp(`(?:function\\s+${functionName}|(?:const|let|var)\\s+${functionName}\\s*=\\s*(?:async\\s+)?(?:function)?\\s*)\\(([^)]*)\\)`).exec(lines[i])
    }
    if (m) {
      const params = m[1]
        ? m[1].split(',').map(p => {
            const trimmed = p.trim()
            const name = trimmed.split(/[:\s=]/)[0].trim()
            const hasDefault = trimmed.includes('=')
            return { name, has_default: hasDefault, raw: trimmed }
          }).filter(p => p.name && p.name !== 'self' && p.name !== 'cls')
        : []
      const returnType = ext === '.py' && m[2] ? m[2].trim() : null
      return { name: functionName, params, return_type: returnType, line: i + 1 }
    }
  }
  return null
}

function findMockUsage(content, functionName, testFile) {
  const mocks = []
  const lines = content.split('\n')
  const fnEscaped = escapeRegex(functionName)
  const fnLower = functionName.toLowerCase()

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    let m
    m = new RegExp(`(?:mock|patch|spy|stub).*${fnEscaped}.*\\.return_value\\s*=\\s*(.+)`, 'i').exec(line)
    if (m) {
      mocks.push({ file: testFile, line: i + 1, mock_type: 'return_value', value: m[1].trim(), context: line.trim() })
      continue
    }

    m = new RegExp(`@(?:patch|mock).*${fnEscaped}`, 'i').exec(line)
    if (m) {
      mocks.push({ file: testFile, line: i + 1, mock_type: 'patch', value: line.trim(), context: line.trim() })
      continue
    }

    m = new RegExp(`(?:jest\\.(?:fn|spyOn)|sinon\\.(?:stub|spy)).*${fnEscaped}`, 'i').exec(line)
    if (m) {
      mocks.push({ file: testFile, line: i + 1, mock_type: 'spy', value: line.trim(), context: line.trim() })
      continue
    }

    m = new RegExp(`mock_${escapeRegex(fnLower)}\\s*\\(([^)]*)\\)`, 'i').exec(line)
    if (m) {
      const argCount = m[1].trim() ? m[1].split(',').length : 0
      mocks.push({ file: testFile, line: i + 1, mock_type: 'call', arguments: m[1].trim(), arg_count: argCount, context: line.trim() })
    }
  }
  return mocks
}

function detectMismatches(signature, mocks) {
  const mismatches = []

  for (const mock of mocks) {
    if (mock.mock_type === 'return_value' && signature.return_type) {
      const val = mock.value
      const rt = signature.return_type
      if (rt !== 'None' && rt !== 'void' && (val.startsWith("'") || val.startsWith('"'))) {
        mismatches.push({
          test_file: mock.file, line: mock.line, mock_type: 'return_value',
          issue: 'return type mismatch',
          current: mock.value,
          expected: `${rt}(...)`,
          suggestion: `update return_value to ${rt} object`,
        })
      }
    }

    if (mock.mock_type === 'call') {
      const requiredParams = signature.params.filter(p => !p.has_default).length
      if (mock.arg_count < requiredParams) {
        const missing = signature.params.slice(mock.arg_count).map(p => p.name)
        mismatches.push({
          test_file: mock.file, line: mock.line, mock_type: 'call',
          issue: 'missing parameters',
          current: `${mock.arg_count} arguments`,
          expected: `${requiredParams} required arguments`,
          suggestion: `add ${missing.join(', ')}`,
        })
      }
    }
  }
  return mismatches
}

export async function handle(args, context) {
  const workspaceDir = args?.workspace_dir

  if (!workspaceDir) {
    return { error: 'missing_parameter', message: 'workspace_dir is required' }
  }

  const file = args?.file
  const functionName = args?.function
  if (!file || !functionName) {
    return { error: 'missing_parameter', message: 'file and function are required' }
  }

  const absPath = join(workspaceDir, file)
  let content
  try { content = readFileSync(absPath, 'utf-8') } catch {
    return { error: 'file_not_found', message: `Cannot read file: ${file}` }
  }
  const ext = extname(file)
  const signature = extractSignature(content, functionName, ext)

  if (!signature) {
    return { error: 'symbol_not_found', message: `Function "${functionName}" not found in ${file}` }
  }

  const testFiles = []
  walkTestFiles(workspaceDir, workspaceDir, testFiles, 100)

  let allMocks = []
  for (const tf of testFiles) {
    try {
      const testContent = readFileSync(join(workspaceDir, tf), 'utf-8')
      allMocks.push(...findMockUsage(testContent, functionName, tf))
    } catch {}
  }

  const mismatches = detectMismatches(signature, allMocks)

  return {
    target: {
      file,
      function: functionName,
      signature: `(${signature.params.map(p => p.raw).join(', ')})${signature.return_type ? ' -> ' + signature.return_type : ''}`,
      line: signature.line,
    },
    mock_mismatches: mismatches,
    summary: {
      total_mocks_checked: allMocks.length,
      mismatches_found: mismatches.length,
      fixable: mismatches.length > 0,
    },
  }
}
