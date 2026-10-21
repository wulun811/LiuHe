// gen-capability-contract.mjs — G0：原 classic 44 项工具合同（机器可读，确定性生成）
//
// 产物：contracts/classic-44.contract.json
// 用法：
//   node scripts/gen-capability-contract.mjs           # 写盘
//   node scripts/gen-capability-contract.mjs --check   # 只验证（exit 1 = 漂移/invalid）
//
// 确定性约束（AGENTS 见性成佛校验）：无网络、无随机、无系统时间、无 git 调用；
// 全部输入 = tools/*/manifest.json 字节 + 对应 handler 源文件字节 + tests/*.js 字节。
// 排序全部显式，重复运行逐字节一致。

import { readdirSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
export const CONTRACT_PATH = join(ROOT, 'contracts', 'classic-44.contract.json')

export function sha256(buf) {
  return 'sha256:' + createHash('sha256').update(buf).digest('hex')
}

// 原 classic 44 = manifest.interface 不是 graph/diagnostic（与 tool-registry/public-catalog 同口径）
export function listClassicManifests(toolsDir = join(ROOT, 'tools')) {
  const rows = []
  for (const d of readdirSync(toolsDir).sort()) {
    const mp = join(toolsDir, d, 'manifest.json')
    if (!existsSync(mp)) continue
    const raw = readFileSync(mp)
    const manifest = JSON.parse(raw.toString('utf-8'))
    if (manifest.interface === 'graph' || manifest.interface === 'diagnostic') continue
    rows.push({ dir: d, manifest, raw, manifestPath: mp })
  }
  rows.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name))
  return rows
}

// schema 内全部 enum（如 action / edit_mode / safety.profile），路径排序稳定
export function walkEnums(schema, prefix = '', out = {}) {
  if (!schema || typeof schema !== 'object') return out
  if (Array.isArray(schema.enum)) out[prefix || '(root)'] = [...schema.enum]
  if (schema.properties) {
    for (const k of Object.keys(schema.properties).sort()) {
      walkEnums(schema.properties[k], prefix ? prefix + '.' + k : k, out)
    }
  }
  if (schema.items) walkEnums(schema.items, prefix + '[]', out)
  return out
}

