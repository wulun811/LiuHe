# 码龙·六合工具（Malong LiuHe）

**LLM-Native 代码操作工具链** — 为无手、无眼、无记忆的 LLM 重新发明代码操作。

[English](README.md) | **简体中文** | [官方文档](https://www.ttimmortal.com/) | [GitHub](https://github.com/wulun811/LiuHe)

![tests](https://img.shields.io/badge/tests-2015%20assertions%20passed-brightgreen)
![tools](https://img.shields.io/badge/tools-44%20MCP-blue)
![languages](https://img.shields.io/badge/parsers-10%20languages-brightgreen)
![read](https://img.shields.io/badge/read%20P95-1ms-brightgreen)
![write](https://img.shields.io/badge/write%20P95-7ms-blue)
![memory](https://img.shields.io/badge/512MB%20limit-RSS%20134MB-brightgreen)
![concurrency](https://img.shields.io/badge/128%20concurrent%20requests-zero%20OOM-brightgreen)
![throughput](https://img.shields.io/badge/throughput-588%20calls%2Fs-blue)
![token](https://img.shields.io/badge/token%20savings-65%25-brightgreen)
![license](https://img.shields.io/badge/license-MIT-blue)
![version](https://img.shields.io/badge/version-0.4.5-blue)
![commits](https://img.shields.io/badge/commits-264-blue)

**码龙·六合工具** 是一套**为 LLM 而非人类设计**的代码操作工具链，包含两个组件：

- **`malong/`** — MCP 工具集（44 个工具）：符号读写、索引、影响分析、引用追踪、调用图、死代码检测、代码审查、安全扫描、批量编辑事务、测试编排、管线验证等，通过 MCP（JSON-RPC over stdio）服务提供给 LLM。
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
| 工具描述压缩 | **44 工具 ≈ 1.33k tokens** | 分级：核心保持 / 低频 ≤70 字符 / 冗长 ≤230 字符；详情走 next_step 衔接提示 |
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
| **索引与搜索** | `reindex`、`symbol_search`、`code_search`（自然语言意图搜索）、`repo_map`（98ms 级文件地图） |
| **分析** | `impact_analysis`（影响面 + 风险）、`call_chain`、`references`、`dep_graph`、`inspect`（大纲+引用+调用链三合一）、`trace_symbol`（常量追踪 + 硬编码副本） |
| **编辑** | `edit_batch`、`edit_transaction`（原子事务 + rollback + 跨会话锁）、`edit_collision_guard`（写冲突检测）、`edit_sandbox`（写前验证）、`diff_facts`（符号变更 + 测试同步）、`rename_symbol`（跨文件原子重命名）、`git_worktree`（隔离分支 + 验证 + 合并） |
| **质量守门** | `code_review`、`security_review`（正则安全模式）、`code_quality`（5 维探针）、`style_sniffer`、`guard_patterns`、`naming_consistency`、`exception_guard`、`config_drift`、`dependency_gatekeeper`、`fix_imports`、`sweep_dead_code`、`mock_sync`——全部纯正则/AST、零 LLM 调用、可复现 |
| **工程辅助** | `test_bridge`（run/suggest/discover）、`find_tests`、`verify_pipeline`（lint/test/typecheck 阶段）、`debug_runner`（错误分析）、`patch_parser`（SEARCH/REPLACE）、`tsc_check`、`spec_gen`、`active_todos` |
| **系统** | `health`、`gc`、`feedback` |

## 架构

```
┌─────────────────────────┐     ┌──────────────────────────────┐
│  LLM 客户端（MCP）       │     │  malong-parse（Rust daemon） │
│  malong/ 44 个工具       │◄───►│  tree-sitter 10 语言解析      │
│  SQLite 索引（按 workspace）│     │  LRU 树缓存 50MB / 批量并行   │
│  Unix Socket 客户端       │     │  catch_unwind 崩溃恢复        │
└─────────────────────────┘     └──────────────────────────────┘
```

- 解析全部由 Rust 服务承担（Node.js 侧零 tree-sitter 绑定）
- 索引为 SQLite（WAL 模式 + 多进程安全），按 workspace 隔离
- 树缓存 LRU（50MB / 5min TTL），批量提取 50 文件/批
- daemon 多会话安全：熔断 + 探活门禁 + 跨会话协调重启（O_EXCL 锁），一个会话的慢请求不连累其他会话

## 自我进化（self-hosting）

30+ 轮「码龙查码龙」：工具集审查并修复**自身**代码，累计修复数十处真实 bug 且全部带测试锁定——包括目录 scope 过滤失效、注册形态死代码误报、常量追踪读取点丢失、SQL 参数化治理等。测试盲区即 bug 潜伏区，每一轮审查都伴随断言增长（现 81 个 JS 测试文件共 2015 断言，2026-08-09 全链 0 失败）。

## 扫描边界（承认局限，边界内承诺必做）

本工具集是确定性扫描器：只做正则形态匹配与引用图检查，**不覆盖控制流、数据流、跨模块语义**。0 命中 ≠ 没问题，高分 ≠ 健康。

- `security_review` 承诺扫描：注入（eval/Function-ctor、exec/spawn 字符串拼接、模板 `${}`、`$()` 命令替换、SQL 拼接）、XSS、硬编码密钥、CORS *、时序/不安全比较、dotenv。**不扫**：SSRF、XXE、反序列化、认证/授权逻辑、业务逻辑漏洞、控制流缺陷。
- `sweep_dead_code` 承诺引用面：import 图 + 固定文件类型文本兜底（.sh/.json/.md 等）；CLI 字符串引用视为活（宁可漏报不可误删）。**不扫**：动态/反射调用。
- 承诺：边界内问题必修，已覆盖形态测试锁定防回归；新规则必须属于已承诺类别。

## 快速开始

### 标准安装（默认——推荐）

`npm ci` 会安装 `better-sqlite3`（完整版 SQLite 后端），这是默认推荐路径：

```bash
# 1) 获取解析服务——从 releases/ 下载预编译二进制，或自己编译：
cd malong-parse && cargo build --release && cp target/release/malong-parse ~/.local/bin
malong-parse &                                   # 启动 daemon（Unix socket）

# 2) 安装工具集（npm ci 装 better-sqlite3 完整版）
cd ../malong && npm ci

# 3) 注册 MCP 服务（opencode / Claude Desktop 等任何 MCP 客户端通用）
#    opencode（项目根 opencode.json；Windows 路径用双反斜杠，Linux/macOS 用正斜杠）：
#    {
#      "mcp": {
#        "malong": {
#          "type": "local",
#          "command": ["node", "--max-old-space-size=512", "N:\\repo\\liuhe\\malong\\mcp-server.js", "--workspace", "N:\\repo\\liuhe"],
#          "enabled": true
#        }
#      }
#    }
#    Claude Desktop（Windows 实测：%APPDATA%\Claude\claude_desktop_config.json）：
#    {
#      "mcpServers": {
#        "malong": { "command": "node", "args": ["/path/to/malong/mcp-server.js"] }
#      }
#    }

# 4) 让 LLM 问一句："search for the symbol 'handle' in my workspace"
```

> **SQL 后端说明**：默认使用 `better-sqlite3` 完整版。若 `npm install` 失败（离线 / 无编译工具链 / Node < 20），服务自动降级为仓库内置的 **sql.js WASM 沙盒后端**（`malong/vendor/`，零依赖、无需网络）——启动日志会提示当前后端与升级命令。两后端数据文件完全兼容（都是 SQLite 格式）。

### 零构建部署（降级路径：沙盒 / 离线环境）

适用于 **Node ≥ 20 且无法 npm 安装**的环境（不能 `npm ci`、不能原生编译）——全部从仓库文件直接运行（**Linux / Windows**，预编译二进制为 linux-x86_64 / windows-x86_64）。此路径下 SQLite 为 sql.js 沙盒后端（降级版）：

```bash
# 0) 克隆后进入工具集目录：
git clone <repo-url> liuhe && cd liuhe/malong

# 1) 解析 daemon——用 releases/ 里的预编译二进制（无需 cargo）：
mkdir -p ~/.local/bin
tar -xzf ../releases/malong-liuhe-0.4.5-linux-x86_64.tar.gz
cp malong-parse/target/release/malong-parse ~/.local/bin
malong-parse &                                   # 启动 daemon（socket: /tmp/malong-parse-$UID.sock）

# 2) 直接跑工具集——零 npm 安装：
node --max-old-space-size=4096 mcp-server.js --workspace /path/to/project
# better-sqlite3 不可用时自动降级仓库内置 SQLite（sql.js WASM）

# 3) 自检（可选，30 秒）：
node tests/test-db-adapter.js   # 22 断言：sql.js 后端 + 持久化
node tests/test-mcp-server.js   # 25 断言：MCP stdio + daemon 往返
```

> **Windows 用户：** 用 `releases/malong-liuhe-0.4.5-windows-x86_64.tar.gz`（内附 `malong-parse.exe`），解压后放到 PATH 即可；MCP 服务启动时会自动拉起 daemon，无需手动执行 `malong-parse &` 这一步。上面的 `mkdir -p`/`tar -xzf` 为 Unix 语法，Windows 用解压工具或 `tar -xzf`（Win10+ 自带）均可。

> 注意：daemon 未启动时，依赖解析的工具（符号提取等）会降级；SQLite 系工具（repo-map / code-index / health-check）不受影响。

- 内置组件声明见 `THIRD_PARTY_NOTICES.md`。

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
[`releases/`](releases/)（附 `.sha256` 校验）——不想编译可以直接下载。

**平台说明：** Linux/macOS 走 Unix socket；**Windows** 上 daemon 监听 TCP `127.0.0.1:31001`（可用 `MALONG_PORT` 覆盖）——MCP 服务启动时会自动探测并拉起 `malong-parse.exe`，无需手动启动；单独使用 parse-client API（非 MCP 场景）时仍需手动启动。Unix socket 路径可用 `MALONG_SOCKET` 覆盖。

### 安装工具集

```bash
cd malong
npm ci
npm test          # 2015 断言全绿（需要 daemon 在跑）
```

### 启动 MCP 服务

```bash
cd malong
node --max-old-space-size=512 mcp-server.js --workspace /path/to/project
```

将 MCP 服务注册到支持 MCP 的 LLM 客户端，工具自动可用。**opencode** 在项目根 `opencode.json` 里注册：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "malong": {
      "type": "local",
      "command": ["node", "--max-old-space-size=512", "malong/mcp-server.js", "--workspace", "."],
      "enabled": true
    }
  }
}
```

> Windows 提示：命令里 `--workspace` 和 `malong/mcp-server.js` 的相对路径以 opencode 启动目录为基准；如需从其他目录启动，改传绝对路径（`N:\\repo\\liuhe\\malong\\mcp-server.js`，JSON 里反斜杠要双写）。daemon 由 MCP 服务自动拉起，无需手动启动 `malong-parse.exe`。

### 配置（环境变量）

全部可选——不设置时用合理默认值。

| 变量 | 默认 | 用途 |
| --- | --- | --- |
| `MALONG_STATE_DIR` | `~/.config/malong` | 用量 / 反馈 / 编辑统计文件的写入目录。覆盖可重定向状态（测试、沙盒宿主）。读取会回退旧目录 `~/.config/opencode/`，0.3.37 之前的数据不丢。 |
| `MALONG_SOCKET` | `/tmp/malong-parse-$(id -u).sock` | 解析 daemon 的 Unix socket 路径（Linux / macOS）。 |
| `MALONG_PORT` | `31001` | 解析 daemon 的 TCP 端口（Windows）。 |
| `MALONG_PARSE_BIN` | 内置 / PATH 上的 `malong-parse` | 客户端自动拉起 daemon 时用的二进制。 |
| `MALONG_PARSE_MODE` | rust-service | 解析传输方式。v0.7.0 仅支持 `rust-service`（`builtin` / `shadow` 会被拒绝）。 |
| `MALONG_WS_GC_DAYS` | `14` | 工作区索引缓存闲置多少天后由 `health cleanup` 清理；`0` 禁用。 |

### 抑制 security 误报

`security_review` 刻意保守，良性模式（用作缓存键的哈希、CLI 入口里的 `process.exit`）也可能触发。提供两种**显式、可审计**的抑制机制——二者都绝不自动抑制注入类规则。

**行级**——在行尾加 `malong-ignore` 抑制该行全部 findings，或 `malong-ignore[eval,exec-cmd]` 仅抑制指定规则（鼓励在 `:` 后写 reason）：

```js
const id = crypto.createHash('md5').update(p).digest('hex') // malong-ignore: 缓存目录名，非安全用途
```

**配置**——在 `.ai-patterns.json`（`guard_patterns` 读的同一个文件）加 `securityIgnore` 数组。每条目接受 `files`（`*` / `**` 通配）和/或 `rules`；省略其一即匹配全部：

```json
{ "securityIgnore": [ { "files": ["**/mcp-server.js"], "rules": ["process-exit"] } ] }
```

被抑制的 finding 不计入评分，但会计入 summary 的 `suppressed` 字段，绝不静默吞掉。注入类规则（eval / exec / SQL / spawn）只能被你亲自写的显式标记或配置条目抑制——绝无启发式自动抑制。

### Journal 自动清理

每次安全写（`write_symbol` / `write_symbols` / `edit_batch`）都会在 `.malong/journal/` 留一份 undo journal。终态事务（`committed` / `rolled_back` / `abandoned` / `failed`）超过 TTL（默认 **24h**，可配置）会被自动清扫——每 workspace 每小时最多实扫一次，节流到几乎零开销。在途（`created` / `staged`）与 `needs_review`（检测到外部改动、待人工核对）的 journal **永不**自动删。这里只动工具自己的回滚备份——绝不碰你的源文件。

### 在 Claude Code 中使用

已用 Claude Code 2.x 端到端验证。MCP 层是标准 JSON-RPC over stdio，任何 MCP 客户端
（Claude Code / codex / opencode / Claude Desktop…）接入方式完全一致。

**1) 前置**——Node ≥ 20 且解析 daemon 已运行（见上文「零构建部署」或「构建 Rust 解析服务」）。

**2) 安装 Claude Code**

```bash
npm install -g @anthropic-ai/claude-code
```

**3) 为 Claude Code 配置一个 Anthropic 兼容的 provider**

Claude Code 需要一个 LLM 后端。任何 Anthropic 兼容端点都行——设置以下变量
（或用 [`cc-switch`](https://www.npmjs.com/package/@cc-switch/cli) 管理）：

```bash
export ANTHROPIC_BASE_URL="https://your-provider/anthropic"   # 任何 Anthropic 兼容端点
export ANTHROPIC_AUTH_TOKEN="your-api-key"                     # 切勿提交到仓库
export ANTHROPIC_MODEL="your-model"                            # 你的 provider 提供的模型名
```

> 用 [`cc-switch`](https://www.npmjs.com/package/@cc-switch/cli)：`npm i -g @cc-switch/cli`，
> `cc-switch new my-provider`（在 `env` 里填同样的 `ANTHROPIC_*` 键），
> `cc-switch switch my-provider`，再 `eval $(cc-switch export)`。

**4) 注册 MCP 服务**

```bash
claude mcp add liuhe -- node /path/to/malong/mcp-server.js --workspace /path/to/project
claude mcp list        # → "liuhe … ✔ Connected"
```

**5) 使用**——在项目里启动 `claude` 直接提问，或无头模式运行：

```bash
claude -p "用 reindex 给工作空间建索引，再用 symbol_search 找 createDb" \
  --allowedTools "mcp__liuhe__reindex" "mcp__liuhe__symbol_search"
```

工具以 `mcp__liuhe__<工具名>` 暴露（如 `mcp__liuhe__health`、`mcp__liuhe__symbol_search`、
`mcp__liuhe__repo_map`）。每个工作区首次使用前先跑一次 `reindex`（可加 `blocking=true`），
符号搜索 / 影响分析才有索引可查。

### 在 codex 中使用

已用 codex 端到端验证（同样是 JSON-RPC over stdio 的 MCP 层）。

> **版本注意**：新版 codex 强制走 OpenAI *Responses* API（`wire_api = "responses"`）。
> 需用仍支持 `wire_api = "chat"` 且带 MCP 的版本——实测 **0.50.0** 可用：
> `npm install -g @openai/codex@0.50.0`。

**1) 前置**——Node ≥ 20 且解析 daemon 已运行（见上文）。

**2) 配置 `~/.codex/config.toml`**——指向任意 OpenAI 兼容 provider（下例用
[OpenCode Zen](https://opencode.ai)），并注册 MCP 服务：

```toml
model = "deepseek-v4-flash"
model_provider = "opencode-zen"

[model_providers.opencode-zen]
name = "OpenCode Zen"
base_url = "https://opencode.ai/zen/go/v1"   # 任何 OpenAI 兼容端点
wire_api = "chat"
env_key = "OPENCODE_ZEN_API_KEY"             # codex 从该环境变量读 API key

[mcp_servers.liuhe]
command = "node"
args = ["/path/to/malong/mcp-server.js", "--workspace", "/path/to/project"]
```

**3) 运行**——导出 API key 后启动 codex：

```bash
export OPENCODE_ZEN_API_KEY="your-api-key"   # 切勿提交到仓库
codex exec "用 reindex 给工作空间建索引，再用 symbol_search 找 createDb"
```

工具以 `liuhe.<工具名>` 暴露（如 `liuhe.health`、`liuhe.symbol_search`、`liuhe.repo_map`）。
每个工作区首次使用前先跑一次 `reindex`，符号搜索才有索引可查。

## 测试

- Rust 侧：`cargo test`（92 断言：各语言提取 + 协议帧编解码 + 缓存 LFU + 服务端 dispatch/优先级队列 + batch_extract + 深嵌套守卫 + 握手认证）
- JS 侧：81 个测试文件共 2015 断言。`npm test` 跑全链（primitives / embedded / mvp-batch / tool-registry / repo-map / handler-smoke / patch-parser / file-collector / code-search / health-check / db-adapter 双后端 / write-runtime / host-config / mcp-server / security-review-rules / journal-prune / gatekeeper-golden / debug-runner / edit-collision-guard / fix-imports / symbol-search / naming-consistency / call-chain / edit-transaction-ext / batch-edit-write / verify-pipeline / dep-graph-project / code-quality / tsc-spec / batch-edit-tocou / workflow-closure / variable-refs / output-budget / read-symbols-batch / feedback-list / test-bridge-run / mock-syncer-truncation / r54-p0 / r54-p1 / r54-p2 / r8 / r9 / crash-injection / r10 / dogfood-r12）；全链 81 文件含 dogfood-r14…r30（真实 daemon 端到端）
- 总计：2015 断言（81 文件全链 0 失败；另 cargo test）
- 一键验证：`./scripts/ci.sh`（自包含：cargo test + npm test + dogfood，复用或自起 daemon）

## 许可证

[MIT](LICENSE)

## 更新日志

完整版本历史见 [CHANGELOG.md](CHANGELOG.md)。
