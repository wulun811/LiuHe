#!/bin/bash
# Package the full zero-dependency toolset tarball (malong/ + malong-parse/ + READMEs).
# Usage: ./scripts/package-full.sh [linux|windows|darwin] [x86_64|aarch64]
# Output: releases/malong-liuhe-<ver>-<os>-<arch>.tar.gz + .sha256
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VER="$(grep -m1 '"version"' malong/package.json | sed 's/.*: "\([0-9.]*\)".*/\1/')"
OS="${1:-linux}"   # linux | windows | darwin
ARCH="${2:-x86_64}" # x86_64 | aarch64
case "$OS" in
  linux|darwin) BIN="malong-parse/target/release/malong-parse" ;;
  windows)      BIN="malong-parse/target/release/malong-parse.exe" ;;
  *) echo "unsupported os: $OS"; exit 1 ;;
esac
[ -f "$BIN" ] || { echo "binary not found: $BIN (build it first: cargo build --release)"; exit 1; }

mkdir -p releases
PKG="releases/malong-liuhe-${VER}-${OS}-${ARCH}.tar.gz"
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

# macOS 无 sha256sum，用 shasum -a 256 兼容
if command -v sha256sum >/dev/null 2>&1; then
  SHA=$(sha256sum "$PKG" | awk '{print $1}')
else
  SHA=$(shasum -a 256 "$PKG" | awk '{print $1}')
fi
echo "$SHA  $PKG" > "$PKG.sha256"
echo "== artifact =="
ls -lh "$PKG"
echo "$SHA  $(basename "$PKG")"
