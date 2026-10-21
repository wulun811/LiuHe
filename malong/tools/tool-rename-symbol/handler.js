import { join, sep } from 'node:path'
import { readFileSync, readdirSync } from 'node:fs'
import { TransactionStore } from '../tool-edit-transaction/transaction-store.js'
import { recoverTransactions } from '../../write-journal.js'
import { scanCjsRequires } from '../../cjs-imports.js'

// r28-fix：诚实化——移除 parser 不支持的 .rb/.php（提取不到符号，扫描纯浪费），补 C/C++/Java/Bash
const SOURCE_EXTS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts', '.py', '.go', '.rs', '.java', '.c', '.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx', '.sh', '.bash'])

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function hasOddBackslashes(line, idx) {
  let n = 0
  for (let k = idx - 1; k >= 0 && line[k] === '\\'; k--) n++
  return n % 2 === 1
}

function getStringRanges(line) {
  const ranges = []
  let i = 0
  while (i < line.length) {
    const ch = line[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      let start = i
      i++
      while (i < line.length && line[i] !== ch) {
        if (line[i] === '\\') i++
        i++
        // R22-⑰（第四轮审核 P1）+ R22-⑱（第五轮核实）：模板字面量（反引号）内 `${...}` 是代码不是字符串——
        // 符号在模板插值里被引用（如 `hello ${old_name} world`）必须可重命名。
        // 括号深度计数找匹配 }（跳过内层字符串/转义），把插值区间分割出字符串范围。
        // 注意：`\${` 是转义字面量（不插值）——`$` 前奇数个反斜杠时不分割（否则字符串内容被误改）。
        if (ch === '`' && line[i - 1] === '$' && line[i] === '{' && !hasOddBackslashes(line, i - 1)) {
          ranges.push([start, i - 1]) // 插值前的字符串段（到 $ 为止）
          let depth = 1
          i++
          while (i < line.length && depth > 0) {
            const c = line[i]
            if (c === '\\') { i += 2; continue }
            if (c === '"' || c === "'" || c === '`') {
              const q = c
              i++
              while (i < line.length && line[i] !== q) { if (line[i] === '\\') i++; i++ }
              continue
            }
            if (c === '{') depth++
            else if (c === '}') depth--
            i++
          }
          start = i // 插值后重新开段（i 指向 } 之后）
        }
      }
      ranges.push([start, i])
    } else if (ch === '/' && line[i + 1] !== '/' && line[i + 1] !== '*' &&
               (i === 0 || /[\s(,=:[\]!&|?(){};]/.test(line.slice(0, i).trimEnd().slice(-1)) || /(?:return|typeof|instanceof|case|in|of|new|delete|void|yield)$/.test(line.slice(0, i).trimEnd()))) {
      // 审查修复（二轮）：正则字面量内 `\/\/`（转义斜杠+斜杠）会被下行 `//` 注释分支误判，
      // 从转义处到行尾全部标为注释 → 行尾真实代码符号漏改（实测 `const urlRe = /https?:\/\//; process.env.X = 1`）。
      // 正则字面量整体跳过（含 [..] 字符类与转义），闭合 `/` 后可能还有 flags。
      // 审查修复（三轮→四轮）：前导判定用「最近非空白字符」+ keyword 判定 trimEnd（`return /re/` 的 / 前是
      // 空格且 return 后带尾空格，旧 $ 锚定失效→`\/\/` 复发实测漏改名，已修）；四轮恢复 \s/)/} 前导——
      // 除法误判由 abandoned 保护兜底（`(x) / 2 // c` 扫描跨到 // 即回退注释分支；无注释除法 phantom 扫描
      // 到行尾 break，无副作用）；扫描遇 `//`/`/*` 中止回退（phantom 扫描跨到注释前说明是除法误判）
      let j = i + 1
      let inClass = false
      let abandoned = false
      for (; j < line.length; j++) {
        const cc = line[j]
        if (cc === '\\') { j++; continue }
        if (cc === '[') inClass = true
        else if (cc === ']') inClass = false
        else if (!inClass && cc === '/' && (line[j + 1] === '/' || line[j + 1] === '*')) { abandoned = true; break }
        else if (cc === '/' && !inClass) break
      }
      if (abandoned) { i++; continue } // 除法误判：回退一格让注释分支处理（`//` 的 `/` 交给下行分支）
      i = j
      continue
    } else if (ch === '/' && line[i + 1] === '/') {
      ranges.push([i, line.length])
      break
    } else if (ch === '/' && line[i + 1] === '*') {
      const end = line.indexOf('*/', i + 2)
      ranges.push([i, end === -1 ? line.length : end + 2])
      i = end === -1 ? line.length : end + 2
      continue
    } else if (ch === '#') {
      ranges.push([i, line.length])
      break
    }
    i++
  }
  return ranges
}

function replaceOutsideStrings(line, re, replacement) {
  const ranges = getStringRanges(line)
  let result = ''
  let lastEnd = 0
  let m
  re.lastIndex = 0
  while ((m = re.exec(line)) !== null) {
    const inString = ranges.some(([s, e]) => m.index >= s && m.index < e)
    if (!inString) {
      result += line.slice(lastEnd, m.index) + replacement
      lastEnd = m.index + m[0].length
    }
  }
  result += line.slice(lastEnd)
  return result
}

function findTextRefs(workspaceDir, symbol, maxFiles = 300, maxResults = 100) {
  const results = []
  // R17-8：`(^|[^\w])` 替代 `\b`——中文/Unicode 符号名边界正确匹配（\b 对 CJK 恒失效）
  const re = new RegExp(`(^|[^\\w])${escapeRegex(symbol)}([^\\w]|$)`)
  const scanned = { files: 0 }
  walk(workspaceDir, workspaceDir, re, results, scanned, maxFiles, maxResults)
  // R22-④（审核修复）：300 文件/100 条上限截断标注——rename 是写操作，漏改名后果重，必须显式告知
  if (scanned.files >= maxFiles || results.length >= maxResults) results.scanTruncated = true
  return results
}

// 15（P2）：作用域保护——被改名符号在本文件的局部绑定名 ≠ symbol 时，只允许改 import 行。
// 例：app.js `const { process: libProcess } = require('./lib.js')` 局部绑定名是 libProcess，
// 裸 token `process`（如 process.env 的 Node 全局）与 lib.js::process 无关，改名不应连坐。
// 若存在同名的同形绑定（`{ process }` / `import { process }`）则保守放行全部（改错比漏改安全）。
function computeScopeRestriction(content, symbol) {
  const lines = content.split('\n')
  const aliasedLines = new Set()
  let bindsSameName = false

  for (const imp of scanCjsRequires(content)) {
    if (!imp.aliasMap) continue
    for (const [local, original] of Object.entries(imp.aliasMap)) {
      if (original !== symbol) continue
      if (local === symbol) bindsSameName = true
      else aliasedLines.add(imp.line)
    }
  }

  const asRe = new RegExp(`(^|[^\\w])${escapeRegex(symbol)}\\s+as\\s+(\\w+)`, 'g')
  for (let i = 0; i < lines.length; i++) {
    let m
    asRe.lastIndex = 0
    while ((m = asRe.exec(lines[i])) !== null) {
      if (m[1] === symbol) bindsSameName = true
      else aliasedLines.add(i + 1)
    }
  }

  return bindsSameName ? null : (aliasedLines.size ? aliasedLines : null)
}

function walk(baseDir, dir, re, results, scanned, maxFiles, maxResults) {
  if (scanned.files >= maxFiles || results.length >= maxResults) return
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    if (scanned.files >= maxFiles || results.length >= maxResults) break
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '__pycache__' || entry.name === 'venv' || entry.name === 'dist' || entry.name === 'build') continue
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(baseDir, fullPath, re, results, scanned, maxFiles, maxResults)
    } else if (entry.isFile()) {
      const ext = fullPath.slice(fullPath.lastIndexOf('.'))
      if (!SOURCE_EXTS.has(ext)) continue
      scanned.files++
      const relPath = (fullPath.startsWith(baseDir + sep) ? fullPath.slice(baseDir.length + 1) : fullPath).replace(/\\/g, '/')
      try {
        const lines = readFileSync(fullPath, 'utf-8').split('\n')
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            results.push({ path: relPath, line: i + 1, context: lines[i].trim() })
            if (results.length >= maxResults) break
          }
        }
      } catch {}
    }
  }
}

