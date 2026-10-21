// 六合工具集 — malong-parse 二进制共享解析（mcp-server / parse-client / code-index 统一入口）
// 解析链：env(MALONG_PARSE_BIN / MALONG_PARSE_BIN_ALT)
//       → npm 平台包（@jieai/malong-parse-<platform>-<arch>，若已安装）
//       → 包内 server/bin/malong-parse（旧版主包内嵌兼容）
//       → ~/.local/bin/malong-parse（历史安装）
//       → dev 源码树 ../malong-parse/target/release|debug（liuhe 仓库内开发）
// 注（0.5.13）：平台包不再在 DSH bundle 里声明 optionalDependencies——旧版钉的 0.5.9
// 从未发布过（npm 最高 0.4.8），永远装不上，只会静默走 catch 分支。仓库里也没有
// npm-platform/ 构建目录。要自动分发需先把平台包真的发出来；当前靠下面分支兜底。
// 平台枚举：linux-x64 / darwin-x64 / darwin-arm64 / win32-x64。
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const require = createRequire(import.meta.url)

export function platformPkgName() {
  const p = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'
  const a = process.arch === 'arm64' ? 'arm64' : 'x64'
  return `@jieai/malong-parse-${p}-${a}`
}

export function resolveParseBinCandidates() {
  const out = []
  if (process.env.MALONG_PARSE_BIN) out.push(process.env.MALONG_PARSE_BIN)
  if (process.env.MALONG_PARSE_BIN_ALT) out.push(process.env.MALONG_PARSE_BIN_ALT)
  try {
    // 平台包 main 指向 bin/malong-parse（win32 为 .exe），resolve 即得二进制绝对路径
    const p = require.resolve(platformPkgName())
    if (typeof p === 'string' && p) out.push(p)
  } catch {}
  out.push(fileURLToPath(new URL('./bin/malong-parse', import.meta.url)))
  out.push(join(os.homedir(), '.local', 'bin', 'malong-parse'))
  // dev 源码树（liuhe 仓库内：malong/parse-bin.js → ../malong-parse/target）
  out.push(fileURLToPath(new URL('../malong-parse/target/release/malong-parse', import.meta.url)))
  out.push(fileURLToPath(new URL('../malong-parse/target/debug/malong-parse', import.meta.url)))
  return out
}

export function resolveParseBin() {
  for (const c of resolveParseBinCandidates()) {
    if (existsSync(c)) return c
    if (process.platform === 'win32' && existsSync(c + '.exe')) return c + '.exe'
  }
  return null
}
