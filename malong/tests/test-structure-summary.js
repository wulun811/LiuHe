// test-structure-summary.js — LH-005/006：结构总览路径归一 + 错误透传 + 文档覆盖 unknown
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP = join(os.tmpdir(), 'opencode', 'structure-summary-test')
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
mkdirSync(join(TMP, 'src'), { recursive: true })
writeFileSync(join(TMP, 'src', 'a.js'), 'export function a() {}\n')
writeFileSync(join(TMP, 'src', 'b.js'), 'export function b() {}\n')
writeFileSync(join(TMP, 'src', 'doc.js'), ['// doc for c', 'function c() {}', 'function d() {}', ''].join(String.fromCharCode(10)))

let pass = 0, fail = 0
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  FAIL:', msg) } }

const imp = (p) => import(pathToFileURL(p).href)
const shared = await imp(join(__dirname, '..', 'tools', 'entry-shared.js'))
const orient = await imp(join(__dirname, '..', 'workflow', 'orient.js'))

// ── 1. structureSummary：collector 绝对路径/win 混合分隔符必须归一后命中；错误必须透传 ──
const svc = {
  async getFileOutline(f) {
    if (f === 'src/a.js') return { outline: [{ name: 'a', type: 'function', line: 1 }] }
    if (f === 'src/b.js') throw new Error('boom outline')
    return { error: 'file_not_found', message: 'no such file: ' + f }
  },
}
const r = await shared.structureSummary(svc, [join(TMP, 'src', 'a.js'), join(TMP, 'src', 'b.js'), 'C:\\other\\src\\a.js'], { limit: 20, workspaceDir: TMP })
const rMods = r.modules || []
const rErrs = r.errors || []
assert(Array.isArray(r.modules) && Array.isArray(r.errors), 'structureSummary 返回 {modules, errors}（得 ' + JSON.stringify(Object.keys(r || {})) + '）')
assert(rMods.length === 2, '工作区外路径不占模块位（得 ' + rMods.length + '）')
assert(rMods[0].file === 'src/a.js' && rMods[0].symbols[0] && rMods[0].symbols[0].name === 'a', '绝对路径归一后命中 outline（得 ' + JSON.stringify(rMods[0]) + '）')
assert(rErrs.length === 2, 'outline 异常 + 工作区外路径计入 errors（得 ' + JSON.stringify(rErrs) + '）')
assert(rErrs.some(e => e.file === 'src/b.js' && /boom/.test(e.error)), 'outline 异常透传（得 ' + JSON.stringify(rErrs) + '）')
assert(rErrs.some(e => /outside/.test(e.error)), '工作区外路径标记（得 ' + JSON.stringify(rErrs) + '）')
assert(rMods[1].file === 'src/b.js' && rMods[1].symbols.length === 0, '失败模块保留占位且符号为空')

// ── 2. toWorkspaceRel/toPosix 边界（win 反斜杠/盘符大小写/越界）──
assert(shared.toPosix('a\\b\\c.js') === 'a/b/c.js', 'toPosix 全量转正斜杠')
assert(shared.toWorkspaceRel('C:\\Ws\\src\\a.js', 'c:/ws') === 'src/a.js', 'win 盘符大小写不敏感 + 反斜杠归一（得 ' + shared.toWorkspaceRel('C:\\Ws\\src\\a.js', 'c:/ws') + '）')
assert(shared.toWorkspaceRel('/home/x/proj/src/a.js', '/home/x/proj') === 'src/a.js', 'posix 绝对路径相对化')
assert(shared.toWorkspaceRel('../outside.js', '/home/x/proj') === null, '越界 ../ 拒绝')
assert(shared.toWorkspaceRel('D:/other/a.js', 'C:/ws') === null, '跨盘拒绝')
assert(shared.toWorkspaceRel('src/a.js/', '/home/x/proj') === 'src/a.js', '尾斜杠剥离')

// ── 2b. 7-A（2026-10-07 专家复测 LH-004/006）：win 盘符工作区下相对路径必须直通 ──
const BS = String.fromCharCode(92)
assert(shared.toWorkspaceRel('z.js', 'D:/work/ws') === 'z.js', 'win base 相对路径直通（专家复现 z.js；得 ' + shared.toWorkspaceRel('z.js', 'D:/work/ws') + '）')
assert(shared.toWorkspaceRel('src' + BS + 'a.js', 'C:' + BS + 'ws') === 'src/a.js', 'win base 相对反斜杠归一（得 ' + shared.toWorkspaceRel('src' + BS + 'a.js', 'C:' + BS + 'ws') + '）')
assert(shared.toWorkspaceRel('./z.js', 'C:/ws') === 'z.js', 'win base ./ 前缀剥离（得 ' + shared.toWorkspaceRel('./z.js', 'C:/ws') + '）')
assert(shared.toWorkspaceRel('../z.js', 'C:/ws') === null, 'win base ../ 越界拒绝（得 ' + shared.toWorkspaceRel('../z.js', 'C:/ws') + '）')
assert(shared.toWorkspaceRel('N:z.js', 'C:/ws') === null, '盘符相对路径拒绝（非绝对、非工作区相对；得 ' + shared.toWorkspaceRel('N:z.js', 'C:/ws') + '）')

// ── 2c. 7-A：相对路径 + win 风格 workspaceDir 过 structureSummary 链（旧实现 outside_workspace）──
const rw = await shared.structureSummary(svc, ['src/a.js'], { limit: 20, workspaceDir: 'C:/ws' })
assert((rw.modules || []).length === 1 && rw.modules[0].file === 'src/a.js' && rw.modules[0].symbols[0]?.name === 'a', 'win base 相对路径结构总览命中（得 ' + JSON.stringify(rw) + '）')
assert((rw.errors || []).length === 0, 'win base 相对路径不产生 outside_workspace（得 ' + JSON.stringify(rw.errors) + '）')

// ── 3. docCoverage：不可读文件计数 + 无分母时 unknown 而非 0 ──
const mods = [
  { file: 'src/doc.js', symbols: [{ name: 'c', kind: 'function', line: 2 }, { name: 'd', kind: 'function', line: 3 }] },
  { file: 'src/missing.js', symbols: [{ name: 'm', kind: 'function', line: 1 }] },
]
let dc = orient.docCoverage(TMP, mods)
assert(dc.total === 2 && dc.documented === 1 && dc.coverage === 0.5, 'docCoverage 分母只算可读符号（得 ' + JSON.stringify(dc) + '）')
assert(dc.unreadable_files === 1, '不可读文件计数（得 ' + dc.unreadable_files + '）')
dc = orient.docCoverage(TMP, [{ file: 'src/nope.js', symbols: [{ name: 'x', kind: 'function', line: 1 }] }])
assert(dc.coverage === null && dc.unknown === true, '无可读符号 → unknown/null（不得读成 0）（得 ' + JSON.stringify(dc) + '）')

console.log('=== test-structure-summary: ' + pass + ' passed, ' + fail + ' failed ===')
process.exit(fail > 0 ? 1 : 0)
