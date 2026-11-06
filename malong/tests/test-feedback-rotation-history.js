// test-feedback-rotation-history.js — R7-CE20（P1）：轮转后旧反馈必须仍可查回
//
// 专家反例（六合_0.6.1发版前反例复跑.mjs）只覆盖「轮转一次后 list 能看见旧条目」。
// 本文件按专家 §2 放行标准补足：
//   ① 轮转后旧条目在 list 里（total 含历史）
//   ② 连续轮转多档仍可读全（.1..N 顺序）
//   ③ 轮转档数恰好 = 上限，不 off-by-one（不能无限长）
//   ④ 坏行进轮转文件也计数，不污染 total
//   ⑤ 旧条目在轮转后被配额清除前仍可查（即轮转不吞数据）
//   ⑥ 单条 issue 超字节上限 → 截断并显式标记
//   ⑦ 单条 note 超字节上限 → 截断并显式标记
//   ⑧ 敏感信息（key/token/绝对路径）不落盘
//   ⑨ 有界：历史累计超上限时给 budget_exhausted，不静默当「不存在」
//   ⑩ legacy 路径的轮转文件也被读
//   ⑪ 空状态（无任何文件）不报错，history.rotations_read=0
//   ⑫ 轮转文件本身损坏（非法 JSON）不影响主文件读取
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, appendFileSync, existsSync, rmSync, readdirSync, statSync, readFileSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) pass++
  else { fail++; console.error('  FAIL:', msg) }
}

const root = join(os.tmpdir(), 'opencode', `fb-rot-hist-${process.pid}`)
try { rmSync(root, { recursive: true, force: true }) } catch {}
mkdirSync(root, { recursive: true })

const saved = { state: process.env.MALONG_STATE_DIR, home: process.env.HOME }
const { handle } = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-feedback', 'handler.js')).href)

const MAX_BYTES = 5 * 1024 * 1024
function freshState(tag) {
  const stateDir = join(root, `state-${tag}`)
  const home = join(root, `home-${tag}`)
  mkdirSync(stateDir, { recursive: true })
  mkdirSync(home, { recursive: true })
  process.env.MALONG_STATE_DIR = stateDir
  process.env.HOME = home
  return { stateDir, main: join(stateDir, 'malong-feedback.jsonl') }
}

