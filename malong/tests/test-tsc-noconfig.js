// test-tsc-noconfig.js — 反馈修复（2026-08-16）：无根 tsconfig.json 的项目
// tsc_check 不再假 fail（tsc 打印帮助 exit 1 / errorCount 0），改为：
//   自动发现 tsconfig.*.json（--project）/ 接受显式 tsconfig 参数 / 真无配置 → no_tsconfig
// 覆盖：无配置无TS源 / 无配置有TS源 / 单子配置自动发现 / 显式覆盖 / 显式缺失 /
//       --project 后仍 help 兜底 / 根 tsconfig 现状保持 / tsconfig 逃逸拦截
import { join, dirname } from 'node:path'
import { mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(tmpdir(), 'opencode', 'tsc-noconfig-t')
let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}
try { rmSync(ROOT, { recursive: true, force: true }) } catch {}
mkdirSync(ROOT, { recursive: true })

const tscMod = await import(pathToFileURL(join(__dirname, '..', 'tools', 'tool-tsc-check', 'handler.js')).href)
const ctx = { getWorkspaceDir: (d) => d }

function mkws(name, { tsconfigs = [], withTs = true, mode = 'ok', withBin = true }) {
  const ws = join(ROOT, name)
  try { rmSync(ws, { recursive: true, force: true }) } catch {}
  mkdirSync(join(ws, 'node_modules', '.bin'), { recursive: true })
  writeFileSync(join(ws, 'FAKE_MODE'), mode)
  for (const t of tsconfigs) writeFileSync(join(ws, t), '{"compilerOptions":{},"include":["src"]}\n')
  if (withTs) writeFileSync(join(ws, 'a.ts'), `export function a(x: number) { return x }\n`)
  // 假 tsc：打印 args 供断言；FAKE_MODE=help 模拟「无根配置打印帮助 exit 1」的真实 tsc 行为
  // 平台分支：Windows 用 .cmd（findTscBin 在 win 上优先找 tsc.cmd），POSIX 用 sh 脚本
  const binName = process.platform === 'win32' ? 'tsc.cmd' : 'tsc'
  const fake = process.platform === 'win32'
    ? [
        '@echo off',
        'echo ARGS:%*',
        'set /p MODE= < FAKE_MODE',
        'if "%MODE%"=="help" (',
        '  echo Version 5.5.4',
        '  echo Usage: tsc [options] [file...]',
        '  exit /b 1',
        ')',
        'exit /b 0',
      ].join('\r\n') + '\r\n'
    : [
        '#!/bin/sh',
        'echo "ARGS:$@"',
        'MODE="$(cat ./FAKE_MODE 2>/dev/null)"',
        'if [ "$MODE" = "help" ]; then',
        '  echo "Version 5.5.4"',
        '  echo "Usage: tsc [options] [file...]"',
        '  echo "  --all  Show all compiler options"',
        '  exit 1',
        'fi',
        'exit 0',
      ].join('\n') + '\n'
  const bin = join(ws, 'node_modules', '.bin', binName)
  if (withBin) { writeFileSync(bin, fake); chmodSync(bin, 0o755) }
  return ws
}

// ① 无 tsconfig 且无 TS 源 → no_tsconfig（不进 tsc）
{
  const ws = mkws('a-none', { withTs: false })
  const r = await tscMod.handle({ workspace_dir: ws }, ctx)
  assert(r.error === 'no_tsconfig', `① 无配置无TS源 → no_tsconfig（得 ${r.error}）`)
  assert(!r.exitCode || r.status !== 'fail', `① 不再假 fail（exitCode=${r.exitCode} status=${r.status}）`)
}

// ② 无 tsconfig 但有 TS 源 → no_tsconfig + 建议建配置
{
  const ws = mkws('b-hasts', { tsconfigs: [], withTs: true })
  const r = await tscMod.handle({ workspace_dir: ws }, ctx)
  assert(r.error === 'no_tsconfig', `② 无配置有TS源 → no_tsconfig（得 ${r.error}）`)
  assert(r.suggestion && r.suggestion.includes('tsconfig'), `② 建议涉及 tsconfig（得 ${(r.suggestion || '').slice(0, 50)}...）`)
  assert(r.message.includes('TS sources present'), `② 明确有 TS 源但无配置（得 ${r.message.slice(0, 50)}...）`)
}

