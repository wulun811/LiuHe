# @jieai/dsh-malong-bridge

Official DSH (DeepSeek Harness) plugin for LiuHe / malong. One command puts the
**Six-He line** (13 `malong__*` MCP tools) into dsh web, and **malong's workspace
automatically follows the current conversation's workspace** — no need to pass a path
manually.
(Since 0.5.22 the bridge defaults to `graph` + state layer = 13 tools — the recommended
daily entry. The classic full catalog (44) and the diagnostic tier (18) are still one
env away: export `MALONG_INTERFACE=classic|diagnostic` on the dsh host.)

```bash
dsh plugin --profile web add @jieai/dsh-malong-bridge
pkill -f "dsh web"
dsh web --port 3456 --host 127.0.0.1
```

`--host` must be one concrete local address. `dsh` **rejects wildcard addresses**
(`0.0.0.0`, `::`); the default is loopback. For remote access, bind an explicit
interface **and** put authentication/firewall in front yourself: this UI grants
file read/write and shell execution to anyone who can reach the port, and the
token in the printed URL is not a substitute for network controls.

> **pnpm 10 warns `Ignored build scripts: better-sqlite3`**: that is pnpm's
> default security policy (blocks dependency postinstall scripts). Run
> `pnpm approve-builds` and check `better-sqlite3` in the list (or edit
> `~/.dsh/profiles/web/pnpm-workspace.yaml` and add `better-sqlite3` under
> `onlyBuiltDependencies`, then `pnpm rebuild better-sqlite3`).
> Without this, better-sqlite3 has no native binary and tool calls will fail.
>
> **Native build fallback**: better-sqlite3 ships prebuilt binaries for common
> platforms (Node 20+); if your platform lacks a prebuilt and you have no build
> toolchain (Windows: Visual Studio Build Tools for node-gyp), the server
> automatically falls back to the vendored sql.js WASM backend
> (`malong/vendor/`, zero native deps) — the startup log shows which backend is
> active. Both backends use SQLite with compatible data files.

## Uninstall

```bash
dsh plugin --profile web remove @jieai/dsh-malong-bridge
pkill -f "dsh web"
dsh web --port 3456 --host 127.0.0.1
```

## Configuration (optional, zero-config by default)

| Env var | Default | Description |
|---|---|---|
| `MALONG_SERVER_PATH` | bundled `server/mcp-server.js` | Override the mcp-server entry (e.g. point at your own LiuHe dev copy) |
| `MALONG_STATE_DIR` | `~/.local/state/malong-dsh` | Index/state storage dir (all workspaces isolated under it by hash) |
| `MALONG_TOOL_TIMEOUT_MS` | `300000` | Per tool call timeout |

You can also write a `config:` override on the `malong-dsh-bridge` entry in the
profile's `cordis.patch.yml` (user layer, applied later).

## How It Works

```
DSH Agent → malong__read_symbol(...) (no workspace_dir)
         → dsh-bridge injects workspace_dir = current session workspace
         → malong mcp-server (spawned subprocess) → per-path-hash isolated indexes
```

- **Dynamic workspace follow**: every tool invocation carries the session
  workspace (`exec.agent.session.header.cwd`); the bridge injects it
  automatically; explicit paths from the model are respected (cross-workspace
  management).
- **State isolation**: indexes are hash-isolated by workspace path under
  `MALONG_STATE_DIR`, unrelated to any project directory.
- **Zero intrusion**: does not touch dsh's node_modules; dsh upgrades are safe.

> **Platform support**: verified on **Linux x86-64** only (Ubuntu 24.04, glibc
> ≥ 2.34). Windows and macOS are **not verified** for this release — see
> **Parser setup** below before assuming they work.

## Parser setup (`malong-parse`)

This tarball contains the bridge and the MCP server, **not** the Rust parser.
`npm install` alone does not give you working parsing. Two separate things must
hold:

1. **The binary must exist.** Resolution order (`parse-bin.js`):
   `MALONG_PARSE_BIN` → `MALONG_PARSE_BIN_ALT` → an installed
   `@jieai/malong-parse-<platform>-<arch>` package (none is published yet) →
   `server/bin/malong-parse` (legacy layout, absent here) →
   `~/.local/bin/malong-parse` → a sibling `../malong-parse/target/{release,debug}`
   dev build.
   The last entry is why a dev checkout works without any env var — do not rely
   on that for an installed setup.
