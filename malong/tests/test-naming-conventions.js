// test-naming-conventions.js — LH-012：单词语文件名不得误报（getNameConvention 中性态）
// 覆盖：unused.py / server.rs / clean.sh / main.go 等单词名零噪声；多词 kebab/camel 在 .py
// 仍如实报；JS kebab 正常。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP = join(os.tmpdir(), 'opencode', 'naming-conventions-test')
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
mkdirSync(TMP, { recursive: true })
let pass = 0, fail = 0
const assert = (c, m) => { if (c) pass++; else { fail++; console.error('  FAIL:', m) } }
const imp = (p) => import(pathToFileURL(p).href)
const review = await imp(join(__dirname, '..', 'tools', 'tool-code-review', 'handler.js'))

const FILES = [
  ['unused.py', false], ['server.rs', false], ['clean.sh', false], ['main.go', false],
  ['my_module.py', false], ['util.js', false], ['util-kit.js', false], ['Widget.ts', false],
  ['my-module.py', true], ['myModule.py', true], ['UPPER.py', true],
]
for (const [f, shouldFlag] of FILES) {
  writeFileSync(join(TMP, f), 'export function mainThing() {}\n')
  const r = await review.handle({ workspace_dir: TMP, file: f }, {})
  const naming = (r.issues || []).filter(i => i.category === 'naming' && String(i.message).includes('naming convention'))
  assert((naming.length > 0) === shouldFlag, f + ' 命名判定（期望 ' + (shouldFlag ? '报' : '不报') + '，得 ' + JSON.stringify(naming.map(i => i.message)) + '）')
}

console.log('\n=== test-naming-conventions: ' + pass + ' passed, ' + fail + ' failed ===')
process.exit(fail > 0 ? 1 : 0)
