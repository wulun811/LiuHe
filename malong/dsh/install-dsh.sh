#!/usr/bin/env bash
# install-dsh.sh — LiuHe DSH adapter plugin one-shot installer
# Idempotent: safe to re-run; removes any old dsh-mcp-client entry if present.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN="$SCRIPT_DIR/dsh-bridge.mjs"
SERVER="$SCRIPT_DIR/../mcp-server.js"
PROFILE_DIR="${DSH_HOME:-$HOME/.dsh}/profiles/web"
PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"
STATE_DIR="$HOME/.local/state/malong-dsh"

if [ ! -f "$SERVER" ]; then
  echo "Error: mcp-server.js not found (expected $SERVER)" >&2
  exit 1
fi
if [ ! -f "$PLUGIN" ]; then
  echo "Error: dsh-bridge.mjs not found (expected $PLUGIN)" >&2
  exit 1
fi
if [ ! -f "$PATCH_FILE" ]; then
  echo "Error: dsh profile config not found (expected $PATCH_FILE). Install and run dsh web once first." >&2
  exit 1
fi

mkdir -p "$STATE_DIR"

if grep -q "malong-dsh-bridge" "$PATCH_FILE"; then
  echo "Already installed (cordis.patch.yml contains malong-dsh-bridge). Will still remove any old dsh-mcp-client entry."
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

# Drop insert blocks left empty by the removal (- insert: with no children)
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
print(f"Removed old dsh-mcp-client entries x{removed}")
PYEOF
  exit 0
fi

cp "$PATCH_FILE" "$PATCH_FILE.bak.$(date +%Y%m%d%H%M%S)"
echo "Backed up: $PATCH_FILE.bak.*"

python3 - "$PATCH_FILE" "$PLUGIN" "$SERVER" "$STATE_DIR" <<'PYEOF'
import sys, re

patch_file, plugin, server, state_dir = sys.argv[1:5]
with open(patch_file, encoding="utf-8") as f:
    lines = f.readlines()

# 1. Remove any old dsh-mcp-client entry (- id: mcp-malong, top-level or inside an insert block)
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

# Drop insert blocks left empty by the removal (- insert: with no children)
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

# 2. Append the malong-dsh-bridge entry
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

print(f"Wrote {patch_file}")
if removed:
    print(f"Removed old dsh-mcp-client entries x{removed}")
print("Plugin entry: id=malong-dsh-bridge, stateDir=%s" % state_dir)
PYEOF

echo
echo "Install complete. Restart dsh web to apply:"
echo "  pkill -f 'dsh web' && dsh web --port 3456 --host 0.0.0.0 --trusted-host <your-LAN-IP>"
echo "Verify: dsh web --dump-config | grep -A6 malong-dsh-bridge"