// ③ 单子配置 tsconfig.src.json → 自动发现 --project → pass
{
  const ws = mkws('c-single', { tsconfigs: ['tsconfig.src.json'] })
  const r = await tscMod.handle({ workspace_dir: ws }, ctx)
  assert(r.status === 'pass' && r.exitCode === 0, `③ 自动发现子配置 → pass（得 ${r.status}/${r.exitCode}）`)
  assert(r.stdout.includes('--project tsconfig.src.json'), `③ 确实走 --project tsconfig.src.json（得 ${(r.stdout || '').slice(0, 60)}...）`)
}

// ④ 显式 tsconfig 覆盖自动发现
{
  const ws = mkws('d-explicit', { tsconfigs: ['tsconfig.src.json', 'tsconfig.client.json'] })
  const r = await tscMod.handle({ workspace_dir: ws, tsconfig: 'tsconfig.client.json' }, ctx)
  assert(r.status === 'pass', `④ 显式 tsconfig 走指定配置（得 ${r.status}）`)
  assert(r.stdout.includes('--project tsconfig.client.json'), `④ --project 指向显式配置（得 ${(r.stdout || '').slice(0, 60)}...）`)
}

// ⑤ 显式 tsconfig 不存在 → no_tsconfig
{
  const ws = mkws('e-missing', { tsconfigs: ['tsconfig.src.json'] })
  const r = await tscMod.handle({ workspace_dir: ws, tsconfig: 'tsconfig.nope.json' }, ctx)
  assert(r.error === 'no_tsconfig' && r.message.includes('tsconfig not found'), `⑤ 显式缺失 → no_tsconfig（得 ${r.error}）`)
}

// ⑥ --project 仍打印 help（坏配置）→ help 兜底 no_tsconfig，而非假 fail
{
  const ws = mkws('f-help', { tsconfigs: ['tsconfig.scanner.json'], mode: 'help' })
  const r = await tscMod.handle({ workspace_dir: ws }, ctx)
  assert(r.error === 'no_tsconfig', `⑥ help 兜底 → no_tsconfig（得 ${r.error}）`)
  assert(r.exitCode === undefined, `⑥ 不输出 exitCode 假 fail（exitCode=${r.exitCode}）`)
}

// ⑦ 根 tsconfig.json 现状保持（无 --project）
{
  const ws = mkws('g-root', { tsconfigs: ['tsconfig.json'] })
  const r = await tscMod.handle({ workspace_dir: ws }, ctx)
  assert(r.status === 'pass', `⑦ 根 tsconfig 正常检查（得 ${r.status}）`)
  assert(!r.stdout.includes('--project'), `⑦ 根配置不走 --project（得 ${(r.stdout || '').slice(0, 60)}...）`)
}

// ⑧ tsconfig 逃逸拦截
{
  const ws = mkws('h-escape', { tsconfigs: ['tsconfig.src.json'] })
  const r = await tscMod.handle({ workspace_dir: ws, tsconfig: '../evil.json' }, ctx)
  assert(r.error === 'path_blocked', `⑧ tsconfig 逃逸拦截（得 ${r.error}）`)
}

// ⑨ 有配置 + TS 源 + tsc 缺失 → tsc_not_found（原语义保留）
{
  const ws = mkws('i-notfound', { tsconfigs: ['tsconfig.src.json'], withBin: false })
  const r = await tscMod.handle({ workspace_dir: ws }, ctx)
  assert(r.error === 'tsc_not_found', `⑨ tsc 缺失 → tsc_not_found（得 ${r.error}）`)
}

try { rmSync(ROOT, { recursive: true, force: true }) } catch {}
console.log(`== test-tsc-noconfig: ${pass} passed, ${fail} failed ==`)
process.exit(fail > 0 ? 1 : 0)