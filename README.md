# Malong LiuHe（码龙·六合工具）

**LLM-Native Code Operations Toolkit** — Code tooling reinvented for the LLM that has no hands, no eyes, and no memory.

**English** | [简体中文](README.zh-CN.md) | [Docs](https://wulun811.github.io/LiuHe) | [GitHub](https://github.com/wulun811/LiuHe)

[![wulun811/LiuHe MCP server](https://glama.ai/mcp/servers/wulun811/LiuHe/badges/score.svg)](https://glama.ai/mcp/servers/wulun811/LiuHe)
![tests](https://img.shields.io/badge/tests-2013%20assertions%20passed-brightgreen)
![tools](https://img.shields.io/badge/tools-44%20MCP-blue)
![languages](https://img.shields.io/badge/parsers-10%20languages-brightgreen)
![read](https://img.shields.io/badge/read%20P95-1ms-brightgreen)
![write](https://img.shields.io/badge/write%20P95-7ms-blue)
![memory](https://img.shields.io/badge/512MB%20limit-RSS%20134MB-brightgreen)
![concurrency](https://img.shields.io/badge/128%20concurrent%20requests-zero%20OOM-brightgreen)
![throughput](https://img.shields.io/badge/throughput-588%20calls%2Fs-blue)
![token](https://img.shields.io/badge/token%20savings-65%25-brightgreen)
![license](https://img.shields.io/badge/license-MIT-blue)
![version](https://img.shields.io/badge/version-0.4.5--post8-blue)
![commits](https://img.shields.io/badge/commits-264-blue)

**Malong LiuHe** is a toolkit built for LLMs rather than humans. It ships two components:
- **`malong/`** — an MCP toolset (44 tools): symbol read/write, indexing, impact analysis, reference tracing, call graphs, dead-code detection, code review, security scanning, atomic batch editing, test orchestration, pipeline verification — served to the LLM over MCP (JSON-RPC over stdio).
- **`malong-parse/`** — a Rust parsing service: a tree-sitter-based multi-language symbol extraction engine (JavaScript/TypeScript/TSX/Python/Go/Rust/C/C++/Java/Bash), talking to the toolset over a Unix socket, with an LRU tree cache and batched parallel extraction.

## Core Idea

Traditional tools (git, sed, IDE) assume a user with hands, eyes, and memory. An LLM has none of these. Malong LiuHe is redesigned around that fact:

| Missing | Design Consequence |
|---------|--------------------|
| **No hands** | Operations must be atomic, undoable, retryable (`edit_transaction` with rollback and undo journal) |
| **No eyes** | Output must be structured and self-explanatory (JSON for direct consumption; errors carry `suggestion`/`next_action`) |
| **No memory** | Every call is self-contained (takes `workspace_dir`); optimistic concurrency with version anchors (`read_symbol` → `write_symbol(base_version)` conflict state machine) |

## Performance (Measured)

| Metric | Value | Note |
|--------|-------|------|
| Small-file read P95 | **1ms** | 50 runs, warmed |
| Small-file write P95 | **7ms** | 30 runs, incl. post-write re-index |
| `repo_map` | **98ms** | down from tens of seconds (SQLite index + Rust parsing) |
| Memory | **RSS 134MB / 26%** | under a real docker `--memory=512m` cgroup limit |
| Concurrency | **128 concurrent / 256 in-flight requests, zero OOM** | 32-way mixed read+write on one hot file, no tearing, DB `integrity_check` PASS |
| Throughput | **~588 calls/s** | single-threaded ceiling — 60–600× real LLM demand |
| Token savings | **↓65.3%** | same task 7673 → 2662 est. (primitives) |
| Call reduction | **↓50.0%** | 6 calls (legacy) → 3 calls (primitives) |
| Tool-description compression | **44 tools ≈ 1.33k tokens** | tiered: core kept, low-freq ≤70 chars, verbose ≤230; detail flows via next_step hints |
| Index throughput | **538 files / 7s** | scoped reindex, measured |
| dry_run fidelity | **47/47** | golden-hash comparison across 3 languages, 100% |
| Concurrent writes to same symbol | **16/16** | exactly one winner + one conflict, zero silent overwrites |

## Language Support

| Language | Symbol Extraction | Reference Extraction |
|----------|:---:|:---:|
| JavaScript / TypeScript / TSX / JSX / MTS / CTS | ✓ | ✓ |
| Python | ✓ | ✓ |
| Go | ✓ | ✓ |
| Rust (impl blocks / trait / enum semantics) | ✓ | ✓ |
| C / C++ (incl. headers) | ✓ | ✓ |
| Java | ✓ | ✓ |
| Bash | ✓ | ✓ |

## Tool Overview

| Category | Tools |
|----------|-------|
| **I/O primitives** | `read_symbol` (symbol read + version), `write_symbol` / `write_symbols` (safe write: conflict state machine + atomic write + undo) |
| **Index & search** | `reindex`, `symbol_search`, `code_search` (keyword + regex intent patterns — NOT semantic search), `repo_map` (98ms file map; skeleton pagination: `page`/`page_size`/`prefix` — truncated output always carries the full top-level skeleton with page numbers)
| **Analysis** | `impact_analysis` (blast radius + risk), `call_chain`, `references`, `dep_graph`, `inspect` (outline + refs + call chain in one), `trace_symbol` (constant tracing + hardcoded copies) |
| **Editing** | `edit_batch`, `edit_transaction` (atomic txn + rollback + cross-session lock), `edit_collision_guard` (write conflict detection), `edit_sandbox` (pre-write validation), `diff_facts` (symbol changes + test sync), `rename_symbol` (atomic cross-file rename), `git_worktree` (isolated branch + verify + merge) |
| **Quality gates** | `code_review`, `security_review` (regex security patterns), `code_quality` (5-dim probe), `style_sniffer`, `guard_patterns`, `naming_consistency`, `exception_guard`, `config_drift`, `dependency_gatekeeper`, `fix_imports`, `sweep_dead_code`, `mock_sync` — all pure regex/AST, zero LLM calls, deterministic |
| **Engineering** | `test_bridge` (run/suggest/discover), `find_tests`, `verify_pipeline` (lint/test/typecheck stages), `debug_runner` (error analysis), `patch_parser` (SEARCH/REPLACE), `tsc_check`, `spec_gen`, `active_todos` |
| **System** | `health`, `gc`, `feedback` |

## Architecture

```
┌─────────────────────────┐     ┌──────────────────────────────┐
│  LLM Client (MCP)       │     │  malong-parse (Rust daemon)  │
│  malong/ 44 tools       │◄───►│  tree-sitter, 10 languages   │
│  SQLite index (per ws)  │     │  LRU tree cache 50MB / batch │
│  Unix socket client     │     │  catch_unwind crash recovery │
└─────────────────────────┘     └──────────────────────────────┘
```

- All parsing is done by the Rust service (zero tree-sitter bindings on the Node side)
- Index is SQLite (WAL mode, multi-process safe), isolated per workspace
- LRU tree cache (50MB / 5min TTL), batched extraction 50 files/batch
- Daemon multi-session safety: circuit breaker + liveness probe + cross-session coordinated restart (O_EXCL lock) — a slow request in one session never stalls others

## Self-Hosting (Dogfooding)

30+ rounds of "Malong reviews Malong": the toolset audits and fixes its **own** code, with dozens of real bugs fixed and locked by tests — including directory-scope filtering gaps, false dead-code reports for registration patterns, lost constant read-sites, and SQL parameterization cleanup. Every round grew the assertion count (now 2013 across 81 JS test files, full chain 0 failures, measured 2026-08-13).

## Scan Boundaries (limits acknowledged; committed within)

Deterministic scanners only — regex pattern matching and reference graphs. **No control-flow, data-flow, or cross-module semantic coverage.** 0 findings ≠ clean; high scores ≠ healthy.

- `security_review` scans: injection (eval/Function-ctor, exec/spawn string building, template `${}`, `$()` substitution, SQL concat), XSS, hardcoded secrets, CORS *, timing/insecure compare, dotenv. **Not scanned**: SSRF, XXE, deserialization, auth/logic flaws, control-flow defects.
- `sweep_dead_code` reference scope: import graph + fixed text-ref fallback (.sh/.json/.md etc.); CLI-string references count as alive (miss-over-delete). **Not scanned**: dynamic/reflection wiring.
- Commitment: issues in scope get fixed; covered patterns are test-locked; new rules must stay within committed categories.

## Quick Start

### Standard install (default — recommended)

`npm ci` installs `better-sqlite3` (the full SQLite backend); this is the default recommended path:

```bash
# 1) Get the parsing daemon — download a prebuilt binary from releases/, or build:
cd malong-parse && cargo build --release && cp target/release/malong-parse ~/.local/bin
malong-parse &                                   # start the daemon (Unix socket)

# 2) Install the toolset (npm ci installs the full better-sqlite3 backend)
cd ../malong && npm ci

# 3) Register the MCP server (works with any MCP client, e.g. opencode / Claude Desktop)
#    opencode (project-root opencode.json; Windows paths use double backslashes, Linux/macOS forward slashes):
#    {
#      "mcp": {
#        "malong": {
#          "type": "local",
#          "command": ["node", "--max-old-space-size=512", "N:\\repo\\liuhe\\malong\\mcp-server.js", "--workspace", "N:\\repo\\liuhe"],
#          "enabled": true
#        }
#      }
#    }
#    Claude Desktop (verified on Windows: %APPDATA%\Claude\claude_desktop_config.json):
#    {
#      "mcpServers": {
#        "malong": { "command": "node", "args": ["/path/to/malong/mcp-server.js"] }
#      }
#    }

# 4) Ask your LLM: "search for the symbol 'handle' in my workspace"

#    DeepSeek Harness (dsh web) — auto session-workspace convenience (extra, optional):
#    Run once on the dsh host (Linux/macOS):
#      Option A (npm, one line — full backend + platform binary included):
#        dsh plugin --profile web add @jieai/dsh-malong-bridge
#        pkill -f "dsh web"; dsh web --port 3456 --host 0.0.0.0 --trusted-host <LAN IP>
#      Option B (script, points at a checkout of this repo):
#        bash malong/dsh/install-dsh.sh         # idempotent; edits ~/.dsh/profiles/web/cordis.patch.yml with backup
#    The bridge registers all 44 tools as malong__* and auto-fills workspace_dir from the
#    current conversation's workspace (no per-call path needed; explicit paths still win).
#    Full guide incl. index rules: malong/dsh/DSH-INTEGRATION.md
#    Troubleshooting: if EVERY malong__* call hangs until timeout, the bridge's
#    mcp-server subprocess is gone. The bridge now auto-restarts it (exponential
#    backoff, pending calls fail fast with "restarting — retry shortly"); if that
#    keeps failing, restart dsh web: kill <dsh web pid> && dsh web --port 3456 ...
```

> **SQL backend note:** the default is the full `better-sqlite3` backend. If `npm install` fails (offline / no build toolchain / Node < 20), the server automatically degrades to the **vendored sql.js WASM sandbox backend** (`malong/vendor/`, zero-dependency, no network) — the startup log shows which backend is active and the upgrade command. Data files are fully compatible between backends (both are SQLite).

### Zero-build deployment (degraded path: sandbox / offline environments)

For environments with **Node >= 20 and no npm access** (no `npm ci`, no native
compilation), everything runs from the repo files as-is (Linux/Windows — the
prebuilt binaries are `linux-x86_64` and `windows-x86_64`). On this path SQLite
runs on the sql.js sandbox backend (degraded):

```bash
# 0) Clone, then enter the toolset directory:
git clone <repo-url> liuhe && cd liuhe/malong

# 1) Parse daemon — prebuilt binary from releases/ (no cargo needed):
mkdir -p ~/.local/bin
tar -xzf ../releases/malong-liuhe-0.4.5-linux-x86_64.tar.gz
cp malong-parse/target/release/malong-parse ~/.local/bin
malong-parse &                                   # start the daemon (socket: /tmp/malong-parse-$UID.sock)

# 2) Run the toolset — zero npm install:
node --max-old-space-size=4096 mcp-server.js --workspace /path/to/project
# vendored SQLite (sql.js WASM) auto-enabled when better-sqlite3 is unavailable

# 3) Self-check (30s, optional):
node tests/test-db-adapter.js   # 22 assertions: sql.js backend + persistence
node tests/test-mcp-server.js   # 25 assertions: MCP stdio + daemon round-trip
```

> **Windows users:** use `releases/malong-liuhe-0.4.5-windows-x86_64.tar.gz` (contains `malong-parse.exe`), extract and put it on PATH; the MCP server auto-starts the daemon, so step 1's `malong-parse &` is not required. The `mkdir -p`/`tar -xzf` above are Unix syntax — on Windows use any extractor (`tar -xzf` works on Win10+).

> Note: if the daemon is not running, parse-dependent tools (symbol extraction
> etc.) degrade; the SQLite-backed tools (repo-map / code-index / health-check)
> still work.

- See `THIRD_PARTY_NOTICES.md` for the vendored component.

What the LLM sees back:

```json
{
  "results": [
    { "name": "handle", "type": "function", "start_line": 6, "end_line": 12, "file": "app.js" },
    { "name": "handle_login", "type": "function", "start_line": 5, "end_line": 9, "file": "src/auth.py" }
  ],
  "count": 2,
  "next_step": "Before modifying found symbols, check blast radius: impact_analysis(...)"
}
```

### Build the Rust parsing service

```bash
cd malong-parse
cargo build --release
cp target/release/malong-parse ~/.local/bin/   # or add to PATH
malong-parse &                                   # daemon (Unix socket: /tmp/malong-parse-$(id -u).sock)
```

Prebuilt binaries for Linux x86_64 are committed under
[`releases/`](releases/) (with `.sha256` checksums) — pick one up instead of building if you prefer.

**Platforms:** Linux and macOS use the Unix socket; on **Windows** the daemon listens on TCP `127.0.0.1:31001` (set `MALONG_PORT` to override) — the MCP server probes and auto-starts `malong-parse.exe` on startup, so no manual launch is needed (if you use the parse-client API directly outside MCP, start it manually). Set `MALONG_SOCKET` to override the Unix socket path.

### Install the toolset

```bash
cd malong
npm ci
npm test          # 2013 assertions (daemon must be running)
```

### Start the MCP server

```bash
cd malong
node --max-old-space-size=512 mcp-server.js --workspace /path/to/project
```

Register the MCP server with any MCP-capable LLM client and the tools become available. For **opencode**, register in the project root `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "malong": {
      "type": "local",
      "command": ["node", "--max-old-space-size=512", "malong/mcp-server.js", "--workspace", "."],
      "enabled": true
    }
  }
}
```

> Windows note: relative paths in `--workspace` and `malong/mcp-server.js` resolve against the directory where opencode is launched; pass absolute paths (escape backslashes as `\\` in JSON) if you start it elsewhere. The daemon is auto-started by the MCP server — no need to launch `malong-parse.exe` manually.

### Configuration (environment variables)

All optional — sensible defaults apply when unset.

| Variable | Default | Purpose |
| --- | --- | --- |
| `MALONG_STATE_DIR` | `~/.config/malong` | Where usage / feedback / edit-stats files are written. Override to redirect state (tests, sandboxed hosts). Reads fall back to the legacy `~/.config/opencode/` so pre-0.3.37 data is not lost. |
| `MALONG_SOCKET` | `/tmp/malong-parse-$(id -u).sock` | Unix socket path to the parse daemon (Linux / macOS). |
| `MALONG_PORT` | `31001` | TCP port for the parse daemon (Windows). |
| `MALONG_PARSE_BIN` | npm platform pkg / `~/.local/bin` | Binary used when the client auto-starts the daemon. Resolution order: this env → `@jieai/malong-parse-<os>-<arch>` npm platform package (installed as an optional dependency of `@jieai/dsh-malong-bridge`) → `~/.local/bin/malong-parse` → `malong-parse/target/release` (dev tree). |
| `MALONG_PARSE_MODE` | rust-service | Parse transport. Only `rust-service` is supported (`builtin` / `shadow` are rejected). |
| `MALONG_WS_GC_DAYS` | `14` | Days a workspace index cache may sit untouched before `health cleanup` prunes it; `0` disables. |

### Suppressing security false positives

`security_review` is deliberately conservative, so benign patterns (a hash used as a cache key, `process.exit` in a CLI entry) can trip it. Two explicit, auditable suppression mechanisms exist — neither ever auto-suppresses injection rules.

**Inline** — append `malong-ignore` to a line to suppress all findings on it, or `malong-ignore[eval,exec-cmd]` for specific rules (a reason after `:` is encouraged):

```js
const id = crypto.createHash('md5').update(p).digest('hex') // malong-ignore: cache-dir name, not security
```

**Config** — add a `securityIgnore` array to `.ai-patterns.json` (the same file `guard_patterns` reads). Each entry takes `files` (`*` / `**` globs) and/or `rules`; omit one side to match all:

```json
{ "securityIgnore": [ { "files": ["**/mcp-server.js"], "rules": ["process-exit"] } ] }
```

Suppressed findings are dropped from the score but counted in the summary's `suppressed` field, so nothing is hidden silently. Injection rules (eval / exec / SQL / spawn) are only ever suppressed by an explicit marker or entry you authored — never heuristically.

### Journal auto-cleanup

Every safe write (`write_symbol` / `write_symbols` / `edit_batch`) leaves an undo journal under `.malong/journal/`. Terminal transactions (`committed` / `rolled_back` / `abandoned` / `failed`) older than a TTL (default **24h**, configurable) are pruned automatically — throttled to at most one scan per hour per workspace, so it costs nothing. In-flight (`created` / `staged`) and `needs_review` (external change awaiting human review) journals are **never** auto-deleted. This only ever touches the tool's own rollback backups — never your source files.

### Using with Claude Code

Verified end-to-end with Claude Code 2.x. The MCP layer is standard JSON-RPC over
stdio, so any MCP client (Claude Code, codex, opencode, Claude Desktop…) connects
the same way.

**1) Prerequisites** — Node >= 20 and the parsing daemon running (see the
*Zero-build deployment* or *Build the Rust parsing service* sections above).

**2) Install Claude Code**

```bash
npm install -g @anthropic-ai/claude-code
```

**3) Point Claude Code at an Anthropic-compatible provider**

Claude Code needs an LLM backend. Any Anthropic-compatible endpoint works — set the
variables below (or manage them with [`cc-switch`](https://www.npmjs.com/package/@cc-switch/cli)):

```bash
export ANTHROPIC_BASE_URL="https://your-provider/anthropic"   # any Anthropic-compatible endpoint
export ANTHROPIC_AUTH_TOKEN="your-api-key"                     # never commit this
export ANTHROPIC_MODEL="your-model"                            # a model your provider serves
```

> With [`cc-switch`](https://www.npmjs.com/package/@cc-switch/cli): `npm i -g @cc-switch/cli`,
> `cc-switch new my-provider` (fill in the same `ANTHROPIC_*` keys under `env`),
> `cc-switch switch my-provider`, then `eval $(cc-switch export)`.

**4) Register the MCP server**

```bash
claude mcp add liuhe -- node /path/to/malong/mcp-server.js --workspace /path/to/project
claude mcp list        # → "liuhe … ✔ Connected"
```

**5) Use it** — start `claude` in your project and ask, or run headless:

```bash
claude -p "index the workspace with reindex, then find createDb with symbol_search" \
  --allowedTools "mcp__liuhe__reindex" "mcp__liuhe__symbol_search"
```

Tools are exposed as `mcp__liuhe__<tool>` (e.g. `mcp__liuhe__health`,
`mcp__liuhe__symbol_search`, `mcp__liuhe__repo_map`). Run `reindex` (optionally
`blocking=true`) once per workspace first, so symbol search / impact analysis have
an index to query.

### Using with codex

Verified end-to-end with codex (same JSON-RPC-over-stdio MCP layer).

> **Version note:** recent codex releases force the OpenAI *Responses* API
> (`wire_api = "responses"`). Use a version that still supports `wire_api = "chat"`
> together with MCP — verified with **0.50.0**:
> `npm install -g @openai/codex@0.50.0`.

**1) Prerequisites** — Node >= 20 and the parsing daemon running (see above).

**2) Configure `~/.codex/config.toml`** — point codex at any OpenAI-compatible
provider (example below: [OpenCode Zen](https://opencode.ai)) and register the MCP
server:

```toml
model = "deepseek-v4-flash"
model_provider = "opencode-zen"

[model_providers.opencode-zen]
name = "OpenCode Zen"
base_url = "https://opencode.ai/zen/go/v1"   # any OpenAI-compatible endpoint
wire_api = "chat"
env_key = "OPENCODE_ZEN_API_KEY"             # codex reads the API key from this env var

[mcp_servers.liuhe]
command = "node"
args = ["/path/to/malong/mcp-server.js", "--workspace", "/path/to/project"]
```

**3) Run** — export the API key, then start codex:

```bash
export OPENCODE_ZEN_API_KEY="your-api-key"   # never commit this
codex exec "index the workspace with reindex, then find createDb with symbol_search"
```

Tools are exposed as `liuhe.<tool>` (e.g. `liuhe.health`, `liuhe.symbol_search`,
`liuhe.repo_map`). Run `reindex` once per workspace first so symbol search has an
index to query.

## Testing

- Rust: `cargo test` (92 assertions: per-language extraction + protocol framing/decoding + cache LFU + server dispatch/priority queue + batch_extract + deep-nesting guards + hello handshake)
- JS: 81 test files, 2013 assertions. `npm test` runs the full chain (primitives / embedded / mvp-batch / tool-registry / repo-map / handler-smoke / patch-parser / file-collector / code-search / health-check / db-adapter dual-backend / write-runtime / host-config / mcp-server / security-review-rules / journal-prune / gatekeeper-golden / debug-runner / edit-collision-guard / fix-imports / symbol-search / naming-consistency / call-chain / edit-transaction-ext / batch-edit-write / verify-pipeline / dep-graph-project / code-quality / tsc-spec / batch-edit-tocou / workflow-closure / variable-refs / output-budget / read-symbols-batch / feedback-list / test-bridge-run / mock-syncer-truncation / r54-p0 / r54-p1 / r54-p2 / r8 / r9 / crash-injection / r10 / dogfood-r12); `test-dogfood-r14…r30` (end-to-end against a real daemon) run separately
- Total: 2013 assertions across 81 JS test files (plus cargo tests)
- One-shot: `./scripts/ci.sh` (self-contained: cargo test + npm test + dogfood; reuses or auto-starts the daemon)

## License

[MIT](LICENSE)

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for the full release history.
