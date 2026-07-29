import { join, dirname, basename, extname } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { ErrorCodes, makeError, validateFilePath } from '../../error-codes.js'

const IMPORT_TO_PACKAGE = {
  cv2: 'opencv-python', yaml: 'pyyaml', PIL: 'pillow',
  sklearn: 'scikit-learn', bs4: 'beautifulsoup4', dotenv: 'python-dotenv',
  jwt: 'pyjwt', attr: 'attrs', dateutil: 'python-dateutil',
  gi: 'pygobject', serial: 'pyserial', usb: 'pyusb',
  wx: 'wxpython', Crypto: 'pycryptodome', nacl: 'pynacl',
  zmq: 'pyzmq', fitz: 'pymupdf', skvideo: 'scikit-video',
  skimage: 'scikit-image', soundfile: 'soundfile',
  u2flib_server: 'python-u2flib-server', magic: 'python-magic',
  ldap: 'python-ldap', memcache: 'python-memcached',
  git: 'gitpython', jenkins: 'python-jenkins',
  ks: 'keystone', k8s: 'kubernetes',
  google: 'google-api-python-client',
  firebase_admin: 'firebase-admin',
  rest_framework: 'djangorestframework',
  corsheaders: 'django-cors-headers',
  debug_toolbar: 'django-debug-toolbar',
  extensions: 'django-extensions',
  filter: 'django-filter',
  storages: 'django-storages',
  celery: 'celery', kombu: 'kombu',
  flask: 'flask', jinja2: 'jinja2', werkzeug: 'werkzeug',
  click: 'click', itsdangerous: 'itsdangerous',
  markdown: 'markdown', markupsafe: 'markupsafe',
  numpy: 'numpy', pandas: 'pandas', scipy: 'scipy',
  matplotlib: 'matplotlib', seaborn: 'seaborn',
  torch: 'torch', tensorflow: 'tensorflow',
  transformers: 'transformers', datasets: 'datasets',
  fastapi: 'fastapi', pydantic: 'pydantic', starlette: 'starlette',
  uvicorn: 'uvicorn', gunicorn: 'gunicorn',
  requests: 'requests', httpx: 'httpx', aiohttp: 'aiohttp',
  sqlalchemy: 'sqlalchemy', alembic: 'alembic',
  redis: 'redis', pymongo: 'pymongo',
  pytest: 'pytest', mock: 'mock',
  mypy: 'mypy', black: 'black', ruff: 'ruff',
  lodash: 'lodash', axios: 'axios', react: 'react', 'react-dom': 'react-dom',
  'tree-sitter': 'tree-sitter', 'tree-sitter-javascript': 'tree-sitter-javascript',
  'tree-sitter-python': 'tree-sitter-python', 'tree-sitter-go': 'tree-sitter-go',
  'tree-sitter-rust': 'tree-sitter-rust', 'tree-sitter-typescript': 'tree-sitter-typescript',
  'better-sqlite3': 'better-sqlite3',
  vue: 'vue', angular: '@angular/core', svelte: 'svelte',
  next: 'next', nuxt: 'nuxt', express: 'express', koa: 'koa',
  webpack: 'webpack', vite: 'vite', rollup: 'rollup', esbuild: 'esbuild',
  babel: '@babel/core', eslint: 'eslint', prettier: 'prettier',
  jest: 'jest', mocha: 'mocha', chai: 'chai', vitest: 'vitest',
  typescript: 'typescript', tsx: 'tsx',
  moment: 'moment', dayjs: 'dayjs', 'date-fns': 'date-fns',
  rxjs: 'rxjs', immer: 'immer', zod: 'zod', yup: 'yup',
  prisma: '@prisma/client', drizzle: 'drizzle-orm',
  socket: 'socket.io', ws: 'ws',
  gin: 'github.com/gin-gonic/gin', echo: 'github.com/labstack/echo',
  fiber: 'github.com/gofiber/fiber', chi: 'github.com/go-chi/chi',
  gorilla: 'github.com/gorilla/mux', cobra: 'github.com/spf13/cobra',
  viper: 'github.com/spf13/viper', zap: 'go.uber.org/zap',
  logrus: 'github.com/sirupsen/logrus', gorm: 'gorm.io/gorm',
  testify: 'github.com/stretchr/testify',
  serde: 'serde', serde_json: 'serde_json', tokio: 'tokio',
  actix: 'actix-web', rocket: 'rocket', warp: 'warp',
  clap: 'clap', anyhow: 'anyhow', thiserror: 'thiserror',
  reqwest: 'reqwest', hyper: 'hyper', tonic: 'tonic',
  diesel: 'diesel', sqlx: 'sqlx', rusqlite: 'rusqlite',
}

