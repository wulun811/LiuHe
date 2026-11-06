// test-outline-lines-semantics.js — outline 的 lines 必须是【文件行数】，不是符号结束行
//
// 2026-11-02 DSH 实测：311 行的 kernel/scripts/pack-smoke.mjs 报 lines: 71。
// 根因（code-index.js getFileOutline）：lines = Math.max(...symbols.end_line)。
// 当时顶层 try/if/for 内的声明还不进符号索引（malong-parse 对 lexical_declaration 有 depth==1 守卫，
// 已于 R18 改为按祖先链判定），于是「最后一个符号的结束行」远小于真实行数 —— 调用方据此判断文件大小会直接读错。
import { join, dirname } from 'node:path'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  FAIL:', msg) } }
const imp = (p) => import(pathToFileURL(p).href)

const { computeOutlineLineFields } = await imp(join(__dirname, '..', 'code-index.js'))
const { INDEX_SCOPE_NOTE } = await imp(join(__dirname, '..', 'index-scope.js'))

// ── ① 最后一个符号止于 71 行、文件 311 行 ──
{
  const f = computeOutlineLineFields([{ start_line: 1, end_line: 71 }], 311)
  assert(f.lines === 311, `① lines 必须是文件行数 311（得 ${JSON.stringify(f.lines)}）`)
  assert(f.outline_end_line === 71, `① outline_end_line 单独报覆盖终点 71（得 ${JSON.stringify(f.outline_end_line)}）`)
  assert(f.outline_note && /311/.test(f.outline_note), `① 覆盖不全必须写进回执（得 ${JSON.stringify(f.outline_note)}）`)
  assert((f.outline_note || '').includes(INDEX_SCOPE_NOTE), `① 必须带共享的覆盖边界说明（得 ${JSON.stringify(f.outline_note)}）`)
  assert(!/does not exist|not implemented/i.test(f.outline_note || ''), '① 不得断言「不存在」')
}

// ── ② 全覆盖：不产生噪音字段 ──
{
  const f = computeOutlineLineFields([{ start_line: 1, end_line: 311 }], 311)
  assert(f.lines === 311 && f.outline_end_line === 311, `② 全覆盖时两值相等（得 ${JSON.stringify(f)}）`)
  assert(!f.outline_note, `② 全覆盖不得加解释噪音（得 ${JSON.stringify(f.outline_note)}）`)
}

// ── ③ 一个符号都没有：lines 仍是文件行数，且必须说明「没索引到符号」──
{
  const f = computeOutlineLineFields([], 50)
  assert(f.lines === 50, `③ 空符号也要报真实行数（得 ${JSON.stringify(f.lines)}）`)
  assert(f.outline_end_line === 0, `③ outline_end_line=0（得 ${JSON.stringify(f.outline_end_line)}）`)
  assert(f.outline_note, `③ 必须说明为什么 outline 是空的（得 ${JSON.stringify(f.outline_note)}）`)
}

// ── ④ 读不到文件（total=0）：退回符号终点，不得报 0 行 ──
{
  const f = computeOutlineLineFields([{ start_line: 1, end_line: 12 }], 0)
  assert(f.lines === 12, `④ 无文件行数时退回符号终点（得 ${JSON.stringify(f.lines)}）`)
}

// ── ⑤ 接线：真实索引里「顶层 try 包住大半文件」的脚本必须报真实行数 ──
{
  const WS = join(tmpdir(), 'opencode', 'ob-outline-lines')
  const SOCK = join(tmpdir(), 'opencode', 'ob-outline-lines.sock')
  try { rmSync(WS, { recursive: true, force: true }) } catch {}
  mkdirSync(join(WS, 'scripts'), { recursive: true })
  const src = [
    "import { readFileSync } from 'node:fs'",
    '',
    'const topLevelConst = 1',
    'function topLevelFn() { return topLevelConst }',
    '',
    'try {',
    "  const readmeText = readFileSync('README.md', 'utf8')",
    '  const sequenceStepsOf = (text) => text.split(/\\r?\\n/)',
    '  const cliSteps = sequenceStepsOf(readmeText)',
    '  console.log(cliSteps.length)',
    '} catch (error) {',
    '  console.error(error)',
    '}',
    '',
  ].join('\n')
  writeFileSync(join(WS, 'scripts', 'gate.mjs'), src)
  const expectedLines = src.split('\n').length - 1 // 末尾有换行：切分后的最后空串不算一行（此文件恰好等于 wc -l；无尾换行时会差 1）
  let ran = false
  try {
    const pc = await imp(join(__dirname, '..', 'parse-client.js'))
    await pc.init({ log: () => {} })
    await pc.connect()
    const { default: codeIndex } = await imp(join(__dirname, '..', 'code-index.js'))
    const langParser = {
      extractAllAsync: (s, e, f, ws) => pc.extractAll(s, e, f, ws),
      hasErrorsAsync: (s, e, f, ws) => pc.hasErrors(s, e, f, ws),
      batchExtractAsync: (f, ws) => pc.batchExtract(f, ws),
    }
    const services = { langParser }
    const core = {
      services,
      getService: (n) => services[n],
      registerService: (n, svc) => { services[n] = svc },
      getWorkspaceDir: () => WS,
      log: () => {},
      emit: () => {},
      get: (k, def) => (k === 'codeIndex.udsPath' ? SOCK : def),
    }
    await codeIndex.init(core)
    const svc = services.codeIndex
    await svc.initWorkspace(WS)
    await svc.indexBatch([join(WS, 'scripts', 'gate.mjs')], WS)
    const o = await svc.getFileOutline('scripts/gate.mjs', {})
    ran = true
    assert(o.lines === expectedLines, `⑤ lines 必须等于真实行数 ${expectedLines}（得 ${JSON.stringify(o.lines)}）`)
    assert(o.outline_end_line <= expectedLines, `⑤ 覆盖终点不得越过文件行数（得 ${JSON.stringify(o.outline_end_line)} / ${expectedLines}）`)
    assert(o.outline_note && o.outline_note.includes(INDEX_SCOPE_NOTE), `⑤ 覆盖不全必须带共享的覆盖边界说明（得 ${JSON.stringify(o.outline_note)}）`)
    // R18：顶层 try 内的声明现在会进索引——DSH 报的那个 sequenceStepsOf 必须真的可见
    const outlineNames = (o.outline || []).map((n) => n.name)
    assert(outlineNames.includes('sequenceStepsOf'), `⑤ 顶层 try 里的 sequenceStepsOf 必须在 outline 里（得 ${JSON.stringify(outlineNames)}）`)
    // ⑥ lines 是「真实行数」，不是 wc -l：3 行、末行无换行时 wc -l 数出 2
    writeFileSync(join(WS, 'scripts', 'no-trailing-nl.js'), 'const a = 1\nconst b = 2\nconst c = 3')
    assert(svc._countFileLines('scripts/no-trailing-nl.js') === 3, `⑥ 3 行、末行无换行 → lines=3（wc -l 会是 2，得 ${JSON.stringify(svc._countFileLines('scripts/no-trailing-nl.js'))}）`)
  } catch (e) {
    console.log(`  · ⑤ 未执行（malong-parse 不可用：${e && e.message}）`)
  } finally {
    try { rmSync(WS, { recursive: true, force: true }) } catch {}
  }
  if (!ran) console.log('  · ⑤ 接线未在本环境验证（无 Rust 解析服务）；①②③④ 已覆盖语义')
}

console.log(`== test-outline-lines-semantics: ${pass} passed, ${fail} failed ==`)
process.exit(fail > 0 ? 1 : 0)
