// tools/python-project.js — Python 项目解析器（0.5.25 新增，test_bridge / verify_pipeline 共用）
//
// 要解决的问题（实测于 docs 交付型仓）：
//   ① 工作区在项目之上时（会话工作区 = 仓库根，而 Python 项目在子目录），框架探测只看工作区根
//      → unknown_framework；
//   ② 解释器只在工作区根找 .venv → 找不到就落回系统 python3 → 依赖装在项目 venv 里时
//      ModuleNotFoundError: No module named 'xxx'。
//
// 解析顺序（先具体后笼统，先项目后工作区）：
//   ① MALONG_PYTHON 环境变量（显式指定，最高优先；不存在则忽略并继续）
//   ② scope 目标所在的项目根（向上找 pyproject.toml/pytest.ini/tox.ini/setup.cfg/setup.py）
//      —— 该项目根下的 .venv/venv/env
//   ③ 工作区根下的 .venv/venv/env（保留旧行为，兼容既有调用）
//   ④ 系统 python（兜底；结果里标 fallback_to_system=true，便于诊断「依赖装在 venv 里」）
//
// 设计约束：
//   · 纯函数、无网络、无副作用（只读文件系统）；结果对象可 JSON 序列化，便于回传诊断。
//   · 不猜「祖先里随便哪个 venv」——项目没有自己的 venv 时宁可用系统 python（并标 fallback），
//     也不随便抓一个不相干的 venv（装错依赖比没装更难查）。
import { join, dirname, resolve, extname, sep } from 'node:path'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { getPythonCmd } from '../python-cmd.js'

// Python 项目标记文件（任一存在即认为该目录是项目根）
export const PY_PROJECT_MARKERS = ['pyproject.toml', 'pytest.ini', 'tox.ini', 'setup.cfg', 'setup.py']
// 虚拟环境候选（相对项目根/工作区根）；Windows 的 venv 布局是 Scripts\python.exe
export const PY_VENV_CANDIDATES = process.platform === 'win32'
  ? [
      '.venv/Scripts/python.exe', 'venv/Scripts/python.exe', 'env/Scripts/python.exe',
      '.venv/bin/python', 'venv/bin/python', 'env/bin/python',
      '.venv/bin/python3', 'venv/bin/python3', 'env/bin/python3',
    ]
  : [
      '.venv/bin/python', 'venv/bin/python', 'env/bin/python',
      '.venv/bin/python3', 'venv/bin/python3', 'env/bin/python3',
      '.venv/Scripts/python.exe', 'venv/Scripts/python.exe', 'env/Scripts/python.exe',
    ]

// 该目录是否是 pytest 项目（沿用 test_bridge 旧口径：pyproject/setup.cfg 存在即算 pytest 项目）
export function hasPytestMarker(dir) {
  if (!dir) return false
  try {
    if (existsSync(join(dir, 'pytest.ini')) || existsSync(join(dir, 'tox.ini'))) return true
    if (existsSync(join(dir, 'pyproject.toml'))) return true
    if (existsSync(join(dir, 'setup.cfg'))) return true
  } catch {}
  return false
}

// 从 startDir 向上找项目根（最多 maxUp 层）；找不到返回 null。
// stopDir：向上查找的边界（工作区根）——不越过工作区去找「不相干的祖先项目」。
export function findPythonProjectRoot(startDir, { maxUp = 6, stopDir = null } = {}) {
  let dir = resolve(startDir)
  const stop = stopDir ? resolve(stopDir) : null
  for (let i = 0; i <= maxUp; i++) {
    for (const m of PY_PROJECT_MARKERS) {
      if (existsSync(join(dir, m))) return dir
    }
    const parent = dirname(dir)
    if (parent === dir) break
    if (stop && parent !== stop && !parent.startsWith(stop + sep)) break
    dir = parent
  }
  return null
}

// 在 dir 下找 venv 解释器（只看 dir 自身，不向上）
export function findVenvPython(dir) {
  if (!dir) return null
  for (const rel of PY_VENV_CANDIDATES) {
    const full = join(dir, rel)
    try {
      if (existsSync(full) && statSync(full).isFile()) return full
    } catch {}
  }
  return null
}