const STDLIB_PY = new Set([
  'abc', 'aifc', 'argparse', 'array', 'ast', 'asynchat', 'asyncio', 'asyncore',
  'atexit', 'audioop', 'base64', 'bdb', 'binascii', 'binhex', 'bisect', 'builtins',
  'bz2', 'calendar', 'cgi', 'cgitb', 'chunk', 'cmath', 'cmd', 'code', 'codecs',
  'codeop', 'collections', 'colorsys', 'compileall', 'concurrent', 'configparser',
  'contextlib', 'contextvars', 'copy', 'copyreg', 'cProfile', 'crypt', 'csv',
  'ctypes', 'curses', 'dataclasses', 'datetime', 'dbm', 'decimal', 'difflib',
  'dis', 'distutils', 'doctest', 'email', 'encodings', 'enum', 'errno',
  'faulthandler', 'fcntl', 'filecmp', 'fileinput', 'fnmatch', 'formatter',
  'fractions', 'ftplib', 'functools', 'gc', 'getopt', 'getpass', 'gettext',
  'glob', 'grp', 'gzip', 'hashlib', 'heapq', 'hmac', 'html', 'http', 'idlelib',
  'imaplib', 'imghdr', 'imp', 'importlib', 'inspect', 'io', 'ipaddress',
  'itertools', 'json', 'keyword', 'lib2to3', 'linecache', 'locale', 'logging',
  'lzma', 'mailbox', 'mailcap', 'marshal', 'math', 'mimetypes', 'mmap',
  'modulefinder', 'multiprocessing', 'netrc', 'nis', 'nntplib', 'numbers',
  'operator', 'optparse', 'os', 'ossaudiodev', 'parser', 'pathlib', 'pdb',
  'pickle', 'pickletools', 'pipes', 'pkgutil', 'platform', 'plistlib', 'poplib',
  'posix', 'posixpath', 'pprint', 'profile', 'pstats', 'pty', 'pwd', 'py_compile',
  'pyclbr', 'pydoc', 'queue', 'quopri', 'random', 're', 'readline', 'reprlib',
  'resource', 'rlcompleter', 'runpy', 'sched', 'secrets', 'select', 'selectors',
  'shelve', 'shlex', 'shutil', 'signal', 'site', 'smtpd', 'smtplib', 'sndhdr',
  'socket', 'socketserver', 'spwd', 'sqlite3', 'sre_compile', 'sre_constants',
  'sre_parse', 'ssl', 'stat', 'statistics', 'string', 'stringprep', 'struct',
  'subprocess', 'sunau', 'symtable', 'sys', 'sysconfig', 'syslog', 'tabnanny',
  'tarfile', 'telnetlib', 'tempfile', 'termios', 'test', 'textwrap', 'threading',
  'time', 'timeit', 'tkinter', 'token', 'tokenize', 'tomllib', 'trace',
  'traceback', 'tracemalloc', 'tty', 'turtle', 'turtledemo', 'types', 'typing',
  'unicodedata', 'unittest', 'urllib', 'uu', 'uuid', 'venv', 'warnings', 'wave',
  'weakref', 'webbrowser', 'winreg', 'winsound', 'wsgiref', 'xdrlib', 'xml',
  'xmlrpc', 'zipapp', 'zipfile', 'zipimport', 'zlib', '_thread',
])

