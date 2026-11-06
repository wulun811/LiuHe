// test-dev-collect.js — scripts/dev-collect.sh：采集开关的唯一真相
//
// 背景（2026-11-02）：桌面 opencode 脚本与 DSH 脚本各写两行 export，两处同时维护必然漂。
// 最贵的失败是「以为在采、其实 off」——P3 三天样本白等，而且没人会发现。
//
// 本测试把开关钉成合同：
//   ① 四个档位各自的开关组合（off / trace / misses / all）
//   ② off 必须**主动 unset**：父进程里残留的 MALONG_TRACE 不得漏进子进程
//      （只“不设置”= 关不干净，这条是核心回归）
//   ③ 档位大小写/空白宽松，未知档位按 off 且必须出声（不能静默当 all）
//   ④ 恒返回 0：调用方脚本普遍带 set -e，source 失败会让服务起不来
//   ⑤ 自身不写盘、不联网、不依赖外部命令（只用 shell 内建 + tr）
import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(ROOT, 'scripts', 'dev-collect.sh')

let passed = 0
let failed = 0
function assert(cond, msg) {
  if (cond) { passed++ } else { failed++; console.error(`FAIL: ${msg}`) }
}

// Windows 复核（2026-11-06）：写死 POSIX PATH 时 win32 找不到 bash（spawn ENOENT，
// stdout 为空 → TRACE=undefined）。只保留宿主 PATH 即可隔离 MALONG_* 污染，同时跨平台。
const SAFE_PATH = process.env.PATH || '/usr/local/bin:/usr/bin:/bin'

// 在干净 shell 里 source 本文件，把结果两个变量与退出码带回来
function runWith(env, { preset = {} } = {}) {
  const presets = Object.entries(preset)
    .map(([k, v]) => `export ${k}='${v}'`)
    .join('\n')
  const script = `
${presets}
. '${SCRIPT}'
code=$?
printf 'RC=%s TRACE=%s MISS=%s\\n' "$code" "\${MALONG_TRACE-<unset>}" "\${MALONG_SEARCH_LOG-<unset>}"
`
  const r = spawnSync('bash', ['-c', script], {
    encoding: 'utf-8',
    // 用最小 env，避免测试机自身的 MALONG_* 混进来
    env: { PATH: SAFE_PATH, ...env },
  })
  const out = String(r.stdout || '')
  const m = out.match(/RC=(\S+) TRACE=(\S+) MISS=(\S+)/)
  return { ...(m ? { rc: m[1], trace: m[2], miss: m[3] } : {}), stdout: out, stderr: String(r.stderr || ''), status: r.status }
}

// ── ① 四个档位 ──
{
  let r = runWith({ MALONG_DEV_COLLECT: 'all' })
  assert(r.trace === 'all' && r.miss === 'misses', `① all → 两个都开（得 TRACE=${r.trace} MISS=${r.miss}）`)

  r = runWith({ MALONG_DEV_COLLECT: 'trace' })
  assert(r.trace === 'all' && r.miss === '<unset>', `① trace → 只开轨迹（得 TRACE=${r.trace} MISS=${r.miss}）`)

  r = runWith({ MALONG_DEV_COLLECT: 'misses' })
  assert(r.trace === '<unset>' && r.miss === 'misses', `① misses → 只开 MISS（得 TRACE=${r.trace} MISS=${r.miss}）`)

  r = runWith({ MALONG_DEV_COLLECT: 'off' })
  assert(r.trace === '<unset>' && r.miss === '<unset>', `① off → 两个都不设（得 TRACE=${r.trace} MISS=${r.miss}）`)

  r = runWith({})
  assert(r.trace === '<unset>' && r.miss === '<unset>', `① 未设档位 → 默认 off（得 TRACE=${r.trace} MISS=${r.miss}）`)
}

// ── ② 核心回归：off 必须把父进程残留变量清掉 ──
// 只“不设置”是不够的——父进程的 MALONG_TRACE 会原样继承进 MCP 子进程，
// 于是“我关掉了”只是假象（真机踩过：以为 off，其实 all 还在采）。
{
  const r = runWith({ MALONG_DEV_COLLECT: 'off' }, { preset: { MALONG_TRACE: 'all', MALONG_SEARCH_LOG: 'misses' } })
  assert(r.trace === '<unset>', `② off 必须 unset 残留的 MALONG_TRACE（得 ${r.trace}）`)
  assert(r.miss === '<unset>', `② off 必须 unset 残留的 MALONG_SEARCH_LOG（得 ${r.miss}）`)

  // 档位之间也要互相清理：从 all 切到 trace，MISS 不能残留
  const r2 = runWith({ MALONG_DEV_COLLECT: 'trace' }, { preset: { MALONG_SEARCH_LOG: 'misses' } })
  assert(r2.miss === '<unset>', `② trace 档必须清掉残留的 MISS 开关（得 ${r2.miss}）`)
}

