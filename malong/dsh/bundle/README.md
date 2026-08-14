# @jieai/dsh-malong-bridge

六合工具集（LiuHe / malong）官方 DSH（DeepSeek Harness）插件。一行命令把 44 个
`malong__*` MCP 工具装进 dsh web，且 **malong 的工作区自动跟随当前对话的工作区**
（选哪个区管哪个区），无需手动指定路径。

```bash
dsh plugin --profile web add @jieai/dsh-malong-bridge
pkill -f "dsh web"
dsh web --port 3456 --host 0.0.0.0
```

安装即用：桥层自动定位包内 `server/mcp-server.js`（含完整工具集后端，唯一原生
依赖 better-sqlite3 有跨平台预编译），无需额外部署。

> **pnpm 10 提示 `Ignored build scripts: better-sqlite3` 时**：这是 pnpm 的
> 默认安全策略（阻止依赖 postinstall）。运行 `pnpm approve-builds` 并在列表里
> 勾选 `better-sqlite3`（或直接编辑 `~/.dsh/profiles/web/pnpm-workspace.yaml`
> 在 `onlyBuiltDependencies` 下加 `better-sqlite3`，然后 `pnpm rebuild better-sqlite3`）。
> 不处理则 better-sqlite3 无原生二进制，工具调用会失败。

## 卸载

```bash
dsh plugin --profile web remove @jieai/dsh-malong-bridge
pkill -f "dsh web"
dsh web --port 3456 --host 0.0.0.0
```

## 配置（可选，默认零配置）

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `MALONG_SERVER_PATH` | 包内 `server/mcp-server.js` | 覆盖 mcp-server 入口（如指向自己的 LiuHe 开发副本） |
| `MALONG_STATE_DIR` | `~/.local/state/malong-dsh` | 索引/状态存储目录（所有工作区按 hash 隔离其下） |
| `MALONG_TOOL_TIMEOUT_MS` | `300000` | 单次工具调用超时 |

也可在 profile 的 `cordis.patch.yml`（用户层，后应用覆盖）里给 `malong-dsh-bridge`
条目写 `config:` 覆盖。

## 工作机制

```
DSH Agent → malong__read_symbol(...)（不传 workspace_dir）
         → dsh-bridge 注入 workspace_dir = 当前会话工作区
         → malong mcp-server（spawn 子进程）→ 按路径 hash 隔离建索引
```

- **工作区动态跟随**：dsh 每次工具执行都携带会话工作区
  （`exec.agent.session.header.cwd`），桥层自动注入；模型显式传路径时尊重（可跨区管理）。
- **状态目录隔离**：索引按工作区路径 hash 隔离在 `MALONG_STATE_DIR` 下，与项目目录无关。
- **零侵入**：不改 dsh 的 node_modules，dsh 升级无损。

> **平台支持（自动）**：`malong-parse`（Rust 解析服务）以 esbuild 式平台子包随装——
> 主包 `optionalDependencies` 声明 `@jieai/malong-parse-linux-x64` /
> `-darwin-x64` / `-darwin-arm64` / `-win32-x64`，安装时 npm/pnpm 按当前 os/cpu
> 自动只拉对应平台二进制，无需手动配置。其他平台/自定义二进制可用
> `MALONG_PARSE_BIN` 环境变量覆盖。

## 与官方 dsh-mcp-client 的差异

官方 `dsh-mcp-client` 桥接单个 MCP server；本插件的桥自带 **动态 workspace 注入**
（每次调用按会话工作区填 `workspace_dir`，模型无需感知路径）——这是 LiuHe 独有的能力。

## 常见问题

| 现象 | 处理 |
|---|---|
| 日志报 `mcp tools/list timeout` | 确认安装完整（`dsh plugin` 后 node_modules 无报错）；重启 dsh |
| 对话里工具列表无 `malong__*` | `dsh web --dump-config \| grep malong` 确认 bundle 层挂上；强刷浏览器 |
| 调用报 `missing_parameter: workspace_dir` | 会话未关联工作区（无 cwd）时无法注入；对话里指明路径即可 |
| dsh 升级后插件失效 | 插件在 profile 层，dsh 升级不影响；若 cordis 接口变更，重装插件即可 |

## 索引规则（透明化）

- **默认忽略**：`node_modules`、`.git`、`dist`、`build`、`target`、`coverage`、
  `__pycache__`、`.venv`、`.malong`、`.ai-transactions`、`vendor` 等
- **md/json 不进索引**：只索引代码文件；查文档内容请用 read 工具
- **`.malongignore` 自定义**：项目根放该文件可白名单式排除目录（每行一条；支持 `*` 通配；最多 100 条）

## License

MIT
