# 六合 × opencode V2 适配指南

> 适用 opencode 2.x（按 v2.0.28 实测，2026-10-15）；V1（≤1.18）用户参考各节「V1 兼容」备注。
> 目标：把六合工具集（malong MCP server）接进 opencode V2，并让工具调用「看得见」。

## TL;DR

1. 配置用 V2 原生形状：`mcp.servers.<名称>`（V1 的 `mcp.<名称>` 直挂仍被兼容，但建议迁移）。
2. V2 默认 **Code Mode**：MCP 工具收进统一执行器，界面不出现 `malong_*` 独立工具行；要「每次调用一行、可见可审计」，给服务器加 `"codemode": false`。
3. 改配置**热生效**（文件监视器），必要时 `opencode reload`，无需重启。
4. 状态核对以 `opencode api get /api/mcp` 为准（`opencode mcp list` 偶有显示抖动）。

## 推荐配置（V2 原生形状，原生直挂可见版）

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "malong": {
        "type": "local",
        "command": ["node", "--max-old-space-size=512", "malong/mcp-server.js", "--workspace", "."],
        "environment": { "MALONG_INTERFACE": "graph", "MALONG_ENTRY_STATE": "1" },
        "codemode": false,
        "timeout": { "catalog": 300000, "execution": 300000 }
      }
    }
  }
}
```

- `codemode: false`：工具以 `malong_code_task`、`malong_edit_transaction` 等独立行呈现；代价是工具 schema 进每次请求（工具面大时占上下文）。不加则回 V2 默认 Code Mode（省上下文、不显示独立行）。
- `timeout`：`catalog`=目录拉取上限、`execution`=单次调用上限（默认值在 `mcp.timeout`）。
- 暂时不用的服务器：`"disabled": true`（保留配置、不连接、不注入工具）。

## V1 → V2 字段对照（MCP 段）

| V1 | V2 原生 | 备注 |
|---|---|---|
| `mcp.<名称>` 直挂 | `mcp.servers.<名称>` | V2 内存归一化兼容 V1 形状 |
| `"enabled": true` | 删除（或 `"disabled": false`） | 反义字段，默认启用 |
| `"timeout": 300000` | `"timeout": { "catalog": 300000, "execution": 300000 }` | V1 数字映射到两者 |
| `experimental.mcp_timeout` | `mcp.timeout`（默认值） | catalog / execution 两键 |

## 工具可见性：Code Mode vs 原生直挂

- **Code Mode（V2 默认）**：模型经统一执行器调用；界面只显示外层执行条目，内层调用名（`malong.code_task` 等）记在该条目的 `state.metadata.toolCalls` 里。
- **原生直挂（`codemode: false`）**：每次调用独立成行（`malong_code_query` 等），审计友好。
- 切换即热生效；目录刷新可能分一两拍，期间偶见 `No tool named ...` 短暂报错，稍候自稳。

## 验证与手动重连

```bash
opencode mcp list                                        # ✓ malong connected
opencode api get /api/mcp                                # 服务端真相（推荐）
opencode api post /api/experimental/mcp/malong/connect   # 手动重连
opencode reload                                          # 重读配置
```

## 常见坑（实测）

1. **V2 严格校验 tools/list**：每个工具必须带 `inputSchema`（MCP 规范必填）；缺失（V1 容忍）会让**整个服务器**判 `failed`。报错见 `opencode mcp list`；修法：给缺失的工具补 `{ "type": "object", "properties": {} }`。
2. `opencode mcp list` 偶发显示 `No MCP servers configured`（显示层抖动），连接与调用不受影响——以 `/api/mcp` 为准。
3. 进程多开正常：V2 按「位置（目录）」维护 MCP 连接，`ps` 里可见多个 `mcp-server.js`。
4. 会话调用记录：Code Mode 下内层调用记于外层条目的 `state.metadata.toolCalls`；原生直挂下即独立工具行——排查「某次调用到底有没有走 malong」看这里。

## 相关文档

- DSH 集成：`malong/dsh/DSH-INTEGRATION.md`
- 响应契约：`malong/RESPONSE-CONTRACT.md`（随 npm 包发布）
