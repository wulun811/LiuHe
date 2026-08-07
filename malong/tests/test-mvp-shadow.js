// test-mvp-shadow.js — 附录 F 测试手段③④：dry_run 影子比对 + 多语言 golden boundary
// 影子比对：dry_run 预测的写入后 hash == 真实写后文件 hash（一致率 100% 才切流）
// golden：py（装饰器/嵌套/类方法）/ js（class 方法/顶层函数）/ go（方法/函数）各测 full/body boundary
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const imp = (p) => import(pathToFileURL(p).href)
const MALONG_DIR = join(__dirname, '..')
const TOOLS_DIR = join(MALONG_DIR, 'tools')

let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}

const WS = join(tmpdir(), 'opencode', 'mvp-shadow-ws')
const DATA = join(tmpdir(), 'opencode', 'mvp-shadow-data')
const SOCK = join(tmpdir(), 'opencode', 'mvp-shadow.sock')

try { rmSync(WS, { recursive: true, force: true }) } catch {}
try { rmSync(DATA, { recursive: true, force: true }) } catch {}
mkdirSync(`${WS}/src`, { recursive: true })
mkdirSync(DATA, { recursive: true })

// ── 三语言 golden fixture（附录 F ⑤：每语言 golden boundary） ──
writeFileSync(`${WS}/src/golden.py`, `import logging

class AccountService:
    """Account operations."""

    @staticmethod
    def _hash(salt, value):
        return salt + value

    def login(self, username, password):
        """Login user."""
        token = self._hash(username, password)
        if not token:
            raise ValueError("empty token")
        return token

    def logout(self, session_id):
        """Logout session."""
        return session_id is not None


def top_level_helper(items):
    result = []
    for it in items:
        result.append(it * 2)
    return result
`)

writeFileSync(`${WS}/src/golden.js`, `class Cache {
  constructor(limit = 100) {
    this.limit = limit;
    this.store = new Map();
  }

  get(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }

  set(key, value) {
    this.store.set(key, value);
    return this.store.size > this.limit ? this.store.delete(this.store.keys().next().value) : true;
  }
}

function normalize(input) {
  return String(input).trim().toLowerCase();
}
`)

writeFileSync(`${WS}/src/golden.go`, `package main

type Server struct {
	port int
}

func (s *Server) Start() error {
	if s.port == 0 {
		return errClosed
	}
	return nil
}

func NewServer(port int) *Server {
	return &Server{port: port}
}
`)

const pc = await imp(join(MALONG_DIR, 'parse-client.js'))
await pc.init({ log: () => {} })
const connected = await pc.connect()
assert(connected, 'parse-client 连接 malong-parse')

const { default: codeIndex } = await imp(join(MALONG_DIR, 'code-index.js'))
const langParser = {
  extractAllAsync: (source, ext, filePath, ws) => pc.extractAll(source, ext, filePath, ws),
  hasErrorsAsync: (source, ext, filePath, ws) => pc.hasErrors(source, ext, filePath, ws),
  batchExtractAsync: (files, ws) => pc.batchExtract(files, ws),
}
const services = { langParser }
const core = {
  services,
  getService: (n) => services[n],
  registerService: (n, svc) => { services[n] = svc },
  getWorkspaceDir: () => DATA,
  log: () => {},
  emit: () => {},
  get: (key, def) => key === 'codeIndex.udsPath' ? SOCK : (key === 'codeIndex.udsToken' ? '' : def),
}
await codeIndex.init(core)
const svc = services.codeIndex
await svc.initWorkspace(WS)
await svc.indexBatch(['golden.py', 'golden.js', 'golden.go'].map(f => join(WS, 'src', f)), WS)
svc.resolveCrossFileRefs()

const { writeSymbol } = await imp(join(MALONG_DIR, 'write-runtime.js'))
const wctx = { codeIndexService: svc, getWorkspaceDir: () => DATA, langParserService: langParser }
const readHandler = (await imp(join(TOOLS_DIR, 'tool-read-symbol', 'handler.js'))).handle
const rctx = { codeIndexService: svc, getWorkspaceDir: () => DATA }

async function currentVersion(filePath) {
  const r = await readHandler({ workspace_dir: WS, locator: { file_path: filePath } }, rctx)
  return r.version
}

let dryOk = 0, dryTotal = 0

async function shadowCompare(filePath, symbolName, content, boundary = 'full', extra = {}) {
  const sym = svc.findSymbolsInFile(filePath, symbolName)[0]
  assert(!!sym, `符号可解析 ${filePath}:${symbolName}（got ${sym ? sym.stable_id : 'none'}）`)
  if (!sym) return
  const v = await currentVersion(filePath)
  const args = { workspace_dir: WS, locator: { symbol_id: sym.stable_id }, base_version: v, content, boundary }
  const dry = await writeSymbol({ ...args, dry_run: true }, wctx)
  assert(dry.success === true, `dry_run 成功 ${filePath}:${symbolName} (${boundary})（得 ${dry.error?.code}）`)
  if (!dry.success) return
  const real = await writeSymbol(args, wctx)
  assert(real.success === true, `真实写成功 ${filePath}:${symbolName} (${boundary})（得 ${real.error?.code || real.error?.conflict_type}）`)
  if (!real.success) return
  const fileHash = `sha256:${sha256File(`${WS}/${filePath}`)}`
  dryTotal++
  if (fileHash === dry.new_version?.file?.hash) dryOk++
  assert(fileHash === dry.new_version?.file?.hash, `影子比对一致 ${filePath}:${symbolName} (${boundary})`)
  // 内容存在性 + 重复写幂等已覆盖（旧测试）；这里验证写入后立刻可读（附录 D）
  const reread = await readHandler({ workspace_dir: WS, locator: { symbol_id: sym.stable_id } }, rctx)
  if (boundary === 'full') {
    assert(reread.symbol?.text === content.trimEnd(), `写后立刻可读 ${filePath}:${symbolName} (${boundary})（正文一致）`)
  } else {
    // body 模式：read 返回整个符号（签名行 + 新 body），验证新 body 在返回内
    const probe = content.trim().split('\n')[0].trim()
    assert(reread.symbol?.text?.includes(probe), `写后立刻可读 ${filePath}:${symbolName} (${boundary})（新 body 在符号内）`)
  }
  return { dry, real }
}

