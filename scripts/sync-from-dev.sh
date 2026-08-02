#!/bin/bash
# Sync the open-source repo (liuhe/) from the development repo (0bore/).
# Replays the open-source adaptations after copying, so the OSS tree stays runnable.
#
# Usage:
#   ./scripts/sync-from-dev.sh [dev-root] [--dry-run]
#   dev-root defaults to /home/chen/1q/0bore
#
# Does NOT push — pushing needs credentials, do it manually:
#   git remote set-url origin http://user:pass@host/... && git push origin master && git remote set-url origin http://host/...
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEV="${1:-/home/chen/1q/0bore}"
DRY=0
[ "${2:-}" = "--dry-run" ] && DRY=1

[ -d "$DEV" ] || { echo "ERROR: dev root not found: $DEV"; exit 1; }

# Dev repo layout: engine at <dev>/malong-parse, toolset at <dev>/malong OR <dev>/docs/六合工具集/malong
if [ -d "$DEV/malong" ]; then
  DEV_MALONG="$DEV/malong"
elif [ -d "$DEV/docs/六合工具集/malong" ]; then
  DEV_MALONG="$DEV/docs/六合工具集/malong"
else
  echo "ERROR: toolset not found under $DEV (looked for malong/ and docs/六合工具集/malong/)"; exit 1
fi
[ -d "$DEV/malong-parse" ] || { echo "ERROR: engine not found: $DEV/malong-parse"; exit 1; }
echo "== dev toolset: $DEV_MALONG =="

EXCLUDES=(
  --exclude node_modules
  --exclude target
  --exclude .index-cache
  --exclude '*.log'
  --exclude '.pytest_cache'
  --exclude '__pycache__'
  --exclude '.malong'
  --exclude 'data'
  # internal-deployment tests removed in the OSS repo (contain absolute paths)
  --exclude 'tests/deploy-check.js'
  --exclude 'tests/measure-tools.js'
  --exclude 'tests/stress-test.js'
  --exclude 'tests/stress-driver.mjs'
)

echo "== rsync malong/ =="
rsync -a --delete "${EXCLUDES[@]}" "$DEV_MALONG/" "$ROOT/malong/"
echo "== rsync malong-parse/ =="
rsync -a --delete --exclude target --exclude .index-cache --exclude '*.log' "$DEV/malong-parse/" "$ROOT/malong-parse/"

echo "== replay OSS adaptations =="
ADAPT=$(python3 - "$ROOT" << 'PY'
import re, sys
root = sys.argv[1]
def sub(path, old, new, tag):
    s = open(path).read()
    if old not in s:
        print(f"WARN: adaptation anchor missing in {path} ({tag}) — check manually", file=sys.stderr)
        return False
    open(path, 'w').write(s.replace(old, new))
    return True
ok = True
# depth: OSS layout puts malong/ one level under repo root (dev had 3 levels)
ok &= sub(f"{root}/malong/code-index.js",
    "join(__dirname, '..', '..', '..', 'malong-parse'", "join(__dirname, '..', 'malong-parse'", "code-index alt bin path")
ok &= sub(f"{root}/malong/mcp-server.js",
    "join(__dirname, '..', '..', '..', 'malong-parse'", "join(__dirname, '..', 'malong-parse'", "mcp-server alt bin path")
# daemon binary path: environment-driven in OSS
ok &= sub(f"{root}/malong/tests/test-kill-recover.js",
    "execSync('setsid /home/chen/.local/bin/malong-parse &', { stdio: 'ignore' })",
    "execSync(`setsid ${process.env.MALONG_PARSE_BIN || 'malong-parse'} &`, { stdio: 'ignore' })", "kill-recover bin path")
ok &= sub(f"{root}/malong/tests/test-reconnect-queue.js",
    "const BIN = '/home/chen/.local/bin/malong-parse'",
    "const BIN = process.env.MALONG_PARSE_BIN || 'malong-parse'", "reconnect-queue bin path")
# cross-language consistency script path
ok &= sub(f"{root}/malong-parse/tests/check-consistency.sh",
    "import('$DIR/../../docs/六合工具集/malong/parse-client.js')",
    "import('$DIR/../../malong/parse-client.js')", "check-consistency path")
sys.exit(0 if ok else 1)
PY
) || echo "NOTE: some adaptations skipped — review before committing"

echo "== protect OSS metadata (dev repo carries different values) =="
python3 - "$ROOT" << 'PY'
import sys
root = sys.argv[1]
def sub(path, old, new, tag):
    s = open(path).read()
    if old not in s:
        print(f"WARN: metadata anchor missing in {path} ({tag}) — check manually", file=sys.stderr)
        return False
    open(path, 'w').write(s.replace(old, new))
    return True
ok = True
# Cargo.toml: version/license/repository are OSS-side only (dev stays at 0.1.0, no metadata)
ok &= sub(f"{root}/malong-parse/Cargo.toml",
    'version = "0.1.0"\nedition = "2021"',
    'version = "0.3.32"\nedition = "2021"\ndescription = "Rust tree-sitter multi-language symbol extraction engine for the Malong LiuHe (码龙·六合工具) LLM-native code toolkit"\nlicense = "MIT"\nrepository = "https://github.com/wulun811/LiuHe"', "cargo metadata")
sys.exit(0 if ok else 1)
PY
echo "== align package.json version with OSS changelog =="
OPEN_VER=$(grep -m1 '^## \[' "$ROOT/CHANGELOG.md" | sed 's/## \[\([0-9.]*\)\].*/\1/')
python3 - "$ROOT" "$OPEN_VER" << 'PY'
import json, sys
root, ver = sys.argv[1], sys.argv[2]
p = f"{root}/malong/package.json"
d = json.load(open(p))
d['version'] = ver
json.dump(d, open(p, 'w'), indent=2, ensure_ascii=False)
open(p, 'a').write('\n')
print(f"  version aligned to {ver}")
PY

DEV_SHA=$(git -C "$DEV" log -1 --format='%h %s' 2>/dev/null | head -c 100)

if [ "$DRY" = 1 ]; then
  echo "== DRY-RUN — changes staged on disk only, no commit =="
  git -C "$ROOT" status --porcelain | head -20
  exit 0
fi

echo "== committing =="
git -C "$ROOT" add -A
if git -C "$ROOT" diff --cached --quiet; then
  echo "no changes to commit"
else
  git -C "$ROOT" commit -q -m "sync: from dev ${DEV_SHA}"
  echo "committed: $(git -C "$ROOT" log -1 --format='%h')"
fi

echo "== done. push manually (credentials) =="
echo "  git remote set-url origin http://USER:PASS@8.137.167.237:3000/cjg007/liuhe.git"
echo "  git push origin master && git push origin --tags"
echo "  git remote set-url origin http://8.137.167.237:3000/cjg007/liuhe.git"
