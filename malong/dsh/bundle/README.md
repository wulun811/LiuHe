# @jieai/dsh-malong-bridge

Official DSH (DeepSeek Harness) plugin for LiuHe / malong. One command puts all 44
`malong__*` MCP tools into dsh web, and **malong's workspace automatically follows
the current conversation's workspace** — no need to pass a path manually.

```bash
dsh plugin --profile web add @jieai/dsh-malong-bridge
pkill -f "dsh web"
dsh web --port 3456 --host 0.0.0.0
```

Works out of the box: the bridge locates the bundled `server/mcp-server.js`
(complete toolset backend; the only native dependency, better-sqlite3, ships
cross-platform precompiled binaries), so no extra deployment is needed.

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

> **Platform support (automatic)**: `malong-parse` (the Rust parsing service)
> ships as esbuild-style platform subpackages — the main package declares
> `@jieai/malong-parse-linux-x64` / `-darwin-x64` / `-darwin-arm64` /
> `-win32-x64` in `optionalDependencies`, and npm/pnpm pulls only the binary for
> the current os/cpu at install time. Other platforms / custom binaries can be
> provided via the `MALONG_PARSE_BIN` env var.

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
