// test-cjs-imports.js — 五轮审查修复：scanCjsRequires 状态机（块注释/模板串/同行 URL 假阳性与假阴性）
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const { scanCjsRequires } = await import(pathToFileURL(join(__dirname, '..', 'cjs-imports.js')).href)

let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}

// ① 普通 require
{
  const r = scanCjsRequires('const a = require("real-dep")\n')
  assert(r.length === 1 && r[0].module === 'real-dep', `① 普通 require（得 ${JSON.stringify(r)}）`)
}
// ② 块注释内 require 不算（幽灵依赖修复点）
{
  const r = scanCjsRequires('/* const { helper } = require("phantom-lib") */\nconst b = require("real2")\n')
  assert(r.length === 1 && r[0].module === 'real2', `② 块注释 require 不算（得 ${JSON.stringify(r.map(x => x.module))}）`)
}
// ③ 模板串内 require 不算
{
  const r = scanCjsRequires('const t = `require("phantom2")`\nconst c = require("real3")\n')
  assert(r.length === 1 && r[0].module === 'real3', `③ 模板串 require 不算（得 ${JSON.stringify(r.map(x => x.module))}）`)
}
// ④ 同行 URL 字符串不连坐删后半行（假阴性修复点）
{
  const r = scanCjsRequires('const u = "http://x"; const m = require("real4")\n')
  assert(r.length === 1 && r[0].module === 'real4', `④ 同行 URL 后 require 保留（得 ${JSON.stringify(r.map(x => x.module))}）`)
}
// ⑤ 行注释内 require 不算
{
  const r = scanCjsRequires('// const d = require("phantom3")\nconst e = require("real5")\n')
  assert(r.length === 1 && r[0].module === 'real5', `⑤ 行注释 require 不算（得 ${JSON.stringify(r.map(x => x.module))}）`)
}
// ⑥ 解构 require aliasMap
{
  const r = scanCjsRequires('const { helper } = require("real6")\n')
  assert(r.length === 1 && r[0].aliasMap && r[0].aliasMap.helper === 'helper', `⑥ 解构 aliasMap（得 ${JSON.stringify(r[0] && r[0].aliasMap)}）`)
}
// ⑦ 跨行块注释吞注释内 require、闭合后恢复
{
  const r = scanCjsRequires('/* block open\n   require("phantom4")\nconst f = require("real7")\n*/\nconst g = require("real8")\n')
  assert(r.length === 1 && r[0].module === 'real8', `⑦ 跨行块注释闭合后恢复（得 ${JSON.stringify(r.map(x => x.module))}）`)
}
// ⑧ 字符串内 require 不报（既有行为保持）
{
  const r = scanCjsRequires('const s = "require(\'also-not-real\')"\n')
  assert(r.length === 0, `⑧ 字符串内 require 不报（得 ${JSON.stringify(r)}）`)
}
// ⑨ 转义引号字符串
{
  const r = scanCjsRequires('const s = "a\\"b"; const m = require("real9")\n')
  assert(r.length === 1 && r[0].module === 'real9', `⑨ 转义引号后 require 保留（得 ${JSON.stringify(r.map(x => x.module))}）`)
}

console.log(`== test-cjs-imports: ${pass} passed, ${fail} failed ==`)
process.exit(fail > 0 ? 1 : 0)