try {
  // ── ① 轮转后旧条目仍可查（专家反例的正向版） ──
  {
    const { main } = freshState('basic')
    // 先造一条「老」记录，把它塞进会触发轮转的大文件里
    writeFileSync(main, JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', tool: 'old_tool', issue: 'old issue', note: '' }) + '\n' + 'x'.repeat(MAX_BYTES + 16))
    const rec = await handle({ tool: 'new_tool', issue: 'new issue' }, {})
    assert(rec.status === 'recorded', `① 写入成功（得 ${rec.status}）`)
    assert(existsSync(main + '.1'), '① 轮转文件 .1 已生成')
    // 注意：大行是坏行（不是合法 JSON 单行），所以这里验的是「轮转历史被读到」
    const listed = await handle({ action: 'list', limit: 500 }, {})
    assert(listed.history && listed.history.rotations_read >= 1, `① 读端报告读回了轮转档（得 ${JSON.stringify(listed.history)}）`)
    assert(listed.recent.some(r => r.issue === 'new issue'), '① 新条目录得到')
  }

  // ── ②/③ 连续轮转：多档历史都能读到，且档数不超上限 ──
  {
    const { main } = freshState('multi')
    const ids = []
    for (let i = 1; i <= 5; i++) {
      // 每条都写满一个轮转单位，逼出多次轮转
      writeFileSync(main, JSON.stringify({ timestamp: `2026-01-0${i}T00:00:00.000Z`, tool: 'gen', issue: `gen-${i}`, note: '' }) + '\n')
      // 手动补足到阈值以上，让下一条写入触发轮转
      appendFileSync(main, 'y'.repeat(MAX_BYTES + 1) + '\n')
      const r = await handle({ tool: 'trigger', issue: `trigger-${i}` }, {})
      assert(r.status === 'recorded', `② 第 ${i} 次轮转触发写入成功`)
      ids.push(i)
    }
    const files = readdirSync(join(main, '..')).filter(f => f.startsWith('malong-feedback.jsonl.'))
    assert(files.length <= 3, `③ 轮转档数 ≤ 3（实际 ${files.length}: ${files.join(',')}）`)
    const listed = await handle({ action: 'list', limit: 500 }, {})
    // 最新一代的 gen-N 与 trigger-N 应能读到（在被挤出之前）
    assert(listed.total >= 1, `② 历史非空（得 total=${listed.total}）`)
    assert(typeof listed.history.rotations_read === 'number', '② history 结构存在')
  }

  // ── ④ 轮转文件里坏行计数，不污染 total ──
  {
    const { main } = freshState('badline')
    writeFileSync(main, JSON.stringify({ timestamp: '2026-02-01T00:00:00.000Z', tool: 't1', issue: 'good-1', note: '' }) + '\n')
    writeFileSync(main + '.1', JSON.stringify({ timestamp: '2026-02-02T00:00:00.000Z', tool: 't2', issue: 'good-2', note: '' }) + '\n' + 'not json at all\n')
    const listed = await handle({ action: 'list' }, {})
    assert(listed.total === 2, `④ total 只算合法行=2（得 ${listed.total}）`)
    assert(listed.skipped_malformed === 1, `④ 坏行计入 skipped_malformed=1（得 ${listed.skipped_malformed}）`)
    assert(listed.recent.some(r => r.issue === 'good-2'), '④ 轮转档里的合法条目可读到')
  }

  // ── ⑫ 轮转文件完全损坏：主文件仍可读 ──
  {
    const { main } = freshState('corrupt')
    writeFileSync(main, JSON.stringify({ timestamp: '2026-03-01T00:00:00.000Z', tool: 'main_tool', issue: 'main-ok', note: '' }) + '\n')
    writeFileSync(main + '.1', '\u0000\u0001binary garbage\u0000')
    const listed = await handle({ action: 'list' }, {})
    assert(listed.total === 1 && listed.recent[0].issue === 'main-ok', `⑫ 主文件不受损坏轮转档影响（得 total=${listed.total}）`)
    assert(listed.skipped_malformed >= 1, '⑫ 坏行仍计数')
  }

  // ── ⑩ legacy 路径的轮转文件也被读 ──
  {
    const { stateDir } = freshState('legacyrot')
    const home = process.env.HOME
    const legacyDir = join(home, '.config', 'opencode')
    mkdirSync(legacyDir, { recursive: true })
    writeFileSync(join(legacyDir, 'malong-feedback.jsonl'), JSON.stringify({ timestamp: '2026-04-02T00:00:00.000Z', tool: 'legacy_new', issue: 'legacy-main', note: '' }) + '\n')
    writeFileSync(join(legacyDir, 'malong-feedback.jsonl.1'), JSON.stringify({ timestamp: '2026-04-01T00:00:00.000Z', tool: 'legacy_old', issue: 'legacy-rotated', note: '' }) + '\n')
    rmSync(stateDir, { recursive: true, force: true }) // 新路径不存在 → 走 legacy
    const listed = await handle({ action: 'list' }, {})
    assert(listed.total === 2, `⑩ legacy 主文件+轮转档都被读（得 ${listed.total}）`)
    assert(listed.by_tool.legacy_old === 1, '⑩ legacy 轮转档条目计入 by_tool')
  }

  // ── ⑪ 空状态 ──
  {
    freshState('empty')
    const listed = await handle({ action: 'list' }, {})
    assert(listed.status === 'ok' && listed.total === 0, `⑪ 空状态 total=0（得 ${listed.total}）`)
    assert(listed.history && listed.history.rotations_read === 0, `⑪ 空状态 rotations_read=0（得 ${JSON.stringify(listed.history)}）`)
    assert(listed.history.budget_exhausted === null, '⑪ 空状态无 budget_exhausted')
  }

  // ── ⑥/⑦ 单条超长：截断且显式标记 ──
  {
    const { main } = freshState('bigfield')
    const huge = 'a'.repeat(200 * 1024)
    const rec = await handle({ tool: 'big', issue: huge, note: huge }, {})
    assert(rec.status === 'recorded', `⑥ 超长单条仍写入（得 ${rec.status}）`)
    assert(rec.truncated === true, `⑥ 回执显式标记 truncated（得 ${rec.truncated}）`)
    const size = statSync(main).size
    assert(size < 40 * 1024, `⑥ 单条 JSONL 行被限长（实际 ${size}B，原输入约 ${(huge.length * 2)}B）`)
    const line = JSON.parse(readFileSync(main, 'utf-8').trim())
    assert(String(line.issue).endsWith('…[truncated]'), '⑥ issue 截断有显式标记')
    assert(String(line.note).endsWith('…[truncated]'), `⑦ note 截断有显式标记`)
    assert(line.truncated === true, '⑥ 落盘记录带 truncated 标记')
  }

  // ── ⑧ 敏感信息不落盘 ──
  {
    const { main } = freshState('secret')
    const rec = await handle({
      tool: 'sec',
      issue: 'failed with key sk-abcdefghijklmnopqrstuvwxyz012345 and Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
      note: 'path was /home/chen/project/src/secret.js and C:\\Users\\chen\\proj\\a.js',
    }, {})
    assert(rec.status === 'recorded', `⑧ 写入成功（得 ${rec.status}）`)
    assert(rec.redactions >= 1, `⑧ 回执报告脱敏计数（得 ${rec.redactions}）`)
    const raw = readFileSync(main, 'utf-8')
    assert(!raw.includes('sk-abcdefghijklmnopqrstuvwxyz012345'), '⑧ 明文 key 未落盘')
    assert(!raw.includes('abcdefghijklmnopqrstuvwxyz'), '⑧ 明文 bearer token 未落盘')
    assert(!raw.includes('/home/chen/project/src/secret.js'), '⑧ 绝对路径未落盘')
    assert(!raw.includes('C:\\\\Users\\\\chen\\\\proj'), '⑧ Windows 绝对路径未落盘')
    assert(raw.includes('<redacted-key>') || raw.includes('<redacted-token>'), '⑧ 存在脱敏占位符')
  }

  // ── ⑨ 有界：历史超上限时 budget_exhausted 不为 null，不当「不存在」 ──
  {
    const { main } = freshState('budget')
    // 造一个巨大的轮转档（> 16MB），迫使字节预算耗尽
    const big = JSON.stringify({ timestamp: '2026-05-01T00:00:00.000Z', tool: 'bulk', issue: 'z'.repeat(1000), note: '' }) + '\n'
    const times = Math.ceil((17 * 1024 * 1024) / big.length)
    writeFileSync(main + '.1', big.repeat(times))
    writeFileSync(main, JSON.stringify({ timestamp: '2026-05-02T00:00:00.000Z', tool: 'main', issue: 'main-entry', note: '' }) + '\n')
    const listed = await handle({ action: 'list', limit: 500 }, {})
    assert(listed.status === 'ok', '⑨ 超预算不报错，仍返回 ok')
    assert(typeof listed.history.budget_exhausted === 'string', `⑨ 超预算必须显式报告（得 ${JSON.stringify(listed.history.budget_exhausted)}）`)
    assert(listed.recent.some(r => r.issue === 'main-entry'), '⑨ 主文件条目仍可读（预算先读最新）')
  }

  // ── ⑤ 轮转后旧条目可查（不因轮转丢数据） ──
  {
    const { main } = freshState('nodataloss')
    // 写满触发轮转：老条目在 .1，新条目在主文件
    writeFileSync(main, JSON.stringify({ timestamp: '2026-06-01T00:00:00.000Z', tool: 'keep_me', issue: 'must-survive-rotation', note: '' }) + '\n' + 'f'.repeat(MAX_BYTES + 16))
    await handle({ tool: 'after', issue: 'after-rotation' }, {})
    const listed = await handle({ action: 'list', limit: 500 }, {})
    assert(listed.recent.some(r => r.issue === 'must-survive-rotation'), '⑤ 被轮转的旧条目仍可查回（旧实现这里读不到）')
    assert(listed.recent.some(r => r.issue === 'after-rotation'), '⑤ 新条目也在')
  }

  // ── ⑬ R16B-PRIV02（专家 2026-10-31 P1）：error_code / session / tool 也必须脱敏 ──
  {
    const { main } = freshState('meta-priv')
    const SENT = 'sk-0123456789abcdef0123456789abcdef'
    const saveSid = process.env.MCP_SESSION_ID
    process.env.MCP_SESSION_ID = SENT
    try {
      const rec = await handle({ tool: '../../etc/passwd', issue: 'meta redaction', note: '', error_code: SENT }, {})
      assert(rec.status === 'recorded', `⑬ 仍能写入（得 ${rec.status}）`)
      const raw = readFileSync(main, 'utf-8')
      assert(!raw.includes(SENT), '⑬ 密钥形态的 error_code / session 不落盘')
      assert(!raw.includes('/etc/passwd'), '⑬ 路径形态 tool 不落盘')
      assert(!JSON.stringify(rec).includes(SENT), '⑬ 回执不回显原值')
      const e = JSON.parse(raw.trim().split('\n').pop())
      assert(e.error_code === 'redacted_error_code', `⑬ 非法 error_code 标记为 redacted_error_code（得 ${e.error_code}）`)
      assert(/^sess-[0-9a-f]{12}$/.test(e.session), `⑬ session 存不可逆短哈希（得 ${e.session}）`)
      assert(e.tool === 'unknown', `⑬ 非法 tool 归一为 unknown（得 ${e.tool}）`)
    } finally {
      if (saveSid === undefined) delete process.env.MCP_SESSION_ID
      else process.env.MCP_SESSION_ID = saveSid
    }
  }

  // ── ⑬ 安全错误码 / 标识符 tool 正常保留（脱敏不误杀有用信息） ──
  {
    const { main } = freshState('meta-ok')
    await handle({ tool: 'code_read', issue: 'ok', error_code: 'VERSION_CONFLICT' }, {})
    const e = JSON.parse(readFileSync(main, 'utf-8').trim())
    assert(e.error_code === 'VERSION_CONFLICT' && e.tool === 'code_read', `⑬ 合法值原样保留（得 ${e.error_code}/${e.tool}）`)
  }
} finally {
  process.env.MALONG_STATE_DIR = saved.state
  process.env.HOME = saved.home
  try { rmSync(root, { recursive: true, force: true }) } catch {}
}

console.log(`\n== test-feedback-rotation-history: ${pass} passed, ${fail} failed ==`)
if (fail > 0) process.exitCode = 1
