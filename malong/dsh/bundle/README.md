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
dsh web --port 3456 --host 0.0.0.0
```

Works out of the box for the MCP server itself: the bridge locates the bundled
`server/mcp-server.js` (complete toolset backend; better-sqlite3 ships
cross-platform precompiled binaries, with a vendored sql.js WASM fallback).

**Parser prerequisite (one-time per machine)**: the Rust parsing service
`malong-parse` is NOT bundled in this tarball. Install it yourself or point
`MALONG_PARSE_BIN` at a binary (see Platform support below). If it cannot be
resolved, tool calls that need parsing fail with an explicit resolution error
listing the searched locations.

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
dsh web --port 3456 --host 0.0.0.0
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

> **Platform support**: `malong-parse` (the Rust parsing service) is NOT bundled
> with this tarball. It is resolved at runtime by `parse-bin.js`, in this order:
> `MALONG_PARSE_BIN` / `MALONG_PARSE_BIN_ALT` env → an installed
> `@jieai/malong-parse-<platform>-<arch>` package (only if you installed one;
> this bundle no longer declares such optionalDependencies) → the bundled
> `server/bin/malong-parse` (legacy layout; absent in this tarball) →
> `~/.local/bin/malong-parse` → a sibling `../malong-parse/target/{release,debug}`
> dev build.
>
> Point it explicitly when installing by hand, e.g.
> `MALONG_PARSE_BIN=/opt/malong-parse/malong-parse` (Linux) or
> `MALONG_PARSE_BIN=C:\tools\malong-parse\malong-parse.exe` (Windows).
>
> **0.5.13 note**: this bundle no longer declares `optionalDependencies` for the
> platform packages. They were pinned to `0.5.9`, a version that was never
> published (npm tops out at `0.4.8`), so they could never install and only
> produced a silent `catch {}` miss on every resolution. Install the binary
> yourself (`~/.local/bin/malong-parse`) or point `MALONG_PARSE_BIN` at one.

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
| Plugin stops working after a dsh upgrade | The plugin lives at the profile layer, upgrades do not affect it; if the cordis interface changes, reinstall the plugin |

## Index Rules (Transparency)

- **Default ignored**: `node_modules`, `.git`, `dist`, `build`, `target`,
  `coverage`, `__pycache__`, `.venv`, `.malong`, `.ai-transactions`, `vendor`, etc.
- **md/json not indexed**: only code files are indexed; use a read tool for documents
- **`.malongignore` customization**: a `.malongignore` file at the project root
  excludes directories allowlist-style (one per line; `*` wildcards supported; max 100 entries)

## License

MIT
