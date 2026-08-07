// test-r54-p1.js — 第七轮审计 P1 修复锁定（正确性）
// 覆盖：code-review 单行函数不误报 + 重复块行号、edit-transaction 单 edit 失败不连坐回滚、
//       transaction-store 事务保留、dep-gatekeeper poetry 解析。
import { join, dirname } from 'node:path'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MALONG = dirname(__dirname)
const imp = (p) => import(pathToFileURL(p).href)

let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++; console.log(`  \u2713 ${msg}`) } else { fail++; console.error(`  \u2717 FAIL: ${msg}`) }
}
const tmp = (tag) => {
  const ws = join(os.tmpdir(), 'opencode', `r54-p1-${tag}-${process.pid}`)
  try { rmSync(ws, { recursive: true, force: true }) } catch {}
  mkdirSync(ws, { recursive: true })
  return ws
}

// ── code-review：单行函数不误报长函数 ──
console.log('\u2500\u2500 code-review \u5355\u884c\u51fd\u6570 + \u91cd\u590d\u884c\u53f7 \u2500\u2500')
{
  const { handle } = await imp(join(MALONG, 'tools/tool-code-review/handler.js'))
  // 单行函数后跟顶层平衡代码：不应误报「函数有 N 行」
  const src1 = 'function tiny() { return 1 }\nconst a = 1\nconst b = 2\nconst c = { x: 1 }\n'
  let r = await handle({ workspace_dir: MALONG, source: src1 }, {})
  const longFnIssues = (r.issues || []).filter(i => i.category === 'complexity' && /\u884c/.test(i.message))
  assert(longFnIssues.length === 0, `\u5355\u884c\u51fd\u6570\u4e0d\u5e94\u8bef\u62a5\u957f\u51fd\u6570\uff08\u5f97 ${longFnIssues.length}\uff09`)

  // 重复块行号：短行在前，重复行行号应为原始行号
  const dup = 'const longRepeatedStatement = someValue + anotherValue\n'.repeat(1)
  const src2 = 'x\n' + dup + 'y\n' + dup + 'z\n' + dup
  r = await handle({ workspace_dir: MALONG, source: src2 }, {})
  const dupIssue = (r.issues || []).find(i => i.category === 'duplication')
  assert(dupIssue && dupIssue.line === 2, `\u91cd\u590d\u5757\u9996\u884c\u5e94\u4e3a\u539f\u59cb\u884c\u53f7 2\uff08\u5f97 ${dupIssue?.line}\uff09`)
}

// ── edit-transaction：单 edit 失败不连坐回滚 ──
console.log('\u2500\u2500 edit-transaction \u5355 edit \u5931\u8d25\u4e0d\u8fde\u5750 \u2500\u2500')
{
  const { handle } = await imp(join(MALONG, 'tools/tool-edit-transaction/handler.js'))
  const ws = tmp('edittxn')
  writeFileSync(join(ws, 'a.js'), 'const alpha = 1\nconst beta = 2\n')
  const b = await handle({ action: 'begin', workspace_dir: ws, name: 't' }, {})
  const txnId = b.txnId
  assert(!!txnId, 'begin \u8fd4\u56de txnId')
  // edit A 成功
  const eA = await handle({ action: 'edit', workspace_dir: ws, txn_id: txnId, file: 'a.js', edits: [{ old_string: 'const alpha = 1', new_string: 'const alpha = 100' }] }, {})
  assert(eA.status === 'staged', `edit A \u5e94 staged\uff08\u5f97 ${eA.status}\uff09`)
  // edit B 零匹配 → 旧实现会 rollback 整事务；新实现保留
  const eB = await handle({ action: 'edit', workspace_dir: ws, txn_id: txnId, file: 'a.js', edits: [{ old_string: 'NO_SUCH_TEXT_XYZ', new_string: 'x' }] }, {})
  assert(eB.status === 'edit_failed', `edit B \u5e94 edit_failed\uff08\u5f97 ${eB.status}\uff09`)
  // 事务仍存在，edit A 的改动仍在盘上
  assert(existsSync(join(ws, '.ai-transactions', txnId)), `\u4e8b\u52a1\u76ee\u5f55\u5e94\u4fdd\u7559`)
  assert(readFileSync(join(ws, 'a.js'), 'utf-8').includes('const alpha = 100'), `edit A \u7684 stage \u6539\u52a8\u5e94\u4fdd\u7559`)
  try { rmSync(ws, { recursive: true, force: true }) } catch {}
}

