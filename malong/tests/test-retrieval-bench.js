// test-retrieval-bench.js — 批11：检索改进（词部件/共现评分/方法可见/路径命中/legacy 回放）
// + 冻结题库完整性。mock 索引，快而确定。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  FAIL:', msg) } }

const shared = await import(pathToFileURL(join(__dirname, '..', 'tools', 'entry-shared.js')).href)
const { findCandidates, wordParts } = shared

// ① wordParts：camel/snake/kebab/常量
assert(JSON.stringify(wordParts('EntityRegistry')) === '["entity","registry"]', '① camel 拆分')
assert(JSON.stringify(wordParts('entity_registry')) === '["entity","registry"]', '① snake 拆分')
assert(JSON.stringify(wordParts('MALONG_ENTRY_STATE')) === '["malong","entry","state"]', '① 常量拆分')
assert(JSON.stringify(wordParts('repo-map.js')) === '["repo","map","js"]', '① kebab/路径拆分')

const symbols = {
  'src/entity_registry.py': [
    { name: 'EntityRegistry', type: 'class', start_line: 1, end_line: 50, stable_id: 'py:entity#class' },
    { name: 'hybrid_sim', type: 'function', start_line: 52, end_line: 60, stable_id: 'py:hybrid#function' },
  ],
  'src/txn.js': [
    { name: 'TransactionStore', type: 'class', start_line: 1, end_line: 80, stable_id: 'js:txn#class' },
    { name: '_commitStaged', type: 'method', parent_id: 9, start_line: 30, end_line: 40, stable_id: 'js:txn::_commitStaged#method' },
    { name: 'applyEdits', type: 'function', start_line: 82, end_line: 95, stable_id: 'js:txn::applyEdits#function' },
  ],
  'repo-map.js': [
    { name: 'generateCompact', type: 'method', parent_id: 3, start_line: 10, end_line: 20, stable_id: 'js:repomap::generateCompact#method' },
  ],
  'src/noise.js': [
    { name: 'noop', type: 'function', start_line: 1, end_line: 2, stable_id: 'js:noise::noop#function' },
  ],
  'src/ops.js': [
    { name: 'deploy', type: 'function', start_line: 1, end_line: 5, stable_id: 'js:ops::deploy#function' },
  ],
  'src/config.js': [
    { name: 'DEPLOY', type: 'variable', start_line: 1, end_line: 1, stable_id: 'js:config::DEPLOY#variable' },
  ],
  'scratch/copy/ops.js': [
    { name: 'deploy', type: 'function', start_line: 1, end_line: 5, stable_id: 'js:scratch::deploy#function' },
  ],
  'tests/ops.test.js': [
    { name: 'deploy', type: 'function', start_line: 1, end_line: 5, stable_id: 'js:tests::deploy#function' },
  ],
  'benchmarks/bench.js': [
    { name: 'benchRun', type: 'function', start_line: 1, end_line: 3, stable_id: 'js:bench::benchRun#function' },
  ],
  'src/relocate.js': [
    { name: 'relocate', type: 'function', start_line: 1, end_line: 4, stable_id: 'js:relocate-src#function' },
  ],
  'deep/mod/ops2.js': [
    { name: 'relocate', type: 'function', start_line: 1, end_line: 4, stable_id: 'js:relocate-deep#function' },
  ],
  'plan-0.5.0/notes.js': [
    { name: 'deploy', type: 'function', start_line: 1, end_line: 5, stable_id: 'js:plan::deploy#function' },
  ],
  'dsh/bundle/server/bench-copy.js': [
    { name: 'bundleRun', type: 'function', start_line: 1, end_line: 3, stable_id: 'js:bundle::bundleRun#function' },
  ],
}
function mockIndex() {
  return {
    async findDefinitions(name, opts = {}) {
      const out = []
      for (const [file, arr] of Object.entries(symbols)) {
        for (const s of arr) {
          if (s.name !== name) continue
          if (s.parent_id != null && !opts?.includeMethods) continue
          out.push({ name, type: s.type, start_line: s.start_line, end_line: s.end_line, path: file })
        }
      }
      return out.slice(0, opts?.limit || 20)
    },
    async searchSymbols(name, { limit = 30 } = {}) {
      const out = []
      const q = String(name).toLowerCase()
      for (const [file, arr] of Object.entries(symbols)) {
        for (const s of arr) {
          if (String(s.name).toLowerCase().includes(q)) out.push({ name: s.name, type: s.type, start_line: s.start_line, end_line: s.end_line, file })
        }
      }
      return out.slice(0, limit)
    },
    findSymbolsInFile(file, name, kind) { return (symbols[file] || []).filter(s => s.name === name && (!kind || s.type === kind)) },
    async getFileOutline(file) { return { outline: (symbols[file] || []).map(s => ({ name: s.name, type: s.type, line: s.start_line, end_line: s.end_line })) } },
    async getSymbolsAtLine() { return [] },
  }
}
const svc = mockIndex()
const WS = '/tmp/fake-ws-retrieval'
const FILES = ['src/entity_registry.py', 'src/txn.js', 'repo-map.js', 'src/noise.js']

