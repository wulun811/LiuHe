// test-comment-search.js — F2-L1：把注释当语料的确定性检索（无 embedding）
//
// 来源：2026-10-29 自用试用。中文自然语言问句在 code_search 里恒 0 命中，
// 因为 token 化把整段中文当成一个 token 去比对符号名。但注释里真的有那些词。
//
// 本测试锁两件事（缺一不可）：
//   ① 能力：能命中（fixture 精确 + 真仓 top-3 命中率）
//   ② 诚实：覆盖率必须可见、噪声必须有界、无意义英文查询必须 0 条
//
// 只测命中率不测误报率，任何检索都会退化成「给我一堆看起来像的东西」。
import { join, dirname } from 'node:path'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const M = join(__dirname, '..')
let pass = 0, fail = 0
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  FAIL:', msg) } }

const { searchComments, queryTokens } = await import(pathToFileURL(join(M, 'comment-search.js')).href)

const WS = join(os.tmpdir(), 'opencode', 'f2-l1-cs')
try { rmSync(WS, { recursive: true, force: true }) } catch {}
mkdirSync(join(WS, 'src'), { recursive: true })
mkdirSync(join(WS, 'tests'), { recursive: true })

// ── ① fixture：精确命中正确的文件与行 ──
writeFileSync(join(WS, 'src/locker.js'), [
  '// 这行不是目标',
  '// 写入前必须核对备份镜像，防止第三方内容被吞掉',
  'export const x = 1',
].join('\n') + '\n')
writeFileSync(join(WS, 'src/other.js'), '// 完全无关的一句话\nexport const y = 2\n')
writeFileSync(join(WS, 'tests/locker.test.js'), '// 写入前必须核对备份镜像，防止第三方内容被吞掉\nexport const t = 1\n')
{
  const r = searchComments(WS, '备份镜像 第三方内容', { limit: 5 })
  assert(r.hits.length > 0, `① fixture 应命中（得 ${r.hits.length}）`)
  const prod = r.hits.filter(h => !h.file.includes('tests/'))
  assert(prod.length > 0, '① 必须有生产文件命中')
  assert(prod[0]?.file === 'src/locker.js', `① 命中正确文件（得 ${JSON.stringify(prod[0]?.file)}）`)
  assert(prod[0]?.line === 2, `① 命中正确行号（得 ${JSON.stringify(prod[0]?.line)}）`)
  // 测试路径降权：生产必须排在测试之前，但测试不隐藏
  assert(r.hits.findIndex(h => !h.file.includes('tests/')) < r.hits.findIndex(h => h.file.includes('tests/')),
    '① 生产注释必须排在测试注释之前（不隐藏）')
}

// ── ② 每条命中必须自带 matched + coverage + match_kind（不得只给裸分）──
{
  const r = searchComments(WS, '备份镜像', { limit: 5 })
  const bad = r.hits.filter(h => !Array.isArray(h.matched) || typeof h.coverage !== 'number' || h.match_kind !== 'comment_text')
  assert(bad.length === 0, `② 命中缺 matched/coverage/match_kind：${JSON.stringify(bad.map(b => b.file))}`)
  assert(r.hits.every(h => h.coverage > 0), '② coverage 不得为 0')
}

// ── ③ 准入用「区分性覆盖率」，展示用「查询覆盖率」——两者都必须达标/如实 ──
// CE18 教训：准入与展示不能用同一个被裁剪过的分母顶上，否则规则和证据一起失真。
{
  writeFileSync(join(WS, 'src/weak.js'), '// 只有备份\n// 只有镜像\n')
  const r = searchComments(WS, '备份镜像 第三方内容 完全无关的第四词 第五个词', { limit: 10 })
  const bad = r.hits.filter(h => h.corpus_coverage < 0.4)
  assert(bad.length === 0, `③ 不得返回区分性覆盖率不足的片段（得 ${JSON.stringify(bad.map(w => [w.file, w.corpus_coverage]))}）`)
  const qt = (r.query_tokens || []).length
  const wrong = r.hits.filter(h => Math.abs(h.coverage - h.matched.length / qt) > 0.01)
  assert(wrong.length === 0, `③ coverage 必须等于 matched/查询词总数 ${qt}（得 ${JSON.stringify(wrong.map(w => [w.coverage, w.matched.length]))}）`)
}

// ── ④ 确定性：同输入同输出（无随机/时间依赖）──
{
  const a = JSON.stringify(searchComments(WS, '备份镜像 第三方', { limit: 5 }).hits)
  const b = JSON.stringify(searchComments(WS, '备份镜像 第三方', { limit: 5 }).hits)
  assert(a === b, '④ 两次调用结果必须完全一致')
}

// ── ⑤ 缓存失效：文件改大后必须重新扫到新内容 ──
{
  writeFileSync(join(WS, 'src/fresh.js'), '// 旧的说明文字\n')
  const before = searchComments(WS, '缓存失效探针', { limit: 5 })
  assert(before.hits.length === 0, `⑤-a 修改前不应命中（得 ${before.hits.length}）`)
  writeFileSync(join(WS, 'src/fresh.js'), '// 旧说明\n// 缓存失效探针必须重新扫到这一行注释，改大文件长度确保 mtime/size 变化\n')
  const after = searchComments(WS, '缓存失效探针', { limit: 5 })
  assert(after.hits.some(h => h.file === 'src/fresh.js'), `⑤-b 修改后必须命中（得 ${JSON.stringify(after.hits.map(h => h.file))}）`)
}

