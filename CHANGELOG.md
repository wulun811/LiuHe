# Changelog

All notable changes to **Malong LiuHe** are documented here.

## [0.3.35] - 2026-08-02

### r35: Sandbox edition — zero-dependency SQLite (db-adapter dual-backend)

Branch product for extreme environments (Node >= 20, **no npm install, no native compilation**):

- **`db-adapter.js`**: backend auto-detection — `better-sqlite3` when available (full version, behavior 100% unchanged); otherwise falls back to the **vendored sql.js WASM** (`malong/vendor/`, MIT, zero-dependency)
- sql.js backend: read-only mtime-detected reload (auto re-reads after writer exports), transaction-granularity export with 500ms throttled merge, tmp+rename atomic write-back, `prepare/get/all/run/exec/close/transaction/pragma` shapes aligned with better-sqlite3
- 6 files migrated to `createDb` (code-index / embedded-reader / repo-map / health-check / naming-consistency); `initWorkspace` async propagation across 17 handlers and 16 test files
- `releases/` re-cut at 0.3.34 (previous 0.3.32 binary contained already-fixed bugs) — sandbox deployment: extract to `~/.local/bin`, zero cargo
- Verified in a simulated sandbox (better-sqlite3 removed): full `npm test` (11 files, 338 assertions) + mcp-server + dogfood all green; full-version regression green; `test-db-adapter` (13 assertions) locks both backends
- Third-party notice: `THIRD_PARTY_NOTICES.md` (sql.js 1.12.0, MIT)
- README (EN/ZH): "Zero-build deployment" section

## [0.3.34] - 2026-08-02

### r34 + r34-fix: Test coverage drive-out — 5 real bugs fixed, 970+ JS / 68 Rust assertions

Test coverage pushed into previously untested layers (protocol framing, server dispatch, MCP stdio, tool registry, repo-map, 7 orphan handlers, patch parser, file collector, NL code search, health stats). **Five real bugs found and fixed**:

- **Fixed** `PrioritizedRequest::Ord` inverted priority comparison — `batch_extract` (priority=1) was queued *after* normal requests (BinaryHeap is a max-heap; pop() returns the largest)
- **Fixed** `simplify.rs` byte-slice truncation `&text[..100]` panicked on UTF-8 multi-byte boundaries (CJK/emoji) — now char-based truncation
- **Fixed** `patch-parser.js` — the P2-C9 lookahead made the standard SEARCH/REPLACE format parse **100% of the time to zero blocks**; also fixed replacement leaking trailing whitespace (normalized-length slicing) and fuzzy-match length misalignment (dynamic end expansion)
- **Fixed** `code-search.js` intent ordering — `/depend.*/` in the whereUsed entry hijacked `dependency tree of X` queries
- **Fixed** `health-check.js` `success_rate` counted `error` status as success (`(total-crash)/total` → now `ok/total`)

Known limits locked by tests: `**/src/foo` multi-segment glob never matches; `generated_*` prefix rules only match at repo root.

New suites: `test-mcp-server` (MCP stdio protocol, 18), `test-tool-registry` (41), `test-repo-map` (32), `test-handler-smoke` (7 orphan handlers, 28), `test-patch-parser` (20), `test-file-collector` (33), `test-code-search` (24), `test-health-check` (17), plus Rust inline tests in `protocol.rs`/`cache.rs`/`server.rs`/`simplify.rs`.

`npm test` 130 → **325** assertions (10 files); `cargo test` 14 → **68**; 1038+ assertions across 45 test files.

### r31: Cross-platform support — Windows (TCP) + macOS ready (see 0.3.33 for details)

- Windows: TCP `127.0.0.1:31001` (`MALONG_PORT` override), no pid/SIGTERM; macOS/Windows build-ready via GitHub Actions matrix; release artifacts on tag
- Windows path adaptation (r31-fix): `pathToFileURL` dynamic imports, `tmpdir()`-based test paths, `toDbRel` forward-slash normalization, UDS→named pipe on Windows, `sep`-aware workspace boundary check
- Reverse-drift guard in `sync-from-dev.sh`: refuses to sync when OSS-only improvements are missing in the dev repo (checks 7 markers, `--skip-guard` escape hatch)

## [0.3.33] - 2026-08-02

### r31: Cross-platform support — Windows (TCP) + macOS ready

