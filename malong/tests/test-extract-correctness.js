// 提取正确性回归测试：JS/TS 解构绑定 + TS 专属构造
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect, extractAll, extractTopLevel, extractSymbols } from '../parse-client.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

let passed = 0, failed = 0
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`) }
  else { failed++; console.log(`  ✗ ${msg}`) }
}

async function main() {
  console.log('提取正确性测试\n')
  await connect()

  console.log('── 1. JS 解构绑定 ──')
  const destructure = `
const { a, b } = require('x')
const [c, d] = arr
const { e: f, ...g } = obj
const { h = 1 } = obj
const { nested: { i } } = obj2
const simple = 5
`
  const r1 = await extractAll(destructure, '.js')
  const names1 = r1.symbols.map(s => s.name)
  for (const n of ['a', 'b', 'c', 'd', 'f', 'g', 'h', 'i', 'simple']) {
    assert(names1.includes(n), `解构绑定提取: ${n}`)
  }
  const garbage = names1.filter(n => /[{}\[\]]/.test(n))
  assert(garbage.length === 0, `无垃圾符号 (got: ${JSON.stringify(garbage)})`)

  console.log('\n── 2. extractTopLevel 解构 ──')
  const r2 = await extractTopLevel(destructure, '.js')
  const names2 = r2.map(s => s.name)
  assert(names2.includes('a') && names2.includes('g'), `top-level 解构: a, g 在 ${JSON.stringify(names2)}`)
  assert(names2.filter(n => /[{}\[\]]/.test(n)).length === 0, 'top-level 无垃圾符号')

  console.log('\n── 3. extractSymbols 解构 ──')
  const r3 = await extractSymbols(destructure, '.js')
  const names3 = r3.symbols.map(s => s.name)
  assert(names3.includes('a') && names3.includes('f'), `extractSymbols 解构: a, f`)

  console.log('\n── 4. TS 专属构造 ──')
  const tsSrc = `
interface User { id: number; name: string }
type ID = string | number
enum Color { Red, Green, Blue }
abstract class Shape { abstract area(): number }
function regular() {}
const { x, y } = point
`
  const r4 = await extractAll(tsSrc, '.ts')
  const names4 = r4.symbols.map(s => s.name)
  const kinds4 = Object.fromEntries(r4.symbols.map(s => [s.name, s.type]))
  assert(kinds4.User === 'interface', `TS interface 提取: User (kind=${kinds4.User})`)
  assert(kinds4.ID === 'type', `TS type alias 提取: ID (kind=${kinds4.ID})`)
  assert(kinds4.Color === 'enum', `TS enum 提取: Color (kind=${kinds4.Color})`)
  assert(kinds4.Shape === 'class', `TS abstract class 提取: Shape (kind=${kinds4.Shape})`)
  assert(names4.includes('regular'), 'TS 普通函数仍提取')
  assert(names4.includes('x') && names4.includes('y'), 'TS 文件内解构仍提取')

  console.log('\n── 5. 真实 TS fixture (sample.ts) ──')
  const sampleTs = readFileSync(join(__dirname, 'fixtures/src/sample.ts'), 'utf-8')
  const r5 = await extractAll(sampleTs, '.ts')
  const kinds5 = Object.fromEntries(r5.symbols.map(s => [s.name, s.type]))
  assert(kinds5.User === 'interface', 'fixture: interface User')
  assert(kinds5.UserID === 'type', 'fixture: type UserID')
  assert(kinds5.Role === 'enum', 'fixture: enum Role')
  assert(kinds5.BaseRepository === 'class', 'fixture: abstract class BaseRepository')
  assert(kinds5.UserRepository === 'class', 'fixture: class UserRepository')
  assert(kinds5.createUser === 'function', 'fixture: function createUser')
  assert(r5.symbols.some(s => s.name === 'Admin'), 'fixture: 解构 const { Admin } = Role')
  assert(r5.symbols.some(s => s.name === 'rest'), 'fixture: 解构 const [first, ...rest]')
  assert(r5.symbols.filter(s => /[{}\[\]]/.test(s.name)).length === 0, 'fixture: 无垃圾符号')

  console.log('\n── 6. 动态 import 补充提取（Rust parser 缺失，JS 侧补） ──')
  const dynSrc = `export const fn = async () => { await import('./real.js') }
const doc = "import('./fake.js')"
const tpl = \`import('./in-template.js')\`
`
  const r6 = await extractAll(dynSrc, '.js')
  const mods6 = r6.refs.filter(r => r.type === 'import').map(r => r.module)
  assert(mods6.includes('./real.js'), `动态 import 提取: ./real.js（得 ${JSON.stringify(mods6)}）`)
  assert(!mods6.includes('./fake.js'), '字符串文本 import 不误报')
  assert(!mods6.includes('./in-template.js'), '模板字符串文本 import 不误报')
  const realIdx = dynSrc.indexOf("import('./real.js')")
  const fakeIdx = dynSrc.indexOf("import('./fake.js')")
  assert(r6.refs.some(r => r.module === './real.js' && r.line === dynSrc.slice(0, realIdx).split('\n').length), `动态 import 行号正确（${r6.refs.find(r => r.module === './real.js')?.line}）`)
  assert(r6.refs.find(r => r.module === './real.js')?.line === 1, `行号 = 1（得 ${r6.refs.find(r => r.module === './real.js')?.line}）`)

  console.log('\n── 7. 中文符号/中文路径/中文注释（多字节行号 + 字符串陷阱） ──')
  const cjkSrc = [
    '// 注释一：中文（含括号）',
    'export const 前缀 = "中文（括号）内容"',
    'export function 函数甲() {',
    '  const 局部 = 1',
    '  return 局部',
    '}',
    '',
    'export class 类乙 {',
    '  async 方法(参数) {',
    '    return 参数',
    '  }',
    '}',
    'const doc = "function fake() { return 1 }"',
  ].join('\n') + '\n'
  const cjkPath = '/tmp/opencode/cjk/中文固化.js'
  mkdirSync('/tmp/opencode/cjk', { recursive: true })
  writeFileSync(cjkPath, cjkSrc)
  const r7 = await extractAll(cjkSrc, '.js', cjkPath)
  const names7 = Object.fromEntries(r7.symbols.map(s => [s.name, s.type]))
  assert(names7['前缀'] === 'variable', `中文变量: 前缀（得 ${JSON.stringify(names7)}）`)
  assert(names7['函数甲'] === 'function', '中文函数: 函数甲')
  assert(names7['类乙'] === 'class', '中文类: 类乙')
  assert(names7['方法'] === 'method', '中文方法: 方法')
  assert(!r7.symbols.some(s => s.name.startsWith('fake')), '字符串内的 fake 函数不提取')
  assert(!r7.symbols.some(s => s.name === '局部' && s.type !== 'variable'), '中文参数不误报')
  const fn7 = r7.symbols.find(s => s.name === '函数甲')
  assert(fn7 && fn7.startLine === 3 && fn7.endLine === 6, `中文函数行号精确（得 ${JSON.stringify(fn7)}）`)
  const cls7 = r7.symbols.find(s => s.name === '类乙')
  assert(cls7 && cls7.startLine === 8 && cls7.endLine === 12, `中文类行号精确（得 ${JSON.stringify(cls7)}）`)
  assert(r7.symbols.every(s => s.startLine >= 1 && s.endLine >= s.startLine), '全部行号有效')

  console.log(`\n═══════════════════════════════════════`)
  console.log(`提取正确性: ${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(1) })
