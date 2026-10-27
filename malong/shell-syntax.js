// Shell 语法校验（bash -n 真解释器）
// 背景（2026-10-27）：Rust tree-sitter 对 .sh 的语法层几乎空转——实测 missing fi / missing done /
// 未闭合 $( 全部 has_errors:false，只有未闭合引号、缺 then、明显乱码才报。而括号启发式在 shell 上
// 原理性不可判（${…#…}、case 的 )、heredoc、$(( )) 合法但不配对），已在 write-edit.js 里整体跳过。
// 两侧都不管 = shell 改动零校验，故此处补真判据：bash -n（只做语法解析，不执行任何命令）。
//
// 与 python-cmd.js 同构：命令探测 + 进程内缓存；结果缓存按内容哈希，避免同一草稿反复起进程。
// 平台：Windows 默认无 bash → 返回 unavailable（调用方如实 skip 且不当成语法错），不假装通过。

import { execFileSync, execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sha256 } from './hash-utils.js'

let _cached = undefined
let _checked = false

const MAX_CACHE = 64
const _resultCache = new Map()

// 探测可用的 shell 解释器；结果进程内缓存（含「没有」这个结论）
export function getShellCmd() {
  if (_checked) return _cached
  _checked = true
  const candidates = []
  if (process.env.MALONG_SH) candidates.push(process.env.MALONG_SH)
  candidates.push('bash', 'sh')
  for (const cmd of candidates) {
    try {
      // --version 在 dash 上不是合法选项，退回 -c 'true' 更通用
      try { execFileSync(cmd, ['--version'], { stdio: 'pipe', timeout: 3000 }) }
      catch { execFileSync(cmd, ['-c', 'true'], { stdio: 'pipe', timeout: 3000 }) }
      _cached = cmd
      return _cached
    } catch {
      // 不存在或无执行权限 → 试下一个
    }
  }
  _cached = null
  return _cached
}

// 仅测试用：重置探测缓存（生产路径不调用）
export function _resetShellCmdCache() {
  _cached = undefined
  _checked = false
  _resultCache.clear()
}

function runShellSyntax(cmd, file) {
  return new Promise((resolve) => {
    // -n = 只读不执行；绝不执行待校验内容里的任何命令
    execFile(cmd, ['-n', file], { timeout: 8000 }, (err, _so, se) => {
      if (!err) return resolve({ ok: true })
      resolve({ ok: false, detail: String(se || err.message).trim().split('\n')[0] })
    })
  })
}

// 修复 P0-1（2026-10-27）：CRLF 不能直接喂给 bash -n。
// Linux/WSL 的 bash 会把 `then\r` 视作非法 token，纯行尾差异也会报「未预期的文件结束符」；
// 而 malong 在 transaction-store 里**刻意**保留 CRLF→CRLF（15-B Windows 行尾继承），
// 于是 Windows 上每个 .sh 的每次编辑都会被 VALIDATION_FAILED 拦住——这与 0.5.29 要解决的
// 「合法文件被误拦」是同一类问题，必须在同一版里修掉。
// 做法：校验前先把 CRLF 规范化为 LF（只影响校验，不写回磁盘），真语法错仍然照报
// （实测：缺 fi 的 CRLF 脚本规范化后依旧 fail）。行尾差异本身以 notice 如实告知，不静默隐藏。
function normalizeCrlf(source) {
  if (!source.includes('\r\n')) return { text: source, hadCrlf: false }
  return { text: source.split('\r\n').join('\n'), hadCrlf: true }
}

function withTempFile(source, ext) {
  const dir = mkdtempSync(join(tmpdir(), 'malong-sh-'))
  const file = join(dir, `snippet${ext || '.sh'}`)
  writeFileSync(file, source, 'utf-8')
  // 脚本可能含密钥：目录已是 700，文件再收紧到 600 作为纵深防御
  try { chmodSync(file, 0o600) } catch {}
  return {
    file,
    cleanup() {
      try { unlinkSync(file) } catch {}
      try { rmdirSync(dir) } catch {}
    },
  }
}

// bash -n 的报错里带的是临时文件路径（且返回时该文件已删除），用户无法据此定位，
// 正是最初「报错行号指向未改动处」的同类体验问题。替换成调用方给的真实文件名。
function humanizeDetail(detail, tmpFile, displayName) {
  const name = displayName || 'script'
  let out = String(detail || '').split(tmpFile).join(name)
  // 兜底：即便路径形态变化也不要把临时路径泄露给用户
  out = out.replace(/\/[^\s:]*malong-sh-[^/\s:]*\/[^\s:]+/g, name)
  return out
}

// 返回 { status: 'pass'|'fail'|'skip', errors?, reason?, unavailable?, notice? }
// 与 write-runtime.validateSyntax 同形状；unavailable=true 表示「本机没有解释器」，
// 调用方（shouldBlockValidation）据此不把它当成语法错，避免 strict 档把 Windows 全量拦住。
export async function validateShellSyntax(source, ext, displayName) {
  const cmd = getShellCmd()
  if (!cmd) {
    return {
      status: 'skip',
      unavailable: true,
      reason: 'shell unavailable: no bash/sh on this host; shell syntax NOT checked (not a syntax error)',
    }
  }
  const raw = String(source || '')
  const key = `${cmd}\u0000${ext || ''}\u0000${displayName || ''}\u0000${sha256(raw)}`
  const hit = _resultCache.get(key)
  // 修复 P0-2：缓存命中必须返回副本——旧实现返回同一对象引用，
  // 调用方一旦改写 status/errors 就会污染后续所有同内容校验（实测可把 fail 改成 pass）。
  if (hit) return { ...hit, ...(hit.errors ? { errors: [...hit.errors] } : {}) }

  const { text, hadCrlf } = normalizeCrlf(raw)
  let result
  // 修复 P1（2026-10-27）：临时目录不可用（只读 TMPDIR / 配额满 / 权限异常）不得炸穿写盘。
  // 旧实现直接 throw ENOENT，而写盘主路径无 catch → 用户得到裸异常而非 VALIDATION_FAILED 语义。
  // 这是「环境缺失」而非「文件有语法错」→ 如实 skip + unavailable，不伪装 pass。
  let file = null
  try {
    const tmp = withTempFile(text, ext)
    file = tmp.file
    try {
      result = await runShellSyntax(cmd, file)
    } finally {
      tmp.cleanup()
    }
  } catch (e) {
    return {
      status: 'skip',
      unavailable: true,
      reason: `shell syntax check skipped: temp file unavailable (${String(e?.message || e).slice(0, 120)}); NOT a syntax error`,
    }
  }
  const value = result.ok
    ? { status: 'pass' }
    : { status: 'fail', errors: [`${cmd} -n: ${humanizeDetail(result.detail, file, displayName)}`] }
  if (hadCrlf) {
    value.notice = 'file uses CRLF line endings; syntax validated after normalizing to LF (line endings not modified)'
  }
  if (_resultCache.size >= MAX_CACHE) _resultCache.delete(_resultCache.keys().next().value)
  _resultCache.set(key, value)
  return { ...value, ...(value.errors ? { errors: [...value.errors] } : {}) }
}
