#!/usr/bin/env node
// test-index-remove-file.js — P2（0.5.18，Windows 正式包复核）：删除同步服务出口
// 覆盖：已索引文件 removeFile → files/symbols 行清除且其他文件不受影响；未索引 → not_indexed（幂等不抛）；
//      workspace 外路径 → outside_workspace（与 _indexFileBound 同边界）。
// 依赖：malong-parse 服务在跑（与 test-crossfile-resolve 同前置）。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createDb } from '../db-adapter.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const imp = (p) => import(pathToFileURL(p).href)
const ROOT = join(__dirname, '..')
let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`) } else { fail++; console.error(`  FAIL: ${msg}`) }
}

const WS = join(tmpdir(), 'opencode', 'rmfile-ws')
const DATA = join(tmpdir(), 'opencode', 'rmfile-data')
const SOCK = join(tmpdir(), 'opencode', 'rmfile-index.sock')
try { rmSync(WS, { recursive: true, force: true }) } catch {}
try { rmSync(DATA, { recursive: true, force: true }) } catch {}
for (const d of [WS, DATA]) mkdirSync(d, { recursive: true })
writeFileSync(join(WS, 'a.js'), 'export function AlphaFn() { return 1 }\n')
writeFileSync(join(WS, 'b.js'), 'export function BetaFn() { return 2 }\n')

const pc = await imp(join(ROOT, 'parse-client.js'))
await pc.init({ log: () => {} })
assert(await pc.connect(), 'parse-client 连接')

const { default: codeIndex } = await imp(join(ROOT, 'code-index.js'))
const langParser = {
  extractAllAsync: (source, ext, filePath, ws) => pc.extractAll(source, ext, filePath, ws),
  extractReferencesAsync: (source, ext) => pc.extractReferences(source, ext),
  batchExtractAsync: (files, ws) => pc.batchExtract(files, ws),
}
const services = { langParser }
const core = {
  services,
  getService: (n) => services[n],
  registerService: (n, svc) => { services[n] = svc },
  getWorkspaceDir: () => DATA,
  log: () => {},
  emit: () => {},
  get: (key, def) => key === 'codeIndex.udsPath' ? SOCK : (key === 'codeIndex.udsToken' ? '' : def),
}
await codeIndex.init(core)
const svc = services.codeIndex
await svc.initWorkspace(WS)
await svc.indexBatch([join(WS, 'a.js'), join(WS, 'b.js')], WS)

const db = await createDb(join(DATA, 'code-index.db'))
const fileRows = (p) => db.prepare('SELECT COUNT(*) AS c FROM files WHERE path = ?').get(p).c
const symRows = (n) => db.prepare('SELECT COUNT(*) AS c FROM symbols WHERE name = ?').get(n).c
assert(fileRows('a.js') === 1 && symRows('AlphaFn') === 1, '① 索引就位（a.js / AlphaFn）')

const r1 = await svc.removeFile(join(WS, 'a.js'), WS)
assert(r1.removed === true && r1.path === 'a.js', '② removeFile 返回 removed=true + 相对路径')
assert(fileRows('a.js') === 0 && symRows('AlphaFn') === 0, '③ files/symbols 行已删除')
assert(fileRows('b.js') === 1 && symRows('BetaFn') === 1, '④ 其他文件不受影响')

const r2 = await svc.removeFile(join(WS, 'a.js'), WS)
assert(r2.removed === false && r2.reason === 'not_indexed', '⑤ 重复删除 → not_indexed（幂等不抛）')

const r3 = await svc.removeFile(join(WS, '..', 'escape.js'), WS)
assert(r3.removed === false && r3.reason === 'outside_workspace', '⑥ workspace 外路径 → 拒绝')

console.log(`\n=== test-index-remove-file: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
