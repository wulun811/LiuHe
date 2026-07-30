#!/bin/bash
# 验证 Rust 端和 Node.js 端输出一致
# 对 fixtures 目录下每个文件，两端跑 extract_all，diff JSON 输出

set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
FIXTURES="$DIR/fixtures"
MALONG_DIR="$DIR/../../docs/六合工具集/malong"
DIFFS=0
PASS=0
FAIL=0

if ! command -v malong-parse &>/dev/null; then
  echo "ERROR: malong-parse binary not found in PATH"
  exit 1
fi

# Ensure malong-parse is running
if ! pgrep -x malong-parse >/dev/null; then
  echo "Starting malong-parse..."
  malong-parse &
  sleep 1
fi

for f in "$FIXTURES"/*.py "$FIXTURES"/*.js "$FIXTURES"/*.ts "$FIXTURES"/*.go "$FIXTURES"/*.rs; do
  [ -f "$f" ] || continue
  base=$(basename "$f")
  ext="${f##*.}"
  case "$ext" in
    py) lang="python" ;;
    js|mjs|cjs) lang="javascript" ;;
    ts|tsx) lang="typescript" ;;
    go) lang="go" ;;
    rs) lang="rust" ;;
    *) lang="" ;;
  esac
  [ -z "$lang" ] && continue

  echo -n "[check] $base ($lang) ... "

  # Node.js side
  node -e "
    import('$MALONG_DIR/lang-parser.js').then(async m => {
      const fs = await import('fs');
      const src = fs.readFileSync('$f', 'utf-8');
      const core = { log: () => {}, registerService: () => {}, getService: () => null, getWorkspaceDir: () => '/tmp' };
      await m.init(core);
      const tree = m.LANG_HANDLERS['$lang'];
      const p = new (await import('tree-sitter'))();
      const grammars = {
        javascript: await import('tree-sitter-javascript'),
        python: await import('tree-sitter-python'),
        go: await import('tree-sitter-go'),
        rust: await import('tree-sitter-rust'),
      };
      if (grammars['$lang']) p.setLanguage(grammars['$lang'].default || grammars['$lang']);
      const t = p.parse(src);
      if (t) {
        const result = tree.extractAll(t, src);
        fs.writeFileSync('$FIXTURES/$base.node.json', JSON.stringify(result, null, 2));
      }
      process.exit(0);
    }).catch(e => { console.error(e); process.exit(1) });
  " 2>/dev/null

  # Rust side
  node -e "
    import('$MALONG_DIR/parse-client.js').then(async pc => {
      const fs = await import('fs');
      const src = fs.readFileSync('$f', 'utf-8');
      const core = { log: () => {} };
      await pc.init(core);
      const ok = await pc.connect();
      if (!ok) { console.error('Rust service not connected'); process.exit(1); }
      const result = await pc.extractAll(src, '.$ext');
      fs.writeFileSync('$FIXTURES/$base.rust.json', JSON.stringify(result, null, 2));
      process.exit(0);
    }).catch(e => { console.error(e); process.exit(1) });
  " 2>/dev/null

  # Diff
  if diff -q "$FIXTURES/$base.node.json" "$FIXTURES/$base.rust.json" >/dev/null 2>&1; then
    echo "PASS"
    PASS=$((PASS+1))
  else
    echo "DIFF"
    DIFFS=$((DIFFS+1))
    diff "$FIXTURES/$base.node.json" "$FIXTURES/$base.rust.json" 2>/dev/null | head -20
  fi
done

echo "---"
echo "Pass: $PASS, Diff: $DIFFS"

# Clean up temp files
rm -f "$FIXTURES"/*.node.json "$FIXTURES"/*.rust.json

[ "$DIFFS" -eq 0 ]