// action 调度面：manifest enum 优先；否则从 handler 源字面量提取；提取不到 = pending（显式）
export function extractActionDispatch(manifest, handlerSrc) {
  const actionProp = manifest.inputSchema?.properties?.action
  if (!actionProp) return { status: 'none' }
  if (Array.isArray(actionProp.enum)) {
    return { status: 'declared', values: [...actionProp.enum].sort(), source: 'manifest.inputSchema.properties.action.enum' }
  }
  const values = new Set()
  const va = /valid_actions[^\[]*\[([^\]]*)\]/.exec(handlerSrc || '')
  if (va) {
    for (const m of va[1].matchAll(/'([a-zA-Z0-9_]+)'|"([a-zA-Z0-9_]+)"/g)) values.add(m[1] || m[2])
  }
  for (const m of (handlerSrc || '').matchAll(/action === '([a-zA-Z0-9_]+)'/g)) values.add(m[1])
  const dflt = /args\?\.action\s*\|\|\s*'([a-zA-Z0-9_]+)'/.exec(handlerSrc || '')
  if (dflt) values.add(dflt[1])
  if (!values.size) return { status: 'pending', note: 'G0：handler 内未找到可提取的 action 字面量；待人工展开' }
  return { status: 'extracted', values: [...values].sort(), source: 'handler source literals (valid_actions/action===/default)' }
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// 原测试位置：tests/*.js 中引用过该工具精确名（引号或反引号）的文件
// 注意：这是「引用位置」记录，不等于 G3 的运行级验收。
export function listTestRefs(root, name) {
  const testsDir = join(root, 'tests')
  if (!existsSync(testsDir)) return []
  const re = new RegExp('[' + String.fromCharCode(39) + String.fromCharCode(96) + '"]' + escapeRe(name) + '[' + String.fromCharCode(39) + String.fromCharCode(96) + '"]')
  const hits = []
  for (const f of readdirSync(testsDir).sort()) {
    if (!f.endsWith('.js')) continue
    let src
    try { src = readFileSync(join(testsDir, f), 'utf-8') } catch { continue }
    if (re.test(src)) hits.push('tests/' + f)
  }
  return hits
}

const UNRESOLVED_INITIAL = ['effects', 'preconditions', 'limits', 'outputs']

export function buildToolEntry(row, root) {
  const { dir, manifest, raw, manifestPath } = row
  const handlerRel = manifest.handler || 'handler.js'
  const handlerPath = join(dirname(manifestPath), handlerRel)
  const handlerSrc = existsSync(handlerPath) ? readFileSync(handlerPath) : Buffer.from('')
  const schema = manifest.inputSchema || {}
  const required = Array.isArray(schema.required) ? [...schema.required].sort() : []
  const properties = schema.properties ? Object.keys(schema.properties).sort() : []
  return {
    name: manifest.name,
    dir,
    version: manifest.version || null,
    protocol_version: manifest.protocol_version || null,
    tags: Array.isArray(manifest.tags) ? [...manifest.tags].sort() : [],
    dependencies: Array.isArray(manifest.dependencies) ? [...manifest.dependencies].sort() : [],
    manifest_sha256: sha256(raw),
    schema_sha256: sha256(Buffer.from(JSON.stringify(schema))),
    handler: handlerRel,
    handler_sha256: sha256(handlerSrc),
    params: { required, properties },
    enums: walkEnums(schema),
    action_dispatch: extractActionDispatch(manifest, handlerSrc.toString('utf-8')),
    test_refs: listTestRefs(root, manifest.name),
    unresolved: [...UNRESOLVED_INITIAL],
  }
}

export function buildContract(toolsDir = join(ROOT, 'tools'), root = ROOT) {
  const tools = listClassicManifests(toolsDir).map(r => buildToolEntry(r, root))
  return {
    contract_version: 1,
    kind: 'classic-44',
    generator: 'scripts/gen-capability-contract.mjs',
    note: 'G0 合同：名称集合/manifest+handler 哈希/参数面/enum/action 调度/原测试位置。unresolved 字段为显式待判定（不得静默省略）。',
    tools,
  }
}

export const POSITIONS_PATH = join(ROOT, 'contracts', 'classic-44.positions.json')

export function loadPositions(root = ROOT) {
  return JSON.parse(readFileSync(join(root, 'contracts', 'classic-44.positions.json'), 'utf-8'))
}

// 人读矩阵：由机器合同 + 位置表渲染（禁止手改产物）
export function renderMatrix(contract, positionsData) {
  const pos = new Map(((positionsData && positionsData.positions) || []).map(p => [p.name, p]))
  const lines = []
  lines.push('# G0 原 44 项合同矩阵（人读）')
  lines.push('')
  lines.push('> 生成：node scripts/gen-capability-contract.mjs --matrix（禁止手改本文件）。')
  lines.push('> 机器可读合同：contracts/classic-44.contract.json；位置表：contracts/classic-44.positions.json。')
  lines.push('> 位置状态：carried 已承接 / partial 部分承接 / not_carried 未承接 / no_landing 无落点。')
  lines.push('')
  lines.push('|#|工具|版本|required|enum/action|入口|位置状态|备注|')
  lines.push('|---|---|---|---|---|---|---|---|')
  contract.tools.forEach((t, i) => {
    const p = pos.get(t.name) || { entry: '?', status: '?', note: '' }
    const parts = Object.keys(t.enums).sort().map(k => k + '=' + t.enums[k].join('/'))
    if (t.action_dispatch && Array.isArray(t.action_dispatch.values)) parts.push('action=' + t.action_dispatch.values.join('/'))
    lines.push('|' + (i + 1) + '|' + t.name + '|' + t.version + '|' + (t.params.required.join(', ') || '-') + '|' + (parts.join('; ') || '-') + '|' + p.entry + '|' + p.status + '|' + (p.note || '') + '|')
  })
  lines.push('')
  const tally = {}
  for (const p of (positionsData && positionsData.positions) || []) tally[p.status] = (tally[p.status] || 0) + 1
  lines.push('位置状态计数：' + Object.keys(tally).sort().map(k => k + '=' + tally[k]).join(' / '))
  lines.push('')
  lines.push('unresolved（G0 显式待判定，44 项共同）：' + [...new Set(contract.tools.flatMap(t => t.unresolved))].sort().join(' / '))
  lines.push('')
  return lines.join('\n')
}

function dupNames(tools) {
  const seen = new Set(), dups = []
  for (const t of tools || []) {
    if (seen.has(t.name)) dups.push(t.name)
    seen.add(t.name)
  }
  return dups
}

// 验证：合同 vs 磁盘现实。返回 { ok, errors[] }（纯函数，便于失败路径测试）
export function verifyContract(contract, toolsDir = join(ROOT, 'tools'), root = ROOT) {
  const errors = []
  const push = (m) => errors.push(m)
  if (!contract || typeof contract !== 'object') { push('contract 不是对象'); return { ok: false, errors } }
  if (contract.contract_version !== 1) push('contract_version 必须为 1（得 ' + contract.contract_version + '）')
  if (contract.kind !== 'classic-44') push('kind 必须为 classic-44（得 ' + contract.kind + '）')
  const tools = Array.isArray(contract.tools) ? contract.tools : []
  if (!tools.length) push('tools 为空')

  const dups = dupNames(tools)
  if (dups.length) push('工具名重复（唯一性违反）: ' + dups.join(', '))

  const diskRows = listClassicManifests(toolsDir)
  const diskNames = diskRows.map(r => r.manifest.name)
  const diskSet = new Set(diskNames)
  const cNames = tools.map(t => t.name)
  const cSet = new Set(cNames)

  const missing = diskNames.filter(n => !cSet.has(n))
  const extra = cNames.filter(n => !diskSet.has(n))
  if (missing.length) push('合同缺登记（missing）: ' + missing.join(', '))
  if (extra.length) push('合同含未知工具（unknown）: ' + extra.join(', '))
  if (cNames.length !== 44) push('合同工具数必须 44（得 ' + cNames.length + '）')
  if (diskNames.length !== 44) push('磁盘 classic 工具数必须 44（得 ' + diskNames.length + '）')

  const rowByName = new Map(diskRows.map(r => [r.manifest.name, r]))
  for (const t of tools) {
    const row = rowByName.get(t.name)
    if (!row) continue
    const fresh = buildToolEntry(row, root)
    if (t.manifest_sha256 !== fresh.manifest_sha256) push(t.name + ': manifest 漂移（合同 ' + t.manifest_sha256 + ' vs 磁盘 ' + fresh.manifest_sha256 + '）')
    if (t.schema_sha256 !== fresh.schema_sha256) push(t.name + ': inputSchema 漂移')
    if (t.handler_sha256 !== fresh.handler_sha256) push(t.name + ': handler 漂移（改 handler 必须重生成合同并显式确认）')
    if (t.version !== fresh.version) push(t.name + ': version 漂移（' + t.version + ' vs ' + fresh.version + '）')
    if (JSON.stringify(t.params) !== JSON.stringify(fresh.params)) push(t.name + ': 参数面漂移')
    if (JSON.stringify(t.enums) !== JSON.stringify(fresh.enums)) push(t.name + ': enum 漂移')
    if (!Array.isArray(t.test_refs) || !t.test_refs.length) push(t.name + ': 无原测试位置（test_refs 空）')
    for (const tr of (Array.isArray(t.test_refs) ? t.test_refs : [])) {
      if (!existsSync(join(root, tr))) push(t.name + ': test_ref 不存在: ' + tr)
    }
    if (!Array.isArray(t.unresolved)) push(t.name + ': unresolved 必须是显式数组')

    const d = t.action_dispatch || {}
    if (!['none', 'declared', 'extracted', 'pending'].includes(d.status)) {
      push(t.name + ': action_dispatch.status 非法（' + d.status + '）')
    } else if (d.status === 'declared') {
      const want = fresh.enums['action'] || []
      if (JSON.stringify(d.values) !== JSON.stringify([...want].sort())) push(t.name + ': action_dispatch.values 与 schema enum 不一致')
    } else if (d.status === 'extracted') {
      if (!Array.isArray(d.values) || !d.values.length) push(t.name + ': extracted 但 values 为空')
      const src = readFileSync(join(dirname(row.manifestPath), t.handler || 'handler.js'), 'utf-8')
      for (const v of d.values || []) {
        if (!src.includes(String.fromCharCode(39) + v + String.fromCharCode(39))) push(t.name + ': action 值 ' + v + ' 在 handler 源中无字面量证据')
      }
    } else if (d.status === 'pending') {
      if (!d.note) push(t.name + ': pending 必须带 note')
    }
  }
  return { ok: errors.length === 0, errors }
}

function main() {
  const check = process.argv.includes('--check')
  const contract = buildContract()
  if (process.argv.includes('--matrix')) {
    // 人读矩阵落在 gitignored 的 reports/contracts/——发布仓不含内部计划目录；
    // 固定文件名（不带日期）以守住本脚本的"无系统时间"确定性约束；历史留档在开发仓
    const out = join(ROOT, '..', 'reports', 'contracts', 'G0-原44项合同矩阵.md')
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, renderMatrix(contract, loadPositions()))
    console.log('wrote ' + out)
    return
  }
  const { ok, errors } = verifyContract(contract)
  if (check) {
    if (!ok) { console.error('contract verify FAILED:'); for (const e of errors) console.error('  - ' + e); process.exit(1) }
    console.log('contract verify OK: ' + contract.tools.length + ' tools')
    return
  }
  mkdirSync(dirname(CONTRACT_PATH), { recursive: true })
  writeFileSync(CONTRACT_PATH, JSON.stringify(contract, null, 2) + '\n')
  console.log('wrote ' + CONTRACT_PATH + ' (' + contract.tools.length + ' tools)')
  if (!ok) {
    console.error('warn: verify found issues:')
    for (const e of errors) console.error('  - ' + e)
    process.exit(1)
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) main()
