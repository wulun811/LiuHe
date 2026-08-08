#!/bin/bash
# Package the full zero-dependency toolset tarball (malong/ + malong-parse/ + READMEs).
# Usage: ./scripts/package-full.sh
# Output: releases/malong-liuhe-<ver>-<os>-x86_64.tar.gz + .sha256
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VER="$(grep -m1 '"version"' malong/package.json | sed 's/.*: "\([0-9.]*\)".*/\1/')"
OS="${1:-linux}"   # linux | windows
BIN="malong-parse/target/release/malong-parse${OS:+${OS##linux}.exe}"
case "$OS" in
  linux)   BIN="malong-parse/target/release/malong-parse" ;;
  windows) BIN="malong-parse/target/release/malong-parse.exe" ;;
esac
[ -f "$BIN" ] || { echo "binary not found: $BIN (build it first: cargo build --release)"; exit 1; }

mkdir -p releases
PKG="releases/malong-liuhe-${VER}-${OS}-x86_64.tar.gz"
# 排除项：node_modules（零依赖语义）、tests/data/.malong/.index-cache（运行时产物）、
# docs/（Y004 开发矩阵等内部文档不进发布包）、*.log
tar -czf "$PKG" \
  --exclude='malong/node_modules' \
  --exclude='malong/.index-cache' \
  --exclude='malong/.malong' \
  --exclude='malong/tests' \
  --exclude='malong/data' \
  --exclude='malong/docs' \
  --exclude='*.log' \
  README.md README.zh-CN.md malong/ "$BIN"

SHA=$(sha256sum "$PKG" | awk '{print $1}')
echo "$SHA  $PKG" > "$PKG.sha256"
echo "== artifact =="
ls -lh "$PKG"
echo "$SHA  $(basename "$PKG")"