const STDLIB_JS = new Set([
  'assert', 'buffer', 'child_process', 'cluster', 'console', 'constants',
  'crypto', 'dgram', 'dns', 'domain', 'events', 'fs', 'http', 'http2', 'https',
  'inspector', 'module', 'net', 'os', 'path', 'perf_hooks', 'process',
  'punycode', 'querystring', 'readline', 'repl', 'stream', 'string_decoder',
  'sys', 'timers', 'tls', 'trace_events', 'tty', 'url', 'util', 'v8', 'vm',
  'wasi', 'worker_threads', 'zlib',
  'node:assert', 'node:buffer', 'node:child_process', 'node:cluster',
  'node:console', 'node:constants', 'node:crypto', 'node:dgram', 'node:dns',
  'node:domain', 'node:events', 'node:fs', 'node:http', 'node:http2',
  'node:https', 'node:inspector', 'node:module', 'node:net', 'node:os',
  'node:path', 'node:perf_hooks', 'node:process', 'node:punycode',
  'node:querystring', 'node:readline', 'node:repl', 'node:stream',
  'node:string_decoder', 'node:sys', 'node:timers', 'node:tls',
  'node:trace_events', 'node:tty', 'node:url', 'node:util', 'node:v8',
  'node:vm', 'node:wasi', 'node:worker_threads', 'node:zlib',
])

const STDLIB_GO = new Set([
  'archive', 'bufio', 'builtin', 'bytes', 'compress', 'container', 'context',
  'crypto', 'database', 'debug', 'embed', 'encoding', 'errors', 'expvar',
  'flag', 'fmt', 'go', 'hash', 'html', 'image', 'index', 'io', 'log',
  'maps', 'math', 'mime', 'net', 'os', 'path', 'plugin', 'reflect',
  'regexp', 'runtime', 'slices', 'sort', 'strconv', 'strings', 'sync',
  'syscall', 'testing', 'text', 'time', 'unicode', 'unsafe',
])

const STDLIB_RS = new Set([
  'std', 'core', 'alloc', 'proc_macro', 'test',
])

const MANIFEST_NAMES = ['pyproject.toml', 'package.json', 'requirements.txt', 'go.mod', 'Cargo.toml']

