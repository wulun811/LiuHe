# LiuHe × DSH (DeepSeek Harness Web) Integration

> Goal: let agents in DSH conversations use the LiuHe tools (`malong__*`) directly,
> with the workspace auto-following the current conversation's workspace (no need
> to pass a path manually).

## Quick Install

```bash
# 1. Prerequisite: install and run `dsh web` once (generates ~/.dsh/profiles/web/)
# 2. One-shot install (idempotent, safe to re-run; backs up the existing config)
bash <repo>/malong/dsh/install-dsh.sh

# 3. Restart dsh web
pkill -f "dsh web"
dsh web --port 3456 --host 0.0.0.0 --trusted-host <your-LAN-IP>

# 4. Verify the config was loaded
dsh web --dump-config | grep -A6 malong-dsh-bridge
```

The install script does three things:
1. Backs up `~/.dsh/profiles/web/cordis.patch.yml`
2. Removes any old `dsh-mcp-client` entry (if previously installed)
3. Appends the `malong-dsh-bridge` plugin entry (pointing at `dsh-bridge.mjs` in this directory)

## How It Works

```
DSH Agent → malong__read_symbol(...) (no workspace_dir)
         → dsh-bridge injects workspace_dir = current session workspace
         → malong mcp-server (spawned subprocess) → per-path-hash isolated indexes
```

- **Dynamic workspace follow**: every tool invocation carries the session workspace
  (`exec.agent.session.header.cwd` = the workspace you picked when creating the
  conversation); the bridge injects it automatically, so the model hits the right
  workspace without passing a path. Explicit paths are respected when given
  (allows cross-workspace management).
- **State isolation**: `~/.local/state/malong-dsh` only holds index/state storage
  (all workspaces are hashed under it), unrelated to any project directory; fully
  isolated from any LiuHe instance used by other hosts (e.g. opencode).
  The bridge spawns mcp-server with `MALONG_STATE_DIR=<stateDir>` (r5 adaptation):
  the final server resolves its state root via `getStateDir()`, and `--workspace`
  is kept only as the legacy-state migration source (`<stateDir>/data/malong-mcp`,
  auto-migrated on first launch). State layout is flat: `<stateDir>/workspaces/<hash>/`.
- **Zero intrusion**: does not touch dsh's node_modules; dsh upgrades are safe;
  does not depend on `dsh-mcp-client`.
- **Tool set**: since 0.5.22 the bridge exposes the **Six-He line only** — `graph` +
  state layer = **13 tools** (`code_task` / `code_read` / `code_status` / `code_query` /
  `code_audit` / `code_batch` / `code_check` / `code_control` / `code_maintain` /
  `code_patch` / `code_worktree` / `edit_transaction` / `invoke_capability`). The classic
  full catalog (44) and the diagnostic tier (18) stay reachable by exporting
  `MALONG_INTERFACE=classic|diagnostic` on the dsh host (the bridge passes its own env
  through to the spawned server; an explicit host value always wins). Since 0.5.24 the
  product default is the same Six-He line, so the bridge's explicit injection is
  belt-and-braces — an unconfigured host would get 13 tools anyway.
  Whitelist-external tools are hidden and rejected with an explicit gate reason.

## Verify

1. Open dsh web, pick a workspace (e.g. `/path/to/projectA`) and create a conversation
2. Ask the agent to read a symbol (it will call `malong__read_symbol` automatically, no path needed)
3. Confirm the index was built:
   ```bash
   ls ~/.local/state/malong-dsh/workspaces/
   # expect <hash>/metadata.json with workspace_dir = /path/to/projectA
   ```
4. Create a conversation in workspace B and read again → a separate hash appears, no interference

## Uninstall / Reinstall

```bash
# Remove the malong-dsh-bridge entry from ~/.dsh/profiles/web/cordis.patch.yml
# (or restore the backup), then restart dsh web.
```

## Index Rules (Transparency)

malong's reindex/search default behavior — worth knowing for both models and users:

- **Default ignored dirs**: `node_modules`, `.git`, `.hg`, `.svn`, `dist`, `build`, `out`, `target`, `coverage`, `__pycache__`, `.venv`, `.env`, `.next`, `.vscode`, `.idea`, **`.malong`**, **`.ai-transactions`**, `vendor`, etc.
- **md/json not indexed**: only code file extensions are indexed (.js/.ts/.py/.go/.rs/.c/.cpp/.java/.sh ...); markdown, JSON, YAML and config files are not — use a read tool to inspect documents, do not rely on reindex.
- **`.malongignore` customization**: a `.malongignore` file at the project root excludes directories allowlist-style (one per line; `*` wildcards supported; max 100 entries)
- **Note**: `data/`-style directories are **not** default-ignored (some projects use `.malongignore` for them); exclude them yourself if you do not want them indexed

## Upgrading the bundle (local `file:` tarball)

```bash
# 1. Rebuild the artifact in the repo, then point the profile at it
cd <repo>/malong/dsh/bundle && ./reprep.sh --pack
# edit ~/.dsh/profiles/web/package.json → "@jieai/dsh-malong-bridge": "file:<abs path>/jieai-dsh-malong-bridge-<ver>.tgz"

# 2. Install through the plugin manager (pnpm under the hood)
dsh plugin --profile web install --prefer-offline

# 3. Restart dsh web, then confirm the version in the log
#    expect: [malong-dsh-bridge] bridge ready (13 tools, version=<ver>)
#            [mcp] [info] [lang-parser] v<ver> rust-service only
```

**Gotcha (pnpm file: deps):** when the *specifier string* does not change (same
`<ver>.tgz` path repacked with new content), pnpm reports `Already up to date`
and leaves the old files hardlinked in `node_modules` even though the lockfile
`integrity` was refreshed. Force a relink by removing the installed copy and
re-running install:

```bash
rm -rf ~/.dsh/profiles/web/node_modules/@jieai/dsh-malong-bridge
cd <repo> && dsh plugin --profile web install --prefer-offline
# verify: diff -r <tarball extract>/package node_modules/@jieai/dsh-malong-bridge  → no output
grep -m1 'export const version' ~/.dsh/profiles/web/node_modules/@jieai/dsh-malong-bridge/server/lang-parser.js
grep -m1 GRAPH_VERSION ~/.dsh/profiles/web/node_modules/@jieai/dsh-malong-bridge/server/tools/entry-shared.js
```

Version spots that must all agree (`test-host-config` asserts this): main
`package.json`, `tools/entry-shared.js GRAPH_VERSION`, `lang-parser.js version`,
`dsh/bundle/package.json`. The bridge itself reads its version from `package.json`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Log shows `mcp tools/list timeout` | Make sure `serverPath` points to an existing executable; restart dsh |
| No `malong__*` tools in the conversation | Confirm `dsh web --dump-config` contains `malong-dsh-bridge` without errors; hard-refresh the browser |
| Call fails with `missing_parameter: workspace_dir` | The conversation has no workspace (no cwd) to inject; pass a path in the prompt |
| Plugin stops working after a dsh upgrade | The plugin lives at the profile layer, upgrades do not affect it; if the cordis interface changes, re-run the installer or update the plugin |

## Files

| File | Purpose |
|---|---|
| `dsh/dsh-bridge.mjs` | cordis plugin: minimal MCP stdio client + automatic workspace_dir injection |
| `dsh/install-dsh.sh` | one-shot installer (idempotent, backs up config) |
| `dsh/DSH-INTEGRATION.md` | this document |
