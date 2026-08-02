# Contributing to Malong LiuHe

Thanks for considering a contribution! This project is a **self-hosted toolkit**: the tools audit their own code ("Malong reviews Malong"), so every round of development produces both code and tests.

## Project layout

```
malong/          MCP toolset (Node.js, ESM)
  tools/         one directory per tool: handler.js + manifest.json
  tests/         test suites (test-*.js) — require a running malong-parse daemon
malong-parse/    Rust parsing service (tree-sitter, Unix socket daemon)
scripts/         ci.sh / release.sh / sync-from-dev.sh
```

## Development workflow

1. **The parsing engine is Rust.** All symbol/reference extraction goes through the `malong-parse` daemon. Node.js side holds zero tree-sitter bindings. If you change extraction, you change Rust — and you must run `cargo test` and re-deploy the binary.
2. **Tools are Node.** Each tool lives in `malong/tools/tool-<name>/` with a `handler.js` and a `manifest.json`. Follow existing conventions: structured errors with `suggestion`/`next_action`, self-contained calls taking `workspace_dir`.
3. **Determinism is a hard gate.** No non-deterministic external calls (network, clock, random) in tool logic — or inject a controllable seed/mock at the upstream of the call chain.

## Testing requirements

Every change must keep the suites green, and **new behavior must come with new assertions** (test blind spots are where bugs live):

```bash
./scripts/ci.sh
```

This runs, self-contained:

- `cargo test` (Rust extraction correctness)
- `npm test` (130+ assertions: primitives / embedded / mvp-batch)
- dogfood suites (`test-dogfood-r14.js`, `test-dogfood-r30.js` — real daemon, end-to-end)
- git cleanliness check

It reuses a running daemon if healthy, otherwise starts a debug-build one and cleans up.

## Commit conventions

- Conventional Commits style: `fix:`, `feat:`, `docs:`, `test:`, `refactor:`, `chore:`
- Reference the round in the body when it's part of a dogfooding cycle, e.g. `r31:`
- One logical change per commit; keep the working tree clean

## Releasing

```bash
./scripts/ci.sh                 # all green
./scripts/release.sh vX.Y.Z     # bundles the Linux x86_64 binary + sha256 for the Release
git tag -a vX.Y.Z -m "..."
git push origin master --tags
```

Then create a Release from the tag and attach the artifact from `/tmp/malong-parse-<ver>-linux-x86_64.tar.gz`.

## License

By contributing you agree your contributions are licensed under [MIT](LICENSE).
