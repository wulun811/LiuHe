# Malong（码龙）— LLM-Native 代码操作工具链

**Malong** 是一套**为 LLM 而非人类设计**的代码操作工具链，包含两个组件：

- **`malong/`** — MCP 工具集（38+ 个工具）：符号读写、索引、影响分析、引用追踪、调用图、死代码检测、代码审查、安全扫描、批量编辑事务等，通过 MCP（JSON-RPC over stdio）服务提供给 LLM。
- **`malong-parse/`** — Rust 解析服务：基于 tree-sitter 的多语言符号提取引擎（JavaScript/TypeScript/TSX/Python/Go/Rust/C/C++/Java/Bash），通过 Unix Socket 与工具集通信，LRU 树缓存 + 批量并行提取。

## 核心理念

传统工具（git、sed、IDE）假设使用者有手、有眼、有记忆；LLM 三者皆无。Malong 围绕这三点重新设计：

| 缺失 | 设计后果 |
|------|---------|
| **无手** | 操作必须原子化、可撤销、可重试（`edit_transaction` 事务 + rollback + undo journal） |
| **无眼** | 输出必须结构化、自解释（JSON 直接消费，错误带 `suggestion`/`next_action`） |
| **无记忆** | 每次调用自包含（带 `workspace_dir`），版本锚定乐观并发（`read_symbol` → `write_symbol(base_version)` 冲突状态机） |

## 快速开始

### 构建 Rust 解析服务

```bash
cd malong-parse
cargo build --release
cp target/release/malong-parse ~/.local/bin/   # 或加入 PATH
malong-parse &                                   # 启动 daemon（Unix socket: /tmp/malong-parse-$(id -u).sock）
```

### 安装工具集

```bash
cd malong
npm ci
npm test          # 130+ 断言全绿（需要 daemon 在跑）
```

### 启动 MCP 服务

```bash
cd malong
node --max-old-space-size=512 mcp-server.js
```

将 MCP 服务注册到支持 MCP 的 LLM 客户端（如 opencode / Claude Desktop），工具自动可用。

## 工具概览

| 类别 | 工具 |
|------|------|
| **I/O 原语** | `read_symbol`（符号读 + 版本）、`write_symbol` / `write_symbols`（安全写，冲突状态机 + 原子写 + undo） |
| **索引与搜索** | `reindex`、`symbol_search`、`repo_map`（98ms 级文件地图） |
| **分析** | `impact_analysis`（影响面 + 风险）、`call_chain`、`references`、`dep_graph`、`inspect`（大纲+引用+调用链三合一） |
| **编辑** | `edit_batch`、`edit_transaction`（原子事务 + rollback + 跨会话锁）、`diff_facts`（符号变更 + 测试同步） |
| **质量守门** | `code_review`、`security_review`（19 种安全模式）、`style_sniffer`、`guard_patterns`、`naming_consistency`、`exception_guard`、`config_drift`、`dependency_gatekeeper`——全部纯正则、零 LLM 调用、可复现 |
| **工程辅助** | `test_bridge`、`find_tests`、`mock_sync`、`rename_symbol`（跨文件原子重命名）、`trace_symbol`（常量追踪 + 硬编码副本） |
| **系统** | `health`、`gc`、`feedback` |

## 多语言支持

| 语言 | 符号提取 | 引用提取 |
|------|:---:|:---:|
| JavaScript / TypeScript / TSX / JSX | ✓ | ✓ |
| Python | ✓ | ✓ |
| Go | ✓ | ✓ |
| Rust（含 impl 块/ trait/ enum 语义） | ✓ | ✓ |
| C / C++（含头文件） | ✓ | ✓ |
| Java | ✓ | ✓ |
| Bash | ✓ | ✓ |

## 架构

```
┌─────────────────────────┐     ┌──────────────────────────────┐
│  LLM 客户端（MCP）       │     │  malong-parse（Rust daemon） │
│  malong/ 38+ 工具        │◄───►│  tree-sitter 多语言解析        │
│  SQLite 索引（按 workspace）│     │  LRU 树缓存 50MB / 批量并行   │
│  Unix Socket 客户端       │     │  catch_unwind 崩溃恢复        │
└─────────────────────────┘     └──────────────────────────────┘
```

- 解析全部由 Rust 服务承担（Node.js 侧零 tree-sitter 绑定）
- 索引为 SQLite（WAL 模式 + 多进程安全），按 workspace 隔离
- 树缓存 LRU（50MB / 5min TTL），批量提取 50 文件/批

## 测试

- Rust 侧：`cargo test`（14 断言，含各语言提取正确性）
- JS 侧：`npm test`（130+ 断言：primitives / embedded / mvp-batch）+ `tests/test-dogfood-*.js`（真实 daemon 端到端：事务回滚、死代码、引用追踪、并发、熔断恢复等）

## 许可证

[MIT](LICENSE)
