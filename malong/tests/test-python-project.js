// test-python-project.js — 0.5.25：Python 项目/解释器解析器（tools/python-project.js）
// 覆盖：项目根定位（scope 目录/文件/通配）/ venv 优先于工作区根 / 无 venv 落系统 python（标记 fallback）/
//       MALONG_PYTHON 覆盖 / 不越过工作区找祖先项目 / venv 有无 pytest 的探测 / test_bridge 集成（命令用对解释器）
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
let pass = 0, fail = 0
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  FAIL:', msg) } }

const py = await import(pathToFileURL(join(ROOT, 'tools', 'python-project.js')).href)
const tb = await import(pathToFileURL(join(ROOT, 'tools', 'tool-test-bridge', 'handler.js')).href)

const TMP = mkdtempSync(join(tmpdir(), 'malong-pyproj-'))
// 夹具：仓库根 ws（无标记）→ 子项目 proj（pyproject.toml + .venv）
const ws = join(TMP, 'ws')
const proj = join(ws, 'proj')
const venvBin = join(proj, '.venv', 'bin')
const sitePy = join(proj, '.venv', 'lib', 'python3.12', 'site-packages')
mkdirSync(venvBin, { recursive: true })
mkdirSync(sitePy, { recursive: true })
writeFileSync(join(proj, 'pyproject.toml'), '[project]\nname = "demo"\n')
writeFileSync(join(proj, '.venv', 'pyvenv.cfg'), 'home = /usr\n')
// 假解释器：可执行 + 指向一个假 site-packages（有 pytest）
const fakePy = join(venvBin, 'python')
writeFileSync(fakePy, '#!/bin/sh\necho ok\n')
try { chmodSync(fakePy, 0o755) } catch {}
mkdirSync(sitePy, { recursive: true })
writeFileSync(join(sitePy, '_pytest'), '')
// 项目内测试文件
mkdirSync(join(proj, 'tests'), { recursive: true })
writeFileSync(join(proj, 'tests', 'test_a.py'), 'def test_a():\n    assert True\n')

// ── 1. 项目根定位 ──
assert(py.findPythonProjectRoot(join(proj, 'tests')) === proj, 'scope 在项目子目录 → 定位到项目根')
assert(py.findPythonProjectRoot(proj) === proj, 'scope 就是项目根 → 定位到项目根')
assert(py.findPythonProjectRoot(join(ws, 'nothing')) === null, '无标记目录 → null')
{
  // 不越过工作区找祖先项目
  const outer = join(TMP, 'outer')
  mkdirSync(outer, { recursive: true })
  writeFileSync(join(outer, 'pyproject.toml'), '[project]\n')
  const inner = join(outer, 'inner')
  mkdirSync(inner, { recursive: true })
  assert(py.findPythonProjectRoot(inner, { stopDir: inner }) === null, 'stopDir 边界内无标记 → 不越过边界')
}

// ── 2. 解释器解析：项目 venv 优先于工作区根 venv ──
{
  const r = py.resolvePythonProject({ workspaceDir: ws, scope: 'proj' })
  assert(r.project_root === proj, '项目根解析正确')
  assert(r.python === fakePy, '用项目自己的 .venv 解释器（得 ' + r.python + '）')
  assert(r.python_source === 'project', '来源标记 = project')
  assert(r.fallback_to_system === false, '未落系统 python')
  assert(r.pytest_project === true, '项目是 pytest 项目')
  assert(r.python_has_pytest === true, '探测到 venv 里有 pytest')
  assert(py.pythonCommandString(r) === '"' + fakePy + '"', '命令串带引号的绝对路径')
}

// ── 2b. Windows venv 布局：Scripts/python.exe + Lib/site-packages ──
{
  const winProj = join(TMP, 'winproj')
  const winVenv = join(winProj, '.venv')
  mkdirSync(join(winVenv, 'Scripts'), { recursive: true })
  mkdirSync(join(winVenv, 'Lib', 'site-packages', 'pytest'), { recursive: true })
  writeFileSync(join(winProj, 'pyproject.toml'), '[project]\nname = "win-fixture"\n')
  const winPy = join(winVenv, 'Scripts', 'python.exe')
  writeFileSync(winPy, '')
  const rw = py.resolvePythonProject({ workspaceDir: winProj, scope: '.' })
  assert(rw.python === winPy, 'Windows venv 布局可解析（Scripts/python.exe，得 ' + rw.python + '）')
  assert(rw.python_has_pytest === true, 'Windows venv 的 Lib/site-packages 能探测到 pytest')
  assert(py.pythonCommandString(rw) === '"' + winPy + '"', 'Windows venv 命令串带引号')
}