function getStdlib(ext) {
  if (ext === '.py') return STDLIB_PY
  if (['.js', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'].includes(ext)) return STDLIB_JS
  if (ext === '.go') return STDLIB_GO
  if (ext === '.rs') return STDLIB_RS
  return new Set()
}

function resolvePackage(importName, ext) {
  if (IMPORT_TO_PACKAGE[importName]) return { pkg: IMPORT_TO_PACKAGE[importName], confident: true }
  if (ext === '.go') return { pkg: importName, confident: false }
  if (ext === '.rs') return { pkg: importName, confident: false }
  return { pkg: importName.replace(/_/g, '-'), confident: false }
}

function installHint(pkg, ext) {
  if (['.js', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'].includes(ext)) return `npm install ${pkg}`
  if (ext === '.py') return `pip install ${pkg}`
  if (ext === '.go') return `go get ${pkg}`
  if (ext === '.rs') return `cargo add ${pkg}`
  return `install ${pkg}`
}

const EXT_MANIFEST_PREF = {
  '.py': ['pyproject.toml', 'requirements.txt'],
  '.js': ['package.json'], '.mjs': ['package.json'], '.cjs': ['package.json'],
  '.ts': ['package.json'], '.tsx': ['package.json'],
  '.go': ['go.mod'],
  '.rs': ['Cargo.toml'],
}

function findManifest(workspaceDir, fileRel, ext) {
  let dir = dirname(join(workspaceDir, fileRel))
  const root = workspaceDir.endsWith('/') ? workspaceDir : workspaceDir + '/'
  const preferred = EXT_MANIFEST_PREF[ext] || []
  while (dir.startsWith(root) || dir === workspaceDir) {
    const found = []
    for (const m of MANIFEST_NAMES) {
      const p = join(dir, m)
      if (existsSync(p)) found.push(p)
    }
    if (found.length > 0) {
      const pref = preferred.length ? found.find(f => preferred.includes(basename(f))) : null
      return { path: pref || found[0], multiple: found.length > 1 ? found.map(f => basename(f)) : undefined }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return { path: null }
}

function parsePyprojectToml(path, deps) {
  const content = readFileSync(path, 'utf-8')
  const lines = content.split('\n')
  let inDeps = false
  let inArray = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '[project]' || trimmed === '[tool.poetry.dependencies]' || trimmed === '[project.dependencies]') {
      inDeps = true
      continue
    }
    if (trimmed.startsWith('[') && inDeps && !inArray) { inDeps = false; continue }

    if (inDeps && trimmed.startsWith('dependencies')) {
      const inline = trimmed.match(/dependencies\s*=\s*\[(.*)\]/)
      if (inline) {
        for (const item of inline[1].split(',')) {
          const m = item.trim().match(/^["']([a-zA-Z0-9_-]+)(\[[^\]]*\])?([><=!~].*?)?["']$/)
          if (m) deps[m[1]] = { required: m[3] || '*' }
        }
        continue
      }
      if (trimmed.includes('[')) { inArray = true; continue }
    }

    if (inArray) {
      if (trimmed === ']' || trimmed === '],') { inArray = false; continue }
      const m = trimmed.match(/^["']([a-zA-Z0-9_-]+)(\[[^\]]*\])?([><=!~].*?)?["'],?$/)
      if (m) deps[m[1]] = { required: m[3] || '*' }
      continue
    }

    if (!inDeps) continue
    const m = trimmed.match(/^["']?([a-zA-Z0-9_-]+)["']?\s*=\s*(.+)$/)
    if (m && !m[1].startsWith('dependencies')) {
      deps[m[1]] = { required: m[2].trim().replace(/["',]/g, '') }
    }
  }
}

function parseRequirementsTxt(path, deps) {
  const content = readFileSync(path, 'utf-8')
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-')) continue
    const m = trimmed.match(/^([a-zA-Z0-9_-]+)\s*([><=!~].*)?$/)
    if (m) deps[m[1]] = { required: m[2]?.trim() || '*' }
  }
}

function parseGoMod(path, deps) {
  const content = readFileSync(path, 'utf-8')
  const lines = content.split('\n')
  let inRequire = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('require (')) { inRequire = true; continue }
    if (trimmed === ')' && inRequire) { inRequire = false; continue }
    if (trimmed.startsWith('require ') && !trimmed.includes('(')) {
      const m = trimmed.match(/^require\s+(\S+)\s+(\S+)/)
      if (m) deps[m[1]] = { required: m[2] }
      continue
    }
    if (inRequire) {
      const m = trimmed.match(/^(\S+)\s+(\S+)/)
      if (m && !m[1].startsWith('//')) deps[m[1]] = { required: m[2] }
    }
  }
}

function parseCargoToml(path, deps) {
  const content = readFileSync(path, 'utf-8')
  const lines = content.split('\n')
  let inDeps = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '[dependencies]' || trimmed === '[dev-dependencies]') { inDeps = true; continue }
    if (trimmed.startsWith('[') && inDeps) { inDeps = false; continue }
    if (!inDeps) continue
    const m = trimmed.match(/^([a-zA-Z0-9_-]+)\s*=\s*(.+)$/)
    if (m) {
      const val = m[2].trim()
      deps[m[1]] = { required: val.replace(/["']/g, '') }
    }
  }
}

function parseManifest(manifestPath) {
  const deps = {}
  const name = basename(manifestPath)
  const warnings = []
  try {
    if (name === 'package.json') {
      const pkg = JSON.parse(readFileSync(manifestPath, 'utf-8'))
      for (const [k, v] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
        deps[k] = { required: v }
      }
    } else if (name === 'pyproject.toml') {
      parsePyprojectToml(manifestPath, deps)
    } else if (name === 'requirements.txt') {
      parseRequirementsTxt(manifestPath, deps)
    } else if (name === 'go.mod') {
      parseGoMod(manifestPath, deps)
    } else if (name === 'Cargo.toml') {
      parseCargoToml(manifestPath, deps)
    }
  } catch (e) {
    warnings.push({ manifest: manifestPath, reason: `parse_failed: ${e.message}` })
  }
  enrichFromLock(dirname(manifestPath), deps)
  return { deps, warnings }
}

function enrichFromLock(dir, deps) {
  const lockFiles = [
    { name: 'package-lock.json', parse: (c) => { try { const l = JSON.parse(c); for (const [k, v] of Object.entries(l.packages || l.dependencies || {})) { if (deps[k.replace(/^node_modules\//, '')]) deps[k.replace(/^node_modules\//, '')].locked = v.version } } catch {} } },
    { name: 'poetry.lock', parse: (c) => { for (const m of c.matchAll(/\[\[package\]\]\s*\nname\s*=\s*"([^"]+)"\s*\nversion\s*=\s*"([^"]+)"/g)) { if (deps[m[1]]) deps[m[1]].locked = m[2] } } },
    { name: 'go.sum', parse: (c) => { for (const line of c.split('\n')) { const m = line.match(/^(\S+)\s+(\S+)/); if (m && deps[m[1]]) deps[m[1]].locked = m[2].replace('/go.mod', '') } } },
    { name: 'Cargo.lock', parse: (c) => { for (const m of c.matchAll(/\[\[package\]\]\s*\nname\s*=\s*"([^"]+)"\s*\nversion\s*=\s*"([^"]+)"/g)) { if (deps[m[1]]) deps[m[1]].locked = m[2] } } },
  ]
  for (const lf of lockFiles) {
    const p = join(dir, lf.name)
    if (existsSync(p)) { try { lf.parse(readFileSync(p, 'utf-8')) } catch {} }
  }
}

function extractImports(file, content, langParser) {
  const ext = extname(file)
  let tree
  try { tree = langParser.parse(content, ext) } catch (e) {
    return { imports: [], warnings: [{ file, reason: `parse_failed: ${e.message}` }] }
  }
  if (!tree) return { imports: [], warnings: [{ file, reason: 'unsupported_language' }] }
  const refs = langParser.extractReferences(tree, content, ext)
  const imports = refs.filter(r => r.type === 'import').map(r => {
    let mod = r.module
    if (mod.startsWith('.')) return { module: mod, raw: r.module, line: r.line, isRelative: true }
    if (ext === '.go' || ext === '.rs') {
      return { module: mod, raw: r.module, line: r.line, isRelative: false }
    }
    if (mod.startsWith('@')) {
      const parts = mod.split('/')
      mod = parts.length >= 2 ? parts[0] + '/' + parts[1] : parts[0]
    } else {
      mod = mod.split('/')[0].split('.')[0]
    }
    return { module: mod, raw: r.module, line: r.line, isRelative: false }
  })
  if (['.js', '.mjs', '.cjs', '.ts', '.tsx'].includes(ext)) {
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      for (const m of lines[i].matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        const raw = m[1]
        if (imports.some(imp => imp.raw === raw)) continue
        if (raw.startsWith('.')) { imports.push({ module: raw, raw, line: i + 1, isRelative: true }); continue }
        const mod = raw.startsWith('@') ? raw.split('/').slice(0, 2).join('/') : raw.split('/')[0]
        imports.push({ module: mod, raw, line: i + 1, isRelative: false })
      }
    }
  }
  return { imports, warnings: [] }
}

export async function handle(args, context) {
  const workspaceDir = args?.workspace_dir
  if (!workspaceDir) return makeError(ErrorCodes.INVALID_INPUT, 'workspace_dir is required')

  const file = args?.file
  if (!file) return makeError(ErrorCodes.INVALID_INPUT, 'file is required')

  const pathCheck = validateFilePath(file)
  if (pathCheck.blocked) return makeError(ErrorCodes.PATH_BLOCKED, pathCheck.detail, { file, reason: pathCheck.reason })

  const absPath = join(workspaceDir, file)
  if (!existsSync(absPath)) return makeError(ErrorCodes.FILE_NOT_FOUND, `File does not exist: ${file}`, { file, suggestion: 'check the file path, or use glob to locate it' })

  const langParser = context?.langParserService
  if (!langParser) return makeError(ErrorCodes.SERVICE_UNAVAILABLE, 'lang-parser service not available', {
    suggestion: 'This tool requires the MCP server context. Ensure malong MCP server is running.'
  })

  const content = readFileSync(absPath, 'utf-8')
  const ext = extname(file)
  const stdlib = getStdlib(ext)

  const { imports, warnings: importWarnings } = extractImports(file, content, langParser)

  const { path: manifestPath, multiple: multipleManifests } = findManifest(workspaceDir, file, ext)
  if (!manifestPath) {
    return {
      file,
      manifest: null,
      imports_checked: imports.length,
      declared_deps: 0,
      issues: [],
      dependencies_found: {},
      warnings: [...importWarnings, { reason: 'no_manifest', hint: 'no dependency manifest found; project may not declare dependencies' }],
    }
  }

  const { deps, warnings: manifestWarnings } = parseManifest(manifestPath)
  const manifestName = basename(manifestPath)
  if (multipleManifests) {
    manifestWarnings.push({ reason: 'multiple_manifests', found: multipleManifests, used: manifestName, hint: `multiple manifests in same directory; used ${manifestName} (first in priority order)` })
  }

  const issues = []
  const dependenciesFound = {}
  let stdlibSkipped = 0, relativeSkipped = 0

  for (const imp of imports) {
    if (imp.isRelative) { relativeSkipped++; continue }
    if (stdlib.has(imp.module) || stdlib.has(imp.module.split('/')[0])) { stdlibSkipped++; continue }

    const { pkg, confident } = resolvePackage(imp.module, ext)

    if (deps[pkg]) {
      dependenciesFound[imp.module] = { in_manifest: true, ...(deps[pkg].locked ? { locked: deps[pkg].locked } : {}) }
      continue
    }

    if (deps[imp.module]) {
      dependenciesFound[imp.module] = { in_manifest: true, ...(deps[imp.module].locked ? { locked: deps[imp.module].locked } : {}) }
      continue
    }

    if (!confident) {
      issues.push({ type: 'unknown_mapping', module: imp.module, line: imp.line, note: `cannot determine package for import '${imp.module}', please verify manually` })
      dependenciesFound[imp.module] = { in_manifest: false }
      continue
    }

    issues.push({
      type: 'missing_dependency',
      module: imp.module,
      package: pkg,
      line: imp.line,
      suggestion: `add ${pkg} to dependencies`,
      install_hint: installHint(pkg, ext)
    })
    dependenciesFound[imp.module] = { in_manifest: false }
  }

  return {
    file,
    manifest: manifestName,
    imports_checked: imports.length,
    stdlib_skipped: stdlibSkipped,
    relative_skipped: relativeSkipped,
    declared_deps: Object.keys(deps).length,
    issues,
    dependencies_found: dependenciesFound,
    warnings: [...importWarnings, ...manifestWarnings].length ? [...importWarnings, ...manifestWarnings] : undefined,
  }
}
