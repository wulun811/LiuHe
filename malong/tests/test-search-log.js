// test-search-log.js — 检索 MISS 本地日志（P3）：开关、归一、白名单、轮转、只读口径
//
// 这个测试守的是「日志会不会骗人」，不是「日志能不能写」：
//   · off 时连文件都不建（否则「空日志」会被读成「没有 MISS」）
//   · 未知取值回落 off（默认拒绝，不猜）
//   · 记录只含白名单字段，且不含绝对路径
//   · 查询词归一（控制符/换行折叠、200 字截断）——否则一行 JSON 会被换行撕成两行
//   · 写失败不抛错（调用方是工具 handler，日志不得改变工具结果）
//   · 读取只有一份口径（readSearchMisses），轮转档一起读、坏行计数
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = mkdtempSync(join(tmpdir(), 'malong-search-log-'))
process.env.MALONG_STATE_DIR = join(ROOT, 'state')

const {
  getSearchLogMode, logSearchMiss, readSearchMisses, searchLogStats, searchLogPath,
  normalizeLoggedQuery, workspaceFingerprint, SEARCH_LOG_FILE,
} = await import('../search-log.js')

let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.log('  FAIL: ' + msg) }
}
function setMode(v) {
  if (v == null) delete process.env.MALONG_SEARCH_LOG
  else process.env.MALONG_SEARCH_LOG = v
}
function logPath() { return join(process.env.MALONG_STATE_DIR, 'trace', SEARCH_LOG_FILE) }
function lines() {
  const p = logPath()
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8').split('\n').filter(Boolean)
}

// ① 默认 off：不落盘、不建目录
setMode(null)
{
  assert(getSearchLogMode() === 'off', '① 未设环境变量 → off（得 ' + getSearchLogMode() + '）')
  const r = logSearchMiss({ query: '回滚时怎么做', codeHits: 0 })
  assert(r.written === false && r.reason === 'disabled', '① off 时 written=false/disabled（得 ' + JSON.stringify(r) + '）')
  assert(!existsSync(logPath()), '① off 时不得创建日志文件（得已存在）')
  const stats = searchLogStats()
  assert(stats.enabled === false && stats.files === 0, '① stats 报告未采集（得 ' + JSON.stringify({ e: stats.enabled, f: stats.files }) + '）')
  assert(/does NOT mean/.test(stats.note), '① off 的 note 必须说清「空日志≠没有 MISS」（得 ' + stats.note + '）')
}

// ② 未知取值回落 off（默认拒绝，不猜）
{
  for (const bad of ['1', 'on', 'yes', 'true', 'all', 'miss']) {
    setMode(bad)
    assert(getSearchLogMode() === 'off', '② 未知取值「' + bad + '」必须回落 off（得 ' + getSearchLogMode() + '）')
  }
  // 大小写/首尾空白是同一个值，容错归一（不当成未知值）
  setMode('MISSES ')
  assert(getSearchLogMode() === 'misses', '② 大小写与首尾空白归一后等于 misses（得 ' + getSearchLogMode() + '）')
  setMode('misses')
  assert(getSearchLogMode() === 'misses', '② 合法取值 misses 生效')
  setMode(null)
}

// ③ 写一条：字段白名单 + 查询词归一
setMode('misses')
{
  const r = logSearchMiss({
    entry: 'code_search', reason: 'weak_docs_only',
    query: '  回滚\n时\t怎么 判断\u0000  ', codeHits: 0, partialHits: 0,
    docHits: 3, docWeak: 3, expandedHits: 1, searchTerms: 2,
    workspaceDir: ROOT,
  })
  assert(r.written === true, '③ misses 时写入成功（得 ' + JSON.stringify(r) + '）')
  const ls = lines()
  assert(ls.length === 1, '③ 只写一行（得 ' + ls.length + '）')
  const rec = JSON.parse(ls[0])
  assert(rec.query === '回滚 时 怎么 判断', '③ 控制符/换行折叠为单空格（得 ' + JSON.stringify(rec.query) + '）')
  assert(rec.query_chars === 10, '③ query_chars 记归一后字数（得 ' + rec.query_chars + '）')
  assert(rec.reason === 'weak_docs_only', '③ reason 透传（得 ' + rec.reason + '）')
  assert(rec.entry === 'code_search', '③ entry 透传（得 ' + rec.entry + '）')
  assert(rec.has_ascii === false, '③ 纯中文 has_ascii=false（得 ' + rec.has_ascii + '）')
  assert(rec.doc_hits === 3 && rec.doc_weak === 3 && rec.expanded_hits === 1 && rec.search_terms === 2, '③ 计数透传（得 ' + JSON.stringify([rec.doc_hits, rec.doc_weak, rec.expanded_hits, rec.search_terms]) + '）')
  const allowed = ['v', 'ts', 'entry', 'reason', 'query', 'query_chars', 'has_ascii', 'code_hits', 'partial_hits', 'doc_hits', 'doc_weak', 'expanded_hits', 'search_terms', 'workspace']
  const extra = Object.keys(rec).filter(k => !allowed.includes(k))
  assert(extra.length === 0, '③ 不得有白名单外字段（多出：' + extra.join(',') + '）')
  assert(!/[\\/]/.test(rec.workspace), '③ workspace 只存指纹，不得含路径分隔符（得 ' + rec.workspace + '）')
  assert(!JSON.stringify(rec).includes(ROOT), '③ 整条记录不得含绝对路径（得 ' + JSON.stringify(rec) + '）')
}

