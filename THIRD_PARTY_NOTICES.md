# Third-Party Notices

This repository vendors the following third-party components:

## sql.js (SQLite compiled to WebAssembly)

- **Files**: `malong/vendor/sql-wasm.cjs`, `malong/vendor/sql-wasm.wasm`
- **Version**: 1.12.0
- **Source**: https://github.com/sql-js/sql.js (npm package `sql.js@1.12.0`)
- **License**: MIT (see `malong/vendor/SQLJS-LICENSE`)
- **Purpose**: zero-dependency SQLite backend for the sandbox deployment variant
  (Node >= 20, no npm install, no native compilation). The default backend remains
  `better-sqlite3`; sql.js is used only when `better-sqlite3` is unavailable.
- **Copyright**: (c) 2017 sql.js authors (see AUTHORS)

## Usage

```
createDb(path, opts)  // from malong/db-adapter.js
  backend detection: better-sqlite3 (default) → vendored sql.js (fallback)
```
