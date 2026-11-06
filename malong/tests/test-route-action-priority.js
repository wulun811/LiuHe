// test-route-action-priority.js — 修改动类意图被文档/审查等弱关键词抢走（B6-route）
//
// 背景：DSH 实录 2026-11-02 §2.4 实测——
//   goal 里只要出现"文档"二字就被路由成 document，而那一轮本质是修代码
//   （写 scripts/验-文档命令.mjs + 283 行测试）。route 决定真实行为：
//   route=review 才触发 audit 完成契约，route=maintain/system 决定结构展开，
//   route=document 则完全不做代码定位。猜错就是"静默的错"。
//
// 根因不是"排序算法不行"，是**确定性缺陷**：
//   inferRouteDetailed 按 ROUTES 数组顺序遍历，change 虽在首位，但
//   '文档命令闸门' 这类 goal 里没有 change 的中文动作词（新增/实现/修复…），
//   却有"文档" → 落到 document。而 '修文档里的错别字' 这种真·文档任务同样命中 document。
//   两者的区别是**有无动作动词**——可判定，不需要语义模型。
//
// 判据（全部确定性、可枚举）：
//   ① 句子里有 change 类动作动词时，即使也提到"文档"，必须是 change
//   ② 真·文档任务（无代码动作词）仍是 document
//   ③ 已有 C 档契约不破：未命中任何词 → default + 可纠正
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const imp = (p) => import(pathToFileURL(join(__dirname, '..', p)).href)
let pass = 0, fail = 0
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  FAIL:', msg) } }

const shared = await imp('tools/entry-shared.js')
const { inferRoute, inferRouteDetailed } = shared

// ── ① 动作动词优先：提到"文档"但实际在改代码 ──
{
  const cases = [
    // DSH 现场的形态：目标是实现一个"文档命令闸门"
    ['实现文档命令的闸门判据', 'change'],
    ['修复文档命令脚本里的判定错误', 'change'],
    ['新增一个生成文档的命令', 'change'],
    ['重构文档渲染流程', 'change'],
    ['把文档检查接到 pre-commit', 'change'],
    ['更新 README 里的安装说明', 'change'],
    // 英文侧同形
    ['implement a docstring gate for commands', 'change'],
    ['add a command that generates documentation', 'change'],
    ['fix the document command script', 'change'],
  ]
  for (const [goal, want] of cases) {
    const got = inferRoute(goal)
    assert(got === want, `① 「${goal}」应路由为 ${want}（得 ${got}）`)
  }
}

// ── ② 真·文档任务仍是 document（无代码动作词）──
{
  const cases = [
    ['给这个函数写文档', 'document'],
    ['文档里这一段读不通', 'document'],
    ['补一下注释', 'document'],
    ['补充 docstring', 'document'],
    ['readme 里有一句话说不清', 'document'],
  ]
  for (const [goal, want] of cases) {
    const got = inferRoute(goal)
    assert(got === want, `② 「${goal}」应路由为 ${want}（得 ${got}）`)
  }
}

// ── ③ 已有行为不回归：纯动作 / 纯诊断 / 纯审查 ──
{
  const cases = [
    ['新增一个 --json 输出选项', 'change'],
    ['修复登录失败的问题', 'change'],
    ['为什么 reindex 会超时', 'diagnose'],
    ['排查写入偶发失败的原因', 'diagnose'],
    ['审查写入路径的安全风险', 'review'],
    ['清理不再使用的死代码', 'maintain'],
    ['给我讲讲整体架构', 'system'],
  ]
  for (const [goal, want] of cases) {
    const got = inferRoute(goal)
    assert(got === want, `③ 「${goal}」应路由为 ${want}（得 ${got}）`)
  }
}

// ── ④ C 档契约不破：未命中任何词 → default（不是静默猜一个）──
{
  const r = inferRouteDetailed('嗯这个那个')
  assert(r.route === 'understand' && r.source === 'default',
    `④ 无命中应 default/understand（得 ${r.route}/${r.source}）`)
  assert(r.evidence === null, '④ default 不带 evidence（没命中就没有命中词）')
}

// ── ⑤ 动作词与文档词同句时，evidence 必须指向动作词（可核查）──
{
  const r = inferRouteDetailed('实现文档命令的闸门判据')
  assert(r.route === 'change', `⑤ 应为 change（得 ${r.route}）`)
  assert(typeof r.evidence === 'string' && r.evidence.length > 0,
    `⑤ 必须给出命中的具体词（得 ${JSON.stringify(r.evidence)}）`)
  assert(/实现|add|implement/i.test(r.evidence), `⑤ evidence 应指向动作词而非"文档"（得 ${r.evidence}）`)
}

// ── ⑥ 非字符串/异常输入不得抛（既有健壮性）──
{
  assert(inferRoute(null) === 'understand', '⑥ null 不抛，落 default')
  assert(inferRoute(123) === 'understand', '⑥ 数字不抛，落 default')
  let threw = null
  try { inferRoute({ toString() { throw new Error('boom') } }) } catch (e) { threw = e }
  assert(threw === null, '⑥ toString 抛错时不得把异常抛给调用方')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
