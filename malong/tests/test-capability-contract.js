// test-capability-contract.js — G0：原 classic 44 项合同（机器可读）
// 覆盖：set-equality / 唯一性 / missing / unknown / 哈希漂移 / dispatch 值证据 / test_refs / pending 带 note
// 失败路径（R22-⑲）：内存变异合同副本，必须能被 verifyContract 抓住。
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
let pass = 0, fail = 0
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  FAIL:', msg) } }

const mod = await import(pathToFileURL(join(ROOT, 'scripts', 'gen-capability-contract.mjs')).href)
const { buildContract, verifyContract, CONTRACT_PATH } = mod

// ── 1. 冻结合同存在且验证通过 ──
assert(existsSync(CONTRACT_PATH), 'contracts/classic-44.contract.json 存在')
const frozen = JSON.parse(readFileSync(CONTRACT_PATH, 'utf-8'))
const v = verifyContract(frozen)
// R04（0.5.10 审核修复）：CRLF 检出诊断——合同冻结原始字节；Windows autocrlf 检出会让 manifest/handler 哈希整体漂移（44/44→0/44）
if (!v.ok) {
  try {
    const td = join(ROOT, 'tools')
    const d = readdirSync(td).find((x) => existsSync(join(td, x, 'manifest.json')))
    const buf = d ? readFileSync(join(td, d, 'manifest.json')) : null
    if (buf && buf.includes(Buffer.from(String.fromCharCode(13) + String.fromCharCode(10)))) {
      console.error('  HINT: 检测到 CRLF 检出（当前工作区不是 LF）——本合同为逐字节冻结：')
      console.error('        git add --renormalize . 并重新检出（或全新 clone）；.gitattributes 已对 tools/*/manifest.json、tools/*/handler.js 固定 eol=lf')
    }
  } catch {}
}
assert(v.ok, '冻结合同 vs 磁盘验证通过（errors: ' + v.errors.join(' | ') + '）')

// ── 2. set-equality / 唯一性 / 确定性排序 ──
const names = frozen.tools.map(t => t.name)
assert(names.length === 44, '合同 44 项（得 ' + names.length + '）')
assert(new Set(names).size === 44, '合同 44 项无重复')
assert(JSON.stringify(names) === JSON.stringify([...names].sort()), '合同名单按名排序（确定性）')

// ── 2b. 位置表：覆盖与状态合法（G0 位置对账不得漏项）──
const POS_PATH = join(ROOT, 'contracts', 'classic-44.positions.json')
assert(existsSync(POS_PATH), 'contracts/classic-44.positions.json 存在')
const posData = JSON.parse(readFileSync(POS_PATH, 'utf-8'))
const posNames = posData.positions.map(p => p.name)
assert(posNames.length === 44 && new Set(posNames).size === 44, '位置表 44 项无重复（得 ' + posNames.length + '）')
assert(JSON.stringify([...posNames].sort()) === JSON.stringify([...names].sort()), '位置表与合同名单 set-equality')
const LEGAL = new Set(Object.keys(posData.status_legend || {}))
assert(LEGAL.size === 4, '位置状态图例 4 项（得 ' + LEGAL.size + '）')
for (const p of posData.positions) {
  assert(LEGAL.has(p.status), '位置表 ' + p.name + ': status 合法（得 ' + p.status + '）')
  assert(typeof p.entry === 'string' && p.entry.length > 0, '位置表 ' + p.name + ': entry 非空')
}

// ── 3. 确定性：两次 build 逐字节一致（无时间/无随机/无 git）──
assert(JSON.stringify(buildContract()) === JSON.stringify(buildContract()), 'buildContract 两次运行逐字节一致')

// ── 4. 每项必备字段（待判定必须显式）──
for (const t of frozen.tools) {
  assert(typeof t.manifest_sha256 === 'string' && t.manifest_sha256.startsWith('sha256:'), t.name + ': manifest_sha256 形状')
  assert(typeof t.handler_sha256 === 'string' && t.handler_sha256.startsWith('sha256:'), t.name + ': handler_sha256 形状')
  assert(Array.isArray(t.params?.required) && Array.isArray(t.params?.properties), t.name + ': 参数面结构')
  assert(Array.isArray(t.unresolved) && t.unresolved.length > 0, t.name + ': unresolved 显式非空（G0 待判定不得省略）')
  assert(typeof t.version === 'string' && t.version.length > 0, t.name + ': version 登记')
}

// ── 5. 失败路径：内存变异，不碰磁盘 ──
function expectFail(label, mutate, needle) {
  const c = JSON.parse(JSON.stringify(frozen))
  mutate(c)
  const r = verifyContract(c)
  assert(!r.ok, '失败路径[' + label + ']：应失败')
  assert(r.errors.some(e => e.includes(needle)), '失败路径[' + label + ']：错误含「' + needle + '」（得 ' + r.errors.join(' | ') + '）')
}
expectFail('empty-contract', c => { for (const k of Object.keys(c)) delete c[k] }, 'tools 为空')
expectFail('missing', c => { c.tools = c.tools.filter(t => t.name !== 'health') }, 'missing')
expectFail('duplicate', c => { c.tools.push(JSON.parse(JSON.stringify(c.tools[0]))) }, '重复')
expectFail('unknown', c => { c.tools[0] = { ...JSON.parse(JSON.stringify(c.tools[0])), name: 'zz_fake_tool' } }, 'unknown')
expectFail('manifest-drift', c => { c.tools[0].manifest_sha256 = 'sha256:' + '0'.repeat(64) }, 'manifest 漂移')
expectFail('handler-drift', c => { c.tools[0].handler_sha256 = 'sha256:' + '0'.repeat(64) }, 'handler 漂移')
expectFail('version-drift', c => { c.tools[0].version = '9.9.9' }, 'version 漂移')
expectFail('testrefs-empty', c => { c.tools[0].test_refs = [] }, '无原测试位置')
expectFail('testrefs-ghost', c => { c.tools[0].test_refs = ['tests/no-such-file.js'] }, 'test_ref 不存在')
expectFail('dispatch-declared', c => { const t = c.tools.find(x => x.action_dispatch.status === 'declared'); t.action_dispatch.values = ['__nope__'] }, '与 schema enum 不一致')
expectFail('dispatch-evidence', c => { const t = c.tools.find(x => x.action_dispatch.status === 'extracted'); t.action_dispatch.values = ['__nope__'] }, '无字面量证据')
expectFail('dispatch-pending-note', c => { c.tools[0].action_dispatch = { status: 'pending' } }, 'pending 必须带 note')
expectFail('dispatch-status', c => { c.tools[0].action_dispatch = { status: 'bogus' } }, 'status 非法')
expectFail('unresolved-missing', c => { delete c.tools[0].unresolved }, 'unresolved 必须是显式数组')
const nullChk = verifyContract(null)
assert(!nullChk.ok && nullChk.errors.some(e => e.includes('不是对象')), 'verifyContract(null) 拒绝')

console.log('\n=== test-capability-contract: ' + pass + ' passed, ' + fail + ' failed ===')
process.exit(fail > 0 ? 1 : 0)