// ② 方法可见（includeMethods/子串恒开）：改进路径找到 _commitStaged；legacy 回放旧行为
{
  const terms = ['applyEdits', '_commitStaged']
  const imp = await findCandidates(svc, WS, '回滚内部实现', null, { files: FILES, search_terms: terms })
  assert(imp.some(c => c.name === '_commitStaged'), '② 改进：方法候选可见')
  const leg = await findCandidates(svc, WS, '回滚内部实现', null, { files: FILES, search_terms: terms, legacy_ranking: true })
  assert(leg.some(c => c.name === 'applyEdits'), '② legacy：applyEdits 命中')
  assert(!leg.some(c => c.name === '_commitStaged'), '② legacy：方法不可见（旧行为）')
}

// ③ 共现评分：entity+registry 双词部件命中 EntityRegistry 置顶
{
  const c = await findCandidates(svc, WS, '实体注册', null, { files: FILES, search_terms: ['entity', 'registry'] })
  assert(c.length > 0 && c[0].name === 'EntityRegistry', '③ 共现聚合置顶（得 ' + (c[0] && c[0].name) + '）')
}

// ④ 路径命中：token 词部件命中文件名 → 文件符号入选；legacy 无此行为
{
  const c = await findCandidates(svc, WS, 'repo map 生成', null, { files: FILES })
  assert(c.some(x => x.file_path === 'repo-map.js' && x.name === 'generateCompact'), '④ 路径命中候选')
  const leg = await findCandidates(svc, WS, 'repo map 生成', null, { files: FILES, legacy_ranking: true })
  assert(!leg.some(x => x.file_path === 'repo-map.js'), '④ legacy 无路径命中')
}

// ⑥ 候选元数据（12-B）：rank_reason / matched_terms / locator 带唯一 symbol_id（防 AMBIGUOUS_SYMBOL）
{
  const c = await findCandidates(svc, WS, '实体注册', null, { files: FILES, search_terms: ['EntityRegistry'] })
  const top = c.find(x => x.name === 'EntityRegistry')
  assert(top && typeof top.rank_reason === 'string' && top.rank_reason.includes('exact_name'), '⑥ rank_reason 含 exact_name（得 ' + (top && top.rank_reason) + '）')
  assert(top && Array.isArray(top.matched_terms) && top.matched_terms.includes('EntityRegistry'), '⑥ matched_terms 回执')
  assert(top && top.locator && top.locator.symbol_id === 'py:entity#class', '⑥ locator 带唯一 symbol_id（得 ' + JSON.stringify(top && top.locator) + '）')
}

// ⑦ 短泛常量降权（12-B）：函数精确名 > 变量精确名；噪声目录（scratch/）再降
{
  const c = await findCandidates(svc, WS, '部署', null, { search_terms: ['deploy'] })
  const fn = c.find(x => x.file_path === 'src/ops.js' && x.name === 'deploy')
  const varr = c.find(x => x.file_path === 'src/config.js' && x.name === 'DEPLOY')
  const noisy = c.find(x => x.file_path === 'scratch/copy/ops.js')
  assert(fn && varr && c.indexOf(fn) < c.indexOf(varr), '⑦ 函数精确名压过变量精确名（旧：变量同分靠插入序）')
  assert(fn && noisy && c.indexOf(fn) < c.indexOf(noisy), '⑦ 噪声目录降权（得 ' + (noisy && noisy.rank_reason) + '）')
  assert(noisy && noisy.rank_reason.includes('noisy_path'), '⑦ 噪声候选带 noisy_path 原因标注')
  const tpath = c.find(x => x.file_path === 'tests/ops.test.js')
  assert(fn && tpath && c.indexOf(fn) < c.indexOf(tpath), '⑦ 测试路径降权（专家：测试不默认挤占生产入口）')
  assert(tpath && tpath.rank_reason.includes('test_path'), '⑦ 测试候选带 test_path 原因标注')
}