function sha256File(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex')
}

// ══════════════ golden：Python ══════════════
console.log('── golden: python ──')
// full boundary：登录加日志（装饰器类内方法）
await shadowCompare('src/golden.py', 'login',
  `    def login(self, username, password):
        """Login user."""
        token = self._hash(username, password)
        if not token:
            raise ValueError("empty token")
        return token
`)
// body boundary：改方法体不动签名
await shadowCompare('src/golden.py', 'login',
  `        token = self._hash(username, password)
        if not token or not username:
            raise ValueError("empty token")
        return token
`, 'body')
// 顶层函数 full
await shadowCompare('src/golden.py', 'top_level_helper',
  `def top_level_helper(items):
    result = []
    for it in items:
        result.append(it * 3)
    return result
`)

// ══════════════ golden：JavaScript ══════════════
console.log('── golden: javascript ──')
await shadowCompare('src/golden.js', 'set',
  `  set(key, value) {
    this.store.set(key, value);
    if (this.store.size > this.limit) {
      const oldest = this.store.keys().next().value;
      return this.store.delete(oldest);
    }
    return true;
  }
`)
await shadowCompare('src/golden.js', 'normalize',
  `function normalize(input) {
  return String(input).trim().toUpperCase();
}
`)
await shadowCompare('src/golden.js', 'set',
  `    this.store.set(key, value);
    if (this.store.size > this.limit) {
      const oldest = this.store.keys().next().value;
      this.store.delete(oldest);
      return false;
    }
    return true;
`, 'body')

// ══════════════ golden：Go ══════════════
console.log('── golden: go ──')
await shadowCompare('src/golden.go', 'Start',
  `func (s *Server) Start() error {
	if s.port == 0 {
		return errClosed
	}
	if s.port < 1024 {
		return errReserved
	}
	return nil
}
`)
await shadowCompare('src/golden.go', 'NewServer',
  `func NewServer(port int) *Server {
	if port <= 0 {
		return nil
	}
	return &Server{port: port}
}
`)
await shadowCompare('src/golden.go', 'Start',
  `	if s.port == 0 {
		return errClosed
	}
	if s.port < 1024 {
		return errReserved
	}
	return nil
`, 'body')

// ══════════════ 影子比对一致率 ══════════════
const rate = dryTotal ? (dryOk / dryTotal) * 100 : 0
assert(rate === 100, `dry_run vs 真实写 diff 一致率 100%（${dryOk}/${dryTotal}）`)

// ══════════════ 冲突恢复（附录 F：next_action 重读 → 重写成功） ══════════════
console.log('── 冲突恢复 ──')
const recSym = svc.findSymbolsInFile('src/golden.js', 'normalize')[0]
const staleVersion = await currentVersion('src/golden.js')
// 外部改文件（模拟另一写者）
const recFile = `${WS}/src/golden.js`
const curJs = readFileSync(recFile, 'utf-8')
writeFileSync(recFile, curJs.replace('String(input).trim().toUpperCase()', 'String(input).trim().toUpperCase(); // touched'))
// 旧 base 写 → 冲突
const recConflict = await writeSymbol({ workspace_dir: WS, locator: { symbol_id: recSym.stable_id }, base_version: staleVersion, content: `function normalize(input) {\n  return String(input).trim().toUpperCase();\n}\n` }, wctx)
assert(recConflict.success === false, `冲突被拒（得 ${recConflict.error?.conflict_type}）`)
assert(!!recConflict.error?.next_action?.tool && recConflict.error?.next_action?.params?.locator, `冲突响应带 next_action（${recConflict.error?.next_action?.tool}）`)
// 按 next_action 重读（模拟 LLM 恢复流程）
const reRead = await readHandler({ workspace_dir: WS, locator: recConflict.error.next_action.params.locator }, rctx)
assert(reRead.symbol?.text?.includes('touched'), `重读拿到最新正文（含外部改动）`)
const recRetry = await writeSymbol({ workspace_dir: WS, locator: { symbol_id: recSym.stable_id }, base_version: reRead.version, content: `function normalize(input) {\n  return String(input).trim().toUpperCase();\n}\n` }, wctx)
assert(recRetry.success === true, `重读后重写成功（冲突恢复闭环，得 ${recRetry.error?.conflict_type}）`)

console.log(`\n=== test-mvp-shadow: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
