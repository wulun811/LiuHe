// test-capability-catalog.js — G1 发现出口（code_query mode=capabilities/capability）
// 覆盖：44 全量枚举 / category+query 过滤 / 分页收敛 / describe 全量 schema 对账 / 未知名 typed 拒绝 / 路径注入拒绝 / 白名单与 G0 合同互锁
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
let pass = 0, fail = 0
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  FAIL:', msg) } }

const mod = await import(pathToFileURL(join(ROOT, 'workflow', 'capability-catalog.js')).href)
const { capabilityWhitelist, listCapabilities, describeCapability, CATALOG_CONTRACT_VERSION } = mod

const contract = JSON.parse(readFileSync(join(ROOT, 'contracts', 'classic-44.contract.json'), 'utf-8'))
const contractNames = contract.tools.map(t => t.name).sort()

// ── 1. 白名单与 G0 合同 set-equality ──
const wl = capabilityWhitelist()
assert(wl.size === 44, '白名单 44 项（得 ' + wl.size + '）')
assert(JSON.stringify([...wl.keys()].sort()) === JSON.stringify(contractNames), '白名单与 G0 合同 set-equality')
for (const [name, t] of wl) {
  assert(existsSync(join(ROOT, 'tools', t.dir, t.handler)), name + ': handler 文件存在')
}

// ── 2. 全量枚举（无过滤）──
const all = listCapabilities({})
assert(all.total === 44 && all.items.length === 44, 'capabilities 全量 44（得 ' + all.total + '/' + all.items.length + '）')
assert(all.next_cursor === null, '全量一页无 next_cursor')
for (const it of all.items) {
  assert(typeof it.summary === 'string' && it.summary.length > 0, it.name + ': summary 非空')
  assert(Array.isArray(it.effects) && it.effects.length > 0, it.name + ': effects 非空')
  assert(typeof it.category === 'string' && it.category.length > 0, it.name + ': category 非空')
}

// ── 3. 过滤 ──
const audit = listCapabilities({ category: 'audit' })
assert(audit.total === 11, 'category=audit 共 11（得 ' + audit.total + '）')
assert(audit.items.every(i => i.category === 'audit'), 'category 过滤无漏网')
assert(audit.items.some(i => i.name === 'security_review'), 'audit 含 security_review')
const q = listCapabilities({ query: 'symbol' })
assert(q.total >= 2 && q.items.every(i => (i.name + ' ' + i.summary).toLowerCase().includes('symbol')), 'query 子串过滤生效（得 ' + q.total + '）')
const miss = listCapabilities({ query: 'zzz_no_such_zzz' })
assert(miss.total === 0 && miss.items.length === 0 && typeof miss.note === 'string' && miss.note.length > 0, '空结果带兜底提示（防死胡同）')

// ── 4. 分页收敛 ──
let cur = 0, seen = [], pages = 0
for (;;) {
  const r = listCapabilities({ cursor: cur, limit: 7 })
  seen.push(...r.items.map(i => i.name))
  pages++
  if (r.next_cursor === null) break
  cur = r.next_cursor
  if (pages > 10) break
}
assert(pages === 7, 'limit=7 分 7 页收敛（得 ' + pages + '）')
assert(seen.length === 44 && new Set(seen).size === 44, '分页无重无漏 44')

// ── 5. describe 全量 schema 对账 + 元数据 ──
for (const name of contractNames) {
  const d = describeCapability(name)
  assert(!d.error, name + ': describe 成功（得 ' + (d.error || 'ok') + '）')
  const t = wl.get(name)
  assert(JSON.stringify(d.schema) === JSON.stringify(t.manifest.inputSchema), name + ': schema 与 manifest 逐字节一致')
  assert(d.catalog_contract_version === CATALOG_CONTRACT_VERSION, name + ': contract_version 透出')
  assert(typeof d.call_template.shortcut === 'string' && d.call_template.shortcut.length > 0, name + ': call_template 非空')
  assert(d.safety && typeof d.safety.readonly === 'boolean', name + ': safety 字段')
}
assert(describeCapability('write_symbol').safety.writes_workspace === true, 'write_symbol: safety.writes_workspace')
assert(describeCapability('read_symbol').safety.readonly === true, 'read_symbol: readonly')
assert(describeCapability('debug_runner').safety.runs_command === true, 'debug_runner: runs_command')
assert(describeCapability('git_worktree').safety.touches_git === true, 'git_worktree: touches_git')
assert(describeCapability('edit_collision_guard').safety.writes_state === true, 'R06 edit_collision_guard: safety.writes_state（state_write 效果类）')
assert(describeCapability('write_symbol').safety.via_outlet && describeCapability('write_symbol').safety.via_outlet.delegates_once === true, 'R06 via_outlet 适配器前置条件分列')
assert(describeCapability('read_symbol').safety.via_outlet && describeCapability('read_symbol').safety.via_outlet.terminal_guard === null, 'R06 只读无终态守卫声明')
assert(describeCapability('write_symbol').safety.via_outlet.terminal_guard !== null, 'R06 副作用有终态守卫声明')
const roD = describeCapability('read_outline')
assert(Array.isArray(roD.adapter.context_services) && roD.adapter.context_services.includes('getWorkspaceDir') && roD.adapter.context_services.includes('codeIndexService'), 'read_outline: adapter.context_services 抽取（getWorkspaceDir/codeIndexService）')
assert(Array.isArray(describeCapability('patch_parser').adapter.context_services), 'patch_parser: adapter 字段形状')

// ── 6. 失败路径：未知名 / 注入 / 空值 ──
const unknown = describeCapability('no_such_tool_zzz')
assert(unknown.error === 'unknown_capability', '未知名 typed 拒绝')
assert(unknown.valid_count === 44, '未知名回报有效数')
for (const bad of ['../etc/passwd', 'tools/tool-read-symbol/handler.js', '/abs/path.js', 'file:///x.js', 'Read_Symbol', 'a', 'x'.repeat(60)]) {
  const r = describeCapability(bad)
  assert(r.error === 'invalid_input', '注入/非法名拒绝: ' + JSON.stringify(bad) + '（得 ' + r.error + '）')
}
assert(describeCapability(null).error === 'missing_parameter', 'null 名 → missing_parameter')
assert(describeCapability('').error === 'missing_parameter', '空名 → missing_parameter')

// ── 7. 失败路径：list 边界输入不抛异常 ──
const bad1 = listCapabilities({ cursor: -5, limit: 0 })
assert(bad1.items.length === 44, 'cursor<0/limit=0 → 默认安全行为（全量一页）')
const bad2 = listCapabilities({ limit: 9999 })
assert(bad2.items.length === 44, 'limit 上限钳制不炸')
const bad3 = listCapabilities({ category: 123, query: {} })
assert(bad3.total === 44, '非字符串过滤参数被忽略（不炸）')

console.log('\n=== test-capability-catalog: ' + pass + ' passed, ' + fail + ' failed ===')
process.exit(fail > 0 ? 1 : 0)
