# 码龙·六合工具（Malong LiuHe）

**LLM-Native 代码操作工具链** — 为无手、无眼、无记忆的 LLM 重新发明代码操作。

[English](README.md) | **简体中文** | [官方文档](https://www.ttimmortal.com/) | [GitHub](https://github.com/wulun811/LiuHe)

![tests](https://img.shields.io/badge/tests-984%2B%20assertions%20passed-brightgreen)
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

**码龙·六合工具** 是一套**为 LLM 而非人类设计**的代码操作工具链，包含两个组件：

- **`malong/`** — MCP 工具集（38 个工具）：符号读写、索引、影响分析、引用追踪、调用图、死代码检测、代码审查、安全扫描、批量编辑事务等，通过 MCP（JSON-RPC over stdio）服务提供给 LLM。
- **`malong-parse/`** — Rust 解析服务：基于 tree-sitter 的 10 语言符号提取引擎（JavaScript/TypeScript/TSX/Python/Go/Rust/C/C++/Java/Bash），通过 Unix Socket 与工具集通信，LRU 树缓存 + 批量并行提取。

## 核心理念

传统工具（git、sed、IDE）假设使用者有手、有眼、有记忆；LLM 三者皆无。码龙·六合围绕这三点重新设计：

| 缺失 | 设计后果 |
|------|---------|
| **无手** | 操作必须原子化、可撤销、可重试（`edit_transaction` 事务 + rollback + undo journal） |
| **无眼** | 输出必须结构化、自解释（JSON 直接消费，错误带 `suggestion`/`next_action`） |
| **无记忆** | 每次调用自包含（带 `workspace_dir`），版本锚定乐观并发（`read_symbol` → `write_symbol(base_version)` 冲突状态机） |

## 性能数据（实测）

| 指标 | 数值 | 说明 |
|------|------|------|
| 小文件 read P95 | **1ms** | 50 次实测，预热后 |
| 小文件 write P95 | **7ms** | 30 次实测，含写后同步重抽 |
| repo_map | **98ms** | 从几十秒优化至 98ms（SQLite 索引 + Rust 解析） |
| 内存 | **RSS 134MB / 26%** | docker `--memory=512m` 真 cgroup 限制下 |
| 并发 | **128 并发 / 256 在途请求零 OOM** | 32 路读写混合打同一热点文件零撕裂，DB `integrity_check` PASS |
| 吞吐 | **~588 call/s** | 单线程封顶，为真实 LLM 需求的 60–600 倍 |
| token 节省 | **↓65.3%** | 原语化同任务 7673 → 2662 est |
| 调用次数 | **↓50.0%** | 旧六步 6 次 → 新原语 3 次 |
| 工具描述压缩 | **1610 → 865t（↓46%）** | 60 场景工具选择实测 F1=100% |
| 索引吞吐 | **538 文件 / 7s** | 缩 scope reindex 实测 |
| dry_run 一致性 | **47/47** | 三语言 golden hash 对比 100% 一致 |
| 并发写同符号 | **16/16** | 恰好一胜一冲突，无静默覆盖 |

## 多语言支持

| 语言 | 符号提取 | 引用提取 |
|------|:---:|:---:|
| JavaScript / TypeScript / TSX / JSX / MTS / CTS | ✓ | ✓ |
| Python | ✓ | ✓ |
| Go | ✓ | ✓ |
| Rust（impl 块 / trait / enum 语义） | ✓ | ✓ |
| C / C++（含头文件） | ✓ | ✓ |
| Java | ✓ | ✓ |
| Bash | ✓ | ✓ |

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

## 架构

```
┌─────────────────────────┐     ┌──────────────────────────────┐
│  LLM 客户端（MCP）       │     │  malong-parse（Rust daemon） │
│  malong/ 38 个工具       │◄───►│  tree-sitter 10 语言解析      │
│  SQLite 索引（按 workspace）│     │  LRU 树缓存 50MB / 批量并行   │
│  Unix Socket 客户端       │     │  catch_unwind 崩溃恢复        │
└─────────────────────────┘     └──────────────────────────────┘
```

- 解析全部由 Rust 服务承担（Node.js 侧零 tree-sitter 绑定）
- 索引为 SQLite（WAL 模式 + 多进程安全），按 workspace 隔离
- 树缓存 LRU（50MB / 5min TTL），批量提取 50 文件/批
- daemon 多会话安全：熔断 + 探活门禁 + 跨会话协调重启（O_EXCL 锁），一个会话的慢请求不连累其他会话

## 自我进化（self-hosting）

25+ 轮「码龙查码龙」：工具集审查并修复**自身**代码，累计修复数十处真实 bug 且全部带测试锁定——包括目录 scope 过滤失效、注册形态死代码误报、常量追踪读取点丢失、SQL 参数化治理等。测试盲区即 bug 潜伏区，每一轮审查都伴随断言增长（现 39 个 JS 测试文件共 984+ 断言）。

## 快速开始

### 零构建部署（沙盒 / 离线环境）

适用于 **Node ≥ 20 且无法 npm 安装**的环境（不能 `npm ci`、不能原生编译）——全部从仓库文件直接运行：

```bash
# 1) 解析 daemon——用 releases/ 里的预编译二进制（无需 cargo）：
tar -xzf releases/malong-parse-0.3.34-linux-x86_64.tar.gz
cp malong-parse ~/.local/bin
malong-parse &                                   # 启动 daemon

# 2) 直接跑工具集——零 npm 安装：
node mcp-server.js --workspace /path/to/project   # 自动启用仓库内置 SQLite（sql.js WASM）
```

- SQLite 后端自动探测：有 `better-sqlite3` 时用完整版（行为完全不变）；否则回退**仓库内置 sql.js WASM**（`malong/vendor/`，零依赖）——无需安装、无需编译、无需网络。
- 两后端数据文件完全兼容（都是 SQLite 格式）。
- 内置组件声明见 `THIRD_PARTY_NOTICES.md`。

### 10 秒体验

```bash
# 1) 获取解析服务——从 releases/ 下载预编译二进制，或自己编译：
cd malong-parse && cargo build --release && cp target/release/malong-parse ~/.local/bin
malong-parse &                                   # 启动 daemon（Unix socket）

# 2) 安装工具集
cd ../malong && npm ci

# 3) 注册 MCP 服务（任何 MCP 客户端通用，如 opencode / Claude Desktop）
#    配置：
#    {
#      "mcpServers": {
#        "malong": { "command": "node", "args": ["/path/to/malong/mcp-server.js"] }
#      }
#    }

# 4) 让 LLM 问一句："search for the symbol 'handle' in my workspace"
```

LLM 收到的真实输出：

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

### 构建 Rust 解析服务

```bash
cd malong-parse
cargo build --release
cp target/release/malong-parse ~/.local/bin/   # 或加入 PATH
malong-parse &                                   # 启动 daemon（Unix socket: /tmp/malong-parse-$(id -u).sock）
```

Linux x86_64 预编译二进制已随仓库提交在
**平台说明：** Linux/macOS 走 Unix socket；**Windows** 上 daemon 监听 TCP `127.0.0.1:31001`（可用 `MALONG_PORT` 覆盖）——需手动启动 `malong-parse.exe`，客户端不自动重启。Unix socket 路径可用 `MALONG_SOCKET` 覆盖。
 [`releases/`](releases/)（附 `.sha256` 校验）——不想编译可以直接下载。

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

## 测试

- Rust 侧：`cargo test`（14 断言，含各语言提取正确性）
- JS 侧：`npm test`（338+ 断言：primitives / embedded / mvp-batch / tool-registry / repo-map / handler smoke / patch-parser / file-collector / code-search / health-check / db-adapter 双后端）+ `tests/test-dogfood-r*.js`（真实 daemon 端到端，9 个套件共 226+ 断言）+ `test-mcp-server.js`（18 断言，MCP stdio 协议）
- Rust 侧：`cargo test`（68 断言：各语言提取 + 协议帧编解码 + 缓存 LFU + 服务端 dispatch/优先级队列 + batch_extract）
- 总计：46 个测试文件共 1052+ 断言（984 JS + 68 Rust）
- 一键验证：`./scripts/ci.sh`（自包含：cargo test + npm test + dogfood，复用或自起 daemon）

## 许可证

[MIT](LICENSE)

## 更新日志

完整版本历史（0.0.1 → 0.3.32）见 [CHANGELOG.md](CHANGELOG.md)。