export async function handle(args, context) {
  const { codeIndexService, getWorkspaceDir } = context
  const workspaceDir = args?.workspace_dir

  if (!workspaceDir) {
    return { error: 'missing_parameter', message: 'workspace_dir is required' }
  }

  // R22-④（审核修复）：入口崩溃自愈——rename 用 TransactionStore 但入口无 recoverTransactions，
  // 中途崩溃留 staged + 部分落盘只能等未来某次 edit_transaction begin 顺带恢复（R4a 设计漏实现）
  try { await recoverTransactions(workspaceDir, { codeIndexService: context?.codeIndexService }) } catch {}

  const symbol = args?.symbol
  const newName = args?.new_name
  let file = args?.file
  const dryRun = args?.dry_run !== false

  if (!symbol || !newName || !file) {
    return { error: 'missing_parameter', message: 'symbol, new_name, and file are required' }
  }

  if (symbol === newName) {
    return { error: 'invalid_input', message: 'new_name must differ from symbol' }
  }

  // r54(P0-2): symbol 进 txn 目录名——拒绝路径分隔符/`..`（store.begin 已消毒，此处提前给清晰错误）
  if (/[/\\]|\.\./.test(symbol)) {
    return { error: 'invalid_input', message: `symbol "${symbol}" contains path separators or ".."; must be a plain symbol name` }
  }

  // 验证 new_name 是合法标识符
  if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(newName)) {
    return { error: 'invalid_input', message: `"${newName}" is not a valid identifier. Must match /^[a-zA-Z_$][a-zA-Z0-9_$]*$/` }
  }

  await codeIndexService?.initWorkspace(workspaceDir)

  // 16：file 参数共用守卫——定义文件无效（目录/不存在）时提前返回，不再静默 definition=null
  if (codeIndexService?.resolveFileArg) {
    const resolved = codeIndexService.resolveFileArg(file, workspaceDir)
    if (!resolved.ok) return { error: resolved.error.code, message: resolved.error.message, suggestion: resolved.error.suggestion }
    file = resolved.path
  }

  let semanticRefs = []
  if (codeIndexService) {
    // r8(F15)：引用集可能被 LIMIT 截断——rename 需要全集，传大 limit 并在截断时警告（防改名静默不完整）
    try { semanticRefs = await codeIndexService.getReferences(symbol, undefined, { limit: 10000 }) || [] } catch {}
  }

  const textRefs = findTextRefs(workspaceDir, symbol)
  const semanticTruncated = semanticRefs.length >= 10000
  // R22-④：文本扫描 300 文件/100 条上限截断标注（漏改名不提示 = 静默不完整写操作）
  const textTruncated = textRefs.scanTruncated === true

  // 定义行解析提前：索引 refs 表只存 use/call 不存定义，文本扫描有 maxFiles 上限可能扫不到深层文件——
  // 不显式补入定义行时改名会漏改定义行，应用后直接产生坏代码（使用点改名、定义未改 → ReferenceError）
  let definition = null
  if (codeIndexService) {
    try {
      const syms = await codeIndexService.getSymbols(file)
      const def = (syms || []).find(s => s.name === symbol)
      if (def) definition = { file, line: def.start_line, type: def.type }
    } catch {}
  }

  const seen = new Set()
  const allRefs = []
  const defRef = definition ? [{ path: definition.file, line: definition.line, context: '' }] : []
  // r54(P1): 用索引返回的真实 line——旧实现恒映射 line:0，下方 lineIdx<0 全跳过，语义引用永远变不成编辑，
  // 文本扫描超 maxFiles/maxResults 上限后唯一补漏来源被丢弃 → 改名静默不完整
  for (const r of [...defRef, ...textRefs, ...semanticRefs.map(s => ({ path: s.path, line: s.line || 0, context: '' }))]) {
    const key = `${r.path}:${r.line}`
    if (!seen.has(key)) { seen.add(key); allRefs.push(r) }
  }

  if (allRefs.length === 0) {
    return { error: 'not_found', message: `No references found for "${symbol}"`, suggestion: `Call reindex(workspace_dir="${workspaceDir}") to update the index` }
  }

  const byFile = new Map()
  for (const ref of allRefs) {
    if (!ref?.path) continue // 脏数据防御（索引缺 path 字段时不崩 handler）
    if (!byFile.has(ref.path)) byFile.set(ref.path, [])
    byFile.get(ref.path).push(ref)
  }

  const editsPerFile = []
  let totalEdits = 0
  const unreadable = []

  for (const [relPath, refs] of byFile) {
    const absPath = join(workspaceDir, relPath)
    let content
    try { content = readFileSync(absPath, 'utf-8') } catch { unreadable.push(relPath); continue }

    // 15（P2）：别名绑定文件（局部名 ≠ symbol）只改 import 行，裸 token 不改
    const scopeRestriction = computeScopeRestriction(content, symbol)

    const lines = content.split('\n')
    // R22-⑯：CJK rename 零宽断言—— 对中文符号永不匹配（\w 不含 CJK），应用段与检测段同步
    const wordRe = new RegExp(`(?<![A-Za-z0-9_])${escapeRegex(symbol)}(?![A-Za-z0-9_])`, 'g')
    const fileEdits = []

    for (const ref of refs) {
      const lineIdx = ref.line - 1
      if (lineIdx < 0 || lineIdx >= lines.length) continue
      if (scopeRestriction && !scopeRestriction.has(ref.line)) continue
      const line = lines[lineIdx]
      if (!wordRe.test(line)) continue
      wordRe.lastIndex = 0

      // R22-⑰（第四轮审核 P1）：旧 stripped 正则把整行模板字面量（含 `${}` 插值）连锅剥掉，
      // 插值里的符号引用（`hello ${old_name} world`）被误判为字符串后跳过整行。
      // 改用 getStringRanges：只剥字符串区间（插值不在 ranges 内），保留下方 replaceOutsideStrings 能改插值代码。
      const ranges = getStringRanges(line)
      const stripped = ranges.length > 0 ? (() => {
        const chars = line.split('')
        for (const [s, e] of ranges) for (let k = s; k < e && k < chars.length; k++) chars[k] = ' '
        return chars.join('')
      })() : line
      if (!wordRe.test(stripped)) continue
      wordRe.lastIndex = 0

      const newLine = replaceOutsideStrings(line, wordRe, newName)
      if (newLine !== line) {
        fileEdits.push({ line: ref.line, old: line, new: newLine })
      }
    }

    if (fileEdits.length > 0) {
      editsPerFile.push({ file: relPath, edits: fileEdits })
      totalEdits += fileEdits.length
    }
  }

  if (totalEdits === 0) {
    return { symbol, new_name: newName, files_changed: 0, total_edits: 0, message: 'No word-boundary matches found (all matches may be in strings/comments)' }
  }

  // dogfood-050（P2 修复）：冲突检测改用「精确同名」——旧实现用 searchSymbols(newName) 的子串匹配，
  // rename formatNumber→formatNum 会因 formatNum 是 formatNumber 的子串而误报；真冲突（sub→mul）
  // 的报错位置取 ORDER BY 首行（可能落在 tests 解构处而非定义）。
  // 分级：同文件（定义文件或本次将编辑的文件）= 阻塞（会产生重复声明）；仅跨文件同名 = 警告。
  let conflictWarning = null
  let conflictBlocking = false
  if (codeIndexService) {
    try {
      const matches = await codeIndexService.searchSymbols(newName, { limit: 50 })
      const exact = (matches || []).filter(s => s.name === newName)
      if (exact.length > 0) {
        const editedFiles = new Set(editsPerFile.map(e => e.file))
        const sameFile = exact.find(s => s.file === definition?.file || editedFiles.has(s.file))
        const pick = sameFile || exact[0]
        conflictWarning = `"${newName}" already exists as ${pick.type} in ${pick.file}`
        conflictBlocking = !!sameFile
      }
    } catch {}
  }

  let affectedCallers = []
  if (codeIndexService) {
    try {
      const callers = await codeIndexService.getCallers(symbol)
      affectedCallers = [...new Set((callers || []).map(c => c.caller_file))].slice(0, 10)
    } catch {}
  }

  const result = {
    symbol,
    new_name: newName,
    dry_run: dryRun,
    files_changed: editsPerFile.length,
    total_edits: totalEdits,
    edits_per_file: editsPerFile,
    definition,
    conflict_warning: conflictWarning,
    conflict_blocking: conflictBlocking,
    ...(semanticTruncated ? { warning: 'Semantic reference set truncated at 10000 — text scan may cover more; rename could be incomplete.' } : {}),
    // R22-④：文本扫描截断警告（与语义截断同字段，可叠加）
    ...(textTruncated ? { warning: (semanticTruncated ? 'Semantic reference set truncated at 10000; ' : '') + `Text scan truncated (300 files / 100 results cap) — deep or late-alphabet files may be missed. Run reindex(workspace_dir=...) and retry for a complete rename.` } : {}),
    affected_callers: affectedCallers.length > 0 ? affectedCallers : undefined,
    next_step: dryRun
      ? `Apply: rename_symbol(..., dry_run=false). Then verify: test_bridge(action="run")`
      : `Verify: test_bridge(action="run"). Check mocks: mock_sync(file="${file}", function="${symbol}")`,
  }

  // dogfood-050（P2 修复）：真阻塞冲突在写盘前拒绝（旧实现只警告，会拆出 { add, mul, mul } 之类重复声明）
  if (!dryRun && conflictBlocking) {
    return {
      ...result,
      status: 'rejected',
      error: 'RENAME_CONFLICT',
      message: conflictWarning,
      suggestion: 'Choose a different new_name, or rename the existing symbol first (this would create duplicate declarations).',
    }
  }

  if (!dryRun) {
    const store = new TransactionStore(workspaceDir)
    const txnId = store.begin(`rename_${symbol}_to_${newName}`)
    let failed = false
    for (const { file: f, edits } of editsPerFile) {
      // r52: backupFile 失败（大文件/文件缺失/路径拦截）必须中止——否则无备份仍写盘，后续失败 rollback 无法还原
      const backupResult = await store.backupFile(txnId, f)
      if (backupResult?.error_code) {
        await store.rollback(txnId)
        result.status = 'rolled_back'
        result.error = backupResult.error
        result.failed_file = f
        failed = true
        break
      }
      const editResult = await store.applyEdits(txnId, f, edits.map(e => ({
        old_string: e.old,
        new_string: e.new,
      })))
      if (editResult.error_code) {
        await store.rollback(txnId)
        result.status = 'rolled_back'
        result.error = editResult.error
        result.failed_file = f
        failed = true
        break
      }
    }
    if (!failed) {
      // R22-⑰（第四轮审核 P1）+ R22-⑱（第五轮核实）：commit 已 async——同步 try/catch 抓不住 rejection
      // （_writeManifest fsync 抛错 → unhandledRejection 崩进程）且失败对象被丢弃谎报 committed。
      // 改 await + 检查返回 error：失败 → staged_pending（文件已 staged 落盘，可 rollback 还原）。
      let cr
      try {
        cr = await store.commit(txnId)
      } catch (e) {
        cr = { error: 'commit_failed', message: `Commit threw: ${e.message}` }
      }
      if (cr?.error) {
        result.status = 'staged_pending'
        result.txn_id = txnId
        result.error = cr.error
        result.warning = `Commit failed (${cr.message || cr.error}); edits are staged in transaction ${txnId} — use edit_transaction(action=rollback) to revert or retry commit`
        return result
      }
      result.status = 'committed'
      result.txn_id = txnId
      // r8(F14)：写后同步重抽——否则按 next_step 立即验证（impact/references 查新名）会拿到旧索引 → 空 caller/低风险误判
      if (codeIndexService) {
        const reindexed = []
        for (const { file: f } of editsPerFile) {
          const abs = join(workspaceDir, f)
          try {
            await codeIndexService.indexFile(abs, workspaceDir)
            reindexed.push(f)
          } catch {
            try { codeIndexService.markIndexDirty(f, 'rename_pending_reindex') } catch {}
          }
        }
        if (reindexed.length > 0) result.reindexed = reindexed
      }
    }
  }

  if (unreadable.length > 0) {
    result.warning = (result.warning ? result.warning + '; ' : '') + `Unreadable files skipped: ${unreadable.join(', ')}`
  }

  return result
}