// ── dep-gatekeeper：poetry pyproject 解析 ──
console.log('\u2500\u2500 dep-gatekeeper poetry \u89e3\u6790 \u2500\u2500')
{
  const mod = await imp(join(MALONG, 'tools/tool-dependency-gatekeeper/handler.js'))
  // parsePyprojectToml 是模块内函数，若未导出则经 handler 主路径间接验证；此处直接验 poetry 段识别
  const ws = tmp('poetry')
  writeFileSync(join(ws, 'pyproject.toml'), [
    '[tool.poetry]',
    'name = "demo"',
    '',
    '[tool.poetry.dependencies]',
    'python = "^3.9"',
    'requests = "^2.28"',
    'flask = { version = "^2.0", optional = true }',
    '',
    '[tool.poetry.group.dev.dependencies]',
    'pytest = "^7.0"',
  ].join('\n'))
  // 通过导出的解析函数验证（若存在）
  if (typeof mod.parsePyprojectToml === 'function') {
    const deps = {}
    mod.parsePyprojectToml(join(ws, 'pyproject.toml'), deps)
    assert(!!deps.requests, `poetry requests \u5e94\u88ab\u8bc6\u522b\uff08\u5f97 ${JSON.stringify(Object.keys(deps))}\uff09`)
    assert(!!deps.flask, `poetry flask(\u8868\u683c\u503c) \u5e94\u88ab\u8bc6\u522b`)
    assert(!!deps.pytest, `poetry group.dev pytest \u5e94\u88ab\u8bc6\u522b`)
    assert(!deps.python, `python \u8fd0\u884c\u65f6\u4e0d\u5e94\u5f53\u4f9d\u8d56`)
  } else {
    console.log('  (parsePyprojectToml \u672a\u5bfc\u51fa\uff0c\u8df3\u8fc7\u76f4\u63a5\u9a8c\u8bc1)')
  }
  try { rmSync(ws, { recursive: true, force: true }) } catch {}
}