2. **A daemon must be reachable.** The MCP server connects to a shared Unix
   socket at `/tmp/malong-parse-<uid>.sock` (`MALONG_SOCKET` overrides it) and
   spawns a daemon if none is running. The daemon is **per-user, shared by all
   sessions** — which is why an unrelated running daemon can make a wrong
   `MALONG_PARSE_BIN` look like it works (you get a `DRIFT` warning in `health`
   instead of a failure).

Recommended install:

```bash
# Linux x86-64 asset shipped alongside this release
install -Dm755 malong-parse-linux-x64-0.3.39 ~/.local/bin/malong-parse
malong-parse --version   # confirm it runs at all
```

Then, in the dsh host environment:

```bash
export MALONG_PARSE_BIN="$HOME/.local/bin/malong-parse"   # optional but explicit
```

**Verify it, don't assume it.** `invoke_capability(name='health')` reports a
`Parse Service` line; check three things: `connected=true`, the daemon's
`size`/`exe` matches the binary you installed, and `drift.detected` is false.

**When it is genuinely missing**, parse-dependent calls fail with an explicit
message naming every searched location:

```
malong-parse binary not found. Searched: <candidates...>.
Set MALONG_PARSE_BIN (Windows: point at the .exe) or install it (~/.local/bin/malong-parse).
```

**Degradation is partial, and it is not a clean fallback.** Indexing,
`outline`/`symbols` and symbol search need the parser. `code_read`, `code_status`
and plain text editing keep working off the static index and the filesystem, so
a missing parser shows up as *empty or absent* symbol results rather than as a
hard stop. Treat "tools respond" as **not** evidence that parsing works —
check `health`.

> **glibc**: the shipped Linux binary is dynamically linked against
> **GLIBC_2.34** (highest versioned symbol). Older distros (e.g. CentOS 7,
> Ubuntu 20.04) will fail at load time with `GLIBC_2.34 not found`; build from
> source there or use a newer base image. It is not "any Linux x64".

On Windows, replacing an existing source file uses the inbox Windows PowerShell
and .NET `File.Replace` with a hidden process to preserve the target's ACL.
Edits, undo and rollback use this path; new files inherit their directory's
permissions. If Windows PowerShell is blocked or replacement is denied, the
write fails explicitly instead of falling back to a rename that resets the ACL.
This adds Windows-only process startup overhead to existing-file writes.

## Differences vs. the official dsh-mcp-client

The official `dsh-mcp-client` bridges a single MCP server; this plugin's bridge
adds **dynamic workspace injection** (fills `workspace_dir` per invocation from
the session workspace, so the model never needs to know the path) — a
capability unique to LiuHe.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Log shows `mcp tools/list timeout` | Verify the install is complete (`dsh plugin` reports no node_modules errors); restart dsh |
| No `malong__*` tools in the conversation | Confirm the bundle layer is attached (`dsh web --dump-config \| grep malong`); hard-refresh the browser |
| Call fails with `missing_parameter: workspace_dir` | The conversation has no workspace (no cwd) to inject; pass a path in the prompt |
| `malong-parse binary not found. Searched: ...` | Install the parser (see **Parser setup**) or set `MALONG_PARSE_BIN` |
| Tools respond but `outline`/symbol search is empty | Parser unreachable or wrong binary. Check `health` → `Parse Service` (`connected`, `size`/`exe`, `drift.detected`). Tools responding is not proof parsing works |
| `health` shows `DRIFT: daemon binary ... differs` | A stale per-user daemon is running an older build. Stop it (`pkill -x malong-parse`) and let the next call respawn from the resolved binary |
| `FILE_NOT_INDEXED` after a crash | Run `invoke_capability(name='reindex', args={workspace_dir, blocking:true})`. `reindex` is asynchronous by default |
| Plugin stops working after a dsh upgrade | The plugin lives at the profile layer, upgrades do not affect it; if the cordis interface changes, reinstall the plugin |

## Index Rules (Transparency)

- **Default ignored**: `node_modules`, `.git`, `dist`, `build`, `target`,
  `coverage`, `__pycache__`, `.venv`, `.malong`, `.ai-transactions`, `vendor`, etc.
- **md/json not indexed**: only code files are indexed; use a read tool for documents
- **`.malongignore` customization**: a `.malongignore` file at the project root
  excludes directories allowlist-style (one per line; `*` wildcards supported; max 100 entries)

## License

MIT
