#!/bin/bash
# CI entry: cargo test + npm test + dogfood suites — self-contained, zero external services.
# Reuses an already-running malong-parse daemon if healthy; otherwise starts one and cleans up.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UID_SOCK="/tmp/malong-parse-$(id -u).sock"
UID_PID="/tmp/malong-parse-$(id -u).pid"

daemon_alive() {
  [ -S "$UID_SOCK" ] && [ -f "$UID_PID" ] && kill -0 "$(cat "$UID_PID" 2>/dev/null)" 2>/dev/null
}

STARTED_DAEMON=0
if ! daemon_alive; then
  echo "== starting malong-parse (debug build) =="
  (cd "$ROOT/malong-parse" && cargo build)
  "$ROOT/malong-parse/target/debug/malong-parse" > /tmp/malong-parse-ci.log 2>&1 &
  for i in $(seq 1 20); do
    daemon_alive && STARTED_DAEMON=1 && break
    sleep 0.5
  done
  if [ "$STARTED_DAEMON" != 1 ]; then
    echo "ERROR: malong-parse did not start"; tail -5 /tmp/malong-parse-ci.log; exit 1
  fi
  echo "== daemon started (pid $(cat "$UID_PID")) =="
else
  echo "== reusing running daemon (pid $(cat "$UID_PID")) =="
fi

trap 'if [ "$STARTED_DAEMON" = 1 ]; then kill "$(cat "$UID_PID" 2>/dev/null)" 2>/dev/null || true; rm -f "$UID_SOCK" "$UID_PID"; fi' EXIT

echo "== cargo test =="
(cd "$ROOT/malong-parse" && cargo test)

echo "== npm ci + npm test =="
(cd "$ROOT/malong" && npm ci --no-audit --no-fund && npm test)

echo "== dogfood suites =="
for t in r14 r30; do
  node "$ROOT/malong/tests/test-dogfood-$t.js"
done

echo "== git cleanliness =="
if [ -n "$(git -C "$ROOT" status --porcelain)" ]; then
  echo "WARNING: working tree not clean after CI"; git -C "$ROOT" status --porcelain | head
else
  echo "clean"
fi

echo "== CI PASSED =="