// ── dep-gatekeeper：R22-⑧ 本地模块弱映射修复（同仓库包不报 unknown_mapping + unresolved 中性标注） ──
console.log('\u2500\u2500 dep-gatekeeper \u672c\u5730\u6a21\u5757 + unresolved \u6807\u6ce8 \u2500\u2500')
{
  const mod = await imp(join(MALONG, 'tools/tool-dependency-gatekeeper/handler.js'))
  const pc = await imp(join(MALONG, 'parse-client.js'))
  await pc.init({ log: () => {} })
  const connected = await pc.connect()
  assert(connected, 'parse-client \u8fde\u63a5\u5230 malong-parse')
  const langParser = {
    extractAllAsync: (source, ext, filePath, ws) => pc.extractAll(source, ext, filePath, ws),
    extractReferencesAsync: (source, ext) => pc.extractReferences(source, ext),
    batchExtractAsync: (files, ws) => pc.batchExtract(files, ws),
  }
  const ws = tmp('localmod')
  writeFileSync(join(ws, 'pyproject.toml'), '[project]\nname = "demo"\nversion = "0.1.0"\ndependencies = []\n')
  mkdirSync(join(ws, 'A1'), { recursive: true })
  writeFileSync(join(ws, 'A1', '__init__.py'), '')
  writeFileSync(join(ws, 'util.py'), 'x = 1\n')
  writeFileSync(join(ws, 'main.py'), 'import A1\nimport util\nimport zzz_nonexistent_xyz\n')
  const r = await mod.handle({ workspace_dir: ws, file: 'main.py' }, { langParserService: langParser })
  assert(!r.error && r.imports_checked === 3, '\u672c\u5730\u6a21\u5757\u6d4b\u8bd5\u4e0d\u5e94\u670d\u52a1\u5931\u8d25\uff08\u5f97 ' + JSON.stringify(r.error || { imports_checked: r.imports_checked }) + '\uff09')
  const unknown = (r.issues || []).filter(i => i.type === 'unknown_mapping')
  assert(!unknown.some(i => i.module === 'A1'), '\u540c\u4ed3\u5e93\u5305\u76ee\u5f55 A1 \u4e0d\u5e94\u62a5 unknown_mapping\uff08\u5f97 ' + JSON.stringify(unknown) + '\uff09')
  assert(!unknown.some(i => i.module === 'util'), '\u540c\u4ed3\u5e93\u540c\u540d\u6587\u4ef6 util \u4e0d\u5e94\u62a5 unknown_mapping')
  assert(r.dependencies_found?.A1?.local_module === true, '\u672c\u5730\u5305 A1 \u5e94\u6807 local_module\uff08\u5f97 ' + JSON.stringify(r.dependencies_found?.A1) + '\uff09')
  assert(r.dependencies_found?.util?.local_module === true, '\u672c\u5730\u6587\u4ef6 util \u5e94\u6807 local_module')
  const zzz = unknown.find(i => i.module === 'zzz_nonexistent_xyz')
  assert(!!zzz && r.dependencies_found?.zzz_nonexistent_xyz?.unresolved === true && r.dependencies_found?.zzz_nonexistent_xyz?.in_manifest === undefined, '\u771f\u672a\u77e5\u6a21\u5757\u5e94 unresolved\u4e2d\u6027\u6807\u6ce8\uff08\u5f97 ' + JSON.stringify(r.dependencies_found?.zzz_nonexistent_xyz) + '\uff09')
  try { rmSync(ws, { recursive: true, force: true }) } catch {}
}