// ── 3. scope 是文件 / 通配 ──
{
  const rFile = py.resolvePythonProject({ workspaceDir: ws, scope: 'proj/tests/test_a.py' })
  assert(rFile.project_root === proj && rFile.python === fakePy, 'scope 是 .py 文件 → 同样定位项目 venv')
  const rGlob = py.resolvePythonProject({ workspaceDir: ws, scope: 'proj/tests/test_*.py' })
  assert(rGlob.project_root === proj && rGlob.python === fakePy, 'scope 带通配 → 同样定位项目 venv')
  const rWin = py.resolvePythonProject({ workspaceDir: ws, scope: 'proj\\tests\\test_a.py' })
  assert(rWin.project_root === proj && rWin.python === fakePy, 'scope 用反斜杠 → 同样定位项目 venv')
}

// ── 4. 无 venv → 落系统 python 且标记 fallback ──
{
  const bare = join(TMP, 'bare')
  mkdirSync(bare, { recursive: true })
  writeFileSync(join(bare, 'pyproject.toml'), '[project]\n')
  const r = py.resolvePythonProject({ workspaceDir: bare, scope: '.' })
  assert(r.python_source === 'system', '无 venv → system')
  assert(r.fallback_to_system === true, '落系统 python 时标记 fallback（供诊断）')
  assert(r.python_has_pytest === null, '系统 python 不做 pytest 探测')
}

// ── 5. MALONG_PYTHON 覆盖（最高优先）──
{
  const custom = join(TMP, 'custom-python')
  writeFileSync(custom, '#!/bin/sh\n')
  const prev = process.env.MALONG_PYTHON
  process.env.MALONG_PYTHON = custom
  const r = py.resolvePythonProject({ workspaceDir: ws, scope: 'proj' })
  assert(r.python === custom && r.python_source === 'env:MALONG_PYTHON', 'MALONG_PYTHON 覆盖优先')
  if (prev === undefined) delete process.env.MALONG_PYTHON; else process.env.MALONG_PYTHON = prev
}

// ── 6. venv 存在但没装 pytest → python_has_pytest=false ──
{
  const noPy = join(TMP, 'nopy', '.venv', 'bin')
  mkdirSync(noPy, { recursive: true })
  writeFileSync(join(noPy, 'python'), '#!/bin/sh\n')
  const proj2 = join(TMP, 'nopy')
  writeFileSync(join(proj2, 'pyproject.toml'), '[project]\n')
  const r = py.resolvePythonProject({ workspaceDir: proj2, scope: '.' })
  assert(r.python_has_pytest === false, 'venv 无 pytest → false（可给「没装/装错地方」提示）')
}

// ── 7. test_bridge 集成：命令里的解释器必须是项目 venv 的 ──
{
  const r = await tb.handle({ workspace_dir: ws, action: 'run', scope: 'proj/tests/test_a.py', dry_run: true }, {})
  // 真跑会因为假解释器输出无 totals 而非 passed；这里只验证「用哪个解释器」
  const cmd = r?.command || ''
  assert(cmd.includes(fakePy), 'test_bridge 命令用项目 venv 解释器（得 ' + cmd + '）')
  assert(!/\bpython3\b/.test(cmd), '不再落回系统 python3')
  assert(r?.interpreter?.source === 'project', '结果透出 interpreter.source=project')
  assert(r?.interpreter?.python === fakePy, '结果透出 interpreter.python')
}

// ── 8. test_bridge：工作区在项目之上、scope='.' 时 → 唯一候选项目被采用 ──
{
  const r = await tb.handle({ workspace_dir: ws, action: 'run', scope: '.' }, {})
  assert(r?.framework === 'pytest', 'scope=' + "'.'" + ' 且工作区只有一个 Python 项目 → 采用它（得 ' + r?.framework + '）')
  assert(r?.interpreter?.python === fakePy, '采用的项目 venv 解释器（得 ' + r?.interpreter?.python + '）')
  assert(r?.interpreter?.source === 'project', 'interpreter.source=project')
  assert(r?.interpreter?.project_root === proj, 'interpreter.project_root 指明项目根')
}

// ── 8b. 多个候选 Python 项目 → 不猜，报 unknown_framework 并列候选 ──
{
  const ws2 = join(TMP, 'ws2')
  for (const p of ['p1', 'p2']) {
    mkdirSync(join(ws2, p), { recursive: true })
    writeFileSync(join(ws2, p, 'pyproject.toml'), '[project]\n')
  }
  const r = await tb.handle({ workspace_dir: ws2, action: 'run', scope: '.' }, {})
  assert(r?.error === 'unknown_framework', '多个 Python 项目 → unknown_framework（有歧义不猜）')
  assert(Array.isArray(r?.python_projects_in_workspace) && r.python_projects_in_workspace.length === 2, '列出全部候选项目（得 ' + JSON.stringify(r?.python_projects_in_workspace) + '）')
  assert(typeof r?.suggestion === 'string' && r.suggestion.includes('p1/'), 'suggestion 点名候选项目')
}

console.log('\n=== test-python-project: ' + pass + ' passed, ' + fail + ' failed ===')
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
process.exit(fail > 0 ? 1 : 0)