// ⑤ 冻结题库完整性
{
  const Q = JSON.parse(readFileSync(join(__dirname, '..', 'benchmarks', 'retrieval', 'questions.json'), 'utf-8'))
  assert(Q.questions.length === 20, '⑤ 20 题')
  assert(Object.keys(Q.repos).length >= 3, '⑤ ≥3 仓')
  const ids = new Set(Q.questions.map(q => q.id))
  assert(ids.size === 20, '⑤ id 唯一')
  assert(Q.questions.every(q => q.expect && q.expect.file && q.expect.symbol), '⑤ 全部预标注 file+symbol')
}

// ⑧ 盲测集完整性（12-C）：expect.files 非空；terms 为小写概念词（无标识符形态）
{
  const B = JSON.parse(readFileSync(join(__dirname, '..', 'benchmarks', 'retrieval', 'questions-blind.json'), 'utf-8'))
  assert(B.questions.length === 15, '⑧ 盲测 15 题')
  assert(B.questions.every(q => Array.isArray(q.expect && q.expect.files) && q.expect.files.length > 0), '⑧ 全部标注 accept 文件集')
  const bad = []
  for (const q of B.questions) {
    if (!q.goal) bad.push(q.id + ':no_goal')
    for (const t of (q.search_terms || [])) {
      if (!/^[a-z][a-z0-9-]*$/.test(t)) bad.push(q.id + ':' + t + ':not_concept_word')
    }
  }
  assert(bad.length === 0, '⑧ terms 无标识符形态（得 ' + JSON.stringify(bad.slice(0, 3)) + '）')
}

// ⑨ 非生产路径（12-D）：benchmarks/ 符号候选带 benchmark_path；非 legacy 内容扫描剔除 benchmarks，legacy 保留
{
  const c = await findCandidates(svc, WS, '基准运行', null, { files: FILES, search_terms: ['benchRun'] })
  const b = c.find(x => x.file_path === 'benchmarks/bench.js')
  assert(b && b.rank_reason.includes('benchmark_path'), '⑨ benchmark 符号候选带 benchmark_path 原因（得 ' + (b && b.rank_reason) + '）')
  const dir = mkdtempSync(join(tmpdir(), 'malong-bench-'))
  mkdirSync(join(dir, 'src'), { recursive: true })
  mkdirSync(join(dir, 'benchmarks'), { recursive: true })
  writeFileSync(join(dir, 'src', 'keep.js'), '// benchmarktoken in production\n')
  writeFileSync(join(dir, 'benchmarks', 'bench-x.js'), '// benchmarktoken in bench\n')
  const files2 = ['src/keep.js', 'benchmarks/bench-x.js']
  const c2 = await findCandidates(svc, dir, '占位', null, { files: files2, search_terms: ['benchmarktoken'] })
  assert(c2.some(x => x.file_path === 'src/keep.js'), '⑨ 非 legacy：生产文件内容候选保留')
  assert(!c2.some(x => x.file_path === 'benchmarks/bench-x.js'), '⑨ 非 legacy：benchmarks 内容候选剔除')
  const c3 = await findCandidates(svc, dir, '占位', null, { files: files2, search_terms: ['benchmarktoken'], legacy_ranking: true })
  assert(c3.some(x => x.file_path === 'benchmarks/bench-x.js'), '⑨ legacy：benchmarks 内容候选保留（回放不变）')
}

// ⑩ 同名歧义（12-D）：≥2 候选精确同名 → ambiguous_name、不吃精确名加成；唯一精确名保留 exact_name
{
  const c = await findCandidates(svc, WS, '部署', null, { search_terms: ['deploy'] })
  const fn = c.find(x => x.file_path === 'src/ops.js' && x.name === 'deploy')
  assert(fn && fn.rank_reason.includes('ambiguous_name'), '⑩ 同名候选标 ambiguous_name（得 ' + (fn && fn.rank_reason) + '）')
  const ent = await findCandidates(svc, WS, '实体注册', null, { files: FILES, search_terms: ['EntityRegistry'] })
  const top = ent.find(x => x.name === 'EntityRegistry')
  assert(top && top.rank_reason.includes('exact_name') && !top.rank_reason.includes('ambiguous_name'), '⑩ 唯一精确名保留 exact_name')
}