- `malong-parse` now builds on **Linux / macOS / Windows**:
  - Unix (Linux/macOS): Unix socket at `/tmp/malong-parse-{uid}.sock` (override with `MALONG_SOCKET`)
  - Windows: TCP `127.0.0.1:31001` (override with `MALONG_PORT`); no pid file / SIGTERM / instance probe (client-side auto-restart degraded — start the daemon manually)
- `handle_connection` genericized (`tokio::io::split`) to serve both stream types
- `parse-client.js`: platform-aware endpoint (`process.getuid` guard, TCP connect on Windows)
- Removed the unused `nix` crate (declared, never used)
- New CI: GitHub Actions matrix (ubuntu / macos-13 x86 / macos-14 arm / windows) runs `cargo test` + `npm test` + dogfood suites; tag `v*` triggers cross-platform release artifacts

## [0.3.32] - 2026-08-02

### r30: Test blind-spot closure + two real `trace_symbol` bugs

- Added functional tests for `edit_transaction`, `diff_facts`, `trace_symbol` (previously smoke-only) — new `test-dogfood-r30` with 16 assertions
- **Fixed** `trace_symbol` value extraction leaving a trailing `;` (`const X = 3;` → `"3;"`), breaking `JSON.parse`
- **Fixed** constant read-sites never found: index refs only record calls/imports, so an imported constant always has ≥1 (import) refs and the text fallback (only triggered at 0 refs) never ran — now runs and merges when all refs are `import` kind (`index_plus_text`)

### r29: Directory-scope filtering + registration-pattern false positives

- **Fixed** `sweep_dead_code` directory scope: DB-layer results leaked the whole workspace (scope-outside files reported); added prefix filtering
- **Fixed** Rust `#[cfg(test)]` inline test functions (`test_*`) reported as dead code
- **Fixed** `detectDeadCode` false positives for registration patterns (`registerService('x', { run: fn })` — zero refs); explicit `isExportReferenced` exemption (export forms like `module.exports` are still reported — dead exports are real dead code)
- **Fixed** 5 `sql-concat` false positives in code-index: constant `ALIAS_LOCAL_MARKER` interpolation → parameterized queries

### r28: Multi-language deep support