// ④ 查询词超长截断（防单行撑爆）
{
  const long = '回'.repeat(300)
  const r = logSearchMiss({ entry: 'code_task', reason: 'zero_hit', query: long })
  assert(r.written === true, '④ 超长查询仍写入')
  const rec = JSON.parse(lines().slice(-1)[0])
  assert(rec.query.length === 200, '④ query 截到 200 字（得 ' + rec.query.length + '）')
  assert(rec.query_chars === 300, '④ query_chars 保留归一前长度（得 ' + rec.query_chars + '）')
}

// ⑤ 空查询不写（否则会积一堆无意义行）
{
  const before = lines().length
  const r1 = logSearchMiss({ query: '   ' })
  const r2 = logSearchMiss({ query: '\n\t' })
  assert(r1.written === false && r1.reason === 'empty_query', '⑤ 空白查询不写（得 ' + JSON.stringify(r1) + '）')
  assert(r2.written === false, '⑤ 控制符查询归一后为空也不写')
  assert(lines().length === before, '⑤ 不写时行数不变（得 ' + lines().length + ' vs ' + before + '）')
}

// ⑥ has_ascii：混排必须能区分（P3 聚类要用它分「有标识符」与「纯中文」）
{
  logSearchMiss({ query: 'external_change 怎么用' })
  const a = JSON.parse(lines().slice(-1)[0])
  assert(a.has_ascii === true, '⑥ 含 ASCII 标识符 → true（得 ' + a.has_ascii + '）')
  logSearchMiss({ query: '回滚时怎么判断' })
  const b = JSON.parse(lines().slice(-1)[0])
  assert(b.has_ascii === false, '⑥ 纯中文 → false（得 ' + b.has_ascii + '）')
}

// ⑦ 归一函数是纯函数（同样输入同结果，不依赖时间/环境）
{
  const a = normalizeLoggedQuery('  a\n\nb\t c ')
  const b = normalizeLoggedQuery('  a\n\nb\t c ')
  assert(a.text === 'a b c', '⑦ 归一结果（得 ' + JSON.stringify(a.text) + '）')
  assert(JSON.stringify(a) === JSON.stringify(b), '⑦ 归一可重复（得 ' + JSON.stringify(a) + ' vs ' + JSON.stringify(b) + '）')
  assert(workspaceFingerprint(ROOT) === workspaceFingerprint(ROOT + '/'), '⑦ 同一目录（带尾斜杠）指纹一致')
  assert(workspaceFingerprint(ROOT) !== workspaceFingerprint(ROOT + '/other'), '⑦ 不同目录指纹不同')
}

// ⑧ 读取：顺序、limit 取最新、时间窗过滤
{
  const { total, entries } = readSearchMisses({ limit: 2 })
  assert(total >= 4, '⑧ total 统计全部条目（得 ' + total + '）')
  assert(entries.length === 2, '⑧ limit 生效（得 ' + entries.length + '）')
  const all = readSearchMisses({ limit: 0 }).entries
  assert(all.length === total, '⑧ limit=0 表示全量（得 ' + all.length + ' vs ' + total + '）')
  assert(all[all.length - 1].query === '回滚时怎么判断', '⑧ 顺序为最旧→最新（末条得 ' + all[all.length - 1].query + '）')
  const future = Date.now() + 60 * 60 * 1000
  const r = readSearchMisses({ sinceMs: future })
  assert(r.total === 0, '⑧ 时间窗过滤生效（得 ' + r.total + '）')
  const past = readSearchMisses({ sinceMs: Date.now() - 60 * 60 * 1000 })
  assert(past.total === total, '⑧ 过去一小时的时间窗包含全部（得 ' + past.total + '）')
}

// ⑨ 坏行：跳过并计数，不得让整份日志读不出来
{
  const p = logPath()
  writeFileSync(p, readFileSync(p, 'utf8') + 'not json\n{"v":1,"ts":"2026-01-01T00:00:00.000Z","query":"半行"}\n')
  const r = readSearchMisses({ limit: 0 })
  assert(r.bad_lines === 1, '⑨ 坏行计数为 1（得 ' + r.bad_lines + '）')
  assert(r.total >= 4, '⑨ 坏行不影响其余条目（得 ' + r.total + '）')
}

