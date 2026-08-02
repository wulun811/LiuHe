# Malong LiuHe（码龙·六合工具）

**LLM-Native Code Operations Toolkit** — Code tooling reinvented for the LLM that has no hands, no eyes, and no memory.

**English** | [简体中文](README.zh-CN.md) | [Docs](https://www.ttimmortal.com/) | [GitHub](https://github.com/wulun811/LiuHe)

![tests](https://img.shields.io/badge/tests-200%2B%20assertions%20passed-brightgreen)
![tools](https://img.shields.io/badge/tools-38%20MCP-blue)
![languages](https://img.shields.io/badge/parsers-10%20languages-brightgreen)
![read](https://img.shields.io/badge/read%20P95-1ms-brightgreen)
![write](https://img.shields.io/badge/write%20P95-7ms-blue)
![memory](https://img.shields.io/badge/512MB%20limit-RSS%20134MB-brightgreen)
![concurrency](https://img.shields.io/badge/128%20concurrent%20requests-zero%20OOM-brightgreen)
![throughput](https://img.shields.io/badge/throughput-588%20calls%2Fs-blue)
![token](https://img.shields.io/badge/token%20savings-65%25-brightgreen)
![license](https://img.shields.io/badge/license-MIT-blue)
![version](https://img.shields.io/badge/version-0.3.32-blue)
![commits](https://img.shields.io/badge/commits-185-blue)

**Malong LiuHe** is a toolkit built for LLMs rather than humans. It ships two components:
- **`malong/`** — an MCP toolset (38 tools): symbol read/write, indexing, impact analysis, reference tracing, call graphs, dead-code detection, code review, security scanning, atomic batch editing — served to the LLM over MCP (JSON-RPC over stdio).
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
| Tool-description compression | **1610 → 865t (↓46%)** | 60-scenario tool selection F1 = 100% |
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
| **Index & search** | `reindex`, `symbol_search`, `repo_map` (98ms file map) |
| **Analysis** | `impact_analysis` (blast radius + risk), `call_chain`, `references`, `dep_graph`, `inspect` (outline + refs + call chain in one) |
| **Editing** | `edit_batch`, `edit_transaction` (atomic txn + rollback + cross-session lock), `diff_facts` (symbol changes + test sync) |
| **Quality gates** | `code_review`, `security_review` (19 security patterns), `style_sniffer`, `guard_patterns`, `naming_consistency`, `exception_guard`, `config_drift`, `dependency_gatekeeper` — all pure regex, zero LLM calls, deterministic |
| **Engineering** | `test_bridge`, `find_tests`, `mock_sync`, `rename_symbol` (atomic cross-file rename), `trace_symbol` (constant tracing + hardcoded copies) |
| **System** | `health`, `gc`, `feedback` |

## Architecture

```
┌─────────────────────────┐     ┌──────────────────────────────┐
│  LLM Client (MCP)       │     │  malong-parse (Rust daemon)  │
│  malong/ 38 tools       │◄───►│  tree-sitter, 10 languages   │
│  SQLite index (per ws)  │     │  LRU tree cache 50MB / batch │
│  Unix socket client     │     │  catch_unwind crash recovery │
└─────────────────────────┘     └──────────────────────────────┘
```

- All parsing is done by the Rust service (zero tree-sitter bindings on the Node side)
- Index is SQLite (WAL mode, multi-process safe), isolated per workspace
- LRU tree cache (50MB / 5min TTL), batched extraction 50 files/batch
- Daemon multi-session safety: circuit breaker + liveness probe + cross-session coordinated restart (O_EXCL lock) — a slow request in one session never stalls others

## Self-Hosting (Dogfooding)

25+ rounds of "Malong reviews Malong": the toolset audits and fixes its **own** code, with dozens of real bugs fixed and locked by tests — including directory-scope filtering gaps, false dead-code reports for registration patterns, lost constant read-sites, and SQL parameterization cleanup. Every round grew the assertion count (now 200+ green).

## Quick Start

### 10-second taste

```bash
# 1) Get the parsing daemon — download a prebuilt binary from releases/, or build:
cd malong-parse && cargo build --release && cp target/release/malong-parse ~/.local/bin
malong-parse &                                   # start the daemon (Unix socket)

# 2) Install the toolset
cd ../malong && npm ci

# 3) Register the MCP server (works with any MCP client, e.g. opencode / Claude Desktop)
#    config:
#    {
#      "mcpServers": {
#        "malong": { "command": "node", "args": ["/path/to/malong/mcp-server.js"] }
#      }
#    }

# 4) Ask your LLM: "search for the symbol 'handle' in my workspace"
```

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
**Platforms:** Linux and macOS use the Unix socket; on **Windows** the daemon listens on TCP `127.0.0.1:31001` (set `MALONG_PORT` to override) — start it manually (`malong-parse.exe`), the client will not auto-restart it. Set `MALONG_SOCKET` to override the Unix socket path.
 [`releases/`](releases/) (with `.sha256` checksums) — pick one up instead of building if you prefer.

### Install the toolset

```bash
cd malong
npm ci
npm test          # 130+ assertions (daemon must be running)
```

### Start the MCP server

```bash
cd malong
node --max-old-space-size=512 mcp-server.js
```

Register the MCP server with any MCP-capable LLM client (e.g. opencode, Claude Desktop) and the tools become available.

## Testing

- Rust: `cargo test` (14 assertions, incl. per-language extraction correctness)
- JS: `npm test` (130+ assertions: primitives / embedded / mvp-batch) + `tests/test-dogfood-*.js` (end-to-end against a real daemon: transaction rollback, dead code, reference tracing, concurrency, circuit breaker, daemon kill-recovery — 69+ assertions)

## License

[MIT](LICENSE)

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for the full release history (0.0.1 → 0.3.32).