- `malong-parse` added **C / C++ / Java / Bash** parsers (10 languages total, was 6)
- **Fixed** Rust kind mapping: `impl` blocks no longer emit fake symbols; methods get `impl_for`; `trait` → interface; `enum` → class
- Full-chain alignment: CACHED_EXT / langOf / symbol-anchors / style-sniffer / security_review
- Follow-up fixes: `.jsx` index failure (parser mapping gap), `.hh/.hxx` set inconsistency, honest tool language claims (removed `.rb/.php` the parser can't parse), CJS `require(` only scanned for CJS files, `Cargo.lock` committed (bin project reproducibility), Rust dead-code warnings zeroed

## [0.3.31] - 2026-08-02

### r27: security_review false-positive governance + rule golden tests

- `exec-cmd`: `(?<![\w.])` lookbehind excludes `RegExp.exec` member calls
- `sql-concat`: no cross-line prose matching; real multi-line concatenation still caught
- New rule golden tests (12 assertions): 8 true positives must fire, 4 false-positive patterns must not

## [0.3.30] - 2026-08-01

### r26: Dead-code cleanup + impact-analysis dedup (dogfooding)

- Removed dead code across the codebase; deduplicated impact-analysis paths

## [0.3.29] - 2026-08-01

### r25: 512MB memory stress test + security_review governance

- docker `--memory=512m`: 128 concurrent / 256 in-flight requests, zero OOM, RSS 134MB
- security_review false-positive governance round 1 (16 → 7 findings on self-scan)

## [0.3.28] - 2026-08-01

### r24: Expert-review landing — implicit context

- Tools become context-aware without new config languages (expert review adopted)

## [0.3.27] - 2026-08-01

### r23-fix5: Return-consistency / conflict parameters / private-convention leakage

## [0.3.26] - 2026-08-01

### r23-fix4: manifest ↔ handler contract audit

## [0.3.25] - 2026-08-01

### r23-fix3: Input-type robustness / ReDoS / performance / determinism

## [0.3.24] - 2026-08-01

### r23-fix2: LLM-user perspective — 9 gaps fixed

## [0.3.23] - 2026-08-01

### r23-fix: New 5 tools full review — 12 issues fixed

## [0.3.22] - 2026-08-01

### r23: 5 new tools added (33 → 38 MCP tools)

## [0.3.21] - 2026-08-01

### r23: Recursive evolution — dogfooding full scan

## [0.3.20] - 2026-08-01

### UX round-3 follow-ups (3 items) completed

## [0.3.19] - 2026-08-01

### UX round-3: 3 issues fixed

## [0.3.18] - 2026-08-01

### Test-framework fixes + `repo_map` reads from the index DB

## [0.3.17] - 2026-08-01

### Tool-description compression for all 33 tools (system prompt 1610t → 865t, ↓46%)

## [0.3.16] - 2026-08-01

### Unified `file` argument guard wired into all tools

## [0.3.15] - 2026-08-01

### "Write-then-read" index consistency root-fix + 5 UX issues

## [0.3.14] - 2026-08-01

### Full-tool trial round 2 — 4 fixes (incl. CJS `require` blind spot)

## [0.3.13] - 2026-08-01

### Index self-healing loop (extractor version stamp + dirty marking + open-DB check + force re-extract)

## [0.3.12] - 2026-08-01

### All-33-tool dogfood UX review — 7 bugs fixed (incl. a "fixed but never deployed" find)

## [0.3.11] - 2026-08-01

### Workspace index DB self-cleanup

## [0.3.10] - 2026-08-01

### All-tool dogfooding — 5 bugs (fix_imports / test_bridge / trace_symbol / call_chain / inspect)

## [0.3.9] - 2026-08-01

### Write-pipeline deep review + UDS multi-session concurrency safety

## [0.3.8] - 2026-08-01

### Rust support (triggered by dogfooding: indexing malong-parse's own source)

## [0.3.7] - 2026-08-01

### Four parallel review groups — 36 true positives fixed (service 15 / write-side 7 / QA 14)

## [0.3.6] - 2026-08-01

### Recursive evolution rounds 3–6 (regex literals / write pipeline / full review 18 issues / P2 debt 37)

## [0.3.5] - 2026-08-01

### Recursive evolution rounds 1–2 — 4 real bugs

## [0.3.4] - 2026-08-01

### Semaphore timeout fallback + repo_map weight relaxation

## [0.3.3] - 2026-08-01

### Self-reference trap fix + P2 false positives + UX polish

## [0.3.2] - 2026-08-01

### QA gatekeeper onboarding + production checkup (0-false-positive gate)

## [0.3.1] - 2026-08-01

### LiuHe philosophy v2: Body / Six Gated Constraints / Discipline three-layer structure

## [0.3.0] - 2026-08-01

### Primitivization P1+P2+P3 (MVP: `read_symbol` / `write_symbol` / `write_symbols` + embedded reader)

- call reduction ↓50%, token ↓65% on the same task

## [0.2.1] - 2026-07-31

### End-to-end tests + runtime fixes + parse-performance optimization + extraction correctness

## [0.2.0] - 2026-07-31

### Five-round full code review + performance test suite

## [0.1.0] - 2026-07-31

### Rust parsing service — tree-sitter uninstalled from Node.js

- All parsing moved to the `malong-parse` Rust daemon (Unix socket), batch 50 files/request

## 0.0.x — 2026-07-18 → 2026-07-28 (early development)

- **0.0.26** 30-tool mutual-reference system + orchestration guide
- **0.0.25** P0/P2 tool inter-reference + three deep review rounds
- **0.0.24** `test_bridge` (closing the loop)
- **0.0.23** 9 pure-algorithm P2 tools (20 → 29 tools)
- **0.0.22** resumable indexing + chain awareness + unified usage stats
- **0.0.21** P1 quality-gate tools (5) + MCP concurrency scheduling
- **0.0.20** tree-sitter native memory management (N-API finalizer + event-loop yield)
- **0.0.19** stdin-close fix + `tree.delete()` fix
- **0.0.18–17** memory optimization — tree-sitter native leak diagnostics
- **0.0.16** MCP server stability
- **0.0.15** auto-index + `undo_commit` + batch impact analysis + startup self-check
- **0.0.14** startup self-check + implicit stats + explicit feedback
- **0.0.13** `edit_transaction` `file_edits` + description optimization + staleness detection + incremental indexing
- **0.0.12** expert review: edit safety + nearest-match + standard error codes + blocking reindex
- **0.0.11** AST-based `fix_imports` + specifier-level precise deletion + index robustness
- **0.0.10** description compression + real-LLM validation + misuse detection fallback
- **0.0.9** LLM UX enhancements (5 items + `edit_validate`)
- **0.0.7–8** P0 toolset (5 tools) + directory reorganization
- **0.0.4–6** bug fixes (incl. Impact Lens fatal bug), additions
- **0.0.1–3** initial toolset