// ⑪ 噪声目录末位分层（12-D）：scratch 候选排在所有非噪声候选之后
{
  const c = await findCandidates(svc, WS, '部署', null, { search_terms: ['deploy'] })
  const noisy = c.find(x => x.file_path === 'scratch/copy/ops.js')
  assert(noisy && c[c.length - 1] && c[c.length - 1].rank_reason && c[c.length - 1].rank_reason.includes('noisy_path'), '⑪ 噪声候选末位（得末位 ' + (c[c.length - 1] && c[c.length - 1].file_path) + '）')
}

// ⑬ 正文回退候选低于真实符号名命中（12-D）：同名 content 候选不压过函数定义
{
  const dir = mkdtempSync(join(tmpdir(), 'malong-content-'))
  mkdirSync(join(dir, 'w'), { recursive: true })
  writeFileSync(join(dir, 'w', 'ref.js'), '// relocate usage\n')
  const c = await findCandidates(svc, dir, '迁移', null, { files: ['src/relocate.js', 'w/ref.js'], search_terms: ['relocate'] })
  const fn = c.find(x => x.file_path === 'src/relocate.js' && x.name === 'relocate')
  const ct = c.find(x => x.file_path === 'w/ref.js')
  assert(fn && ct && ct.rank_reason.includes('content_hit'), '⑬ content 候选存在并标 content_hit')
  assert(fn && ct && c.indexOf(fn) < c.indexOf(ct), '⑬ 函数定义优先于同名正文回退（旧：+10 反而 content 在前）')
}

// ⑭ 计划/实验目录降权（13-D）：plan-* 候选带 noisy_path 且排在生产候选之后
{
  const c = await findCandidates(svc, WS, '部署', null, { search_terms: ['deploy'] })
  const plan = c.find(x => x.file_path === 'plan-0.5.0/notes.js')
  assert(plan && plan.rank_reason.includes('noisy_path'), '⑭ 计划目录候选带 noisy_path（得 ' + (plan && plan.rank_reason) + '）')
  const fn = c.find(x => x.file_path === 'src/ops.js' && x.name === 'deploy')
  assert(fn && plan && c.indexOf(fn) < c.indexOf(plan), '⑭ 计划目录排在生产候选之后')
}

// ⑮ 留出集完整性（13-D）：goal+terms 冻结、expect 留空（调分前不运行）
{
  const H = JSON.parse(readFileSync(join(__dirname, '..', 'benchmarks', 'retrieval', 'questions-holdout.json'), 'utf-8'))
  assert(H.questions.length === 12, '⑮ 留出 12 题（得 ' + H.questions.length + '）')
  assert(H.questions.every(q => q.goal && !q.expect), '⑮ expect 留空（冻结规则）')
  const bad = []
  for (const q of H.questions) for (const t of (q.search_terms || [])) if (!/^[a-z][a-z0-9-]*$/.test(t)) bad.push(q.id + ':' + t)
  assert(bad.length === 0, '⑮ terms 无标识符形态（得 ' + JSON.stringify(bad.slice(0, 3)) + '）')
}

