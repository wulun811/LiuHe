#!/bin/bash
# 验证 Rust 服务解析 fixtures 输出合法 JSON
# 输出 expected.json + 校验

set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
FIXTURES="$DIR/fixtures"
PASS=0
FAIL=0

# Ensure malong-parse is running
if ! pgrep -x malong-parse >/dev/null; then
  echo "Starting malong-parse..."
  malong-parse &
  sleep 2
fi

for f in "$FIXTURES"/*.py "$FIXTURES"/*.js "$FIXTURES"/*.mjs "$FIXTURES"/*.go "$FIXTURES"/*.rs; do
  [ -f "$f" ] || continue
  base=$(basename "$f")
  ext="${f##*.}"
  
  echo -n "[check] $base ... "

  # Rust side
  node -e "
    import('$DIR/../../docs/六合工具集/malong/parse-client.js').then(async pc => {
      const fs = await import('fs');
      const src = fs.readFileSync('$f', 'utf-8');
      const core = { log: () => {} };
      await pc.init(core);
      const ok = await pc.connect();
      if (!ok) { console.error('Rust service not connected'); process.exit(1); }
      const result = await pc.extractAll(src, '.$ext');
      fs.writeFileSync('$FIXTURES/$base.expected.json', JSON.stringify(result, null, 2));
      console.log('OK (' + result.symbols.length + ' syms, ' + result.refs.length + ' refs)');
      process.exit(0);
    }).catch(e => { console.error(e); process.exit(1) });
  " 2>&1
  
  # Verify valid JSON
  if node -e "JSON.parse(require('fs').readFileSync('$FIXTURES/$base.expected.json','utf-8'))" 2>/dev/null; then
    PASS=$((PASS+1))
  else
    echo "  INVALID JSON"
    FAIL=$((FAIL+1))
  fi
done

echo "---"
echo "Pass: $PASS, Fail: $FAIL"
[ "$FAIL" -eq 0 ]
