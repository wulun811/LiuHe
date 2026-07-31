// test-reading-fixes.js — 验证码龙阅读四问题修复（①旧索引 ②跨语言碰撞 ③Rust路径解析 ④噪声过滤）
// 依赖：malong-parse 服务在跑（新二进制）。起真实 code-index（mock core + parse-client 做 langParser）。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MALONG_DIR = join(__dirname, '..')

let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}

const WS = '/tmp/opencode/rfix-ws'
const DATA = '/tmp/opencode/rfix-data'
const SOCK = '/tmp/opencode/rfix-code-index.sock'

// ── 准备 fixture workspace ──
rmSync(WS, { recursive: true, force: true })
rmSync(DATA, { recursive: true, force: true })
for (const d of [`${WS}/src`, `${WS}/py`, DATA]) mkdirSync(d, { recursive: true })

writeFileSync(`${WS}/src/hash.rs`, `pub fn token_to_id(token: &str) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in token.as_bytes() { hash ^= *b as u64; }
    hash
}
`)
writeFileSync(`${WS}/src/format.rs`, `pub fn read_block(data: &[u8]) -> Option<u32> {
    let n = data.len();
    Some(n as u32)
}
pub fn binary_search_index(entries: &[u64], target: u64) -> Option<usize> {
    entries.iter().position(|&x| x == target)
}
`)
writeFileSync(`${WS}/src/reader.rs`, `pub fn lookup(token: &str) -> Result<u32, String> {
    let token_id = crate::hash::token_to_id(token);
    let idx = format::binary_search_index(&[], token_id).ok_or("not found")?;
    let block = format::read_block(&[]).ok_or("bad block")?;
    Ok(block)
}
pub fn lookup_wrapper(token: &str) -> Result<u32, String> {
    lookup(token)
}
`)
writeFileSync(`${WS}/src/main.rs`, `pub fn run() {
    let r = crate::reader::lookup("python");
    let _ = r;
}
`)
// Python 跨语言同名碰撞：reg.lookup 与 Rust 的 lookup 同名
writeFileSync(`${WS}/py/registry.py`, `class Registry:
    def lookup(self, topic, value):
        return None

def use():
    reg = Registry()
    eid = reg.lookup("person", "x")
    return eid
`)

// ── ④ 提取器层：Rust 噪声不入库 ──
const pc = await import(join(MALONG_DIR, 'parse-client.js'))
await pc.init({ log: () => {} })
const connected = await pc.connect()
assert(connected, 'parse-client 连接到 malong-parse')

const readerSrc = readFileSync(`${WS}/src/reader.rs`, 'utf-8')
const extracted = await pc.extractAll(readerSrc, '.rs')
const refNames = extracted.refs.filter(r => r.type === 'call').map(r => r.name)
const lastSeg = n => n.split(/[:.]+/).pop()
const NOISE = ['Ok', 'Some', 'Err', 'None', 'into', 'ok_or', 'len', 'map', 'unwrap', 'expect', 'iter', 'collect', 'position', 'as_bytes', 'is_empty']
const leaked = refNames.filter(n => NOISE.includes(lastSeg(n)))
assert(leaked.length === 0, `④ 提取器层噪声应清零，泄漏: ${leaked.join(',')}`)
assert(refNames.some(n => lastSeg(n) === 'token_to_id'), '④/③ 真实调用 token_to_id 保留')