// ⑮b AC22 oracle 冻结完整性（14-C）：与 holdout 同 id、accept 非空、questions_sha256 与题库一致
{
  const { createHash } = await import('node:crypto')
  const hp = join(__dirname, '..', 'benchmarks', 'retrieval', 'questions-holdout.json')
  const H2 = JSON.parse(readFileSync(hp, 'utf-8'))
  const hsha = createHash('sha256').update(readFileSync(hp)).digest('hex')
  const O = JSON.parse(readFileSync(join(__dirname, '..', 'benchmarks', 'retrieval', 'oracle-holdout.json'), 'utf-8'))
  const ids = new Set(H2.questions.map(q => q.id))
  const oids = (O.entries || []).map(e => e.id)
  assert(oids.length === 12 && oids.every(id => ids.has(id)), '⑮b oracle 12 条且与留出同 id')
  const bad = (O.entries || []).filter(e => !(e.accept && Array.isArray(e.accept.files) && e.accept.files.length && Array.isArray(e.accept.symbols) && e.accept.symbols.length && e.rationale))
  assert(bad.length === 0, '⑮b 每条 accept files+symbols 非空且有 rationale（得 ' + JSON.stringify(bad.map(e => e.id)) + '）')
  assert(String(O.questions_sha256 || '').replace(/^sha256:/, '') === hsha, '⑮b questions_sha256 与留出库一致（冻结锚；若为 CRLF 检出：.gitattributes eol=lf 未生效，需重新 checkout）')
  // ⑮c 逐字节交付契约（第三轮 Windows 复验）：题库不得含 CR——防 autocrlf 把冻结锚改写成 CRLF（不改 oracle、不做归一）
  assert(!readFileSync(hp).includes(0x0d), '⑮c holdout 题库字节契约：无 CR（gitattributes eol=lf 生效）')
}

// ⑯ 构建副本路径（13-E live 狗粮）：dsh/bundle/ 符号候选带 benchmark_path；非 legacy 内容剔除，legacy 保留
{
  const c = await findCandidates(svc, WS, '副本运行', null, { files: FILES, search_terms: ['bundleRun'] })
  const b = c.find(x => x.file_path === 'dsh/bundle/server/bench-copy.js')
  assert(b && b.rank_reason.includes('benchmark_path'), '⑯ bundle 副本符号候选带 benchmark_path 原因（得 ' + (b && b.rank_reason) + '）')
  const dir = mkdtempSync(join(tmpdir(), 'malong-bundle-'))
  mkdirSync(join(dir, 'src'), { recursive: true })
  mkdirSync(join(dir, 'dsh', 'bundle', 'server'), { recursive: true })
  writeFileSync(join(dir, 'src', 'keep2.js'), '// bundletoken in production\n')
  writeFileSync(join(dir, 'dsh', 'bundle', 'server', 'copy.js'), '// bundletoken in bundle copy\n')
  const files2 = ['src/keep2.js', 'dsh/bundle/server/copy.js']
  const c2 = await findCandidates(svc, dir, '占位', null, { files: files2, search_terms: ['bundletoken'] })
  assert(c2.some(x => x.file_path === 'src/keep2.js'), '⑯ 非 legacy：生产文件内容候选保留')
  assert(!c2.some(x => x.file_path === 'dsh/bundle/server/copy.js'), '⑯ 非 legacy：bundle 副本内容候选剔除')
  const c3 = await findCandidates(svc, dir, '占位', null, { files: files2, search_terms: ['bundletoken'], legacy_ranking: true })
  assert(c3.some(x => x.file_path === 'dsh/bundle/server/copy.js'), '⑯ legacy：bundle 副本内容候选保留（回放不变）')
}

// ⑰ 候选预算（14-A AC32）：首屏每文件至多 2 项；被挤出者保留在完整列表；legacy 原序不变
{
  const terms = ['TransactionStore', '_commitStaged', 'applyEdits', 'relocate']
  const c = await findCandidates(svc, WS, '事务回滚与迁移', null, { search_terms: terms })
  const txnHead = c.slice(0, 4).filter(x => x.file_path === 'src/txn.js').length
  assert(txnHead <= 2, '⑰ 首屏同文件 ≤2 项（得 ' + txnHead + '：' + JSON.stringify(c.slice(0, 4).map(x => x.file_path)) + '）')
  assert(new Set(c.slice(0, 4).map(x => x.file_path)).size >= 3, '⑰ 首屏覆盖 ≥3 文件（得 ' + JSON.stringify(c.slice(0, 4).map(x => x.file_path)) + '）')
  assert(c.some(x => x.name === 'applyEdits'), '⑰ 被挤出候选保留在完整列表')
  const leg = await findCandidates(svc, WS, '事务回滚与迁移', null, { search_terms: terms, legacy_ranking: true })
  assert(leg.findIndex(x => x.name === 'applyEdits') === 1, '⑰ legacy 无预算保持原序（applyEdits 第 2 位，得 ' + leg.findIndex(x => x.name === 'applyEdits') + '）')
}

console.log('== test-retrieval-bench: ' + pass + ' passed, ' + fail + ' failed ==')
if (fail > 0) process.exit(1)