// scope 归一：scope 是文件 → 取其所在目录；是目录 → 目录本身；含通配 → 取通配前的目录部分
function scopeDirOf(scope) {
  if (typeof scope !== 'string') return ''
  // Windows 调用方可能传反斜杠路径；统一按 / 切分
  const s = scope.trim().replace(/\\/g, '/')
  if (!s || s === '.') return ''
  const noGlob = s.split(/[*?[]/)[0]
  // 带扩展名 → 文件（取所在目录）；否则 → 目录本身
  if (/\.[A-Za-z0-9_]+$/.test(noGlob)) {
    const slash = noGlob.lastIndexOf('/')
    return slash >= 0 ? noGlob.slice(0, slash) : ''
  }
  return noGlob
}

// 该解释器（venv 路径）里装了 pytest 吗？——文件探测，不起进程。
// 用途：venv 存在但没装 pytest 时给出「装错地方/没装」的直白提示，而不是让 agent 猜。
export function venvHasPytest(venvPythonPath) {
  if (!venvPythonPath) return null
  const venvRoot = resolve(venvPythonPath, '..', '..') // <venv>/bin/python or <venv>/Scripts/python.exe → <venv>
  // Windows venv: <venv>/Lib/site-packages；POSIX: <venv>/lib/pythonX.Y/site-packages
  const siteDirs = [join(venvRoot, 'Lib', 'site-packages')]
  try {
    const libDir = join(venvRoot, 'lib')
    for (const e of readdirSync(libDir, { withFileTypes: true })) {
      if (!e.isDirectory() || !e.name.startsWith('python')) continue
      siteDirs.push(join(libDir, e.name, 'site-packages'))
    }
  } catch {}
  return siteDirs.some(sp => existsSync(join(sp, '_pytest')) || existsSync(join(sp, 'pytest')))
}

// 解析 Python 项目与解释器。
// 入参：{ workspaceDir, scope }
// 出参：{ project_root, pytest_project, python, python_source, venv_found, fallback_to_system, searched, project_candidates }
export function resolvePythonProject({ workspaceDir, scope } = {}) {
  const ws = workspaceDir ? resolve(workspaceDir) : process.cwd()
  const relDir = scopeDirOf(scope)
  const scopeAbs = relDir ? resolve(ws, relDir) : ws

  // ① scope 所在项目根（若 scope 指向的是文件，取其所在目录）；向上查找不越过工作区
  const projectRoot = findPythonProjectRoot(scopeAbs, { stopDir: ws })
  const searched = []
  const candidates = []

  // 诊断用：工作区内的 Python 项目（最多下钻 2 层）——scope='.' 且没探测到项目时告诉调用方去哪儿指
  try {
    const scan = (dir, prefix, depth) => {
      if (depth > 2) return
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue
        const d = join(dir, e.name)
        const rel = prefix + e.name + '/'
        if (PY_PROJECT_MARKERS.some((m) => existsSync(join(d, m)))) candidates.push(rel)
        else scan(d, rel, depth + 1)
      }
    }
    scan(ws, '', 1)
  } catch {}

  // ①b 工作区里恰好只有一个 Python 项目子目录 → 采用它（无歧义才动作；有歧义只报告）
  const uniqueCandidate = !projectRoot && candidates.length === 1 ? join(ws, candidates[0].replace(/\/$/, '')) : null
  const effectiveRoot = projectRoot || uniqueCandidate

  // ② 项目根的 venv
  let python = null
  let pythonSource = 'system'
  let venvFound = false

  const envPython = process.env.MALONG_PYTHON
  if (envPython && existsSync(envPython)) {
    python = envPython
    pythonSource = 'env:MALONG_PYTHON'
    venvFound = true
  }

  if (!python && effectiveRoot) {
    const v = findVenvPython(effectiveRoot)
    searched.push(effectiveRoot)
    if (v) { python = v; pythonSource = 'project'; venvFound = true }
  }

  // ③ 工作区根的 venv（旧行为兜底，兼容既有调用）
  if (!python) {
    const v = findVenvPython(ws)
    searched.push(ws)
    if (v) { python = v; pythonSource = 'workspace'; venvFound = true }
  }

  // ④ 系统 python 兜底
  if (!python) {
    python = getPythonCmd()
    pythonSource = 'system'
  }

  // 诊断用：工作区内的 Python 项目（最多下钻 2 层）——scope='.' 且没探测到项目时告诉调用方去哪儿指
  // （候选扫描已在函数前段完成——这里不再重复）

  return {
    project_root: effectiveRoot,
    // 项目根是「唯一候选子目录」时也记来源，便于诊断（scope 指到哪儿、为何选它）
    project_root_source: projectRoot ? 'scope' : (uniqueCandidate ? 'unique_subdir' : null),
    pytest_project: hasPytestMarker(effectiveRoot) || hasPytestMarker(ws),
    python,
    python_source: pythonSource,
    venv_found: venvFound,
    fallback_to_system: pythonSource === 'system',
    // venv 存在但没装 pytest → false（系统 python 时为 null = 没探测）
    python_has_pytest: venvFound ? venvHasPytest(python) : null,
    searched,
    project_candidates: candidates.slice(0, 8),
  }
}

// 给命令用的解释器串（venv 路径加引号；系统命令原样）
export function pythonCommandString(resolved) {
  const p = resolved?.python
  if (!p) return getPythonCmd()
  if (resolved?.python_source === 'system') return p
  return '"' + p + '"'
}
