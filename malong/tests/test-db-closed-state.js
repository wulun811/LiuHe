// test-db-closed-state.js — 数据库关闭态判据必须后端中立（专家 R16o 裁决 §5.4）
//
// 真实缺陷（专家在无 native better-sqlite3 的环境独立复现）：
//   test-ws-switch-race 断言 `db.open === false` 判"stop 关闭全部句柄"。
//   但这是 better-sqlite3 的专属属性——sql.js fallback（SqlJsDb）根本没有 `open`，
//   它维护的是 `_closed`。于是同一份产品代码：
//     · 有 native better-sqlite3 → 18/18 PASS
//     · 只有 sql.js fallback   → 17/18 FAIL，且失败信息看起来像"stop 没关句柄"
//   这不是产品停机故障，**是测试判据绑定了后端实现细节**。
//
// 本测试锁住合同：关闭态判据必须同时认 `open === false` 与 `_closed === true`，
// 且对"两种都没有"的未知后端 fail-closed（判为未关闭，不放过）。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) pass++
  else { fail++; console.error('  FAIL:', msg) }
}

const { isDbClosed } = await import(pathToFileURL(join(root, 'db-adapter.js')).href)

// ① better-sqlite3 形态：open === false 表示已关
assert(isDbClosed({ open: false }) === true, '① native 后端 open=false → 已关闭')
assert(isDbClosed({ open: true }) === false, '① native 后端 open=true → 仍开启')

// ② sql.js / SqlJsDb 形态：只有 _closed，没有 open
assert(isDbClosed({ _closed: true }) === true,
  '② sql.js 后端 _closed=true → 已关闭（这是专家那次红灯的根因）')
assert(isDbClosed({ _closed: false }) === false, '② sql.js 后端 _closed=false → 仍开启')

// ③ 两种属性同时存在时以"已关"为准（任一为真即已关，宽进严出）
assert(isDbClosed({ open: false, _closed: false }) === true, '③ open=false 已足够判关闭')
assert(isDbClosed({ open: true, _closed: true }) === true, '③ _closed=true 已足够判关闭')

// ④ 未知后端（两个属性都没有）必须 fail-closed：判为"未确认关闭"
//    宁可让测试红，也不要因为读不到属性而假装通过。
assert(isDbClosed({}) === false, '④ 无任何关闭态属性 → 不得判为已关闭（fail-closed）')
assert(isDbClosed(null) === false, '④ null 句柄 → 不得判为已关闭')
assert(isDbClosed(undefined) === false, '④ undefined 句柄 → 不得判为已关闭')

// ⑤ 幂等/纯函数：不修改入参
{
  const db = { open: false }
  const before = JSON.stringify(db)
  isDbClosed(db)
  assert(JSON.stringify(db) === before, '⑤ 判据不得修改句柄对象')
}

console.log(`test-db-closed-state: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
