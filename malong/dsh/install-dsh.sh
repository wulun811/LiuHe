#!/usr/bin/env bash
# install-dsh.sh — 六合工具集 DSH 适配插件一键安装
# 幂等：重复执行安全；自动移除旧的 dsh-mcp-client 条目（若存在）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN="$SCRIPT_DIR/dsh-bridge.mjs"
SERVER="$SCRIPT_DIR/../mcp-server.js"
PROFILE_DIR="${DSH_HOME:-$HOME/.dsh}/profiles/web"
PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"
STATE_DIR="$HOME/.local/state/malong-dsh"

if [ ! -f "$SERVER" ]; then
  echo "错误: 未找到 mcp-server.js（期望 $SERVER）" >&2
  exit 1
fi
if [ ! -f "$PLUGIN" ]; then
  echo "错误: 未找到 dsh-bridge.mjs（期望 $PLUGIN）" >&2
  exit 1
fi
if [ ! -f "$PATCH_FILE" ]; then
  echo "错误: 未找到 dsh profile 配置（期望 $PATCH_FILE）。请先安装并运行一次 dsh web。" >&2
  exit 1
fi

mkdir -p "$STATE_DIR"

if grep -q "malong-dsh-bridge" "$PATCH_FILE"; then
  echo "已安装（cordis.patch.yml 已包含 malong-dsh-bridge）。仍将清理旧的 dsh-mcp-client 条目（如有）。"
  python3 - "$PATCH_FILE" <<'PYEOF'
import re, sys

patch_file = sys.argv[1]
with open(patch_file, encoding="utf-8") as f:
    lines = f.readlines()

out = []
i = 0
removed = 0
while i < len(lines):
    line = lines[i]
    if re.match(r"^ {0,4}- id: mcp-malong\s*$", line):
        removed += 1
        indent = len(line) - len(line.lstrip(" "))
        i += 1
        while i < len(lines):
            nxt = lines[i]
            if re.match(r"^- ", nxt):
                break
            nxt_indent = len(nxt) - len(nxt.lstrip(" "))
            if nxt_indent <= indent and nxt.strip():
                break
            i += 1
        continue
    out.append(line)
    i += 1

# 清理因移除而变空的 insert 块（- insert: 后无子项）
final = []
i = 0
while i < len(out):
    line = out[i]
    if re.match(r"^- insert:\s*$", line):
        nxt = out[i + 1] if i + 1 < len(out) else ""
        if not nxt.strip() or re.match(r"^- ", nxt):
            i += 1
            continue
    final.append(line)
    i += 1

with open(patch_file, "w", encoding="utf-8") as f:
    f.writelines(final)
print(f"已清理旧的 dsh-mcp-client 条目 x{removed}")
PYEOF
  exit 0
fi

cp "$PATCH_FILE" "$PATCH_FILE.bak.$(date +%Y%m%d%H%M%S)"
echo "已备份: $PATCH_FILE.bak.*"

python3 - "$PATCH_FILE" "$PLUGIN" "$SERVER" "$STATE_DIR" <<'PYEOF'
import sys, re

patch_file, plugin, server, state_dir = sys.argv[1:5]
with open(patch_file, encoding="utf-8") as f:
    lines = f.readlines()

# 1. 移除旧的 dsh-mcp-client 条目（- id: mcp-malong，顶层或 insert 块内均可）
out = []
i = 0
removed = 0
while i < len(lines):
    line = lines[i]
    if re.match(r"^ {0,4}- id: mcp-malong\s*$", line):
        removed += 1
        indent = len(line) - len(line.lstrip(" "))
        i += 1
        while i < len(lines):
            nxt = lines[i]
            if re.match(r"^- ", nxt):
                break
            nxt_indent = len(nxt) - len(nxt.lstrip(" "))
            if nxt_indent <= indent and nxt.strip():
                break
            i += 1
        continue
    out.append(line)
    i += 1

# 清理因移除而变空的 insert 块（- insert: 后无子项）
final = []
i = 0
while i < len(out):
    line = out[i]
    if re.match(r"^- insert:\s*$", line):
        nxt = out[i + 1] if i + 1 < len(out) else ""
        if not nxt.strip() or re.match(r"^- ", nxt):
            i += 1
            continue
    final.append(line)
    i += 1
lines = final

# 2. 追加 malong-dsh-bridge 条目
plugin_abs = plugin
if not plugin_abs.startswith("/"):
    plugin_abs = "/" + plugin_abs
block = [
    "- insert:\n",
    "    - id: malong-dsh-bridge\n",
    f"      name: {plugin_abs}\n",
    "      config:\n",
    f"        serverPath: {server}\n",
    f"        stateDir: {state_dir}\n",
    "        toolCallTimeoutMs: 300000\n",
]
if out and not out[-1].endswith("\n"):
    out[-1] += "\n"
out.extend(block)

with open(patch_file, "w", encoding="utf-8") as f:
    f.writelines(out)

print(f"已写入 {patch_file}")
if removed:
    print(f"已移除旧的 dsh-mcp-client 条目 x{removed}")
print("插件条目: id=malong-dsh-bridge, stateDir=%s" % state_dir)
PYEOF

echo
echo "安装完成。请重启 dsh web 生效："
echo "  pkill -f 'dsh web' && dsh web --port 3456 --host 0.0.0.0 --trusted-host <你的局域网IP>"
echo "验证：dsh web --dump-config | grep -A6 malong-dsh-bridge"