// ── R22-⑪：3 分档工具 P2 修复锁定（guard-patterns 三引号/空文件 + code-quality 注释污染 + code-review 字符串花括号 + style-sniffer 撇号/聚合 + active-todos read_errors） ──
console.log('\u2500\u2500 R22-⑪ 3 \u5206\u6863\u4fee\u590d\u9501\u5b9a \u2500\u2500')
{
  const gp = await imp(join(MALONG, 'tools/tool-guard-patterns/handler.js'))
  const cq = await imp(join(MALONG, 'tools/tool-code-quality/handler.js'))
  const cr = await imp(join(MALONG, 'tools/tool-code-review/handler.js'))
  const ss = await imp(join(MALONG, 'tools/tool-style-sniffer/handler.js'))
  const at = await imp(join(MALONG, 'tools/tool-active-todos/handler.js'))
  const ws = tmp('v41')
  // guard-patterns: 单引号内三连不误开 + 真裸 except 仍报；docstring 内 except 文本不报；空文件无 unsupported_language
  writeFileSync(join(ws, 'a.py'), 'x = \'"""\'\ny = 1\ntry:\n    z = x\nexcept:\n    pass\n')
  writeFileSync(join(ws, 'b.py'), 'def f():\n    """doc\n    except: this is doc text\n    """\n    return 1\n')
  writeFileSync(join(ws, 'empty.py'), '')
  const pc = await imp(join(MALONG, 'parse-client.js'))
  await pc.init({ log: () => {} })
  const connected = await pc.connect()
  assert(connected, 'parse-client \u8fde\u63a5\u5230 malong-parse')
  const langParser = {
    extractAllAsync: (s, e, f, ws) => pc.extractAll(s, e, f, ws),
    extractReferencesAsync: (s, e) => pc.extractReferences(s, e),
    batchExtractAsync: (f, ws) => pc.batchExtract(f, ws),
  }
  const rGpA = await gp.handle({ workspace_dir: ws, file: 'a.py' }, { langParserService: langParser })
  const rGpB = await gp.handle({ workspace_dir: ws, file: 'b.py' }, { langParserService: langParser })
  const rGpE = await gp.handle({ workspace_dir: ws, file: 'empty.py' }, { langParserService: langParser })
  assert((rGpA.violations || []).filter(v => v.rule === 'no-bare-except').length === 1, `单引号内三连不污染、真裸 except 仍报（得 ${JSON.stringify(rGpA.violations)}）`)
  assert((rGpB.violations || []).filter(v => v.rule === 'no-bare-except').length === 0, `docstring 内 except 文本不误报`)
  assert(!JSON.stringify(rGpE.warnings || []).includes('unsupported_language'), `空文件不报 unsupported_language（得 ${JSON.stringify(rGpE.warnings)}）`)
  // code-quality: 注释-only 0 违规 + 非代码 paradigmFit applicable=false
  writeFileSync(join(ws, 'comments.js'), '// eval is dangerous\n// process.exit here\n/* Function ctor */\n')
  writeFileSync(join(ws, 'doc.md'), '# title\ntext\n')
  const rCq = await cq.handle({ workspace_dir: ws, file: 'comments.js' }, {})
  const rCqMd = await cq.handle({ workspace_dir: ws, file: 'doc.md' }, {})
  assert(rCq.dimensions?.archViolation?.rawViolations === 0 && rCq.dimensions?.blastRadius?.rawDangerousAPIs === 0, `注释-only 文件 0 违规（得 ${JSON.stringify(rCq.dimensions?.archViolation)}/${rCq.dimensions?.blastRadius?.rawDangerousAPIs}）`)
  assert(rCqMd.dimensions?.paradigmFit?.applicable === false, `非代码文件 paradigmFit applicable=false`)
  // code-review: 字符串里的花括号不干扰长函数判断
  writeFileSync(join(ws, 'str.js'), 'const a = "{"\nconst b = "}"\nfunction short() { return 1 }\nfunction alsoShort() { return 2 }\n')
  const rCr = await cr.handle({ workspace_dir: ws, file: 'str.js' }, {})
  assert((rCr.issues || []).filter(i => i.category === 'complexity').length === 0, `字符串花括号 0 长函数误报`)
  // style-sniffer: 撇号不污染 + 全文件聚合 + sample_note（独立 ws——共享 ws 混入的 a.py/b.py 三引号会影响采样排序，断言非确定）
  const wsSs = tmp('v41-ss')
  writeFileSync(join(wsSs, 'style.js'), "const a = 'x';\nconst b = 'y';\n// don't worry\n/* it's fine */\n")
  writeFileSync(join(wsSs, 'str.js'), 'const a = "{"\nconst b = "}"\n')
  writeFileSync(join(wsSs, 'plain.js'), 'const z = 1\n')
  const rSs = await ss.handle({ workspace_dir: wsSs }, {})
  assert(rSs.styles?.quotes === 'single', `撇号不污染且全文件聚合选单引号（得 ${rSs.styles?.quotes}）`)
  assert(!!rSs.sample_note && rSs.sample_note.includes('small sample'), `sample_note 低置信度声明（得 ${rSs.sample_note}）`)
  try { rmSync(wsSs, { recursive: true, force: true }) } catch {}
  // active-todos: read_errors 字段
  writeFileSync(join(ws, 'todo.js'), '// TODO: fix\n')
  const rAt = await at.handle({ workspace_dir: ws }, {})
  assert(typeof rAt.read_errors === 'number' && typeof rAt.files_truncated === 'boolean', `active-todos read_errors/files_truncated 字段（得 ${rAt.read_errors}/${rAt.files_truncated}）`)
  try { rmSync(ws, { recursive: true, force: true }) } catch {}
}

console.log(`\n=== test-r54-p1: ${pass} passed, ${fail} failed ===`)
process.exit(fail > 0 ? 1 : 0)
