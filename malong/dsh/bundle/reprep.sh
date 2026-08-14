#!/usr/bin/env bash
# 重建 @jieai/dsh-malong-bridge 发布物（一处维护：代码在 malong/，此脚本生成 bundle 快照）
# 用法：cd malong/dsh/bundle && ./reprep.sh [--pack]
set -euo pipefail
cd "$(dirname "$0")"
MALONG_ROOT="../../"          # liuhe/malong/

echo "[reprep] syncing server/ from malong/ ..."
rm -rf server
rsync -a \
  --exclude='node_modules' --exclude='data' --exclude='docs' --exclude='dsh' \
  --exclude='tests' --exclude='scripts' --exclude='benchmarks' \
  --exclude='package.json' --exclude='package-lock.json' --exclude='.malong' \
  --exclude='.gitignore' --exclude='.ai-patterns.json' --exclude='PROJECT_RULES.md' \
  "$MALONG_ROOT" server/

echo "[reprep] platform binaries NOT bundled (esbuild-style: npm optionalDependencies pull @jieai/malong-parse-<platform>)"

echo "[reprep] patching bridge (bundle fallback) ..."
cp "$MALONG_ROOT/dsh/dsh-bridge.mjs" dsh-bridge.mjs
python3 - <<'PYEOF'
p = 'dsh-bridge.mjs'
s = open(p).read()
old = '''import { dirname, join } from "node:path"
import { mkdirSync } from "node:fs"
import os from "node:os"'''
new = '''import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { mkdirSync } from "node:fs"
import os from "node:os"'''
assert old in s, 'bridge import block changed'
s = s.replace(old, new)
old2 = '''  const serverPath = cfg.serverPath
  if (typeof serverPath !== "string" || serverPath.length === 0) {'''
new2 = '''  // r0.4.5-post5（一体包）：serverPath 缺省时回退到包内 server/mcp-server.js——
  // import.meta.url 在 ESM 内恒可用，零配置安装；MALONG_SERVER_PATH 仍可覆盖
  const serverPath = cfg.serverPath ?? fileURLToPath(new URL('./server/mcp-server.js', import.meta.url))
  if (typeof serverPath !== "string" || serverPath.length === 0) {'''
assert old2 in s, 'bridge serverPath block changed'
s = s.replace(old2, new2)
open(p, 'w').write(s)
print('  bridge patched')
PYEOF

echo "[reprep] bundle tree ready: $(du -sh server | cut -f1) server/, $(ls server/bin/)"
if [ "${1:-}" = "--pack" ]; then
  npm pack
fi