// ── 起真实 code-index ──
const { default: codeIndex } = await import(join(MALONG_DIR, 'code-index.js'))
const langParser = {
  extractAllAsync: (source, ext, filePath) => pc.extractAll(source, ext, filePath),
  batchExtractAsync: (files) => pc.batchExtract(files),
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
svc.initWorkspace(WS)

// 索引整个 workspace
const absFiles = ['src/hash.rs', 'src/format.rs', 'src/reader.rs', 'src/main.rs', 'py/registry.py'].map(f => join(WS, f))
await svc.indexBatch(absFiles, WS)
svc.resolveCrossFileRefs()

// ── ① getFileOutline 错误区分 + ensureIndexed 异步真索引 ──
const outline = await svc.getFileOutline('src/reader.rs')
assert(!outline.error && outline.outline?.some(s => s.name === 'lookup'), '① 已索引文件 outline 正常含 lookup')

const missing = await svc.getFileOutline('no_such_file.rs')
assert(missing.error === 'file_not_found', `① 磁盘不存在 -> file_not_found（得 ${missing.error}）`)

writeFileSync(`${WS}/src/fresh.rs`, `pub fn brand_new() -> u32 { 42 }\n`)
const freshBefore = await svc.getFileOutline('src/fresh.rs')
assert(freshBefore.error === 'not_indexed_yet', `① 磁盘存在未索引 -> not_indexed_yet（得 ${freshBefore.error}）`)

const { ensureIndexed, checkFileStaleness } = await import(join(MALONG_DIR, 'staleness.js'))
const ensured = await ensureIndexed(svc, WS, 'src/fresh.rs')
const freshAfter = await svc.getFileOutline('src/fresh.rs')
assert(ensured && !freshAfter.error, '① ensureIndexed 异步等待后真索引成功（竞态修复）')

writeFileSync(`${WS}/src/fresh2.rs`, `pub fn another() -> u32 { 1 }\n`)
const stale = await checkFileStaleness(svc, WS, 'src/fresh2.rs')
const fresh2 = await svc.getFileOutline('src/fresh2.rs')
assert(stale?.auto_indexed === true && !fresh2.error, '① checkFileStaleness 异步 auto_index 真生效')

// ── ② 跨语言分离 + 置信度 ──
const impact = await svc.getImpactAnalysis('src/reader.rs', { symbol: 'lookup', changeType: 'modify', depth: 2 })
const callerFiles = impact.callers.map(c => c.file)
const crossFiles = (impact.cross_language_matches || []).map(c => c.file)
assert(callerFiles.includes('src/main.rs'), `② 同语言调用者 main.rs 在 callers（得 ${callerFiles.join(',')}）`)
assert(callerFiles.includes('src/reader.rs'), `②/10 同文件调用者 reader.rs(lookup_wrapper) 应在 callers（得 ${callerFiles.join(',')}）`)
assert(!callerFiles.some(f => f.endsWith('.py')), `② Python 调用者不应在 callers（得 ${callerFiles.join(',')}）`)
assert(crossFiles.includes('py/registry.py'), `② Python 调用者应在 cross_language_matches（得 ${crossFiles.join(',')}）`)
assert(impact.caller_count.direct === 2, `②/10 caller_count.direct 同语言=2（main.rs + 同文件 lookup_wrapper，得 ${impact.caller_count.direct}）`)
assert(impact.cross_language_count === 1, `② cross_language_count=1（得 ${impact.cross_language_count}）`)
assert(impact.callers.every(c => c.confidence === 'high'), '② 同语言 callers 全 confidence=high')
assert(impact.risk_level === 'medium', `②/10 risk 由同语言计数 direct=2 -> medium（得 ${impact.risk_level}）`)
assert(impact.limitations.includes('cross_language_segregated'), '② limitations 标注 cross_language_segregated')

// ── ③ Rust 路径 callee 解析 ──
const calleeNames = impact.callees.map(c => c.function)
const tokenIdCallee = impact.callees.find(c => c.function === 'token_to_id')
assert(!!tokenIdCallee, `③ callee 含 token_to_id（得 ${calleeNames.join(',')}）`)
assert(tokenIdCallee?.resolved === true, '③ token_to_id resolved=true')
assert((tokenIdCallee?.callee_file || '').endsWith('hash.rs'), `③ token_to_id 解析到 hash.rs（得 ${tokenIdCallee?.callee_file}）`)
assert(impact.callees.some(c => c.function === 'binary_search_index' && (c.callee_file || '').endsWith('format.rs')), '③ binary_search_index 解析到 format.rs')
assert(impact.callees.some(c => c.function === 'read_block' && (c.callee_file || '').endsWith('format.rs')), '③ read_block 解析到 format.rs')

// ── ④ 查询期 callees 无噪声 ──
const calleeNoise = calleeNames.filter(n => NOISE.includes(n))
assert(calleeNoise.length === 0, `④ callees 无噪声（泄漏 ${calleeNoise.join(',')}）`)

await codeIndex.stop()
try { const { disconnect } = pc; await disconnect() } catch {}

console.log(`\n=== test-reading-fixes: ${pass} passed, ${fail} failed ===`)
process.exit(fail > 0 ? 1 : 0)
