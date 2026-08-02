# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Report privately via:

- The repository owner's contact (see the Gitea/GitHub profile of the maintainer), or
- A private fork-based disclosure to the maintainer

Include, when possible:

- Affected version(s) and component (`malong/` toolset or `malong-parse/` daemon)
- Steps to reproduce (minimal example)
- Impact assessment

## Scope

Notable attack surface, in order of importance:

1. **`malong-parse` daemon** — parses untrusted source code with tree-sitter. Inputs are bounded (1MB per file, per-request timeout, `catch_unwind` recovery), but a parser-level crash or memory issue is the most likely fault class. Report parser crashes even without a security proof.
2. **`better-sqlite3` native module** — the only prebuilt native dependency; supply-chain concerns apply.
3. **MCP server** — exposed only to the local LLM client over stdio; treat any remote exposure as a vulnerability.

## Response

- Acknowledgment: within 3 working days
- Fix + coordinated release: as soon as practical; critical issues take priority over feature work

## Non-goals

This project is a local, single-user code toolkit. It does not claim to be a security boundary: run it on code you already trust to execute (the LLM agent runs the tools on your behalf).