// ── ③ 宽松输入 + 未知档位出声 ──
{
  const r = runWith({ MALONG_DEV_COLLECT: '  ALL  ' })
  assert(r.trace === 'all' && r.miss === 'misses', `③ 大小写/空白宽松（得 TRACE=${r.trace} MISS=${r.miss}）`)

  const bad = runWith({ MALONG_DEV_COLLECT: 'verbose' })
  assert(bad.trace === '<unset>' && bad.miss === '<unset>', `③ 未知档位按 off（得 TRACE=${bad.trace} MISS=${bad.miss}）`)
  assert(/unknown MALONG_DEV_COLLECT/.test(bad.stderr), `③ 未知档位必须在 stderr 出声（得 ${JSON.stringify(bad.stderr.slice(0, 80))}）`)
}

// ── ④ 恒返回 0（调用方带 set -e） ──
{
  const script = `set -euo pipefail\n. '${SCRIPT}'\necho SURVIVED`
  const r = spawnSync('bash', ['-c', script], {
    encoding: 'utf-8',
    env: { PATH: SAFE_PATH, MALONG_DEV_COLLECT: 'all' },
  })
  assert(r.status === 0 && /SURVIVED/.test(r.stdout), `④ 在 set -euo pipefail 下可安全 source（得 status=${r.status} out=${r.stdout.trim()}）`)

  // 未知档位也不能弄死调用方
  const r2 = spawnSync('bash', ['-c', `set -euo pipefail\n. '${SCRIPT}'\necho SURVIVED`], {
    encoding: 'utf-8',
    env: { PATH: SAFE_PATH, MALONG_DEV_COLLECT: 'bogus' },
  })
  assert(r2.status === 0 && /SURVIVED/.test(r2.stdout), `④ 未知档位也不得让 set -e 退出（得 status=${r2.status}）`)
}

// ── ⑤ 不留中间变量、不写盘、不起子进程以外的动作 ──
{
  const r = runWith({ MALONG_DEV_COLLECT: 'all' })
  assert(!/_malong_dev_collect_mode/.test(r.stdout), '⑤ 内部变量用完即清，不污染调用方环境')
  assert(existsSync(SCRIPT), '⑤ 脚本在预期位置')
  const body = readFileSync(SCRIPT, 'utf-8')
  assert(!/\bcurl\b|\bwget\b|\bnode\b|\bnpm\b/.test(body), '⑤ 不联网、不拉起 node/npm（纯 shell）')
  assert(!/>\s*['"]?\/|\bmkdir\b|\btouch\b/.test(body), '⑤ 不写盘（无重定向到文件、无 mkdir/touch）')
}

// ── ⑥ 调用方脚本必须带守卫（R16n 审查发现）──
// 真实事故形状：启动脚本里写 `. /path/to/dev-collect.sh`，一旦该文件被删/被移，
// 带 `set -euo pipefail` 的 DSH 脚本会**直接退出**——服务根本起不来，
// 而且日志里只有一行 “No such file or directory”，看不出是开关文件惹的祸。
// 另一面：光加 `[ -f ]` 守卫还不够，缺文件时必须**主动 unset** 继承来的开关，
// 否则“默认 off”只是假象（父进程残值会原样漏进来，以为关掉了其实还在采）。
{
  // 模拟启动脚本里那段逻辑（守卫 + 缺失时清理），在 set -euo pipefail 下运行
  const guarded = `
set -euo pipefail
export MALONG_DEV_COLLECT=all
MALONG_COLLECT_SH='$TARGET'
if [ -f "$MALONG_COLLECT_SH" ]; then
  . "$MALONG_COLLECT_SH"
else
  echo "WARN_MISSING" >&2
  unset MALONG_TRACE
  unset MALONG_SEARCH_LOG
fi
unset MALONG_COLLECT_SH
printf 'TRACE=%s MISS=%s\\n' "\${MALONG_TRACE-<unset>}" "\${MALONG_SEARCH_LOG-<unset>}"
`
  // ① 文件存在 → 正常按档位打开，且不报缺失告警
  const ok = spawnSync('bash', ['-c', guarded.replace('$TARGET', SCRIPT)], {
    encoding: 'utf-8',
    env: { PATH: SAFE_PATH },
  })
  assert(ok.status === 0, `⑥ 开关文件存在时启动脚本正常跑完（得 status=${ok.status}）`)
  assert(/TRACE=all MISS=misses/.test(ok.stdout), `⑥ 开关文件存在时按档位生效（得 ${ok.stdout.trim()}）`)
  assert(!/WARN_MISSING/.test(ok.stderr), '⑥ 文件存在时不得误报告警')

  // ② 文件缺失 + 父进程有残值 → 不得退出、不得静默继承
  const miss = spawnSync('bash', ['-c', guarded.replace('$TARGET', '/nonexistent/dev-collect.sh')], {
    encoding: 'utf-8',
    env: { PATH: SAFE_PATH, MALONG_TRACE: 'all', MALONG_SEARCH_LOG: 'misses' },
  })
  assert(miss.status === 0, `⑥ 开关文件缺失时不得让 set -e 退出（得 status=${miss.status}）`)
  assert(/WARN_MISSING/.test(miss.stderr), `⑥ 缺失必须出声告警（得 ${JSON.stringify(miss.stderr.slice(0, 60))}）`)
  assert(/TRACE=<unset> MISS=<unset>/.test(miss.stdout),
    `⑥ 缺失时必须清掉继承来的开关（得 ${miss.stdout.trim()}）`)
}

console.log(`\n== test-dev-collect: ${passed} passed, ${failed} failed ==`)
if (failed > 0) process.exitCode = 1
