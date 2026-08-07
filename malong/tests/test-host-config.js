// test-host-config.js — MCP 宿主中立状态目录（r37）
// 覆盖：MALONG_STATE_DIR 定向 / 默认 ~/.config/malong / 旧 ~/.config/opencode 回退读取 /
//       会话 ID 通用探测（OPENCODE_SESSION / MCP_SESSION_ID / SESSION_ID）
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; console.error('  FAIL:', msg) }
}
const hc = await import(pathToFileURL(join(__dirname, '..', 'host-config.js')).href)

const TMP = join(os.tmpdir(), 'opencode', 'host-config-test')
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })
const oldHome = process.env.HOME
const oldState = process.env.MALONG_STATE_DIR

// ── 默认目录：~/.config/malong（HOME 定向下）──
{
  process.env.HOME = TMP
  delete process.env.MALONG_STATE_DIR
  assert(hc.getStateDir() === join(TMP, '.config', 'malong'), `默认状态目录（${hc.getStateDir()}）`)
  assert(hc.resolveStateFile('x.jsonl') === join(TMP, '.config', 'malong', 'x.jsonl'), 'resolveStateFile 默认目录')
}

// ── MALONG_STATE_DIR 覆盖 ──
{
  const custom = join(TMP, 'custom-state')
  process.env.MALONG_STATE_DIR = custom
  assert(hc.getStateDir() === custom, 'MALONG_STATE_DIR 覆盖生效')
  assert(hc.resolveStateFile('x.jsonl') === join(custom, 'x.jsonl'), 'resolveStateFile 跟随覆盖')
}

// ── ensureStateDir 创建目录 ──
{
  const custom = join(TMP, 'ensure-dir')
  process.env.MALONG_STATE_DIR = custom
  hc.ensureStateDir()
  assert(existsSync(custom), 'ensureStateDir 创建目录')
}

// ── 旧路径回退读取：新文件缺失时读 ~/.config/opencode/ 同名文件 ──
{
  process.env.HOME = TMP
  delete process.env.MALONG_STATE_DIR
  mkdirSync(join(TMP, '.config', 'opencode'), { recursive: true })
  const legacy = join(TMP, '.config', 'opencode', 'malong-usage.jsonl')
  writeFileSync(legacy, '{"legacy":true}\n')
  assert(hc.readStateFile('malong-usage.jsonl') === legacy, '新文件缺失时回退旧 opencode 路径')
  const p = hc.readStateFile('nonexistent.jsonl')
  assert(p === join(TMP, '.config', 'malong', 'nonexistent.jsonl'), '新旧均缺失时返回新路径')
}

// ── 新路径优先：两处都有时读新 ──
{
  process.env.HOME = TMP
  delete process.env.MALONG_STATE_DIR
  mkdirSync(join(TMP, '.config', 'malong'), { recursive: true })
  writeFileSync(join(TMP, '.config', 'malong', 'malong-usage.jsonl'), '{"new":true}\n')
  writeFileSync(join(TMP, '.config', 'opencode', 'malong-usage.jsonl'), '{"legacy":true}\n')
  const p = hc.readStateFile('malong-usage.jsonl')
  assert(p === join(TMP, '.config', 'malong', 'malong-usage.jsonl'), '新路径优先')
}

// ── 会话 ID 通用探测 ──
{
  const oldOs = process.env.OPENCODE_SESSION
  const oldMs = process.env.MCP_SESSION_ID
  const oldS = process.env.SESSION_ID
  delete process.env.OPENCODE_SESSION; delete process.env.MCP_SESSION_ID; delete process.env.SESSION_ID
  assert(hc.getSessionId() === '', '无任何会话 env 时为空串')
  process.env.OPENCODE_SESSION = 'oc-1'
  assert(hc.getSessionId() === 'oc-1', 'OPENCODE_SESSION 优先')
  delete process.env.OPENCODE_SESSION
  process.env.MCP_SESSION_ID = 'mcp-2'
  assert(hc.getSessionId() === 'mcp-2', 'MCP_SESSION_ID 探测')
  delete process.env.MCP_SESSION_ID
  process.env.SESSION_ID = 's-3'
  assert(hc.getSessionId() === 's-3', 'SESSION_ID 探测')
  if (oldOs) process.env.OPENCODE_SESSION = oldOs
  if (oldMs) process.env.MCP_SESSION_ID = oldMs
  if (oldS) process.env.SESSION_ID = oldS
}

// ── 环境还原 ──
{
  if (oldHome) process.env.HOME = oldHome
  if (oldState) process.env.MALONG_STATE_DIR = oldState
  else delete process.env.MALONG_STATE_DIR
}

rmSync(TMP, { recursive: true, force: true })
console.log(`== test-host-config: ${pass} passed, ${fail} failed ==`)
if (fail > 0) process.exit(1)
