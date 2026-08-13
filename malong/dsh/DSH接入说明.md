# 六合工具集 × DSH（DeepSeek Harness Web）接入说明

> 目标：让 DSH 对话中的 Agent 直接使用六合工具（`malong__*` 共 38 个），
> 且 **malong 的工作区自动跟随当前对话的工作区**（选哪个区管哪个区），无需手动指定路径。

## 一、快速安装

```bash
# 1. 前提：已安装并运行过 dsh web（生成 ~/.dsh/profiles/web/）
# 2. 一键安装（幂等，可重复执行；自动备份原配置）
bash <六合工具集>/malong/dsh/install-dsh.sh

# 3. 重启 dsh web
pkill -f "dsh web"
dsh web --port 3456 --host 0.0.0.0 --trusted-host <你的局域网IP>

# 4. 验证配置已加载
dsh web --dump-config | grep -A6 malong-dsh-bridge
```

安装脚本做三件事：
1. 备份 `~/.dsh/profiles/web/cordis.patch.yml`
2. 移除旧的 dsh-mcp-client 条目（若曾装过）
3. 追加 `malong-dsh-bridge` 插件条目（指向本目录 `dsh-bridge.mjs`）

## 二、工作机制

```
DSH Agent → malong__read_symbol(...)（不传 workspace_dir）
         → dsh-bridge 注入 workspace_dir = 当前会话工作区
         → malong mcp-server（spawn 子进程）→ 按路径 hash 隔离建索引
```

- **工作区动态跟随**：dsh 每次工具执行都携带会话工作区
  （`exec.agent.session.header.cwd` = 你创建对话时选的工作区路径），桥层自动注入，
  模型不传也会命中正确工作区；模型显式传路径时尊重（可跨区管理）。
- **状态目录隔离**：`--workspace ~/.local/state/malong-dsh` 仅是索引/状态存储位置
  （所有工作区索引按 hash 隔离放在其下），与任何项目目录无关；
  与 opencode 侧的 malong 实例（如有）完全隔离。
- **零侵入**：不改 dsh 的 node_modules，dsh 升级无损；不依赖 dsh-mcp-client。

## 三、验证

1. 打开 dsh web，选一个工作区（如 `/path/to/projectA`）创建对话
2. 让 Agent 读一个符号（它会自动调 `malong__read_symbol`，无需指定路径）
3. 确认索引生成：
   ```bash
   ls ~/.local/state/malong-dsh/data/malong-mcp/workspaces/
   # 应出现 <hash>/metadata.json，其中 workspace_dir = /path/to/projectA
   ```
4. 另选工作区 B 再建对话再读 → 出现另一个独立 hash，互不干扰

## 四、卸载 / 重装

```bash
# 从 ~/.dsh/profiles/web/cordis.patch.yml 移除 malong-dsh-bridge 条目（或还原备份文件），重启 dsh web
```

## 五、索引规则（透明化）

malong 的 reindex/搜索默认行为，模型与用户都应知道：

- **默认忽略目录**：`node_modules`、`.git`、`.hg`、`.svn`、`dist`、`build`、`out`、`target`、`coverage`、`__pycache__`、`.venv`、`.env`、`.next`、`.vscode`、`.idea`、**`.malong`**、**`.ai-transactions`**、`vendor` 等
- **md/json 不进索引**：只索引代码文件扩展名（.js/.ts/.py/.go/.rs/.c/.cpp/.java/.sh 等），markdown、JSON、YAML、配置文件不在索引内——查文档内容请用 read 工具，不要依赖 reindex
- **`.malongignore` 自定义**：项目根放 `.malongignore` 文件可白名单式排除目录（每行一条；支持 `*` 通配；最多 100 条）
- **注意**：`data/` 这类目录**不是默认忽略项**（某些项目是 .malongignore 特例），如不需要索引请自行排除

## 六、常见问题

| 现象 | 处理 |
|---|---|
| 日志报 `mcp tools/list timeout` | 确认 `serverPath` 指向存在且可执行；重启 dsh |
| 对话里工具列表无 `malong__*` | 确认 `dsh web --dump-config` 含 malong-dsh-bridge 且无报错；强刷浏览器 |
| 调用报 `missing_parameter: workspace_dir` | 会话未关联工作区（无 cwd）时无法注入；对话里指明路径即可 |
| dsh 升级后插件失效 | 插件在 profile 层，dsh 升级不影响；若 cordis 接口变更，重跑 install 或更新插件 |

## 六、文件清单

| 文件 | 说明 |
|---|---|
| `dsh/dsh-bridge.mjs` | cordis 插件：最小 MCP stdio client + workspace_dir 自动注入 |
| `dsh/install-dsh.sh` | 一键安装脚本（幂等、自动备份） |
| `dsh/DSH接入说明.md` | 本文档 |
