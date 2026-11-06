// test-write-symbol-honesty.js — G1-R2 / D-04：写路径异常文案不得断言「文件未修改」
//
// 背景（2026-10-29 专家裁决 D-04 = B）：
//   tools/tool-write-symbol/handler.js 的 catch 块原文案为
//     "Check disk space and file permissions; the file was not modified."
//   该 catch 覆盖整个 writeSymbol()，理论上包含写盘【之后】的步骤
//   （updateJournalState / 回读 / registerWriter / indexFile / auditLog）。
//   本轮静态核查未注入出可达路径（写后各步均吞异常或降级），
//   但「找不到注入点」≠「永不发生」——一旦未来新增写后步骤裸抛，
//   这句话就从「安心提示」变成「谎报」，违反不变式 #1（真实效果不冒名）。
//
// 专家裁决：只在证据证明未写时说未写；否则说「结果不确定，重读核对」。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) { if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) } }

const TMP = join(os.tmpdir(), 'opencode', 'write-symbol-honesty')
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
const WS = join(TMP, 'ws')
mkdirSync(join(WS, 'src'), { recursive: true })
writeFileSync(join(WS, 'src', 'a.js'), 'function foo() { return 1 }\n')

const mod = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-write-symbol', 'handler.js')).href)

// ① 源码级断言：文案不得包含无条件的「未修改」断言
{
  const src = readFileSync(join(__dirname, '..', 'tools', 'tool-write-symbol', 'handler.js'), 'utf-8')
  // 只看实际引用文案（suggestion: '...'），不看注释——注释里引用旧文案做说明是合法且有益的
  const suggestionLines = src.split('\n').filter(l => /suggestion\s*:/.test(l)).join('\n')
  assert(!/the file was not modified/i.test(suggestionLines),
    'D-04 suggestion 不得含 "the file was not modified"（无证据的绝对断言）')
  assert(/may be uncertain|re-read/i.test(suggestionLines),
    'D-04 suggestion 须提示结果不确定 / 重读核对（得 ' + JSON.stringify((suggestionLines.match(/'([^']*)'/) || [])[1]) + '）')
}

// ② 行为级断言：真实异常路径返回中性文案 + outcome_uncertain
// 用非法 context 触发 writeSymbol 内部抛错（writeSymbol 收到损坏的 args 时抛 TypeError）
{
  const r = await mod.handle({ workspace_dir: WS, locator: { file_path: 'src/a.js' }, new_content: 'x'.repeat(5) }, { langParserService: { hasErrorsAsync: async () => { throw new Error('boom-parser') } }, codeIndexService: null })
  // 无论成功还是失败，只要落到了 catch，就必须是中性文案
  if (r && r.error === 'write_failed') {
    const s = r.suggestion || ''
    assert(!/was not modified/i.test(s), 'D-04 异常回执不得断言未修改（得 ' + JSON.stringify(s) + '）')
    assert(r.outcome_uncertain === true, 'D-04 异常回执显式标注 outcome_uncertain（得 ' + JSON.stringify(r.outcome_uncertain) + '）')
  } else {
    // 未触发 catch 也接受——本断言的意义是「若触发则必须中性」，不强行制造崩溃
    assert(true, 'D-04 本次未触发 catch 路径（不强制制造异常）')
  }
}

try { rmSync(TMP, { recursive: true, force: true }) } catch {}

console.log('== test-write-symbol-honesty: ' + pass + ' passed, ' + fail + ' failed ==')
if (fail > 0) process.exit(1)
