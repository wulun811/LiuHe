// 建议动作可达性（专家 P2-④）：graph 面内 handler 给出的 next_action/建议动作引用的工具，
// 必须在该接口真的可见；隐藏动作若泄漏必须改写。失败路径：曾出现 rich 的 navigation.next_action
// 指向 graph 隐藏的 read_symbol。
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { GRAPH_READ, GRAPH_WRITE, GRAPH_EXTRA } from '../workflow/public-catalog.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TOOLS = join(__dirname, '..', 'tools')
let pass = 0, fail = 0
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  FAIL:', msg) } }

const FACE = new Set([...GRAPH_READ, ...GRAPH_WRITE, ...GRAPH_EXTRA])

// 扫描对象：graph 可见的 code_* handler + rich-projection + entry-shared（下一条建议的构造处）
const targets = []
for (const d of readdirSync(TOOLS)) {
  const p = join(TOOLS, d, 'handler.js')
  if (!existsSync(p)) continue
  const mf = join(TOOLS, d, 'manifest.json')
  if (!existsSync(mf)) continue
  const m = JSON.parse(readFileSync(mf, 'utf-8'))
  if (FACE.has(m.name)) targets.push([m.name, p])
}
targets.push(['code_read:rich-projection', join(TOOLS, 'tool-code-read', 'rich-projection.js')])
targets.push(['entry-shared', join(TOOLS, 'entry-shared.js')])

// 提取 `tool: '<name>'`；排除 provenance 记录（via/source 委托，非模型可调用建议）
const RE = /tool:\s*'([a-z_]+)'/g
let scanned = 0
for (const [label, p] of targets) {
  const lines = readFileSync(p, 'utf-8').split('\n')
  for (const line of lines) {
    if (/via:\s*'delegate'|source:\s*'|provenance/.test(line)) continue // 委托出处，非建议动作
    RE.lastIndex = 0
    let m
    while ((m = RE.exec(line)) !== null) {
      scanned++
      assert(FACE.has(m[1]), label + ': 建议动作 tool="' + m[1] + '" 在 graph 面内（否则模型撞隐藏工具）')
    }
  }
}
assert(scanned > 0, '扫描到建议动作引用（防测试空跑假绿）')

// ── R05（0.5.10 审核修复）：classic-only 名的建议文本必须被改写到 graph 可达形式（name='...' 之外不得裸现）──
{
  const { sanitizeAdvisory } = await import(pathToFileURL(join(__dirname, '..', 'workflow', 'action-map.js')).href)
  const { loadPositions } = await import(pathToFileURL(join(__dirname, '..', 'workflow', 'capability-catalog.js')).href)
  const hidden = [...loadPositions().byName.keys()].filter((n) => !FACE.has(n)).sort()
  assert(hidden.length > 0, 'R05 扫描集非空（防测试空跑）')
  const scrub = (s) => String(s).replace(/name\s*=\s*['"]?[A-Za-z_][A-Za-z0-9_]*['"]?/g, 'name=<cap>').replace(/mode\s*=\s*['"][a-z]+['"]/g, 'mode=<cap>')
  let checked = 0
  for (const n of hidden) {
    const callOut = scrub(sanitizeAdvisory('Run ' + n + '(x=1) please.'))
    assert(!new RegExp('(?<![A-Za-z0-9_])' + n + '(?![A-Za-z0-9_])').test(callOut), 'R05 ' + n + '( 调用形式改写后无裸名')
    checked++
    if (n.includes('_')) {
      const bareOut = scrub(sanitizeAdvisory('Use ' + n + ' before editing.'))
      assert(!new RegExp('(?<![A-Za-z0-9_])' + n + '(?![A-Za-z0-9_])').test(bareOut), 'R05 ' + n + ' 裸名改写后无泄漏')
      checked++
    }
  }
  assert(checked > 10, 'R05 覆盖检查数（' + checked + '）')
}

console.log('=== test-graph-action-reachability: ' + pass + ' passed, ' + fail + ' failed（扫描 ' + scanned + ' 处 tool 引用）===')
process.exit(fail ? 1 : 0)
