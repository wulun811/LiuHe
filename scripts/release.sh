#!/bin/bash
# Release packaging: build release binary, bundle tar.gz + sha256 for Gitea Releases.
# Usage: ./scripts/release.sh [tag]   (defaults to the latest git tag)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TAG="${1:-$(git -C "$ROOT" describe --tags --abbrev=0 2>/dev/null || echo v0.3.32)}"
VER="${TAG#v}"

echo "== building release $TAG =="
(cd "$ROOT/malong-parse" && cargo build --release)

BIN="$ROOT/malong-parse/target/release/malong-parse"
[ -x "$BIN" ] || { echo "binary not found: $BIN"; exit 1; }

STAGE="$(mktemp -d)"
cp "$BIN" "$STAGE/malong-parse"
cp "$ROOT/LICENSE" "$STAGE/LICENSE"
printf 'Malong LiuHe %s — Linux x86_64\nRust tree-sitter parsing daemon. See https://github.com or the repo README for usage.\n' "$TAG" > "$STAGE/README.txt"

# 产物放仓库内 releases/ 目录：Gitea→GitHub 跳转复制会带仓库内文件（Releases 附件不搬）
REL="$ROOT/releases"
mkdir -p "$REL"
PKG="$REL/malong-parse-${VER}-linux-x86_64.tar.gz"
tar -czf "$PKG" -C "$STAGE" malong-parse LICENSE README.txt
rm -rf "$STAGE"

echo "== artifact =="
ls -lh "$PKG"
SHA=$(sha256sum "$PKG" | awk '{print $1}')
echo "$SHA  $PKG" > "$PKG.sha256"
echo "$SHA  $(basename "$PKG")"
echo ""
echo "== 提交并推送后 GitHub 用户即可下载（仓库内文件随复制走）=="
echo "  git add releases/ && git commit -m \"release: add binary artifact\" && git push"