// ⑩ 轮转：超 1MB 后开新档，旧内容进 .1，读取两份都算
{
  const p = logPath()
  writeFileSync(p, 'x'.repeat(1024 * 1024 + 10) + '\n')
  const before = readSearchMisses({ limit: 0 }).files.length
  const r = logSearchMiss({ query: '轮转后仍要能写' })
  assert(r.written === true, '⑩ 超限后仍写入成功（得 ' + JSON.stringify(r) + '）')
  assert(existsSync(p + '.1'), '⑩ 旧文件应轮转为 .1')
  assert(statSync(p).size < 4096, '⑩ 新主文件应为空档（得 ' + statSync(p).size + 'B）')
  const after = readSearchMisses({ limit: 0 })
  assert(after.files.length >= before + 1, '⑩ 读取把轮转档算进来（得 ' + after.files.length + ' vs ' + before + '）')
  assert(after.entries.some(e => e.query === '轮转后仍要能写'), '⑩ 新写入的条目可被读出')
}

// ⑪ 写失败：不抛错、如实返回（工具结果不得因此受影响）
{
  const blocked = join(ROOT, 'blocked')
  mkdirSync(blocked, { recursive: true })
  writeFileSync(join(blocked, 'trace'), 'not a dir')
  const prev = process.env.MALONG_STATE_DIR
  process.env.MALONG_STATE_DIR = blocked
  let threw = null
  let r = null
  try { r = logSearchMiss({ query: '目录被占住' }) } catch (e) { threw = e }
  assert(threw === null, '⑪ 写失败不得抛错（抛出：' + String(threw && threw.message) + '）')
  assert(r && r.written === false && r.reason === 'write_failed', '⑪ 写失败如实返回 write_failed（得 ' + JSON.stringify(r) + '）')
  process.env.MALONG_STATE_DIR = prev
}

// ⑫ 默认值兜底：非法 reason/entry 收敛成枚举值，不写自由文本
{
  logSearchMiss({ entry: 'evil_entry', reason: 'whatever', query: '兜底检查' })
  const rec = JSON.parse(lines().slice(-1)[0])
  assert(rec.entry === 'code_search', '⑫ 非法 entry 收敛为 code_search（得 ' + rec.entry + '）')
  assert(rec.reason === 'zero_hit', '⑫ 非法 reason 收敛为 zero_hit（得 ' + rec.reason + '）')
}

// ⑬ triage --search：分类可看；未采集时必须明说「空日志≠没有 MISS」
{
  const { spawnSync } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  setMode('misses')
  logSearchMiss({ entry: 'code_search', reason: 'zero_hit', query: '中文任务为什么搜不到' })
  logSearchMiss({ entry: 'code_search', reason: 'weak_docs_only', query: 'retry helper 在哪', docHits: 2, docWeak: 2, searchTerms: 2 })
  const script = fileURLToPath(new URL('../scripts/trace-triage.mjs', import.meta.url))
  const envOn = { ...process.env, MALONG_SEARCH_LOG: 'misses' }
  const envOff = { ...process.env }
  delete envOff.MALONG_SEARCH_LOG

  const j = spawnSync(process.execPath, [script, '--search', '--json'], { env: envOn, encoding: 'utf8' })
  let parsed = null
  try { parsed = JSON.parse(j.stdout) } catch { parsed = null }
  assert(!!parsed && parsed.ok === true, '⑬ --json 输出可解析（stderr: ' + String(j.stderr).slice(0, 120) + '）')
  const sm = parsed && parsed.search_misses
  assert(!!sm && sm.collecting === true, '⑬ 采集中的日志被报告为 collecting（得 ' + JSON.stringify(sm && sm.collecting) + '）')
  assert(sm && sm.total >= 2, '⑬ 条目计数正确（得 ' + (sm && sm.total) + '）')
  assert(sm && sm.by_ascii.cjk_only >= 1 && sm.by_ascii.ascii >= 1, '⑬ 纯中文/含标识符分开计数（得 ' + JSON.stringify(sm && sm.by_ascii) + '）')
  assert(sm && sm.by_hypotheses.with_hypotheses >= 1, '⑬ 给过假设词的单独计数（得 ' + JSON.stringify(sm && sm.by_hypotheses) + '）')

  const jo = spawnSync(process.execPath, [script, '--search', '--json'], { env: envOff, encoding: 'utf8' })
  let offParsed = null
  try { offParsed = JSON.parse(jo.stdout) } catch { offParsed = null }
  assert(!!offParsed && offParsed.search_misses.collecting === false, '⑬ 未采集时 collecting=false（得 ' + JSON.stringify(offParsed && offParsed.search_misses.collecting) + '）')
  assert(!!offParsed && /does NOT mean/.test(offParsed.search_misses.note), '⑬ 未采集时 note 必须说清「空日志≠没有 MISS」（得 ' + JSON.stringify(offParsed && offParsed.search_misses.note) + '）')

  const human = spawnSync(process.execPath, [script, '--search'], { env: envOn, encoding: 'utf8' })
  assert(/检索 MISS/.test(human.stdout), '⑬ 人类可读输出含检索 MISS 段（得 ' + String(human.stdout).slice(0, 80) + '）')
  assert(/不能算命中率/.test(human.stdout), '⑬ 人类可读输出必须声明口径（得 ' + String(human.stdout).slice(-120) + '）')
}

setMode(null)
rmSync(ROOT, { recursive: true, force: true })
console.log(`== test-search-log: ${pass} passed, ${fail} failed ==`)
if (fail > 0) process.exit(1)