// ── ⑥ 否定：纯英文无意义查询必须 0 条（不得硬造候选）──
{
  const r = searchComments(WS, 'zzzqqqxxx nothingmatches', { limit: 5 })
  assert(r.hits.length === 0, `⑥ 无意义英文查询必须 0 命中（得 ${r.hits.length}）`)
}
// ── ⑦ 中文噪声：覆盖率必须如实（等于 matched/查询词总数），数量有界 ──
// 旧版这条断言用的是「有效词」分母——分母被裁过，于是它自己也是绿的。CE18 同一病根。
{
  const r = searchComments(WS, '这条查询完全不存在zzzqqq', { limit: 10 })
  const qt = (r.query_tokens || []).length
  const wrong = r.hits.filter(h => Math.abs(h.coverage - h.matched.length / qt) > 0.01)
  assert(wrong.length === 0, `⑦ 中文噪声覆盖率也必须如实（得 ${JSON.stringify(wrong.map(w => [w.coverage, w.matched.length, qt]))}）`)
  assert(r.hits.length <= 3, `⑦ 中文噪声必须有界（得 ${r.hits.length} 条）`)
}

// ── ⑧ 真仓基准：top-3 命中率（这是 L1 存在的理由，不达标就该删掉这个模块）──
// 相关文件用「集合」而不是单一答案——检索基准里「哪个文件算对」通常有多个正确答案，
// 写死单一文件名会把标注错误当成检索退化（实测确实发生过）。
// 同时排除本测试文件自身：它保存着查询字面量，不排除测的就是自指。
{
  const SELF = 'tests/test-comment-search.js'
  const cases = [
    ['索引过期了怎么办', ['reindex', 'symbol-search', 'staleness', 'code-index']],
    ['任务终态还能不能写', ['entry-store', 'entry-shared']],
    ['回执 三元组 hash 版本', ['receipt']],
    ['崩溃恢复 未完成的事务', ['write-journal', 'transaction-store']],
    ['提交前怎么确认文件没被别人改', ['transaction-store', 'verify-pipeline', 'write-runtime']],
    ['锁顺序 死锁 多把锁', ['transaction-store', 'write-runtime']],
  ]
  let hit = 0
  const detail = []
  for (const [q, wants] of cases) {
    const r = searchComments(M, q, { limit: 3 })
    const files = r.hits.map(h => h.file).filter(f => f !== SELF)
    const ok = files.some(f => wants.some(w => f.includes(w)))
    if (ok) hit++
    detail.push(`${ok ? 'HIT ' : 'MISS'} ${q} → ${files.join(',') || '（无）'}`)
  }
  const rate = hit / cases.length
  console.log('  [L1 基准] top-3 命中率 ' + hit + '/' + cases.length + ' = ' + rate.toFixed(2))
  for (const d of detail) console.log('    ' + d)
  // 下限 2/6：只防「彻底退化回 0 命中」。实测 3/6，余量留给注释自然变动，
  // 避免测试因为改一句注释就红（脆弱测试比没有测试更坏）。
  assert(rate >= 0.33, `⑧ 真仓 top-3 命中率不得退到 2/6 以下（得 ${hit}/${cases.length}）`)
}

// ── ⑨ queryTokens 一致性：查询与语料必须同一套切分，否则覆盖度算不准 ──
{
  const t = queryTokens('备份镜像 locks')
  assert(t.includes('备份') && t.includes('镜像'), '⑨ 中文必须切 bigram')
  assert(t.includes('locks'), '⑨ 英文必须保留整词（小写）')
}

// ── ⑩ CE18 最小反例（专家 2026-10-29 实测复现）：语料缺词不得从分母里删掉 ──
// 原实现：effective = 语料里出现过的查询词 → 缺词被删 → 只命中 1/3 也报 coverage=1.0。
// 这是「算出的数没有正确分母」，与 R3-CE17 同类：数字算出来了，但分母是裁过的。
{
  const D = join(os.tmpdir(), 'opencode', 'ce18-fixture')
  try { rmSync(D, { recursive: true, force: true }) } catch {}
  mkdirSync(D, { recursive: true })
  writeFileSync(join(D, 'alpha.js'), '// transaction consistent version guard present here\nconst x=1\n')
  writeFileSync(join(D, 'beta.js'), '// index cache freshness proof present here\n')
  const r = searchComments(D, 'transaction nebula galaxy', { limit: 5 })
  const h = r.hits.find(x => x.file === 'alpha.js')
  assert(!!h, `⑩ 已知字面词必须仍被找到（得 ${JSON.stringify(r.hits.map(x => x.file))}）`)
  if (h) {
    assert(h.coverage !== 1, `⑩ 只命中 1/3 时 coverage 不得虚报 1（得 ${h.coverage}）`)
    assert(Math.abs(h.coverage - 1 / 3) < 0.01, `⑩ coverage 必须是 1/3（得 ${h.coverage}）`)
    assert(Array.isArray(h.unmatched_query_tokens) && h.unmatched_query_tokens.includes('nebula') && h.unmatched_query_tokens.includes('galaxy'),
      `⑩ 必须报出未命中的查询词（得 ${JSON.stringify(h.unmatched_query_tokens)}）`)
  }
  try { rmSync(D, { recursive: true, force: true }) } catch {}
}

