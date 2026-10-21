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
  --exclude='/bin/' \
  --exclude='.gitignore' --exclude='.ai-patterns.json' --exclude='PROJECT_RULES.md' \
  --exclude='.ai-transactions' --exclude='.malongignore.bak' \
  "$MALONG_ROOT" server/

echo "[reprep] parser binaries NOT bundled; optionalDependencies removed in 0.5.13 (declared 0.5.9 never existed) — SET MALONG_PARSE_BIN or install ~/.local/bin/malong-parse; see README Platform support"

echo "[reprep] copying bridge ..."
# 0.5.13：一体包所需的 serverPath 回退已上移到 dsh-bridge.mjs 源码（defaultServerPath），
# 此处只做复制。旧版在这里用 python 字符串替换改 import/赋值，断言随源码行变动即失效
# （本轮就因加了 readFileSync 而炸）——不再需要。
cp "$MALONG_ROOT/dsh/dsh-bridge.mjs" dsh-bridge.mjs
node --check dsh-bridge.mjs

echo "[reprep] bundle tree ready: $(du -sh server | cut -f1) server/"
if [ "${1:-}" = "--pack" ]; then
  npm pack
fi