// ── ⑪ 双分母必须分开暴露，且 score 不得暗示语义相似 ──
{
  const r = searchComments(WS, '备份镜像 第三方内容', { limit: 5 })
  const h = r.hits[0]
  assert(!!h, `⑪ 需要一条命中（得 ${r.hits.length}）`)
  if (h) {
    const qt = r.query_tokens.length
    assert(Math.abs(h.coverage - h.matched.length / qt) < 0.01, `⑪ coverage 分母必须是查询词总数 ${qt}（得 ${h.coverage}）`)
    assert(typeof h.corpus_coverage === 'number', `⑪ 必须单独暴露 corpus_coverage（得 ${JSON.stringify(h.corpus_coverage)}）`)
    assert(h.match_basis === 'comment_keyword', `⑪ match_basis 必须是 comment_keyword（得 ${JSON.stringify(h.match_basis)}）`)
    assert(typeof h.score_basis === 'string' && /coverage/.test(h.score_basis) && /not semantic/i.test(h.score_basis),
      `⑪ score 语义必须标为覆盖率、并显式否认语义相似（得 ${JSON.stringify(h.score_basis)}）`)
  }
}

// ── ⑫ 语料内超高频词：可降权召回，但不得从查询覆盖率分母里消失 ──
{
  const D = join(os.tmpdir(), 'opencode', 'ce18-common')
  try { rmSync(D, { recursive: true, force: true }) } catch {}
  mkdirSync(D, { recursive: true })
  for (let i = 0; i < 5; i++) writeFileSync(join(D, `c${i}.js`), '// commonword appears everywhere in this corpus\n')
  writeFileSync(join(D, 'rare.js'), '// commonword and rareterm together here\n')
  const r = searchComments(D, 'commonword rareterm', { limit: 10 })
  assert(r.hits.length > 0, '⑫ 含稀有词的片段必须被召回')
  const rare = r.hits.find(h => h.file === 'rare.js')
  assert(!!rare, `⑫ rare.js 必须在结果里（得 ${JSON.stringify(r.hits.map(h => h.file))}）`)
  if (rare) assert(Math.abs(rare.coverage - 1) < 0.01, `⑫ 两个词都命中时 coverage 应为 1（得 ${rare.coverage}）`)
  const onlyCommon = r.hits.filter(h => h.file !== 'rare.js')
  assert(onlyCommon.every(h => Math.abs(h.coverage - 0.5) < 0.01),
    `⑫ 只命中高频词的片段若召回，coverage 必须是 1/2（得 ${JSON.stringify(onlyCommon.map(h => h.coverage))}）`)
  assert((r.query_tokens || []).length === 2, `⑫ 查询词总数必须是 2，不得因降权而变（得 ${JSON.stringify(r.query_tokens)}）`)
  try { rmSync(D, { recursive: true, force: true }) } catch {}
}

// ── ⑬ 英中混合：缺失的英文词必须留在分母里 ──
{
  const r = searchComments(WS, '备份镜像 mirrored', { limit: 5 })
  const h = r.hits[0]
  assert(!!h, '⑬ 中文部分应命中')
  if (h) {
    assert(Math.abs(h.coverage - 3 / 4) < 0.01, `⑬ 3 个中文 bigram 命中 / 4 个查询词 = 0.75（得 ${h.coverage}）`)
    assert(h.unmatched_query_tokens.includes('mirrored'), `⑬ 未命中词必须含 mirrored（得 ${JSON.stringify(h.unmatched_query_tokens)}）`)
  }
}

// ── ⑭ 超限扫描必须显式声明，不得静默只搜一部分 ──
{
  const D = join(os.tmpdir(), 'opencode', 'ce18-cap')
  try { rmSync(D, { recursive: true, force: true }) } catch {}
  mkdirSync(D, { recursive: true })
  for (let i = 0; i < 6; i++) writeFileSync(join(D, `f${i}.js`), `// cap probe marker ${i}\n`)
  const r = searchComments(D, 'cap probe marker', { limit: 5, max_files: 3 })
  assert(r.corpus && r.corpus.truncated === true, `⑭ 超限必须报 truncated（得 ${JSON.stringify(r.corpus)}）`)
  assert(r.corpus.files === 3, `⑭ 扫描文件数应被钳到 3（得 ${r.corpus.files}）`)
  try { rmSync(D, { recursive: true, force: true }) } catch {}
}

try { rmSync(WS, { recursive: true, force: true }) } catch {}
console.log(`== test-comment-search: ${pass} passed, ${fail} failed ==`)
process.exit(fail > 0 ? 1 : 0)
